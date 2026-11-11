/**
 * RevolutGate: one Durable Object per Revolut connection ("revolut:<connectionId>") that every
 * Revolut call goes through (docs/decisions/0031-revolut-connection.md, mirroring ExactGate,
 * docs/decisions/0015-exactgate-design.md).
 *
 * Unlike Exact, Revolut has one API host and one rate-limit scope per connection, so the gate
 * instance is ALSO the token authority: there is exactly one per connection, which makes the token
 * refresh single-flight by construction. The instance still pins itself to its connection id on
 * first use ("connection:<id>") and refuses any other id, so a refresh for connection N can only
 * ever run in the instance named for N.
 *
 * Queue behaviour: the queue is in memory. If the instance is evicted or redeployed while requests
 * wait, those callers get a retryable error (503 gate_unavailable); nothing is persisted on
 * purpose. The sliding window, counters and job budgets are persisted so an eviction does not hand
 * out a fresh budget.
 *
 * Not allowed in this phase: any payment endpoint (request.ts allow-list). Nothing in here logs
 * request bodies, URLs, IBANs or tokens.
 */
import { DurableObject } from "cloudflare:workers";
import {
  RevolutApiError,
  RevolutAuthError,
  RevolutBudgetExhaustedError,
  RevolutRateLimitedError,
  type RevolutRequest,
  type RevolutResponse,
} from "@camelthorn/revolut";
import { auditStatement } from "../db/audit";
import { decryptToken, encryptToken, keyring, TokenCryptoError } from "../crypto/token-crypto";
import type { Env } from "../env";
import { loadRevolutConfig, revolutWebhookUrl } from "./config";
import { refreshTokens, TokenEndpointError } from "./oauth";
import { buildUrl, JOB_ID_RE, validateRequest, versionOf } from "./request";
import {
  aad,
  environmentOf,
  isLivePending,
  loadRevolutById,
  markNeedsReauth,
  reencryptWebhookSecrets,
  type RevolutConnectionRow,
} from "./store";
import { toWire, type GateResult } from "./wire";

export interface GateLimits {
  /**
   * ASSUMPTION (verify with credentials): Revolut documents no exact per-minute figure for the
   * Business API; 60 per minute is the conservative working value, same as Exact.
   */
  perMinute: number;
  /** A queued request that would wait longer than this fails with a retryable error. */
  maxQueueWaitMs: number;
  /** Per-run budget for a job that has none configured. */
  defaultJobBudget: number;
  fetchTimeoutMs: number;
}

export const DEFAULT_LIMITS: GateLimits = {
  perMinute: 60,
  maxQueueWaitMs: 90_000,
  defaultJobBudget: 200,
  fetchTimeoutMs: 30_000,
};

/**
 * Token timing. ASSUMPTION (verify with credentials): the access token lives about 40 minutes
 * (the real expiry always comes from `expires_in`). A token with REFRESH_MARGIN_MS or less left is
 * refreshed by the next call that needs it; never earlier without a reason (a 401 on the stored
 * token is one).
 */
export const TOKEN_LIFETIME_MS = 40 * 60_000;
export const REFRESH_MARGIN_MS = 60_000;
/** A refresh the token endpoint rejects (unclassifiable) is retried after these waits. */
const REFRESH_RETRY_DELAYS_MS = [5_000, 15_000];
/** After a failed refresh with a still-valid token, do not try again for this long. */
const REFRESH_COOLDOWN_MS = 10_000;
/** Retry persisting a stashed token pair this often (alarm). */
const PENDING_RETRY_MS = 30_000;
/** invalid_client this many times in a row, over at least this long, flags CREDENTIALS_REJECTED. */
const CLIENT_REJECT_ATTEMPTS = 3;
const CLIENT_REJECT_SPAN_MS = 60_000;
const CLIENT_REJECT_COOLDOWN_MS = 60_000;
export const CREDENTIALS_REJECTED = "token_endpoint_rejected_credentials";
const DEFAULT_429_WAIT_MS = 60_000;
const MAX_BLOCK_MS = 3600_000;
const JOB_TTL_MS = 24 * 3600 * 1000;
/** After this many user calls in a row with a job call waiting, the oldest job call goes next. */
const USER_BURST = 5;

type GateRole = `connection:${number}`;

/** The job id of the connect callback's account check (the only use of a staged connection). */
export const CONNECT_JOB_ID = "revolut-connect";
const PENDING_DETAILS_RE =
  /^\/accounts\/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\/bank-details$/;

interface LimiterState {
  day: string;
  used: number;
  userUsed: number;
  jobUsed: number;
  limited: number;
  /** Start times (ms, ascending) of calls in the last 60 s; never longer than the cap. */
  window: number[];
  blockedUntil: number;
}

interface JobState {
  budget: number;
  used: number;
  startedAt: number;
}

interface Queued {
  req: RevolutRequest;
  enqueuedAt: number;
  retried: boolean;
  resolve: (r: RevolutResponse) => void;
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
  /** When Revolut said the refresh token expires (ms), if it did. */
  refreshExpiresAt?: number | null;
}
const pendingKey = (id: number): string => `pending:${id}`;
const clientRejectsKey = (id: number): string => `client-rejects:${id}`;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Retry-After as seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(headers: Record<string, string>, now: number): number | null {
  const v = headers["retry-after"]?.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export class RevolutGate extends DurableObject<Env> {
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
  private role: GateRole | null = null;
  private userStreak = 0;
  private refreshCooldownUntil = 0;
  private clientRejectedUntil = 0;
  /** The last token this instance obtained (in memory only: an eviction costs one refresh). */
  private issued: { issuedAt: number; expiresAt: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.load());
  }

  private async load(): Promise<void> {
    const saved = await this.ctx.storage.get<LimiterState>("rl");
    this.st = saved ?? this.freshState(Date.now());
    if (!Array.isArray(this.st.window)) this.st.window = [];
    this.role = (await this.ctx.storage.get<GateRole>("role")) ?? null;
  }

  /** An instance serves exactly one connection, pinned on first use. */
  private async claimRole(connectionId: number): Promise<boolean> {
    const role: GateRole = `connection:${connectionId}`;
    if (this.role === role) return true;
    if (this.role !== null) return false;
    this.role = role;
    await this.ctx.storage.put("role", role);
    return true;
  }

  private freshState(now: number): LimiterState {
    return {
      day: dayOf(now),
      used: 0,
      userUsed: 0,
      jobUsed: 0,
      limited: 0,
      window: [],
      blockedUntil: 0,
    };
  }

  // ---------------------------------------------------------------------------------------
  // Public RPC
  // ---------------------------------------------------------------------------------------

  /** RPC entry point: always resolves with an envelope (errors lose their class over RPC). */
  async call(req: RevolutRequest): Promise<GateResult> {
    try {
      return { ok: true, response: await this.request(req) };
    } catch (e) {
      return { ok: false, error: toWire(e) };
    }
  }

  async request(req: RevolutRequest): Promise<RevolutResponse> {
    validateRequest(req);
    if (!(await this.claimRole(req.connectionId))) {
      throw new RevolutApiError(400, "wrong gate for connection", "connection_mismatch");
    }
    if (req.priority === "job") {
      const job = await this.ensureJob(req.jobId);
      if (job.used >= job.budget) throw new RevolutBudgetExhaustedError(req.jobId);
    }
    return new Promise<RevolutResponse>((resolve, reject) => {
      this.queue.push({ req, enqueuedAt: this.now(), retried: false, resolve, reject });
      void this.pump();
    });
  }

  /** Starts (or restarts) a job run with its own call budget. */
  async startJob(jobId: string, budget?: number): Promise<{ jobId: string; budget: number }> {
    if (!JOB_ID_RE.test(jobId)) throw new RevolutApiError(400, "invalid job id", "job_id");
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1 || budget > 100_000)) {
      throw new RevolutApiError(400, "invalid budget", "budget");
    }
    const now = this.now();
    const job: JobState = {
      budget: budget ?? this.limits.defaultJobBudget,
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
  usage(): { day: string; used: number; queued: number; blockedUntil: number; windowUsed: number } {
    const now = this.now();
    this.rollover(now);
    this.pruneWindow(now);
    return {
      day: this.st.day,
      used: this.st.used,
      queued: this.queue.length,
      blockedUntil: this.st.blockedUntil,
      windowUsed: this.st.window.length,
    };
  }

  /** The alarm only retries a stashed token pair (see doRefresh). */
  async alarm(): Promise<void> {
    if (this.role?.startsWith("connection:")) {
      const id = Number(this.role.slice("connection:".length));
      try {
        await this.flushPending(id);
      } catch {
        /* D1 still down: re-armed below */
      }
      if ((await this.ctx.storage.get(pendingKey(id))) !== undefined) {
        await this.ctx.storage.setAlarm(this.now() + PENDING_RETRY_MS);
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Token authority
  // ---------------------------------------------------------------------------------------

  /**
   * Returns a usable access token, refreshing if it expires within the margin. Concurrent callers
   * share one refresh. `staleExpiresAt` is the `expires_at` of a token Revolut just rejected: a
   * refresh is forced only if the stored token is still that one.
   */
  // A JS-private method on purpose: Workers RPC exposes every public method of a Durable Object,
  // and this one returns a plaintext access token. It must never be callable from outside.
  #refreshAccessToken(connectionId: number, staleExpiresAt?: string): Promise<TokenResult> {
    if (this.refreshing && this.refreshing.connectionId === connectionId) {
      return this.refreshing.promise;
    }
    const promise = (async (): Promise<TokenResult> => {
      if (!Number.isSafeInteger(connectionId) || connectionId < 1) {
        return { ok: false, code: "not_connected", retryable: false };
      }
      if (!(await this.claimRole(connectionId))) {
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
   * token changed because someone re-authorised meanwhile). Throws on a D1 error. Public only so
   * tests can simulate a storage failure.
   */
  async persistTokens(
    connectionId: number,
    oldRefreshEnc: string,
    accessEnc: string,
    refreshEnc: string,
    expiresAtMs: number,
    refreshExpiresAtMs: number | null = null,
    // A NEW refresh token without a stated expiry: the stored expiry belonged to the old one, so it
    // is cleared (unknown) rather than kept. Without rotation it is kept.
    rotated = false,
  ): Promise<boolean> {
    const r = await this.env.DB.prepare(
      `UPDATE connections
       SET access_token_enc = ?3, refresh_token_enc = ?4, expires_at = ?5, last_error = NULL,
           refresh_expires_at = CASE WHEN ?6 IS NOT NULL THEN ?6
                                     WHEN ?7 = 1 THEN NULL ELSE refresh_expires_at END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1 AND kind = 'revolut' AND status = 'active' AND refresh_token_enc = ?2`,
    )
      .bind(
        connectionId,
        oldRefreshEnc,
        accessEnc,
        refreshEnc,
        new Date(expiresAtMs).toISOString(),
        refreshExpiresAtMs === null ? null : new Date(refreshExpiresAtMs).toISOString(),
        rotated ? 1 : 0,
      )
      .run();
    return r.meta.changes === 1;
  }

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
        pending.refreshExpiresAt ?? null,
        true, // only a rotated pair is ever stashed
      );
    } catch {
      return pending; // D1 still failing: keep it
    }
    await this.ctx.storage.delete(pendingKey(connectionId));
    return null;
  }

  private async noteClientRejected(connectionId: number): Promise<boolean> {
    const now = this.now();
    const key = clientRejectsKey(connectionId);
    const prev = await this.ctx.storage.get<{ count: number; firstAt: number }>(key);
    const next = prev
      ? { count: prev.count + 1, firstAt: prev.firstAt }
      : { count: 1, firstAt: now };
    await this.ctx.storage.put(key, next);
    return next.count >= CLIENT_REJECT_ATTEMPTS && now - next.firstAt >= CLIENT_REJECT_SPAN_MS;
  }

  /**
   * Records that Revolut rejects the app's client credentials (client id, key or issuer):
   * `last_error` on the still-active connection plus one audit row, both only if not already
   * recorded. Tokens are not touched: the grant is fine, the fix is REVOLUT_CLIENT_ID /
   * REVOLUT_PRIVATE_KEY / REVOLUT_ISSUER (an admin's job, not a re-authorisation).
   */
  private async markCredentialsRejected(connectionId: number): Promise<void> {
    const guard = `kind = 'revolut' AND status = 'active' AND (last_error IS NULL OR last_error <> '${CREDENTIALS_REJECTED}')`;
    const db = this.env.DB;
    await db.batch([
      auditStatement(
        db,
        {
          actorEmail: "system",
          action: "connection.revolut_credentials_rejected",
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
      const dbRow = await loadRevolutById(db, connectionId);
      if (!dbRow || dbRow.status !== "active") {
        await this.ctx.storage.delete(pendingKey(connectionId));
        return {
          ok: false,
          code: dbRow?.status === "needs_reauth" ? "needs_reauth" : "not_connected",
          retryable: false,
        };
      }
      const environment = environmentOf(dbRow);
      if (!environment) return { ok: false, code: "not_connected", retryable: false };
      // While a rotated pair is stashed, D1 still holds the dead refresh token: use the stash.
      const pending = await this.ctx.storage.get<PendingTokens>(pendingKey(connectionId));
      const row: RevolutConnectionRow = pending
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
        exp - now > this.marginFor(exp) &&
        (staleExpiresAt === undefined || row.expires_at !== staleExpiresAt);
      if (stillFresh) {
        // A refresh (or a reconnect) already produced a good token: do not refresh again.
        const t = await usableOld();
        if (t) return t;
      }
      if (!row.refresh_token_enc || !baseRefreshEnc) {
        await markNeedsReauth(db, row.id, "no_refresh_token");
        return { ok: false, code: "needs_reauth", retryable: false };
      }
      if (!forced && this.refreshCooldownUntil > now) {
        const t = await usableOld();
        if (t) return t;
      }
      if (this.clientRejectedUntil > this.now()) {
        return (await usableOld()) ?? { ok: false, code: CREDENTIALS_REJECTED, retryable: true };
      }

      const refreshToken = await decryptToken(keys, row.refresh_token_enc, aad(row.id, "refresh"));
      let origin: string;
      try {
        origin = new URL(this.env.REVOLUT_REDIRECT_URI).origin;
      } catch {
        return { ok: false, code: "server_misconfigured", retryable: false };
      }
      const cfg = loadRevolutConfig(this.env, origin);
      if (!cfg.ok) return { ok: false, code: "server_misconfigured", retryable: false };

      let tokens;
      let lastFailure = "unavailable";
      let credentialsRejected = false;
      for (let attempt = 0; ; attempt++) {
        try {
          tokens = await refreshTokens(environment, cfg.config, refreshToken, this.now());
          break;
        } catch (e) {
          const failure = e instanceof TokenEndpointError ? e.failure : "unavailable";
          lastFailure = failure;
          // Only a clear invalid_grant means the grant is gone. Everything else keeps the tokens.
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
          if (failure === "bad_config" || delay === undefined) break;
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
          const t = await usableOld();
          if (t) return t; // the old token still works: keep using it
        }
        return {
          ok: false,
          code: credentialsRejected
            ? CREDENTIALS_REJECTED
            : lastFailure === "unavailable"
              ? "token_endpoint_unavailable"
              : lastFailure === "bad_config"
                ? "server_misconfigured"
                : "token_refresh_retry",
          retryable: lastFailure !== "bad_config",
        };
      }

      // Persist BEFORE the new access token is used. If Revolut rotated the refresh token the old
      // one may be spent, so the pair must not be lost: after two failed D1 writes it is stashed
      // (ciphertext) in DO storage and retried on the alarm. Without rotation the stored refresh
      // token is still good, so a failed write costs only a repeat refresh later.
      const issuedAt = this.now();
      const expiresAt = issuedAt + tokens.expiresInS * 1000;
      const refreshExpiresAt =
        tokens.refreshExpiresInS === null ? null : issuedAt + tokens.refreshExpiresInS * 1000;
      const rotated = tokens.refreshToken !== null;
      let persisted = false;
      let stashed = false;
      try {
        const accessEnc = await encryptToken(
          this.env.TOKEN_ENC_KEY,
          tokens.accessToken,
          aad(row.id, "access"),
        );
        // Always re-encrypted with the current key (also when Revolut did not rotate it), so a
        // TOKEN_ENC_KEY rotation completes after one refresh cycle (docs/DEPLOY.md).
        const refreshEnc = await encryptToken(
          this.env.TOKEN_ENC_KEY,
          tokens.refreshToken ?? refreshToken,
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
              refreshExpiresAt,
              rotated,
            );
          } catch {
            persisted = await this.persistTokens(
              row.id,
              baseRefreshEnc,
              accessEnc,
              refreshEnc,
              expiresAt,
              refreshExpiresAt,
              rotated,
            );
          }
        } catch {
          if (rotated) {
            const stash: PendingTokens = {
              baseRefreshEnc,
              accessEnc,
              refreshEnc,
              expiresAt,
              refreshExpiresAt,
            };
            await this.ctx.storage.put(pendingKey(row.id), stash);
            stashed = true;
          }
          persisted = true;
        }
      } catch {
        if (rotated) {
          try {
            await markNeedsReauth(db, row.id, "token_persist_failed");
          } catch {
            /* D1 is down; the next refresh attempt will hit invalid_grant and mark it then */
          }
          return { ok: false, code: "needs_reauth", retryable: false };
        }
        return { ok: false, code: "refresh_failed", retryable: true };
      }
      if (!persisted) {
        // Row changed under us (disconnect or re-authorise). Do not use or keep these tokens.
        return { ok: false, code: "connection_changed", retryable: true };
      }
      this.clientRejectedUntil = 0;
      this.issued = { issuedAt, expiresAt };
      // A TOKEN_ENC_KEY rotation also moves the webhook signing secrets to the current key now
      // (review S3). Best effort: it never fails or delays the token result beyond one read.
      await reencryptWebhookSecrets(this.env, row.id).catch(() => undefined);
      try {
        if (!stashed) await this.ctx.storage.delete(pendingKey(row.id));
        await this.ctx.storage.delete(clientRejectsKey(row.id));
        if (stashed) await this.ctx.storage.setAlarm(this.now() + PENDING_RETRY_MS);
      } catch {
        /* bookkeeping only */
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

  private pickNext(): Queued | undefined {
    const user = this.queue.find((q) => q.req.priority === "user");
    const job = this.queue.find((q) => q.req.priority === "job");
    if (user && job && this.userStreak >= USER_BURST) return job;
    return user ?? job;
  }

  private expireWaiting(): void {
    const now = this.now();
    for (const q of [...this.queue]) {
      if (now - q.enqueuedAt > this.limits.maxQueueWaitMs) {
        this.unqueue(q);
        q.reject(new RevolutRateLimitedError(1000, "queued too long"));
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
      await Promise.resolve(); // let requests enqueued in the same tick all be visible
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
      if (job && job.used >= job.budget) throw new RevolutBudgetExhaustedError(req.jobId);
    }
    let wait: number;
    if (this.st.blockedUntil > now) wait = this.st.blockedUntil - now;
    else {
      wait = this.minuteWait(now);
      if (wait <= 0) return 0;
    }
    if (now - item.enqueuedAt + wait > this.limits.maxQueueWaitMs) {
      throw new RevolutRateLimitedError(wait);
    }
    return wait;
  }

  private spend(req: RevolutRequest): void {
    this.st.window.push(this.now());
    this.st.used++;
    if (req.priority === "user") this.st.userUsed++;
    else {
      this.st.jobUsed++;
      const job = this.jobs.get(req.jobId);
      if (job) job.used++;
    }
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
  }

  /** Sliding window: never more than `perMinute` calls in any 60 s. Returns ms until a slot frees. */
  private minuteWait(now: number): number {
    const w = this.st.window;
    const cap = Math.max(1, this.limits.perMinute);
    if (w.length < cap) return 0;
    return Math.max(0, Math.ceil((w[w.length - cap] as number) + 60_000 - now));
  }

  private rollover(now: number): void {
    const day = dayOf(now);
    if (day === this.st.day) return;
    Object.assign(this.st, { day, used: 0, userUsed: 0, jobUsed: 0, limited: 0 });
  }

  /** Saves the limiter state, plus the budget of the job the request belongs to (if any). */
  private async persist(req?: RevolutRequest): Promise<void> {
    const job = req?.priority === "job" ? this.jobs.get(req.jobId) : undefined;
    if (req && job) await this.ctx.storage.put({ rl: this.st, [`job:${req.jobId}`]: job });
    else await this.ctx.storage.put("rl", this.st);
  }

  // ---------------------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------------------

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
  private async execute(item: Queued): Promise<RevolutResponse | null> {
    const { req } = item;
    const row = await loadRevolutById(this.env.DB, req.connectionId);
    // A 'pending' connection holds tokens an admin has not confirmed yet (they may belong to
    // somebody else's Revolut account, review R2). While the confirmation window is open they
    // serve exactly what the connect callback needs to show the admin what was connected: the
    // account list and each account's bank details, on API 1.0, for the connect call only. No
    // job, no webhook, no transactions, no refresh.
    const verifying =
      row !== null &&
      isLivePending(row, this.now()) &&
      req.priority === "user" &&
      req.jobId === CONNECT_JOB_ID &&
      req.method === "GET" &&
      versionOf(req) === "1.0" &&
      (req.path === "/accounts" || PENDING_DETAILS_RE.test(req.path));
    if (!row || (row.status === "pending" && !verifying) || row.status === "disabled") {
      throw new RevolutAuthError("not_connected");
    }
    if (row.status !== "active" && !verifying) throw new RevolutAuthError("needs_reauth");
    const environment = environmentOf(row);
    if (!environment) throw new RevolutAuthError("not_connected");
    const url = buildUrl(environment, req);
    if (req.method === "POST" && req.path === "/webhooks") this.checkWebhookTarget(req.body);
    const token = await this.accessTokenFor(row);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    if (headers.accept === undefined) headers.accept = "application/json";
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
      throw new RevolutApiError(502, "revolut unreachable", "network");
    }
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k.toLowerCase()] = v;
    });
    await this.persist(req);

    if (res.status === 429) {
      const wait = Math.min(
        MAX_BLOCK_MS,
        Math.max(1000, retryAfterMs(outHeaders, this.now()) ?? DEFAULT_429_WAIT_MS),
      );
      this.st.blockedUntil = this.now() + wait;
      this.st.limited++;
      await this.persist();
      throw new RevolutRateLimitedError(wait);
    }
    if (res.status === 401 && !verifying) {
      if (item.retried) throw new RevolutAuthError("unauthorized");
      // Revoked or replaced elsewhere: force one refresh (only if the stored token is still the
      // one Revolut rejected) and retry once.
      const forced = await this.#refreshAccessToken(row.id, row.expires_at ?? undefined);
      if (!forced.ok) throw this.tokenError(forced);
      item.retried = true;
      this.queue.unshift(item);
      return null;
    }
    if (res.status === 401) throw new RevolutAuthError("unauthorized");
    return { status: res.status, headers: outHeaders, body };
  }

  /**
   * A webhook subscription receives every transaction of the account: it may only ever point at
   * this app's own webhook endpoint (derived from the configured redirect URI's origin).
   */
  private checkWebhookTarget(body: string | undefined): void {
    let target: unknown;
    let expected: string;
    try {
      expected = revolutWebhookUrl(new URL(this.env.REVOLUT_REDIRECT_URI).origin);
      target = (JSON.parse(body ?? "") as { url?: unknown }).url;
    } catch {
      throw new RevolutApiError(400, "invalid revolut request", "webhook_url");
    }
    if (target !== expected) {
      throw new RevolutApiError(400, "invalid revolut request", "webhook_url");
    }
  }

  private tokenError(r: Extract<TokenResult, { ok: false }>): Error {
    // Retryable token trouble (an endpoint outage, an unclassifiable rejection) is a 503, never an
    // auth error: only a clear invalid_grant ends the connection.
    return r.retryable
      ? new RevolutApiError(503, "token refresh failed", r.code)
      : new RevolutAuthError(r.code);
  }

  /**
   * How much lifetime must be left for a token to be used without a refresh. Normally
   * REFRESH_MARGIN_MS; for a token this instance obtained with an unusually short `expires_in`
   * (two margins or less) half its lifetime, so a short-lived token is not refreshed on every call.
   */
  private marginFor(expMs: number): number {
    const i = this.issued;
    if (i === null || i.expiresAt !== expMs) return REFRESH_MARGIN_MS;
    return Math.min(REFRESH_MARGIN_MS, Math.floor((i.expiresAt - i.issuedAt) / 2));
  }

  private async accessTokenFor(row: RevolutConnectionRow): Promise<string> {
    const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
    // While a rotated pair is stashed (D1 write failed), D1's access token is the old one: let
    // the token authority answer from the stash instead.
    const stashed = (await this.ctx.storage.get(pendingKey(row.id))) !== undefined;
    if (!stashed && row.access_token_enc && exp - this.now() > this.marginFor(exp)) {
      try {
        return await decryptToken(keyring(this.env), row.access_token_enc, aad(row.id, "access"));
      } catch {
        throw new RevolutAuthError("token_unreadable");
      }
    }
    const r = await this.#refreshAccessToken(row.id);
    if (!r.ok) throw this.tokenError(r);
    return r.accessToken;
  }
}
