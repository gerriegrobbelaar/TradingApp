/**
 * ExactGate: one Durable Object per Exact division ("exact:<division>") that every Exact call
 * goes through, plus one "token authority" instance per connection ("exact-token:<id>") that is
 * the only place an OAuth refresh ever happens (docs/decisions/0015-exactgate-design.md).
 *
 * Why two kinds of instance: Exact refresh tokens are single use and one connection serves all
 * its divisions. If each division gate refreshed on its own, two gates could refresh at once and
 * the second would burn the first one's new token (a double refresh logs us out). Division gates
 * therefore ask the connection's authority, which refreshes single-flight.
 *
 * Queue behaviour: the queue is in memory. If the instance is evicted or the code is redeployed
 * while requests wait, those callers get a retryable error (ExactApiError 503 gate_unavailable)
 * and must retry; nothing is persisted on purpose. Counters (daily use, minute bucket, job
 * budgets) are persisted so an eviction does not hand out a fresh budget.
 *
 * Nothing in here logs request bodies, URLs or tokens.
 */
import { DurableObject } from "cloudflare:workers";
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  type ExactRequest,
  type ExactResponse,
} from "@camelthorn/exact";
import { decryptToken, encryptToken, keyring, TokenCryptoError } from "../crypto/token-crypto";
import type { Env } from "../env";
import { loadExactConfig } from "./config";
import { refreshTokens, TokenEndpointError } from "./oauth";
import { buildUrl, validateRequest } from "./request";
import {
  aad,
  loadConnectionById,
  loadExactConnection,
  markNeedsReauth,
  type ExactConnectionRow,
} from "./store";
import { toWire, type GateResult } from "./wire";

export interface GateLimits {
  /** Exact allows about 60 calls per minute per division. */
  perMinute: number;
  /** ... and about 5,000 per day. */
  perDay: number;
  /** Fraction of the daily budget only `user` priority may spend. */
  userReserveFraction: number;
  /** A queued request that would wait longer than this fails with a retryable error. */
  maxQueueWaitMs: number;
  /** Per-run budget for a job that has none configured. */
  defaultJobBudget: number;
  /** Delay before the daily summary row is written to D1 (0 = never schedule an alarm). */
  flushIntervalMs: number;
  fetchTimeoutMs: number;
}

export const DEFAULT_LIMITS: GateLimits = {
  perMinute: 60,
  perDay: 5000,
  userReserveFraction: 0.1,
  maxQueueWaitMs: 90_000,
  defaultJobBudget: 500,
  flushIntervalMs: 30_000,
  fetchTimeoutMs: 30_000,
};

const REFRESH_MARGIN_MS = 60_000;
const MAX_BLOCK_MS = 24 * 3600 * 1000;
const JOB_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const JOB_TTL_MS = 24 * 3600 * 1000;
/**
 * Fairness: after this many user calls in a row while a job call is waiting, the oldest job call
 * goes next. Users still jump the queue, but a steady stream of UI clicks cannot starve a job.
 */
const USER_BURST = 5;
/** Instance roles; an instance takes one on first use and refuses the other (see `claimRole`). */
type GateRole = `division:${number}` | `authority:${number}`;

interface RemoteDay {
  dayLimit: number;
  dayRemaining: number;
  /** Epoch ms when Exact says the daily window resets, or null if unknown. */
  dayResetMs: number | null;
}

interface LimiterState {
  division: number | null;
  /** UTC day (YYYY-MM-DD) the counters below belong to. */
  day: string;
  used: number;
  userUsed: number;
  jobUsed: number;
  limited: number;
  tokens: number;
  tokensAt: number;
  /** Capacity of the minute bucket (Exact's reported limit, else limits.perMinute). */
  capacity: number;
  blockedUntil: number;
  remote: RemoteDay | null;
}

interface JobState {
  budget: number;
  used: number;
  startedAt: number;
}

interface Queued {
  req: ExactRequest;
  enqueuedAt: number;
  retried: boolean;
  resolve: (r: ExactResponse) => void;
  reject: (e: unknown) => void;
}

export type TokenResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; code: string; retryable: boolean };

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Exact sends reset times as epoch milliseconds; tolerate seconds too. */
const toEpochMs = (n: number): number => (n < 1e11 ? n * 1000 : n);

export class ExactGate extends DurableObject<Env> {
  /** Mutable so tests can tighten them; production uses the defaults. */
  limits: GateLimits = { ...DEFAULT_LIMITS };
  /** Clock and sleeper are replaceable for deterministic tests. */
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  private st!: LimiterState;
  private jobs = new Map<string, JobState>();
  private queue: Queued[] = [];
  private pumping = false;
  private refreshing: { connectionId: number; promise: Promise<TokenResult> } | null = null;
  private dirty = false;
  private alarmScheduled = false;
  private role: GateRole | null = null;
  /** User calls dispatched in a row while a job call was waiting (see USER_BURST). */
  private userStreak = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<LimiterState>("rl");
      this.st = saved ?? this.freshState(Date.now());
      this.role = (await ctx.storage.get<GateRole>("role")) ?? null;
    });
  }

  /**
   * An instance is either a division gate or a connection's token authority, never both. The
   * role is persisted on first use, so a refresh can only ever run in the one instance that
   * first acted as the authority for that connection (`exact-token:<id>`), and a division gate
   * that is (wrongly) asked to refresh refuses instead of racing the authority.
   */
  private async claimRole(role: GateRole): Promise<boolean> {
    if (this.role === role) return true;
    if (this.role !== null) return false;
    this.role = role;
    await this.ctx.storage.put("role", role);
    return true;
  }

  private freshState(now: number): LimiterState {
    return {
      division: null,
      day: dayOf(now),
      used: 0,
      userUsed: 0,
      jobUsed: 0,
      limited: 0,
      tokens: this.limits.perMinute,
      tokensAt: now,
      capacity: this.limits.perMinute,
      blockedUntil: 0,
      remote: null,
    };
  }

  // ---------------------------------------------------------------------------------------
  // Public RPC
  // ---------------------------------------------------------------------------------------

  /** RPC entry point: always resolves with an envelope (errors lose their class over RPC). */
  async call(req: ExactRequest): Promise<GateResult> {
    try {
      return { ok: true, response: await this.request(req) };
    } catch (e) {
      return { ok: false, error: toWire(e) };
    }
  }

  async request(req: ExactRequest): Promise<ExactResponse> {
    validateRequest(req);
    if (!(await this.claimRole(`division:${req.division}`))) {
      throw new ExactApiError(400, "wrong gate for division", "division_mismatch");
    }
    if (this.st.division === null) {
      this.st.division = req.division;
      await this.persist();
    } else if (this.st.division !== req.division) {
      throw new ExactApiError(400, "wrong gate for division", "division_mismatch");
    }
    if (req.priority === "job") {
      const job = await this.ensureJob(req.jobId);
      if (job.used >= job.budget) throw new ExactBudgetExhaustedError(req.jobId);
    }
    return new Promise<ExactResponse>((resolve, reject) => {
      this.queue.push({ req, enqueuedAt: this.now(), retried: false, resolve, reject });
      void this.pump();
    });
  }

  /** Starts (or restarts) a job run with its own call budget. */
  async startJob(jobId: string, budget?: number): Promise<{ jobId: string; budget: number }> {
    if (!JOB_ID_RE.test(jobId)) throw new ExactApiError(400, "invalid job id", "job_id");
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1 || budget > 100_000)) {
      throw new ExactApiError(400, "invalid budget", "budget");
    }
    const now = this.now();
    const job: JobState = {
      budget: budget ?? (await this.defaultBudget(jobId)),
      used: 0,
      startedAt: now,
    };
    this.jobs.set(jobId, job);
    await this.ctx.storage.put(`job:${jobId}`, job);
    await this.purgeOldJobs(now);
    return { jobId, budget: job.budget };
  }

  /** Ends a job run and returns how many calls it used. */
  async endJob(jobId: string): Promise<{ used: number }> {
    const job = this.jobs.get(jobId) ?? (await this.ctx.storage.get<JobState>(`job:${jobId}`));
    this.jobs.delete(jobId);
    await this.ctx.storage.delete(`job:${jobId}`);
    return { used: job?.used ?? 0 };
  }

  /** Snapshot for the UI and data-quality rules. */
  usage(): {
    division: number | null;
    day: string;
    used: number;
    remaining: number;
    queued: number;
    blockedUntil: number;
  } {
    const now = this.now();
    this.rollover(now);
    return {
      division: this.st.division,
      day: this.st.day,
      used: this.st.used,
      remaining: this.dayRemaining(now),
      queued: this.queue.length,
      blockedUntil: this.st.blockedUntil,
    };
  }

  /** Writes today's counters to D1 (exact_usage). Also runs from the alarm. */
  async flushUsage(): Promise<void> {
    this.dirty = false;
    const s = this.st;
    if (s.division === null) return;
    await this.env.DB.prepare(
      `INSERT INTO exact_usage (division, day, calls, user_calls, job_calls, rate_limited, remaining, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (division, day) DO UPDATE SET
         calls = excluded.calls, user_calls = excluded.user_calls, job_calls = excluded.job_calls,
         rate_limited = excluded.rate_limited, remaining = excluded.remaining,
         updated_at = excluded.updated_at`,
    )
      .bind(
        s.division,
        s.day,
        s.used,
        s.userUsed,
        s.jobUsed,
        s.limited,
        s.remote ? s.remote.dayRemaining : null,
        new Date(this.now()).toISOString(),
      )
      .run();
  }

  async alarm(): Promise<void> {
    this.alarmScheduled = false;
    if (this.dirty) await this.flushUsage();
  }

  // ---------------------------------------------------------------------------------------
  // Token authority (called by division gates over RPC; also usable directly)
  // ---------------------------------------------------------------------------------------

  /**
   * Returns a usable access token, refreshing if it expires within 60 s. Concurrent callers
   * share one refresh. `staleExpiresAt` is the `expires_at` of a token Exact just rejected: a
   * refresh is forced only if the stored token is still that one.
   */
  refreshAccessToken(connectionId: number, staleExpiresAt?: string): Promise<TokenResult> {
    if (this.refreshing && this.refreshing.connectionId === connectionId) {
      return this.refreshing.promise;
    }
    const promise = (async (): Promise<TokenResult> => {
      if (!Number.isSafeInteger(connectionId) || connectionId < 1) {
        return { ok: false, code: "not_connected", retryable: false };
      }
      if (!(await this.claimRole(`authority:${connectionId}`))) {
        return { ok: false, code: "wrong_token_authority", retryable: false };
      }
      return this.doRefresh(connectionId, staleExpiresAt);
    })().finally(() => {
      if (this.refreshing?.promise === promise) this.refreshing = null;
    });
    this.refreshing = { connectionId, promise };
    return promise;
  }

  /**
   * Stores new tokens. Returns false if the row no longer matches (disconnected, or the refresh
   * token changed because someone re-authorised meanwhile). Throws on a D1 error.
   * Public only so tests can simulate a storage failure.
   */
  async persistTokens(
    connectionId: number,
    oldRefreshEnc: string,
    accessEnc: string,
    refreshEnc: string,
    expiresAtMs: number,
  ): Promise<boolean> {
    const r = await this.env.DB.prepare(
      `UPDATE connections
       SET access_token_enc = ?3, refresh_token_enc = ?4, expires_at = ?5, last_error = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1 AND status = 'active' AND refresh_token_enc = ?2`,
    )
      .bind(connectionId, oldRefreshEnc, accessEnc, refreshEnc, new Date(expiresAtMs).toISOString())
      .run();
    return r.meta.changes === 1;
  }

  private async doRefresh(connectionId: number, staleExpiresAt?: string): Promise<TokenResult> {
    const db = this.env.DB;
    try {
      const row = await loadConnectionById(db, connectionId);
      if (!row || row.status !== "active") {
        return {
          ok: false,
          code: row?.status === "needs_reauth" ? "needs_reauth" : "not_connected",
          retryable: false,
        };
      }
      const keys = keyring(this.env);
      const now = this.now();
      const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
      const stillFresh =
        row.access_token_enc !== null &&
        exp - now > REFRESH_MARGIN_MS &&
        (staleExpiresAt === undefined || row.expires_at !== staleExpiresAt);
      if (stillFresh && row.access_token_enc) {
        // Another refresh (or a reconnect) already produced a good token: do not burn the
        // single-use refresh token again.
        return {
          ok: true,
          accessToken: await decryptToken(keys, row.access_token_enc, aad(row.id, "access")),
          expiresAt: exp,
        };
      }
      if (!row.refresh_token_enc) {
        await markNeedsReauth(db, row.id, "no_refresh_token");
        return { ok: false, code: "needs_reauth", retryable: false };
      }
      const refreshToken = await decryptToken(keys, row.refresh_token_enc, aad(row.id, "refresh"));
      let origin: string;
      try {
        origin = new URL(this.env.EXACT_REDIRECT_URI).origin;
      } catch {
        return { ok: false, code: "server_misconfigured", retryable: false };
      }
      const cfg = loadExactConfig(this.env, origin);
      if (!cfg.ok) return { ok: false, code: "server_misconfigured", retryable: false };

      let tokens;
      try {
        tokens = await refreshTokens(
          {
            host: row.region_host,
            clientId: cfg.config.clientId,
            clientSecret: cfg.config.clientSecret,
          },
          refreshToken,
        );
      } catch (e) {
        const failure = e instanceof TokenEndpointError ? e.failure : "unavailable";
        if (failure === "invalid_grant" || failure === "malformed") {
          await markNeedsReauth(
            db,
            row.id,
            failure === "malformed" ? "malformed_response" : failure,
          );
          return { ok: false, code: "needs_reauth", retryable: false };
        }
        // "rejected" (for example a wrong client secret) is our configuration, not the user's
        // grant: do not wipe the tokens. "unavailable" is transient.
        return {
          ok: false,
          code: failure === "rejected" ? "token_rejected" : "token_endpoint_unavailable",
          retryable: failure !== "rejected",
        };
      }

      // The old refresh token is spent. Persist the new one BEFORE the new access token is used.
      const expiresAt = this.now() + tokens.expiresInS * 1000;
      let persisted = false;
      try {
        const accessEnc = await encryptToken(
          this.env.TOKEN_ENC_KEY,
          tokens.accessToken,
          aad(row.id, "access"),
        );
        const refreshEnc = await encryptToken(
          this.env.TOKEN_ENC_KEY,
          tokens.refreshToken,
          aad(row.id, "refresh"),
        );
        try {
          persisted = await this.persistTokens(
            row.id,
            row.refresh_token_enc,
            accessEnc,
            refreshEnc,
            expiresAt,
          );
        } catch {
          // One retry for a transient D1 error; the new refresh token exists only in memory.
          persisted = await this.persistTokens(
            row.id,
            row.refresh_token_enc,
            accessEnc,
            refreshEnc,
            expiresAt,
          );
        }
      } catch {
        try {
          await markNeedsReauth(db, row.id, "token_persist_failed");
        } catch {
          /* D1 is down; the next refresh attempt will hit invalid_grant and mark it then */
        }
        return { ok: false, code: "needs_reauth", retryable: false };
      }
      if (!persisted) {
        // Row changed under us (disconnect or re-authorise). Do not use or keep these tokens.
        return { ok: false, code: "connection_changed", retryable: true };
      }
      return { ok: true, accessToken: tokens.accessToken, expiresAt };
    } catch (e) {
      if (e instanceof TokenCryptoError) {
        // Wrong or missing TOKEN_ENC_KEY: our configuration, not a revoked grant.
        return { ok: false, code: "token_unreadable", retryable: false };
      }
      return { ok: false, code: "refresh_failed", retryable: true };
    }
  }

  // ---------------------------------------------------------------------------------------
  // Queue and limiter
  // ---------------------------------------------------------------------------------------

  /**
   * User calls first, oldest first, except that after USER_BURST user calls in a row with a job
   * call waiting the oldest job call goes (so jobs are delayed, never starved).
   */
  private pickNext(): Queued | undefined {
    const user = this.queue.find((q) => q.req.priority === "user");
    const job = this.queue.find((q) => q.req.priority === "job");
    if (user && job && this.userStreak >= USER_BURST) return job;
    return user ?? job;
  }

  /** Fails every waiting call that has been queued longer than maxQueueWaitMs. */
  private expireWaiting(): void {
    const now = this.now();
    for (const q of [...this.queue]) {
      if (now - q.enqueuedAt > this.limits.maxQueueWaitMs) {
        this.unqueue(q);
        q.reject(new ExactRateLimitedError(1000, "queued too long"));
      }
    }
  }

  private noteDispatch(item: Queued): void {
    if (item.req.priority === "job") this.userStreak = 0;
    else if (this.queue.some((q) => q.req.priority === "job")) this.userStreak++;
    else this.userStreak = 0;
  }

  private unqueue(item: Queued): void {
    const i = this.queue.indexOf(item);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // Let requests enqueued in the same tick all be visible before choosing the first.
      await Promise.resolve();
      for (;;) {
        this.expireWaiting();
        const item = this.pickNext();
        if (!item) break;
        try {
          const wait = this.waitFor(item);
          if (wait > 0) {
            await this.sleep(wait);
            continue; // re-pick: a user request may have arrived meanwhile
          }
          this.unqueue(item);
          this.noteDispatch(item);
          this.spend(item.req);
          await this.persist(item.req);
          const res = await this.execute(item);
          if (res) item.resolve(res);
        } catch (e) {
          this.unqueue(item);
          item.reject(e);
        }
      }
    } finally {
      this.pumping = false;
      if (this.queue.length > 0) void this.pump();
    }
  }

  /** 0 = go now, >0 = wait this long; throws if the request must fail instead of waiting. */
  private waitFor(item: Queued): number {
    const now = this.now();
    this.rollover(now);
    this.refill(now);
    const { req } = item;
    if (req.priority === "job") {
      const job = this.jobs.get(req.jobId);
      if (job && job.used >= job.budget) throw new ExactBudgetExhaustedError(req.jobId);
    }
    let wait = 0;
    if (this.st.blockedUntil > now) {
      wait = this.st.blockedUntil - now;
    } else {
      const remaining = this.dayRemaining(now);
      if (remaining <= 0)
        throw new ExactRateLimitedError(this.untilDayReset(now), "daily budget used");
      if (req.priority === "job" && remaining <= this.reserve()) {
        // The last slice of the day is kept for people using the UI.
        throw new ExactRateLimitedError(this.untilDayReset(now), "daily budget reserved");
      }
      if (this.st.tokens >= 1) return 0;
      wait = Math.ceil(((1 - this.st.tokens) * 60_000) / this.st.capacity);
    }
    if (now - item.enqueuedAt + wait > this.limits.maxQueueWaitMs) {
      throw new ExactRateLimitedError(wait);
    }
    return wait;
  }

  private spend(req: ExactRequest): void {
    this.st.tokens = Math.max(0, this.st.tokens - 1);
    this.st.used++;
    if (req.priority === "user") this.st.userUsed++;
    else {
      this.st.jobUsed++;
      const job = this.jobs.get(req.jobId);
      if (job) job.used++;
    }
    if (this.st.remote) this.st.remote.dayRemaining = Math.max(0, this.st.remote.dayRemaining - 1);
    this.markDirty();
  }

  private refill(now: number): void {
    const s = this.st;
    if (now > s.tokensAt) {
      s.tokens = Math.min(s.capacity, s.tokens + ((now - s.tokensAt) * s.capacity) / 60_000);
    }
    s.tokensAt = now;
  }

  private rollover(now: number): void {
    const day = dayOf(now);
    if (day === this.st.day) {
      if (this.st.remote?.dayResetMs != null && now >= this.st.remote.dayResetMs) {
        this.st.remote = null;
      }
      return;
    }
    if (this.dirty) void this.flushUsage().catch(() => undefined); // yesterday's final numbers
    // Exact's own window may end later than UTC midnight; keep its numbers until it says reset.
    const r = this.st.remote;
    const remote = r && r.dayResetMs !== null && now < r.dayResetMs ? r : null;
    Object.assign(this.st, { day, used: 0, userUsed: 0, jobUsed: 0, limited: 0, remote });
  }

  /**
   * The smaller of Exact's own remaining count (while its window is current) and the local
   * counter. Headers can only lower the allowance, never raise it above the configured cap.
   */
  private dayRemaining(now: number): number {
    const local = Math.max(0, this.limits.perDay - this.st.used);
    const r = this.st.remote;
    if (r && (r.dayResetMs === null || now < r.dayResetMs)) {
      return Math.min(local, Math.max(0, r.dayRemaining));
    }
    return local;
  }

  private reserve(): number {
    const limit = Math.min(this.st.remote?.dayLimit ?? this.limits.perDay, this.limits.perDay);
    return Math.ceil(limit * this.limits.userReserveFraction);
  }

  private untilDayReset(now: number): number {
    const r = this.st.remote?.dayResetMs;
    if (r != null && r > now) return r - now;
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return next.getTime() - now;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.limits.flushIntervalMs > 0 && !this.alarmScheduled) {
      this.alarmScheduled = true;
      void this.ctx.storage.setAlarm(this.now() + this.limits.flushIntervalMs).catch(() => {
        this.alarmScheduled = false;
      });
    }
  }

  /** Saves the limiter state, plus the budget of the job the request belongs to (if any). */
  private async persist(req?: ExactRequest): Promise<void> {
    const job = req?.priority === "job" ? this.jobs.get(req.jobId) : undefined;
    if (req && job) {
      await this.ctx.storage.put({ rl: this.st, [`job:${req.jobId}`]: job });
    } else {
      await this.ctx.storage.put("rl", this.st);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------------------

  private async defaultBudget(jobId: string): Promise<number> {
    try {
      const row = await this.env.DB.prepare("SELECT exact_budget FROM jobs WHERE name = ?1")
        .bind(jobId)
        .first<{ exact_budget: number }>();
      if (row && Number.isInteger(row.exact_budget) && row.exact_budget > 0) {
        return row.exact_budget;
      }
    } catch {
      /* fall through to the default */
    }
    return this.limits.defaultJobBudget;
  }

  private async ensureJob(jobId: string): Promise<JobState> {
    const known = this.jobs.get(jobId);
    if (known) return known;
    const saved = await this.ctx.storage.get<JobState>(`job:${jobId}`);
    if (saved) {
      this.jobs.set(jobId, saved);
      return saved;
    }
    // A job that never called startJob still gets a budget, so it cannot run unbounded.
    await this.startJob(jobId);
    return this.jobs.get(jobId) as JobState;
  }

  private async purgeOldJobs(now: number): Promise<void> {
    const all = await this.ctx.storage.list<JobState>({ prefix: "job:" });
    for (const [key, job] of all) {
      if (now - job.startedAt > JOB_TTL_MS) {
        this.jobs.delete(key.slice(4));
        await this.ctx.storage.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Executing a call
  // ---------------------------------------------------------------------------------------

  /** Returns null when the request was put back in the queue for one retry after a 401. */
  private async execute(item: Queued): Promise<ExactResponse | null> {
    const { req } = item;
    const row = await loadExactConnection(this.env.DB);
    if (!row || row.status === "pending" || row.status === "disabled") {
      throw new ExactAuthError("not_connected");
    }
    if (row.status !== "active") throw new ExactAuthError("needs_reauth");
    const url = buildUrl(row.region_host, req);
    const token = await this.accessTokenFor(row);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    if (req.api === "rest" && headers.accept === undefined) headers.accept = "application/json";
    headers.authorization = `Bearer ${token}`;

    let res: Response;
    let body: string;
    try {
      res = await fetch(url.toString(), {
        method: req.method,
        headers,
        ...(req.body !== undefined && req.method !== "GET" ? { body: req.body } : {}),
        redirect: "manual", // never forward the bearer token to a redirect target
        signal: AbortSignal.timeout(this.limits.fetchTimeoutMs),
      });
      body = await res.text();
    } catch {
      throw new ExactApiError(502, "exact unreachable", "network");
    }
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k.toLowerCase()] = v;
    });
    this.readRateHeaders(outHeaders, this.now());
    await this.persist(req);

    if (res.status === 429) {
      const retryMs = this.blockFor429(outHeaders, this.now());
      await this.persist();
      throw new ExactRateLimitedError(retryMs);
    }
    if (res.status === 401) {
      if (item.retried) throw new ExactAuthError("unauthorized");
      // Revoked or rotated elsewhere: force one refresh (only if the stored token is still the
      // one Exact rejected) and retry once.
      const forced = await this.authority(row.id).refreshAccessToken(
        row.id,
        row.expires_at ?? undefined,
      );
      if (!forced.ok) throw this.tokenError(forced);
      item.retried = true;
      this.queue.unshift(item);
      return null;
    }
    return { status: res.status, headers: outHeaders, body };
  }

  private authority(connectionId: number): DurableObjectStub<ExactGate> {
    const ns = this.env.EXACT_GATE;
    return ns.get(ns.idFromName(`exact-token:${connectionId}`));
  }

  private tokenError(r: Extract<TokenResult, { ok: false }>): Error {
    return r.retryable
      ? new ExactApiError(503, "token refresh failed", r.code)
      : new ExactAuthError(r.code);
  }

  private async accessTokenFor(row: ExactConnectionRow): Promise<string> {
    const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
    if (row.access_token_enc && exp - this.now() > REFRESH_MARGIN_MS) {
      try {
        return await decryptToken(keyring(this.env), row.access_token_enc, aad(row.id, "access"));
      } catch {
        throw new ExactAuthError("token_unreadable");
      }
    }
    const r = await this.authority(row.id).refreshAccessToken(row.id);
    if (!r.ok) throw this.tokenError(r);
    return r.accessToken;
  }

  /** Trust Exact's numbers over our own counters. */
  private readRateHeaders(h: Record<string, string>, now: number): void {
    const num = (k: string): number | null => {
      const v = h[k];
      if (v === undefined || v.trim() === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const s = this.st;
    const dayRemaining = num("x-ratelimit-remaining");
    if (dayRemaining !== null) {
      const reset = num("x-ratelimit-reset");
      const resetMs = reset === null ? null : toEpochMs(reset);
      s.remote = {
        dayLimit: Math.min(
          num("x-ratelimit-limit") ?? s.remote?.dayLimit ?? this.limits.perDay,
          this.limits.perDay,
        ),
        dayRemaining: Math.max(0, dayRemaining),
        dayResetMs: resetMs !== null && resetMs > now ? resetMs : null,
      };
    }
    const minuteLimit = num("x-ratelimit-minutely-limit");
    // Never above the configured per-minute cap: a header may only tighten the limiter.
    if (minuteLimit !== null && minuteLimit >= 1) {
      s.capacity = Math.min(Math.floor(minuteLimit), this.limits.perMinute);
    }
    const minuteRemaining = num("x-ratelimit-minutely-remaining");
    if (minuteRemaining !== null) {
      // Lower the local bucket to Exact's count, never raise it (that would exceed perMinute).
      this.refill(now);
      s.tokens = Math.min(s.tokens, s.capacity, Math.max(0, minuteRemaining));
      const reset = num("x-ratelimit-minutely-reset");
      const resetMs = reset === null ? null : toEpochMs(reset);
      if (minuteRemaining < 1 && resetMs !== null && resetMs > now) {
        s.blockedUntil = Math.max(s.blockedUntil, Math.min(resetMs, now + 120_000));
      }
    }
  }

  /** Blocks the gate per Retry-After / reset headers after a 429; returns the wait in ms. */
  private blockFor429(h: Record<string, string>, now: number): number {
    let ms: number | null = null;
    const ra = h["retry-after"];
    if (ra !== undefined) {
      const secs = Number(ra);
      if (Number.isFinite(secs) && secs >= 0) ms = secs * 1000;
      else {
        const date = Date.parse(ra);
        if (Number.isFinite(date)) ms = Math.max(0, date - now);
      }
    }
    if (ms === null) {
      const minReset = Number(h["x-ratelimit-minutely-reset"]);
      const dayReset = Number(h["x-ratelimit-reset"]);
      if (this.st.remote && this.st.remote.dayRemaining <= 0 && Number.isFinite(dayReset)) {
        ms = Math.max(0, toEpochMs(dayReset) - now);
      } else if (Number.isFinite(minReset) && h["x-ratelimit-minutely-reset"] !== undefined) {
        ms = Math.max(0, toEpochMs(minReset) - now);
      }
    }
    const wait = Math.min(MAX_BLOCK_MS, Math.max(1000, ms ?? 60_000));
    this.st.blockedUntil = now + wait;
    this.st.tokens = 0;
    this.st.limited++;
    this.markDirty();
    return wait;
  }
}
