import {
  GLOBAL_MIN_INTERVAL_MINUTES,
  MAX_PROJECTED_EXACT_CALLS_PER_DAY,
  amsterdamParts,
  checkScheduleRules,
  nextRun,
  projectedExactCalls,
  type ExactJobLoad,
} from "@camelthorn/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AWAITING_LIVE_VERIFICATION,
  DEFAULT_JOBS,
  resetDefaultJobsMemoForTests,
  seedDefaultJobs,
} from "../src/jobs/defaults";
import {
  FULL_SYNC_MAX_ATTEMPTS,
  SCHEDULED_WORST_CASE_CALLS_PER_DAY,
} from "../src/jobs/exact-handlers";
import { HANDLERS } from "../src/jobs/handlers";
import { db } from "./job-helpers";

const loadOf = (name: string): ExactJobLoad => {
  const j = DEFAULT_JOBS.find((x) => x.name === name);
  if (!j) throw new Error(`no default job ${name}`);
  return {
    schedule: j.schedule,
    budget: j.exactBudget,
    maxAttempts: HANDLERS[j.handler]?.maxAttempts ?? 1,
    ...(HANDLERS[j.handler]?.dailyExactCallCap !== undefined
      ? { dailyCap: HANDLERS[j.handler]?.dailyExactCallCap as number }
      : {}),
  };
};

describe("default jobs against the schedule rules and the Exact budget cap", () => {
  it("every default schedule is allowed for its own handler", () => {
    for (const j of DEFAULT_JOBS) {
      expect(checkScheduleRules(j.schedule, HANDLERS[j.handler]?.scheduleRules), j.name).toBeNull();
    }
  });

  it("no handler rule asks for less than the global floor", () => {
    for (const [key, h] of Object.entries(HANDLERS)) {
      expect(
        h.scheduleRules?.minIntervalMinutes ?? GLOBAL_MIN_INTERVAL_MINUTES,
        key,
      ).toBeGreaterThanOrEqual(GLOBAL_MIN_INTERVAL_MINUTES);
    }
  });

  it("the two Exact sync jobs project to exactly the 1,960 calls of ADR 0017", () => {
    const sync = projectedExactCalls([loadOf("exact.full_sync"), loadOf("exact.incremental_sync")]);
    expect(sync).toBe(1960);
    expect(sync).toBe(SCHEDULED_WORST_CASE_CALLS_PER_DAY);
    // Derived the long way too: real nextRun fires on the 25-hour autumn day.
    const fires = (expr: string): number => {
      let n = 0;
      let at = Date.parse("2026-10-24T22:00:00Z") - 1; // 00:00 on the 25th in Amsterdam
      for (;;) {
        const f = nextRun({ kind: "cron", expr }, at);
        if (f === null || amsterdamParts(f).date !== "2026-10-25") return n;
        n++;
        at = f;
      }
    };
    expect(fires("30 * * * *") * 40 + fires("0 2 * * *") * 240 * FULL_SYNC_MAX_ATTEMPTS).toBe(1960);
  });

  it("all default Exact jobs switched on together stay under the cap (about 2,960)", () => {
    const all = projectedExactCalls(
      DEFAULT_JOBS.filter((j) => HANDLERS[j.handler]?.usesExact).map((j) => loadOf(j.name)),
    );
    // 1,960 (sync) + 600 (earlier jobs) + 400 (booking daily cap, ADR 0044)
    expect(all).toBe(2960);
    expect(all).toBeLessThanOrEqual(MAX_PROJECTED_EXACT_CALLS_PER_DAY);
  });
});

describe("S6: the Exact sync jobs ship disabled (the public ECB import is the one exception)", () => {
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM job_runs"),
      db.prepare("DELETE FROM jobs"),
      db.prepare("DELETE FROM settings WHERE key = 'seed.default_jobs'"),
    ]);
    resetDefaultJobsMemoForTests();
  });

  it("new installs get them disabled with the reason code; only the public ECB import and the internal bank matching are enabled", async () => {
    for (const n of ["exact.full_sync", "exact.incremental_sync"]) {
      const j = DEFAULT_JOBS.find((x) => x.name === n);
      expect(j).toMatchObject({ enabled: false, disabledReason: AWAITING_LIVE_VERIFICATION });
    }
    // The data quality checks read D1 only (ADR 0045), so they ship on as well.
    expect(DEFAULT_JOBS.filter((j) => j.enabled).map((j) => j.name)).toEqual([
      "bank.match",
      "ecb.fx_import",
      "dq.checks",
      "dq.digest",
    ]);
    expect(DEFAULT_JOBS.find((j) => j.name === "ecb.fx_import")?.exactBudget).toBe(0);
    await seedDefaultJobs(db);
    const rows = await db
      .prepare("SELECT name, enabled, next_run_at FROM jobs WHERE name LIKE 'exact.%sync'")
      .all<{ name: string; enabled: number; next_run_at: string | null }>();
    expect(rows.results).toHaveLength(2);
    for (const r of rows.results) expect(r).toMatchObject({ enabled: 0, next_run_at: null });
  });

  it("an existing, enabled row is never flipped by a later seed", async () => {
    await db
      .prepare(
        `INSERT INTO jobs (name, handler, kind, schedule_json, enabled, exact_budget, created_at)
         VALUES ('exact.full_sync', 'exact.full_sync', 'system', '{"kind":"cron","expr":"0 3 * * *"}', 1, 100, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    await seedDefaultJobs(db);
    const row = await db
      .prepare(
        "SELECT enabled, exact_budget, schedule_json FROM jobs WHERE name = 'exact.full_sync'",
      )
      .first<{ enabled: number; exact_budget: number; schedule_json: string }>();
    expect(row).toMatchObject({ enabled: 1, exact_budget: 100 });
    expect(row?.schedule_json).toContain("0 3 * * *");
  });
});
