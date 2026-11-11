/**
 * Phase 5 review Q1, walks: S1 (a failing first page cannot shrink the 90-day initial backfill),
 * S2 (a bad row is quarantined, the rest of the page and the walk go on, rows are retried and give
 * up), S7 (skipped legs and refused state changes end the run partial with a code).
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { INITIAL_BACKFILL_DAYS, requestBackfill } from "../src/revolut/sync";
import { QUARANTINE_MAX_ATTEMPTS, QUARANTINE_RETRY_MS } from "../src/revolut/quarantine";
import { db } from "./helpers";
import { assertCountsAndCodesOnly } from "./counts-only";
import {
  fakeRevolutClock,
  resetRevolut,
  seedRevolut,
  stubRevolut,
  type RevolutStub,
} from "./revolut-helpers";
import { fakeRevolut, rowsOf, simpleTx, type FakeRevolut } from "./revolut-r3-helpers";
import {
  ago,
  backfill,
  ctxFor,
  HOUR,
  later,
  rawApi,
  rawLeg,
  rawTx,
  sync,
  type RawApi,
} from "./revolut-q1-helpers";
import { runRevolutBackfill } from "../src/revolut/sync";

let connId: number;
let stub: RevolutStub;
let api: FakeRevolut;
let raw: RawApi;

const stateRow = async (entity: string) =>
  db
    .prepare("SELECT * FROM revolut_sync_state WHERE connection_id = ?1 AND entity = ?2")
    .bind(connId, entity)
    .first<Record<string, unknown>>();
const quarantine = () => rowsOf("revolut_quarantine");

beforeEach(async () => {
  await resetRevolut();
  connId = await seedRevolut({ status: "active" });
  stub = stubRevolut();
  api = fakeRevolut();
  raw = rawApi(api);
  stub.api = raw.handle;
});
afterEach(() => stub.restore());

describe("S1: a failing first page does not shrink the initial backfill", () => {
  const history = () => [
    simpleTx("h-80", { createdAt: ago(24 * 80) }),
    simpleTx("h-50", { createdAt: ago(24 * 50) }),
    simpleTx("h-10", { createdAt: ago(24 * 10) }),
  ];

  async function expectStillInitial(): Promise<void> {
    expect(await stateRow("backfill")).toMatchObject({
      initial: 1,
      requested_days: INITIAL_BACKFILL_DAYS,
      window_days: INITIAL_BACKFILL_DAYS,
      cursor: null,
    });
    expect((await stateRow("backfill"))?.["window_from"]).toBeTruthy();
  }

  async function finishAndCheck(): Promise<void> {
    const next = await backfill();
    expect(next.status).toBe("ok");
    expect(next.summary).toMatchObject({ initial: true, windowDays: 90, complete: true });
    // All three, including the 80-day-old one a 35-day walk would never have reached.
    expect((await rowsOf("bank_transactions")).map((r) => r["external_id"]).sort()).toEqual([
      "h-10",
      "h-50",
      "h-80",
    ]);
    expect(await stateRow("backfill")).toMatchObject({
      requested_days: null,
      window_from: null,
      initial: 1,
      last_missing: null,
    });
    // The next ordinary run is a 35-day walk again.
    expect((await backfill()).summary).toMatchObject({ initial: false, windowDays: 35 });
  }

  it("a rate limit on the first page: the next run continues the 90-day walk", async () => {
    api.transactions = history();
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    const clock = await fakeRevolutClock(connId);
    api.failAll = 429;
    const first = await backfill({ trigger: "manual" });
    expect(first).toMatchObject({ status: "partial", code: "rate_limited" });
    expect(first.summary).toMatchObject({ initial: true, windowDays: 90, missing: 0, seen: 0 });
    await expectStillInitial();
    api.failAll = null;
    clock.t += 3_600_000;
    await finishAndCheck();
  });

  it("the gate being unavailable: same", async () => {
    api.transactions = history();
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    const down = {
      idFromName: (n: string) => n,
      jurisdiction: () => down,
      get: () => ({
        startJob: async () => {
          throw new Error("gate down");
        },
        endJob: async () => ({ used: 0 }),
      }),
    };
    const brokenEnv = Object.create(env, {
      REVOLUT_GATE: { value: down, enumerable: true },
    }) as Env;
    const first = await runRevolutBackfill(ctxFor("revolut.backfill", { env: brokenEnv }));
    expect(first).toMatchObject({ status: "partial", code: "gate_unavailable" });
    await expectStillInitial();
    await finishAndCheck();
  });

  it("the deadline passing before the first page: the walk is reported initial_backfill_incomplete and resumes", async () => {
    api.transactions = history();
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    const first = await backfill({ trigger: "manual", deadlineMs: Date.now() - 1 });
    expect(first).toMatchObject({ status: "partial", code: "initial_backfill_incomplete" });
    expect(first.summary).toMatchObject({ initial: true, windowDays: 90, missing: 0 });
    await expectStillInitial();
    await finishAndCheck();
  });

  it("an aborted run is the same", async () => {
    api.transactions = history();
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    const ac = new AbortController();
    ac.abort();
    const first = await backfill({ trigger: "manual", signal: ac.signal });
    expect(first.code).toBe("initial_backfill_incomplete");
    await expectStillInitial();
    await finishAndCheck();
  });

  it("a permanent error on the first page keeps the window as well", async () => {
    api.transactions = history();
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    api.failAll = 400;
    expect(await backfill()).toMatchObject({ status: "error", code: "api_400" });
    await expectStillInitial();
    api.failAll = null;
    await finishAndCheck();
  });

  it("the daily run resumes a stalled initial walk instead of starting a 35-day one", async () => {
    api.transactions = history();
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    await backfill({ trigger: "manual", deadlineMs: Date.now() - 1 });
    const daily = await backfill({
      run: {
        id: 9,
        attempt: 1,
        scheduledFor: new Date(Date.now() + 24 * HOUR).toISOString(),
        requestedBy: "system",
      },
    });
    expect(daily.summary).toMatchObject({ initial: true, windowDays: 90, complete: true });
    expect(await rowsOf("bank_transactions")).toHaveLength(3);
  });

  it("an initial request that arrives during a daily walk supersedes it: the next run is the 90-day walk", async () => {
    api.maxCount = 2;
    api.transactions = Array.from({ length: 14 }, (_, i) =>
      simpleTx(`d-${i}`, { createdAt: ago(1 + i) }),
    );
    const first = await backfill();
    expect(first.status).toBe("partial");
    expect(first.summary).toMatchObject({ initial: false, windowDays: 35 });
    const daily = await stateRow("backfill");
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    const next = await backfill({ trigger: "manual" });
    // Not the daily walk resumed: a new 90-day window, and the daily missing count is not recorded.
    expect(next.summary).toMatchObject({ initial: true, windowDays: 90 });
    const mid = await stateRow("backfill");
    expect(mid?.["window_from"]).not.toBe(daily?.["window_from"]);
    expect(mid).toMatchObject({ initial: 1, window_days: 90, requested_days: 90 });
    let guard = 0;
    let last = next;
    while (last.status === "partial" && guard++ < 12) last = await backfill();
    expect(last.status).toBe("ok");
    expect(await stateRow("backfill")).toMatchObject({
      requested_days: null,
      window_from: null,
      last_missing: null,
    });
    expect(await rowsOf("bank_transactions")).toHaveLength(14);
  });

  it("a daily walk keeps going when no initial request is pending (no supersede without one)", async () => {
    api.maxCount = 2;
    api.transactions = Array.from({ length: 6 }, (_, i) =>
      simpleTx(`e-${i}`, { createdAt: ago(1 + i) }),
    );
    await backfill();
    const daily = await stateRow("backfill");
    await backfill();
    expect((await stateRow("backfill"))?.["window_from"]).toBe(daily?.["window_from"]);
  });

  it("the poll keeps its window when its first page fails", async () => {
    await sync();
    const watermark = String((await stateRow("transactions"))?.["watermark"]);
    const inner = raw.handle;
    stub.api = (c) =>
      c.url.pathname === "/api/1.0/transactions" ? new Response("{}", { status: 400 }) : inner(c);
    expect(await sync()).toMatchObject({ status: "error", code: "api_400" });
    const mid = await stateRow("transactions");
    expect(mid?.["window_from"]).toBeTruthy();
    stub.api = inner;
    stub.apiCalls.length = 0;
    await sync();
    const from = stub.apiCalls
      .find((c) => c.url.pathname === "/api/1.0/transactions")
      ?.url.searchParams.get("from");
    expect(from).toBe(mid?.["window_from"]);
    expect(Date.parse(String(from))).toBe(Date.parse(watermark) - 2 * HOUR);
  });
});

describe("S2: per-row quarantine", () => {
  // Hours are tenths of an hour ago, so every row sits inside the poll's two-hour overlap.
  const T = (h: number): string => ago(h / 10);
  const badRows = () => [
    rawTx("q-no-leg-id", T(2), [{ account_id: "x", amount: 1, currency: "EUR" }]),
    rawTx("q-decimals", T(3), [rawLeg("d", { amount: 1.005 })]),
    rawTx("q-zoneless", ago(0.25).replace("Z", "")),
    rawTx(
      "q-many-legs",
      T(4),
      Array.from({ length: 21 }, (_, i) => rawLeg(`l${i}`)),
    ),
    rawTx("q-dup-legs", T(5), [rawLeg("same"), rawLeg("same")]),
  ];

  it("ingests the good rows of a page with all five kinds of bad row, ends partial", async () => {
    api.transactions = [
      simpleTx("good-1", { createdAt: T(1) }),
      simpleTx("good-2", { createdAt: T(6) }),
    ];
    raw.rows = badRows();
    const r = await sync();
    expect(r).toMatchObject({ status: "partial", code: "rows_quarantined" });
    expect(r.summary).toMatchObject({ inserted: 2, quarantined: 5, complete: true });
    expect((await rowsOf("bank_transactions")).map((x) => x["external_id"]).sort()).toEqual([
      "good-1",
      "good-2",
    ]);
    const q = await quarantine();
    // The zone-less row cannot be placed in the order but is still identified; the 21-leg row is
    // refused by the ingest rather than the client.
    expect(q.map((x) => [x["external_id"], x["code"]]).sort()).toEqual([
      ["q-decimals", "bad_shape"],
      ["q-dup-legs", "bad_shape"],
      ["q-many-legs", "too_many_legs"],
      ["q-no-leg-id", "bad_shape"],
      ["q-zoneless", "bad_timestamp"],
    ]);
    // Ids and codes only: no payload text anywhere in the table or the summary.
    expect(JSON.stringify(q)).not.toMatch(/1\.005|Acme|Invoice/);
    assertCountsAndCodesOnly(r.summary);
    expect(await stateRow("transactions")).toMatchObject({
      last_status: "partial",
      last_error: "rows_quarantined",
      cursor: null,
    });
    expect((await stateRow("transactions"))?.["watermark"]).toBeTruthy();
  });

  it("the pending refresh step still runs", async () => {
    await sync();
    api.transactions = [simpleTx("old", { createdAt: T(72), state: "completed", updatedAt: T(1) })];
    await db
      .prepare(
        `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, leg_id, state, amount_minor,
                                        currency, booked_at, created_at, updated_at, source)
         VALUES (?1, (SELECT id FROM bank_accounts WHERE connection_id = ?1 LIMIT 1), 'old', 'old-l1', 'pending',
                 -10050, 'EUR', ?2, ?2, ?3, 'webhook')`,
      )
      .bind(connId, T(72), T(71))
      .run();
    raw.rows = badRows();
    const r = await sync();
    expect(r.summary).toMatchObject({ pendingRefreshed: 1, quarantined: 5 });
    expect((await rowsOf("bank_transactions", "external_id = 'old'"))[0]).toMatchObject({
      state: "completed",
    });
  });

  it("a bad row at a page boundary cannot stall the walk", async () => {
    api.maxCount = 2;
    api.transactions = [
      simpleTx("a", { createdAt: T(1) }),
      simpleTx("b", { createdAt: T(3) }),
      simpleTx("c", { createdAt: T(5) }),
    ];
    raw.rows = [
      rawTx("bad-mid", T(2), [{ amount: "x" }]),
      rawTx("bad-end", T(4), [{ amount: "x" }]),
    ];
    let r = await backfill();
    let guard = 0;
    while (r.status === "partial" && r.code === "walk_incomplete" && guard++ < 6) {
      r = await backfill();
    }
    expect(r).toMatchObject({ status: "partial", code: "rows_quarantined" });
    expect((await rowsOf("bank_transactions")).map((x) => x["external_id"]).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(await stateRow("backfill")).toMatchObject({ cursor: null, window_from: null });
    expect((await quarantine()).map((x) => x["external_id"]).sort()).toEqual([
      "bad-end",
      "bad-mid",
    ]);
  });

  it("the daily backfill quarantines too, and a repeated outcome is audited once", async () => {
    raw.rows = badRows();
    const count = async (): Promise<number> =>
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'revolut.sync_run'")
          .first<{ n: number }>()
      )?.n ?? 0;
    const before = await count();
    await sync();
    await sync();
    await sync();
    // Same standing problem each time: one audit row, not three.
    expect(await count()).toBe(before + 1);
    const b = await backfill();
    expect(b).toMatchObject({ status: "partial", code: "rows_quarantined" });
    expect(b.summary).toMatchObject({ quarantined: 5 });
  });

  it("a row that is fixed later is stored by the retry and leaves the quarantine", async () => {
    raw.rows = [rawTx("fix-me", T(30), [{ amount: "x" }])];
    await sync();
    expect((await quarantine()).map((x) => x["external_id"])).toEqual(["fix-me"]);
    // Revolut now serves a good version of the row.
    raw.rows = [rawTx("fix-me", T(30))];
    const r = await sync(later(2 * HOUR));
    expect(r.summary).toMatchObject({ quarantineRetried: 1, quarantineCleared: 1, inserted: 1 });
    expect(await quarantine()).toEqual([]);
    expect((await rowsOf("bank_transactions")).map((x) => x["external_id"])).toEqual(["fix-me"]);
    expect(r.summary["quarantineOpen"]).toBe(0);
  });

  it("a row stored by a walk leaves the quarantine as well", async () => {
    raw.rows = [rawTx("walk-fix", T(1), [{ amount: "x" }])];
    await sync();
    expect(await quarantine()).toHaveLength(1);
    raw.rows = [rawTx("walk-fix", T(1))];
    await sync();
    expect(await quarantine()).toEqual([]);
  });

  it("gives up after the bounded number of attempts and stops retrying", async () => {
    // Outside the poll window, so only the retry step sees it.
    raw.rows = [rawTx("never", T(30), [{ amount: "x" }])];
    await db
      .prepare(
        `INSERT INTO revolut_quarantine (connection_id, external_id, code, first_seen_at, last_seen_at)
         VALUES (?1, 'never', 'bad_shape', ?2, ?2)`,
      )
      .bind(connId, T(40))
      .run();
    for (let i = 1; i <= QUARANTINE_MAX_ATTEMPTS + 2; i++) {
      await sync(later(i * (QUARANTINE_RETRY_MS + 60_000)));
    }
    expect((await quarantine())[0]).toMatchObject({
      attempts: QUARANTINE_MAX_ATTEMPTS,
      gave_up: 1,
    });
    const reads = stub.apiCalls.filter((c) => c.url.pathname === "/api/1.0/transaction/never");
    expect(reads).toHaveLength(QUARANTINE_MAX_ATTEMPTS);
  });

  it("retries at most once per hour, and a transaction Revolut no longer has is cleared", async () => {
    await db
      .prepare(
        `INSERT INTO revolut_quarantine (connection_id, external_id, code, first_seen_at, last_seen_at)
         VALUES (?1, 'gone', 'bad_shape', ?2, ?2)`,
      )
      .bind(connId, T(40))
      .run();
    raw.rows = [rawTx("gone", T(30), [{ amount: "x" }])];
    await sync(); // the walk meets it (inside its first 24 hours): the walk, not the retry, handles it
    expect((await quarantine())[0]).toMatchObject({ attempts: 0 });
    await sync(); // now it is outside the poll window: one retry
    expect((await quarantine())[0]).toMatchObject({ attempts: 1 });
    await sync(); // within the hour: not read again
    expect((await quarantine())[0]).toMatchObject({ attempts: 1 });
    raw.rows = [];
    await sync(later(2 * HOUR));
    expect(await quarantine()).toEqual([]);
  });

  describe("the quarantine retry and errors from Revolut", () => {
    async function seedOne(): Promise<void> {
      await db
        .prepare(
          `INSERT INTO revolut_quarantine (connection_id, external_id, code, first_seen_at, last_seen_at)
           VALUES (?1, 'rl', 'bad_shape', ?2, ?2)`,
        )
        .bind(connId, T(40))
        .run();
    }
    const failSingle = (status: number) => {
      const inner = raw.handle;
      stub.api = (c) =>
        c.url.pathname.startsWith("/api/1.0/transaction/")
          ? new Response("{}", { status, headers: status === 429 ? { "retry-after": "1" } : {} })
          : inner(c);
    };
    const singleCalls = () =>
      stub.apiCalls.filter((c) => c.url.pathname === "/api/1.0/transaction/rl").length;

    it("a 4xx for the one transaction counts as an attempt (so it gives up in the end)", async () => {
      await seedOne();
      failSingle(400);
      await sync();
      expect((await quarantine())[0]).toMatchObject({ attempts: 1, gave_up: 0 });
      for (let i = 1; i <= QUARANTINE_MAX_ATTEMPTS + 2; i++) {
        await sync(later(i * (QUARANTINE_RETRY_MS + 60_000)));
      }
      expect((await quarantine())[0]).toMatchObject({
        attempts: QUARANTINE_MAX_ATTEMPTS,
        gave_up: 1,
      });
      expect(singleCalls()).toBe(QUARANTINE_MAX_ATTEMPTS);
    });

    it("a 5xx is not an attempt, but the row waits an hour: no call every poll", async () => {
      await seedOne();
      failSingle(503);
      await fakeRevolutClock(connId); // the client's 5xx backoff and the gate's waits are not real
      await sync();
      const after = singleCalls();
      expect(after).toBeGreaterThan(0);
      expect((await quarantine())[0]).toMatchObject({ attempts: 0, gave_up: 0 });
      expect((await quarantine())[0]?.["last_attempt_at"]).toBeTruthy();
      await sync(later(10 * 60_000));
      await sync(later(20 * 60_000));
      expect(singleCalls()).toBe(after);
      await sync(later(QUARANTINE_RETRY_MS + 60_000));
      expect(singleCalls()).toBeGreaterThan(after);
      expect((await quarantine())[0]).toMatchObject({ attempts: 0, gave_up: 0 });
    });

    it("a rate limit records nothing at all: it is nobody's verdict on the row", async () => {
      await seedOne();
      await fakeRevolutClock(connId);
      failSingle(429);
      await sync();
      expect((await quarantine())[0]).toMatchObject({
        attempts: 0,
        gave_up: 0,
        last_attempt_at: null,
      });
    });
  });
});

describe("S7: legs without our account and refused state changes", () => {
  it("counts skipped legs, ends partial with legs_skipped, and stores the count per row", async () => {
    raw.rows = [rawTx("two-legs", ago(1), [rawLeg("a"), rawLeg("b", { account_id: undefined })])];
    const r = await sync();
    expect(r).toMatchObject({ status: "partial", code: "legs_skipped" });
    expect(r.summary).toMatchObject({ skippedLegs: 1, inserted: 1, complete: true });
    const rows = await rowsOf("bank_transactions");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ skipped_legs: 1, state_conflict: 0 });
  });

  it("a transaction with only foreign legs is counted but stores nothing", async () => {
    raw.rows = [rawTx("foreign", ago(1), [rawLeg("a", { account_id: undefined })])];
    const r = await sync();
    expect(r).toMatchObject({ status: "partial", code: "legs_skipped" });
    expect(await rowsOf("bank_transactions")).toEqual([]);
  });

  it("quarantine wins over legs_skipped as the code, both counts are in the summary", async () => {
    raw.rows = [
      rawTx("two-legs", ago(1), [rawLeg("a"), rawLeg("b", { account_id: undefined })]),
      rawTx("bad", ago(2), [{ amount: "x" }]),
    ];
    const r = await sync();
    expect(r.code).toBe("rows_quarantined");
    expect(r.summary).toMatchObject({ skippedLegs: 1, quarantined: 1 });
  });

  it("the backfill reports skipped legs too", async () => {
    raw.rows = [rawTx("x", ago(5), [rawLeg("a"), rawLeg("b", { account_id: undefined })])];
    const r = await backfill();
    expect(r).toMatchObject({ status: "partial", code: "legs_skipped" });
    expect(r.summary).toMatchObject({ skippedLegs: 1, complete: true });
  });

  it("a refused state change flags the row and is counted in the summary", async () => {
    api.transactions = [simpleTx("t1", { createdAt: ago(1), state: "completed" })];
    await sync();
    // Revolut now says failed: completed -> failed is not a legal change.
    api.transactions = [
      simpleTx("t1", {
        createdAt: ago(1),
        state: "failed",
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ];
    const r = await sync();
    expect(r.summary).toMatchObject({ blocked: 1 });
    expect((await rowsOf("bank_transactions"))[0]).toMatchObject({
      state: "completed",
      state_conflict: 1,
    });
  });

  it("a quiet poll afterwards is ok again", async () => {
    raw.rows = [rawTx("only", ago(1))];
    expect((await sync()).status).toBe("ok");
  });
});
