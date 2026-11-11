import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cookieFrom,
  addSession,
  addUser,
  authed,
  call,
  db,
  resetDb,
  setCookies,
  ORIGIN,
} from "./helpers";
import worker from "../src/index";
import { loadWebhookSecrets, saveWebhookSecret } from "../src/revolut/store";
import { loadRevolutConfig } from "../src/revolut/config";
import { authorizeUrl } from "../src/revolut/oauth";
import {
  auditActions,
  resetRevolut,
  rotatedOk,
  seedRevolut,
  storedRevolut,
  stubRevolut,
  type RevolutStub,
} from "./revolut-helpers";

const ADMIN = "gerrie.grobbelaar@camelthorncapital.com";
const FLOW = "__Host-revolut-oauth";
const Q = "?environment=production&creates_bank_entries=0&payments_mode=drafts";
const WEBHOOK = "123e4567-e89b-12d3-a456-426614174000";

let adminTok: string;
let adminId: number;
let stub: RevolutStub;

beforeEach(async () => {
  await resetDb();
  await resetRevolut();
  adminId = await addUser(ADMIN, ["admin"]);
  adminTok = await addSession(adminId);
  stub = stubRevolut();
  stub.token = (_f, n) => rotatedOk(n + 100);
  stub.api = () => Response.json([{ id: "acc-1", name: "Main", currency: "EUR", balance: 100 }]);
});
afterEach(() => stub.restore());

interface Started {
  state: string;
  flowCookie: string;
  location: URL;
}

async function start(token = adminTok, query = Q): Promise<Started> {
  const res = await authed(`/api/connections/revolut/start${query}`, token);
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
  call(`/api/connections/revolut/callback?${query}&state=${encodeURIComponent(s.state)}`, {
    headers: {
      cookie: `__Host-session=${token}${s.flowCookie ? `; ${FLOW}=${s.flowCookie}` : ""}`,
    },
  });

const row = () =>
  db
    .prepare("SELECT * FROM connections WHERE kind = 'revolut'")
    .first<Record<string, string | number | null>>();

describe("GET /api/connections/revolut/start", () => {
  it("redirects an admin with fresh step-up to the consent page with the right parameters", async () => {
    const s = await start();
    expect(s.location.origin + s.location.pathname).toBe(
      "https://business.revolut.com/app-confirm",
    );
    expect(Object.fromEntries(s.location.searchParams)).toMatchObject({
      client_id: "test-revolut-client-id",
      redirect_uri: "https://app.test/api/connections/revolut/callback",
      response_type: "code",
    });
    expect(s.state.length).toBeGreaterThanOrEqual(40);
    expect(s.flowCookie).not.toBe("");
    const header = setCookies(await authed(`/api/connections/revolut/start${Q}`, adminTok)).find(
      (c) => c.startsWith(FLOW),
    );
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/Secure/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(s.location.href).not.toMatch(/PRIVATE KEY|client_assertion/);
  });

  it("uses the sandbox consent page for the sandbox environment", async () => {
    const s = await start(adminTok, "?environment=sandbox&creates_bank_entries=1");
    expect(s.location.host).toBe("sandbox-business.revolut.com");
  });

  it("REQUIRES an explicit creates_bank_entries (no default)", async () => {
    for (const q of [
      "?environment=production",
      "?environment=production&creates_bank_entries=",
      "?environment=production&creates_bank_entries=2",
      "?environment=production&creates_bank_entries=true",
      "?environment=production&creates_bank_entries=yes&payments_mode=drafts",
    ]) {
      const res = await authed(`/api/connections/revolut/start${q}`, adminTok);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: "creates_bank_entries_required" });
    }
    expect(await row()).toBeNull();
  });

  it("validates environment and payments mode", async () => {
    const env1 = await authed(
      "/api/connections/revolut/start?environment=live&creates_bank_entries=0",
      adminTok,
    );
    expect(env1.status).toBe(400);
    expect(await env1.json()).toEqual({ error: "invalid_environment" });
    expect(
      (await authed("/api/connections/revolut/start?creates_bank_entries=0", adminTok)).status,
    ).toBe(400);
    const mode = await authed(
      "/api/connections/revolut/start?environment=production&creates_bank_entries=0&payments_mode=auto",
      adminTok,
    );
    expect(mode.status).toBe(400);
    expect(await mode.json()).toEqual({ error: "invalid_payments_mode" });
  });

  it("requires a recent Google sign-in (step-up)", async () => {
    const stale = await addSession(adminId, { lastAuthAgoMs: 20 * 60 * 1000 });
    const res = await authed(`/api/connections/revolut/start${Q}`, stale);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "step_up_required" });
  });

  it.each(["finance", "approver", "viewer"] as const)("is forbidden for %s", async (role) => {
    const id = await addUser(`${role}@camelthorncapital.com`, [role]);
    const res = await authed(`/api/connections/revolut/start${Q}`, await addSession(id));
    expect(res.status).toBe(403);
  });

  it("needs a session", async () => {
    expect((await call(`/api/connections/revolut/start${Q}`)).status).toBe(401);
  });

  it("answers 500 server_misconfigured while the Revolut settings are incomplete", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/connections/revolut/start${Q}`, {
        headers: { cookie: `__Host-session=${adminTok}`, "x-requested-with": "fetch" },
      }),
      { ...env, REVOLUT_CLIENT_ID: "" },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
    expect(err.mock.calls.flat().join(" ")).toContain("REVOLUT_CLIENT_ID");
    expect(err.mock.calls.flat().join(" ")).not.toContain("PRIVATE KEY");
    err.mockRestore();
  });

  it("refuses to switch environment while a connection exists", async () => {
    await seedRevolut({ environment: "production" });
    const res = await authed(
      "/api/connections/revolut/start?environment=sandbox&creates_bank_entries=0",
      adminTok,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "environment_change_requires_disconnect" });
    // Same environment (re-authorise) is fine.
    expect((await authed(`/api/connections/revolut/start${Q}`, adminTok)).status).toBe(302);
  });
});

describe("GET /api/connections/revolut/callback", () => {
  it("stores encrypted tokens, proves them with GET /accounts through the gate and audits", async () => {
    const s = await start(
      adminTok,
      "?environment=production&creates_bank_entries=1&payments_mode=pay",
    );
    const res = await callback(s);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings/connections?revolut=connected");

    const form = stub.tokenCalls[0];
    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("code")).toBe("the-code");
    expect(form?.get("client_id")).toBe("test-revolut-client-id");
    expect(form?.get("client_assertion")?.split(".")).toHaveLength(3);
    expect(form?.has("client_secret")).toBe(false);

    const r = await row();
    expect(r).toMatchObject({
      status: "active",
      connected_by: ADMIN,
      revolut_environment: "production",
      creates_bank_entries: 1,
      payments_mode: "pay",
      last_error: null,
    });
    expect(r?.["bank_entries_decided_at"]).toBeTruthy();
    // Ciphertext only, bound to this connection.
    expect(JSON.stringify(r)).not.toMatch(/racc-|rref-|the-code/);
    expect(await storedRevolut(r?.["id"] as number)).toMatchObject({
      access: "racc-101",
      refresh: "rref-101",
    });
    const expiry = Date.parse(String(r?.["expires_at"])) - Date.now();
    expect(expiry).toBeGreaterThan(2390_000);
    expect(expiry).toBeLessThanOrEqual(2400_000);

    expect(stub.apiCalls).toHaveLength(1);
    expect(stub.apiCalls[0]?.url.pathname).toBe("/api/1.0/accounts");
    expect(stub.apiCalls[0]?.headers.authorization).toBe("Bearer racc-101");

    const audit = await db
      .prepare(
        "SELECT actor_email, action, before_json, after_json FROM audit_log WHERE action LIKE 'connection.revolut_%' ORDER BY id",
      )
      .all<{ actor_email: string; action: string; after_json: string }>();
    expect(audit.results.map((a) => a.action)).toEqual([
      "connection.revolut_authorized",
      "connection.revolut_connected",
    ]);
    expect(audit.results.every((a) => a.actor_email === ADMIN)).toBe(true);
    expect(audit.results[0]?.after_json).toMatch(/"createsBankEntries":true/);
    expect(JSON.stringify(audit.results)).not.toMatch(/racc-|rref-|the-code|PRIVATE KEY|eyJ/);
  });

  it("stores the explicit creates_bank_entries = 0 and the sandbox environment", async () => {
    stub.hosts = new Set(["sandbox-b2b.revolut.com"]);
    const s = await start(adminTok, "?environment=sandbox&creates_bank_entries=0");
    expect((await callback(s)).headers.get("location")).toContain("revolut=connected");
    expect(await row()).toMatchObject({
      status: "active",
      revolut_environment: "sandbox",
      creates_bank_entries: 0,
      payments_mode: "drafts",
    });
    expect(stub.apiCalls[0]?.url.host).toBe("sandbox-b2b.revolut.com");
  });

  it("is single use: replaying the same callback does nothing", async () => {
    const s = await start();
    expect((await callback(s)).headers.get("location")).toContain("revolut=connected");
    stub.tokenCalls.length = 0;
    const again = await callback(s);
    expect(again.headers.get("location")).toBe("/settings/connections?revolut=denied");
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("rejects a wrong or missing state and a missing or tampered flow cookie (CSRF)", async () => {
    const s = await start();
    for (const bad of [
      callback({ ...s, state: "forged" }),
      callback({ ...s, state: "" }),
      callback({ ...s, flowCookie: "" }),
      callback({ ...s, flowCookie: `${s.flowCookie}x` }),
      callback({ ...s, flowCookie: s.flowCookie.replace(/^./, (c) => (c === "A" ? "B" : "A")) }),
    ]) {
      expect((await bad).headers.get("location")).toBe("/settings/connections?revolut=denied");
    }
    expect(stub.tokenCalls).toHaveLength(0);
    expect(await row()).toBeNull();
  });

  it("does not accept the Exact flow cookie or a state from another flow", async () => {
    const s = await start();
    const res = await call(
      `/api/connections/revolut/callback?code=c&state=${encodeURIComponent(s.state)}`,
      { headers: { cookie: `__Host-session=${adminTok}; __Host-exact-oauth=${s.flowCookie}` } },
    );
    expect(res.headers.get("location")).toBe("/settings/connections?revolut=denied");
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("rejects a callback from a different admin than the one who started the flow", async () => {
    const s = await start();
    const other = await addSession(await addUser("second@camelthorncapital.com", ["admin"]));
    const res = await callback(s, other);
    expect(res.headers.get("location")).toBe("/settings/connections?revolut=denied");
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("is admin only and needs a session", async () => {
    const s = await start();
    const viewer = await addSession(await addUser("v@camelthorncapital.com", ["viewer"]));
    expect((await callback(s, viewer)).status).toBe(403);
    const anon = await call(`/api/connections/revolut/callback?code=c&state=${s.state}`, {
      headers: { cookie: `${FLOW}=${s.flowCookie}` },
    });
    expect(anon.status).toBe(401);
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("denies when Revolut reports an error or sends no code", async () => {
    for (const query of ["error=access_denied", ""]) {
      const s = await start();
      expect((await callback(s, adminTok, query)).headers.get("location")).toBe(
        "/settings/connections?revolut=denied",
      );
    }
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("reports an error and stores nothing when the code exchange fails", async () => {
    stub.token = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const audited = await auditActions("connection.revolut_connected");
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?revolut=error");
    expect(await row()).toBeNull();
    expect(await auditActions("connection.revolut_connected")).toBe(audited);
  });

  it("an exchange answer without a refresh token is an error (the connection could not last)", async () => {
    stub.token = () => Response.json({ access_token: "x", token_type: "bearer", expires_in: 2400 });
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?revolut=error");
    expect(await row()).toBeNull();
  });

  it("removes the sign-in again when GET /accounts fails (credentials not proven)", async () => {
    stub.api = () => new Response("nope", { status: 500 });
    const failedBefore = await auditActions("connection.revolut_verification_failed");
    const connectedBefore = await auditActions("connection.revolut_connected");
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?revolut=unverified");
    const r = await row();
    expect(r).toMatchObject({
      status: "disabled",
      last_error: "verification_failed",
      access_token_enc: null,
      refresh_token_enc: null,
    });
    expect(await auditActions("connection.revolut_verification_failed")).toBe(failedBefore + 1);
    expect(await auditActions("connection.revolut_connected")).toBe(connectedBefore);
  });

  it("removes the sign-in when GET /accounts answers something that is not an account list", async () => {
    stub.api = () => Response.json({ not: "a list" });
    const res = await callback(await start());
    expect(res.headers.get("location")).toBe("/settings/connections?revolut=unverified");
    expect((await row())?.["status"]).toBe("disabled");
  });

  it("clears the flow cookie on every outcome", async () => {
    const res = await callback(await start());
    expect(setCookies(res).some((c) => c.startsWith(`${FLOW}=;`) && c.includes("Max-Age=0"))).toBe(
      true,
    );
  });

  it("re-authorising replaces the tokens of the existing connection and records the new choice", async () => {
    const id = await seedRevolut({
      status: "needs_reauth",
      access: "old",
      refresh: "old",
      createsBankEntries: false,
    });
    await callback(await start(adminTok, "?environment=production&creates_bank_entries=1"));
    const rows = await db
      .prepare("SELECT id, status, creates_bank_entries FROM connections WHERE kind = 'revolut'")
      .all<{ id: number; status: string; creates_bank_entries: number }>();
    expect(rows.results).toEqual([{ id, status: "active", creates_bank_entries: 1 }]);
    expect(await storedRevolut(id)).toMatchObject({ access: "racc-101", refresh: "rref-101" });
    const audit = await db
      .prepare(
        "SELECT before_json FROM audit_log WHERE action = 'connection.revolut_authorized' ORDER BY id DESC",
      )
      .first<{ before_json: string }>();
    expect(audit?.before_json).toContain('"createsBankEntries":false');
  });
});

describe("POST /api/connections/revolut/disconnect", () => {
  const post = (token = adminTok) =>
    authed("/api/connections/revolut/disconnect", token, { method: "POST" });

  it("wipes the tokens and the webhook secrets, deletes the subscription and audits", async () => {
    const id = await seedRevolut({ webhookId: WEBHOOK });
    await saveWebhookSecret(env, id, WEBHOOK, "wsec-ONE", ADMIN);
    stub.api = () => new Response(null, { status: 204 });
    const before = await auditActions("connection.revolut_disconnected");
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: true });
    expect(await storedRevolut(id)).toMatchObject({
      status: "disabled",
      access: null,
      refresh: null,
    });
    const r = await db
      .prepare(
        "SELECT token_ref, expires_at, webhook_id, webhook_secret_enc, webhook_secret_prev_enc FROM connections WHERE id = ?1",
      )
      .bind(id)
      .first();
    expect(r).toEqual({
      token_ref: null,
      expires_at: null,
      webhook_id: null,
      webhook_secret_enc: null,
      webhook_secret_prev_enc: null,
    });
    expect(stub.apiCalls).toHaveLength(1);
    expect(stub.apiCalls[0]).toMatchObject({ method: "DELETE" });
    expect(stub.apiCalls[0]?.url.pathname).toBe(`/api/2.0/webhooks/${WEBHOOK}`);
    expect(await auditActions("connection.revolut_disconnected")).toBe(before + 1);
    const a = await db
      .prepare(
        "SELECT after_json FROM audit_log WHERE action = 'connection.revolut_disconnected' ORDER BY id DESC",
      )
      .first<{ after_json: string }>();
    expect(a?.after_json).toContain('"webhookRemoved":true');
  });

  it("still disconnects when the webhook cannot be deleted, and says so in the audit row", async () => {
    const id = await seedRevolut({ webhookId: WEBHOOK });
    stub.api = () => new Response("boom", { status: 500 });
    expect((await post()).status).toBe(200);
    expect((await storedRevolut(id)).status).toBe("disabled");
    const a = await db
      .prepare(
        "SELECT after_json FROM audit_log WHERE action = 'connection.revolut_disconnected' ORDER BY id DESC",
      )
      .first<{ after_json: string }>();
    expect(a?.after_json).toContain('"webhookRemoved":false');
  });

  it("skips the webhook call for a connection that needs re-authorisation", async () => {
    await seedRevolut({ status: "needs_reauth", webhookId: WEBHOOK });
    expect((await post()).status).toBe(200);
    expect(stub.apiCalls).toHaveLength(0);
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("is idempotent: a second disconnect is 200, changes nothing and writes no audit row", async () => {
    await seedRevolut();
    expect(await (await post()).json()).toEqual({ ok: true, changed: true });
    const n = await auditActions("connection.revolut_disconnected");
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: false });
    expect(await auditActions("connection.revolut_disconnected")).toBe(n);
  });

  it("is a no-op without any connection row", async () => {
    const n = await auditActions("connection.revolut_disconnected");
    expect(await (await post()).json()).toEqual({ ok: true, changed: false });
    expect(await auditActions("connection.revolut_disconnected")).toBe(n);
  });

  it("needs admin and a fresh sign-in", async () => {
    await seedRevolut();
    const stale = await addSession(adminId, { lastAuthAgoMs: 20 * 60 * 1000 });
    const res = await post(stale);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "step_up_required" });
    const fin = await addSession(await addUser("f@camelthorncapital.com", ["finance"]));
    expect((await post(fin)).status).toBe(403);
    expect(
      (
        await call("/api/connections/revolut/disconnect", {
          method: "POST",
          headers: { "x-requested-with": "fetch" },
        })
      ).status,
    ).toBe(401);
    expect((await row())?.["status"]).toBe("active");
  });

  it("the CSRF header is required", async () => {
    await seedRevolut();
    const res = await call("/api/connections/revolut/disconnect", {
      method: "POST",
      headers: { cookie: `__Host-session=${adminTok}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/connections/revolut/settings", () => {
  const patch = (json: unknown, token = adminTok) =>
    authed("/api/connections/revolut/settings", token, { method: "PATCH", json });

  it("changes creates_bank_entries and payments_mode, with step-up, and audits before and after", async () => {
    const id = await seedRevolut({ createsBankEntries: false, paymentsMode: "drafts" });
    const res = await patch({ createsBankEntries: true, paymentsMode: "pay" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      changed: true,
      createsBankEntries: true,
      paymentsMode: "pay",
    });
    expect(await row()).toMatchObject({ id, creates_bank_entries: 1, payments_mode: "pay" });
    const a = await db
      .prepare(
        "SELECT actor_email, before_json, after_json FROM audit_log WHERE action = 'connection.revolut_settings_changed' ORDER BY id DESC",
      )
      .first<{ actor_email: string; before_json: string; after_json: string }>();
    expect(a?.actor_email).toBe(ADMIN);
    expect(a?.before_json).toContain('"createsBankEntries":false');
    expect(a?.after_json).toContain('"createsBankEntries":true');
    expect(a?.after_json).toContain('"paymentsMode":"pay"');
  });

  it("needs a fresh sign-in when a value changes, but not for a no-op", async () => {
    await seedRevolut({ createsBankEntries: false });
    const changedBefore = await auditActions("connection.revolut_settings_changed");
    const stale = await addSession(adminId, { lastAuthAgoMs: 20 * 60 * 1000 });
    const res = await patch({ createsBankEntries: true }, stale);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "step_up_required" });
    expect((await row())?.["creates_bank_entries"]).toBe(0);
    const same = await patch({ createsBankEntries: false, paymentsMode: "drafts" }, stale);
    expect(await same.json()).toEqual({ ok: true, changed: false });
    expect(await auditActions("connection.revolut_settings_changed")).toBe(changedBefore);
  });

  it("is admin only", async () => {
    await seedRevolut();
    for (const role of ["finance", "approver", "viewer"] as const) {
      const t = await addSession(await addUser(`${role}@camelthorncapital.com`, [role]));
      expect((await patch({ paymentsMode: "pay" }, t)).status).toBe(403);
    }
    expect((await row())?.["payments_mode"]).toBe("drafts");
  });

  it("validates the body strictly", async () => {
    await seedRevolut();
    for (const body of [
      {},
      { createsBankEntries: "yes" },
      { createsBankEntries: 1 },
      { other: 1 },
      [],
      null,
    ]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
    }
    const bad = await patch({ paymentsMode: "auto" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_payments_mode" });
  });

  it("404s without a live connection", async () => {
    expect((await patch({ paymentsMode: "pay" })).status).toBe(404);
    await seedRevolut({ status: "disabled" });
    expect((await patch({ paymentsMode: "pay" })).status).toBe(404);
  });

  it("works for a connection that needs re-authorisation", async () => {
    await seedRevolut({ status: "needs_reauth" });
    expect((await patch({ paymentsMode: "pay" })).status).toBe(200);
  });
});

describe("GET /api/connections (Revolut part)", () => {
  it("reports status, environment and the two settings and never a secret", async () => {
    const id = await seedRevolut({
      createsBankEntries: true,
      paymentsMode: "pay",
      environment: "sandbox",
    });
    await saveWebhookSecret(env, id, WEBHOOK, "wsec-TOP-SECRET", ADMIN);
    const viewer = await addSession(await addUser("v@camelthorncapital.com", ["viewer"]));
    const res = await authed("/api/connections", viewer);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/racc-|rref-|wsec|PRIVATE KEY|v1\./);
    const body = JSON.parse(text) as {
      revolutConfigured: boolean;
      connections: { kind: string; status: string; revolut?: unknown }[];
    };
    expect(body.revolutConfigured).toBe(true);
    expect(body.connections.find((c) => c.kind === "revolut")).toMatchObject({
      status: "active",
      revolut: { environment: "sandbox", createsBankEntries: true, paymentsMode: "pay" },
    });
  });

  it("reports an undecided bank-entries choice as null, and Revolut as not configured when settings are missing", async () => {
    const id = await seedRevolut();
    await db
      .prepare("UPDATE connections SET bank_entries_decided_at = NULL WHERE id = ?1")
      .bind(id)
      .run();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/connections`, {
        headers: { cookie: `__Host-session=${adminTok}` },
      }),
      { ...env, REVOLUT_PRIVATE_KEY: "" },
    );
    const body = (await res.json()) as {
      revolutConfigured: boolean;
      connections: { kind: string; revolut?: { createsBankEntries: unknown } }[];
    };
    expect(body.revolutConfigured).toBe(false);
    expect(
      body.connections.find((c) => c.kind === "revolut")?.revolut?.createsBankEntries,
    ).toBeNull();
  });
});

describe("webhook secrets at rest", () => {
  it("are encrypted, bound to the connection and column, and rotate with an overlap", async () => {
    const id = await seedRevolut();
    await saveWebhookSecret(env, id, WEBHOOK, "wsec-ONE", ADMIN);
    const raw = await db
      .prepare(
        "SELECT webhook_id, webhook_secret_enc, webhook_secret_prev_enc FROM connections WHERE id = ?1",
      )
      .bind(id)
      .first<{
        webhook_id: string;
        webhook_secret_enc: string;
        webhook_secret_prev_enc: string | null;
      }>();
    expect(raw?.webhook_id).toBe(WEBHOOK);
    expect(raw?.webhook_secret_enc.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("wsec-ONE");
    expect(raw?.webhook_secret_prev_enc).toBeNull();
    expect(await loadWebhookSecrets(env, id)).toEqual(["wsec-ONE"]);

    await saveWebhookSecret(env, id, WEBHOOK, "wsec-TWO", ADMIN);
    expect(await loadWebhookSecrets(env, id)).toEqual(["wsec-TWO", "wsec-ONE"]);

    // A blob moved to another column does not decrypt (AAD binding).
    await db
      .prepare("UPDATE connections SET webhook_secret_prev_enc = webhook_secret_enc WHERE id = ?1")
      .bind(id)
      .run();
    await expect(loadWebhookSecrets(env, id)).rejects.toThrow();
    const audit = await db
      .prepare(
        "SELECT after_json FROM audit_log WHERE action = 'connection.revolut_webhook_secret_saved' ORDER BY id DESC LIMIT 2",
      )
      .all<{ after_json: string }>();
    expect(JSON.stringify(audit.results)).not.toContain("wsec");
  });
});

describe("configuration and consent URL", () => {
  const base = {
    REVOLUT_CLIENT_ID: "cid",
    REVOLUT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    REVOLUT_ISSUER: "app.test",
    REVOLUT_REDIRECT_URI: "https://app.test/api/connections/revolut/callback",
    TOKEN_ENC_KEY: env.TOKEN_ENC_KEY,
  };
  it("reports names of missing settings only", () => {
    expect(loadRevolutConfig(base, "https://app.test")).toMatchObject({ ok: true });
    const miss = (over: Record<string, string>) => {
      const r = loadRevolutConfig({ ...base, ...over }, "https://app.test");
      return r.ok ? [] : r.missing;
    };
    expect(miss({ REVOLUT_CLIENT_ID: "" })).toEqual(["REVOLUT_CLIENT_ID"]);
    expect(miss({ REVOLUT_PRIVATE_KEY: "" })).toEqual(["REVOLUT_PRIVATE_KEY"]);
    expect(miss({ REVOLUT_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nx" })).toEqual([
      "REVOLUT_PRIVATE_KEY(pkcs8)",
    ]);
    expect(miss({ REVOLUT_ISSUER: "other.test" })).toEqual(["REVOLUT_ISSUER(host)"]);
    expect(
      miss({ REVOLUT_REDIRECT_URI: "https://evil.test/api/connections/revolut/callback" }),
    ).toEqual(["REVOLUT_REDIRECT_URI(origin/path)"]);
    expect(miss({ REVOLUT_REDIRECT_URI: "https://app.test/other" })).toEqual([
      "REVOLUT_REDIRECT_URI(origin/path)",
    ]);
    expect(miss({ TOKEN_ENC_KEY: "short" })).toEqual(["TOKEN_ENC_KEY"]);
    const r = loadRevolutConfig({ ...base, REVOLUT_CLIENT_ID: "" }, "https://app.test");
    expect(JSON.stringify(r)).not.toContain("PRIVATE KEY");
  });

  it("the consent URL stays on the two known consent hosts", () => {
    const cfg = { clientId: "cid", redirectUri: base.REVOLUT_REDIRECT_URI };
    expect(new URL(authorizeUrl("production", cfg, "s")).host).toBe("business.revolut.com");
    expect(new URL(authorizeUrl("sandbox", cfg, "s")).host).toBe("sandbox-business.revolut.com");
  });
});
