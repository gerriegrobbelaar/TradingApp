/**
 * GateCore: the part of the Exact gate and the Revolut gate that must never differ between them
 * (task G9, docs/decisions/0048-shared-gate-core.md). Both Durable Object classes extend this one
 * class, so a safeguard is fixed in ONE place:
 *
 *  - the in-memory queue with user priority, FIFO inside a priority and the anti-starvation burst;
 *  - the sliding 60 s window, the persisted counters and the UTC day rollover;
 *  - per-job call budgets (stored before the call is spent, persisted so a restart never hands out
 *    a fresh budget) and the rule that a job without a budget still gets one;
 *  - the 429 block (clamped, never shorter than one second);
 *  - the role pin: an instance serves exactly one identity, taken on first use;
 *  - the token refresh skeleton: single flight, no refresh of a fresh token, stash of a rotated
 *    pair in Durable Object storage when D1 fails, one shared alarm, invalid_grant is the ONLY
 *    thing that wipes tokens, repeated invalid_client flags the credentials instead.
 *
 * What differs between the gates is configuration or a hook, listed as the abstract members below
 * (error classes, limits, daily budget, token timing, the write policy, the request pipeline). A
 * subclass never re-implements a rule from this file.
 *
 * Nothing in here logs request bodies, URLs, IBANs or tokens. Token-bearing results leave this
 * class only through the subclasses' own entry points.
 */
import { JOB_ID_RE } from "@camelthorn/core";
import { DurableObject } from "cloudflare:workers";
import { decryptToken, encryptToken, keyring, TokenCryptoError } from "../crypto/token-crypto";
import { auditStatement } from "../db/audit";
import type { Env } from "../env";

export interface CoreLimits {
  perMinute: number;
  /** A queued request that would wait longer than this fails with a retryable error. */
  maxQueueWaitMs: number;
  /** Per-run budget for a job that has none configured. */
  defaultJobBudget: number;
  fetchTimeoutMs: number;
}

export interface CoreState {
  /** UTC day (YYYY-MM-DD) the counters belong to. */
  day: string;
  used: number;
  userUsed: number;
  jobUsed: number;
  limited: number;
  /** Start times (ms, ascending) of calls in the last 60 s; never longer than the cap. */
  window: number[];
  blockedUntil: number;
}

export interface CoreRequest {
  priority: "user" | "job";
  jobId: string;
}

export interface JobState {
  budget: number;
  used: number;
  startedAt: number;
}

export interface Queued<Req, Res> {
  req: Req;
  enqueuedAt: number;
  retried: boolean;
  /** The retry was granted because the 401 token was too young to refresh (Exact only). */
  youngRetry?: boolean;
  resolve: (r: Res) => void;
  reject: (e: unknown) => void;
}

export type TokenResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; code: string; retryable: boolean };

export interface PendingTokens {
  /** The refresh token D1 still holds (the WHERE guard of the eventual write). */
  baseRefreshEnc: string;
  accessEnc: string;
  refreshEnc: string;
  expiresAt: number;
  /** When the provider said the refresh token expires (ms), if it did (Revolut). */
  refreshExpiresAt?: number | null;
}

/** The token columns every connection row has, whichever provider it belongs to. */
export interface TokenRow {
  id: number;
  status: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: string | null;
}

export interface RefreshedTokens {
  accessToken: string;
  /** null = the provider did not rotate the refresh token. */
  refreshToken: string | null;
  expiresInS: number;
  refreshExpiresInS?: number | null;
}

export interface SavedPair {
  accessEnc: string;
  refreshEnc: string;
  expiresAt: number;
  refreshExpiresAt: number | null;
  rotated: boolean;
}

export interface ThrottleContext<R extends TokenRow> {
  row: R;
  exp: number;
  now: number;
  forced: boolean;
  /** The still-valid old token, or null when there is none (or it has under 2 s left). */
  usableOld: () => Promise<TokenResult | null>;
}

export interface HttpOutcome {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Job ids: the one definition lives in @camelthorn/core (job-id.ts). */
export { JOB_ID_RE };
export const CREDENTIALS_REJECTED = "token_endpoint_rejected_credentials";
/** A refresh the token endpoint rejects (unclassifiable) is retried after these waits. */
const REFRESH_RETRY_DELAYS_MS = [5_000, 15_000];
/** After a failed refresh with a still-valid token, do not try again for this long. */
const REFRESH_COOLDOWN_MS = 10_000;
/** Retry persisting a stashed token pair this often (alarm). */
export const PENDING_RETRY_MS = 30_000;
/** invalid_client this many times in a row, over at least this long, flags CREDENTIALS_REJECTED. */
const CLIENT_REJECT_ATTEMPTS = 3;
const CLIENT_REJECT_SPAN_MS = 60_000;
const CLIENT_REJECT_COOLDOWN_MS = 60_000;
const JOB_TTL_MS = 24 * 3600 * 1000;
/**
 * Fairness: after this many user calls in a row while a job call is waiting, the oldest job call
 * goes next. Users still jump the queue, but a steady stream of UI clicks cannot starve a job.
 */
export const USER_BURST = 5;
export const JOB_ID_MAX_BUDGET = 100_000;

export const pendingKey = (connectionId: number): string => `pending:${connectionId}`;
export const clientRejectsKey = (connectionId: number): string => `client-rejects:${connectionId}`;
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export abstract class GateCore<
  Req extends CoreRequest,
  Res,
  Wire,
  S extends CoreState,
  L extends CoreLimits,
  R extends TokenRow,
  Role extends string,
> extends DurableObject<Env> {
  /** Mutable so tests can tighten them; production uses the defaults. */
  limits: L;
  /** Clock and sleeper are replaceable for deterministic tests. */
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  protected st!: S;
  protected jobs = new Map<string, JobState>();
  protected queue: Queued<Req, Res>[] = [];
  protected pumping = false;
  protected role: Role | null = null;
  /** User calls dispatched in a row while a job call was waiting (see USER_BURST). */
  protected userStreak = 0;
  /** Revolut's stash records the refresh token's expiry (null included); Exact's has no such field. */
  protected stashRefreshExpiry = false;
  /** No refresh attempt before this time after a failed one that left a usable token. */
  protected refreshCooldownUntil = 0;
  /** No refresh attempt at all before this time once our client credentials were rejected. */
  protected clientRejectedUntil = 0;
  /** Single flight: at most one refresh per connection is ever running in this instance. */
  private refreshing: { connectionId: number; promise: Promise<TokenResult> } | null = null;

  /** The one load of the persisted state (see `ensureLoaded`). */
  #loading: Promise<void> | null = null;

  /**
   * Single-flight token refresh for a connection; subclasses wrap it in their own entry point.
   *
   * RPC surface rule (review G9): Workers RPC exposes every PROTOTYPE method of a Durable Object
   * (TypeScript `private`/`protected` are not enforced at runtime) and no instance property. So
   * everything that hands out a plaintext token, sends a request past the write policy, or performs
   * the outbound fetch is an instance property or JS-private: `refreshShared`, `send`, the
   * subclasses' `execute` and `#accessTokenFor`. gate-rpc-surface.test.ts pins the full list of
   * prototype methods, so a new one is a reviewed change.
   */
  protected readonly refreshShared: (
    connectionId: number,
    role: Role,
    staleExpiresAt?: string,
  ) => Promise<TokenResult>;

  /**
   * The one outbound fetch of a gate: never follows a redirect (the bearer token must not go
   * elsewhere), always has a timeout, and reports any failure as a retryable 502 without details.
   * An instance property (not RPC-callable, see above).
   */
  protected readonly send: (
    url: URL,
    req: { method: string; body?: string | undefined },
    headers: Record<string, string>,
  ) => Promise<HttpOutcome>;

  constructor(ctx: DurableObjectState, env: Env, limits: L) {
    super(ctx, env);
    this.limits = limits;
    this.refreshShared = (connectionId, role, staleExpiresAt) =>
      this.#refreshOnce(connectionId, role, staleExpiresAt);
    this.send = (url, req, headers) => this.#send(url, req, headers);
    // The persisted state is loaded HERE, so no subclass can forget it or run a method before it.
    // The microtask yield lets the subclass constructor (and its field initialisers) finish first;
    // blockConcurrencyWhile keeps every RPC call and the alarm out until the load is done, and the
    // entry points also await `ensureLoaded` (a directly constructed instance, an alarm wake).
    void ctx.blockConcurrencyWhile(async () => {
      await Promise.resolve();
      await this.ensureLoaded();
    });
  }

  /** Loads the persisted state once; every entry point awaits it before touching state. */
  protected ensureLoaded(): Promise<void> {
    if (this.#loading === null) {
      const p = this.load();
      this.#loading = p;
      // A failed load is retried by the next entry point instead of being cached.
      p.catch(() => {
        if (this.#loading === p) this.#loading = null;
      });
    }
    return this.#loading;
  }

  // ---------------------------------------------------------------------------------------
  // Hooks: what differs between the gates
  // ---------------------------------------------------------------------------------------

  /** Extra fields of a brand-new limiter state. */
  protected abstract freshExtra(): Omit<S, keyof CoreState>;
  protected abstract rateLimited(retryAfterMs: number, message?: string): Error;
  protected abstract budgetExhausted(jobId: string): Error;
  protected abstract apiError(status: number, message: string, code: string): Error;
  protected abstract wireError(e: unknown): Wire;
  /** Synchronous request validation (paths, headers, identifiers). Throws. */
  protected abstract validate(req: Req): void;
  /** The write policy: refuses what must not run. Default deny lives in the subclass. */
  protected abstract authorize(req: Req): Promise<void>;
  /** Claims the role and pins the identity of the request. Throws on a mismatch. */
  protected abstract admit(req: Req): Promise<void>;
  /* eslint-disable @typescript-eslint/no-unused-vars -- default hooks ignore their arguments */
  /** Hook for state saved by an older build. */
  protected migrateState(): void {}
  /** Largest per-minute allowance (Exact lets the provider's own header tighten it). */
  protected minuteCap(): number {
    return Math.max(1, this.limits.perMinute);
  }
  /** Extra constraint on the minute window (Exact's remote count), in ms to wait. */
  protected extraMinuteWait(_now: number): number {
    return 0;
  }
  /** Daily budget rules; throws when the request must fail instead of waiting. */
  protected checkDaily(_req: Req, _now: number): void {}
  protected onSpend(_req: Req): void {}
  protected afterPrune(_now: number): void {}
  protected onSameDay(_now: number): void {}
  /** Fields the new day keeps or sets besides the zeroed counters. */
  protected onNewDay(_now: number): Partial<S> {
    return {};
  }
  protected onBlocked(): void {}
  protected defaultBudget(_jobId: string): Promise<number> {
    return Promise.resolve(this.limits.defaultJobBudget);
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */
  /** Largest block a 429 can impose. */
  protected abstract readonly maxBlockMs: number;
  /** Message of the 502 for a call that never got an answer. */
  protected abstract readonly unreachableMessage: string;
  /** How the stash owner is found: the connection id this instance is the token authority for. */
  protected abstract authorityConnectionId(): number | null;

  // Token refresh hooks
  protected abstract loadConnection(id: number): Promise<R | null>;
  protected abstract markNeedsReauth(id: number, reason: string): Promise<unknown>;
  protected abstract aad(id: number, kind: "access" | "refresh"): string;
  /** Checks only the provider needs (Revolut: a corrupt environment column). */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- default hook ignores its argument
  protected checkRow(_row: R): TokenResult | null {
    return null;
  }
  protected abstract freshMargin(expMs: number): number;
  /** Minimum token age (Exact) and the post-failure cooldown. null = go on to refresh. */
  protected abstract throttle(ctx: ThrottleContext<R>): Promise<TokenResult | null>;
  /** A failing TokenResult, or the function that calls the token endpoint for this connection. */
  protected abstract openEndpoint(
    row: R,
  ): TokenResult | ((refreshToken: string) => Promise<RefreshedTokens>);
  protected abstract classifyFailure(e: unknown): string;
  /** The failure that makes a retry pointless (a bad host or a bad configuration). */
  protected abstract readonly noRetryFailure: string;
  protected abstract failureResult(lastFailure: string): { code: string; retryable: boolean };
  /** Writes a refreshed pair to D1; true if the row still matched. Calls `this.persistTokens`. */
  protected abstract persistPair(
    id: number,
    baseRefreshEnc: string,
    pair: SavedPair,
  ): Promise<boolean>;
  /** Provider bookkeeping once a refreshed pair is safe (inside the best-effort block). */
  protected abstract afterTokensSaved(row: R, issuedAt: number, expiresAt: number): Promise<void>;
  /** `connection.<provider>_credentials_rejected` and the SQL that scopes the row to the provider. */
  protected abstract readonly credentialsAudit: { action: string; scope: string };

  // ---------------------------------------------------------------------------------------
  // State, role
  // ---------------------------------------------------------------------------------------

  /** Loads the persisted limiter state (the sliding window included) and role. */
  protected async load(): Promise<void> {
    const saved = await this.ctx.storage.get<S>("rl");
    this.st = saved ?? this.freshState(Date.now());
    // State saved by an older build (token bucket) has no window.
    if (!Array.isArray(this.st.window)) this.st.window = [];
    this.migrateState();
    this.role = (await this.ctx.storage.get<Role>("role")) ?? null;
  }

  /**
   * An instance serves one identity, pinned (and persisted) on first use. Anything else is refused,
   * so a refresh for connection N can only ever run in the instance named for N.
   */
  protected async claimRole(role: Role): Promise<boolean> {
    // Never pin (and persist) a role over a stored one this instance has not read yet.
    await this.ensureLoaded();
    if (this.role === role) return true;
    if (this.role !== null) return false;
    this.role = role;
    await this.ctx.storage.put("role", role);
    return true;
  }

  protected freshState(now: number): S {
    return {
      day: dayOf(now),
      used: 0,
      userUsed: 0,
      jobUsed: 0,
      limited: 0,
      window: [],
      blockedUntil: 0,
      ...this.freshExtra(),
    } as unknown as S;
  }

  // ---------------------------------------------------------------------------------------
  // Public RPC
  // ---------------------------------------------------------------------------------------

  /** RPC entry point: always resolves with an envelope (errors lose their class over RPC). */
  async call(req: Req): Promise<{ ok: true; response: Res } | { ok: false; error: Wire }> {
    try {
      return { ok: true, response: await this.request(req) };
    } catch (e) {
      return { ok: false, error: this.wireError(e) };
    }
  }

  async request(req: Req): Promise<Res> {
    this.validate(req);
    await this.ensureLoaded();
    // Defence in depth: the write policy runs before anything is queued or spent.
    await this.authorize(req);
    await this.admit(req);
    if (req.priority === "job") {
      const job = await this.ensureJob(req.jobId);
      if (job.used >= job.budget) throw this.budgetExhausted(req.jobId);
    }
    return new Promise<Res>((resolve, reject) => {
      this.queue.push({ req, enqueuedAt: this.now(), retried: false, resolve, reject });
      void this.pump();
    });
  }

  /** Starts (or restarts) a job run with its own call budget. */
  async startJob(jobId: string, budget?: number): Promise<{ jobId: string; budget: number }> {
    if (!JOB_ID_RE.test(jobId)) throw this.apiError(400, "invalid job id", "job_id");
    await this.ensureLoaded();
    if (
      budget !== undefined &&
      (!Number.isInteger(budget) || budget < 1 || budget > JOB_ID_MAX_BUDGET)
    ) {
      throw this.apiError(400, "invalid budget", "budget");
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
    await this.ensureLoaded();
    const job = this.jobs.get(jobId) ?? (await this.ctx.storage.get<JobState>(`job:${jobId}`));
    this.jobs.delete(jobId);
    await this.ctx.storage.delete(`job:${jobId}`);
    return { used: job?.used ?? 0 };
  }

  /**
   * A Durable Object has ONE alarm, shared by every use (usage flush, stash retry). All of them
   * arm it through here, which only ever moves it earlier, so no use can push another's back or
   * cancel it; `alarm()` does every job whenever it fires.
   */
  protected async armAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /**
   * A token authority with a stashed token pair keeps trying to write it to D1. Never throws, so
   * a failing usage flush after it cannot starve it.
   */
  protected async retryStash(): Promise<void> {
    await this.ensureLoaded(); // an alarm can be the first event after a restart
    const id = this.authorityConnectionId();
    if (id === null) return;
    try {
      await this.flushPending(id);
    } catch {
      /* D1 still down: the check below re-arms the alarm */
    }
    if ((await this.ctx.storage.get(pendingKey(id))) !== undefined) {
      await this.armAlarm(this.now() + PENDING_RETRY_MS);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Token authority: single flight, refresh skeleton, stash
  // ---------------------------------------------------------------------------------------

  /**
   * Concurrent callers for the same connection share one refresh. The result carries a plaintext
   * access token, so this is an instance property and the flow behind it is JS-private: Workers
   * RPC exposes prototype methods only, and none of these is one.
   */
  #refreshOnce(connectionId: number, role: Role, staleExpiresAt?: string): Promise<TokenResult> {
    if (this.refreshing && this.refreshing.connectionId === connectionId) {
      return this.refreshing.promise;
    }
    const promise = (async (): Promise<TokenResult> => {
      if (!Number.isSafeInteger(connectionId) || connectionId < 1) {
        return { ok: false, code: "not_connected", retryable: false };
      }
      if (!(await this.claimRole(role))) {
        return { ok: false, code: "wrong_token_authority", retryable: false };
      }
      return this.#doRefresh(connectionId, staleExpiresAt);
    })().finally(() => {
      if (this.refreshing?.promise === promise) this.refreshing = null;
    });
    this.refreshing = { connectionId, promise };
    return promise;
  }

  /**
   * Writes a stashed token pair (kept in DO storage after two failed D1 writes) to D1. Returns the
   * stash that is still pending, or null. The stash holds ciphertext only.
   */
  protected async flushPending(connectionId: number): Promise<PendingTokens | null> {
    const pending = await this.ctx.storage.get<PendingTokens>(pendingKey(connectionId));
    if (!pending) return null;
    try {
      await this.persistPair(connectionId, pending.baseRefreshEnc, {
        accessEnc: pending.accessEnc,
        refreshEnc: pending.refreshEnc,
        expiresAt: pending.expiresAt,
        refreshExpiresAt: pending.refreshExpiresAt ?? null,
        rotated: true, // only a rotated pair is ever stashed
      });
    } catch {
      return pending; // D1 still failing: keep it
    }
    // Written, or the row changed meanwhile (disconnect or re-authorise): either way done.
    await this.ctx.storage.delete(pendingKey(connectionId));
    return null;
  }

  /** Counts a client_rejected answer; true once it has repeated long enough to report. */
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
   * Records that the provider rejects the app's client credentials: `last_error` on the
   * still-active connection plus one audit row, both only if not already recorded. Tokens are not
   * touched: the grant is fine, the fix is the app's configuration (an admin's job, not a
   * re-authorisation).
   */
  private async markCredentialsRejected(connectionId: number): Promise<void> {
    const { action, scope } = this.credentialsAudit;
    const guard = `${scope}status = 'active' AND (last_error IS NULL OR last_error <> '${CREDENTIALS_REJECTED}')`;
    const db = this.env.DB;
    await db.batch([
      auditStatement(
        db,
        {
          actorEmail: "system",
          action,
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

  async #doRefresh(connectionId: number, staleExpiresAt?: string): Promise<TokenResult> {
    try {
      await this.flushPending(connectionId);
      const dbRow = await this.loadConnection(connectionId);
      if (!dbRow || dbRow.status !== "active") {
        await this.ctx.storage.delete(pendingKey(connectionId));
        return {
          ok: false,
          code: dbRow?.status === "needs_reauth" ? "needs_reauth" : "not_connected",
          retryable: false,
        };
      }
      const rejected = this.checkRow(dbRow);
      if (rejected) return rejected;
      // While a rotated pair is stashed, D1 still holds the dead refresh token: use the stash.
      const pending = await this.ctx.storage.get<PendingTokens>(pendingKey(connectionId));
      const row: R = pending
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
              accessToken: await decryptToken(
                keys,
                row.access_token_enc,
                this.aad(row.id, "access"),
              ),
              expiresAt: exp,
            }
          : null;
      const stillFresh =
        row.access_token_enc !== null &&
        exp - now > this.freshMargin(exp) &&
        (staleExpiresAt === undefined || row.expires_at !== staleExpiresAt);
      if (stillFresh) {
        // A refresh (or a reconnect) already produced a good token: do not refresh again.
        const t = await usableOld();
        if (t) return t;
      }
      if (!row.refresh_token_enc || !baseRefreshEnc) {
        await this.markNeedsReauth(row.id, "no_refresh_token");
        return { ok: false, code: "needs_reauth", retryable: false };
      }
      const throttled = await this.throttle({ row, exp, now, forced, usableOld });
      if (throttled) return throttled;
      if (this.clientRejectedUntil > this.now()) {
        // The provider keeps rejecting our client credentials: do not hammer the token endpoint.
        return (await usableOld()) ?? { ok: false, code: CREDENTIALS_REJECTED, retryable: true };
      }

      const refreshToken = await decryptToken(
        keys,
        row.refresh_token_enc,
        this.aad(row.id, "refresh"),
      );
      const endpoint = this.openEndpoint(row);
      if (typeof endpoint !== "function") return endpoint;

      let tokens: RefreshedTokens | undefined;
      let lastFailure = "unavailable";
      let credentialsRejected = false;
      for (let attempt = 0; ; attempt++) {
        try {
          tokens = await endpoint(refreshToken);
          break;
        } catch (e) {
          const failure = this.classifyFailure(e);
          lastFailure = failure;
          // Only a clear invalid_grant means the grant is gone. Everything else, including a
          // premature-refresh rejection whose body we cannot classify and a 2xx we cannot read,
          // keeps the tokens (a spent refresh token answers invalid_grant on the next try).
          if (failure === "invalid_grant") {
            await this.markNeedsReauth(row.id, failure);
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
          if (failure === this.noRetryFailure || delay === undefined) break;
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
        const mapped = this.failureResult(lastFailure);
        return credentialsRejected
          ? { ok: false, code: CREDENTIALS_REJECTED, retryable: mapped.retryable }
          : { ok: false, ...mapped };
      }

      // Persist BEFORE the new access token is used. If the provider rotated the refresh token the
      // old one may be spent, so the pair must not be lost: after two failed D1 writes it is
      // stashed (ciphertext) in DO storage and retried on the alarm. Without rotation the stored
      // refresh token is still good, so a failed write costs only a repeat refresh later.
      const issuedAt = this.now();
      const expiresAt = issuedAt + tokens.expiresInS * 1000;
      const refreshExpiresAt =
        tokens.refreshExpiresInS == null ? null : issuedAt + tokens.refreshExpiresInS * 1000;
      const rotated = tokens.refreshToken !== null;
      let persisted = false;
      let stashed = false;
      try {
        const accessEnc = await encryptToken(
          this.env.TOKEN_ENC_KEY,
          tokens.accessToken,
          this.aad(row.id, "access"),
        );
        // Always re-encrypted with the current key (also when the provider did not rotate it), so
        // a TOKEN_ENC_KEY rotation completes after one refresh cycle (docs/DEPLOY.md).
        const refreshEnc = await encryptToken(
          this.env.TOKEN_ENC_KEY,
          tokens.refreshToken ?? refreshToken,
          this.aad(row.id, "refresh"),
        );
        const pair: SavedPair = { accessEnc, refreshEnc, expiresAt, refreshExpiresAt, rotated };
        try {
          try {
            persisted = await this.persistPair(row.id, baseRefreshEnc, pair);
          } catch {
            persisted = await this.persistPair(row.id, baseRefreshEnc, pair);
          }
        } catch {
          if (rotated) {
            const stash: PendingTokens = {
              baseRefreshEnc,
              accessEnc,
              refreshEnc,
              expiresAt,
              ...(this.stashRefreshExpiry ? { refreshExpiresAt } : {}),
            };
            await this.ctx.storage.put(pendingKey(row.id), stash);
            stashed = true;
          }
          persisted = true;
        }
      } catch {
        if (rotated) {
          try {
            await this.markNeedsReauth(row.id, "token_persist_failed");
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
      // The new pair is safe (D1 or stash). Everything below is bookkeeping: a failure here must
      // never turn into needs_reauth, which would wipe the tokens that were just saved.
      this.clientRejectedUntil = 0;
      try {
        await this.afterTokensSaved(row, issuedAt, expiresAt);
        // A direct write supersedes any older stash (same base refresh token in D1).
        if (!stashed) await this.ctx.storage.delete(pendingKey(row.id));
        await this.ctx.storage.delete(clientRejectsKey(row.id));
        if (stashed) await this.armAlarm(this.now() + PENDING_RETRY_MS);
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

  /**
   * User calls first, oldest first, except that after USER_BURST user calls in a row with a job
   * call waiting the oldest job call goes (so jobs are delayed, never starved).
   */
  private pickNext(): Queued<Req, Res> | undefined {
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
        q.reject(this.rateLimited(1000, "queued too long"));
      }
    }
  }

  private noteDispatch(item: Queued<Req, Res>): void {
    if (item.req.priority === "job") this.userStreak = 0;
    else if (this.queue.some((q) => q.req.priority === "job")) this.userStreak++;
    else this.userStreak = 0;
  }

  protected unqueue(item: Queued<Req, Res>): void {
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

  /**
   * Performs one dispatched call. Returns null when it was put back in the queue for a retry.
   * An instance property in the subclass, never a prototype method: it runs a request past the
   * door checks, so it must not be RPC-callable (see `refreshShared`).
   */
  protected abstract readonly execute: (item: Queued<Req, Res>) => Promise<Res | null>;

  /** 0 = go now, >0 = wait this long; throws if the request must fail instead of waiting. */
  private waitFor(item: Queued<Req, Res>): number {
    const now = this.now();
    this.rollover(now);
    this.pruneWindow(now);
    const { req } = item;
    if (req.priority === "job") {
      const job = this.jobs.get(req.jobId);
      if (job && job.used >= job.budget) throw this.budgetExhausted(req.jobId);
    }
    let wait: number;
    if (this.st.blockedUntil > now) wait = this.st.blockedUntil - now;
    else {
      this.checkDaily(req, now);
      wait = this.minuteWait(now);
      if (wait <= 0) return 0;
    }
    if (now - item.enqueuedAt + wait > this.limits.maxQueueWaitMs) {
      throw this.rateLimited(wait);
    }
    return wait;
  }

  private spend(req: Req): void {
    this.st.window.push(this.now());
    this.st.used++;
    if (req.priority === "user") this.st.userUsed++;
    else {
      this.st.jobUsed++;
      const job = this.jobs.get(req.jobId);
      if (job) job.used++;
    }
    this.onSpend(req);
  }

  /** Drops calls older than 60 s. Entries at exactly now-60s are out: any 60 s span is [t, t+60s). */
  protected pruneWindow(now: number): void {
    const w = this.st.window;
    let n = 0;
    while (n < w.length && (w[n] as number) <= now - 60_000) n++;
    if (n > 0) w.splice(0, n);
    // A clock that went backwards must not let the log grow or lock the gate for long.
    if (w.length > 0 && (w[w.length - 1] as number) > now) {
      for (let i = 0; i < w.length; i++) w[i] = Math.min(w[i] as number, now);
    }
    this.afterPrune(now);
  }

  /** Sliding window: never more than the cap in any 60 s. Returns ms until a slot frees. */
  private minuteWait(now: number): number {
    const w = this.st.window;
    const cap = this.minuteCap();
    let wait = 0;
    if (w.length >= cap) wait = (w[w.length - cap] as number) + 60_000 - now;
    wait = Math.max(wait, this.extraMinuteWait(now));
    return wait > 0 ? Math.ceil(wait) : 0;
  }

  protected rollover(now: number): void {
    const day = dayOf(now);
    if (day === this.st.day) {
      this.onSameDay(now);
      return;
    }
    const keep = this.onNewDay(now);
    Object.assign(this.st, { day, used: 0, userUsed: 0, jobUsed: 0, limited: 0, ...keep });
  }

  /** Saves the limiter state, plus the budget of the job the request belongs to (if any). */
  protected async persist(req?: Req): Promise<void> {
    const job = req?.priority === "job" ? this.jobs.get(req.jobId) : undefined;
    if (req && job) await this.ctx.storage.put({ rl: this.st, [`job:${req.jobId}`]: job });
    else await this.ctx.storage.put("rl", this.st);
  }

  /** Blocks the gate after a 429 for the hinted time, clamped to [1 s, maxBlockMs]. */
  protected blockAfter429(hintMs: number, now: number): number {
    const wait = Math.min(this.maxBlockMs, Math.max(1000, hintMs));
    this.st.blockedUntil = now + wait;
    this.st.limited++;
    this.onBlocked();
    return wait;
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
  // Network
  // ---------------------------------------------------------------------------------------

  /** Behind the instance property `send` (JS-private: not reachable over RPC). */
  async #send(
    url: URL,
    req: { method: string; body?: string | undefined },
    headers: Record<string, string>,
  ): Promise<HttpOutcome> {
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
      throw this.apiError(502, this.unreachableMessage, "network");
    }
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k.toLowerCase()] = v;
    });
    return { status: res.status, headers: outHeaders, body };
  }
}
