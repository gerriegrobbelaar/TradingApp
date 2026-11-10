import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookieFrom, addSession, addUser, authed, call, db, resetDb, setCookies } from "./helpers";
import worker from "../src/index";
import { parseMe } from "../src/exact/routes";
import {
  auditActions,
  resetExact,
  seedConnection,
  stubExact,
  storedTokens,
  type ExactStub,
} from "./exact-helpers";

const ADMIN = "gerrie.grobbelaar@camelthorncapital.com";
const FLOW = "__Host-exact-oauth";
const ME = {
  d: { results: [{ CurrentDivision: 123456, DivisionCustomerName: "Camelthorn Advisory B.V." }] },
};

let adminTok: string;
let adminId: number;
let stub: ExactStub;

beforeEach(async () => {
  await resetDb();
  await resetExact();
  adminId = await addUser(ADMIN, ["admin"]);
  adminTok = await addSession(adminId);
  stub = stubExact();
  stub.token = () =>
    Response.json({
      access_token: "acc-NEW",
      refresh_token: "ref-NEW",
      token_type: "bearer",
      expires_in: "600",
    });
  stub.api = () => Response.json(ME);
});
afterEach(() => stub.restore());

interface Started {
  state: string;
  flowCookie: string;
  location: URL;
}

async function start(token = adminTok): Promise<Started> {
  const res = await authed("/api/connections/exact/start", token);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  return {
    state: location.searchParams.get("state") ?? "",
    flowCookie: cookieFrom(res, FLOW) ?? "",
    location,
  };
}

const callback = (
  s: { state: string; flowCookie: string },
  token = adminTok,
  query = "code=the-code",
) =>
  call(`/api/connections/exact/callback?${query}&state=${encodeURIComponent(s.state)}`, {
    headers: {
      cookie: `__Host-session=${token}${s.flowCookie ? `; ${FLOW}=${s.flowCookie}` : ""}`,
    },
  });

describe("GET /api/connections/exact/start", () => {
  it("redirects an admin with fresh step-up to Exact with the right parameters", async () => {
    const s = await start();
    expect(s.location.origin + s.location.pathname).toBe(
      "https://start.exactonline.nl/api/oauth2/auth",
    );
    expect(Object.fromEntries(s.location.searchParams)).toMatchObject({
      client_id: "test-exact-client-id",
      redirect_uri: "https://app.test/api/connections/exact/callback",
      response_type: "code",
      force_login: "0",
    });
    expect(s.state.length).toBeGreaterThanOrEqual(40);
    expect(s.flowCookie).not.toBe("");
    const header = setCookies(await authed("/api/connections/exact/start", adminTok)).find((c) =>
      c.startsWith(FLOW),
    );
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/Secure/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(JSON.stringify(Object.fromEntries(s.location.searchParams))).not.toContain(
      "test-exact-client-secret",
    );
  });

  it("requires a recent Google sign-in (step-up)", async () => {
    const stale = await addSession(adminId, { lastAuthAgoMs: 20 * 60 * 1000 });
    const res = await authed("/api/connections/exact/start", stale);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "step_up_required" });
  });

  it.each(["finance", "approver", "viewer"] as const)("is forbidden for %s", async (role) => {
    const id = await addUser(`${role}@camelthorncapital.com`, [role]);
    const res = await authed("/api/connections/exact/start", await addSession(id));
    expect(res.status).toBe(403);
  });

  it("needs a session", async () => {
    expect((await call("/api/connections/exact/start")).status).toBe(401);
  });
});

describe("GET /api/connections/exact/callback", () => {
  it("stores encrypted tokens, learns the division through the gate and audits", async () => {
    const s = await start();
    const res = await callback(s);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings/connections?exact=connected");

    const form = stub.tokenCalls[0];
    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("code")).toBe("the-code");
    expect(form?.get("redirect_uri")).toBe("https://app.test/api/connections/exact/callback");
    expect(form?.get("client_id")).toBe("test-exact-client-id");
    expect(form?.get("client_secret")).toBe("test-exact-client-secret");

    const row = await db
      .prepare("SELECT * FROM connections WHERE kind = 'exact'")
      .first<Record<string, string | number | null>>();
    expect(row).toMatchObject({
      status: "active",
      connected_by: ADMIN,
      region_host: "start.exactonline.nl",
      last_error: null,
    });
    // Ciphertext only, bound to this connection.
    expect(JSON.stringify(row)).not.toContain("acc-NEW");
    expect(JSON.stringify(row)).not.toContain("ref-NEW");
    expect(await storedTokens(row?.id as number)).toMatchObject({
      access: "acc-NEW",
      refresh: "ref-NEW",
    });
    const expiry = Date.parse(String(row?.expires_at)) - Date.now();
    expect(expiry).toBeGreaterThan(590_000);
    expect(expiry).toBeLessThanOrEqual(600_000);

    // /current/Me went through the gate with the new bearer token.
    expect(stub.apiCalls[0]?.url.pathname).toBe("/api/v1/current/Me");
    expect(stub.apiCalls[0]?.headers.authorization).toBe("Bearer acc-NEW");
    const div = await db
      .prepare("SELECT exact_division, name FROM divisions")
      .all<{ exact_division: number; name: string }>();
    expect(div.results).toEqual([{ exact_division: 123456, name: "Camelthorn Advisory B.V." }]);

    const audit = await db
      .prepare(
        "SELECT actor_email, action, after_json FROM audit_log WHERE action LIKE 'connection.exact_%' ORDER BY id",
      )
      .all<{ actor_email: string; action: string; after_json: string }>();
    expect(audit.results.map((a) => a.action)).toEqual([
      "connection.exact_connected",
      "connection.exact_divisions_synced",
    ]);
    expect(audit.results.every((a) => a.actor_email === ADMIN)).toBe(true);
    expect(JSON.stringify(audit.results)).not.toMatch(/acc-NEW|ref-NEW|the-code/);
  });

  it("is single use: replaying the same callback does nothing", async () => {
    const s = await start();
    expect((await callback(s)).headers.get("location")).toContain("exact=connected");
    stub.tokenCalls.length = 0;
    const again = await callback(s);
    expect(again.headers.get("location")).toBe("/settings/connections?exact=denied");
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("rejects a wrong or missing state and a missing flow cookie", async () => {
    const s = await start();
    for (const bad of [
      callback({ ...s, state: "forged" }),
      callback({ ...s, state: "" }),
      callback({ ...s, flowCookie: "" }),
      callback({ ...s, flowCookie: `${s.flowCookie}x` }),
      // Tamper with the FIRST character: every bit of it is significant. (The last base64url
      // character carries padding bits, so changing it can decode to the same bytes; that made
      // this test flaky about 1 run in 16.)
      callback({ ...s, flowCookie: s.flowCookie.replace(/^./, (c) => (c === "A" ? "B" : "A")) }),
    ]) {
      const res = await bad;
      expect(res.headers.get("location")).toBe("/settings/connections?exact=denied");
    }
    expect(stub.tokenCalls).toHaveLength(0);
    expect(
      await db.prepare("SELECT 1 FROM connections WHERE status = 'active'").first(),
    ).toBeNull();
  });

  it("rejects a callback from a different admin than the one who started the flow", async () => {
    const s = await start();
    const otherId = await addUser("second@camelthorncapital.com", ["admin"]);
    const res = await callback(s, await addSession(otherId));
    expect(res.headers.get("location")).toBe("/settings/connections?exact=denied");
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("is admin only and needs a session", async () => {
    const s = await start();
    const viewer = await addSession(await addUser("v@camelthorncapital.com", ["viewer"]));
    expect((await callback(s, viewer)).status).toBe(403);
    const anon = await call(`/api/connections/exact/callback?code=c&state=${s.state}`, {
      headers: { cookie: `${FLOW}=${s.flowCookie}` },
    });
    expect(anon.status).toBe(401);
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("denies when Exact reports an error or sends no code", async () => {
    for (const query of ["error=access_denied", ""]) {
      const s = await start();
      const res = await callback(s, adminTok, query);
      expect(res.headers.get("location")).toBe("/settings/connections?exact=denied");
    }
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("reports an error and stores nothing when the code exchange fails", async () => {
    stub.token = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const audited = await auditActions("connection.exact_connected");
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?exact=error");
    expect(
      await db.prepare("SELECT 1 FROM connections WHERE status = 'active'").first(),
    ).toBeNull();
    expect(await auditActions("connection.exact_connected")).toBe(audited);
  });

  it("stays connected but says so when /current/Me fails", async () => {
    stub.api = () => new Response("nope", { status: 500 });
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?exact=connected_no_division");
    expect(
      (await db.prepare("SELECT status FROM connections").first<{ status: string }>())?.status,
    ).toBe("active");
    expect(await db.prepare("SELECT 1 FROM divisions").first()).toBeNull();
  });

  it("clears the flow cookie on every outcome", async () => {
    const s = await start();
    const res = await callback(s);
    expect(setCookies(res).some((c) => c.startsWith(`${FLOW}=;`) && c.includes("Max-Age=0"))).toBe(
      true,
    );
  });

  it("re-authorising replaces the tokens of the existing connection", async () => {
    const id = await seedConnection({ status: "needs_reauth", access: "old", refresh: "old" });
    await callback(await start());
    const rows = await db
      .prepare("SELECT id, status FROM connections")
      .all<{ id: number; status: string }>();
    expect(rows.results).toEqual([{ id, status: "active" }]);
    expect(await storedTokens(id)).toMatchObject({ access: "acc-NEW", refresh: "ref-NEW" });
  });
});

describe("POST /api/connections/exact/disconnect", () => {
  const post = (token = adminTok) =>
    authed("/api/connections/exact/disconnect", token, { method: "POST" });

  it("wipes the tokens, disables the connection and audits", async () => {
    const id = await seedConnection();
    const before = await auditActions("connection.exact_disconnected");
    const res = await post();
    expect(res.status).toBe(200);
    expect(await storedTokens(id)).toMatchObject({
      status: "disabled",
      access: null,
      refresh: null,
    });
    const row = await db
      .prepare("SELECT token_ref, expires_at FROM connections WHERE id = ?1")
      .bind(id)
      .first();
    expect(row).toEqual({ token_ref: null, expires_at: null });
    expect(await auditActions("connection.exact_disconnected")).toBe(before + 1);
    // Calls through the gate now fail without touching Exact.
    const { gateStub, req } = await import("./exact-helpers");
    const out = await gateStub("exact:991").call(req(991));
    expect(out).toEqual({ ok: false, error: { kind: "auth", code: "not_connected" } });
    expect(stub.apiCalls).toHaveLength(0);
  });

  it("is idempotent: a second disconnect is 200, changes nothing and writes no audit row", async () => {
    await seedConnection();
    expect(await (await post()).json()).toEqual({ ok: true, changed: true });
    const n = await auditActions("connection.exact_disconnected");
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: false });
    expect(await auditActions("connection.exact_disconnected")).toBe(n);
  });

  it("is a no-op without any connection row", async () => {
    const n = await auditActions("connection.exact_disconnected");
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: false });
    expect(await auditActions("connection.exact_disconnected")).toBe(n);
  });

  it("audits the change without any token material in before/after", async () => {
    const id = await seedConnection({ access: "acc-AUDIT", refresh: "ref-AUDIT" });
    await post();
    const rows = await db
      .prepare(
        "SELECT before_json, after_json FROM audit_log WHERE entity = 'connection' AND entity_id = ?1",
      )
      .bind(String(id))
      .all<{ before_json: string | null; after_json: string | null }>();
    const text = JSON.stringify(rows.results);
    expect(rows.results.length).toBeGreaterThan(0);
    for (const bad of ["acc-AUDIT", "ref-AUDIT", "v1.", "token"]) expect(text).not.toContain(bad);
  });

  it("needs admin and a recent sign-in", async () => {
    await seedConnection();
    const viewer = await addSession(await addUser("v@camelthorncapital.com", ["viewer"]));
    expect((await post(viewer)).status).toBe(403);
    const stale = await addSession(adminId, { lastAuthAgoMs: 20 * 60 * 1000 });
    expect((await post(stale)).status).toBe(401);
  });

  it("needs the CSRF header", async () => {
    await seedConnection();
    const res = await call("/api/connections/exact/disconnect", {
      method: "POST",
      headers: { cookie: `__Host-session=${adminTok}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/connections", () => {
  it("shows status and divisions to every role, never tokens", async () => {
    const id = await seedConnection({ access: "acc-LEAK", refresh: "ref-LEAK" });
    await db
      .prepare("INSERT INTO divisions (connection_id, exact_division, name) VALUES (?1, 42, 'BV')")
      .bind(id)
      .run();
    for (const role of ["admin", "finance", "approver", "viewer"] as const) {
      const tok = await addSession(await addUser(`${role}-x@camelthorncapital.com`, [role]));
      const res = await authed("/api/connections", tok);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toMatch(/acc-LEAK|ref-LEAK|v1\.|token_enc|access_token|refresh_token/);
      const body = JSON.parse(text) as {
        exactConfigured: boolean;
        connections: { kind: string; status: string; divisions: unknown[]; connectedBy: string }[];
      };
      expect(body.exactConfigured).toBe(true);
      expect(body.connections).toEqual([
        expect.objectContaining({
          kind: "exact",
          status: "active",
          connectedBy: "gerrie@camelthorncapital.com",
          divisions: [{ division: 42, name: "BV", currency: "EUR" }],
        }),
      ]);
    }
  });

  it("reports needs_reauth with its error code", async () => {
    await seedConnection({ status: "needs_reauth" });
    await db.prepare("UPDATE connections SET last_error = 'invalid_grant'").run();
    const res = await authed("/api/connections", adminTok);
    const body = (await res.json()) as { connections: { status: string; lastError: string }[] };
    expect(body.connections[0]).toMatchObject({
      status: "needs_reauth",
      lastError: "invalid_grant",
    });
  });

  it("needs a session", async () => {
    expect((await call("/api/connections")).status).toBe(401);
  });
});

describe("misconfiguration", () => {
  const withEnv = (over: Record<string, string>, path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(`https://app.test${path}`, {
        ...init,
        headers: { cookie: `__Host-session=${adminTok}`, "x-requested-with": "fetch" },
      }),
      { ...env, ...over },
    );

  it.each([
    ["EXACT_CLIENT_ID", ""],
    ["EXACT_CLIENT_SECRET", ""],
    ["EXACT_REDIRECT_URI", "https://evil.example/api/connections/exact/callback"],
    ["EXACT_REDIRECT_URI", "https://app.test/somewhere/else"],
    ["TOKEN_ENC_KEY", ""],
    ["TOKEN_ENC_KEY", btoa("too short")],
  ])("%s=%j makes start and callback answer 500 server_misconfigured", async (name, value) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const path of [
      "/api/connections/exact/start",
      "/api/connections/exact/callback?code=a&state=b",
    ]) {
      const res = await withEnv({ [name]: value }, path);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "server_misconfigured" });
    }
    // only variable names are logged
    expect(spy.mock.calls.flat().join(" ")).not.toContain("test-exact-client-secret");
    spy.mockRestore();
    // other routes are unaffected, and the status route still works (and says not configured)
    expect((await withEnv({ [name]: value }, "/api/auth/me")).status).toBe(200);
    const list = await withEnv({ [name]: value }, "/api/connections");
    expect(((await list.json()) as { exactConfigured: boolean }).exactConfigured).toBe(false);
  });
});

describe("parseMe", () => {
  it("reads the current division and falls back to a generic name", () => {
    expect(parseMe(JSON.stringify(ME))).toEqual({
      division: 123456,
      name: "Camelthorn Advisory B.V.",
    });
    expect(parseMe(JSON.stringify({ d: [{ CurrentDivision: "77" }] }))).toEqual({
      division: 77,
      name: "Division 77",
    });
    for (const bad of [
      "",
      "{}",
      '{"d":{"results":[]}}',
      '{"d":{"results":[{"CurrentDivision":0}]}}',
      "[1]",
    ]) {
      expect(parseMe(bad)).toBeNull();
    }
  });
});

describe("no secrets in logs", () => {
  it("logs no token, code or secret during connect", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await callback(await start());
    await callback({ state: "bad", flowCookie: "" });
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    for (const secret of ["acc-NEW", "ref-NEW", "the-code", "test-exact-client-secret"]) {
      expect(logged).not.toContain(secret);
    }
    spies.forEach((s) => s.mockRestore());
  });
});
