import { env } from "cloudflare:test";
import { vi } from "vitest";
import { resetJwksCacheForTests } from "../src/auth/google";
import { createSession, type Role } from "../src/auth/session";
import { sha256Hex, toBase64Url } from "../src/auth/crypto";
import worker from "../src/index";
import { resetSeedMemoForTests } from "../src/db/seed";

export const db = env.DB;
export const ORIGIN = "https://app.test";
export const CLIENT_ID = env.GOOGLE_CLIENT_ID;
export const HD = "camelthorncapital.com";

const enc = new TextEncoder();
const b64 = (o: unknown): string => toBase64Url(enc.encode(JSON.stringify(o)));

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as TestKey["jwk"],
  };
}

export async function signJwt(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = b64({ alg: "RS256", typ: "JWT", kid: key.kid, ...header });
  const p = b64(claims);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    enc.encode(`${h}.${p}`),
  );
  return `${h}.${p}.${toBase64Url(new Uint8Array(sig))}`;
}

export interface GoogleStub {
  /** Keys currently published at the JWKS endpoint. */
  keys: TestKey[];
  /** Builds the id_token returned by the token endpoint, given the nonce from the login redirect. */
  idToken: (nonce: string) => Promise<string>;
  tokenRequests: URLSearchParams[];
  jwksFetches: number;
}

export function stubGoogle(stub: GoogleStub): void {
  resetJwksCacheForTests();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      stub.jwksFetches++;
      return Response.json(
        { keys: stub.keys.map((k) => k.jwk) },
        { headers: { "cache-control": "public, max-age=3600" } },
      );
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(String(init?.body));
      stub.tokenRequests.push(params);
      const nonce = lastNonce;
      return Response.json({ id_token: await stub.idToken(nonce), access_token: "x" });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

let lastNonce = "";

export function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-sub-1",
    email: "gerrie.grobbelaar@camelthorncapital.com",
    email_verified: true,
    hd: HD,
    iat: now,
    exp: now + 3600,
    ...over,
  };
}

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

/** workers-types does not declare Headers.getSetCookie yet; the runtime has it. */
export function setCookies(res: Response): string[] {
  return (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

export function cookieFrom(res: Response, name: string): string | undefined {
  for (const c of setCookies(res)) {
    if (c.startsWith(`${name}=`)) return c.slice(name.length + 1).split(";")[0];
  }
  return undefined;
}

export interface LoginResult {
  callback: Response;
  sessionToken: string | undefined;
  authUrl: URL;
}

/**
 * Drives login -> Google -> callback. `mutate` lets a test tamper with the callback inputs.
 * `nonceOverride` makes the stub sign a different nonce than the one issued.
 */
export async function doLogin(
  stub: GoogleStub,
  opts: {
    stepUp?: boolean;
    state?: (s: string) => string;
    flowCookie?: (c: string) => string | undefined;
    existingSession?: string;
  } = {},
): Promise<LoginResult> {
  const login = await call(`/api/auth/login${opts.stepUp ? "?step_up=1" : ""}`);
  const authUrl = new URL(login.headers.get("location") ?? "");
  lastNonce = authUrl.searchParams.get("nonce") ?? "";
  let flow = cookieFrom(login, "__Host-oauth");
  if (opts.flowCookie) flow = opts.flowCookie(flow ?? "");
  const state = opts.state
    ? opts.state(authUrl.searchParams.get("state") ?? "")
    : authUrl.searchParams.get("state");
  const cookies = [
    flow ? `__Host-oauth=${flow}` : "",
    opts.existingSession ? `__Host-session=${opts.existingSession}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const callback = await call(
    `/api/auth/callback?code=abc&state=${encodeURIComponent(state ?? "")}`,
    {
      headers: cookies ? { cookie: cookies } : {},
    },
  );
  return { callback, authUrl, sessionToken: cookieFrom(callback, "__Host-session") };
}

export function newStub(
  keys: TestKey[],
  build: (nonce: string, key: TestKey) => Promise<string>,
): GoogleStub {
  const stub: GoogleStub = {
    keys,
    tokenRequests: [],
    jwksFetches: 0,
    idToken: (nonce) => build(nonce, keys[0] as TestKey),
  };
  return stub;
}

export async function resetDb(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions"),
    db.prepare("DELETE FROM invites"),
    db.prepare("DELETE FROM user_roles"),
    db.prepare("DELETE FROM users"),
    db.prepare("DELETE FROM settings"),
  ]);
  resetSeedMemoForTests();
}

export async function addUser(
  email: string,
  roles: Role[],
  opts: { sub?: string | null; disabled?: boolean } = {},
): Promise<number> {
  const r = await db
    .prepare("INSERT INTO users (email, google_sub, disabled_at) VALUES (?1, ?2, ?3)")
    .bind(
      email,
      opts.sub === undefined ? `sub-${email}` : opts.sub,
      opts.disabled ? "2026-01-01T00:00:00.000Z" : null,
    )
    .run();
  const id = r.meta.last_row_id;
  for (const role of roles) {
    await db.prepare("INSERT INTO user_roles (user_id, role) VALUES (?1, ?2)").bind(id, role).run();
  }
  return id;
}

export async function addSession(
  userId: number,
  opts: { lastAuthAgoMs?: number; lastSeenAgoMs?: number } = {},
): Promise<string> {
  const token = await createSession(db, userId, Date.now());
  const hash = await sha256Hex(token);
  const iso = (ago: number): string => new Date(Date.now() - ago).toISOString();
  await db
    .prepare("UPDATE sessions SET last_auth_at = ?1, last_seen_at = ?2 WHERE token_hash = ?3")
    .bind(iso(opts.lastAuthAgoMs ?? 0), iso(opts.lastSeenAgoMs ?? 0), hash)
    .run();
  return token;
}

/** Authenticated request with the CSRF header. */
export function authed(
  path: string,
  token: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, ...rest } = init;
  return call(path, {
    ...rest,
    headers: {
      cookie: `__Host-session=${token}`,
      "x-requested-with": "fetch",
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
}
