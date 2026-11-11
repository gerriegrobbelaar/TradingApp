/**
 * Phase 5 review Q1, reviewer's cases: walk identity under a concurrent reset (S1, N3), bounded
 * failing walks, quarantine bounds and fuzzing (S2), card numbers (S6), counterparty refresh after
 * the TTL (S6), the conflict flag's consumers and newly flagged conflicts (S7, S9), 404 retries
 * mixed with other retries and the dead-letter path (S8), the BIC of a re-checked account (N4).
 * No real timers: clocks are offsets, the client's backoff is a no-op (test/do-namespace.ts).
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleQueue } from "../src/jobs/runner";
import {
  clearStateConflict,
  countStateConflicts,
  listStateConflicts,
} from "../src/revolut/conflicts";
import { COUNTERPARTY_MAX_ATTEMPTS, COUNTERPARTY_TTL_MS } from "../src/revolut/counterparties";
import { EVENT_MAX_ATTEMPTS } from "../src/revolut/events";
import {
  pruneQuarantine,
  QUARANTINE_GAVE_UP_TTL_MS,
  QUARANTINE_MAX_ROWS,
} from "../src/revolut/quarantine";
import {
  BACKFILL_CALL_BUDGET,
  INITIAL_BACKFILL_DAYS,
  requestBackfill,
  resetSyncForReplacedAccounts,
} from "../src/revolut/sync";
import { db } from "./helpers";
import { assertCountsAndCodesOnly } from "./counts-only";
import {
  fakeRevolutClock,
  resetRevolut,
  seedRevolut,
  stubRevolut,
  type RevolutStub,
} from "./revolut-helpers";
import {
  ACC_EUR,
  EventQueue,
  envWithQueue,
  fakeRevolut,
  rowsOf,
  simpleTx,
  type FakeRevolut,
} from "./revolut-r3-helpers";
import {
  ago,
  backfill,
  cpRecord,
  HOUR,
  later,
  rawApi,
  rawLeg,
  rawTx,
  sync,
  type RawApi,
} from "./revolut-q1-helpers";

let connId: number;
let stub: RevolutStub;
let api: FakeRevolut;
let raw: RawApi;

const IBAN_A = "NL91ABNA0417164300";
const IBAN_B = "DE89370400440532013000";
const PAN = "4111111111111111";

beforeEach(async () => {
  await resetRevolut();
  connId = await seedRevolut({ status: "active" });
  stub = stubRevolut();
  api = fakeRevolut();
  raw = rawApi(api);
  stub.api = raw.handle;
});
afterEach(() => stub.restore());

const stateRow = async (entity: string) =>
  db
    .prepare("SELECT * FROM revolut_sync_state WHERE connection_id = ?1 AND entity = ?2")
    .bind(connId, entity)
    .first<Record<string, unknown>>();

/** Every text the app stored that a leak could hide in. */
async function everythingStored(): Promise<string> {
  const parts: unknown[] = [];
  for (const t of [
    "bank_transactions",
    "revolut_quarantine",
    "revolut_sync_state",
    "revolut_counterparties",
    "audit_log",
    "job_runs",
    "webhook_events",
  ]) {
    parts.push(await rowsOf(t));
  }
  return JSON.stringify(parts);
}

/** Calls the stub's handler for /transactions; `onCall(n)` runs before the n-th one (1-based). */
function onTransactions(onCall: (n: number) => Promise<Response | void>): void {
  const inner = raw.handle;
  let n = 0;
  stub.api = async (c) => {
    if (c.url.pathname === "/api/1.0/transactions") {
      n++;
      const r = await onCall(n);
      if (r) return r;
    }
    return inner(c);
  };
}

describe("S1 / N3: a walk that was reset meanwhile cannot write over the reset", () => {
  it("the initial backfill finishing after a reset does not consume the NEW 90-day request", async () => {
    api.transactions = [simpleTx("h-1", { createdAt: ago(24 * 40) })];
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    onTransactions(async (n) => {
      // The sync (or the confirm route) resets the walks while this walk is reading its page.
      if (n === 1) await resetSyncForReplacedAccounts(db, connId);
    });
    const r = await backfill({ trigger: "manual" });
    expect(r).toMatchObject({ status: "partial", code: "walk_superseded" });
    expect(await stateRow("backfill")).toMatchObject({
      requested_days: INITIAL_BACKFILL_DAYS,
      window_from: null,
      cursor: null,
      initial: 0,
    });
    // The next run is the requested 90-day walk, and it completes.
    stub.api = raw.handle;
    const next = await backfill();
    expect(next.summary).toMatchObject({ initial: true, windowDays: 90, complete: true });
    expect((await stateRow("backfill"))?.["requested_days"]).toBeNull();
  });

  it("the poll finishing after a reset does not set a watermark from the forgotten walk", async () => {
    onTransactions(async (n) => {
      if (n === 1) await resetSyncForReplacedAccounts(db, connId);
    });
    const r = await sync();
    expect(r).toMatchObject({ status: "partial", code: "walk_incomplete" });
    expect(await stateRow("transactions")).toMatchObject({
      watermark: null,
      window_from: null,
      cursor: null,
    });
  });

  it("a failing initial walk says so in its summary and in the connection status", async () => {
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    api.failAll = 400;
    const r = await backfill({ trigger: "manual" });
    expect(r).toMatchObject({ status: "error", code: "api_400" });
    expect(r.summary).toMatchObject({ initial: true, initialBackfillPending: true });
    assertCountsAndCodesOnly(r.summary);
  });

  it("a first page that keeps failing costs a bounded number of calls per run and keeps the window", async () => {
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    api.failAll = 503;
    await fakeRevolutClock(connId);
    let window: unknown = undefined;
    for (let i = 0; i < 4; i++) {
      const r = await backfill({ trigger: "manual" });
      expect(r.status).toBe("partial");
      expect(r.callsUsed ?? 0).toBeLessThanOrEqual(BACKFILL_CALL_BUDGET);
      const s = await stateRow("backfill");
      if (window === undefined) window = s?.["window_from"];
      expect(s).toMatchObject({ window_from: window, initial: 1, requested_days: 90 });
    }
  });

  it("missing is counted once across a stop and a resume", async () => {
    api.maxCount = 2;
    api.transactions = Array.from({ length: 6 }, (_, i) =>
      simpleTx(`m-${i}`, { createdAt: ago(2 + i) }),
    );
    onTransactions(async (n) =>
      n === 2 ? new Response(JSON.stringify({ message: "x" }), { status: 400 }) : undefined,
    );
    const first = await backfill();
    expect(first.status).toBe("error");
    expect(first.summary["missing"]).toBe(2);
    stub.api = raw.handle;
    let last = await backfill();
    let guard = 0;
    while (last.status === "partial" && guard++ < 6) last = await backfill();
    expect(last.summary).toMatchObject({ complete: true, missing: 6 });
    expect((await stateRow("backfill"))?.["last_missing"]).toBe(6);
    // A walk over the same rows finds nothing missing.
    const again = await backfill({
      run: {
        id: 2,
        attempt: 1,
        scheduledFor: new Date(Date.now() + 24 * HOUR).toISOString(),
        requestedBy: "system",
      },
    });
    expect(again.summary["missing"]).toBe(0);
  });
});

describe("S2: quarantine bounds and fuzzing", () => {
  it("prunes beyond the cap (least recently seen first) and gave-up rows after 30 days", async () => {
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < QUARANTINE_MAX_ROWS + 5; i++) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO revolut_quarantine (connection_id, external_id, code, first_seen_at, last_seen_at)
             VALUES (?1, ?2, 'bad_shape', ?3, ?3)`,
          )
          .bind(
            connId,
            `q-${i}`,
            new Date(now - (QUARANTINE_MAX_ROWS + 5 - i) * 1000).toISOString(),
          ),
      );
    }
    for (let i = 0; i < stmts.length; i += 400) await db.batch(stmts.slice(i, i + 400));
    await db
      .prepare(
        `UPDATE revolut_quarantine SET gave_up = 1, attempts = 5, last_seen_at = ?2
         WHERE connection_id = ?1 AND external_id IN ('q-1000', 'q-1001')`,
      )
      .bind(connId, new Date(now - QUARANTINE_GAVE_UP_TTL_MS - HOUR).toISOString())
      .run();
    await db
      .prepare(
        "UPDATE revolut_quarantine SET gave_up = 1, attempts = 5 WHERE external_id = 'q-1004'",
      )
      .run();
    const removed = await pruneQuarantine(db, connId, now);
    const left = await rowsOf("revolut_quarantine");
    expect(left.length).toBe(QUARANTINE_MAX_ROWS);
    expect(removed).toBe(5);
    const ids = new Set(left.map((r) => r["external_id"]));
    expect(ids.has("q-1000")).toBe(false); // gave up, last seen 30+ days ago
    expect(ids.has("q-1004")).toBe(true); // gave up but seen recently: still reported
    expect(ids.has("q-0")).toBe(false); // the least recently seen beyond the cap
  });

  it("a malformed page full of IBAN- and card-number-looking text stores codes only", async () => {
    const T = (h: number): string => ago(h / 10);
    raw.rows = [
      rawTx("fz-amount", T(1), [rawLeg("a", { amount: IBAN_A })]),
      rawTx("fz-currency", T(2), [rawLeg("b", { currency: PAN })]),
      rawTx("fz-legid", T(3), [
        { account_id: ACC_EUR, amount: 1, currency: "EUR", description: PAN },
      ]),
      rawTx("fz-stamp", PAN),
      rawTx(`${PAN}`, T(4), [rawLeg("c", { amount: `${IBAN_B} ${PAN}` })]),
      { id: { nested: IBAN_A }, created_at: T(5), legs: [] },
      rawTx("fz-bill", T(6), [rawLeg("d", { bill_amount: PAN, bill_currency: "EUR" })]),
    ];
    const r = await sync();
    expect(r).toMatchObject({ status: "partial", code: "rows_quarantined" });
    assertCountsAndCodesOnly(r.summary);
    const all = await everythingStored();
    expect(all).not.toContain(IBAN_A);
    expect(all).not.toContain(IBAN_B);
    expect(all).not.toContain("ABNA0417");
    for (const q of await rowsOf("revolut_quarantine")) {
      expect(String(q["code"])).toMatch(/^[a-z][a-z0-9_]{0,40}$/);
    }
    // The PAN-looking transaction id is an id (it passes the id rule), never anything else.
    const stored = JSON.stringify(await rowsOf("bank_transactions"));
    expect(stored).not.toContain(PAN);
  });
});

describe("S6: card numbers", () => {
  it("an unmasked card number on the transaction and the leg is reduced to its last four everywhere", async () => {
    raw.rows = [
      rawTx("card-1", ago(0.5), [rawLeg("l", { card: { card_number: PAN } })], {
        card: { card_number: `${PAN} ` },
        merchant: { name: "Shop" },
      }),
    ];
    const r = await sync();
    expect(r.status).toBe("ok");
    const row = (await rowsOf("bank_transactions"))[0];
    expect(row?.["card_last4"]).toBe("1111");
    expect(JSON.stringify(r)).not.toContain("411111");
    expect(await everythingStored()).not.toContain("411111");
  });
});

describe("S6: counterparty cache freshness (TTL)", () => {
  const txFor = (id: string, cp: string, extra: Record<string, unknown> = {}, h = 0.5) =>
    rawTx(id, ago(h), [
      rawLeg(`${id}-l`, {
        counterparty: { id: cp, account_type: "external", name: "Acme", ...extra },
      }),
    ]);
  const ibanOf = async (txId: string) =>
    (await rowsOf("bank_transactions", `external_id = '${txId}'`))[0];

  it("an answer older than 7 days is read again; cached IBANs on unmatched rows follow it", async () => {
    raw.rows = [
      txFor("t-un", "cp-1"),
      txFor("t-m", "cp-1", {}, 0.6),
      txFor("t-direct", "cp-1", { iban: IBAN_A }, 0.7),
    ];
    raw.counterparties.set("cp-1", cpRecord("cp-1", [{ id: "x", iban: IBAN_A, currency: "EUR" }]));
    await sync();
    expect(await ibanOf("t-un")).toMatchObject({
      counterparty_iban: IBAN_A,
      counterparty_iban_cached: 1,
    });
    expect(await ibanOf("t-direct")).toMatchObject({
      counterparty_iban: IBAN_A,
      counterparty_iban_cached: 0,
    });
    await db
      // 'matched' needs a live match since migration 0022; 'ignored' freezes the same way.
      .prepare("UPDATE bank_transactions SET match_status = 'ignored' WHERE external_id = 't-m'")
      .run();
    // The counterparty's IBAN changed at Revolut.
    raw.counterparties.set("cp-1", cpRecord("cp-1", [{ id: "x", iban: IBAN_B, currency: "EUR" }]));
    await sync(later(3 * 24 * HOUR)); // fresh: no call
    expect(raw.counterpartyCalls).toEqual(["cp-1"]);
    await sync(later(COUNTERPARTY_TTL_MS + HOUR));
    expect(raw.counterpartyCalls).toEqual(["cp-1", "cp-1"]);
    expect((await ibanOf("t-un"))?.["counterparty_iban"]).toBe(IBAN_B);
    expect((await ibanOf("t-m"))?.["counterparty_iban"]).toBe(IBAN_A); // matched: frozen
    expect((await ibanOf("t-direct"))?.["counterparty_iban"]).toBe(IBAN_A); // Revolut said so
    expect((await rowsOf("revolut_counterparties"))[0]).toMatchObject({
      status: "ok",
      iban: IBAN_B,
      attempts: 0,
    });
    // The re-delivery of the matched row does not raise a conflict over our own cache change.
    expect((await ibanOf("t-m"))?.["state_conflict"]).toBe(0);
  });

  it("a refresh that fails keeps the last answer and backs off (hourly, then weekly)", async () => {
    raw.rows = [txFor("t1", "cp-1")];
    raw.counterparties.set("cp-1", cpRecord("cp-1", [{ iban: IBAN_A, currency: "EUR" }]));
    await sync();
    raw.counterparties.set("cp-1", 400);
    const base = COUNTERPARTY_TTL_MS + HOUR;
    await sync(later(base));
    expect((await rowsOf("revolut_counterparties"))[0]).toMatchObject({
      status: "ok",
      iban: IBAN_A,
      attempts: 1,
    });
    expect((await ibanOf("t1"))?.["counterparty_iban"]).toBe(IBAN_A);
    await sync(later(base + 10 * 60_000)); // within the hour: no call
    expect(raw.counterpartyCalls).toHaveLength(2);
    for (let i = 1; i <= COUNTERPARTY_MAX_ATTEMPTS + 2; i++) {
      await sync(later(base + i * (HOUR + 60_000)));
    }
    expect(raw.counterpartyCalls).toHaveLength(1 + COUNTERPARTY_MAX_ATTEMPTS);
    // After the bound, once a week.
    await sync(later(base + COUNTERPARTY_TTL_MS + 12 * HOUR));
    expect(raw.counterpartyCalls).toHaveLength(2 + COUNTERPARTY_MAX_ATTEMPTS);
    expect((await rowsOf("revolut_counterparties"))[0]?.["iban"]).toBe(IBAN_A);
  });

  it("an id that failed 5 times is tried again weekly, never parked for good", async () => {
    raw.rows = [txFor("t1", "cp-x")];
    raw.counterparties.set("cp-x", 400);
    for (let i = 0; i <= COUNTERPARTY_MAX_ATTEMPTS + 1; i++) {
      await sync(later(i * (HOUR + 60_000)));
    }
    expect(raw.counterpartyCalls).toHaveLength(COUNTERPARTY_MAX_ATTEMPTS);
    raw.counterparties.set("cp-x", cpRecord("cp-x", [{ iban: IBAN_B, currency: "EUR" }]));
    await sync(later(COUNTERPARTY_TTL_MS + 24 * HOUR));
    expect((await ibanOf("t1"))?.["counterparty_iban"]).toBe(IBAN_B);
  });

  it("not_found is re-checked after the TTL too", async () => {
    raw.rows = [txFor("t1", "cp-late")];
    await sync();
    expect((await rowsOf("revolut_counterparties"))[0]?.["status"]).toBe("not_found");
    raw.counterparties.set("cp-late", cpRecord("cp-late", [{ iban: IBAN_A, currency: "EUR" }]));
    await sync(later(COUNTERPARTY_TTL_MS + HOUR));
    expect((await ibanOf("t1"))?.["counterparty_iban"]).toBe(IBAN_A);
  });
});

describe("S7 / S9: the state_conflict flag", () => {
  it("a newly flagged conflict ends the poll partial once; the flag stays; the next run is ok", async () => {
    api.transactions = [simpleTx("t1", { createdAt: ago(1), state: "completed" })];
    expect((await sync()).status).toBe("ok");
    api.transactions = [
      simpleTx("t1", {
        createdAt: ago(1),
        state: "failed",
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ];
    const r = await sync();
    expect(r).toMatchObject({ status: "partial", code: "state_conflict" });
    expect(r.summary).toMatchObject({ blocked: 1, conflictsFlagged: 1 });
    const again = await sync();
    expect(again.status).toBe("ok");
    expect(again.summary).toMatchObject({ blocked: 1, conflictsFlagged: 0 });
    expect(await countStateConflicts(db, connId)).toBe(1);
  });

  it("a stale pending read of a completed row is counted but not flagged", async () => {
    api.transactions = [simpleTx("t1", { createdAt: ago(1), state: "completed" })];
    await sync();
    api.transactions = [simpleTx("t1", { createdAt: ago(1), state: "pending" })];
    const r = await sync();
    expect(r.status).toBe("ok");
    expect(r.summary).toMatchObject({ blocked: 1, conflictsFlagged: 0 });
    expect(await countStateConflicts(db, connId)).toBe(0);
  });

  it("Phase 7/8 can list and clear the flag; clearing is audited once and returns no IBAN", async () => {
    raw.rows = [
      rawTx("c1", ago(1), [
        rawLeg("l", { counterparty: { id: "cp", name: "Acme", iban: IBAN_A } }),
      ]),
    ];
    await sync();
    await db.prepare("UPDATE bank_transactions SET state_conflict = 1").run();
    const list = await listStateConflicts(db, connId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ externalId: "c1", legId: "l", state: "completed" });
    expect(JSON.stringify(list)).not.toContain(IBAN_A);
    expect(JSON.stringify(list)).not.toContain("Acme");
    const id = list[0]?.id as number;
    expect(await clearStateConflict(db, id, "Finance@Camelthorncapital.com")).toBe(true);
    expect(await clearStateConflict(db, id, "finance@camelthorncapital.com")).toBe(false);
    expect(await countStateConflicts(db, connId)).toBe(0);
    const audits = await rowsOf("audit_log", "action = 'bank_transaction.conflict_cleared'");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_email: "finance@camelthorncapital.com",
      entity_id: String(id),
    });
  });
});

describe("S8: 404 retries among other retries, and the dead-letter path", () => {
  async function queuedEvent(txId: string): Promise<number> {
    const r = await db
      .prepare(
        `INSERT INTO webhook_events (connection_id, event_hash, event_type, external_id)
         VALUES (?1, ?2, 'TransactionCreated', ?3) RETURNING id`,
      )
      .bind(connId, "a".repeat(63) + String(Math.floor(Math.random() * 10)), txId)
      .first<{ id: number }>();
    return r?.id as number;
  }
  interface FakeMsg {
    body: unknown;
    attempts: number;
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  }
  const msg = (id: number, attempts: number): FakeMsg => ({
    body: { type: "revolut_event", webhookEventId: id },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  });
  const consume = (m: FakeMsg, e: Env = envWithQueue(new EventQueue())) =>
    handleQueue({ messages: [m] } as unknown as MessageBatch<unknown>, e);
  const eventRow = async (id: number) =>
    (await rowsOf("webhook_events", `id = ${id}`))[0] as Record<string, unknown>;

  it("rate limit, then 404s: the 404 delays follow the delivery number; the last delivery settles", async () => {
    await fakeRevolutClock(connId);
    const id = await queuedEvent("tx-gone");
    api.failAll = 429;
    const m1 = msg(id, 1);
    await consume(m1);
    expect(m1.retry).toHaveBeenCalledTimes(1);
    api.failAll = null;
    for (const [attempt, delay] of [
      [2, 120],
      [3, 600],
    ] as const) {
      const m = msg(id, attempt);
      await consume(m);
      expect(m.retry).toHaveBeenCalledWith({ delaySeconds: delay });
      expect((await eventRow(id))["status"]).toBe("queued");
    }
    const last = msg(id, EVENT_MAX_ATTEMPTS);
    await consume(last);
    expect(last.ack).toHaveBeenCalled();
    expect(await eventRow(id)).toMatchObject({
      status: "processed",
      error_code: "transaction_not_found",
    });
  });

  it("a rate limit on the last delivery settles as error, never leaves the row queued", async () => {
    await fakeRevolutClock(connId);
    const id = await queuedEvent("tx-1");
    api.failAll = 429;
    const last = msg(id, EVENT_MAX_ATTEMPTS);
    await consume(last);
    expect(last.ack).toHaveBeenCalled();
    expect(await eventRow(id)).toMatchObject({ status: "error", error_code: "rate_limited" });
  });

  it("an exception on the last delivery (it goes to the DLQ next) still settles the row", async () => {
    const id = await queuedEvent("tx-1");
    const broken = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (
              sql.startsWith("SELECT id, connection_id, status, external_id FROM webhook_events")
            ) {
              throw new Error("d1 down");
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const e = Object.create(envWithQueue(new EventQueue()), {
      DB: { value: broken, enumerable: true },
    }) as Env;
    const early = msg(id, 1);
    await consume(early, e);
    expect(early.retry).toHaveBeenCalled();
    expect((await eventRow(id))["status"]).toBe("queued");
    const last = msg(id, EVENT_MAX_ATTEMPTS);
    await consume(last, e);
    expect(last.retry).toHaveBeenCalled(); // the queue moves it to the DLQ
    expect(await eventRow(id)).toMatchObject({ status: "error", error_code: "internal" });
  });
});

describe("N4: a re-checked account gets its BIC", () => {
  it("an account looked up before (bic = '') gets the real BIC when the IBAN arrives", async () => {
    await sync();
    await db
      .prepare(
        `UPDATE bank_accounts SET iban = NULL, bic = '', details_status = 'error', details_attempts = 1,
           details_checked_at = '2026-01-01T00:00:00.000Z' WHERE external_id = ?1`,
      )
      .bind(ACC_EUR)
      .run();
    await sync();
    expect((await rowsOf("bank_accounts", `external_id = '${ACC_EUR}'`))[0]).toMatchObject({
      details_status: "ok",
      bic: "REVOGB21",
    });
  });
});
