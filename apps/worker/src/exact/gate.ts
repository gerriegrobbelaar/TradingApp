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
  JOB_ID_RE,
  parseRateLimitHeaders,
  retryAfterFromHeaders,
  type ExactRequest,
  type ExactResponse,
} from "@camelthorn/exact";
import { decryptToken, encryptToken, keyring, TokenCryptoError } from "../crypto/token-crypto";
import type { Env } from "../env";
import { loadExactConfig } from "./config";
import { getExactGate } from "./gate-transport";
import { refreshTokens, TokenEndpointError } from "./oauth";
import { buildUrl, validateRequest } from "./request";
import {
  aad,
  loadConnectionById,
  loadExactConnection,
  markNeedsReauth,
  type ExactConnectionRow,
} from "./store";
import { auditStatement } from "../db/audit";
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

/**
 * Token timing (ADR 0016, UNVERIFIED against a live connection). Access tokens live about 600 s.
 * Exact is believed to refuse a refresh until the token is at least about 570 s old, so:
 *   - MIN_REFRESH_AGE_MS = 570 s: a refresh is never attempted on a younger token.
 *   - REFRESH_MARGIN_MS = 600 - 570 = 30 s: a token with 30 s or less left (age >= 570 s) is
 *     refreshed by the next call that needs it. A call that arrives with 20-30 s left (age
 *     570-580 s) refreshes inside the intended window; one arriving later refreshes late but
 *     still legally. 20 s is the least time a call in flight needs on a token.
 *   - The minimum age scales with the lifetime Exact actually gave: the earliest refresh is
 *     min(issued + 570 s, expires - 30 s). With expires_in 600 both are the same; with a shorter
 *     lifetime (say 300 s) a fixed 570 s rule would leave us with no valid token for minutes, and
 *     once a token has expired it can always be refreshed.
 *   - If a refresh is still needed before that point (for example a stored row without an access
 *     token), it waits (bounded by MAX_AGE_WAIT_MS) rather than going early; if the wait would be
 *     longer, the still-valid token is used instead.
 */
export const TOKEN_LIFETIME_MS = 600_000;
export const MIN_REFRESH_AGE_MS = 570_000;
export const REFRESH_MARGIN_MS = TOKEN_LIFETIME_MS - MIN_REFRESH_AGE_MS;
const MAX_AGE_WAIT_MS = 30_000;
/** A refresh the token endpoint rejects (premature or unclassifiable) is retried after these waits. */
const REFRESH_RETRY_DELAYS_MS = [5_000, 15_000];
/** After a failed refresh with a still-valid token, do not try again for this long. */
const REFRESH_COOLDOWN_MS = 10_000;
/** Wait before retrying a call whose 401 came from a token too young to refresh. */
const YOUNG_401_WAIT_MS = 2_000;
/** Retry persisting a stashed token pair this often (alarm). */
const PENDING_RETRY_MS = 30_000;
/**
 * The token endpoint rejecting our client credentials (invalid_client) this many times in a row,
 * over at least this long, marks the connection with CREDENTIALS_REJECTED (ADR 0016 item 20).
 */
const CLIENT_REJECT_ATTEMPTS = 3;
const CLIENT_REJECT_SPAN_MS = 60_000;
/** After that, no new attempt for this long (a wrong secret does not fix itself in seconds). */
const CLIENT_REJECT_COOLDOWN_MS = 60_000;
export const CREDENTIALS_REJECTED = "token_endpoint_rejected_credentials";
const MAX_BLOCK_MS = 24 * 3600 * 1000;
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
  /**
   * Sliding-window log: start times (ms, ascending) of calls in the last 60 s. Never longer than
   * the per-minute cap, so storage stays small.
   */
  window: number[];
  /** Per-minute cap (Exact's reported limit, else limits.perMinute); never above limits.perMinute. */
  capacity: number;
  /** Exact's own minute count, which can only tighten the window (see readRateHeaders). */
  remoteMinute: { left: number; until: number } | null;
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
  /** The retry was granted because the 401 token was too young to refresh (not a rotation). */
  youngRetry?: boolean;
  resolve: (r: ExactResponse) => void;
  reject: (e: unknown) => void;
}

export type TokenResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; code: string; retryable: boolean };

interface PendingTokens {
  /** The refresh token D1 still holds (the WHERE guard of the eventual write). */
  baseRefreshEnc: string;
  accessEnc: string;
  refreshEnc: string;
  expiresAt: number;
}
const pendingKey = (connectionId: number): string => `pending:${connectionId}`;
const issuedKey = (connectionId: number): string => `issued:${connectionId}`;
const clientRejectsKey = (connectionId: number): string => `client-rejects:${connectionId}`;

interface ClientRejects {
  /** Consecutive client_rejected answers from the token endpoint. */
  count: number;
  firstAt: number;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

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
  /** No refresh attempt before this time after a failed one that left a usable token. */
  private refreshCooldownUntil = 0;
  /** No refresh attempt at all before this time once our client credentials were rejected. */
  private clientRejectedUntil = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.load());
  }

  /** Loads the persisted limiter state (the sliding window included) and role. */
  private async load(): Promise<void> {
    const saved = await this.ctx.storage.get<LimiterState>("rl");
    this.st = saved ?? this.freshState(Date.now());
    // State saved by an older build (token bucket) has no window.
    if (!Array.isArray(this.st.window)) this.st.window = [];
    if (this.st.remoteMinute === undefined) this.st.remoteMinute = null;
    this.role = (await this.ctx.storage.get<GateRole>("role")) ?? null;
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
      window: [],
      capacity: this.limits.perMinute,
      remoteMinute: null,
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

  /**
   * A Durable Object has ONE alarm, shared by the usage flush (division gates) and the stash retry
   * (token authorities). Both arm it through here, which only ever moves it earlier, so neither
   * use can push the other's back or cancel it; `alarm()` does both jobs whenever it fires.
   */
  private async armAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    this.alarmScheduled = false;
    // A token authority with a stashed token pair keeps trying to write it to D1 (review N2).
    // Done first and never throws, so a failing usage flush cannot starve it.
    if (this.role?.startsWith("authority:")) {
      const id = Number(this.role.slice("authority:".length));
      try {
        await this.flushPending(id);
      } catch {
        /* D1 still down: the check below re-arms the alarm */
      }
      if ((await this.ctx.storage.get(pendingKey(id))) !== undefined) {
        await this.armAlarm(this.now() + PENDING_RETRY_MS);
      }
    }
    if (this.dirty) await this.flushUsage();
  }

  // ---------------------------------------------------------------------------------------
  // Token authority (called by division gates over RPC; also usable directly)
  // ---------------------------------------------------------------------------------------

  /**
   * Returns a usable access token, refreshing if it expires within 30 s. Concurrent callers
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

  /**
   * Writes a stashed token pair (kept in DO storage after two failed D1 writes) to D1. Returns
   * the stash that is still pending, or null. The stash holds ciphertext only.
   */
  private async flushPending(connectionId: number): Promise<PendingTokens | null> {
    const pending = await this.ctx.storage.get<PendingTokens>(pendingKey(connectionId));
    if (!pending) return null;
    try {
      await this.persistTokens(
        connectionId,
        pending.baseRefreshEnc,
        pending.accessEnc,
        pending.refreshEnc,
        pending.expiresAt,
      );
    } catch {
      return pending; // D1 still failing: keep it
    }
    // Written, or the row changed meanwhile (disconnect or re-authorise): either way done.
    await this.ctx.storage.delete(pendingKey(connectionId));
    return null;
  }

  /**
   * Earliest time this token may be refreshed: min(issued + MIN_REFRESH_AGE_MS, expires -
   * REFRESH_MARGIN_MS). The issue time comes from the record written on every refresh; without one
   * (tokens from the connect callback or an older build) a 600 s lifetime is assumed, and a token
   * with more than that left is older than we can know, so it counts as old enough.
   */
  private async earliestRefreshAt(
    connectionId: number,
    expiresAtIso: string | null,
  ): Promise<number> {
    const now = this.now();
    const parsed = expiresAtIso ? Date.parse(expiresAtIso) : NaN;
    if (!Number.isFinite(parsed)) return now; // no usable expiry: nothing to protect
    let issuedAt: number;
    let saved: { expiresAt: string; issuedAt: number } | undefined;
    try {
      saved = await this.ctx.storage.get(issuedKey(connectionId));
    } catch {
      saved = undefined;
    }
    if (saved && saved.expiresAt === expiresAtIso && Number.isFinite(saved.issuedAt)) {
      issuedAt = saved.issuedAt;
    } else {
      const derived = parsed - TOKEN_LIFETIME_MS;
      issuedAt = derived > now ? now - MIN_REFRESH_AGE_MS : derived;
    }
    return Math.min(issuedAt + MIN_REFRESH_AGE_MS, parsed - REFRESH_MARGIN_MS);
  }

  /** Counts a client_rejected answer; true once it has repeated long enough to report. */
  private async noteClientRejected(connectionId: number): Promise<boolean> {
    const now = this.now();
    const key = clientRejectsKey(connectionId);
    const prev = await this.ctx.storage.get<ClientRejects>(key);
    const next: ClientRejects = prev
      ? { count: prev.count + 1, firstAt: prev.firstAt }
      : { count: 1, firstAt: now };
    await this.ctx.storage.put(key, next);
    return next.count >= CLIENT_REJECT_ATTEMPTS && now - next.firstAt >= CLIENT_REJECT_SPAN_MS;
  }

  /**
   * Records that Exact rejects the app's client credentials: `last_error` on the still-active
   * connection plus one audit row, both only if not already recorded. Tokens are not touched: the
   * grant is fine, the fix is EXACT_CLIENT_ID / EXACT_CLIENT_SECRET (an admin's job, not a
   * re-authorisation). A successful refresh clears `last_error` again (persistTokens).
   */
  private async markCredentialsRejected(connectionId: number): Promise<void> {
    const guard = `status = 'active' AND (last_error IS NULL OR last_error <> '${CREDENTIALS_REJECTED}')`;
    const db = this.env.DB;
    await db.batch([
      auditStatement(
        db,
        {
          actorEmail: "system",
          action: "connection.exact_credentials_rejected",
          entity: "connection",
          entityId: connectionId,
          after: { status: "active", reason: CREDENTIALS_REJECTED },
        },
        {
          sql: `EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND ${guard})`,
          binds: [connectionId],
        },
      ),
      db
        .prepare(
          `UPDATE connections SET last_error = ?2,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?1 AND ${guard}`,
        )
        .bind(connectionId, CREDENTIALS_REJECTED),
    ]);
  }

  private async doRefresh(connectionId: number, staleExpiresAt?: string): Promise<TokenResult> {
    const db = this.env.DB;
    try {
      await this.flushPending(connectionId);
      const dbRow = await loadConnectionById(db, connectionId);
      if (!dbRow || dbRow.status !== "active") {
        await this.ctx.storage.delete(pendingKey(connectionId));
        return {
          ok: false,
          code: dbRow?.status === "needs_reauth" ? "needs_reauth" : "not_connected",
          retryable: false,
        };
      }
      // While a rotated pair is stashed, D1 still holds the dead refresh token: use the stash.
      const pending = await this.ctx.storage.get<PendingTokens>(pendingKey(connectionId));
      const row: ExactConnectionRow = pending
        ? {
            ...dbRow,
            access_token_enc: pending.accessEnc,
            refresh_token_enc: pending.refreshEnc,
            expires_at: new Date(pending.expiresAt).toISOString(),
          }
        : dbRow;
      const baseRefreshEnc = pending ? pending.baseRefreshEnc : dbRow.refresh_token_enc;
      const keys = keyring(this.env);
      const now = this.now();
      const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
      const forced = staleExpiresAt !== undefined && row.expires_at === staleExpiresAt;
      const usableOld = async (): Promise<TokenResult | null> =>
        row.access_token_enc && exp - this.now() > 2_000
          ? {
              ok: true,
              accessToken: await decryptToken(keys, row.access_token_enc, aad(row.id, "access")),
              expiresAt: exp,
            }
          : null;
      const stillFresh =
        row.access_token_enc !== null &&
        exp - now > REFRESH_MARGIN_MS &&
        (staleExpiresAt === undefined || row.expires_at !== staleExpiresAt);
      if (stillFresh) {
        // Another refresh (or a reconnect) already produced a good token: do not burn the
        // single-use refresh token again.
        const t = await usableOld();
        if (t) return t;
      }
      if (!row.refresh_token_enc || !baseRefreshEnc) {
        await markNeedsReauth(db, row.id, "no_refresh_token");
        return { ok: false, code: "needs_reauth", retryable: false };
      }

      // Never refresh a token younger than the minimum age (B2).
      const earliest = await this.earliestRefreshAt(row.id, row.expires_at);
      if (now < earliest) {
        if (forced) {
          // Exact rejected a token we may not refresh yet: the caller waits and retries once.
          return { ok: false, code: "token_too_young", retryable: true };
        }
        if (earliest - now <= MAX_AGE_WAIT_MS) {
          await this.sleep(earliest - now);
        } else {
          return (await usableOld()) ?? { ok: false, code: "token_refresh_retry", retryable: true };
        }
      } else if (!forced && this.refreshCooldownUntil > now) {
        const t = await usableOld();
        if (t) return t;
      }
      if (this.clientRejectedUntil > this.now()) {
        // Exact keeps rejecting our client credentials: do not hammer the token endpoint.
        return (await usableOld()) ?? { ok: false, code: CREDENTIALS_REJECTED, retryable: true };
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
      let lastFailure = "unavailable";
      let credentialsRejected = false;
      for (let attempt = 0; ; attempt++) {
        try {
          tokens = await refreshTokens(
            {
              host: row.region_host,
              clientId: cfg.config.clientId,
              clientSecret: cfg.config.clientSecret,
            },
            refreshToken,
          );
          break;
        } catch (e) {
          const failure = e instanceof TokenEndpointError ? e.failure : "unavailable";
          lastFailure = failure;
          // Only a clear invalid_grant means the grant is gone. Everything else, including a
          // premature-refresh rejection whose body we cannot classify and a 2xx we cannot read,
          // keeps the tokens (a spent refresh token answers invalid_grant on the next try).
          if (failure === "invalid_grant") {
            await markNeedsReauth(db, row.id, failure);
            await this.ctx.storage.delete([
              pendingKey(connectionId),
              clientRejectsKey(connectionId),
            ]);
            return { ok: false, code: "needs_reauth", retryable: false };
          }
          if (failure === "client_rejected" && (await this.noteClientRejected(row.id))) {
            credentialsRejected = true;
            break; // retrying with the same wrong credentials cannot help
          }
          const delay = REFRESH_RETRY_DELAYS_MS[attempt];
          if (failure === "bad_host" || delay === undefined) break;
          await this.sleep(delay);
        }
      }
      if (!tokens) {
        this.refreshCooldownUntil = this.now() + REFRESH_COOLDOWN_MS;
        if (credentialsRejected) {
          this.clientRejectedUntil = this.now() + CLIENT_REJECT_COOLDOWN_MS;
          try {
            await this.markCredentialsRejected(row.id);
          } catch {
            /* D1 down: reported on the next attempt */
          }
        }
        if (!forced) {
          const t = await usableOld(); // the old token still works: keep using it
          if (t) return t;
        }
        return {
          ok: false,
          code: credentialsRejected
            ? CREDENTIALS_REJECTED
            : lastFailure === "unavailable"
              ? "token_endpoint_unavailable"
              : "token_refresh_retry",
          retryable: true,
        };
      }

      // The old refresh token is spent. Persist the new one BEFORE the new access token is used;
      // if D1 fails twice, stash the encrypted pair in DO storage instead (review N2).
      const issuedAt = this.now();
      const expiresAt = issuedAt + tokens.expiresInS * 1000;
      let persisted = false;
      let stashed = false;
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
          try {
            persisted = await this.persistTokens(
              row.id,
              baseRefreshEnc,
              accessEnc,
              refreshEnc,
              expiresAt,
            );
          } catch {
            persisted = await this.persistTokens(
              row.id,
              baseRefreshEnc,
              accessEnc,
              refreshEnc,
              expiresAt,
            );
          }
        } catch {
          const stash: PendingTokens = { baseRefreshEnc, accessEnc, refreshEnc, expiresAt };
          await this.ctx.storage.put(pendingKey(row.id), stash);
          persisted = true;
          stashed = true;
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
      // The new pair is safe (D1 or stash). Everything below is bookkeeping: a failure here must
      // never turn into needs_reauth, which would wipe the tokens that were just saved.
      this.clientRejectedUntil = 0;
      try {
        await this.ctx.storage.put(issuedKey(row.id), {
          expiresAt: new Date(expiresAt).toISOString(),
          issuedAt,
        });
        // A direct write supersedes any older stash (same base refresh token in D1).
        if (!stashed) await this.ctx.storage.delete(pendingKey(row.id));
        await this.ctx.storage.delete(clientRejectsKey(row.id));
        if (stashed) await this.armAlarm(this.now() + PENDING_RETRY_MS);
      } catch {
        /* without the issued record the age falls back to expires_at - 600 s (same answer) */
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
    this.pruneWindow(now);
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
      wait = this.minuteWait(now);
      if (wait <= 0) return 0;
    }
    if (now - item.enqueuedAt + wait > this.limits.maxQueueWaitMs) {
      throw new ExactRateLimitedError(wait);
    }
    return wait;
  }

  private spend(req: ExactRequest): void {
    const at = this.now();
    this.st.window.push(at);
    if (this.st.remoteMinute) this.st.remoteMinute.left--;
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

  /** Drops calls older than 60 s. Entries at exactly now-60s are out: any 60 s span is [t, t+60s). */
  private pruneWindow(now: number): void {
    const w = this.st.window;
    let n = 0;
    while (n < w.length && (w[n] as number) <= now - 60_000) n++;
    if (n > 0) w.splice(0, n);
    // A clock that went backwards must not let the log grow or lock the gate for long.
    if (w.length > 0 && (w[w.length - 1] as number) > now) {
      for (let i = 0; i < w.length; i++) w[i] = Math.min(w[i] as number, now);
    }
    const r = this.st.remoteMinute;
    if (r && now >= r.until) this.st.remoteMinute = null;
  }

  /**
   * Sliding-window limiter (review S1): never more than `cap` calls in any 60 s, with or without
   * rate-limit headers. Returns 0 to go now, else ms until a slot frees. Exact's own minute count
   * (remoteMinute) can only make this stricter.
   */
  private minuteWait(now: number): number {
    const w = this.st.window;
    const cap = Math.max(1, Math.min(this.st.capacity, this.limits.perMinute));
    let wait = 0;
    if (w.length >= cap) {
      wait = (w[w.length - cap] as number) + 60_000 - now;
    }
    const r = this.st.remoteMinute;
    if (r && r.left < 1) wait = Math.max(wait, r.until - now);
    return wait > 0 ? Math.ceil(wait) : 0;
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
      void this.armAlarm(this.now() + this.limits.flushIntervalMs).catch(() => {
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
      if (item.retried) {
        // A token too young to refresh was rejected twice: retryable, not a lost grant.
        if (item.youngRetry)
          throw new ExactApiError(503, "token refresh failed", "token_refresh_retry");
        throw new ExactAuthError("unauthorized");
      }
      // Revoked or rotated elsewhere: force one refresh (only if the stored token is still the
      // one Exact rejected, and only if it is old enough to refresh) and retry once.
      const forced = await getExactGate(this.env, `exact-token:${row.id}`).refreshAccessToken(
        row.id,
        row.expires_at ?? undefined,
      );
      if (!forced.ok && forced.code === "token_too_young") {
        item.retried = true;
        item.youngRetry = true;
        await this.sleep(YOUNG_401_WAIT_MS);
        this.queue.unshift(item);
        return null;
      }
      if (!forced.ok) throw this.tokenError(forced);
      item.retried = true;
      // The authority handed back the same token (it joined a refresh that reused it, or a stash
      // of the same pair): a second 401 then says nothing about the grant, so keep it retryable.
      if (row.expires_at !== null && forced.expiresAt === Date.parse(row.expires_at)) {
        item.youngRetry = true;
      }
      this.queue.unshift(item);
      return null;
    }
    return { status: res.status, headers: outHeaders, body };
  }

  private authority(connectionId: number): DurableObjectStub<ExactGate> {
    return getExactGate(this.env, `exact-token:${connectionId}`);
  }

  private tokenError(r: Extract<TokenResult, { ok: false }>): Error {
    // Retryable token trouble (a refresh Exact refused for now, an endpoint outage) is a 503, never
    // an auth error: only a clear invalid_grant ends the connection (review B2).
    return r.retryable
      ? new ExactApiError(
          503,
          "token refresh failed",
          r.code === "token_too_young" ? "token_refresh_retry" : r.code,
        )
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

  /**
   * Trust Exact's numbers over our own counters, but only to TIGHTEN the limiter. How the headers
   * are read (names, epoch seconds or milliseconds, decimals) is `parseRateLimitHeaders` in
   * @camelthorn/exact, shared with the client.
   */
  private readRateHeaders(h: Record<string, string>, now: number): void {
    const info = parseRateLimitHeaders(h, now);
    const s = this.st;
    const dayRemaining = info.daily.remaining;
    if (dayRemaining !== null) {
      const resetMs = info.daily.resetAtMs;
      s.remote = {
        dayLimit: Math.min(
          info.daily.limit ?? s.remote?.dayLimit ?? this.limits.perDay,
          this.limits.perDay,
        ),
        dayRemaining: Math.max(0, dayRemaining),
        dayResetMs: resetMs !== null && resetMs > now ? resetMs : null,
      };
    }
    const minuteLimit = info.minutely.limit;
    // Never above the configured per-minute cap: a header may only tighten the limiter.
    if (minuteLimit !== null && minuteLimit >= 1) {
      s.capacity = Math.min(Math.floor(minuteLimit), this.limits.perMinute);
    }
    const minuteRemaining = info.minutely.remaining;
    if (minuteRemaining !== null) {
      const resetMs = info.minutely.resetAtMs;
      const until =
        resetMs !== null && resetMs > now ? Math.min(resetMs, now + 120_000) : now + 60_000;
      const left = Math.max(0, Math.floor(minuteRemaining));
      // Keep the stricter of Exact's count and ours; it can only lower what we allow.
      if (!s.remoteMinute || left <= s.remoteMinute.left || now >= s.remoteMinute.until) {
        s.remoteMinute = { left, until };
      }
      if (minuteRemaining < 1 && resetMs !== null && resetMs > now) {
        s.blockedUntil = Math.max(s.blockedUntil, until);
      }
    }
  }

  /** Blocks the gate per Retry-After / reset headers after a 429; returns the wait in ms. */
  private blockFor429(h: Record<string, string>, now: number): number {
    const ms = retryAfterFromHeaders(h, now, {
      dailyExhausted: this.st.remote !== null && this.st.remote.dayRemaining <= 0,
    });
    const wait = Math.min(MAX_BLOCK_MS, Math.max(1000, ms));
    this.st.blockedUntil = now + wait;
    this.st.limited++;
    this.markDirty();
    return wait;
  }
}
