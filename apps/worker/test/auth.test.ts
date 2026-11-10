import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Base64Url, sha256Hex } from "../src/auth/crypto";
import { loadAuthConfig } from "../src/auth/config";
import { resetJwksCacheForTests } from "../src/auth/google";
import { safeReturnTo } from "../src/auth/flow-cookie";
import {
  CLIENT_ID,
  HD,
  addSession,
  addUser,
  authed,
  call,
  claims,
  db,
  doLogin,
  makeKey,
  setCookies,
  newStub,
  resetDb,
  signJwt,
  stubGoogle,
  type GoogleStub,
  type TestKey,
} from "./helpers";

let key: TestKey;
const ADMIN = "gerrie.grobbelaar@camelthorncapital.com";

beforeAll(async () => {
  key = await makeKey("kid-1");
});

beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubWith(
  over: Record<string, unknown> | ((nonce: string) => Record<string, unknown>) = {},
): GoogleStub {
  const stub = newStub([key], (nonce, k) =>
    signJwt(k, claims({ nonce, ...(typeof over === "function" ? over(nonce) : over) })),
  );
  stubGoogle(stub);
  return stub;
}

async function expectDenied(r: Awaited<ReturnType<typeof doLogin>>): Promise<void> {
  expect(r.callback.status).toBe(302);
  expect(r.callback.headers.get("location")).toBe("/?auth=denied");
  expect(r.sessionToken).toBeUndefined();
  expect(await db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>()).toEqual({
    n: 0,
  });
}

describe("login redirect", () => {
  it("sends the right parameters to Google and sets a signed HttpOnly flow cookie", async () => {
    const res = await call("/api/auth/login");
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get("location") ?? "");
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(env.OAUTH_REDIRECT_URI);
    expect(u.searchParams.get("scope")).toBe("openid email");
    expect(u.searchParams.get("hd")).toBe(HD);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(u.searchParams.get("nonce")).toBeTruthy();
    expect(u.searchParams.get("prompt")).toBeNull();
    const setCookie = setCookies(res).join("\n");
    expect(setCookie).toMatch(/__Host-oauth=.*HttpOnly/);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Max-Age=600");
  });

  it("adds prompt=login and max_age=0 for a step-up", async () => {
    const res = await call("/api/auth/login?step_up=1");
    const u = new URL(res.headers.get("location") ?? "");
    expect(u.searchParams.get("prompt")).toBe("login");
    expect(u.searchParams.get("max_age")).toBe("0");
  });

  it("only accepts same-origin relative return_to paths", () => {
    const o = "https://app.test";
    expect(safeReturnTo("/today", o)).toBe("/today");
    expect(safeReturnTo("/invoices?x=1#top", o)).toBe("/invoices?x=1#top");
    expect(safeReturnTo("/%2F%2Fevil.test", o)).toBe("/%2F%2Fevil.test"); // stays a path
    expect(safeReturnTo("/caf\u00e9/\u20ac", o)).toBe("/caf%C3%A9/%E2%82%AC"); // header-safe
    for (const bad of [
      "//evil.test",
      "///evil.test",
      "https://evil.test",
      "http:/evil.test",
      "javascript:alert(1)",
      "/\\evil",
      "\\\\evil",
      "/\t/evil.test",
      "/\n/evil.test",
      "/../..//evil.test",
      "/./\u0000",
      "today",
      "",
      "/" + "a".repeat(3000),
    ]) {
      expect(safeReturnTo(bad, o), bad).toBe("/");
    }
    expect(safeReturnTo(null, o)).toBe("/");
  });

  it("carries a decoded but hostile return_to through as / (end to end)", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    // URLSearchParams decodes %2F%2F and %5C before our check sees them.
    for (const rt of ["//evil.test", "/\\evil.test", "https://evil.test/x"]) {
      await resetDb();
      await addUser(ADMIN, ["admin"], { sub: null });
      const r = await doLogin(stubWith(), { returnTo: rt });
      expect(r.callback.headers.get("location")).toBe("/");
    }
    await resetDb();
    await addUser(ADMIN, ["admin"], { sub: null });
    const ok = await doLogin(stubWith(), { returnTo: "/payables?tab=open" });
    expect(ok.callback.headers.get("location")).toBe("/payables?tab=open");
  });
});

describe("callback", () => {
  it("happy path: seeded admin signs in, sub is bound, session stored hash-only", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const stub = stubWith();
    const r = await doLogin(stub);
    expect(r.callback.status).toBe(302);
    expect(r.callback.headers.get("location")).toBe("/");
    const token = r.sessionToken;
    expect(token).toBeTruthy();
    const cookie = setCookies(r.callback).find((c) => c.startsWith("__Host-session="));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain/i);

    // PKCE: verifier sent to the token endpoint hashes to the challenge.
    const tokenReq = stub.tokenRequests[0];
    expect(tokenReq?.get("client_secret")).toBe(env.GOOGLE_CLIENT_SECRET);
    expect(tokenReq?.get("grant_type")).toBe("authorization_code");
    expect(await sha256Base64Url(tokenReq?.get("code_verifier") ?? "")).toBe(
      r.authUrl.searchParams.get("code_challenge"),
    );

    const user = await db
      .prepare("SELECT google_sub FROM users WHERE email = ?1")
      .bind(ADMIN)
      .first<{ google_sub: string }>();
    expect(user?.google_sub).toBe("google-sub-1");

    // Only the hash is in D1.
    const rows = await db.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.token_hash).toBe(await sha256Hex(token ?? ""));
    expect(rows.results[0]?.token_hash).not.toBe(token);
    const dump = JSON.stringify((await db.prepare("SELECT * FROM sessions").all()).results);
    expect(dump).not.toContain(token);

    // A plain login without auth_time does not count as a fresh sign-in for step-up.
    const me = await authed("/api/auth/me", token ?? "");
    expect(await me.json()).toMatchObject({ email: ADMIN, roles: ["admin"], stepUpFresh: false });

    const audit = await db
      .prepare("SELECT actor_email, action FROM audit_log WHERE action = 'auth.login'")
      .first();
    expect(audit).toEqual({ actor_email: ADMIN, action: "auth.login" });
  });

  it("accepts an unaccepted invite on first sign-in and grants its roles", async () => {
    await db
      .prepare(
        "INSERT INTO invites (email, roles, invited_by) VALUES ('new.person@camelthorncapital.com', '[\"finance\",\"viewer\"]', ?1)",
      )
      .bind(ADMIN)
      .run();
    const stub = stubWith({ email: "New.Person@camelthorncapital.com", sub: "sub-new" });
    const r = await doLogin(stub);
    expect(r.sessionToken).toBeTruthy();
    const me = await authed("/api/auth/me", r.sessionToken ?? "");
    expect(await me.json()).toMatchObject({
      email: "new.person@camelthorncapital.com",
      roles: ["finance", "viewer"],
    });
    const inv = await db
      .prepare("SELECT accepted_at FROM invites")
      .first<{ accepted_at: string | null }>();
    expect(inv?.accepted_at).not.toBeNull();
  });

  it.each([
    ["wrong aud", { aud: "someone-else" }],
    ["wrong iss", { iss: "https://evil.example.com" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["bad nonce", { nonce: "not-the-nonce" }],
    ["email not verified", { email_verified: false }],
    ["wrong hd", { hd: "gmail.com" }],
    ["missing hd", { hd: undefined }],
    ["hd in different case but email outside domain", { email: "x@gmail.com" }],
    ["subdomain email", { email: "gerrie.grobbelaar@evil.camelthorncapital.com" }],
    ["email_verified as string", { email_verified: "true" }],
    ["multi-audience", { aud: [CLIENT_ID, "other-client"] }],
    ["azp of another client", { azp: "other-client" }],
    ["missing iat", { iat: undefined }],
    ["iat in the future", { iat: Math.floor(Date.now() / 1000) + 600 }],
    ["auth_time in the future", { auth_time: Math.floor(Date.now() / 1000) + 600 }],
    ["auth_time not a number", { auth_time: "now" }],
    ["missing exp", { exp: undefined }],
    ["missing nonce", { nonce: undefined }],
  ])("denies: %s", async (_name, over) => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const r = await doLogin(stubWith(over));
    await expectDenied(r);
  });

  it("denies a token signed with a different key", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const other = await makeKey("kid-1"); // same kid, different key material
    const stub = newStub([key], (nonce) => signJwt(other, claims({ nonce })));
    stubGoogle(stub);
    await expectDenied(await doLogin(stub));
  });

  it.each(["none", "HS256", "RS384", "PS256", "ES256", undefined])(
    "denies alg %s (RS256 only)",
    async (alg) => {
      await addUser(ADMIN, ["admin"], { sub: null });
      const stub = newStub([key], (nonce, k) => signJwt(k, claims({ nonce }), { alg }));
      stubGoogle(stub);
      await expectDenied(await doLogin(stub));
    },
  );

  it("denies an HS256 token MAC'd with the public key (key confusion)", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const stub = newStub([key], async (nonce) => {
      const enc = new TextEncoder();
      const b64 = (o: unknown): string =>
        btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const h = b64({ alg: "HS256", typ: "JWT", kid: key.kid });
      const p = b64(claims({ nonce }));
      const k = await crypto.subtle.importKey(
        "raw",
        enc.encode(key.jwk.n ?? ""),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`${h}.${p}`)));
      let bin = "";
      for (const b of sig) bin += String.fromCharCode(b);
      return `${h}.${p}.${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    });
    stubGoogle(stub);
    await expectDenied(await doLogin(stub));
  });

  it("denies a token whose kid is missing or unknown, and a JWK for another alg", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const noKid = newStub([key], (nonce, k) => signJwt(k, claims({ nonce }), { kid: undefined }));
    stubGoogle(noKid);
    await expectDenied(await doLogin(noKid));
    expect(noKid.jwksFetches).toBe(0);

    const unknown = newStub([key], (nonce, k) => signJwt(k, claims({ nonce }), { kid: "nope" }));
    stubGoogle(unknown);
    await expectDenied(await doLogin(unknown));

    const wrongAlg: TestKey = { ...key, jwk: { ...key.jwk, alg: "RS512" } };
    const stub = newStub([wrongAlg], (nonce, k) => signJwt(k, claims({ nonce })));
    stubGoogle(stub);
    await expectDenied(await doLogin(stub));
  });

  it("fails closed when the JWKS cannot be fetched or is malformed", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    for (const jwks of [
      new Response("down", { status: 503 }),
      new Response("not json", { status: 200 }),
      Response.json({ nokeys: true }),
    ]) {
      const stub = stubWith();
      const real = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "https://www.googleapis.com/oauth2/v3/certs") return jwks.clone();
        return real(input, init);
      });
      await expectDenied(await doLogin(stub));
    }
  });

  it("a replayed callback (same flow cookie, state and code) cannot create a second session", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const r = await doLogin(stubWith());
    expect(r.sessionToken).toBeTruthy();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const again = await r.replay();
    expect(again.headers.get("location")).toBe("/?auth=denied");
    expect(warn).toHaveBeenLastCalledWith("sign-in denied", "flow_replayed");
    expect(setCookies(again).some((c) => /^__Host-session=[^;]+;/.test(c))).toBe(false);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>()).toEqual({
      n: 1,
    });
    // The flow cookie is cleared on success too.
    expect(setCookies(r.callback).some((c) => c.startsWith("__Host-oauth=;"))).toBe(true);
  });

  it("accepts the bare accounts.google.com issuer", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const r = await doLogin(stubWith({ iss: "accounts.google.com" }));
    expect(r.sessionToken).toBeTruthy();
  });

  it("denies a bad state", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const stub = stubWith();
    await expectDenied(await doLogin(stub, { state: () => "forged" }));
    expect(stub.tokenRequests).toHaveLength(0); // rejected before any call to Google
  });

  it("denies a missing, tampered or foreign flow cookie", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    await expectDenied(await doLogin(stubWith(), { flowCookie: () => undefined }));
    await expectDenied(
      await doLogin(stubWith(), {
        flowCookie: (c) => `${c.slice(0, -3)}${c.endsWith("AAA") ? "BBB" : "AAA"}`,
      }),
    );
  });

  it("denies an expired flow cookie", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const stub = stubWith();
    const login = await call("/api/auth/login");
    const u = new URL(login.headers.get("location") ?? "");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);
    const flow = setCookies(login)[0]?.split(";")[0] ?? "";
    const res = await call(`/api/auth/callback?code=x&state=${u.searchParams.get("state")}`, {
      headers: { cookie: flow },
    });
    expect(res.headers.get("location")).toBe("/?auth=denied");
    expect(stub.tokenRequests).toHaveLength(0);
  });

  it("denies an uninvited user", async () => {
    await expectDenied(await doLogin(stubWith({ email: "stranger@camelthorncapital.com" })));
  });

  it("denies a revoked or already accepted invite", async () => {
    await db
      .prepare(
        "INSERT INTO invites (email, roles, invited_by, revoked_at) VALUES ('stranger@camelthorncapital.com', '[\"viewer\"]', 'x', '2026-01-01T00:00:00.000Z')",
      )
      .run();
    await expectDenied(await doLogin(stubWith({ email: "stranger@camelthorncapital.com" })));
  });

  it("denies a disabled user, even with a valid token", async () => {
    await addUser(ADMIN, ["admin"], { sub: "google-sub-1", disabled: true });
    await expectDenied(await doLogin(stubWith()));
  });

  it("denies when the Google sub differs from the stored one", async () => {
    await addUser(ADMIN, ["admin"], { sub: "original-sub" });
    await expectDenied(await doLogin(stubWith({ sub: "attacker-sub" })));
  });

  it("denies when Google rejects the code", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const stub = stubWith();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 400 }));
    await expectDenied(await doLogin(stub));
  });

  it("failure reasons never reach the client or the log in full", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await doLogin(stubWith({ hd: "gmail.com" }));
    const body = await r.callback.text();
    expect(body).toBe("");
    expect(r.callback.headers.get("location")).toBe("/?auth=denied");
    expect(warn.mock.calls.flat().join(" ")).toBe("sign-in denied bad_hd");
  });

  it("refetches the JWKS when Google rotates keys (unknown kid) and caches otherwise", async () => {
    await addUser(ADMIN, ["admin"], { sub: null });
    const k1 = await makeKey("old");
    const k2 = await makeKey("new");
    const stub: GoogleStub = newStub([k1], (nonce, k) => signJwt(k, claims({ nonce })));
    stubGoogle(stub);
    expect((await doLogin(stub)).sessionToken).toBeTruthy();
    expect(stub.jwksFetches).toBe(1);
    expect((await doLogin(stub)).sessionToken).toBeTruthy();
    expect(stub.jwksFetches).toBe(1); // cached

    stub.keys = [k2];
    stub.idToken = (nonce) => signJwt(k2, claims({ nonce }));
    expect((await doLogin(stub)).sessionToken).toBeTruthy();
    expect(stub.jwksFetches).toBe(2); // unknown kid forced a refetch
    resetJwksCacheForTests();
  });

  it("step-up login replaces the old session and refreshes last_auth_at", async () => {
    const id = await addUser(ADMIN, ["admin"], { sub: "google-sub-1" });
    const old = await addSession(id, { lastAuthAgoMs: 60 * 60 * 1000 });
    const r = await doLogin(stubWith({ auth_time: Math.floor(Date.now() / 1000) - 5 }), {
      stepUp: true,
      existingSession: old,
    });
    expect(r.sessionToken).toBeTruthy();
    expect((await authed("/api/auth/me", old)).status).toBe(401);
    const me = await authed("/api/auth/me", r.sessionToken ?? "");
    expect((await me.json()) as { stepUpFresh: boolean }).toMatchObject({ stepUpFresh: true });
  });

  it("step-up denies when Google reports an old auth_time", async () => {
    const id = await addUser(ADMIN, ["admin"], { sub: "google-sub-1" });
    const r = await doLogin(stubWith({ auth_time: Math.floor(Date.now() / 1000) - 3600 }), {
      stepUp: true,
    });
    expect(id).toBeGreaterThan(0);
    await expectDenied(r);
  });
});

describe("step-up cannot be refreshed without re-authenticating", () => {
  it("step-up denies when Google omits auth_time", async () => {
    await addUser(ADMIN, ["admin"], { sub: "google-sub-1" });
    await expectDenied(await doLogin(stubWith(), { stepUp: true }));
  });

  it("a plain (silent SSO) login does not make the session step-up fresh", async () => {
    const id = await addUser(ADMIN, ["admin"], { sub: "google-sub-1" });
    const stale = await addSession(id, { lastAuthAgoMs: 60 * 60 * 1000 });
    // Google reports the original authentication an hour ago.
    const r = await doLogin(stubWith({ auth_time: Math.floor(Date.now() / 1000) - 3600 }), {
      existingSession: stale,
    });
    expect(r.sessionToken).toBeTruthy();
    const body = { email: "x@camelthorncapital.com", roles: ["viewer"] };
    const res = await authed("/api/users/invite", r.sessionToken ?? "", {
      method: "POST",
      json: body,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "step_up_required" });

    // Without auth_time at all: also not fresh.
    const r2 = await doLogin(stubWith());
    const me = await authed("/api/auth/me", r2.sessionToken ?? "");
    expect(await me.json()).toMatchObject({ stepUpFresh: false });
  });

  it("a plain login whose auth_time is genuinely recent counts as a sign-in within 15 minutes", async () => {
    await addUser(ADMIN, ["admin"], { sub: "google-sub-1" });
    const r = await doLogin(stubWith({ auth_time: Math.floor(Date.now() / 1000) - 60 }));
    const me = await authed("/api/auth/me", r.sessionToken ?? "");
    expect(await me.json()).toMatchObject({ stepUpFresh: true });
  });

  it("the step_up flag in the flow cookie cannot be flipped", async () => {
    await addUser(ADMIN, ["admin"], { sub: "google-sub-1" });
    const r = await doLogin(stubWith(), {
      flowCookie: (c) => {
        const [payload, sig] = c.split(".");
        const json = JSON.parse(atob((payload ?? "").replace(/-/g, "+").replace(/_/g, "/"))) as {
          stepUp: boolean;
        };
        json.stepUp = !json.stepUp;
        const p = btoa(JSON.stringify(json))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        return `${p}.${sig ?? ""}`;
      },
    });
    await expectDenied(r);
  });
});

describe("sessions", () => {
  it("idle expiry after 12 hours; activity slides the window", async () => {
    const id = await addUser("a@camelthorncapital.com", ["viewer"]);
    const fresh = await addSession(id, { lastSeenAgoMs: 11 * 3600 * 1000 });
    expect((await authed("/api/auth/me", fresh)).status).toBe(200);
    // The request slid last_seen_at forward.
    const row = await db
      .prepare("SELECT last_seen_at FROM sessions")
      .first<{ last_seen_at: string }>();
    expect(Date.now() - Date.parse(row?.last_seen_at ?? "")).toBeLessThan(5000);

    const idle = await addSession(id, { lastSeenAgoMs: 12 * 3600 * 1000 + 1000 });
    expect((await authed("/api/auth/me", idle)).status).toBe(401);
  });

  it("absolute cap", async () => {
    const id = await addUser("a@camelthorncapital.com", ["viewer"]);
    const t = await addSession(id);
    await db
      .prepare("UPDATE sessions SET expires_at = ?1")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await authed("/api/auth/me", t)).status).toBe(401);
  });

  it("a disabled user's existing session stops working", async () => {
    const id = await addUser("a@camelthorncapital.com", ["viewer"]);
    const t = await addSession(id);
    await db.prepare("UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z'").run();
    expect((await authed("/api/auth/me", t)).status).toBe(401);
  });

  it("logout deletes the session and clears the cookie", async () => {
    const id = await addUser("a@camelthorncapital.com", ["viewer"]);
    const t = await addSession(id);
    const res = await authed("/api/auth/logout", t, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await authed("/api/auth/me", t)).status).toBe(401);
  });

  it("logout of an expired or unknown session still clears the cookie, and needs CSRF", async () => {
    const res = await authed("/api/auth/logout", "a".repeat(43), { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("__Host-session=; Path=/");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    const noCsrf = await call("/api/auth/logout", { method: "POST" });
    expect(noCsrf.status).toBe(403);
  });

  it("logout is audited under the user's email", async () => {
    const id = await addUser("a@camelthorncapital.com", ["viewer"]);
    const t = await addSession(id);
    await authed("/api/auth/logout", t, { method: "POST" });
    const row = await db
      .prepare("SELECT actor_email, after_json FROM audit_log WHERE action = 'auth.logout'")
      .first();
    expect(row).toEqual({ actor_email: "a@camelthorncapital.com", after_json: null });
  });

  it("garbage tokens are rejected", async () => {
    expect((await authed("/api/auth/me", "x")).status).toBe(401);
    expect((await authed("/api/auth/me", "a".repeat(43))).status).toBe(401);
  });
});

describe("step-up", () => {
  it("me reports fresh vs stale; protected route answers step_up_required when stale", async () => {
    const id = await addUser(ADMIN, ["admin"]);
    const stale = await addSession(id, { lastAuthAgoMs: 16 * 60 * 1000 });
    const fresh = await addSession(id, { lastAuthAgoMs: 14 * 60 * 1000 });

    expect(await (await authed("/api/auth/me", stale)).json()).toMatchObject({
      stepUpFresh: false,
    });
    expect(await (await authed("/api/auth/me", fresh)).json()).toMatchObject({ stepUpFresh: true });

    const body = { email: "x@camelthorncapital.com", roles: ["viewer"] };
    const denied = await authed("/api/users/invite", stale, { method: "POST", json: body });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "step_up_required" });
    const ok = await authed("/api/users/invite", fresh, { method: "POST", json: body });
    expect(ok.status).toBe(201);
  });
});

describe("access control", () => {
  it("default-denies: unauthenticated requests get 401, health and login are open", async () => {
    expect((await call("/api/auth/me")).status).toBe(401);
    expect((await call("/api/users")).status).toBe(401);
    expect((await call("/api/health")).status).toBe(200);
    expect((await call("/api/auth/login")).status).toBe(302);
    expect((await call("/api/nope")).status).toBe(404);
    expect(
      (await call("/api/users", { method: "PUT", headers: { "x-requested-with": "x" } })).status,
    ).toBe(405);
  });

  it("CSRF: unsafe methods need X-Requested-With and a matching Origin", async () => {
    const id = await addUser(ADMIN, ["admin"]);
    const t = await addSession(id);
    const cookie = { cookie: `__Host-session=${t}` };
    const noHeader = await call("/api/auth/logout", { method: "POST", headers: cookie });
    expect(noHeader.status).toBe(403);
    expect(await noHeader.json()).toEqual({ error: "csrf" });

    const badOrigin = await call("/api/auth/logout", {
      method: "POST",
      headers: { ...cookie, "x-requested-with": "fetch", origin: "https://evil.test" },
    });
    expect(badOrigin.status).toBe(403);

    // Session survives the rejected attempts.
    expect((await authed("/api/auth/me", t)).status).toBe(200);

    const good = await call("/api/auth/logout", {
      method: "POST",
      headers: { ...cookie, "x-requested-with": "fetch", origin: "https://app.test" },
    });
    expect(good.status).toBe(200);
  });

  it("role checks per route; roles are not hierarchical", async () => {
    const viewer = await addSession(await addUser("v@camelthorncapital.com", ["viewer"]));
    const finance = await addSession(await addUser("f@camelthorncapital.com", ["finance"]));
    const approver = await addSession(await addUser("p@camelthorncapital.com", ["approver"]));
    const admin = await addSession(await addUser(ADMIN, ["admin"]));
    const noRoles = await addSession(await addUser("n@camelthorncapital.com", []));
    for (const t of [viewer, finance, approver, noRoles]) {
      expect((await authed("/api/users", t)).status).toBe(403);
      expect((await authed("/api/users/invite", t, { method: "POST", json: {} })).status).toBe(403);
      expect((await authed("/api/users/1/roles", t, { method: "PATCH", json: {} })).status).toBe(
        403,
      );
      expect((await authed("/api/users/1", t, { method: "DELETE" })).status).toBe(403);
      expect((await authed("/api/auth/me", t)).status).toBe(200);
    }
    expect((await authed("/api/users", admin)).status).toBe(200);
    // admin does not imply other roles
    expect(await (await authed("/api/auth/me", admin)).json()).toMatchObject({ roles: ["admin"] });
  });
});

describe("configuration", () => {
  it("fails closed with a named error when settings are missing", async () => {
    const r = loadAuthConfig({ ...env, GOOGLE_CLIENT_ID: "", SESSION_SECRET: "short" });
    expect(r).toEqual({ ok: false, missing: ["GOOGLE_CLIENT_ID", "SESSION_SECRET(length)"] });
  });

  it("routes answer 500 server_misconfigured but health stays up", async () => {
    const { default: worker } = await import("../src/index");
    const broken = { ...env, GOOGLE_CLIENT_ID: "" };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await worker.fetch(new Request("https://app.test/api/auth/login"), broken);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
    const health = await worker.fetch(new Request("https://app.test/api/health"), broken);
    expect(health.status).toBe(200);
  });
});
