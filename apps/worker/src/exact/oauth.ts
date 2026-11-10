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
 * "rejected" is any 4xx other than a clear invalid_grant, a redirect, or a body we cannot classify:
 * it may be a premature refresh (ADR 0016), so callers treat it as retryable, never as a lost grant.
 * "bad_host" is our own configuration (not an Exact host) and is not worth retrying.
 */
export type TokenFailure = "invalid_grant" | "rejected" | "unavailable" | "malformed" | "bad_host";

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
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) throw new TokenEndpointError("unavailable");
    throw new TokenEndpointError(obj.error === "invalid_grant" ? "invalid_grant" : "rejected");
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
