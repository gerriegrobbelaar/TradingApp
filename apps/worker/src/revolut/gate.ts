/**
 * RevolutGate: one Durable Object per Revolut connection ("revolut:<connectionId>") that every
 * Revolut call goes through (docs/decisions/0031-revolut-connection.md, mirroring ExactGate,
 * docs/decisions/0015-exactgate-design.md).
 *
 * The queue, limiter, budgets, role pin and token refresh skeleton are the shared GateCore
 * (../gate/core.ts, docs/decisions/0048-shared-gate-core.md). This file holds only what is
 * Revolut's own: the request allow-list (request.ts, default deny), the staged-connection
 * verification, the webhook target check, the token timing and the 401 rules.
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
import {
  RevolutApiError,
  RevolutAuthError,
  RevolutBudgetExhaustedError,
  RevolutRateLimitedError,
  type RevolutRequest,
  type RevolutResponse,
} from "@camelthorn/revolut";
import { decryptToken, keyring } from "../crypto/token-crypto";
import type { Env } from "../env";
import {
  CREDENTIALS_REJECTED,
  GateCore,
  pendingKey,
  type CoreLimits,
  type CoreState,
  type Queued,
  type RefreshedTokens,
  type SavedPair,
  type ThrottleContext,
  type TokenResult,
} from "../gate/core";
import { loadRevolutConfig, revolutWebhookUrl } from "./config";
import { refreshTokens, TokenEndpointError } from "./oauth";
import { buildUrl, validateRequest, versionOf } from "./request";
import {
  aad,
  environmentOf,
  isLivePending,
  loadRevolutById,
  markNeedsReauth,
  reencryptWebhookSecrets,
  type RevolutConnectionRow,
} from "./store";
import { toWire, type WireError } from "./wire";

export { CREDENTIALS_REJECTED };
export type { TokenResult };

export interface GateLimits extends CoreLimits {
  /**
   * ASSUMPTION (verify with credentials): Revolut documents no exact per-minute figure for the
   * Business API; 60 per minute is the conservative working value, same as Exact.
   */
  perMinute: number;
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
const DEFAULT_429_WAIT_MS = 60_000;
const MAX_BLOCK_MS = 3600_000;

type GateRole = `connection:${number}`;

/** The job id of the connect callback's account check (the only use of a staged connection). */
export const CONNECT_JOB_ID = "revolut-connect";
const PENDING_DETAILS_RE =
  /^\/accounts\/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\/bank-details$/;

/** Retry-After as seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(headers: Record<string, string>, now: number): number | null {
  const v = headers["retry-after"]?.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export class RevolutGate extends GateCore<
  RevolutRequest,
  RevolutResponse,
  WireError,
  CoreState,
  GateLimits,
  RevolutConnectionRow,
  GateRole
> {
  /** The last token this instance obtained (in memory only: an eviction costs one refresh). */
  private issued: { issuedAt: number; expiresAt: number } | null = null;
  protected readonly maxBlockMs = MAX_BLOCK_MS;
  protected readonly unreachableMessage = "revolut unreachable";
  protected readonly noRetryFailure = "bad_config";
  protected readonly credentialsAudit = {
    action: "connection.revolut_credentials_rejected",
    scope: "kind = 'revolut' AND ",
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { ...DEFAULT_LIMITS });
    this.stashRefreshExpiry = true;
  }

  // ---------------------------------------------------------------------------------------
  // Hooks of the shared core
  // ---------------------------------------------------------------------------------------

  protected freshExtra(): Record<string, never> {
    return {};
  }
  protected rateLimited(retryAfter: number, message?: string): Error {
    return new RevolutRateLimitedError(retryAfter, message);
  }
  protected budgetExhausted(jobId: string): Error {
    return new RevolutBudgetExhaustedError(jobId);
  }
  protected apiError(status: number, message: string, code: string): Error {
    return new RevolutApiError(status, message, code);
  }
  protected wireError(e: unknown): WireError {
    return toWire(e);
  }
  protected validate(req: RevolutRequest): void {
    validateRequest(req);
  }
  /**
   * Revolut's write policy is static and fully decided by `validateRequest` (default deny: an
   * allow-list of reads and the webhook calls; every payment endpoint is refused). Nothing is
   * re-read from D1, so there is nothing more to check here.
   */
  protected authorize(): Promise<void> {
    return Promise.resolve();
  }
  protected async admit(req: RevolutRequest): Promise<void> {
    if (!(await this.claimRole(`connection:${req.connectionId}`))) {
      throw new RevolutApiError(400, "wrong gate for connection", "connection_mismatch");
    }
  }
  protected authorityConnectionId(): number | null {
    return this.role?.startsWith("connection:")
      ? Number(this.role.slice("connection:".length))
      : null;
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

  /** The alarm only retries a stashed token pair (see the core's refresh). */
  async alarm(): Promise<void> {
    await this.retryStash();
  }

  // ---------------------------------------------------------------------------------------
  // Token authority
  // ---------------------------------------------------------------------------------------

  // A JS-private method on purpose: Workers RPC exposes every public method of a Durable Object,
  // and this one returns a plaintext access token. It must never be callable from outside.
  #refreshAccessToken(connectionId: number, staleExpiresAt?: string): Promise<TokenResult> {
    return this.refreshShared(connectionId, `connection:${connectionId}`, staleExpiresAt);
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

  protected loadConnection(id: number): Promise<RevolutConnectionRow | null> {
    return loadRevolutById(this.env.DB, id);
  }
  protected markNeedsReauth(id: number, reason: string): Promise<unknown> {
    return markNeedsReauth(this.env.DB, id, reason);
  }
  protected aad(id: number, kind: "access" | "refresh"): string {
    return aad(id, kind);
  }
  protected checkRow(row: RevolutConnectionRow): TokenResult | null {
    return environmentOf(row) ? null : { ok: false, code: "not_connected", retryable: false };
  }
  protected freshMargin(expMs: number): number {
    return this.marginFor(expMs);
  }

  protected async throttle(
    ctx: ThrottleContext<RevolutConnectionRow>,
  ): Promise<TokenResult | null> {
    if (!ctx.forced && this.refreshCooldownUntil > ctx.now) return ctx.usableOld();
    return null;
  }

  protected openEndpoint(
    row: RevolutConnectionRow,
  ): TokenResult | ((refreshToken: string) => Promise<RefreshedTokens>) {
    const environment = environmentOf(row);
    if (!environment) return { ok: false, code: "not_connected", retryable: false };
    let origin: string;
    try {
      origin = new URL(this.env.REVOLUT_REDIRECT_URI).origin;
    } catch {
      return { ok: false, code: "server_misconfigured", retryable: false };
    }
    const cfg = loadRevolutConfig(this.env, origin);
    if (!cfg.ok) return { ok: false, code: "server_misconfigured", retryable: false };
    return (refreshToken) => refreshTokens(environment, cfg.config, refreshToken, this.now());
  }

  protected classifyFailure(e: unknown): string {
    return e instanceof TokenEndpointError ? e.failure : "unavailable";
  }

  protected failureResult(lastFailure: string): { code: string; retryable: boolean } {
    return {
      code:
        lastFailure === "unavailable"
          ? "token_endpoint_unavailable"
          : lastFailure === "bad_config"
            ? "server_misconfigured"
            : "token_refresh_retry",
      retryable: lastFailure !== "bad_config",
    };
  }

  protected persistPair(id: number, baseRefreshEnc: string, p: SavedPair): Promise<boolean> {
    return this.persistTokens(
      id,
      baseRefreshEnc,
      p.accessEnc,
      p.refreshEnc,
      p.expiresAt,
      p.refreshExpiresAt,
      p.rotated,
    );
  }

  protected async afterTokensSaved(
    row: RevolutConnectionRow,
    issuedAt: number,
    expiresAt: number,
  ): Promise<void> {
    this.issued = { issuedAt, expiresAt };
    // A TOKEN_ENC_KEY rotation also moves the webhook signing secrets to the current key now
    // (review S3). Best effort: it never fails or delays the token result beyond one read.
    await reencryptWebhookSecrets(this.env, row.id).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------
  // Executing a call
  // ---------------------------------------------------------------------------------------

  /**
   * Returns null when the request was put back in the queue for one retry after a 401. An instance
   * property, not a method: it runs a request past the door checks, so it is not RPC-callable.
   */
  protected readonly execute = async (
    item: Queued<RevolutRequest, RevolutResponse>,
  ): Promise<RevolutResponse | null> => {
    const { req } = item;
    // The static allow-list once more (it is the whole write policy here): nothing reaches the
    // network that `validateRequest` would refuse, whatever path led to this call.
    validateRequest(req);
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
    const token = await this.#accessTokenFor(row);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    if (headers.accept === undefined) headers.accept = "application/json";
    headers.authorization = `Bearer ${token}`;

    const res = await this.send(url, req, headers);
    const outHeaders = res.headers;
    await this.persist(req);

    if (res.status === 429) {
      const wait = this.blockAfter429(
        retryAfterMs(outHeaders, this.now()) ?? DEFAULT_429_WAIT_MS,
        this.now(),
      );
      await this.persist();
      throw new RevolutRateLimitedError(wait);
    }
    if (res.status === 401 && !verifying && req.method !== "GET") {
      // A write is NEVER re-sent by the gate (same rule as ExactGate; ADR 0048): the outcome of a
      // rejected write is not ours to guess. Heal the token for the caller's next call, then fail
      // retryably; the caller retries with its own idempotency key.
      await this.#refreshAccessToken(row.id, row.expires_at ?? undefined).catch(() => undefined);
      throw new RevolutApiError(503, "write not re-sent after 401", "write_auth_retry_refused");
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
    return { status: res.status, headers: outHeaders, body: res.body };
  };

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

  // JS-private: it returns a plaintext access token, so it must not be RPC-callable.
  async #accessTokenFor(row: RevolutConnectionRow): Promise<string> {
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
