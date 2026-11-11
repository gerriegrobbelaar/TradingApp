import { applyD1Migrations, env } from "cloudflare:test";
import { validateSchedule } from "@camelthorn/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_JOBS,
  DEFAULT_JOBS_VERSION,
  resetDefaultJobsMemoForTests,
  seedDefaultJobs,
} from "../src/jobs/defaults";
import { HANDLERS } from "../src/jobs/handlers";
import { auditRows } from "./sync-helpers";
import { db } from "./job-helpers";

const reset = async () => {
  await db.batch([
    db.prepare("DELETE FROM job_runs"),
    db.prepare("DELETE FROM jobs"),
    db.prepare("DELETE FROM settings WHERE key = 'seed.default_jobs'"),
  ]);
  resetDefaultJobsMemoForTests();
};

const jobs = async () =>
  (
    await db
      .prepare(
        "SELECT name, handler, schedule_json, enabled, exact_budget, timezone, kind, next_run_at FROM jobs ORDER BY id",
      )
      .all<{
        name: string;
        handler: string;
        schedule_json: string;
        enabled: number;
        exact_budget: number;
        timezone: string;
        kind: string;
        next_run_at: string | null;
      }>()
  ).results;

beforeEach(reset);

describe("default jobs (CLAUDE.md 4.1)", () => {
  it("every default has a valid schedule, a registered handler and Europe/Amsterdam", () => {
    for (const j of DEFAULT_JOBS) {
      expect(validateSchedule(j.schedule).ok, j.name).toBe(true);
      expect(HANDLERS[j.handler], j.name).toBeDefined();
      expect(j.exactBudget).toBeGreaterThanOrEqual(0);
      expect(j.exactBudget).toBeLessThanOrEqual(1000);
    }
  });

  it("matches the table: schedules, and which are enabled until their phase is built", async () => {
    expect(await seedDefaultJobs(db)).toBe("applied");
    const rows = await jobs();
    const by = (n: string) => rows.find((r) => r.name === n);
    const sched = (n: string) => JSON.parse(by(n)?.schedule_json ?? "{}");
    expect(sched("revolut.sync")).toEqual({ kind: "cron", expr: "*/10 * * * *" });
    expect(sched("exact.bank_balances")).toMatchObject({ kind: "cron" });
    expect(sched("ecb.fx_import")).toEqual({
      kind: "cron",
      expr: "15 16 * * *",
      workingDaysOnly: true,
    });
    expect(sched("dq.checks")).toMatchObject({ kind: "cron" });
    expect(sched("reminders.send")).toEqual({ kind: "cron", expr: "0 9 * * *" });
    expect(sched("exact.full_sync")).toEqual({ kind: "cron", expr: "0 2 * * *" });
    expect(sched("exact.incremental_sync")).toMatchObject({ kind: "cron" });
    expect(sched("fx.revaluation")).toEqual({ kind: "last_working_day", time: "16:30" });
    // Only the ECB import (public, read-only, no credentials; ADR 0036) and the internal bank
    // matching (suggestions only; automatic matching has its own switch, ADR 0042) ship enabled.
    // Later phases are not built and the Exact and Revolut jobs wait for the first live checks.
    expect(rows.filter((r) => r.enabled === 1).map((r) => r.name)).toEqual([
      "bank.match",
      "ecb.fx_import",
    ]);
    expect(sched("bank.match")).toEqual({ kind: "cron", expr: "2,12,22,32,42,52 * * * *" });
    expect(rows.every((r) => r.timezone === "Europe/Amsterdam" && r.kind === "system")).toBe(true);
    // Enabled jobs have a next run in the future; disabled ones none.
    for (const r of rows) {
      if (r.enabled === 1) expect(Date.parse(r.next_run_at as string)).toBeGreaterThan(Date.now());
      else expect(r.next_run_at).toBeNull();
    }
  });

  it("is idempotent: a second start changes nothing and audits nothing", async () => {
    const audits = (await auditRows("job.seed_defaults")).length;
    expect(await seedDefaultJobs(db)).toBe("applied");
    const first = await jobs();
    expect(await seedDefaultJobs(db)).toBe("current");
    expect(await seedDefaultJobs(db)).toBe("current");
    expect(await jobs()).toEqual(first);
    expect(first).toHaveLength(DEFAULT_JOBS.length);
    expect(await auditRows("job.seed_defaults")).toHaveLength(audits + 1);
    const marker = await db
      .prepare(
        "SELECT json_extract(value_json, '$.version') AS v FROM settings WHERE key = 'seed.default_jobs'",
      )
      .first<{ v: number }>();
    expect(marker?.v).toBe(DEFAULT_JOBS_VERSION);
  });

  it("concurrent starts seed once and audit once", async () => {
    const audits = (await auditRows("job.seed_defaults")).length;
    await Promise.all([seedDefaultJobs(db), seedDefaultJobs(db), seedDefaultJobs(db)]);
    expect(await jobs()).toHaveLength(DEFAULT_JOBS.length);
    expect(await auditRows("job.seed_defaults")).toHaveLength(audits + 1);
  });

  it("never overwrites an admin's edits, even when a newer defaults version is applied", async () => {
    await seedDefaultJobs(db);
    await db
      .prepare(
        `UPDATE jobs SET enabled = 0, exact_budget = 99, schedule_json = '{"kind":"cron","expr":"5 4 * * *"}'
         WHERE name = 'exact.full_sync'`,
      )
      .run();
    await db.prepare("UPDATE jobs SET enabled = 1 WHERE name = 'dq.checks'").run();
    // A release added a default job and bumped the version: simulate it by removing one job and
    // lowering the marker.
    await db.prepare("DELETE FROM jobs WHERE name = 'reminders.send'").run();
    await db
      .prepare(
        "UPDATE settings SET value_json = json_object('version', 0) WHERE key = 'seed.default_jobs'",
      )
      .run();
    expect(await seedDefaultJobs(db)).toBe("applied");
    const rows = await jobs();
    expect(rows).toHaveLength(DEFAULT_JOBS.length);
    const full = rows.find((r) => r.name === "exact.full_sync");
    expect(full).toMatchObject({ enabled: 0, exact_budget: 99 });
    expect(JSON.parse(full?.schedule_json ?? "{}")).toEqual({ kind: "cron", expr: "5 4 * * *" });
    expect(rows.find((r) => r.name === "dq.checks")?.enabled).toBe(1);
    // The missing job came back with its default.
    expect(rows.find((r) => r.name === "reminders.send")?.enabled).toBe(0);
  });
});

describe("migration 0008 on a populated database", () => {
  it("keeps old jobs and runs, maps them to the new columns, and the foreign keys hold", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0008"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));
    await mdb.batch([
      mdb.prepare(
        `INSERT INTO jobs (name, cron, enabled, exact_budget, last_run_at, last_result, next_run_at)
         VALUES ('nightly', '0 2 * * *', 1, 240, '2026-01-02T01:00:00Z', '{"ok":true}', '2026-01-03T01:00:00Z')`,
      ),
      mdb.prepare(
        "INSERT INTO jobs (name, cron, enabled, exact_budget, last_result) VALUES ('odd', '*/5 * * * *', 0, 5000, 'not json')",
      ),
      mdb.prepare(
        `INSERT INTO job_runs (job_name, started_at, finished_at, status, trigger, triggered_by, calls_used, result_json)
         VALUES ('nightly', '2026-01-02T01:00:00Z', '2026-01-02T01:03:00Z', 'ok', 'cron', NULL, 12, '{"rows":3}')`,
      ),
      mdb.prepare(
        `INSERT INTO job_runs (job_name, started_at, status, trigger, triggered_by)
         VALUES ('nightly', '2026-01-03T01:00:00Z', 'running', 'manual', 'a@b.test')`,
      ),
      // Two old runs of one job with the same start time (the UNIQUE claim must not reject them).
      mdb.prepare(
        `INSERT INTO job_runs (id, job_name, started_at, finished_at, status, trigger)
         VALUES (40, 'odd', '2026-01-04T00:00:00Z', '2026-01-04T00:00:01Z', 'ok', 'cron')`,
      ),
      mdb.prepare(
        `INSERT INTO job_runs (id, job_name, started_at, finished_at, status, trigger)
         VALUES (41, 'odd', '2026-01-04T00:00:00Z', '2026-01-04T00:00:02Z', 'skipped', 'cron')`,
      ),
      mdb.prepare(
        "INSERT INTO audit_log (actor_email, action, entity) VALUES ('system', 'before.0008', 'test')",
      ),
    ]);

    const triggers = async () =>
      (
        await mdb
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
          .all<{ name: string; sql: string }>()
      ).results;
    const triggersBefore = await triggers();
    expect(triggersBefore.map((t) => t.name)).toEqual(
      expect.arrayContaining(["audit_log_no_update", "audit_log_no_delete"]),
    );

    // Up to 0022: the matching migration adds triggers of its own (migration-0022.test.ts).
    await applyD1Migrations(
      mdb,
      all.filter((m) => m.name < "0022"),
    );
    // Every trigger survives unchanged (append-only audit log, open item rules).
    expect(await triggers()).toEqual(triggersBefore);

    const jobRows = (
      await mdb
        .prepare(
          "SELECT id, name, handler, kind, schedule_json, timezone, enabled, exact_budget, last_run_at, last_result_json, next_run_at FROM jobs ORDER BY name",
        )
        .all<Record<string, unknown>>()
    ).results;
    expect(jobRows).toHaveLength(2);
    expect(jobRows[0]).toMatchObject({
      name: "nightly",
      handler: "nightly",
      kind: "custom",
      timezone: "Europe/Amsterdam",
      enabled: 1,
      exact_budget: 240,
      last_run_at: "2026-01-02T01:00:00Z",
      last_result_json: '{"ok":true}',
      next_run_at: "2026-01-03T01:00:00Z",
    });
    expect(JSON.parse(jobRows[0]?.["schedule_json"] as string)).toEqual({
      kind: "cron",
      expr: "0 2 * * *",
    });
    // A budget above the new hard cap is clamped; an unparsable old result is dropped.
    expect(jobRows[1]).toMatchObject({ name: "odd", exact_budget: 1000, last_result_json: null });

    const nightlyId = jobRows[0]?.["id"] as number;
    const runs = (
      await mdb
        .prepare(
          "SELECT id, job_id, scheduled_for, attempt, status, trigger, requested_by, calls_used, result_json, error_code, finished_at FROM job_runs ORDER BY id",
        )
        .all<Record<string, unknown>>()
    ).results;
    const oddId = jobRows[1]?.["id"] as number;
    expect(runs).toEqual([
      {
        id: 1,
        job_id: nightlyId,
        scheduled_for: "2026-01-02T01:00:00Z",
        attempt: 1,
        status: "ok",
        trigger: "schedule",
        requested_by: "system",
        calls_used: 12,
        result_json: '{"rows":3}',
        error_code: null,
        finished_at: "2026-01-02T01:03:00Z",
      },
      {
        // Left 'running' by the old code: closed, so the new sweep never re-sends it.
        id: 2,
        job_id: nightlyId,
        scheduled_for: "2026-01-03T01:00:00Z",
        attempt: 1,
        status: "error",
        trigger: "manual",
        requested_by: "a@b.test",
        calls_used: 0,
        result_json: '{"code":"abandoned"}',
        error_code: "abandoned",
        finished_at: "2026-01-03T01:00:00Z",
      },
      {
        id: 40,
        job_id: oddId,
        scheduled_for: "2026-01-04T00:00:00Z",
        attempt: 1,
        status: "ok",
        trigger: "schedule",
        requested_by: "system",
        calls_used: 0,
        result_json: null,
        error_code: null,
        finished_at: "2026-01-04T00:00:01Z",
      },
      {
        id: 41,
        job_id: oddId,
        scheduled_for: "2026-01-04T00:00:00Z",
        attempt: 2,
        status: "skipped",
        trigger: "schedule",
        requested_by: "system",
        calls_used: 0,
        result_json: null,
        error_code: null,
        finished_at: "2026-01-04T00:00:02Z",
      },
    ]);
    // New runs continue after the copied ids.
    const added = await mdb
      .prepare(
        "INSERT INTO job_runs (job_id, scheduled_for) VALUES (?1, '2026-02-01T00:00:00Z') RETURNING id",
      )
      .bind(nightlyId)
      .first<{ id: number }>();
    expect(added?.id).toBeGreaterThan(41);

    // Constraints are live on the new tables.
    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await expect(
      mdb.prepare("INSERT INTO job_runs (job_id, scheduled_for) VALUES (9999, 'x')").run(),
    ).rejects.toThrow();
    await expect(
      mdb
        .prepare(
          "INSERT INTO job_runs (job_id, scheduled_for, attempt) VALUES (?1, '2026-01-02T01:00:00Z', 1)",
        )
        .bind(nightlyId)
        .run(),
    ).rejects.toThrow();
    await expect(
      mdb
        .prepare(
          "INSERT INTO jobs (name, handler, schedule_json, timezone) VALUES ('tz', 'x', '{}', 'UTC')",
        )
        .run(),
    ).rejects.toThrow();
    // Other tables and triggers survive: the audit log is still append-only.
    await expect(mdb.prepare("DELETE FROM audit_log").run()).rejects.toThrow();
    const audit = await mdb
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'before.0008'")
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("the table shapes the app relies on exist after a clean migration", async () => {
    const cols = async (t: string) =>
      (
        await db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()
      ).results.map((c) => c.name);
    expect(await cols("jobs")).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "handler",
        "kind",
        "schedule_json",
        "timezone",
        "enabled",
        "exact_budget",
        "last_scheduled_at",
        "last_run_at",
        "last_status",
        "last_result_json",
        "next_run_at",
      ]),
    );
    expect(await cols("job_runs")).toEqual(
      expect.arrayContaining([
        "id",
        "job_id",
        "scheduled_for",
        "attempt",
        "status",
        "trigger",
        "requested_by",
        "started_at",
        "finished_at",
        "heartbeat_at",
        "result_json",
        "error_code",
        "runner_token",
      ]),
    );
  });
});
