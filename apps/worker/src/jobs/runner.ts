/**
 * The job runner (CLAUDE.md 4.1).
 *
 *   Cron Trigger, every minute
 *     -> tickScheduler: for every enabled job whose schedule is due (isDue), CLAIM the slot by
 *        inserting a job_runs row 'queued' (UNIQUE (job_id, scheduled_for, attempt), so duplicate
 *        ticks and overlapping isolates cannot enqueue it twice), move the job's baseline and
 *        next_run_at, and send {runId, jobId} to the Queue;
 *     -> handleQueue: the consumer executes the run (executeRun).
 *
 * executeRun is idempotent per run: a redelivery for a finished run is acked and ignored; one
 * that is 'running' with a fresh heartbeat is retried later (somebody is on it); one whose
 * heartbeat is older than STALE_MS is taken over (the old executor can no longer finish it: only
 * the holder of runner_token may). Overlap between RUNS of one job is prevented by a JobLock
 * lease (a Durable Object per job name): a run that cannot get it is recorded 'skipped' with
 * code already_running. The lease is released in `finally`, expires by itself if the isolate dies,
 * and is extended by a heartbeat while the handler works. If the heartbeat finds the lease lost,
 * the handler's signal is aborted.
 *
 * Handlers never take other jobs down: every handler runs in try/catch with a timeout, and the
 * outcome is a row in job_runs (+ the job's last_* columns). Results hold counts and codes only.
 *
 * A sweep in every tick re-sends messages that were lost (a crash between the insert and the
 * send, a dropped dead-letter) and finally marks runs that never completed as errors.
 */
import { amsterdamParts, isDue, nextRun, validateSchedule, type Schedule } from "@camelthorn/core";
import { auditStatement, maskDeep } from "../db/audit";
import type { Env } from "../env";
import { getEuObject } from "../eu-object";
import { isTransientFailure, type SyncDeps } from "../exact/sync";
import { handlerFor } from "./handlers";
import {
  TERMINAL,
  type HandlerDef,
  type HandlerResult,
  type JobContext,
  type JobMessage,
  type JobRow,
  type RunRow,
  type RunTrigger,
} from "./types";

/** Lease lifetime; the heartbeat renews it, a dead isolate loses it after this long. */
export const LOCK_TTL_MS = 90_000;
export const HEARTBEAT_MS = 30_000;
/** A 'running' run whose heartbeat is older than this is stuck and may be taken over. */
export const STALE_MS = 2 * 60_000;
/** The sweep re-sends a message for a run untouched this long. */
export const SWEEP_AFTER_MS = 5 * 60_000;
/** Sends per run (the first plus resends) before the sweep gives up and marks it an error. */
export const MAX_ENQUEUES = 4;
/** Wall time of one run; below the 15-minute queue consumer limit. */
export const RUN_TIMEOUT_MS = 13 * 60_000;
/** After the abort at the timeout a handler gets this long to wind down. */
export const ABORT_GRACE_MS = 30_000;
/** Wait before a delivery is retried when the run is being executed by somebody else. */
export const BUSY_RETRY_SECONDS = 60;
export const MANUAL_COOLDOWN_SECONDS = 30;
export const RESULT_MAX_CHARS = 4000;
/** Queue messages can be delayed by at most 12 hours. */
const MAX_DELAY_SECONDS = 12 * 3600;
export const RUN_RETENTION_DAYS = 90;
export const LAST_TICK_KEY = "scheduler.last_tick";

/** Test seams and tuning. Production passes nothing. */
export interface RunnerDeps {
  now?: () => number;
  handlers?: Record<string, HandlerDef>;
  lockTtlMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  timeoutMs?: number;
  graceMs?: number;
  syncDeps?: SyncDeps;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const parseMs = (v: string | null): number | null => {
  if (v === null) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
};

export function parseSchedule(json: string): Schedule | null {
  try {
    const v = validateSchedule(JSON.parse(json));
    return v.ok ? v.schedule : null;
  } catch {
    return null;
  }
}

const lockFor = (env: Pick<Env, "JOB_LOCK">, jobName: string) =>
  getEuObject(env.JOB_LOCK, `job:${jobName}`);

// ---------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------

/** Sends a run to the queue. False (never throws) if the queue is missing or refuses. */
export async function enqueueRun(
  env: Pick<Env, "JOBS_QUEUE">,
  runId: number,
  jobId: number,
  delaySeconds = 0,
): Promise<boolean> {
  try {
    const delay = Math.min(Math.max(Math.trunc(delaySeconds), 0), MAX_DELAY_SECONDS);
    await env.JOBS_QUEUE.send({ runId, jobId }, delay > 0 ? { delaySeconds: delay } : undefined);
    return true;
  } catch (e) {
    console.error("job enqueue failed", e instanceof Error ? e.name : "unknown");
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Scheduler tick
// ---------------------------------------------------------------------------------------------

export interface TickResult {
  claimed: { jobName: string; runId: number }[];
  resent: number;
  abandoned: number;
}

export async function tickScheduler(env: Env, nowMs: number = Date.now()): Promise<TickResult> {
  const db = env.DB;
  const result: TickResult = { claimed: [], resent: 0, abandoned: 0 };
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_by)
       VALUES (?1, json_object('at', ?2), 'system')
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = ?2`,
    )
    .bind(LAST_TICK_KEY, iso(nowMs))
    .run()
    .catch(() => undefined);

  const jobs = await db.prepare("SELECT * FROM jobs WHERE enabled = 1 ORDER BY id").all<JobRow>();
  for (const job of jobs.results) {
    try {
      const claimed = await claimIfDue(env, job, nowMs);
      if (claimed !== null) result.claimed.push({ jobName: job.name, runId: claimed });
    } catch (e) {
      // One job's trouble (a bad schedule, a D1 hiccup) must not stop the others.
      console.error("job tick failed", job.name, e instanceof Error ? e.name : "unknown");
    }
  }

  try {
    const swept = await sweep(env, nowMs);
    result.resent = swept.resent;
    result.abandoned = swept.abandoned;
    if (amsterdamParts(nowMs).minute === 17) await pruneRuns(db, nowMs);
  } catch (e) {
    console.error("job sweep failed", e instanceof Error ? e.name : "unknown");
  }
  return result;
}

/** Claims the due slot of a job and enqueues it. Returns the run id, or null if not due / lost. */
async function claimIfDue(env: Env, job: JobRow, nowMs: number): Promise<number | null> {
  const schedule = parseSchedule(job.schedule_json);
  if (schedule === null) {
    console.error("job has an invalid schedule", job.name);
    return null;
  }
  const lastMs = parseMs(job.last_scheduled_at);
  const createdMs = parseMs(job.created_at) ?? nowMs;
  if (!isDue(schedule, lastMs, nowMs, createdMs)) return null;
  const slot = nextRun(schedule, lastMs ?? createdMs);
  if (slot === null) return null;

  const token = crypto.randomUUID();
  const next = nextRun(schedule, nowMs);
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO job_runs (job_id, scheduled_for, attempt, status, trigger, requested_by,
                             queued_at, enqueued_at, claim_token)
       VALUES (?1, ?2, 1, 'queued', 'schedule', 'system', ?3, ?3, ?4)
       ON CONFLICT (job_id, scheduled_for, attempt) DO NOTHING
       RETURNING id`,
    ).bind(job.id, iso(slot), iso(nowMs), token),
    // Only the tick that won the slot moves the baseline (missed slots collapse into one run).
    env.DB.prepare(
      `UPDATE jobs SET last_scheduled_at = ?3, next_run_at = ?4
       WHERE id = ?1 AND EXISTS (SELECT 1 FROM job_runs WHERE job_id = ?1 AND scheduled_for = ?2
                                 AND attempt = 1 AND claim_token = ?5)`,
    ).bind(job.id, iso(slot), iso(nowMs), next === null ? null : iso(next), token),
  ]);
  const row = ins?.results?.[0] as { id: number } | undefined;
  if (!row) return null; // another tick or isolate claimed this slot
  await enqueueRun(env, row.id, job.id);
  return row.id;
}

/** Re-sends lost messages; marks runs that never completed as errors. */
export async function sweep(
  env: Env,
  nowMs: number,
): Promise<{ resent: number; abandoned: number }> {
  const db = env.DB;
  const cut = iso(nowMs - SWEEP_AFTER_MS);
  const stale = await db
    .prepare(
      `SELECT id, job_id, status, enqueue_count FROM job_runs
       WHERE enqueued_at < ?1
         AND (status = 'queued' OR (status = 'running' AND COALESCE(heartbeat_at, started_at) < ?1))
       ORDER BY id LIMIT 50`,
    )
    .bind(cut)
    .all<{ id: number; job_id: number; status: string; enqueue_count: number }>();
  let resent = 0;
  let abandoned = 0;
  for (const r of stale.results) {
    if (r.enqueue_count >= MAX_ENQUEUES) {
      const finished = iso(nowMs);
      const [upd] = await db.batch([
        db
          .prepare(
            `UPDATE job_runs SET status = 'error', finished_at = ?2, error_code = 'abandoned',
               result_json = json_object('code', 'abandoned')
             WHERE id = ?1 AND status IN ('queued', 'running') AND enqueued_at < ?3`,
          )
          .bind(r.id, finished, cut),
        db
          .prepare(
            `UPDATE jobs SET last_run_at = ?2, last_status = 'error',
               last_result_json = json_object('code', 'abandoned')
             WHERE id = ?1 AND EXISTS (SELECT 1 FROM job_runs WHERE id = ?3 AND error_code = 'abandoned'
                                       AND finished_at = ?2)`,
          )
          .bind(r.job_id, finished, r.id),
      ]);
      if (upd?.meta.changes === 1) abandoned++;
      continue;
    }
    const bump = await db
      .prepare(
        `UPDATE job_runs SET enqueue_count = enqueue_count + 1, enqueued_at = ?2
         WHERE id = ?1 AND enqueued_at < ?3 AND status IN ('queued', 'running')`,
      )
      .bind(r.id, iso(nowMs), cut)
      .run();
    if (bump.meta.changes === 1 && (await enqueueRun(env, r.id, r.job_id))) resent++;
  }
  return { resent, abandoned };
}

async function pruneRuns(db: D1Database, nowMs: number): Promise<void> {
  const cutoff = iso(nowMs - RUN_RETENTION_DAYS * 86_400_000);
  await db
    .prepare(
      `DELETE FROM job_runs WHERE id IN (
         SELECT id FROM job_runs WHERE finished_at IS NOT NULL AND finished_at < ?1 LIMIT 500)`,
    )
    .bind(cutoff)
    .run();
}

// ---------------------------------------------------------------------------------------------
// Manual runs
// ---------------------------------------------------------------------------------------------

export type ManualResult =
  | { ok: true; runId: number }
  | { ok: false; reason: "already_running" | "cooldown"; retryAfterSeconds?: number };

/**
 * "Run now": one new run row, audited in the same batch. Refused (nothing written) while the
 * job has a queued or running run, or within the per-job cooldown of the last manual run. Both
 * conditions sit inside the INSERT, so two racing requests cannot both get in.
 */
export async function createManualRun(
  env: Env,
  job: Pick<JobRow, "id" | "name">,
  email: string,
  nowMs: number,
): Promise<ManualResult> {
  const db = env.DB;
  const at = iso(nowMs);
  const token = crypto.randomUUID();
  const cooldownCut = iso(nowMs - MANUAL_COOLDOWN_SECONDS * 1000);
  const [ins, audit] = await db.batch([
    db
      .prepare(
        `INSERT INTO job_runs (job_id, scheduled_for, attempt, status, trigger, requested_by,
                               queued_at, enqueued_at, claim_token)
         SELECT ?1, ?2, 1, 'queued', 'manual', ?3, ?2, ?2, ?4
         WHERE NOT EXISTS (SELECT 1 FROM job_runs WHERE job_id = ?1 AND status IN ('queued', 'running'))
           AND NOT EXISTS (SELECT 1 FROM job_runs WHERE job_id = ?1 AND trigger = 'manual' AND queued_at > ?5)
         ON CONFLICT (job_id, scheduled_for, attempt) DO NOTHING
         RETURNING id`,
      )
      .bind(job.id, at, email, token, cooldownCut),
    auditStatement(
      db,
      {
        actorEmail: email,
        action: "job.run_now",
        entity: "job",
        entityId: job.id,
        after: { job: job.name },
      },
      {
        sql: "EXISTS (SELECT 1 FROM job_runs WHERE job_id = ?7 AND claim_token = ?8)",
        binds: [job.id, token],
      },
    ),
  ]);
  const row = ins?.results?.[0] as { id: number } | undefined;
  if (!row || audit?.meta.changes !== 1) {
    const last = await db
      .prepare("SELECT MAX(queued_at) AS at FROM job_runs WHERE job_id = ?1 AND trigger = 'manual'")
      .bind(job.id)
      .first<{ at: string | null }>();
    const busy = await db
      .prepare("SELECT 1 AS x FROM job_runs WHERE job_id = ?1 AND status IN ('queued', 'running')")
      .bind(job.id)
      .first();
    if (busy) return { ok: false, reason: "already_running" };
    const lastMs = parseMs(last?.at ?? null);
    const wait =
      lastMs === null ? 0 : Math.ceil((lastMs + MANUAL_COOLDOWN_SECONDS * 1000 - nowMs) / 1000);
    return { ok: false, reason: "cooldown", retryAfterSeconds: Math.max(wait, 1) };
  }
  await enqueueRun(env, row.id, job.id);
  return { ok: true, runId: row.id };
}

// ---------------------------------------------------------------------------------------------
// Queue consumer
// ---------------------------------------------------------------------------------------------

export type Disposition = { kind: "ack"; reason: string } | { kind: "retry"; delaySeconds: number };

const ack = (reason: string): Disposition => ({ kind: "ack", reason });

type LoadedRun = RunRow & {
  job_name: string;
  handler: string;
  enabled: number;
  exact_budget: number;
};

class RunTimeout extends Error {
  constructor() {
    super("run timed out");
    this.name = "RunTimeout";
  }
}

function serialise(result: HandlerResult, extra: Record<string, unknown> = {}): string {
  const body = {
    status: result.status,
    ...(result.code !== undefined ? { code: result.code } : {}),
    ...extra,
    summary: result.summary,
  };
  let text = JSON.stringify(maskDeep(body));
  if (text.length > RESULT_MAX_CHARS) {
    text = JSON.stringify({
      status: result.status,
      ...(result.code !== undefined ? { code: result.code } : {}),
      truncated: true,
    });
  }
  return text;
}

export async function executeRun(
  env: Env,
  runId: number,
  deps: RunnerDeps = {},
): Promise<Disposition> {
  const db = env.DB;
  const clock = deps.now ?? Date.now;
  const row = await db
    .prepare(
      `SELECT r.*, j.name AS job_name, j.handler, j.enabled, j.exact_budget
       FROM job_runs r JOIN jobs j ON j.id = r.job_id WHERE r.id = ?1`,
    )
    .bind(runId)
    .first<LoadedRun>();
  if (!row) return ack("unknown_run");
  if (TERMINAL.has(row.status)) return ack("already_finished");

  const startMs = clock();
  const token = crypto.randomUUID();
  const claim = await db
    .prepare(
      `UPDATE job_runs SET status = 'running', started_at = ?2, heartbeat_at = ?2, runner_token = ?3,
         finished_at = NULL
       WHERE id = ?1 AND (status = 'queued'
         OR (status = 'running' AND COALESCE(heartbeat_at, started_at) < ?4))`,
    )
    .bind(runId, iso(startMs), token, iso(startMs - (deps.staleMs ?? STALE_MS)))
    .run();
  // Somebody else is running it right now: look again later (it may be dead by then).
  if (claim.meta.changes !== 1) return { kind: "retry", delaySeconds: BUSY_RETRY_SECONDS };

  const def = (deps.handlers ?? undefined)?.[row.handler] ?? handlerFor(row.handler);
  const finish = (result: HandlerResult) => finishRun(env, row, def, token, result, clock());

  if (row.enabled !== 1 && row.trigger !== "manual") {
    return finish({ status: "skipped", code: "disabled", summary: {} });
  }
  if (!def?.run) {
    return finish({
      status: "skipped",
      code: "not_implemented",
      summary: { phase: def?.phase ?? null },
    });
  }

  const lock = lockFor(env, row.job_name);
  const ttl = deps.lockTtlMs ?? LOCK_TTL_MS;
  let got;
  try {
    got = await lock.acquire(token, ttl);
  } catch (e) {
    // The lock object is unreachable: put the run back and let the queue try again.
    console.error("job lock unavailable", e instanceof Error ? e.name : "unknown");
    await db
      .prepare(
        "UPDATE job_runs SET status = 'queued', runner_token = NULL WHERE id = ?1 AND runner_token = ?2",
      )
      .bind(runId, token)
      .run();
    return { kind: "retry", delaySeconds: 30 };
  }
  if (!got.ok) {
    return finish({
      status: "skipped",
      code: "already_running",
      summary: {},
    });
  }

  const ac = new AbortController();
  const timeoutMs = deps.timeoutMs ?? RUN_TIMEOUT_MS;
  const graceMs = deps.graceMs ?? ABORT_GRACE_MS;
  const ctx: JobContext = {
    env,
    job: {
      id: row.job_id,
      name: row.job_name,
      handler: row.handler,
      exactBudget: row.exact_budget,
    },
    run: {
      id: row.id,
      attempt: row.attempt,
      scheduledFor: row.scheduled_for,
      requestedBy: row.requested_by,
    },
    trigger: row.trigger,
    budget: row.exact_budget,
    deadlineMs: startMs + timeoutMs,
    signal: ac.signal,
    log: (event, fields) =>
      console.log(JSON.stringify({ job: row.job_name, run: row.id, event, ...(fields ?? {}) })),
    now: clock,
    ...(deps.syncDeps ? { syncDeps: deps.syncDeps } : {}),
  };

  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const beat = setInterval(() => {
    void (async () => {
      try {
        const alive = await lock.heartbeat(token, ttl);
        if (!alive) {
          console.error("job lock lost", row.job_name);
          ac.abort();
          return;
        }
        await db
          .prepare("UPDATE job_runs SET heartbeat_at = ?2 WHERE id = ?1 AND runner_token = ?3")
          .bind(runId, iso(clock()), token)
          .run();
      } catch {
        /* a missed beat only matters if several are missed; the lease TTL covers one */
      }
    })();
  }, deps.heartbeatMs ?? HEARTBEAT_MS);

  let result: HandlerResult;
  try {
    const stop = new Promise<never>((_, reject) => {
      ac.signal.addEventListener("abort", () => {
        setTimeout(() => reject(new RunTimeout()), graceMs);
      });
    });
    stop.catch(() => undefined);
    result = await Promise.race([def.run(ctx), stop]);
  } catch (e) {
    result = failureResult(e);
  } finally {
    clearTimeout(timer);
    clearInterval(beat);
    // Release in finally; if this fails the lease simply expires.
    await lock.release(token).catch(() => undefined);
  }
  return finish(result);
}

function failureResult(e: unknown): HandlerResult {
  if (e instanceof RunTimeout) return { status: "error", code: "timeout", summary: {} };
  if (isTransientFailure(e)) {
    return {
      status: "partial",
      code: "transient",
      summary: {},
      retry: { delaySeconds: 300 },
    };
  }
  console.error("job handler failed", e instanceof Error ? e.name : "unknown");
  return { status: "error", code: "handler_error", summary: {} };
}

async function finishRun(
  env: Env,
  row: LoadedRun,
  def: HandlerDef | undefined,
  token: string,
  result: HandlerResult,
  nowMs: number,
): Promise<Disposition> {
  const db = env.DB;
  const retry =
    result.retry !== undefined &&
    def !== undefined &&
    row.attempt < def.maxAttempts &&
    row.trigger !== "manual" &&
    result.status !== "error"
      ? result.retry
      : null;
  const finished = iso(nowMs);
  const resultJson = serialise(
    result,
    retry ? { retry: { attempt: row.attempt + 1, inSeconds: retry.delaySeconds } } : {},
  );
  const [upd] = await db.batch([
    db
      .prepare(
        `UPDATE job_runs SET status = ?2, finished_at = ?3, result_json = ?4, error_code = ?5,
           calls_used = ?6
         WHERE id = ?1 AND runner_token = ?7 AND status = 'running'`,
      )
      .bind(
        row.id,
        result.status,
        finished,
        resultJson,
        result.code ?? null,
        result.callsUsed ?? 0,
        token,
      ),
    db
      .prepare(
        `UPDATE jobs SET last_run_at = ?3, last_status = ?2, last_result_json = ?4
         WHERE id = ?5 AND EXISTS (SELECT 1 FROM job_runs WHERE id = ?1 AND runner_token = ?6
                                   AND finished_at = ?3 AND status = ?2)`,
      )
      .bind(row.id, result.status, finished, resultJson, row.job_id, token),
  ]);
  if (upd?.meta.changes !== 1) {
    // Taken over by another consumer while we worked; its result stands.
    console.error("job run was taken over", row.job_name);
    return ack("taken_over");
  }
  if (retry) {
    const ins = await db
      .prepare(
        `INSERT INTO job_runs (job_id, scheduled_for, attempt, status, trigger, requested_by,
                               queued_at, enqueued_at, claim_token)
         VALUES (?1, ?2, ?3, 'queued', 'retry', 'system', ?4, ?4, ?5)
         ON CONFLICT (job_id, scheduled_for, attempt) DO NOTHING
         RETURNING id`,
      )
      .bind(row.job_id, row.scheduled_for, row.attempt + 1, finished, crypto.randomUUID())
      .first<{ id: number }>();
    if (ins) await enqueueRun(env, ins.id, row.job_id, retry.delaySeconds);
  }
  return ack(result.status);
}

/** The Worker's queue() handler: one run per message. */
export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  deps: RunnerDeps = {},
): Promise<void> {
  for (const msg of batch.messages) {
    const body = msg.body as Partial<JobMessage> | null;
    if (!body || !Number.isSafeInteger(body.runId)) {
      msg.ack();
      continue;
    }
    try {
      const d = await executeRun(env, body.runId as number, deps);
      if (d.kind === "retry") msg.retry({ delaySeconds: d.delaySeconds });
      else msg.ack();
    } catch (e) {
      console.error("job message failed", e instanceof Error ? e.name : "unknown");
      msg.retry({ delaySeconds: 30 });
    }
  }
}

export type { RunTrigger };
