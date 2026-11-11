// STUB created by task R2 against the fixed interface agreed with task R1. R1 owns this file;
// take R1's version on merge. R2 only consumes these three names; the return shape of
// parseTokenResponse is an ASSUMPTION (see apps/worker/src/revolut/oauth.ts, the one adapter).

export interface ClientAssertionInput {
  issuer: string;
  clientId: string;
  privateKeyPem: string;
  audience?: string;
  now: number;
  ttlSeconds?: number;
}

/** Stub encoding (not base64): only the three-part shape matters for the worker's tests. */
const b64u = (s: string): string => encodeURIComponent(s).replace(/\./g, "%2E").replace(/%/g, "~");

/** Stub: the real one signs RS256 with the PKCS#8 key. Here only the shape matters. */
export async function buildClientAssertion(input: ClientAssertionInput): Promise<string> {
  if (!input.privateKeyPem.includes("PRIVATE KEY")) throw new Error("bad private key");
  const iat = Math.floor(input.now / 1000);
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64u(
    JSON.stringify({
      iss: input.issuer,
      sub: input.clientId,
      aud: input.audience ?? "https://revolut.com",
      iat,
      exp: iat + (input.ttlSeconds ?? 300),
    }),
  );
  return `${header}.${payload}.stub-signature`;
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const q = (k: string, v: string): string => `${k}=${encodeURIComponent(v)}`;
  return `https://business.revolut.com/app-confirm?${[
    q("client_id", input.clientId),
    q("redirect_uri", input.redirectUri),
    q("response_type", "code"),
    q("state", input.state),
  ].join("&")}`;
}

export interface ParsedTokenResponse {
  accessToken: string;
  /** Null when the token endpoint sent none (a refresh normally does not). */
  refreshToken: string | null;
  expiresInS: number;
}

export function parseTokenResponse(body: string): ParsedTokenResponse {
  const o = JSON.parse(body) as Record<string, unknown>;
  const expires = Number(o["expires_in"]);
  if (typeof o["access_token"] !== "string" || !Number.isFinite(expires) || expires <= 0) {
    throw new Error("malformed token response");
  }
  return {
    accessToken: o["access_token"],
    refreshToken: typeof o["refresh_token"] === "string" ? o["refresh_token"] : null,
    expiresInS: expires,
  };
}
