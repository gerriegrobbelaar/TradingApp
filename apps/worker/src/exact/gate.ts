/**
 * ExactGate: one Durable Object per Exact division ("exact:<division>") that every Exact call
 * goes through, plus one "token authority" instance per connection ("exact-token:<id>") that is
 * the only place an OAuth refresh ever happens (docs/decisions/0015-exactgate-design.md).
 *
 * The queue, limiter, budgets, role pin and token refresh skeleton are the shared GateCore
 * (../gate/core.ts, docs/decisions/0048-shared-gate-core.md). This file holds only what is Exact's
 * own: the daily budget with a user reserve and Exact's rate-limit headers, the minimum token age,
 * the write policy re-read from D1, the XML/REST request shape and the 401 rules for writes.
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
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  ExactWriteAuthRetryRefused,
  parseRateLimitHeaders,
  retryAfterFromHeaders,
  type ExactRequest,
  type ExactResponse,
} from "@camelthorn/exact";
import { decryptToken, keyring } from "../crypto/token-crypto";
import type { Env } from "../env";
import {
  CREDENTIALS_REJECTED,
  GateCore,
  type Queued,
  type RefreshedTokens,
  type SavedPair,
  type ThrottleContext,
  type TokenResult,
} from "../gate/core";
import { loadExactConfig } from "./config";
import { getExactGate } from "./gate-transport";
import { refreshTokens, TokenEndpointError } from "./oauth";
import { buildUrl, validateRequest } from "./request";
import { allowedReadShape, isWrite, refuseWrite } from "./write-policy";
import {
  aad,
  loadConnectionById,
  loadExactConnection,
  markNeedsReauth,
  type ExactConnectionRow,
} from "./store";
import { toWire, type WireError } from "./wire";

export { CREDENTIALS_REJECTED };
export type { TokenResult };

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
/** Longest daily window an X-RateLimit-Reset header may announce (24 h plus clock slack). */
const MAX_DAY_WINDOW_MS = 25 * 3600 * 1000;
/** Wait before retrying a call whose 401 came from a token too young to refresh. */
const YOUNG_401_WAIT_MS = 2_000;
const MAX_BLOCK_MS = 24 * 3600 * 1000;
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

const issuedKey = (connectionId: number): string => `issued:${connectionId}`;

export class ExactGate extends GateCore<
  ExactRequest,
  ExactResponse,
  WireError,
  LimiterState,
  GateLimits,
  ExactConnectionRow,
  GateRole
> {
  private dirty = false;
  private alarmScheduled = false;
  protected readonly maxBlockMs = MAX_BLOCK_MS;
  protected readonly unreachableMessage = "exact unreachable";
  protected readonly noRetryFailure = "bad_host";
  protected readonly credentialsAudit = {
    action: "connection.exact_credentials_rejected",
    scope: "kind = 'exact' AND ",
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { ...DEFAULT_LIMITS });
    void ctx.blockConcurrencyWhile(() => this.load());
  }

  // ---------------------------------------------------------------------------------------
  // Hooks of the shared core
  // ---------------------------------------------------------------------------------------

  protected freshExtra(): Omit<
    LimiterState,
    "day" | "used" | "userUsed" | "jobUsed" | "limited" | "window" | "blockedUntil"
  > {
    return {
      division: null,
      capacity: this.limits.perMinute,
      remoteMinute: null,
      remote: null,
    };
  }

  protected migrateState(): void {
    if (this.st.remoteMinute === undefined) this.st.remoteMinute = null;
  }

  protected rateLimited(retryAfterMs: number, message?: string): Error {
    return new ExactRateLimitedError(retryAfterMs, message);
  }
  protected budgetExhausted(jobId: string): Error {
    return new ExactBudgetExhaustedError(jobId);
  }
  protected apiError(status: number, message: string, code: string): Error {
    return new ExactApiError(status, message, code);
  }
  protected wireError(e: unknown): WireError {
    return toWire(e);
  }
  protected validate(req: ExactRequest): void {
    validateRequest(req);
  }

  /**
   * Defence in depth (ADR 0044): the gate refuses every write except the two booking writes, and
   * those only while the fail-closed switch and the verification mark say so, read from D1 NOW.
   */
  protected async authorize(req: ExactRequest): Promise<void> {
    await this.assertMethodAllowed(req);
  }

  protected async admit(req: ExactRequest): Promise<void> {
    if (!(await this.claimRole(`division:${req.division}`))) {
      throw new ExactApiError(400, "wrong gate for division", "division_mismatch");
    }
    if (this.st.division === null) {
      this.st.division = req.division;
      await this.persist();
    } else if (this.st.division !== req.division) {
      throw new ExactApiError(400, "wrong gate for division", "division_mismatch");
    }
  }

  private async assertMethodAllowed(req: ExactRequest): Promise<void> {
    if (!isWrite(req)) {
      if (!allowedReadShape(req))
        throw new ExactApiError(403, "exact request refused", "write_not_allowed");
      return;
    }
    const refusal = await refuseWrite(this.env.DB, req);
    if (refusal !== null) throw new ExactApiError(403, "exact write refused", refusal);
  }

  protected authorityConnectionId(): number | null {
    return this.role?.startsWith("authority:")
      ? Number(this.role.slice("authority:".length))
      : null;
  }

  protected minuteCap(): number {
    return Math.max(1, Math.min(this.st.capacity, this.limits.perMinute));
  }

  /** Exact's own minute count (remoteMinute) can only make the wait longer. */
  protected extraMinuteWait(now: number): number {
    const r = this.st.remoteMinute;
    return r && r.left < 1 ? r.until - now : 0;
  }

  protected checkDaily(req: ExactRequest, now: number): void {
    const remaining = this.dayRemaining(now);
    if (remaining <= 0)
      throw new ExactRateLimitedError(this.untilDayReset(now), "daily budget used");
    if (req.priority === "job" && remaining <= this.reserve()) {
      // The last slice of the day is kept for people using the UI.
      throw new ExactRateLimitedError(this.untilDayReset(now), "daily budget reserved");
    }
  }

  protected onSpend(): void {
    if (this.st.remoteMinute) this.st.remoteMinute.left--;
    if (this.st.remote) this.st.remote.dayRemaining = Math.max(0, this.st.remote.dayRemaining - 1);
    this.markDirty();
  }

  protected afterPrune(now: number): void {
    const r = this.st.remoteMinute;
    if (r && now >= r.until) this.st.remoteMinute = null;
  }

  protected onSameDay(now: number): void {
    if (this.st.remote?.dayResetMs != null && now >= this.st.remote.dayResetMs) {
      this.st.remote = null;
    }
  }

  protected onNewDay(now: number): Partial<LimiterState> {
    if (this.dirty) void this.flushUsage().catch(() => undefined); // yesterday's final numbers
    // Exact's own window may end later than UTC midnight; keep its numbers until it says reset.
    const r = this.st.remote;
    return { remote: r && r.dayResetMs !== null && now < r.dayResetMs ? r : null };
  }

  protected onBlocked(): void {
    this.markDirty();
  }

  protected async defaultBudget(jobId: string): Promise<number> {
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

  // ---------------------------------------------------------------------------------------
  // Usage, alarm
  // ---------------------------------------------------------------------------------------

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
    // A token authority with a stashed token pair keeps trying to write it to D1 (review N2).
    // Done first and never throws, so a failing usage flush cannot starve it.
    await this.retryStash();
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
    return this.refreshShared(connectionId, `authority:${connectionId}`, staleExpiresAt);
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
       WHERE id = ?1 AND kind = 'exact' AND status = 'active' AND refresh_token_enc = ?2`,
    )
      .bind(connectionId, oldRefreshEnc, accessEnc, refreshEnc, new Date(expiresAtMs).toISOString())
      .run();
    return r.meta.changes === 1;
  }

  protected loadConnection(id: number): Promise<ExactConnectionRow | null> {
    return loadConnectionById(this.env.DB, id);
  }
  protected markNeedsReauth(id: number, reason: string): Promise<unknown> {
    return markNeedsReauth(this.env.DB, id, reason);
  }
  protected aad(id: number, kind: "access" | "refresh"): string {
    return aad(id, kind);
  }
  protected freshMargin(): number {
    return REFRESH_MARGIN_MS;
  }

  protected persistPair(id: number, baseRefreshEnc: string, p: SavedPair): Promise<boolean> {
    return this.persistTokens(id, baseRefreshEnc, p.accessEnc, p.refreshEnc, p.expiresAt);
  }

  protected async afterTokensSaved(
    row: ExactConnectionRow,
    issuedAt: number,
    expiresAt: number,
  ): Promise<void> {
    await this.ctx.storage.put(issuedKey(row.id), {
      expiresAt: new Date(expiresAt).toISOString(),
      issuedAt,
    });
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
    // The caller's clock reading: compared against the result, so it must be the same instant
    // (a second this.now() here could be a millisecond later and make a token "too young").
    now: number,
  ): Promise<number> {
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

  /** Never refresh a token younger than the minimum age (B2); then the failure cooldown. */
  protected async throttle(ctx: ThrottleContext<ExactConnectionRow>): Promise<TokenResult | null> {
    const { row, now, forced, usableOld } = ctx;
    const earliest = await this.earliestRefreshAt(row.id, row.expires_at, now);
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
    return null;
  }

  protected openEndpoint(
    row: ExactConnectionRow,
  ): TokenResult | ((refreshToken: string) => Promise<RefreshedTokens>) {
    let origin: string;
    try {
      origin = new URL(this.env.EXACT_REDIRECT_URI).origin;
    } catch {
      return { ok: false, code: "server_misconfigured", retryable: false };
    }
    const cfg = loadExactConfig(this.env, origin);
    if (!cfg.ok) return { ok: false, code: "server_misconfigured", retryable: false };
    return (refreshToken) =>
      refreshTokens(
        {
          host: row.region_host,
          clientId: cfg.config.clientId,
          clientSecret: cfg.config.clientSecret,
        },
        refreshToken,
      );
  }

  protected classifyFailure(e: unknown): string {
    return e instanceof TokenEndpointError ? e.failure : "unavailable";
  }

  protected failureResult(lastFailure: string): { code: string; retryable: boolean } {
    return {
      code: lastFailure === "unavailable" ? "token_endpoint_unavailable" : "token_refresh_retry",
      retryable: true,
    };
  }

  // ---------------------------------------------------------------------------------------
  // Daily budget, Exact's headers
  // ---------------------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------------------
  // Executing a call
  // ---------------------------------------------------------------------------------------

  /** Returns null when the request was put back in the queue for one retry after a 401. */
  protected async execute(
    item: Queued<ExactRequest, ExactResponse>,
  ): Promise<ExactResponse | null> {
    const { req } = item;
    const row = await loadExactConnection(this.env.DB);
    // A 'pending' connection holds tokens the connect callback has not verified yet (ADR 0019):
    // they serve GET /current/Me (division 0) and nothing else.
    const verifying =
      row?.status === "pending" &&
      req.division === 0 &&
      req.api === "rest" &&
      req.method === "GET" &&
      req.path === "/Me";
    if (!row || (row.status === "pending" && !verifying) || row.status === "disabled") {
      throw new ExactAuthError("not_connected");
    }
    if (row.status !== "active" && !verifying) throw new ExactAuthError("needs_reauth");
    const url = buildUrl(row.region_host, req);
    // A write may have waited in the queue: the switch is read again right before the call.
    if (isWrite(req)) await this.assertMethodAllowed(req);
    const token = await this.accessTokenFor(row);
    // ...and once more after the (possibly slow) token step, immediately before the network call.
    if (isWrite(req)) await this.assertMethodAllowed(req);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    if (req.api === "rest" && headers.accept === undefined) headers.accept = "application/json";
    headers.authorization = `Bearer ${token}`;

    const res = await this.send(url, req, headers);
    const outHeaders = res.headers;
    this.readRateHeaders(outHeaders, this.now());
    await this.persist(req);

    if (res.status === 429) {
      const retryMs = this.blockFor429(outHeaders, this.now());
      await this.persist();
      throw new ExactRateLimitedError(retryMs);
    }
    if (res.status === 401 && isWrite(req)) {
      // A POST is NEVER re-sent by the gate. Heal the token for the caller's next (read) call, then
      // report the typed refusal: the outcome is treated as unknown and the booker re-probes first.
      await getExactGate(this.env, `exact-token:${row.id}`)
        .refreshAccessToken(row.id, row.expires_at ?? undefined)
        .catch(() => undefined);
      throw new ExactWriteAuthRetryRefused();
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
    return { status: res.status, headers: outHeaders, body: res.body };
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
        // Exact's daily window is at most a day long: a reset further out (a garbled or hostile
        // header) is capped, so "0 left" can never lock the gate for longer than that.
        dayResetMs:
          resetMs !== null && resetMs > now ? Math.min(resetMs, now + MAX_DAY_WINDOW_MS) : null,
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
    return this.blockAfter429(ms, now);
  }
}
