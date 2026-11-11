/**
 * Revolut Business OAuth 2.0 calls: consent URL, authorization-code exchange and refresh, both
 * authenticated with a signed client assertion (JWT, private_key_jwt style) instead of a client
 * secret. Shared by the connect callback and the RevolutGate. Nothing here logs; errors carry
 * codes only. Wire-format assumptions: docs/decisions/0031-revolut-connection.md (UNVERIFIED
 * until a live sandbox connection exists).
 *
 * The pure helpers (client assertion, consent URL, token parsing) come from @camelthorn/revolut
 * (task R1); this file is the one adapter around them.
 */
import {
  buildAuthorizeUrl,
  buildClientAssertion,
  buildTokenRequestBody,
  parseTokenResponse,
  type RevolutTokens,
} from "@camelthorn/revolut";
import {
  revolutApiHost,
  revolutConsentHost,
  type RevolutConfig,
  type RevolutEnvironment,
} from "./config";

export interface TokenSet {
  accessToken: string;
  /** Null when the endpoint sent none: a refresh normally does not rotate the refresh token. */
  refreshToken: string | null;
  expiresInS: number;
}

/**
 * "rejected" is any 4xx other than a clear invalid_grant or client rejection, a redirect, or a
 * body we cannot classify: retryable, never a lost grant.
 * "client_rejected" is `invalid_client` / `unauthorized_client`, or a 401 without invalid_grant:
 * most likely a wrong REVOLUT_CLIENT_ID, a key that is not the one registered, or a wrong
 * REVOLUT_ISSUER. Tokens are kept; reported as a configuration problem once it repeats.
 * "malformed" is a 2xx we cannot read (retryable: the old refresh token may still be good).
 * "bad_config" is our own configuration (no usable key) and is not worth retrying.
 */
export type TokenFailure =
  "invalid_grant" | "client_rejected" | "rejected" | "unavailable" | "malformed" | "bad_config";

export class TokenEndpointError extends Error {
  readonly failure: TokenFailure;
  constructor(failure: TokenFailure) {
    super(`revolut token endpoint: ${failure}`);
    this.name = "TokenEndpointError";
    this.failure = failure;
  }
}

const errorCode = (obj: Record<string, unknown>): string =>
  typeof obj.error === "string" ? obj.error.trim().toLowerCase() : "";

/**
 * The consent URL. R1's helper builds the production URL; the sandbox consent page lives on
 * another host, so the host is switched here and checked against the two known hosts.
 */
export function authorizeUrl(
  environment: RevolutEnvironment,
  cfg: Pick<RevolutConfig, "clientId" | "redirectUri">,
  state: string,
): string {
  const u = new URL(
    buildAuthorizeUrl({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, state }),
  );
  u.hostname = revolutConsentHost(environment);
  if (u.protocol !== "https:" || u.host !== revolutConsentHost(environment)) {
    throw new TokenEndpointError("bad_config");
  }
  return u.toString();
}

type Grant =
  { kind: "authorization_code"; code: string } | { kind: "refresh_token"; refreshToken: string };

async function post(
  environment: RevolutEnvironment,
  cfg: RevolutConfig,
  grant: Grant,
  nowMs: number,
): Promise<TokenSet> {
  let assertion: string;
  try {
    assertion = await buildClientAssertion({
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      privateKeyPem: cfg.privateKeyPem,
      now: nowMs,
    });
  } catch {
    throw new TokenEndpointError("bad_config");
  }
  const body =
    grant.kind === "authorization_code"
      ? buildTokenRequestBody({
          grant: "authorization_code",
          code: grant.code,
          clientId: cfg.clientId,
          clientAssertion: assertion,
        })
      : buildTokenRequestBody({
          grant: "refresh_token",
          refreshToken: grant.refreshToken,
          clientId: cfg.clientId,
          clientAssertion: assertion,
        });
  let res: Response;
  try {
    res = await fetch(`https://${revolutApiHost(environment)}/api/1.0/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      // A 307/308 would re-send the assertion and refresh token to wherever it points: never follow.
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new TokenEndpointError("unavailable");
  }
  if (res.status >= 300 && res.status < 400) throw new TokenEndpointError("rejected");
  const text = await res.text().catch(() => "");
  let obj: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(text);
    if (data && typeof data === "object") obj = data as Record<string, unknown>;
  } catch {
    /* not JSON: classified below by status */
  }
  const code = errorCode(obj);
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) throw new TokenEndpointError("unavailable");
    // Only the `error` member counts (RFC 6749 5.2); a description that merely mentions a code is
    // ambiguous, and an ambiguous answer must never wipe the tokens.
    if (code === "invalid_grant") throw new TokenEndpointError("invalid_grant");
    if (code === "invalid_client" || code === "unauthorized_client" || res.status === 401) {
      throw new TokenEndpointError("client_rejected");
    }
    throw new TokenEndpointError("rejected");
  }
  if (code !== "" && obj.access_token === undefined) {
    throw new TokenEndpointError(code === "invalid_grant" ? "invalid_grant" : "rejected");
  }
  let parsed: RevolutTokens;
  try {
    // R1's parser: access_token printable, token_type bearer, expires_in an integer 1..604800.
    parsed = parseTokenResponse(text);
  } catch {
    throw new TokenEndpointError("malformed");
  }
  const refreshToken =
    parsed.refreshToken !== undefined && parsed.refreshToken !== "" ? parsed.refreshToken : null;
  // The first exchange must deliver a refresh token; without one the connection could not last.
  if (grant.kind === "authorization_code" && refreshToken === null) {
    throw new TokenEndpointError("malformed");
  }
  return { accessToken: parsed.accessToken, refreshToken, expiresInS: parsed.expiresInSeconds };
}

export const exchangeCode = (
  environment: RevolutEnvironment,
  cfg: RevolutConfig,
  code: string,
  nowMs: number,
) => post(environment, cfg, { kind: "authorization_code", code }, nowMs);

export const refreshTokens = (
  environment: RevolutEnvironment,
  cfg: RevolutConfig,
  refreshToken: string,
  nowMs: number,
) => post(environment, cfg, { kind: "refresh_token", refreshToken }, nowMs);
