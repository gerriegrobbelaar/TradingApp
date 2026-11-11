/**
 * The initial jobs of CLAUDE.md 4.1, written at Worker start like the admin seed (ADR 0004):
 *  - a settings marker `seed.default_jobs` holds the defaults VERSION that was applied, so the
 *    common case after the first run is one read and no write;
 *  - applying a version inserts every default job that is missing BY NAME and never touches an
 *    existing row, so an admin's edits (schedule, enabled, budget) survive restarts and releases;
 *  - a release that adds a default job bumps DEFAULT_JOBS_VERSION and ships the new entry; the
 *    next start inserts just that job.
 * The ECB import is the exception: it reads a public source without credentials and starts
 * enabled on a new install. Jobs whose phase is not built yet start disabled (their handler would only record "skipped").
 * The two Exact sync jobs ship disabled too (review S6) until the first live connection has been
 * checked; an admin switches them on afterwards. Existing rows are never flipped.
 */
import { nextRun, type Schedule } from "@camelthorn/core";
import { auditStatement } from "../db/audit";
import { FULL_SYNC_BUDGET, INCREMENTAL_SYNC_BUDGET } from "./exact-handlers";

export const DEFAULT_JOBS_VERSION = 2;
const MARKER = "seed.default_jobs";

export interface DefaultJob {
  name: string;
  handler: string;
  schedule: Schedule;
  enabled: boolean;
  exactBudget: number;
  /** Why a default job ships switched off, as a stable code (shown to admins by GET /api/jobs). */
  disabledReason?: typeof AWAITING_LIVE_VERIFICATION;
}

/** The Exact jobs wait for the first live connection checks (docs/DEPLOY.md). */
export const AWAITING_LIVE_VERIFICATION = "awaiting_live_verification";

export const defaultJobFor = (name: string): DefaultJob | undefined =>
  DEFAULT_JOBS.find((j) => j.name === name);

export const DEFAULT_JOBS: readonly DefaultJob[] = [
  {
    name: "revolut.sync",
    handler: "revolut.sync",
    schedule: { kind: "cron", expr: "*/10 * * * *" },
    enabled: false,
    // Switch on after the first live Revolut connection checks (docs/DEPLOY.md).
    disabledReason: AWAITING_LIVE_VERIFICATION,
    exactBudget: 0,
  },
  {
    name: "revolut.backfill",
    handler: "revolut.backfill",
    // After the nightly Exact full sync (02:00), in the quiet hours.
    schedule: { kind: "cron", expr: "15 3 * * *" },
    enabled: false,
    disabledReason: AWAITING_LIVE_VERIFICATION,
    exactBudget: 0,
  },
  {
    name: "exact.bank_balances",
    handler: "exact.bank_balances",
    // The Exact bank feed is daily; polling faster only wastes budget (CLAUDE.md 4.1).
    schedule: { kind: "cron", expr: "5 * * * *" },
    enabled: false, // Phase 8 (data quality): planned for the data-quality phase
    exactBudget: 20,
  },
  {
    name: "ecb.fx_import",
    handler: "ecb.fx_import",
    schedule: { kind: "cron", expr: "15 16 * * *", workingDaysOnly: true },
    // Public, read-only, credential-free source: on by default on NEW installs (ADR 0036).
    // Existing rows are never flipped by the seeding.
    enabled: true,
    exactBudget: 0,
  },
  {
    name: "dq.checks",
    handler: "dq.checks",
    schedule: { kind: "cron", expr: "20 * * * *" },
    enabled: false, // Phase 8
    exactBudget: 0,
  },
  {
    name: "reminders.send",
    handler: "reminders.send",
    schedule: { kind: "cron", expr: "0 9 * * *" },
    enabled: false, // Phase 10
    exactBudget: 0,
  },
  {
    name: "exact.full_sync",
    handler: "exact.full_sync",
    schedule: { kind: "cron", expr: "0 2 * * *" },
    enabled: false,
    disabledReason: AWAITING_LIVE_VERIFICATION,
    exactBudget: FULL_SYNC_BUDGET,
  },
  {
    name: "exact.incremental_sync",
    handler: "exact.incremental_sync",
    // Half past the hour, so it does not meet the nightly full sync at 02:00 (they share a lease).
    schedule: { kind: "cron", expr: "30 * * * *" },
    enabled: false,
    disabledReason: AWAITING_LIVE_VERIFICATION,
    exactBudget: INCREMENTAL_SYNC_BUDGET,
  },
  {
    name: "fx.revaluation",
    handler: "fx.revaluation",
    schedule: { kind: "last_working_day", time: "16:30" },
    enabled: false, // Phase 12
    exactBudget: 100,
  },
];

export type DefaultJobsResult = "applied" | "current";

export async function seedDefaultJobs(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<DefaultJobsResult> {
  const marked = await db
    .prepare("SELECT json_extract(value_json, '$.version') AS v FROM settings WHERE key = ?1")
    .bind(MARKER)
    .first<{ v: number | null }>();
  if ((marked?.v ?? 0) >= DEFAULT_JOBS_VERSION) return "current";

  const now = new Date(nowMs).toISOString();
  const stale = `NOT EXISTS (SELECT 1 FROM settings WHERE key = '${MARKER}'
                  AND COALESCE(json_extract(value_json, '$.version'), 0) >= ${DEFAULT_JOBS_VERSION})`;
  const statements = DEFAULT_JOBS.map((j) => {
    const next = j.enabled ? nextRun(j.schedule, nowMs) : null;
    return db
      .prepare(
        `INSERT INTO jobs (name, handler, kind, schedule_json, enabled, exact_budget, created_at,
                           last_scheduled_at, next_run_at)
         VALUES (?1, ?2, 'system', ?3, ?4, ?5, ?6, ?6, ?7)
         ON CONFLICT (name) DO NOTHING`,
      )
      .bind(
        j.name,
        j.handler,
        JSON.stringify(j.schedule),
        j.enabled ? 1 : 0,
        j.exactBudget,
        now,
        next === null ? null : new Date(next).toISOString(),
      );
  });
  await db.batch([
    ...statements,
    // One audit row per applied version; the guard makes a concurrent second isolate write none.
    auditStatement(
      db,
      {
        actorEmail: "system",
        action: "job.seed_defaults",
        entity: "job",
        after: { version: DEFAULT_JOBS_VERSION, jobs: DEFAULT_JOBS.map((j) => j.name) },
      },
      { sql: stale, binds: [] },
    ),
    db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_by)
         VALUES (?1, json_object('version', ${DEFAULT_JOBS_VERSION}, 'at', ?2), 'system')
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
           updated_by = 'system', updated_at = excluded.updated_at
         WHERE COALESCE(json_extract(settings.value_json, '$.version'), 0) < ${DEFAULT_JOBS_VERSION}`,
      )
      .bind(MARKER, now),
  ]);
  return "applied";
}

let seeding: Promise<void> | null = null;

/** Once per isolate; concurrent callers share one attempt; a failed attempt is retried next time. */
export function ensureDefaultJobs(env: { DB: D1Database }): Promise<void> {
  if (!seeding) {
    seeding = seedDefaultJobs(env.DB).then(
      () => undefined,
      (err: unknown) => {
        seeding = null;
        throw err;
      },
    );
  }
  return seeding;
}

export function resetDefaultJobsMemoForTests(): void {
  seeding = null;
}
