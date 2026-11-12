/**
 * /api/dq/notifications (ADR 0046): admin only, step-up, strict validation, optimistic revision,
 * audited, and the test message to the caller.
 */
import type { DqNotificationsResponse, DqNotificationsTestResponse } from "@camelthorn/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSession, addUser, authed, call, resetDb } from "./helpers";
import { resetDq } from "./dq-helpers";
import { emailLogWipeStatements } from "./outbox-wipe";
import { db, emailRows } from "./dq-notify-helpers";
import { auditRows } from "./sync-helpers";

type Role = "admin" | "finance" | "viewer" | "staleAdmin" | "outsideAdmin";
const tokens = {} as Record<Role, string>;

async function send<T = Record<string, unknown>>(
  role: Role,
  method: string,
  json?: unknown,
  path = "/api/dq/notifications",
) {
  const res = await authed(path, tokens[role], { method, ...(json !== undefined ? { json } : {}) });
  return { status: res.status, body: (await res.json()) as T };
}
const err = (r: { body: unknown }): unknown => (r.body as { error?: unknown }).error;
const PROVIDER = {
  emailProvider: "https",
  emailHost: "api.mail.example.com",
  emailFrom: "alerts@camelthorncapital.com",
};

beforeEach(async () => {
  await resetDb();
  await resetDq();
  tokens.admin = await addSession(await addUser("admin@camelthorncapital.com", ["admin"]));
  tokens.finance = await addSession(await addUser("fin@camelthorncapital.com", ["finance"]));
  tokens.viewer = await addSession(await addUser("viewer@camelthorncapital.com", ["viewer"]));
  tokens.staleAdmin = await addSession(await addUser("stale@camelthorncapital.com", ["admin"]), {
    lastAuthAgoMs: 20 * 60_000,
  });
  tokens.outsideAdmin = await addSession(await addUser("ext@example.com", ["admin"]));
});
afterEach(() => vi.restoreAllMocks());

describe("access", () => {
  it("needs a session and the admin role; changes need a fresh sign-in", async () => {
    expect((await call("/api/dq/notifications")).status).toBe(401);
    for (const role of ["finance", "viewer"] as const) {
      expect((await send(role, "GET")).status, role).toBe(403);
      expect((await send(role, "PATCH", { rev: null, enabled: false })).status, role).toBe(403);
      expect((await send(role, "POST", {}, "/api/dq/notifications/test")).status, role).toBe(403);
    }
    const r = await send("staleAdmin", "PATCH", { rev: null, enabled: false });
    expect(r.status).toBe(401);
    expect(err(r)).toBe("step_up_required");
    const t = await send("staleAdmin", "POST", {}, "/api/dq/notifications/test");
    expect(t.status).toBe(401);
  });
});

describe("GET", () => {
  it("returns the defaults, never the key, and the recipient count from the users table", async () => {
    const r = await send<DqNotificationsResponse>("admin", "GET");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      rev: null,
      apiKeyPresent: true,
      senderActive: false,
      allowedDomain: "camelthorncapital.com",
      // admin + finance on the allowed domain; the outside admin does not count
      recipientCount: 3,
      settings: {
        enabled: true,
        alertRecipients: "admin_finance",
        baseUrl: "",
        maxAlertsPerRun: 10,
        emailProvider: "disabled",
      },
    });
    expect(JSON.stringify(r.body)).not.toContain("test-email-api-key");
  });
});

describe("PATCH", () => {
  it("saves, audits and changes the revision", async () => {
    const r = await send<DqNotificationsResponse>("admin", "PATCH", {
      rev: null,
      maxAlertsPerRun: 4,
      baseUrl: "https://App.Example.com/",
      ...PROVIDER,
    });
    expect(r.status).toBe(200);
    expect(r.body.rev).toEqual(expect.any(String));
    expect(r.body.settings).toMatchObject({
      maxAlertsPerRun: 4,
      baseUrl: "https://app.example.com",
      emailProvider: "https",
    });
    expect(r.body.senderActive).toBe(true);
    const audit = await auditRows("dq.notifications_changed", "dq.notifications");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_email).toBe("admin@camelthorncapital.com");
    expect(audit[0]?.before_json).toContain('"maxAlertsPerRun":10');
    expect(audit[0]?.after_json).toContain('"maxAlertsPerRun":4');
    expect(audit[0]?.after_json).not.toContain("test-email-api-key");
    const again = await send<DqNotificationsResponse>("admin", "GET");
    expect(again.body.rev).toBe(r.body.rev);
  });

  it("a stale revision is refused and writes nothing", async () => {
    const first = await send<DqNotificationsResponse>("admin", "PATCH", {
      rev: null,
      maxAlertsPerRun: 3,
    });
    const before = (await auditRows("dq.notifications_changed")).length;
    const stale = await send("admin", "PATCH", { rev: null, maxAlertsPerRun: 5 });
    expect(stale.status).toBe(409);
    expect(err(stale)).toBe("conflict");
    const ok = await send("admin", "PATCH", { rev: first.body.rev, maxAlertsPerRun: 5 });
    expect(ok.status).toBe(200);
    expect((await auditRows("dq.notifications_changed")).length).toBe(before + 1);
  });

  it("a change that changes nothing writes nothing", async () => {
    const before = (await auditRows("dq.notifications_changed")).length;
    const r = await send<DqNotificationsResponse>("admin", "PATCH", {
      rev: null,
      maxAlertsPerRun: 10,
      enabled: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.rev).toBeNull();
    expect((await auditRows("dq.notifications_changed")).length).toBe(before);
  });

  it("is strict about every field", async () => {
    const audits = (await auditRows("dq.notifications_changed")).length;
    const bad: [Record<string, unknown>, string][] = [
      [{}, "nothing_to_change"],
      [{ extra: 1 }, "bad_request"],
      [{ enabled: "yes" }, "bad_enabled"],
      [{ alertRecipients: "all" }, "bad_recipients"],
      [{ baseUrl: "http://app.example.com" }, "bad_base_url"],
      [{ baseUrl: "https://app.example.com/x" }, "bad_base_url"],
      [{ baseUrl: 5 }, "bad_base_url"],
      [{ maxAlertsPerRun: 0 }, "bad_max_alerts"],
      [{ maxAlertsPerRun: 51 }, "bad_max_alerts"],
      [{ maxAlertsPerRun: "10" }, "bad_max_alerts"],
      [{ emailProvider: "smtp" }, "bad_provider"],
      [{ emailHost: "https://x.com" }, "bad_email_host"],
      [{ emailHost: "10.0.0.1" }, "bad_email_host"],
      [{ emailFrom: "Name <a@b.com>" }, "bad_email_from"],
    ];
    for (const [body, code] of bad) {
      const r = await send("admin", "PATCH", { rev: null, ...body });
      expect([r.status, err(r)], JSON.stringify(body)).toEqual([400, code]);
    }
    expect(err(await send("admin", "PATCH", { enabled: false }))).toBe("bad_rev");
    const inc = await send("admin", "PATCH", { rev: null, emailProvider: "https" });
    expect([inc.status, err(inc)]).toEqual([422, "provider_incomplete"]);
    expect(await auditRows("dq.notifications_changed")).toHaveLength(audits);
  });
});

describe("test message", () => {
  const fetchOk = () =>
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ id: "prov-test" }), { status: 200 })),
      );

  it("without a provider nothing is sent", async () => {
    const spy = fetchOk();
    const r = await send<DqNotificationsTestResponse>(
      "admin",
      "POST",
      {},
      "/api/dq/notifications/test",
    );
    expect(r.body).toEqual({ status: "skipped_not_configured", code: null });
    expect(spy).not.toHaveBeenCalled();
    expect(await emailRows()).toEqual([]);
  });

  it("sends one message to the caller only, logs it, and allows one per minute", async () => {
    await send("admin", "PATCH", { rev: null, ...PROVIDER });
    const spy = fetchOk();
    const r = await send<DqNotificationsTestResponse>(
      "admin",
      "POST",
      {},
      "/api/dq/notifications/test",
    );
    expect(r.body).toEqual({ status: "sent", code: null });
    expect(spy).toHaveBeenCalledTimes(1);
    const call0 = spy.mock.calls[0]!;
    expect(String(call0[0])).toBe("https://api.mail.example.com/emails");
    const body = JSON.parse(String((call0[1] as RequestInit).body)) as { to: string[] };
    expect(body.to).toEqual(["admin@camelthorncapital.com"]);
    const rows = await emailRows();
    expect(rows).toMatchObject([
      { kind: "test", status: "sent", recipients_count: 1, provider_message_id: "prov-test" },
    ]);
    const again = await send("admin", "POST", {}, "/api/dq/notifications/test");
    expect([again.status, err(again)]).toEqual([409, "too_soon"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("the limit is one per 60 seconds, not one per clock minute, and per caller", async () => {
    await send("admin", "PATCH", { rev: null, ...PROVIDER });
    const spy = fetchOk();
    const me = await db
      .prepare("SELECT id FROM users WHERE email = 'admin@camelthorncapital.com'")
      .first<{ id: number }>();
    // A test sent 20 seconds ago in the PREVIOUS minute bucket (12:00:59 then 12:01:00).
    const t = Date.now() - 20_000;
    await db
      .prepare(
        `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, created_at, updated_at)
         VALUES (?1, 'test', 'dq.test.v1', 1, 'sent', ?2, ?2)`,
      )
      .bind(`dq-test:${me!.id}:${Math.floor(t / 60_000) - 1}`, new Date(t).toISOString())
      .run();
    const r = await send("admin", "POST", {}, "/api/dq/notifications/test");
    expect([r.status, err(r)]).toEqual([409, "too_soon"]);
    expect(spy).not.toHaveBeenCalled();
    // Another user's recent test does not block this one; a caller with a similar id prefix neither.
    await db.batch(await emailLogWipeStatements(db));
    await db
      .prepare(
        `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, created_at, updated_at)
         VALUES (?1, 'test', 'dq.test.v1', 1, 'sent', ?2, ?2)`,
      )
      .bind(`dq-test:${me!.id}0:${Math.floor(t / 60_000)}`, new Date(t).toISOString())
      .run();
    const ok = await send<DqNotificationsTestResponse>(
      "admin",
      "POST",
      {},
      "/api/dq/notifications/test",
    );
    expect(ok.body).toEqual({ status: "sent", code: null });
  });

  it("two concurrent test requests send one message", async () => {
    await send("admin", "PATCH", { rev: null, ...PROVIDER });
    const spy = fetchOk();
    const rs = await Promise.all([
      send("admin", "POST", {}, "/api/dq/notifications/test"),
      send("admin", "POST", {}, "/api/dq/notifications/test"),
      send("admin", "POST", {}, "/api/dq/notifications/test"),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("an admin outside the allowed domain gets no test message", async () => {
    await send("admin", "PATCH", { rev: null, ...PROVIDER });
    const spy = fetchOk();
    const r = await send("outsideAdmin", "POST", {}, "/api/dq/notifications/test");
    expect([r.status, err(r)]).toEqual([422, "not_an_allowed_recipient"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a refusal by the provider as a code, not as text", async () => {
    await send("admin", "PATCH", { rev: null, ...PROVIDER });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("secret provider text", { status: 403 })),
    );
    const r = await send<DqNotificationsTestResponse>(
      "admin",
      "POST",
      {},
      "/api/dq/notifications/test",
    );
    expect(r.body).toEqual({ status: "failed", code: "http_403" });
    expect(JSON.stringify(r.body)).not.toContain("secret");
    expect(db).toBeDefined();
  });
});
