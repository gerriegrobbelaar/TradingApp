/**
 * POST /api/webhooks/revolut and the queue consumer for Revolut events (task R3a, ADR 0032).
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleQueue, parseQueueMessage } from "../src/jobs/runner";
import { EVENT_MAX_ATTEMPTS } from "../src/revolut/events";
import { loadWebhookSecretSet, saveWebhookSecret } from "../src/revolut/store";
import { Router } from "../src/router";
import { db, resetDb } from "./helpers";
import { resetRevolut, seedRevolut, stubRevolut, type RevolutStub } from "./revolut-helpers";
import {
  ADMIN,
  CP_IBAN,
  deliveryRequest,
  envWithQueue,
  eventBody,
  EventQueue,
  fakeRevolut,
  rowsOf,
  simpleTx,
  storeWebhookSecret,
  WEBHOOK_ID,
  WEBHOOK_SECRET,
  type Delivery,
  type FakeRevolut,
} from "./revolut-r3-helpers";

let connId: number;
let queue: EventQueue;
let stub: RevolutStub;
let api: FakeRevolut;

beforeEach(async () => {
  await resetDb();
  await resetRevolut();
  connId = await seedRevolut({ status: "active" });
  await storeWebhookSecret(connId);
  queue = new EventQueue();
  stub = stubRevolut();
  api = fakeRevolut();
  stub.api = api.handle;
});
afterEach(() => stub.restore());

const deliver = async (d: Delivery): Promise<Response> =>
  worker.fetch(await deliveryRequest(d), envWithQueue(queue));

const valid = (id = "tx-1", event = "TransactionCreated"): Delivery => ({
  body: eventBody(event, id),
});

const events = () => rowsOf("webhook_events");

describe("webhook endpoint: accepting a delivery", () => {
  it("verifies, stores a hash row, enqueues ids only and answers 200", async () => {
    const res = await deliver(valid("tx-1"));
    expect(res.status).toBe(200);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connection_id: connId,
      event_type: "TransactionCreated",
      external_id: "tx-1",
      status: "queued",
    });
    expect(String(rows[0]?.["event_hash"])).toMatch(/^[0-9a-f]{64}$/);
    expect(queue.sent).toEqual([{ type: "revolut_event", webhookEventId: rows[0]?.["id"] }]);
    // The body itself is never stored.
    expect(JSON.stringify(rows)).not.toContain("request_id");
  });

  it("a replayed delivery is answered 200 and enqueued once", async () => {
    const d = valid("tx-1");
    expect((await deliver(d)).status).toBe(200);
    expect((await deliver(d)).status).toBe(200);
    expect((await deliver(d)).status).toBe(200);
    expect(await events()).toHaveLength(1);
    expect(queue.sent).toHaveLength(1);
  });

  it("two different events are two rows and two messages", async () => {
    await deliver(valid("tx-1"));
    await deliver(valid("tx-2", "TransactionStateChanged"));
    expect(await events()).toHaveLength(2);
    expect(queue.sent).toHaveLength(2);
  });

  it("an unknown event type is 200 and ignored, nothing is enqueued", async () => {
    const res = await deliver({ body: eventBody("PayoutLinkCreated", "x-1") });
    expect(res.status).toBe(200);
    expect(await events()).toMatchObject([{ status: "ignored", event_type: "PayoutLinkCreated" }]);
    expect(queue.sent).toEqual([]);
  });

  it("a signed but malformed body is recorded as an error and acknowledged", async () => {
    for (const body of ["not json", JSON.stringify({ event: "TransactionCreated" }), "[]"]) {
      expect((await deliver({ body })).status).toBe(200);
    }
    const rows = await events();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r["status"] === "error" && r["error_code"] === "bad_payload")).toBe(
      true,
    );
    expect(queue.sent).toEqual([]);
  });

  it("refuses a transaction id the API path would not accept", async () => {
    const res = await deliver({ body: eventBody("TransactionCreated", "../accounts") });
    expect(res.status).toBe(200);
    expect(await events()).toMatchObject([{ status: "error", error_code: "bad_transaction_id" }]);
    expect(queue.sent).toEqual([]);
  });

  it("accepts a rotation header with several signatures", async () => {
    const ts = Date.now();
    const d = valid("tx-9");
    const real = (await deliveryRequest({ ...d, timestampMs: ts })).headers.get(
      "revolut-signature",
    );
    const res = await deliver({
      ...d,
      timestampMs: ts,
      signature: `v1=${"a".repeat(64)}, ${real ?? ""}`,
    });
    expect(res.status).toBe(200);
  });
});

describe("webhook endpoint: every authentication failure is the same 401", () => {
  async function snapshot(res: Response) {
    return {
      status: res.status,
      body: await res.text(),
      headers: [...res.headers.entries()].sort(),
    };
  }

  it("is byte-for-byte identical for all causes, and has no side effects", async () => {
    const now = Date.now();
    const base = valid("tx-1");
    const cases: [string, () => Promise<Response>][] = [
      ["wrong signature", () => deliver({ ...base, signature: `v1=${"0".repeat(64)}` })],
      ["wrong secret", () => deliver({ ...base, secret: "another-secret-value" })],
      [
        "tampered body",
        async () => {
          const signed = await deliveryRequest(base);
          return worker.fetch(
            new Request(signed.url, {
              method: "POST",
              headers: signed.headers,
              body: base.body.replace("tx-1", "tx-2"),
            }),
            envWithQueue(queue),
          );
        },
      ],
      ["missing signature", () => deliver({ ...base, omitSignature: true })],
      ["missing timestamp", () => deliver({ ...base, omitTimestamp: true })],
      ["timestamp 6 minutes old", () => deliver({ ...base, timestampMs: now - 6 * 60_000 })],
      ["timestamp 6 minutes ahead", () => deliver({ ...base, timestampMs: now + 6 * 60_000 })],
      ["timestamp in seconds", () => deliver({ ...base, timestampMs: Math.floor(now / 1000) })],
      ["garbage signature", () => deliver({ ...base, signature: "not-a-signature" })],
      ["empty signature", () => deliver({ ...base, signature: "" })],
      ["v2 signature only", () => deliver({ ...base, signature: `v2=${"0".repeat(64)}` })],
    ];
    const seen: Awaited<ReturnType<typeof snapshot>>[] = [];
    for (const [name, run] of cases) {
      const s = await snapshot(await run());
      expect(s.status, name).toBe(401);
      seen.push(s);
    }
    for (const s of seen) expect(s).toEqual(seen[0]);
    expect(seen[0]?.body).toBe("unauthorized");
    expect(await events()).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it("no connection, an inactive connection, no secret or an empty secret: the same 401", async () => {
    const ok = await snapshot(await deliver({ ...valid("tx-1"), signature: "x" }));
    // no secret stored
    await db
      .prepare("UPDATE connections SET webhook_secret_enc = NULL, webhook_secret_prev_enc = NULL")
      .run();
    expect(await snapshot(await deliver(valid("tx-1")))).toEqual(ok);
    // not active
    await storeWebhookSecret(connId);
    await db.prepare("UPDATE connections SET status = 'needs_reauth'").run();
    expect(await snapshot(await deliver(valid("tx-1")))).toEqual(ok);
    // an empty secret can never verify (fail closed): storing "" and delivering with an empty key
    await db.prepare("UPDATE connections SET status = 'active'").run();
    await saveWebhookSecret(env, connId, WEBHOOK_ID, "", ADMIN);
    expect(await snapshot(await deliver({ ...valid("tx-1"), signature: "x" }))).toEqual(ok);
    // no connection at all
    await resetRevolut();
    expect(await snapshot(await deliver(valid("tx-1")))).toEqual(ok);
    expect(queue.sent).toEqual([]);
  });

  it("logs a reason code only, never the body, the signature or the secret", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const d = valid("tx-secret-1");
    await deliver({ ...d, signature: `v1=${"b".repeat(64)}` });
    await deliver(d);
    await deliver({ ...d, timestampMs: Date.now() - 10 * 60_000 });
    const text = spies
      .flatMap((s) => s.mock.calls.flat())
      .map(String)
      .join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(text).toContain("revolut webhook rejected");
    for (const leak of [WEBHOOK_SECRET, "b".repeat(64), "tx-secret-1", "request_id", "v1="]) {
      expect(text).not.toContain(leak);
    }
  });
});

describe("webhook endpoint: size, queue failures and other requests", () => {
  it("rejects a body over 1 MB with 413, before parsing", async () => {
    const big = "x".repeat(1_048_577);
    const res = await deliver({ body: big });
    expect(res.status).toBe(413);
    expect(await events()).toEqual([]);
    // a body of exactly the limit is read (and then fails authentication, not size)
    const edge = await deliver({ body: "y".repeat(1_048_576), signature: "v1=" + "0".repeat(64) });
    expect(edge.status).toBe(401);
  });

  it("rejects an oversized body that declares no length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const chunk = new Uint8Array(512 * 1024).fill(120);
        c.enqueue(chunk);
        c.enqueue(chunk);
        c.enqueue(chunk);
        c.close();
      },
    });
    const req = new Request("https://app.test/api/webhooks/revolut", {
      method: "POST",
      body: stream,
      headers: {
        "revolut-signature": "v1=" + "0".repeat(64),
        "revolut-request-timestamp": String(Date.now()),
      },
      // @ts-expect-error duplex is required by the runtime for stream bodies
      duplex: "half",
    });
    const res = await worker.fetch(req, envWithQueue(queue));
    expect(res.status).toBe(413);
  });

  it("a queue failure is a 500 and marks the row, and the redelivery enqueues", async () => {
    queue.fail = true;
    const d = valid("tx-1");
    expect((await deliver(d)).status).toBe(500);
    expect(await events()).toMatchObject([{ status: "error", error_code: "enqueue_failed" }]);
    expect(queue.sent).toEqual([]);

    queue.fail = false;
    expect((await deliver(d)).status).toBe(200);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", error_code: null });
    expect(queue.sent).toHaveLength(1);
    // and a further redelivery changes nothing
    expect((await deliver(d)).status).toBe(200);
    expect(queue.sent).toHaveLength(1);
  });

  it("a queued row nobody processed for 5 minutes is enqueued again, once per window", async () => {
    const d = valid("tx-1");
    await deliver(d);
    await db.prepare("UPDATE webhook_events SET received_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await deliver(d)).status).toBe(200);
    expect(queue.sent).toHaveLength(2);
    expect((await deliver(d)).status).toBe(200);
    expect(queue.sent).toHaveLength(2);
  });

  it("a finished or failed event is never enqueued again", async () => {
    const d = valid("tx-1");
    await deliver(d);
    await db.prepare("UPDATE webhook_events SET status = 'processed'").run();
    await deliver(d);
    await db.prepare("UPDATE webhook_events SET status = 'error', error_code = 'api_400'").run();
    await deliver(d);
    expect(queue.sent).toHaveLength(1);
  });

  it("only POST on the exact path is served; the default-deny rules are unchanged", async () => {
    const e = envWithQueue(queue);
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await worker.fetch(await deliveryRequest({ ...valid(), method }), e);
      expect(res.status, method).toBe(405);
    }
    for (const path of ["/api/webhooks", "/api/webhooks/other", "/api/webhooks/revolut/x"]) {
      const res = await worker.fetch(new Request(`https://app.test${path}`, { method: "POST" }), e);
      expect(res.status, path).toBe(404);
    }
    // CSRF is still required everywhere else: a cookie request without the header is refused.
    const csrf = await worker.fetch(
      new Request("https://app.test/api/connections/revolut/disconnect", {
        method: "POST",
        headers: { cookie: "__Host-session=whatever" },
      }),
      e,
    );
    expect(csrf.status).toBe(403);
    expect(await events()).toEqual([]);
  });

  it("CSRF exemption is only allowed on a public route", () => {
    const r = new Router();
    expect(() => r.add("POST", "/x", { csrfExempt: true }, () => new Response())).toThrow();
    expect(() =>
      r.add("POST", "/y", { public: true, csrfExempt: true }, () => new Response()),
    ).not.toThrow();
  });

  it("every route registered by the Worker: only the webhook is csrfExempt", async () => {
    // The Worker's router is module-private; the registration functions are the source of truth.
    const { registerRevolutWebhookRoute } = await import("../src/revolut/webhook-route");
    const { registerRevolutRoutes } = await import("../src/revolut/routes");
    const { registerAuthRoutes } = await import("../src/auth/routes");
    const { registerUserRoutes } = await import("../src/auth/users-routes");
    const { registerExactRoutes } = await import("../src/exact/routes");
    const { registerSyncRoutes } = await import("../src/exact/sync-routes");
    const { registerBankRoutes } = await import("../src/read/bank-routes");
    const { registerReadRoutes } = await import("../src/read/routes");
    const { registerJobRoutes } = await import("../src/jobs/routes");
    const router = new Router();
    for (const reg of [
      registerAuthRoutes,
      registerUserRoutes,
      registerExactRoutes,
      registerRevolutRoutes,
      registerRevolutWebhookRoute,
      registerSyncRoutes,
      registerBankRoutes,
      registerReadRoutes,
      registerJobRoutes,
    ]) {
      reg(router);
    }
    const exempt = router.describe().filter((r) => r.access.csrfExempt);
    expect(exempt.map((r) => r.pattern)).toEqual(["POST /api/webhooks/revolut"]);
    expect(exempt[0]?.access.public).toBe(true);
  });
});

describe("webhook secrets: rotation overlap", () => {
  it("accepts the previous secret during the overlap and drops it after the first delivery with the new one", async () => {
    await saveWebhookSecret(env, connId, WEBHOOK_ID, "wsk_new_secret_value", ADMIN);
    expect(await loadWebhookSecretSet(env, connId)).toEqual({
      current: "wsk_new_secret_value",
      previous: WEBHOOK_SECRET,
    });
    // signed with the OLD secret: accepted, overlap stays
    expect((await deliver({ ...valid("tx-1"), secret: WEBHOOK_SECRET })).status).toBe(200);
    expect((await loadWebhookSecretSet(env, connId)).previous).toBe(WEBHOOK_SECRET);
    // signed with the NEW one: accepted, the old one is retired and audited
    expect((await deliver({ ...valid("tx-2"), secret: "wsk_new_secret_value" })).status).toBe(200);
    expect(await loadWebhookSecretSet(env, connId)).toEqual({
      current: "wsk_new_secret_value",
      previous: null,
    });
    const audit = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'connection.revolut_webhook_prev_secret_retired'",
      )
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
    // the old secret no longer verifies
    expect((await deliver({ ...valid("tx-3"), secret: WEBHOOK_SECRET })).status).toBe(401);
  });
});

// ---- queue consumer -------------------------------------------------------------------------

interface FakeMsg {
  body: unknown;
  attempts: number;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}
const msg = (body: unknown, attempts = 1): FakeMsg => ({
  body,
  attempts,
  ack: vi.fn(),
  retry: vi.fn(),
});
const consume = (m: FakeMsg) =>
  handleQueue({ messages: [m] } as unknown as MessageBatch<unknown>, envWithQueue(queue));

async function receive(txId: string, event = "TransactionCreated"): Promise<number> {
  await deliver({ body: eventBody(event, txId) });
  return Number(
    queue.sent[queue.sent.length - 1] && (await rowsOf("webhook_events")).slice(-1)[0]?.["id"],
  );
}

describe("queue consumer: Revolut events", () => {
  it("refreshes the transaction from the API, not from the payload", async () => {
    // The payload lies about state and amount; the API says pending and -100.50.
    api.transactions = [simpleTx("tx-1", { state: "pending" })];
    await deliver({
      body: eventBody("TransactionStateChanged", "tx-1", {
        state: "completed",
        new_state: "completed",
        amount: 999999,
      }),
    });
    const id = (await events())[0]?.["id"] as number;
    const m = msg({ type: "revolut_event", webhookEventId: id });
    await consume(m);
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
    const tx = await rowsOf("bank_transactions");
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({
      external_id: "tx-1",
      leg_id: "tx-1-l1",
      state: "pending",
      amount_minor: -10050,
      currency: "EUR",
      source: "webhook",
    });
    expect(await events()).toMatchObject([{ status: "processed", error_code: null }]);
    // exactly one Revolut call for the event, and it went through the gate with a job id
    expect(stub.apiCalls.map((c) => c.url.pathname)).toEqual(["/api/1.0/transaction/tx-1"]);
  });

  it("is idempotent: a redelivered message changes nothing and calls nothing", async () => {
    api.transactions = [simpleTx("tx-1")];
    const id = await receive("tx-1");
    await consume(msg({ type: "revolut_event", webhookEventId: id }));
    const before = await rowsOf("bank_transactions");
    const calls = stub.apiCalls.length;
    const m = msg({ type: "revolut_event", webhookEventId: id });
    await consume(m);
    expect(m.ack).toHaveBeenCalled();
    expect(await rowsOf("bank_transactions")).toEqual(before);
    expect(stub.apiCalls.length).toBe(calls);
  });

  it("an event for an unknown transaction (404) is processed with a code", async () => {
    const id = await receive("tx-gone");
    const m = msg({ type: "revolut_event", webhookEventId: id });
    await consume(m);
    expect(m.ack).toHaveBeenCalled();
    expect(await events()).toMatchObject([
      { status: "processed", error_code: "transaction_not_found" },
    ]);
    expect(await rowsOf("bank_transactions")).toEqual([]);
  });

  it("a rate limit asks the queue to retry; the row stays queued; the last attempt records the error", async () => {
    api.transactions = [simpleTx("tx-1")];
    const id = await receive("tx-1");
    api.failAll = 429;
    const first = msg({ type: "revolut_event", webhookEventId: id }, 1);
    await consume(first);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) });
    expect(first.ack).not.toHaveBeenCalled();
    expect(await events()).toMatchObject([{ status: "queued", error_code: "rate_limited" }]);

    const last = msg({ type: "revolut_event", webhookEventId: id }, EVENT_MAX_ATTEMPTS);
    await consume(last);
    expect(last.ack).toHaveBeenCalled();
    expect(last.retry).not.toHaveBeenCalled();
    expect(await events()).toMatchObject([{ status: "error", error_code: "rate_limited" }]);
  });

  it("a Revolut outage (500) is retried; a permanent failure is recorded at once", async () => {
    api.transactions = [simpleTx("tx-1")];
    const id = await receive("tx-1");
    api.failAll = 503;
    const m = msg({ type: "revolut_event", webhookEventId: id }, 1);
    await consume(m);
    expect(m.retry).toHaveBeenCalled();
    api.failAll = 400;
    const m2 = msg({ type: "revolut_event", webhookEventId: id }, 1);
    await consume(m2);
    expect(m2.ack).toHaveBeenCalled();
    expect(await events()).toMatchObject([{ status: "error", error_code: "api_400" }]);
  });

  it("a connection that needs re-authorisation fails the event with that code", async () => {
    api.transactions = [simpleTx("tx-1")];
    const id = await receive("tx-1");
    await db.prepare("UPDATE connections SET status = 'needs_reauth'").run();
    const m = msg({ type: "revolut_event", webhookEventId: id });
    await consume(m);
    expect(m.ack).toHaveBeenCalled();
    expect(await events()).toMatchObject([{ status: "error", error_code: "needs_reauth" }]);
    expect(stub.apiCalls).toEqual([]);
  });

  it("an infrastructure failure inside the consumer retries the message (and the queue's DLQ takes it after max_retries)", async () => {
    api.transactions = [simpleTx("tx-1")];
    const id = await receive("tx-1");
    const broken = Object.create(envWithQueue(queue), {
      DB: {
        value: new Proxy(env.DB, {
          get(target, prop) {
            if (prop === "prepare") {
              return () => {
                throw new Error("d1 down");
              };
            }
            return Reflect.get(target, prop) as unknown;
          },
        }),
        enumerable: true,
      },
    }) as typeof env;
    const m = msg({ type: "revolut_event", webhookEventId: id }, 2);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await handleQueue({ messages: [m] } as unknown as MessageBatch<unknown>, broken);
    err.mockRestore();
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(m.ack).not.toHaveBeenCalled();
    // wrangler.toml sends it to the dead-letter queue after the third retry.
    const toml = (await import("../wrangler.toml?raw")).default;
    expect(toml).toMatch(/max_retries = 3/);
    expect(toml).toMatch(/dead_letter_queue = "camelthorn-jobs-dlq"/);
    expect(EVENT_MAX_ATTEMPTS).toBe(4);
  });

  it("an unknown event id is acked", async () => {
    const m = msg({ type: "revolut_event", webhookEventId: 987654 });
    await consume(m);
    expect(m.ack).toHaveBeenCalled();
  });
});

describe("queue message validation", () => {
  it("accepts job messages and exact Revolut event messages only", () => {
    expect(parseQueueMessage({ runId: 3, jobId: 1 })).toEqual({ kind: "job", runId: 3 });
    expect(parseQueueMessage({ type: "revolut_event", webhookEventId: 5 })).toEqual({
      kind: "revolut_event",
      webhookEventId: 5,
    });
    for (const bad of [
      null,
      undefined,
      "x",
      7,
      [],
      {},
      { runId: "3" },
      { runId: 1.5 },
      { type: "revolut_event" },
      { type: "revolut_event", webhookEventId: "5" },
      { type: "revolut_event", webhookEventId: 0 },
      { type: "revolut_event", webhookEventId: -1 },
      { type: "revolut_event", webhookEventId: 5, extra: 1 },
      { type: "other", webhookEventId: 5 },
      { type: "job", runId: 3 },
    ]) {
      expect(parseQueueMessage(bad).kind, JSON.stringify(bad)).toBe("unknown");
    }
  });

  it("unknown messages are acked and logged by type name only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const secretish = { type: "SECRET-IBAN-" + CP_IBAN, payload: CP_IBAN };
    const a = msg(secretish);
    const b = msg({ type: "mystery_job", payload: CP_IBAN });
    const c = msg({ type: "revolut_event", webhookEventId: "5", payload: CP_IBAN });
    await consume(a);
    await consume(b);
    await consume(c);
    const text = warn.mock.calls.flat().map(String).join("\n");
    warn.mockRestore();
    for (const m of [a, b, c]) {
      expect(m.ack).toHaveBeenCalled();
      expect(m.retry).not.toHaveBeenCalled();
    }
    expect(text).toContain("mystery_job");
    expect(text).not.toContain(CP_IBAN);
    expect(text).not.toContain("SECRET");
  });
});
