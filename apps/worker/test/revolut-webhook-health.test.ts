/**
 * Phase 5 review fixes Q2: S3 (TOKEN_ENC_KEY rotation keeps webhooks working), S4 (webhook channel
 * health, housekeeping, retention), N1 (header checks before body and D1), N2 (unparsed re-claim
 * age), N8 (refresh token expiry).
 *
 * Time is a fixed system time (Date only is faked); nothing waits.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEncryptedWith } from "../src/crypto/token-crypto";
import type { Env } from "../src/env";
import worker from "../src/index";
import { tickScheduler } from "../src/jobs/runner";
import { MAX_REQUEUES } from "../src/revolut/webhook-route";
import {
  HOUSEKEEPING_BATCH,
  HOUSEKEEPING_EVERY_MS,
  housekeepWebhookEvents,
  resetHousekeepingState,
} from "../src/revolut/webhook-housekeeping";
import {
  reencryptWebhookSecrets,
  saveWebhookSecret,
  webhookSecretsReadable,
} from "../src/revolut/store";
import { addSession, addUser, authed, db, resetDb } from "./helpers";
import {
  fakeRevolutClock,
  refreshOk,
  resetRevolut,
  revolutGate,
  rreq,
  seedRevolut,
  stubRevolut,
  type RevolutStub,
} from "./revolut-helpers";
import {
  ADMIN,
  deliveryRequest,
  envWithQueue,
  eventBody,
  EventQueue,
  rowsOf,
  WEBHOOK_ID,
  WEBHOOK_SECRET,
  type Delivery,
} from "./revolut-r3-helpers";
import { unwrap } from "../src/revolut/wire";

/** The current key and the "old" key the test pool accepts for decryption (vitest.config.ts). */
const KEY_B = env.TOKEN_ENC_KEY;
const KEY_A = env.TOKEN_ENC_KEY_PREVIOUS as string;
/** A key nobody has: ciphertexts under it cannot be read. */
const KEY_C = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 200 - i)));

const ADMIN2 = "admin2@camelthorncapital.com";
const NOW = Date.parse("2026-11-11T10:00:00.000Z");
let connId: number;
let queue: EventQueue;
let stub: RevolutStub;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
  await resetRevolut();
  connId = await seedRevolut({ status: "active" });
  queue = new EventQueue();
  stub = stubRevolut();
});
afterEach(() => {
  stub.restore();
  vi.useRealTimers();
});

const underKey = (key: string) =>
  ({ DB: env.DB, TOKEN_ENC_KEY: key }) as Pick<Env, "DB" | "TOKEN_ENC_KEY">;
const withKeys = (keys: { current: string; previous?: string }): Env =>
  Object.create(envWithQueue(queue), {
    TOKEN_ENC_KEY: { value: keys.current, enumerable: true },
    TOKEN_ENC_KEY_PREVIOUS: { value: keys.previous, enumerable: true },
  }) as Env;

const deliver = async (d: Delivery, e: Env = envWithQueue(queue)): Promise<Response> =>
  worker.fetch(await deliveryRequest(d), e);
const valid = (id: string): Delivery => ({ body: eventBody("TransactionCreated", id) });

/** First request of the isolate seeds the admin (reads and writes); do it before spying. */
const prime = async () => {
  await worker.fetch(new Request("https://app.test/api/health"), envWithQueue(queue));
};

const blobs = async () =>
  (await db
    .prepare("SELECT webhook_secret_enc AS cur, webhook_secret_prev_enc AS prev FROM connections")
    .first<{ cur: string | null; prev: string | null }>())!;

/** An env whose DB records every prepared statement. */
function spyEnv(): { env: Env; sql: string[]; batches: () => number } {
  const sql: string[] = [];
  let batches = 0;
  const spiedDb = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (q: string) => {
          sql.push(q.replace(/\s+/g, " ").trim());
          return target.prepare(q);
        };
      }
      if (prop === "batch") {
        return (...a: Parameters<D1Database["batch"]>) => {
          batches++;
          return target.batch(...a);
        };
      }
      return Reflect.get(target, prop) as unknown;
    },
  });
  return {
    env: Object.create(envWithQueue(queue), { DB: { value: spiedDb, enumerable: true } }) as Env,
    sql,
    batches: () => batches,
  };
}

describe("S3: TOKEN_ENC_KEY rotation keeps the webhook working", () => {
  it("a delivery after the rotation still verifies and moves the secret to the new key", async () => {
    await saveWebhookSecret(underKey(KEY_A) as never, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    const before = await blobs();
    expect(await isEncryptedWith(KEY_A, before.cur!)).toBe(true);

    // current = B, previous = A
    const res = await deliver(valid("tx-1"), withKeys({ current: KEY_B, previous: KEY_A }));
    expect(res.status).toBe(200);
    const after = await blobs();
    expect(await isEncryptedWith(KEY_B, after.cur!)).toBe(true);
    expect(after.cur).not.toBe(before.cur);

    // A is dropped: everything still works
    const res2 = await deliver(valid("tx-2"), withKeys({ current: KEY_B }));
    expect(res2.status).toBe(200);
    expect(queue.sent).toHaveLength(2);
    expect(await webhookSecretsReadable(withKeys({ current: KEY_B }), connId)).toBe(true);
  });

  it("re-encrypts the previous secret too, and does nothing when both are already current", async () => {
    await saveWebhookSecret(underKey(KEY_A) as never, connId, WEBHOOK_ID, "wsk_old_secret", ADMIN);
    await saveWebhookSecret(underKey(KEY_A) as never, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    const e = withKeys({ current: KEY_B, previous: KEY_A });
    // delivery signed with the PREVIOUS secret verifies (the overlap) and re-encrypts both
    const res = await deliver({ ...valid("tx-1"), secret: "wsk_old_secret" }, e);
    expect(res.status).toBe(200);
    const b = await blobs();
    expect(await isEncryptedWith(KEY_B, b.cur!)).toBe(true);
    expect(await isEncryptedWith(KEY_B, b.prev!)).toBe(true);
    expect(await reencryptWebhookSecrets(e, connId)).toEqual({ readable: true, reencrypted: 0 });
    // dropping A: the new secret and the overlap secret both still verify
    const only = withKeys({ current: KEY_B });
    expect((await deliver({ ...valid("tx-2"), secret: "wsk_old_secret" }, only)).status).toBe(200);
    expect((await deliver(valid("tx-3"), only)).status).toBe(200);
  });

  it("a refresh by the token authority re-encrypts the webhook secrets", async () => {
    await saveWebhookSecret(underKey(KEY_A) as never, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    await db
      .prepare("UPDATE connections SET expires_at = ?1")
      .bind(new Date(NOW + 1000).toISOString())
      .run();
    stub.token = (_f, n) => refreshOk(n);
    (await fakeRevolutClock(connId)).t = NOW;
    expect(unwrap(await revolutGate(connId).call(rreq(connId))).status).toBe(200);
    expect(stub.tokenCalls).toHaveLength(1);
    const b = await blobs();
    expect(await isEncryptedWith(KEY_B, b.cur!)).toBe(true);
  });

  it("a compare-and-swap never overwrites a secret registered meanwhile", async () => {
    await saveWebhookSecret(underKey(KEY_A) as never, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    const old = (await blobs()).cur!;
    // someone registers again between our read and write: simulate by changing the column first
    await saveWebhookSecret(env, connId, WEBHOOK_ID, "wsk_registered_again", ADMIN);
    const fresh = await blobs();
    expect(fresh.cur).not.toBe(old);
    const r = await reencryptWebhookSecrets(env, connId);
    expect(r.readable).toBe(true);
    expect((await blobs()).cur).toBe(fresh.cur); // already current: untouched
  });

  it("an unreadable secret is a uniform 401, shows to admins only, and registering again fixes it", async () => {
    await saveWebhookSecret(underKey(KEY_C) as never, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    const res = await deliver(valid("tx-1"));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");

    const admin = await addSession(await addUser(ADMIN2, ["admin"]));
    const viewer = await addSession(await addUser("v@camelthorncapital.com", ["viewer"]));
    type Row = { kind: string; revolut?: Record<string, unknown> };
    const list = async (tok: string) =>
      (
        (await (await authed("/api/connections", tok)).json()) as { connections: Row[] }
      ).connections.find((c) => c.kind === "revolut")!.revolut!;
    const a = await list(admin);
    expect(a["webhookSecretReadable"]).toBe(false);
    expect((a["webhook"] as Record<string, unknown>)["secretReadable"]).toBe(false);
    const v = await list(viewer);
    expect("webhookSecretReadable" in v).toBe(false);
    expect("secretReadable" in (v["webhook"] as Record<string, unknown>)).toBe(false);
    expect((v["webhook"] as Record<string, unknown>)["registered"]).toBe(true);

    // "Register again" (saveWebhookSecret is its storage step) works although the old one is unreadable.
    await saveWebhookSecret(env, connId, WEBHOOK_ID, "wsk_fresh_secret", ADMIN);
    expect((await blobs()).prev).toBeNull();
    expect((await deliver({ ...valid("tx-2"), secret: "wsk_fresh_secret" })).status).toBe(200);
    expect((await list(admin))["webhookSecretReadable"]).toBe(true);
  });
});

describe("N1: header checks come before the body and before any D1 read", () => {
  const cases: [string, Delivery][] = [
    ["no signature", { body: "{}", omitSignature: true }],
    ["no timestamp", { body: "{}", omitTimestamp: true }],
    ["a seconds timestamp", { body: "{}", headers: {}, timestampMs: 1_700_000_000 }],
    ["a timestamp outside the window", { body: "{}", timestampMs: NOW - 6 * 60_000 }],
    ["a malformed signature", { body: "{}", signature: "garbage" }],
    // Before the fix an oversized declared length was answered 413 first; now the headers decide.
    [
      "an oversized declared length without a signature",
      {
        body: "{}",
        omitSignature: true,
        headers: { "content-length": "9".repeat(30) },
      },
    ],
  ];
  it.each(cases)("%s: the same 401, the body is never read, no D1 read", async (_n, d) => {
    await prime();
    const s = spyEnv();
    const req = await deliveryRequest(d);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode("{}"));
        c.close();
      },
    });
    const probe = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body,
      // @ts-expect-error duplex is required by the runtime for stream bodies
      duplex: "half",
    });
    const res = await worker.fetch(probe, s.env);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
    expect(probe.bodyUsed).toBe(false);
    expect(s.sql.filter((q) => /^SELECT/i.test(q))).toEqual([]);
    expect(await rowsOf("webhook_events")).toEqual([]);
  });

  it("a request that passes the header checks is still verified as before", async () => {
    await saveWebhookSecret(env, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    expect((await deliver(valid("tx-1"))).status).toBe(200);
    expect((await deliver({ ...valid("tx-2"), signature: `v1=${"0".repeat(64)}` })).status).toBe(
      401,
    );
  });
});

describe("S4: rejected deliveries are counted with a bounded number of D1 writes", () => {
  it("10,000 rejected deliveries cause a handful of writes, and the count is exact once flushed", async () => {
    await prime();
    const s = spyEnv();
    const sig = `v1=${"0".repeat(64)}`;
    const mk = (i: number) =>
      new Request("https://app.test/api/webhooks/revolut", {
        method: "POST",
        body: "{}",
        headers:
          i % 2 === 0
            ? {} // missing_header
            : { "revolut-signature": sig, "revolut-request-timestamp": String(NOW - 3_600_000) },
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 10_000; i++) {
      expect((await worker.fetch(mk(i), s.env)).status).toBe(401);
    }
    const lines = warn.mock.calls.length;
    warn.mockRestore();
    // two reasons -> at most one write batch each (not 10,000 rows), and no reads at all
    expect(s.batches()).toBeLessThanOrEqual(2);
    expect(s.sql.filter((q) => /^SELECT/i.test(q))).toEqual([]);
    expect(s.sql.length).toBeLessThanOrEqual(4);
    expect(s.sql.filter((q) => q.startsWith("INSERT INTO webhook_rejections"))).toHaveLength(2);
    // sampled log: far fewer lines than rejections
    expect(lines).toBeLessThanOrEqual(12);
    const rows = await rowsOf("webhook_rejections");
    expect(rows.length).toBeLessThanOrEqual(2);

    // a minute later the next rejection flushes what was carried in memory
    vi.setSystemTime(NOW + 61_000);
    await worker.fetch(mk(0), s.env);
    await worker.fetch(mk(1), s.env);
    const total = (await rowsOf("connections", "id = " + connId))[0]!["webhook_rejected_total"];
    const sum = (await db
      .prepare("SELECT SUM(count) AS n FROM webhook_rejections")
      .first<{ n: number }>())!.n;
    expect(total).toBe(10_002);
    expect(sum).toBe(10_002);
    expect((await rowsOf("webhook_rejections")).length).toBeLessThanOrEqual(4);
  }, 120_000);

  it("reason codes are a closed list (nothing the caller sends becomes a value)", async () => {
    await saveWebhookSecret(env, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    await deliver({ ...valid("tx-1"), signature: `v1=${"a".repeat(64)}` });
    const codes = (await rowsOf("webhook_rejections")).map((r) => r["reason_code"]);
    expect(codes).toEqual(["bad_signature"]);
  });

  it("verified deliveries stamp the connection at most once a minute", async () => {
    await saveWebhookSecret(env, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    const s = spyEnv();
    for (let i = 0; i < 5; i++) {
      expect((await deliver(valid(`tx-${i}`), s.env)).status).toBe(200);
    }
    const stamps = s.sql.filter((q) => q.includes("last_webhook_verified_at"));
    expect(stamps).toHaveLength(1);
    const stored = () =>
      db.prepare("SELECT last_webhook_verified_at AS v FROM connections").first<{ v: string }>();
    expect((await stored())!.v).toBe(new Date(NOW).toISOString());
    vi.setSystemTime(NOW + 61_000);
    await deliver(valid("tx-later"), s.env);
    expect((await stored())!.v).toBe(new Date(NOW + 61_000).toISOString());
  });

  it("GET /api/connections shows the channel health to every role", async () => {
    await saveWebhookSecret(env, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    const viewer = await addSession(await addUser("v@camelthorncapital.com", ["viewer"]));
    type Webhook = Record<string, unknown>;
    const get = async () =>
      (
        (await (await authed("/api/connections", viewer)).json()) as {
          connections: { kind: string; revolut?: { webhook: Webhook } }[];
        }
      ).connections.find((c) => c.kind === "revolut")!.revolut!.webhook;
    expect(await get()).toMatchObject({
      registered: true,
      lastVerifiedAt: null,
      rejectedLast24h: 0,
      rejectedTotal: 0,
    });
    await deliver(valid("tx-1"));
    await deliver({ ...valid("tx-2"), signature: `v1=${"a".repeat(64)}` });
    expect(await get()).toMatchObject({
      registered: true,
      lastVerifiedAt: new Date(NOW).toISOString(),
      lastRejectedAt: new Date(NOW).toISOString(),
      rejectedLast24h: 1,
      rejectedTotal: 1,
    });
    // buckets older than 24 hours do not count
    await db
      .prepare(
        "INSERT INTO webhook_rejections (connection_id, bucket_at, reason_code, count) VALUES (?1, ?2, 'other', 50)",
      )
      .bind(connId, new Date(NOW - 25 * 3_600_000).toISOString())
      .run();
    expect((await get())["rejectedLast24h"]).toBe(1);
  });

  it("disconnecting resets the channel health", async () => {
    await saveWebhookSecret(env, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    await deliver(valid("tx-1"));
    await deliver({ ...valid("tx-2"), signature: `v1=${"a".repeat(64)}` });
    const admin = await addSession(await addUser(ADMIN2, ["admin"]));
    const res = await authed("/api/connections/revolut/disconnect", admin, { method: "POST" });
    expect(res.status).toBe(200);
    const row = (await rowsOf("connections", `id = ${connId}`))[0]!;
    expect(row).toMatchObject({
      last_webhook_verified_at: null,
      last_webhook_rejected_at: null,
      webhook_rejected_total: 0,
      refresh_expires_at: null,
    });
  });
});

describe("S4: housekeeping of webhook_events and webhook_rejections", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  async function seedEvent(
    n: number,
    over: { status?: string; type?: string; ageMs: number; requeues?: number; ext?: string | null },
  ): Promise<number> {
    const hash = n.toString(16).padStart(64, "0");
    const r = await db
      .prepare(
        `INSERT INTO webhook_events (connection_id, event_hash, event_type, external_id, received_at, status, requeue_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        connId,
        hash,
        over.type ?? "TransactionCreated",
        over.ext === undefined ? `tx-${n}` : over.ext,
        iso(NOW - over.ageMs),
        over.status ?? "queued",
        over.requeues ?? 0,
      )
      .run();
    return r.meta.last_row_id;
  }
  const e = () => envWithQueue(queue);
  const MIN = 60_000;

  it("re-enqueues a stale queued row once, leaves a recent one, fails exhausted and unparsed rows", async () => {
    const stale = await seedEvent(1, { ageMs: 20 * MIN });
    const recent = await seedEvent(2, { ageMs: 1 * MIN });
    const exhausted = await seedEvent(3, { ageMs: 20 * MIN, requeues: MAX_REQUEUES });
    const unparsed = await seedEvent(4, { ageMs: 20 * MIN, type: "unparsed", ext: null });
    const r = await housekeepWebhookEvents(e(), NOW);
    expect(r).toMatchObject({ ran: true, requeued: 1, failed: 2 });
    expect(queue.sent).toEqual([{ type: "revolut_event", webhookEventId: stale }]);
    const by = async (id: number) => (await rowsOf("webhook_events", `id = ${id}`))[0]!;
    expect(await by(stale)).toMatchObject({
      status: "queued",
      requeue_count: 1,
      received_at: iso(NOW),
    });
    expect(await by(recent)).toMatchObject({ status: "queued", requeue_count: 0 });
    expect(await by(exhausted)).toMatchObject({ status: "error", error_code: "requeue_exhausted" });
    expect(await by(unparsed)).toMatchObject({ status: "error", error_code: "never_parsed" });
    // the next run (10 minutes on) does not enqueue the row again until it is stale again
    resetHousekeepingState();
    await housekeepWebhookEvents(e(), NOW + HOUSEKEEPING_EVERY_MS + 1000);
    expect(queue.sent).toHaveLength(1);
  });

  it("a queue that refuses ends the row as error enqueue_failed (a redelivery can recover it)", async () => {
    const id = await seedEvent(1, { ageMs: 20 * MIN });
    queue.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await housekeepWebhookEvents(e(), NOW);
    expect(r.failed).toBe(1);
    expect((await rowsOf("webhook_events", `id = ${id}`))[0]).toMatchObject({
      status: "error",
      error_code: "enqueue_failed",
    });
  });

  it("deletes finished rows after 30 days and rejections after 7, in bounded batches", async () => {
    const old = HOUSEKEEPING_BATCH * 2 + 50;
    await db.batch(
      Array.from({ length: old }, (_, i) =>
        db
          .prepare(
            `INSERT INTO webhook_events (connection_id, event_hash, event_type, received_at, status)
             VALUES (?1, ?2, 'TransactionCreated', ?3, ?4)`,
          )
          .bind(
            connId,
            (1000 + i).toString(16).padStart(64, "0"),
            iso(NOW - 31 * 86_400_000),
            ["processed", "ignored", "error"][i % 3],
          ),
      ),
    );
    const keep1 = await seedEvent(1, { status: "processed", ageMs: 29 * 86_400_000 });
    const keep2 = await seedEvent(2, { ageMs: 40 * 86_400_000 }); // queued: never deleted by age
    await db
      .prepare(
        "INSERT INTO webhook_rejections (connection_id, bucket_at, reason_code, count) VALUES (?1, ?2, 'other', 1), (?1, ?3, 'other', 1)",
      )
      .bind(connId, iso(NOW - 8 * 86_400_000), iso(NOW - 6 * 86_400_000))
      .run();
    const s = spyEnv();
    const r = await housekeepWebhookEvents(s.env, NOW);
    expect(r.deletedEvents).toBe(old);
    expect(r.deletedRejections).toBe(1);
    // 200 + 200 + 50 rows: three DELETE statements for the events, one for the rejections
    expect(s.sql.filter((q) => q.startsWith("DELETE FROM webhook_events"))).toHaveLength(3);
    const left = (await rowsOf("webhook_events")).map((x) => x["id"]);
    expect(left.sort()).toEqual([keep1, keep2].sort());
    expect(await rowsOf("webhook_rejections")).toHaveLength(1);
  });

  it("one run deletes at most 5 batches; the rest waits for the next window", async () => {
    const old = HOUSEKEEPING_BATCH * 5 + 30;
    await db.batch(
      Array.from({ length: old }, (_, i) =>
        db
          .prepare(
            `INSERT INTO webhook_events (connection_id, event_hash, event_type, received_at, status)
             VALUES (?1, ?2, 'x', ?3, 'processed')`,
          )
          .bind(connId, (5000 + i).toString(16).padStart(64, "0"), iso(NOW - 40 * 86_400_000)),
      ),
    );
    const r = await housekeepWebhookEvents(e(), NOW);
    expect(r.deletedEvents).toBe(HOUSEKEEPING_BATCH * 5);
    resetHousekeepingState();
    const r2 = await housekeepWebhookEvents(e(), NOW + HOUSEKEEPING_EVERY_MS + 1000);
    expect(r2.deletedEvents).toBe(30);
  });

  it("is nearly free when idle: no query inside the window, one write-less claim for a second isolate", async () => {
    const s = spyEnv();
    const first = await housekeepWebhookEvents(s.env, NOW);
    expect(first.ran).toBe(true);
    expect(s.sql).toHaveLength(2); // the claim and the single "anything due" query
    await housekeepWebhookEvents(s.env, NOW + 5 * MIN);
    expect(s.sql).toHaveLength(2);
    // another isolate within the same window: one statement, nothing written, no work
    resetHousekeepingState();
    const second = await housekeepWebhookEvents(s.env, NOW + 5 * MIN);
    expect(second.ran).toBe(false);
    expect(s.sql).toHaveLength(3);
  });

  it("is called from the scheduler tick", async () => {
    const id = await seedEvent(1, { ageMs: 20 * MIN });
    await tickScheduler(e(), NOW);
    expect(queue.sent).toEqual([{ type: "revolut_event", webhookEventId: id }]);
  });
});

describe("N2: an unparsed row is only taken over when it is old enough", () => {
  async function unparsedRow(body: string, ageMs: number): Promise<number> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const r = await db
      .prepare(
        `INSERT INTO webhook_events (connection_id, event_hash, event_type, received_at, status)
         VALUES (?1, ?2, 'unparsed', ?3, 'queued')`,
      )
      .bind(connId, hash, new Date(NOW - ageMs).toISOString())
      .run();
    return r.meta.last_row_id;
  }

  it("two overlapping deliveries of one body enqueue nothing while the first is young", async () => {
    await saveWebhookSecret(env, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    const d = valid("tx-1");
    const id = await unparsedRow(d.body, 10_000);
    expect((await deliver(d)).status).toBe(200);
    expect(queue.sent).toEqual([]);
    expect((await rowsOf("webhook_events", `id = ${id}`))[0]).toMatchObject({
      event_type: "unparsed",
      requeue_count: 0,
    });
  });

  it("an unparsed row older than 60 s is taken over once", async () => {
    await saveWebhookSecret(env, connId, WEBHOOK_ID, WEBHOOK_SECRET, ADMIN);
    const d = valid("tx-1");
    const id = await unparsedRow(d.body, 120_000);
    expect((await deliver(d)).status).toBe(200);
    expect((await deliver(d)).status).toBe(200); // the overlapping twin: the row is young again
    expect(queue.sent).toEqual([{ type: "revolut_event", webhookEventId: id }]);
    expect((await rowsOf("webhook_events", `id = ${id}`))[0]).toMatchObject({
      event_type: "TransactionCreated",
      requeue_count: 1,
    });
  });
});

describe("N8: the refresh token expiry is stored when Revolut says it", () => {
  const refreshExpiresAt = async () =>
    (await db
      .prepare("SELECT refresh_expires_at AS r FROM connections")
      .first<{ r: string | null }>())!.r;

  it("stores refresh_token_expires_in on a refresh, keeps it when a later refresh omits it", async () => {
    (await fakeRevolutClock(connId)).t = NOW;
    await db
      .prepare("UPDATE connections SET expires_at = ?1")
      .bind(new Date(NOW + 1000).toISOString())
      .run();
    stub.token = (_f, n) =>
      Response.json({
        access_token: `racc-${n}`,
        token_type: "bearer",
        expires_in: 2400,
        refresh_token_expires_in: 7_776_000,
      });
    await revolutGate(connId).call(rreq(connId));
    expect(await refreshExpiresAt()).toBe(new Date(NOW + 7_776_000_000).toISOString());

    await db
      .prepare("UPDATE connections SET expires_at = ?1")
      .bind(new Date(NOW + 1000).toISOString())
      .run();
    stub.token = (_f, n) => refreshOk(n);
    await revolutGate(connId).call(rreq(connId));
    expect(await refreshExpiresAt()).toBe(new Date(NOW + 7_776_000_000).toISOString());
  });

  it.each([0, -5, 1.5, "abc", 99_999_999_999, null])(
    "ignores an unusable refresh_token_expires_in (%s)",
    async (bad) => {
      (await fakeRevolutClock(connId)).t = NOW;
      await db
        .prepare("UPDATE connections SET expires_at = ?1")
        .bind(new Date(NOW + 1000).toISOString())
        .run();
      stub.token = (_f, n) =>
        Response.json({
          access_token: `racc-${n}`,
          token_type: "bearer",
          expires_in: 2400,
          refresh_token_expires_in: bad,
        });
      await revolutGate(connId).call(rreq(connId));
      expect(await refreshExpiresAt()).toBeNull();
    },
  );

  it("GET /api/connections returns refreshExpiresAt (null = unknown)", async () => {
    const admin = await addSession(await addUser(ADMIN2, ["admin"]));
    const get = async () =>
      (
        (await (await authed("/api/connections", admin)).json()) as {
          connections: { kind: string; refreshExpiresAt: string | null }[];
        }
      ).connections.find((c) => c.kind === "revolut")!.refreshExpiresAt;
    expect(await get()).toBeNull();
    await db
      .prepare("UPDATE connections SET refresh_expires_at = '2027-02-01T00:00:00.000Z'")
      .run();
    expect(await get()).toBe("2027-02-01T00:00:00.000Z");
  });
});
