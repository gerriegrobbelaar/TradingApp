import { isEmailInDomain, normalizeEmail } from "@camelthorn/core";
import { fromBase64Url } from "./crypto";
import type { AuthConfig } from "./config";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;

/** Carries only a reason code; it never contains token or email material. */
export class AuthError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "AuthError";
  }
}

export function buildAuthUrl(
  cfg: AuthConfig,
  p: { state: string; nonce: string; challenge: string; stepUp: boolean },
): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("hd", cfg.allowedHd); // hint only; enforced server-side after the token check
  if (p.stepUp) {
    u.searchParams.set("prompt", "login");
    u.searchParams.set("max_age", "0");
  }
  return u.toString();
}

export async function exchangeCode(
  cfg: AuthConfig,
  code: string,
  verifier: string,
): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new AuthError("token_exchange_failed");
  const body = (await res.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") throw new AuthError("token_exchange_no_id_token");
  return body.id_token;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}
let jwksCache: { keys: Jwk[]; expiresAt: number } | null = null;

export function resetJwksCacheForTests(): void {
  jwksCache = null;
}

async function fetchJwks(nowMs: number): Promise<Jwk[]> {
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new AuthError("jwks_fetch_failed");
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new AuthError("jwks_malformed");
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
  const ttlMs = Math.min(Math.max(Number(maxAge ?? 3600), 60), 24 * 3600) * 1000;
  jwksCache = { keys: body.keys, expiresAt: nowMs + ttlMs };
  return body.keys;
}

/**
 * Cached with a TTL; an unknown `kid` (key rotation) forces one refetch before failing. The
 * callback only reaches this point after a valid state cookie and a successful code exchange,
 * so an attacker cannot use forged kids to make us hammer Google.
 */
async function findKey(kid: string, nowMs: number): Promise<Jwk> {
  if (jwksCache && jwksCache.expiresAt > nowMs) {
    const hit = jwksCache.keys.find((k) => k.kid === kid);
    if (hit) return hit;
  }
  const fresh = await fetchJwks(nowMs);
  const hit = fresh.find((k) => k.kid === kid);
  if (!hit) throw new AuthError("unknown_kid");
  return hit;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  /** `auth_time` claim (epoch seconds): when the user last actually authenticated at Google. */
  authTime?: number;
}

const dec = new TextDecoder();

export async function verifyIdToken(
  cfg: AuthConfig,
  idToken: string,
  expectedNonce: string,
  nowMs: number,
): Promise<GoogleIdentity> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AuthError("jwt_malformed");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(dec.decode(fromBase64Url(h))) as typeof header;
    claims = JSON.parse(dec.decode(fromBase64Url(p))) as typeof claims;
  } catch {
    throw new AuthError("jwt_malformed");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AuthError("jwt_alg");

  const jwk = await findKey(header.kid, nowMs);
  if (
    jwk.kty !== "RSA" ||
    !jwk.n ||
    !jwk.e ||
    (jwk.alg !== undefined && jwk.alg !== "RS256") ||
    (jwk.use !== undefined && jwk.use !== "sig")
  ) {
    throw new AuthError("jwk_unusable");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64Url(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) throw new AuthError("bad_signature");

  const nowS = Math.floor(nowMs / 1000);
  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) throw new AuthError("bad_iss");
  // Exactly our client: a string, or a one-element array. Multi-audience tokens are refused.
  const aud = claims.aud;
  const audOk =
    typeof aud === "string"
      ? aud === cfg.clientId
      : Array.isArray(aud) && aud.length === 1 && aud[0] === cfg.clientId;
  if (!audOk) throw new AuthError("bad_aud");
  if (claims.azp !== undefined && claims.azp !== cfg.clientId) throw new AuthError("bad_azp");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= nowS) {
    throw new AuthError("expired");
  }
  if (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_SECONDS > nowS) {
    throw new AuthError("bad_iat");
  }
  if (
    claims.auth_time !== undefined &&
    (typeof claims.auth_time !== "number" ||
      !Number.isFinite(claims.auth_time) ||
      claims.auth_time - CLOCK_SKEW_SECONDS > nowS)
  ) {
    throw new AuthError("bad_auth_time");
  }
  if (typeof claims.nonce !== "string" || claims.nonce !== expectedNonce) {
    throw new AuthError("bad_nonce");
  }
  if (claims.email_verified !== true) throw new AuthError("email_unverified");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new AuthError("no_sub");
  if (typeof claims.email !== "string" || claims.email === "") throw new AuthError("no_email");
  const email = normalizeEmail(claims.email);
  if (typeof claims.hd !== "string" || claims.hd.toLowerCase() !== cfg.allowedHd) {
    throw new AuthError("bad_hd");
  }
  if (!isEmailInDomain(email, cfg.allowedHd)) throw new AuthError("bad_email_domain");

  return {
    sub: claims.sub,
    email,
    ...(typeof claims.auth_time === "number" ? { authTime: claims.auth_time } : {}),
  };
}
