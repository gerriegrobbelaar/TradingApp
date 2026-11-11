/**
 * The Revolut jobs as defaults (task R3a): revolut.sync stays as it was (disabled, 10 minutes),
 * revolut.backfill is new (daily 03:15, disabled), both ship "awaiting live verification", the
 * schedule rules hold, and an installation seeded before this release gets the new job without any
 * existing row being touched.
 */
import { checkScheduleRules, type Schedule } from "@camelthorn/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AWAITING_LIVE_VERIFICATION,
  DEFAULT_JOBS_VERSION,
  defaultJobFor,
  resetDefaultJobsMemoForTests,
  seedDefaultJobs,
} from "../src/jobs/defaults";
import { HANDLERS } from "../src/jobs/handlers";
import { db } from "./job-helpers";

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM job_runs"),
    db.prepare("DELETE FROM jobs"),
    db.prepare("DELETE FROM settings WHERE key = 'seed.default_jobs'"),
  ]);
  resetDefaultJobsMemoForTests();
});

const cron = (expr: string): Schedule => ({ kind: "cron", expr });

describe("revolut jobs", () => {
  it("are defaults, implemented and switched off until the first live checks", () => {
    for (const name of ["revolut.sync", "revolut.backfill"]) {
      const d = defaultJobFor(name);
      expect(d, name).toBeDefined();
      expect(d?.enabled).toBe(false);
      expect(d?.disabledReason).toBe(AWAITING_LIVE_VERIFICATION);
      expect(d?.exactBudget).toBe(0);
      expect(typeof HANDLERS[name]?.run).toBe("function");
      expect(HANDLERS[name]?.usesExact).toBe(false);
    }
    expect(defaultJobFor("revolut.sync")?.schedule).toEqual(cron("*/10 * * * *"));
    expect(defaultJobFor("revolut.backfill")?.schedule).toEqual(cron("15 3 * * *"));
  });

  it("the defaults satisfy their own schedule rules", () => {
    for (const name of ["revolut.sync", "revolut.backfill"]) {
      const d = defaultJobFor(name) as NonNullable<ReturnType<typeof defaultJobFor>>;
      expect(checkScheduleRules(d.schedule, HANDLERS[name]?.scheduleRules), name).toBeNull();
    }
  });

  it("the sync runs every 5 to 15 minutes; the backfill at most every 12 hours", () => {
    const sync = HANDLERS["revolut.sync"]?.scheduleRules;
    expect(checkScheduleRules(cron("*/5 * * * *"), sync)).toBeNull();
    expect(checkScheduleRules(cron("*/15 * * * *"), sync)).toBeNull();
    expect(checkScheduleRules(cron("*/3 * * * *"), sync)).not.toBeNull();
    expect(checkScheduleRules(cron("0 * * * *"), sync)).not.toBeNull();
    const bf = HANDLERS["revolut.backfill"]?.scheduleRules;
    expect(checkScheduleRules(cron("15 3 * * *"), bf)).toBeNull();
    expect(checkScheduleRules(cron("15 */6 * * *"), bf)).not.toBeNull();
    expect(checkScheduleRules(cron("*/10 * * * *"), bf)).not.toBeNull();
  });

  it("lateness and attempts are bounded", () => {
    expect(HANDLERS["revolut.sync"]).toMatchObject({ maxAttempts: 1, maxLatenessMs: 30 * 60_000 });
    expect(HANDLERS["revolut.backfill"]?.maxAttempts).toBeGreaterThan(1);
    expect(HANDLERS["revolut.backfill"]?.maxLatenessMs).toBeGreaterThan(0);
  });
});

describe("seeding an installation that predates revolut.backfill", () => {
  it("adds the new job, leaves every existing row (including admin edits) alone", async () => {
    expect(DEFAULT_JOBS_VERSION).toBeGreaterThanOrEqual(2);
    // The state of a version-1 installation: eight jobs, one edited by an admin.
    await seedDefaultJobs(db);
    await db.prepare("DELETE FROM jobs WHERE name = 'revolut.backfill'").run();
    await db
      .prepare(
        `UPDATE jobs SET enabled = 1, schedule_json = '{"kind":"cron","expr":"*/5 * * * *"}'
         WHERE name = 'revolut.sync'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE settings SET value_json = json_object('version', 1, 'at', '2026-01-01T00:00:00.000Z')
         WHERE key = 'seed.default_jobs'`,
      )
      .run();
    const before = (
      await db.prepare("SELECT * FROM jobs WHERE name <> 'revolut.backfill' ORDER BY id").all()
    ).results;

    expect(await seedDefaultJobs(db)).toBe("applied");

    const after = (
      await db.prepare("SELECT * FROM jobs WHERE name <> 'revolut.backfill' ORDER BY id").all()
    ).results;
    expect(after).toEqual(before);
    const added = await db
      .prepare(
        "SELECT name, enabled, schedule_json, next_run_at FROM jobs WHERE name = 'revolut.backfill'",
      )
      .first<{
        name: string;
        enabled: number;
        schedule_json: string;
        next_run_at: string | null;
      }>();
    expect(added).toMatchObject({ enabled: 0, next_run_at: null });
    expect(JSON.parse(added?.schedule_json ?? "{}")).toEqual(cron("15 3 * * *"));
    const sync = await db
      .prepare("SELECT enabled, schedule_json FROM jobs WHERE name = 'revolut.sync'")
      .first<{ enabled: number; schedule_json: string }>();
    expect(sync?.enabled).toBe(1);
    expect(sync?.schedule_json).toContain("*/5");
    expect(await seedDefaultJobs(db)).toBe("current");
  });
});
