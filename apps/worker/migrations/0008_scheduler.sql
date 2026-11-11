-- 0008 Phase 3 scheduler (CLAUDE.md 4.1, task H2).
--
-- Rebuilds jobs and job_runs. The Phase 0 tables (0003) keyed jobs by name, stored one cron string
-- and had a two-value trigger; the scheduler needs a numeric id for the API, a structured
-- schedule (cron or "last working day", see packages/core schedule), a handler key, run claims
-- that cannot be duplicated, and heartbeats. SQLite cannot add a PRIMARY KEY or drop a column
-- CHECK in place, so both tables are rebuilt with copy -> drop -> rename. Only job_runs references
-- jobs and nothing references job_runs, so dropping job_runs first and then jobs is safe with
-- foreign keys on; no PRAGMA is needed. Existing rows are copied (test/migration-0008.test.ts runs
-- this on a populated database).
--
-- The default jobs are NOT inserted here: like the admin seed (ADR 0004) they are written at Worker
-- start by apps/worker/src/jobs/defaults.ts (one marker per defaults version, then insert-if-
-- missing by name, so admin edits are never overwritten). They need no Workers variables, but
-- keeping them in code lets a later release add a default job without another migration.

CREATE TABLE jobs_0008 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The stable key, e.g. 'exact.full_sync'. Also what the Exact gate looks up for a default budget.
  name          TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  -- Key into the handler registry in code (apps/worker/src/jobs/handlers.ts). An unknown key is
  -- treated as "not implemented" and runs are recorded as skipped.
  handler       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'system' CHECK (kind IN ('system', 'custom')),
  -- packages/core Schedule as JSON: {"kind":"cron","expr":"0 2 * * *"} or {"kind":"last_working_day","time":"16:30"}
  schedule_json TEXT NOT NULL CHECK (json_valid(schedule_json)),
  timezone      TEXT NOT NULL DEFAULT 'Europe/Amsterdam' CHECK (timezone = 'Europe/Amsterdam'),
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- Exact calls per administration and run. Hard cap enforced by the API (1..1000); 0 = not an Exact job.
  exact_budget  INTEGER NOT NULL DEFAULT 0 CHECK (exact_budget BETWEEN 0 AND 1000),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Baseline for "is a slot due": when the scheduler last claimed a slot for this job (or when the
  -- schedule was changed / the job enabled), so missed slots collapse into one run and a new
  -- schedule never fires for the past.
  last_scheduled_at TEXT,
  last_run_at   TEXT,
  last_status   TEXT CHECK (last_status IS NULL OR last_status IN ('ok', 'partial', 'error', 'skipped')),
  last_result_json TEXT CHECK (last_result_json IS NULL OR json_valid(last_result_json)),
  next_run_at   TEXT,
  -- Optimistic concurrency token for admin edits (changes with every edit).
  rev           TEXT,
  updated_at    TEXT,
  updated_by    TEXT
);

INSERT INTO jobs_0008 (name, handler, kind, schedule_json, timezone, enabled, exact_budget,
                       last_scheduled_at, last_run_at, last_status, last_result_json, next_run_at)
SELECT name, name, 'custom', json_object('kind', 'cron', 'expr', cron), 'Europe/Amsterdam', enabled,
       MIN(MAX(exact_budget, 0), 1000), NULL, last_run_at, NULL,
       CASE WHEN last_result IS NOT NULL AND json_valid(last_result) THEN last_result END,
       next_run_at
FROM jobs;

CREATE TABLE job_runs_0008 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES jobs_0008 (id),
  -- The slot this run is for. Scheduled runs: the schedule slot (UTC ISO). Manual runs: the click.
  -- UNIQUE with attempt, so two ticks (or isolates) can never claim the same slot twice.
  scheduled_for TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'ok', 'partial', 'error', 'skipped')),
  trigger       TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual', 'retry')),
  -- The user's email, or 'system'.
  requested_by  TEXT NOT NULL DEFAULT 'system',
  queued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- When the queue message was last sent (queued_at, or the sweep's resend); the sweep waits for it.
  enqueued_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at    TEXT,
  finished_at   TEXT,
  heartbeat_at  TEXT,
  -- Random token of the request/tick that created the row (lets the audit row prove it was ours).
  claim_token   TEXT,
  -- Random token of the consumer that is executing it; only that consumer may finish the run.
  runner_token  TEXT,
  -- How many times the queue message was (re)sent by the sweep.
  enqueue_count INTEGER NOT NULL DEFAULT 1,
  -- Small summary: counts and codes only. Never tokens, IBANs, email bodies or Exact payloads.
  result_json   TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code    TEXT,
  calls_used    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (job_id, scheduled_for, attempt)
);

-- Old runs keep their ids. A run left 'running' by the old code has no executor any more: it is
-- closed as an error (code 'abandoned') so the new sweep never re-sends or "takes over" it. Two old
-- runs of one job with the same start time get attempts 1, 2, ... so the UNIQUE claim cannot fail.
INSERT INTO job_runs_0008 (id, job_id, scheduled_for, attempt, status, trigger, requested_by, queued_at,
                           enqueued_at, started_at, finished_at, result_json, error_code, calls_used)
SELECT r.id, j.id, r.started_at,
       ROW_NUMBER() OVER (PARTITION BY r.job_name, r.started_at ORDER BY r.id),
       CASE r.status WHEN 'running' THEN 'error' ELSE r.status END,
       CASE r.trigger WHEN 'manual' THEN 'manual' ELSE 'schedule' END,
       COALESCE(r.triggered_by, 'system'), r.started_at, r.started_at, r.started_at,
       CASE r.status WHEN 'running' THEN COALESCE(r.finished_at, r.started_at) ELSE r.finished_at END,
       CASE WHEN r.status = 'running' THEN json_object('code', 'abandoned')
            WHEN r.result_json IS NOT NULL AND json_valid(r.result_json) THEN r.result_json END,
       CASE r.status WHEN 'running' THEN 'abandoned' END,
       r.calls_used
FROM job_runs r JOIN jobs_0008 j ON j.name = r.job_name;

DROP TABLE job_runs;
DROP TABLE jobs;
ALTER TABLE jobs_0008 RENAME TO jobs;
ALTER TABLE job_runs_0008 RENAME TO job_runs;

CREATE INDEX idx_job_runs_job ON job_runs (job_id, id DESC);
CREATE INDEX idx_job_runs_open ON job_runs (status, enqueued_at) WHERE status IN ('queued', 'running');
CREATE INDEX idx_job_runs_finished ON job_runs (finished_at) WHERE finished_at IS NOT NULL;
