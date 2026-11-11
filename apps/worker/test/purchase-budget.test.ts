import { describe, expect, it } from "vitest";
import { PURCHASE_ENTRY_WINDOW_DAYS } from "@camelthorn/core";
import {
  FULL_SYNC_BUDGET,
  FULL_SYNC_MAX_ATTEMPTS,
  INCREMENTAL_SYNC_BUDGET,
  MAX_INCREMENTAL_RUNS_PER_DAY,
  SCHEDULED_WORST_CASE_CALLS_PER_DAY,
} from "../src/jobs/exact-handlers";
import { DEFAULT_CHUNK_PAGES } from "../src/exact/sync";
import { INCREMENTAL_MAX_CHUNKS } from "../src/exact/purchase-sync";

/**
 * Call arithmetic for the purchase-entry sync (ADR 0025). Both reads run inside the existing job
 * budgets (240 Exact calls per full attempt, 40 per hourly run), so the scheduled worst case per
 * administration and day does not move: 4 x 240 + 25 x 40 = 1,960 of Exact's 5,000.
 */
describe("purchase entry call arithmetic", () => {
  const pages = (rows: number, size = 60): number => Math.ceil(rows / size);

  it("leaves the scheduled worst case per administration and day where it was", () => {
    expect(FULL_SYNC_MAX_ATTEMPTS * FULL_SYNC_BUDGET).toBe(960);
    expect(MAX_INCREMENTAL_RUNS_PER_DAY * INCREMENTAL_SYNC_BUDGET).toBe(1000);
    expect(SCHEDULED_WORST_CASE_CALLS_PER_DAY).toBe(
      FULL_SYNC_MAX_ATTEMPTS * FULL_SYNC_BUDGET +
        MAX_INCREMENTAL_RUNS_PER_DAY * INCREMENTAL_SYNC_BUDGET,
    );
    expect(SCHEDULED_WORST_CASE_CALLS_PER_DAY).toBe(1960);
    expect(5000 - SCHEDULED_WORST_CASE_CALLS_PER_DAY).toBeGreaterThanOrEqual(500 + 1000);
  });

  it("an hourly run spends at most 10 of its 40 calls on purchase entries", () => {
    expect(INCREMENTAL_MAX_CHUNKS * DEFAULT_CHUNK_PAGES).toBe(10);
    expect(INCREMENTAL_MAX_CHUNKS * DEFAULT_CHUNK_PAGES).toBeLessThanOrEqual(
      INCREMENTAL_SYNC_BUDGET / 4,
    );
    // and the usual hour is one call: a day of 25 ticks costs 25, not 250
    expect(25 * 1).toBeLessThanOrEqual(MAX_INCREMENTAL_RUNS_PER_DAY);
  });

  it("a night reads a reference division's window in a few dozen calls", () => {
    expect(PURCHASE_ENTRY_WINDOW_DAYS).toBe(120);
    // 150 entries a month = 600 in the window, plus 40 old pending ones: 640 rows
    expect(pages(640)).toBe(11);
    // a busy administration with 1,500 a month: 6,000 rows, 100 calls
    expect(pages(6000)).toBe(100);
    // the reference division's other entities take 153 calls and the ledger 65 (ADR 0024)
    const normalNight = 153 + 65 + pages(640);
    expect(normalNight).toBeLessThanOrEqual(FULL_SYNC_BUDGET);
    expect(normalNight).toBe(229);
    // the busy one needs a second attempt, which the scheduler already gives
    const busy = 153 + 65 + pages(6000);
    expect(busy).toBeGreaterThan(FULL_SYNC_BUDGET);
    expect(busy).toBeLessThanOrEqual(FULL_SYNC_MAX_ATTEMPTS * FULL_SYNC_BUDGET);
  });

  it("an hourly cursor read of the busy administration (30 changes a day) is one call", () => {
    expect(pages(30)).toBe(1);
  });
});
