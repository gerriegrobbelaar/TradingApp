/**
 * Exact OAuth 2.0 token endpoint calls (authorization code and refresh). Shared by the connect
 * callback and the ExactGate token authority. Nothing here logs; errors carry codes only.
 * Assumptions about Exact's exact wire format: docs/decisions/0016-exact-oauth-assumptions.md.
 */
import { isExactHost } from "./config";
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Lifetime in seconds. */
  expiresInS: number;
}

/**
 * "rejected" is any 4xx other than a clear invalid_grant or client rejection, a redirect, or a
 * body we cannot classify: it may be a premature refresh (ADR 0016), so callers treat it as
 * retryable, never as a lost grant.
 * "client_rejected" is `invalid_client` / `unauthorized_client`, or a 401 without invalid_grant:
 * most likely a wrong EXACT_CLIENT_ID / EXACT_CLIENT_SECRET. Tokens are kept; the authority
 * reports it as a configuration problem once it repeats (ADR 0016 item 20).
 * "malformed" is a 2xx we cannot read. The old refresh token may or may not be spent; keeping it
 * costs nothing (a spent one answers invalid_grant on the next try), so it is retryable too.
 * "bad_host" is our own configuration (not an Exact host) and is not worth retrying.
 */
export type TokenFailure =
  "invalid_grant" | "client_rejected" | "rejected" | "unavailable" | "malformed" | "bad_host";

/** The OAuth `error` code, trimmed and lower-cased; "" if the body has none. */
function errorCode(obj: Record<string, unknown>): string {
  return typeof obj.error === "string" ? obj.error.trim().toLowerCase() : "";
}

export class TokenEndpointError extends Error {
  readonly failure: TokenFailure;
  constructor(failure: TokenFailure) {
    super(`exact token endpoint: ${failure}`);
    this.name = "TokenEndpointError";
    this.failure = failure;
  }
}

export interface OAuthClient {
  host: string;
  clientId: string;
  clientSecret: string;
}

export function authorizeUrl(
  host: string,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const u = new URL(`https://${host}/api/oauth2/auth`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("force_login", "0");
  u.searchParams.set("state", state);
  return u.toString();
}

async function post(client: OAuthClient, form: Record<string, string>): Promise<TokenSet> {
  // The client secret and the refresh token go in the body: only ever to an Exact host.
  if (!isExactHost(client.host)) throw new TokenEndpointError("bad_host");
  let res: Response;
  try {
    res = await fetch(`https://${client.host}/api/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        ...form,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }).toString(),
      // A 307/308 would re-send the secret to wherever it points: never follow.
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new TokenEndpointError("unavailable");
  }
  if (res.status >= 300 && res.status < 400) throw new TokenEndpointError("rejected");
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const code = errorCode(obj);
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) throw new TokenEndpointError("unavailable");
    // Only the `error` member counts (RFC 6749 5.2), at 400 or 401 alike. A description that merely
    // mentions a code is ambiguous, and an ambiguous answer must never wipe the tokens.
    if (code === "invalid_grant") throw new TokenEndpointError("invalid_grant");
    if (code === "invalid_client" || code === "unauthorized_client" || res.status === 401) {
      throw new TokenEndpointError("client_rejected");
    }
    throw new TokenEndpointError("rejected");
  }
  // A 2xx that carries an OAuth error instead of tokens was not a successful refresh.
  if (code !== "" && obj.access_token === undefined) {
    throw new TokenEndpointError(code === "invalid_grant" ? "invalid_grant" : "rejected");
  }
  const { access_token, refresh_token } = obj;
  // Exact sends expires_in as a string ("600"); accept a number too.
  const expiresIn = Number(obj.expires_in);
  if (
    typeof access_token !== "string" ||
    access_token === "" ||
    typeof refresh_token !== "string" ||
    refresh_token === "" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new TokenEndpointError("malformed");
  }
  return { accessToken: access_token, refreshToken: refresh_token, expiresInS: expiresIn };
}

export const exchangeCode = (client: OAuthClient, code: string, redirectUri: string) =>
  post(client, { grant_type: "authorization_code", code, redirect_uri: redirectUri });

export const refreshTokens = (client: OAuthClient, refreshToken: string) =>
  post(client, { grant_type: "refresh_token", refresh_token: refreshToken });
