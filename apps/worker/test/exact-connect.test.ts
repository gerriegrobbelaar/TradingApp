import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookieFrom, addSession, addUser, authed, call, db, resetDb, setCookies } from "./helpers";
import worker from "../src/index";
import {
  exactIdentity,
  isDifferentAccount,
  keepIdentity,
  shortIdentity,
} from "../src/exact/routes";
import { createGateTransport } from "../src/exact/gate-transport";
import { ExactAuthError } from "@camelthorn/exact";
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
const CUSTOMER = "aaaaaaaa-1111-2222-3333-444444444444";
const meBody = (over: Record<string, unknown> = {}) => ({
  d: {
    results: [
      {
        UserID: "11111111-2222-3333-4444-555555555555",
        CurrentDivision: 123456,
        DivisionCustomer: CUSTOMER,
        DivisionCustomerName: "Camelthorn Advisory B.V.",
        ...over,
      },
    ],
  },
});
const ME = meBody();

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

async function start(token = adminTok, query = ""): Promise<Started> {
  const res = await authed(`/api/connections/exact/start${query}`, token);
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
      "connection.exact_authorized",
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
          divisions: [
            expect.objectContaining({
              division: 42,
              name: "BV",
              currency: "EUR",
              syncEnabled: false,
            }),
          ],
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

  it("reports rejected app credentials on an active connection (configuration problem)", async () => {
    await seedConnection();
    await db
      .prepare("UPDATE connections SET last_error = 'token_endpoint_rejected_credentials'")
      .run();
    const res = await authed("/api/connections", adminTok);
    const text = await res.text();
    expect(JSON.parse(text).connections[0]).toMatchObject({
      status: "active",
      lastError: "token_endpoint_rejected_credentials",
    });
    expect(text).not.toMatch(/acc-0|ref-0/);
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

describe("reconnecting to another Exact account", () => {
  const rows = () =>
    db
      .prepare("SELECT exact_division, sync_enabled FROM divisions ORDER BY exact_division")
      .all<{ exact_division: number; sync_enabled: number }>();
  const conn = () =>
    db
      .prepare("SELECT status, last_error, exact_identity, access_token_enc FROM connections")
      .first<{
        status: string;
        last_error: string | null;
        exact_identity: string | null;
        access_token_enc: string | null;
      }>();

  it("stores the identity and enables only the /Me division on the first connection", async () => {
    await callback(await start());
    expect((await rows()).results).toEqual([{ exact_division: 123456, sync_enabled: 1 }]);
    expect((await conn())?.exact_identity).toMatch(/^(id|name):[0-9a-f]{64}$/);
  });

  it("lets the same account reconnect and never re-enables a division an admin switched off", async () => {
    await callback(await start());
    await db.batch([
      db.prepare("UPDATE divisions SET sync_enabled = 0"),
      db.prepare(
        "INSERT INTO divisions (connection_id, exact_division, name, sync_enabled) SELECT id, 777, 'Other', 0 FROM connections",
      ),
    ]);
    // Same customer, but Exact now says the current division is 777.
    stub.api = () => Response.json(meBody({ CurrentDivision: 777 }));
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?exact=connected");
    // The admin had switched everything off and the reconnect did not turn anything back on.
    const r = (await rows()).results;
    expect(r.filter((d) => d.sync_enabled === 1).map((d) => d.exact_division)).toEqual([]);
  });

  it("refuses a different account without confirmation and removes the new sign-in", async () => {
    await callback(await start());
    const before = await conn();
    stub.api = () =>
      Response.json(
        meBody({
          CurrentDivision: 999001,
          DivisionCustomer: "bbbbbbbb-1111-2222-3333-444444444444",
          DivisionCustomerName: "Other Company B.V.",
        }),
      );
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?exact=different_exact_account");
    const after = await conn();
    expect(after).toMatchObject({
      status: "disabled",
      last_error: "different_exact_account",
      access_token_enc: null,
      exact_identity: before?.exact_identity,
    });
    // Old divisions untouched, the new one not added.
    expect((await rows()).results).toEqual([{ exact_division: 123456, sync_enabled: 1 }]);
    expect(await auditActions("connection.exact_account_mismatch")).toBe(1);
    expect(await auditActions("connection.exact_account_replaced")).toBe(0);
  });

  it("replaces the account with confirm_replace=1: old divisions off, new one on, audited", async () => {
    await callback(await start());
    stub.api = () =>
      Response.json(
        meBody({
          CurrentDivision: 999001,
          DivisionCustomer: "bbbbbbbb-1111-2222-3333-444444444444",
          DivisionCustomerName: "Other Company B.V.",
        }),
      );
    const res = await callback(await start(adminTok, "?confirm_replace=1"));
    expect(res.headers.get("location")).toBe("/settings/connections?exact=connected");
    expect((await rows()).results).toEqual([
      { exact_division: 123456, sync_enabled: 0 },
      { exact_division: 999001, sync_enabled: 1 },
    ]);
    expect(await conn()).toMatchObject({ status: "active", last_error: null });
    expect(await auditActions("connection.exact_account_replaced")).toBe(1);
    const audit = await db
      .prepare(
        "SELECT actor_email, after_json FROM audit_log WHERE action = 'connection.exact_account_replaced'",
      )
      .first<{ actor_email: string; after_json: string }>();
    expect(audit?.actor_email).toBe(ADMIN);
    expect(audit?.after_json).toContain("999001");
  });

  it("confirm_replace is only honoured for the flow that was started with it", async () => {
    await callback(await start());
    stub.api = () =>
      Response.json(
        meBody({
          CurrentDivision: 999001,
          DivisionCustomer: "cccccccc-1111-2222-3333-444444444444",
        }),
      );
    // A plain start with the parameter only on the callback URL does not count.
    const s = await start();
    const res = await callback(s, adminTok, "code=the-code&confirm_replace=1");
    expect(res.headers.get("location")).toBe("/settings/connections?exact=different_exact_account");
  });

  it("falls back to the division list when the identity is unknown on one side", async () => {
    await callback(await start());
    await db.prepare("UPDATE connections SET exact_identity = NULL").run();
    // Same division as before: the same account, and the identity is filled in.
    await callback(await start());
    expect((await conn())?.exact_identity).toMatch(/^(id|name):[0-9a-f]{64}$/);
    await db.prepare("UPDATE connections SET exact_identity = NULL").run();
    stub.api = () => Response.json(meBody({ CurrentDivision: 555 }));
    const res = await callback(await start());
    expect(res.headers.get("location")).toContain("different_exact_account");
  });
});

describe("account identity", () => {
  const me = (over: Partial<Parameters<typeof exactIdentity>[0]>) => ({
    userId: "u",
    userName: null,
    fullName: null,
    email: null,
    currentDivision: 1,
    divisionCustomerId: null,
    divisionCustomerName: null,
    ...over,
  });

  it("hashes the customer id, else the normalised name, else nothing", async () => {
    const byId = await exactIdentity(
      me({ divisionCustomerId: CUSTOMER, divisionCustomerName: "A" }),
    );
    expect(byId).toMatch(/^(id|name):[0-9a-f]{64}$/);
    expect(
      await exactIdentity(me({ divisionCustomerId: CUSTOMER, divisionCustomerName: "B" })),
    ).toBe(byId);
    const byName = await exactIdentity(me({ divisionCustomerName: "  Camelthorn B.V. " }));
    expect(byName).toBe(await exactIdentity(me({ divisionCustomerName: "camelthorn b.v." })));
    expect(byName).not.toBe(byId);
    expect(await exactIdentity(me({}))).toBeNull();
    expect(await exactIdentity(me({ divisionCustomerName: "   " }))).toBeNull();
  });

  it("decides 'different' from the known divisions first, else from identities", () => {
    const none = { identity: null, divisions: [] as number[] };
    // No history: never different.
    expect(isDifferentAccount(none, { identity: "id:a", division: 1 })).toBe(false);
    // A division we know is the same data, whatever the identity says (a rename, a missing id).
    expect(
      isDifferentAccount({ identity: "id:a", divisions: [1] }, { identity: "id:b", division: 1 }),
    ).toBe(false);
    expect(
      isDifferentAccount(
        { identity: "name:a", divisions: [1] },
        { identity: "name:b", division: 1 },
      ),
    ).toBe(false);
    expect(
      isDifferentAccount({ identity: null, divisions: [1] }, { identity: "id:b", division: 1 }),
    ).toBe(false);
    // An unknown division: only equal identities make it the same account.
    expect(
      isDifferentAccount({ identity: "id:a", divisions: [1] }, { identity: "id:a", division: 9 }),
    ).toBe(false);
    expect(
      isDifferentAccount({ identity: "id:a", divisions: [1] }, { identity: "id:b", division: 9 }),
    ).toBe(true);
    expect(
      isDifferentAccount({ identity: null, divisions: [1] }, { identity: "id:b", division: 2 }),
    ).toBe(true);
    expect(
      isDifferentAccount({ identity: "id:a", divisions: [1] }, { identity: null, division: 2 }),
    ).toBe(true);
    expect(
      isDifferentAccount({ identity: "id:a", divisions: [] }, { identity: null, division: 2 }),
    ).toBe(true);
    expect(
      isDifferentAccount({ identity: "id:a", divisions: [1] }, { identity: "name:a", division: 2 }),
    ).toBe(true);
  });

  it("never downgrades a stable id to a name, and keeps the old one when Exact sends none", () => {
    expect(keepIdentity("id:a", "name:b")).toBe("id:a");
    expect(keepIdentity("id:a", null)).toBe("id:a");
    expect(keepIdentity("name:a", "id:b")).toBe("id:b");
    expect(keepIdentity("name:a", "name:b")).toBe("name:b");
    expect(keepIdentity(null, "name:b")).toBe("name:b");
  });

  it("shortens identities for audit rows to the kind and 12 characters", () => {
    expect(shortIdentity(`id:${"a".repeat(64)}`)).toBe(`id:${"a".repeat(12)}`);
    expect(shortIdentity(`name:${"b".repeat(64)}`)).toBe(`name:${"b".repeat(12)}`);
    expect(shortIdentity("f".repeat(64))).toBe("f".repeat(12));
    expect(shortIdentity(null)).toBeNull();
  });
});

describe("reconnect safety (review G3)", () => {
  const conn = () =>
    db
      .prepare(
        "SELECT status, last_error, exact_identity, access_token_enc, refresh_token_enc FROM connections",
      )
      .first<{
        status: string;
        last_error: string | null;
        exact_identity: string | null;
        access_token_enc: string | null;
        refresh_token_enc: string | null;
      }>();
  const enabled = async () =>
    (
      await db
        .prepare("SELECT exact_division, sync_enabled FROM divisions ORDER BY exact_division")
        .all<{ exact_division: number; sync_enabled: number }>()
    ).results;
  const other = () =>
    Response.json(
      meBody({
        CurrentDivision: 999001,
        DivisionCustomer: "bbbbbbbb-1111-2222-3333-444444444444",
        DivisionCustomerName: "Other Company B.V.",
      }),
    );

  it("a company rename in Exact (no customer id) does not lock the admin out", async () => {
    stub.api = () => Response.json(meBody({ DivisionCustomer: null }));
    await callback(await start());
    const first = (await conn())?.exact_identity;
    expect(first).toMatch(/^name:/);
    stub.api = () =>
      Response.json(
        meBody({ DivisionCustomer: null, DivisionCustomerName: "Camelthorn Holding B.V." }),
      );
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?exact=connected");
    const after = await conn();
    expect(after?.status).toBe("active");
    expect(after?.exact_identity).toMatch(/^name:/);
    expect(after?.exact_identity).not.toBe(first);
  });

  it("a renamed company with a stable id keeps its id identity", async () => {
    await callback(await start());
    const first = (await conn())?.exact_identity;
    expect(first).toMatch(/^id:/);
    stub.api = () => Response.json(meBody({ DivisionCustomerName: "Renamed B.V." }));
    expect((await callback(await start())).headers.get("location")).toContain("exact=connected");
    stub.api = () => Response.json(meBody({ DivisionCustomer: null }));
    expect((await callback(await start())).headers.get("location")).toContain("exact=connected");
    expect((await conn())?.exact_identity).toBe(first);
  });

  it("after a refusal the original account reconnects and its divisions are as before", async () => {
    await callback(await start());
    await db
      .prepare(
        "INSERT INTO divisions (connection_id, exact_division, name, sync_enabled) SELECT id, 777, 'Second', 1 FROM connections",
      )
      .run();
    const identity = (await conn())?.exact_identity;
    stub.api = other;
    await callback(await start());
    expect(await conn()).toMatchObject({
      status: "disabled",
      access_token_enc: null,
      refresh_token_enc: null,
    });
    stub.api = () => Response.json(ME);
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?exact=connected");
    expect(await conn()).toMatchObject({
      status: "active",
      last_error: null,
      exact_identity: identity,
    });
    expect(await enabled()).toEqual([
      { exact_division: 777, sync_enabled: 1 },
      { exact_division: 123456, sync_enabled: 1 },
    ]);
  });

  it("while the new sign-in is unverified, its tokens serve GET /Me only", async () => {
    await callback(await start());
    let seen: { status?: string; division?: string } = {};
    stub.api = async (c) => {
      // While /Me runs, the connection is 'pending': a division call must be refused.
      const row = await db.prepare("SELECT status FROM connections").first<{ status: string }>();
      seen = { status: row?.status ?? "", division: c.url.pathname };
      const t = createGateTransport(env, 123456);
      const err = await t({
        division: 123456,
        api: "rest",
        method: "GET",
        path: "/crm/Accounts",
        priority: "user",
        jobId: "probe",
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExactAuthError);
      return other();
    };
    await callback(await start());
    expect(seen).toEqual({ status: "pending", division: "/api/v1/current/Me" });
    // Exactly one API call went out with the new tokens: /current/Me.
    expect(stub.apiCalls.map((c) => c.url.pathname)).toEqual([
      "/api/v1/current/Me",
      "/api/v1/current/Me",
    ]);
    expect((await conn())?.status).toBe("disabled");
  });

  it("fails closed when /current/Me cannot be read for a connection with history", async () => {
    await callback(await start());
    const before = await conn();
    stub.api = () => new Response("nope", { status: 500 });
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?exact=unverified");
    expect(await conn()).toMatchObject({
      status: "disabled",
      last_error: "account_unverified",
      access_token_enc: null,
      refresh_token_enc: null,
      exact_identity: before?.exact_identity,
    });
    expect(await enabled()).toEqual([{ exact_division: 123456, sync_enabled: 1 }]);
    expect(await auditActions("connection.exact_account_unverified")).toBe(1);
    // Retrying with /Me working connects again.
    stub.api = () => Response.json(ME);
    expect((await callback(await start())).headers.get("location")).toContain("exact=connected");
    expect((await conn())?.status).toBe("active");
  });

  it("never activates tokens another callback staged meanwhile", async () => {
    await callback(await start());
    stub.api = async () => {
      // A second flow staged its own tokens while this callback was verifying.
      await db.prepare("UPDATE connections SET refresh_token_enc = 'someone-else'").run();
      return Response.json(ME);
    };
    const connected = await auditActions("connection.exact_connected");
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?exact=error");
    expect(await conn()).toMatchObject({ status: "pending", refresh_token_enc: "someone-else" });
    expect(await auditActions("connection.exact_connected")).toBe(connected);
  });

  it("confirm_replace needs an admin with a recent sign-in", async () => {
    const stale = await addSession(adminId, { lastAuthAgoMs: 20 * 60 * 1000 });
    expect((await authed("/api/connections/exact/start?confirm_replace=1", stale)).status).toBe(
      401,
    );
    const fin = await addSession(await addUser("f@camelthorncapital.com", ["finance"]));
    expect((await authed("/api/connections/exact/start?confirm_replace=1", fin)).status).toBe(403);
  });

  it("a confirm_replace flow is single use", async () => {
    await callback(await start());
    stub.api = other;
    const s = await start(adminTok, "?confirm_replace=1");
    expect((await callback(s)).headers.get("location")).toContain("exact=connected");
    expect((await callback(s)).headers.get("location")).toContain("exact=denied");
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
