/**
 * The webhook subscription lifecycle and the post-confirmation hooks (task R3a, ADR 0032):
 * creation on confirm, "Register webhook", recovery from a lost creation response, replacement
 * (rotation), failure surfacing, secrets never stored or logged from list responses, and the
 * initial 90-day backfill enqueued by the confirmation.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { seedDefaultJobs } from "../src/jobs/defaults";
import { handleQueue } from "../src/jobs/runner";
import type { QueueMessage } from "../src/jobs/types";
import { registerWebhook } from "../src/revolut/webhooks";
import { loadRevolutConnection, loadWebhookSecretSet } from "../src/revolut/store";
import { ORIGIN, addSession, addUser, db, resetDb } from "./helpers";
import { resetRevolut, seedRevolut, stubRevolut, type RevolutStub } from "./revolut-helpers";
import {
  ACC_EUR,
  ADMIN,
  envWithQueue,
  EventQueue,
  fakeRevolut,
  rowsOf,
  simpleTx,
  storeWebhookSecret,
  WEBHOOK_ID,
  WEBHOOK_SECRET,
  type FakeRevolut,
} from "./revolut-r3-helpers";

let connId: number;
let stub: RevolutStub;
let api: FakeRevolut;
let queue: EventQueue;
let adminTok: string;

const OTHER_ID = "223e4567-e89b-12d3-a456-426614174999";
const NEW_ID = "323e4567-e89b-12d3-a456-426614174111";
const OUR_URL = "https://app.test/api/webhooks/revolut";

beforeEach(async () => {
  await resetDb();
  await resetRevolut();
  adminTok = await addSession(await addUser(ADMIN, ["admin"]));
  stub = stubRevolut();
  api = fakeRevolut();
  stub.api = api.handle;
  queue = new EventQueue();
  await db.batch([db.prepare("DELETE FROM job_runs"), db.prepare("DELETE FROM jobs")]);
  await seedDefaultJobs(db);
});
afterEach(() => stub.restore());

const post = (path: string, token: string, json?: unknown, e = envWithQueue(queue)) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        cookie: `__Host-session=${token}`,
        "x-requested-with": "fetch",
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    }),
    e,
  );

const hooks = () => stub.apiCalls.filter((c) => c.url.pathname.startsWith("/api/2.0/webhooks"));
const registerRoute = (json: unknown = {}, token = adminTok) =>
  post("/api/connections/revolut/webhook/register", token, json);
const conn = async () =>
  (await loadRevolutConnection(db)) as NonNullable<
    Awaited<ReturnType<typeof loadRevolutConnection>>
  >;
const lastError = async () =>
  (
    await db
      .prepare("SELECT last_error FROM connections WHERE id = ?1")
      .bind(connId)
      .first<{ last_error: string | null }>()
  )?.last_error;

describe("register webhook", () => {
  beforeEach(async () => {
    connId = await seedRevolut({ status: "active" });
  });

  it("creates the subscription for this app's URL and stores the secret encrypted", async () => {
    const res = await registerRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "registered" });
    const create = hooks().find((c) => c.method === "POST");
    expect(JSON.parse(create?.body ?? "{}")).toEqual({
      url: OUR_URL,
      events: ["TransactionCreated", "TransactionStateChanged"],
    });
    expect(await loadWebhookSecretSet(env, connId)).toEqual({
      current: WEBHOOK_SECRET,
      previous: null,
    });
    const row = await db
      .prepare("SELECT webhook_id, webhook_secret_enc FROM connections WHERE id = ?1")
      .bind(connId)
      .first<{ webhook_id: string; webhook_secret_enc: string }>();
    expect(row?.webhook_id).toBe(WEBHOOK_ID);
    expect(row?.webhook_secret_enc).not.toContain(WEBHOOK_SECRET);
    expect(await lastError()).toBeNull();
  });

  it("never lets the secret reach the response, the audit log or the console", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const savedCount = async () =>
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'connection.revolut_webhook_secret_saved'",
          )
          .first<{ n: number }>()
      )?.n ?? 0;
    const before = await savedCount();
    const res = await registerRoute();
    const body = await res.text();
    const text = spies
      .flatMap((s) => s.mock.calls.flat())
      .map(String)
      .join("\n");
    spies.forEach((s) => s.mockRestore());
    const audit = JSON.stringify(
      (await db.prepare("SELECT before_json, after_json FROM audit_log").all()).results,
    );
    for (const hay of [body, text, audit]) {
      expect(hay).not.toContain(WEBHOOK_SECRET);
      expect(hay).not.toContain("wsk_");
    }
    expect(await savedCount()).toBe(before + 1);
  });

  it("is a no-op when already registered", async () => {
    await registerRoute();
    stub.apiCalls.length = 0;
    const res = await registerRoute();
    expect(await res.json()).toEqual({ ok: true, status: "already_registered" });
    expect(stub.apiCalls).toEqual([]);
  });

  it("needs an admin with a fresh sign-in, a strict body and an active connection", async () => {
    const viewer = await addSession(await addUser("v@camelthorncapital.com", ["viewer"]));
    expect((await registerRoute({}, viewer)).status).toBe(403);
    const stale = await addSession(await addUser("a2@camelthorncapital.com", ["admin"]), {
      lastAuthAgoMs: 60 * 60_000,
    });
    expect((await registerRoute({}, stale)).status).toBe(401);
    expect((await registerRoute({ replace: "yes" })).status).toBe(400);
    expect((await registerRoute({ other: 1 })).status).toBe(400);
    await db.prepare("UPDATE connections SET status = 'needs_reauth'").run();
    expect((await registerRoute()).status).toBe(409);
    const anon = await worker.fetch(
      new Request(`${ORIGIN}/api/connections/revolut/webhook/register`, {
        method: "POST",
        headers: { "x-requested-with": "fetch" },
      }),
      envWithQueue(queue),
    );
    expect(anon.status).toBe(401);
    expect(hooks()).toEqual([]);
  });

  it("a failed creation is surfaced, audited with a code, and can be repeated", async () => {
    api.webhookCreate = { ...api.webhookCreate, status: 400 };
    const res = await registerRoute();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "webhook_registration_failed",
      code: "api_400",
    });
    expect(await lastError()).toBe("webhook_not_registered");
    const list = (await (
      await worker.fetch(
        new Request(`${ORIGIN}/api/connections`, {
          headers: { cookie: `__Host-session=${adminTok}` },
        }),
        envWithQueue(queue),
      )
    ).json()) as { connections: { kind: string; revolut?: { webhookRegistered: boolean } }[] };
    expect(list.connections.find((c) => c.kind === "revolut")?.revolut?.webhookRegistered).toBe(
      false,
    );
    const failed = await db
      .prepare(
        "SELECT after_json FROM audit_log WHERE action = 'connection.revolut_webhook_failed'",
      )
      .all<{ after_json: string }>();
    expect(failed.results).toHaveLength(1);
    expect(JSON.parse(failed.results[0]?.after_json ?? "{}")).toMatchObject({ failure: "api_400" });

    api.webhookCreate = { ...api.webhookCreate, status: 201 };
    expect((await registerRoute()).status).toBe(200);
    expect(await lastError()).toBeNull();
  });

  it("does not overwrite an existing last_error with the webhook flag", async () => {
    await db
      .prepare("UPDATE connections SET last_error = 'token_endpoint_rejected_credentials'")
      .run();
    api.webhookCreate = { ...api.webhookCreate, status: 500 };
    await registerWebhook(env, await conn(), ADMIN, { appOrigin: "https://app.test" });
    expect(await lastError()).toBe("token_endpoint_rejected_credentials");
  });
});

describe("recovery from a lost creation response", () => {
  beforeEach(async () => {
    connId = await seedRevolut({ status: "active" });
  });

  it("deletes our own stale subscription (no secret held), creates a fresh one, keeps others", async () => {
    api.webhooks = [
      { id: WEBHOOK_ID, url: OUR_URL, events: ["TransactionCreated"] },
      { id: OTHER_ID, url: "https://elsewhere.example/hook", events: ["TransactionCreated"] },
    ];
    api.webhookCreate = { ...api.webhookCreate, id: NEW_ID, secret: "wsk_fresh_secret" };
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const res = await registerRoute();
    const text = spies
      .flatMap((s) => s.mock.calls.flat())
      .map(String)
      .join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(res.status).toBe(200);
    const sequence = hooks().map((c) => `${c.method} ${c.url.pathname}`);
    expect(sequence).toEqual([
      "GET /api/2.0/webhooks",
      `DELETE /api/2.0/webhooks/${WEBHOOK_ID}`,
      "POST /api/2.0/webhooks",
    ]);
    expect((await conn()).webhook_id).toBe(NEW_ID);
    expect((await loadWebhookSecretSet(env, connId)).current).toBe("wsk_fresh_secret");
    // The list response carried a secret: it is nowhere in D1, the audit log or the console.
    const everything = JSON.stringify([
      (await db.prepare("SELECT * FROM connections").all()).results,
      (await db.prepare("SELECT * FROM audit_log").all()).results,
      text,
    ]);
    expect(everything).not.toContain("wsk_LEAK_FROM_LIST");
    const deleted = await db
      .prepare(
        "SELECT after_json FROM audit_log WHERE action = 'connection.revolut_webhook_deleted'",
      )
      .all<{ after_json: string }>();
    expect(JSON.parse(deleted.results[0]?.after_json ?? "{}")).toMatchObject({
      webhookId: WEBHOOK_ID,
      reason: "recovery",
    });
  });

  it("does not list subscriptions when the secret is already held", async () => {
    await storeWebhookSecret(connId);
    await registerRoute();
    expect(hooks()).toEqual([]);
  });

  it("a failing list does not stop the creation", async () => {
    // The fake lists fine; make only the list fail by failing GET /webhooks via a wrapper.
    const original = api.handle;
    stub.api = (c) =>
      c.method === "GET" && c.url.pathname === "/api/2.0/webhooks"
        ? Response.json({ message: "no" }, { status: 403 })
        : original(c);
    expect((await registerRoute()).status).toBe(200);
  });
});

describe("replacing the subscription (rotation)", () => {
  beforeEach(async () => {
    connId = await seedRevolut({ status: "active" });
    await storeWebhookSecret(connId);
  });

  it("creates the new one first, keeps the old secret as previous, then deletes the old subscription", async () => {
    api.webhookCreate = { ...api.webhookCreate, id: NEW_ID, secret: "wsk_rotated_secret" };
    const res = await registerRoute({ replace: true });
    expect(await res.json()).toEqual({ ok: true, status: "registered" });
    expect(hooks().map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/2.0/webhooks",
      `DELETE /api/2.0/webhooks/${WEBHOOK_ID}`,
    ]);
    expect(await loadWebhookSecretSet(env, connId)).toEqual({
      current: "wsk_rotated_secret",
      previous: WEBHOOK_SECRET,
    });
    expect((await conn()).webhook_id).toBe(NEW_ID);
  });

  it("a failed replacement leaves the working subscription alone", async () => {
    api.webhookCreate = { ...api.webhookCreate, status: 500 };
    const res = await registerRoute({ replace: true });
    expect(res.status).toBe(502);
    expect((await loadWebhookSecretSet(env, connId)).current).toBe(WEBHOOK_SECRET);
    expect(hooks().some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("confirming a connection", () => {
  const SUMMARY = {
    accountCount: 1,
    currencies: ["EUR"],
    holders: ["Camelthorn Advisory B.V."],
    accounts: [{ name: "Main EUR", currency: "EUR", state: "active", last4: "5678" }],
    previousAccounts: 0,
    matchingAccounts: 0,
    stateEchoed: true,
  };

  beforeEach(async () => {
    connId = await seedRevolut({ status: "pending" });
    await db
      .prepare("UPDATE connections SET pending_summary = ?2 WHERE id = ?1")
      .bind(connId, JSON.stringify(SUMMARY))
      .run();
  });

  const confirm = () =>
    post("/api/connections/revolut/confirm", adminTok, { ref: "test-ref", ownAccount: true });

  it("registers the webhook and queues the 90-day initial backfill, which then runs", async () => {
    api.transactions = [
      simpleTx("t-new", { createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
      simpleTx("t-80d", { createdAt: new Date(Date.now() - 80 * 86_400_000).toISOString() }),
      simpleTx("t-100d", { createdAt: new Date(Date.now() - 100 * 86_400_000).toISOString() }),
    ];
    const res = await confirm();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, webhook: "registered", backfill: "queued" });
    expect((await conn()).status).toBe("active");
    expect((await loadWebhookSecretSet(env, connId)).current).toBe(WEBHOOK_SECRET);

    // A manual run of revolut.backfill is queued, requested by the confirming admin.
    const runs = await rowsOf("job_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "manual", requested_by: ADMIN });
    const msgs = queue.sent as QueueMessage[];
    expect(msgs).toHaveLength(1);
    expect(
      (
        await db
          .prepare("SELECT requested_days FROM revolut_sync_state WHERE entity = 'backfill'")
          .first<{
            requested_days: number;
          }>()
      )?.requested_days,
    ).toBe(90);

    // Deliver the message: the walk covers 90 days and is the initial one.
    const m = { body: msgs[0], attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await handleQueue({ messages: [m] } as unknown as MessageBatch<unknown>, envWithQueue(queue));
    expect(m.ack).toHaveBeenCalled();
    expect((await rowsOf("bank_transactions")).map((r) => r["external_id"]).sort()).toEqual([
      "t-80d",
      "t-new",
    ]);
    const run = (await rowsOf("job_runs"))[0];
    expect(run?.["status"]).toBe("ok");
    expect(JSON.parse(String(run?.["result_json"])).summary).toMatchObject({
      initial: true,
      windowDays: 90,
    });
    expect((await rowsOf("bank_accounts")).some((a) => a["external_id"] === ACC_EUR)).toBe(true);
  });

  it("a webhook failure does not block the confirmation, and is surfaced", async () => {
    api.webhookCreate = { ...api.webhookCreate, status: 500 };
    const res = await confirm();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, webhook: "failed" });
    expect((await conn()).status).toBe("active");
    expect(await lastError()).toBe("webhook_not_registered");
  });

  it("asking twice is harmless: no second run while one is queued, the request stays", async () => {
    await confirm();
    const again = await queueAgain();
    expect(again).toBe("requested");
    expect(await rowsOf("job_runs")).toHaveLength(1);
  });

  async function queueAgain(): Promise<string> {
    const { queueInitialBackfill } = await import("../src/revolut/initial-backfill");
    return queueInitialBackfill(envWithQueue(queue), connId, ADMIN, Date.now());
  }
});
