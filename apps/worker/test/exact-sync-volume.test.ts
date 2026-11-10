import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ExactBudgetExhaustedError } from "@camelthorn/exact";
import {
  SCHEDULED_FULL_BUDGET,
  SCHEDULED_INCREMENTAL_BUDGET,
  SCHEDULED_WORST_CASE_CALLS_PER_DAY,
  runScheduledExactSync,
} from "../src/exact/scheduled";
import { MANUAL_SYNC_BUDGET } from "../src/exact/sync-routes";
import {
  newMeter,
  syncDivision,
  type EntityName,
  type SubrequestMeter,
  type SyncSummary,
} from "../src/exact/sync";
import { FakeExact, addDivision, db, fakeGate, resetSync, type FakeItem } from "./sync-helpers";

/**
 * Volume tests (review G1): the reference division of the Phase 2 review end to end through
 * syncDivision / runScheduledExactSync with a scripted transport that enforces the gate's job
 * budget. 10,000 relations, 4,000 relation bank accounts, 5,000 open items (3,000 receivables,
 * 2,000 payables). Exact's page sizes are an assumption (60 on list endpoints, 1,000 on sync
 * endpoints), so the matrix also covers 60 everywhere and 1,000 everywhere.
 */
const RELATIONS = 10_000;
const BANKS = 4_000;
const RECEIVABLES = 3_000;
const PAYABLES = 2_000;

const MATRIX = [
  { label: "list 60, sync 1,000", list: 60, sync: 1000 },
  { label: "list 60, sync 60 (worst case)", list: 60, sync: 60 },
  { label: "list 1,000, sync 1,000", list: 1000, sync: 1000 },
];

const openItem = (i: number, from: number): FakeItem => ({
  n: from + i,
  account: (i % RELATIONS) + 1,
  name: `Relation ${(i % RELATIONS) + 1}`,
  amount: 10 + (i % 990),
  currency: "EUR",
  invoiceNumber: from + i,
  ts: from + i,
});

function referenceExact(exactDivision: number, list: number, sync: number): FakeExact {
  const fx = new FakeExact(exactDivision);
  fx.divisions = [{ code: exactDivision, description: "Reference BV" }];
  fx.listPageSize = list;
  fx.syncPageSize = sync;
  fx.accounts = Array.from({ length: RELATIONS }, (_, i) => ({
    n: i + 1,
    name: `Relation ${i + 1}`,
    ts: i + 1,
    customer: i % 2 === 0,
    supplier: i % 2 === 1,
  }));
  fx.banks = Array.from({ length: BANKS }, (_, i) => ({
    n: i + 1,
    account: i + 1,
    iban: `NL00TEST${String(i + 1).padStart(10, "0")}`,
  }));
  fx.receivables = Array.from({ length: RECEIVABLES }, (_, i) => openItem(i, 100_000));
  fx.payables = Array.from({ length: PAYABLES }, (_, i) => openItem(i, 200_000));
  return fx;
}

/** A gate that spends a per-job budget: the call after the last one is refused, not delivered. */
function budgetedGate(fx: FakeExact) {
  let used = 0;
  let budget = 0;
  let rejected = 0;
  const gate = fakeGate({
    startJob: async (_id, b) => {
      used = 0;
      budget = b ?? 0;
    },
    endJob: async () => ({ used }),
  });
  fx.beforeCall = () => {
    if (used >= budget) {
      rejected++;
      throw new ExactBudgetExhaustedError("x");
    }
    used++;
  };
  return { gate, delivered: () => fx.calls.length - rejected };
}

const counts = async (divisionId: number) => ({
  relations:
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM relations WHERE division_id = ?1")
        .bind(divisionId)
        .first<{ n: number }>()
    )?.n ?? 0,
  open:
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM open_items WHERE division_id = ?1 AND status = 'open'")
        .bind(divisionId)
        .first<{ n: number }>()
    )?.n ?? 0,
  closed:
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM open_items WHERE division_id = ?1 AND status = 'closed'",
        )
        .bind(divisionId)
        .first<{ n: number }>()
    )?.n ?? 0,
  ibans:
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM relations WHERE division_id = ?1 AND iban IS NOT NULL")
        .bind(divisionId)
        .first<{ n: number }>()
    )?.n ?? 0,
});

const rowsOf = (s: SyncSummary): number =>
  (Object.keys(s.entities) as EntityName[]).reduce((n, e) => n + s.entities[e].rows, 0);

describe.each(MATRIX)("reference division, $label", ({ list, sync }) => {
  beforeEach(resetSync);

  it("the scheduled day stays under the budgets, every run advances, and the night completes", async () => {
    const div = await addDivision();
    const fx = referenceExact(div.exactDivision, list, sync);
    const { gate, delivered } = budgetedGate(fx);

    // Winter day: Amsterdam is UTC+1, so 23:00Z on the 14th is 00:00 on the 15th.
    const firstTick = Date.parse("2026-01-14T23:00:00Z");
    let dayCalls = 0;
    let completedAtTick: number | null = null;
    let maxSubrequests = 0;
    for (let tick = 0; tick < 24; tick++) {
      const at = firstTick + tick * 3_600_000;
      const meter: SubrequestMeter = newMeter();
      const before = delivered();
      const r = await runScheduledExactSync(
        env,
        at,
        { transport: fx.transport, gate, now: () => at },
        meter,
      );
      const used = delivered() - before;
      dayCalls += used;
      maxSubrequests = Math.max(maxSubrequests, meter.used);
      expect(meter.used).toBeLessThanOrEqual(meter.limit);
      expect(r.ran).toHaveLength(1);
      const ran = r.ran[0];
      expect(ran?.status === "ok" || ran?.status === "partial").toBe(true);

      const local = tick; // local hour of the day: tick 0 is 00:00
      const inWindow = local >= 2 && local <= 5;
      if (!inWindow) expect(ran?.mode).toBe("incremental");
      expect(used).toBeLessThanOrEqual(
        ran?.mode === "full" ? SCHEDULED_FULL_BUDGET : SCHEDULED_INCREMENTAL_BUDGET,
      );

      // Forward progress: a tick that ends partial must have written rows or finished work.
      if (ran?.status === "partial") {
        const run = await db
          .prepare("SELECT rows_seen FROM sync_state WHERE division_id = ?1 AND entity = 'run'")
          .bind(div.id)
          .first<{ rows_seen: number }>();
        expect(run?.rows_seen ?? 0).toBeGreaterThan(0);
      }

      const full = await db
        .prepare(
          "SELECT last_full_completed_at AS t FROM sync_state WHERE division_id = ?1 AND entity = 'run'",
        )
        .bind(div.id)
        .first<{ t: string | null }>();
      if (full?.t && completedAtTick === null) completedAtTick = tick;

      // The incremental cursors of the open items start at 0 after the full sync and walk the
      // sync endpoint once (ADR 0017), inside the hourly budget; after that an hour without
      // changes costs a handful of calls.
      if (completedAtTick !== null && tick > completedAtTick) {
        expect(ran?.mode).toBe("incremental");
        if (tick >= completedAtTick + 5) expect(used).toBeLessThanOrEqual(6);
      }
    }

    // The reference division is complete inside the 02:00-05:59 window.
    expect(completedAtTick).not.toBeNull();
    expect(completedAtTick as number).toBeGreaterThanOrEqual(2);
    expect(completedAtTick as number).toBeLessThanOrEqual(5);
    expect(await counts(div.id)).toEqual({
      relations: RELATIONS,
      open: RECEIVABLES + PAYABLES,
      closed: 0,
      ibans: BANKS,
    });
    expect(dayCalls).toBeLessThanOrEqual(SCHEDULED_WORST_CASE_CALLS_PER_DAY);
    // Leaves most of Exact's 5,000 calls a day for users and later jobs.
    expect(dayCalls).toBeLessThanOrEqual(2000);
    expect(maxSubrequests).toBeLessThan(1000);
  }, 300_000);

  it("a second night re-reads everything, closes only what is gone and stays in budget", async () => {
    const div = await addDivision();
    const fx = referenceExact(div.exactDivision, list, sync);
    const { gate, delivered } = budgetedGate(fx);
    const night = Date.parse("2026-01-15T01:00:00Z"); // 02:00 local
    for (let tick = 0; tick < 4; tick++) {
      const at = night + tick * 3_600_000;
      await runScheduledExactSync(env, at, { transport: fx.transport, gate, now: () => at });
    }
    expect((await counts(div.id)).open).toBe(RECEIVABLES + PAYABLES);

    // Next day: 100 receivables are paid in Exact (3.3 %, under the close guard).
    fx.receivables = fx.receivables.slice(100);
    const before = delivered();
    let nightCalls = 0;
    let done = false;
    for (let tick = 0; tick < 4 && !done; tick++) {
      const at = night + 24 * 3_600_000 + tick * 3_600_000;
      const calls0 = delivered();
      const r = await runScheduledExactSync(env, at, {
        transport: fx.transport,
        gate,
        now: () => at,
      });
      nightCalls += delivered() - calls0;
      expect(r.ran[0]?.mode).toBe("full");
      done = r.ran[0]?.status === "ok";
    }
    expect(done).toBe(true);
    expect(nightCalls).toBe(delivered() - before);
    expect(nightCalls).toBeLessThanOrEqual(4 * SCHEDULED_FULL_BUDGET);
    expect(await counts(div.id)).toMatchObject({
      open: RECEIVABLES - 100 + PAYABLES,
      closed: 100,
    });
  }, 300_000);

  it("manual full slices at the route's call budget each advance and finish the pass", async () => {
    const div = await addDivision();
    const fx = referenceExact(div.exactDivision, list, sync);
    const { gate, delivered } = budgetedGate(fx);
    let slices = 0;
    let total = 0;
    let finished = false;
    let lastRows = -1;
    while (!finished && slices < 40) {
      slices++;
      const before = delivered();
      const s = await syncDivision(
        env,
        div,
        {
          jobId: `manual-${slices}`,
          mode: "full",
          budget: MANUAL_SYNC_BUDGET,
          actor: "fin@camelthorncapital.com",
          deadlineMs: Date.now() + 600_000,
          guaranteeProgress: true,
          readIbans: false,
        },
        { transport: fx.transport, gate },
      );
      total += delivered() - before;
      expect(delivered() - before).toBeLessThanOrEqual(MANUAL_SYNC_BUDGET);
      expect(delivered() - before).toBeGreaterThan(0);
      finished = s.cycleComplete;
      if (!finished) {
        expect(s.status).toBe("partial");
        expect(rowsOf(s)).toBeGreaterThan(0); // forward progress in every slice
        lastRows = rowsOf(s);
      }
    }
    if (list === 60) expect(slices).toBeGreaterThan(1);
    expect(lastRows).toBeGreaterThanOrEqual(-1);
    expect(finished).toBe(true);
    expect(await counts(div.id)).toMatchObject({
      relations: RELATIONS,
      open: RECEIVABLES + PAYABLES,
      closed: 0,
      ibans: 0, // manual runs leave the IBANs to the nightly run
    });
    // About (pages of the pass) / (budget per slice) slices; the cap is a sanity bound.
    expect(slices).toBeLessThanOrEqual(40);
    expect(total).toBeGreaterThan(0);
  }, 300_000);
});
