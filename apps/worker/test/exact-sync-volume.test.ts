import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ExactBudgetExhaustedError } from "@camelthorn/exact";
import {
  FULL_SYNC_BUDGET,
  FULL_SYNC_MAX_ATTEMPTS,
  INCREMENTAL_SYNC_BUDGET,
  SCHEDULED_WORST_CASE_CALLS_PER_DAY,
} from "../src/jobs/exact-handlers";
import { callExact } from "./job-helpers";
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
 * syncDivision / callExact with a scripted transport that enforces the gate's job
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

    // Winter day: Amsterdam is UTC+1, so 23:00Z on the 14th is 00:00 on the 15th. The full job
    // fires at 02:00 and is re-queued 5 minutes after each partial run (at most 4 attempts); the
    // incremental job fires at half past every hour.
    const dayStart = Date.parse("2026-01-14T23:00:00Z");
    let dayCalls = 0;
    let maxSubrequests = 0;
    let fullAttempts = 0;
    let completedHour: number | null = null;
    const runJob = async (mode: "full" | "incremental", t: number) => {
      const meter: SubrequestMeter = newMeter();
      const before = delivered();
      const r = await callExact(
        mode,
        t,
        { transport: fx.transport, gate, now: () => t },
        { meter, runId: t },
      );
      const used = delivered() - before;
      dayCalls += used;
      maxSubrequests = Math.max(maxSubrequests, meter.used);
      expect(meter.used).toBeLessThanOrEqual(meter.limit);
      expect(used).toBeLessThanOrEqual(
        mode === "full" ? FULL_SYNC_BUDGET : INCREMENTAL_SYNC_BUDGET,
      );
      expect(r.status === "ok" || r.status === "partial").toBe(true);
      // Forward progress: a run that ends partial must have written rows or finished work.
      if (r.status === "partial") {
        const run = await db
          .prepare("SELECT rows_seen FROM sync_state WHERE division_id = ?1 AND entity = 'run'")
          .bind(div.id)
          .first<{ rows_seen: number }>();
        expect(run?.rows_seen ?? 0).toBeGreaterThan(0);
      }
      return { r, used };
    };
    for (let h = 0; h < 24; h++) {
      const hourStart = dayStart + h * 3_600_000;
      if (h === 2) {
        let r;
        do {
          fullAttempts++;
          r = (await runJob("full", hourStart + (fullAttempts - 1) * 300_000)).r;
        } while (r.retry && fullAttempts < FULL_SYNC_MAX_ATTEMPTS);
        if (r.status === "ok") completedHour = h;
      }
      // The incremental cursors of the open items start at 0 after the full sync and walk the
      // sync endpoint once (ADR 0017), inside the hourly budget; after that an hour without
      // changes costs a handful of calls.
      const { used } = await runJob("incremental", hourStart + 30 * 60_000);
      if (completedHour !== null && h >= completedHour + 5) expect(used).toBeLessThanOrEqual(6);
    }

    // The reference division is complete within the full job's attempts.
    expect(completedHour).toBe(2);
    expect(fullAttempts).toBeLessThanOrEqual(FULL_SYNC_MAX_ATTEMPTS);
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
    const fullNight = async (start: number) => {
      let attempts = 0;
      let calls = 0;
      let r;
      do {
        const t = start + attempts * 300_000;
        attempts++;
        const before = delivered();
        r = await callExact(
          "full",
          t,
          { transport: fx.transport, gate, now: () => t },
          { runId: t },
        );
        calls += delivered() - before;
      } while (r.retry && attempts < FULL_SYNC_MAX_ATTEMPTS);
      return { r, calls, attempts };
    };
    expect((await fullNight(night)).r.status).toBe("ok");
    expect((await counts(div.id)).open).toBe(RECEIVABLES + PAYABLES);

    // Next day: 100 receivables are paid in Exact (3.3 %, under the close guard).
    fx.receivables = fx.receivables.slice(100);
    const second = await fullNight(night + 24 * 3_600_000);
    expect(second.r.status).toBe("ok");
    expect(second.calls).toBeLessThanOrEqual(FULL_SYNC_MAX_ATTEMPTS * FULL_SYNC_BUDGET);
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
