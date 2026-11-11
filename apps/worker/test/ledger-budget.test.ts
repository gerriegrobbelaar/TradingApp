import { describe, expect, it } from "vitest";
import {
  FULL_SYNC_BUDGET,
  FULL_SYNC_MAX_ATTEMPTS,
  INCREMENTAL_SYNC_BUDGET,
  MAX_INCREMENTAL_RUNS_PER_DAY,
  SCHEDULED_WORST_CASE_CALLS_PER_DAY,
} from "../src/jobs/exact-handlers";
import { CYCLE_MAX_AGE_MS } from "../src/exact/sync";
import { LEDGER_PAGE_SIZE_GUESS, estimateLedgerCalls } from "../src/exact/ledger-sync";

/**
 * Call arithmetic for the ledger sync (ADR 0023). The ledger is read inside the existing full-sync
 * budget (240 Exact calls per administration and attempt, 4 attempts a day), by resuming across
 * runs, so the worst case per administration and day does not move: 1,960 of Exact's 5,000.
 */
describe("ledger call arithmetic", () => {
  it("leaves the scheduled worst case per administration and day where it was", () => {
    expect(FULL_SYNC_MAX_ATTEMPTS * FULL_SYNC_BUDGET).toBe(960);
    expect(MAX_INCREMENTAL_RUNS_PER_DAY * INCREMENTAL_SYNC_BUDGET).toBe(1000);
    expect(SCHEDULED_WORST_CASE_CALLS_PER_DAY).toBe(1960);
    expect(5000 - SCHEDULED_WORST_CASE_CALLS_PER_DAY).toBeGreaterThanOrEqual(500 + 1000);
  });

  it("reads a reference ledger (300 accounts, 12 periods) in 65 calls a night, 155 on the weekly night", () => {
    expect(LEDGER_PAGE_SIZE_GUESS).toBe(60);
    const steady = estimateLedgerCalls({ accounts: 300, balanceYears: 1 });
    const weekly = estimateLedgerCalls({ accounts: 300, balanceYears: 2, budgetAccounts: 150 });
    expect(steady).toBe(5 + 60);
    expect(weekly).toBe(5 + 2 * 60 + 30);
  });

  it("fits one run of 240 calls next to the reference division's open items on a normal night", () => {
    // 5,000 open items and 4,000 relation bank accounts at 60 rows a page, divisions and relations.
    const other = Math.ceil(3000 / 60) + Math.ceil(2000 / 60) + Math.ceil(4000 / 60) + 1 + 1;
    const night = other + estimateLedgerCalls({ accounts: 300, balanceYears: 1 });
    expect(night).toBeLessThanOrEqual(FULL_SYNC_BUDGET);
    // The weekly night, with the previous year and the budgets, needs a second attempt: allowed,
    // the scheduler retries a partial full sync (4 attempts a day).
    const weekly =
      other + estimateLedgerCalls({ accounts: 300, balanceYears: 2, budgetAccounts: 150 });
    expect(weekly).toBeGreaterThan(FULL_SYNC_BUDGET);
    expect(weekly).toBeLessThanOrEqual(FULL_SYNC_MAX_ATTEMPTS * FULL_SYNC_BUDGET);
  });

  it("a very large ledger takes a second night, never more than a cycle may last", () => {
    // 2,000 accounts: 400 calls a year of balances. First read (two years + budgets):
    const first = estimateLedgerCalls({ accounts: 2000, balanceYears: 2, budgetAccounts: 1000 });
    expect(first).toBe(34 + 2 * 400 + 200);
    const perDay = FULL_SYNC_MAX_ATTEMPTS * FULL_SYNC_BUDGET;
    expect(first).toBeGreaterThan(perDay); // more than one day of scheduled full-sync calls
    expect(Math.ceil(first / perDay)).toBe(2);
    // A cycle lasts 36 hours; the nightly run starts 24 hours after the previous one, so a pass
    // that needs a second night still continues. A third night would start a new cycle.
    expect(CYCLE_MAX_AGE_MS).toBe(36 * 3_600_000);
    expect(24 * 3_600_000).toBeLessThan(CYCLE_MAX_AGE_MS);
    expect(48 * 3_600_000).toBeGreaterThan(CYCLE_MAX_AGE_MS);
  });

  it("the hourly run does not grow: it never reads ledger data (tested in ledger-sync.test.ts)", () => {
    expect(INCREMENTAL_SYNC_BUDGET).toBe(40);
  });
});
