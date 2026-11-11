/**
 * Jobs API (CLAUDE.md 4.1, 4.8 Settings, Schedules).
 *
 *  GET   /api/jobs              any signed-in role: the jobs, their schedule in words, enabled,
 *                               budget, next run and last run, plus whether the Worker's queue and
 *                               cron are set up (`scheduler`)
 *  GET   /api/jobs/:id/runs     any signed-in role: history, newest first (`?limit=`, max 100)
 *  PATCH /api/jobs/:id          admin (no step-up): `{ enabled?, schedule?, exactBudget?, rev? }`.
 *                               The schedule is checked by validateSchedule, the budget must be a whole
 *                               number of 1..MAX_EXACT_BUDGET (and only Exact jobs have one), the
 *                               time zone is always Europe/Amsterdam. The change and its audit row
 *                               are one batch (ADR 0013), guarded by the job's `rev`: the one the
 *                               client sends (409 conflict when stale) and the one read here.
 *                               A bad schedule is 400 `schedule_invalid` with a `message`; one
 *                               outside the handler's scheduleRules (also checked when a job is
 *                               switched on) is 400 `schedule_not_allowed`; a change that would
 *                               raise the switched-on Exact jobs above 3,000 projected calls per
 *                               administration and day is 400 `budget_cap_exceeded`.
 *  POST  /api/jobs/:id/run      the roles in the handler's runRoles (default admin and finance;
 *                               403 forbidden otherwise), plus a fresh sign-in when the handler
 *                               says stepUp (401 step_up_required): "Run now". 202 with the run
 *                               id; 409 while the job is queued or running, 429 within 30 s of
 *                               the last manual run, 409
 *                               not_implemented for a job whose phase is not built, 503 when the
 *                               queue is not configured. It enqueues like a scheduled run, so the
 *                               lock and the Exact budget apply unchanged.
 */
import { auditStatement } from "../db/audit";
import {
  checkScheduleRules,
  describeSchedule,
  GLOBAL_MIN_INTERVAL_MINUTES,
  MAX_PROJECTED_EXACT_CALLS_PER_DAY,
  nextRun,
  projectedExactCalls,
  validateSchedule,
  type ExactJobLoad,
  type Schedule,
} from "@camelthorn/core";
import { isStepUpFresh } from "../auth/session";
import { json, type Ctx, type Router } from "../router";
import { defaultJobFor } from "./defaults";
import { handlerFor, isImplemented } from "./handlers";
import { createManualRun, LAST_TICK_KEY, parseSchedule } from "./runner";
import { DEFAULT_RUN_ROLES, type JobRow, type RunRow } from "./types";

const ANY_ROLE = { roles: ["admin", "finance", "approver", "viewer"] } as const;
const ADMIN = { roles: ["admin"] } as const;
// The route lets every signed-in role in; runNow applies the handler's own runRoles and stepUp.

/** Hard server-side ceiling for Exact calls per administration and run. */
export const MAX_EXACT_BUDGET = 1000;
const MAX_RUNS_LIMIT = 100;
const DEFAULT_RUNS_LIMIT = 20;

const iso = (ms: number): string => new Date(ms).toISOString();

function parseSummary(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runView(r: RunRow & { job_name?: string }) {
  const result = parseSummary(r.result_json) as { summary?: unknown } | null;
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    attempt: r.attempt,
    requestedBy: r.requested_by,
    scheduledFor: r.scheduled_for,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    errorCode: r.error_code,
    callsUsed: r.calls_used,
    summary: result?.summary ?? null,
  };
}

interface LastRunRow extends RunRow {
  job_id: number;
}

async function listJobs(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const jobs = await db.prepare("SELECT * FROM jobs ORDER BY id").all<JobRow>();
  // The latest run of each job (any status), and whether one is queued or running.
  const last = await db
    .prepare(
      `SELECT r.* FROM job_runs r
       WHERE r.id = (SELECT MAX(id) FROM job_runs WHERE job_id = r.job_id)`,
    )
    .all<LastRunRow>();
  const open = await db
    .prepare("SELECT DISTINCT job_id FROM job_runs WHERE status IN ('queued', 'running')")
    .all<{ job_id: number }>();
  const lastByJob = new Map(last.results.map((r) => [r.job_id, r]));
  const busy = new Set(open.results.map((r) => r.job_id));
  const tick = await db
    .prepare("SELECT json_extract(value_json, '$.at') AS at FROM settings WHERE key = ?1")
    .bind(LAST_TICK_KEY)
    .first<{ at: string | null }>();

  return json({
    scheduler: {
      queueConfigured: typeof ctx.env.JOBS_QUEUE?.send === "function",
      lastTickAt: tick?.at ?? null,
      now: iso(ctx.nowMs),
    },
    maxExactBudget: MAX_EXACT_BUDGET,
    maxProjectedExactCallsPerDay: MAX_PROJECTED_EXACT_CALLS_PER_DAY,
    jobs: jobs.results.map((j) => {
      const def = handlerFor(j.handler);
      const schedule = parseSchedule(j.schedule_json);
      const lastRun = lastByJob.get(j.id);
      return {
        id: j.id,
        name: j.name,
        title: def?.title ?? j.name,
        description: def?.description ?? "",
        implemented: isImplemented(j.handler),
        phase: def?.phase ?? null,
        usesExact: def?.usesExact ?? false,
        runRoles: def?.runRoles ?? DEFAULT_RUN_ROLES,
        stepUpToRun: def?.stepUp === true,
        maxLatenessMinutes:
          def?.maxLatenessMs === undefined ? null : Math.round(def.maxLatenessMs / 60_000),
        scheduleRules: {
          minIntervalMinutes: Math.max(
            def?.scheduleRules?.minIntervalMinutes ?? 0,
            GLOBAL_MIN_INTERVAL_MINUTES,
          ),
          allowedIntervalMinutes: def?.scheduleRules?.allowedIntervalMinutes ?? null,
          workingDaysOnly: def?.scheduleRules?.workingDaysOnly === true,
        },
        // Admin-visible: a default job that ships switched off says why (until it is switched on).
        defaultEnabled: defaultJobFor(j.name)?.enabled ?? null,
        ...(j.enabled !== 1 && defaultJobFor(j.name)?.disabledReason
          ? { disabledReason: defaultJobFor(j.name)?.disabledReason }
          : {}),
        schedule,
        scheduleText: schedule ? describeSchedule(schedule) : "Invalid schedule",
        timezone: j.timezone,
        enabled: j.enabled === 1,
        exactBudget: j.exact_budget,
        /** Send back with PATCH; a stale one gets 409 conflict. */
        rev: j.rev,
        nextRunAt: j.enabled === 1 ? j.next_run_at : null,
        running: busy.has(j.id),
        lastRun: lastRun ? runView(lastRun) : null,
      };
    }),
  });
}

function jobId(ctx: Ctx): number | null {
  const v = ctx.params["id"] ?? "";
  return /^[1-9][0-9]{0,9}$/.test(v) ? Number(v) : null;
}

async function loadJob(ctx: Ctx, id: number): Promise<JobRow | null> {
  return ctx.env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<JobRow>();
}

async function listRuns(ctx: Ctx): Promise<Response> {
  const id = jobId(ctx);
  if (id === null) return json({ error: "not_found" }, 404);
  const job = await loadJob(ctx, id);
  if (!job) return json({ error: "not_found" }, 404);
  const raw = ctx.url.searchParams.get("limit");
  let limit = DEFAULT_RUNS_LIMIT;
  if (raw !== null) {
    if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) < 1) return json({ error: "invalid_limit" }, 400);
    limit = Math.min(Number(raw), MAX_RUNS_LIMIT);
  }
  const runs = await ctx.env.DB.prepare(
    "SELECT * FROM job_runs WHERE job_id = ?1 ORDER BY id DESC LIMIT ?2",
  )
    .bind(id, limit)
    .all<RunRow>();
  return json({ jobId: id, runs: runs.results.map(runView) });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await request.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function patchJob(ctx: Ctx): Promise<Response> {
  const id = jobId(ctx);
  const email = ctx.session?.email;
  if (id === null || !email) return json({ error: "not_found" }, 404);
  const body = await readBody(ctx.request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const allowed = new Set(["enabled", "schedule", "exactBudget", "rev"]);
  const keys = Object.keys(body);
  if (keys.some((k) => !allowed.has(k)) || keys.filter((k) => k !== "rev").length === 0) {
    return json({ error: "invalid_body" }, 400);
  }
  if ("rev" in body && body["rev"] !== null && typeof body["rev"] !== "string") {
    return json({ error: "invalid_body" }, 400);
  }
  const job = await loadJob(ctx, id);
  if (!job) return json({ error: "not_found" }, 404);
  // Optimistic concurrency across requests: the screen sends the rev it was shown, so an edit made
  // from a stale page never silently overwrites somebody else's newer one.
  if ("rev" in body && body["rev"] !== job.rev) return json({ error: "conflict" }, 409);
  const def = handlerFor(job.handler);

  let enabled = job.enabled === 1;
  if ("enabled" in body) {
    if (typeof body["enabled"] !== "boolean") return json({ error: "invalid_enabled" }, 400);
    enabled = body["enabled"];
  }
  let schedule: Schedule | null = parseSchedule(job.schedule_json);
  let scheduleChanged = false;
  if ("schedule" in body) {
    const v = validateSchedule(body["schedule"]);
    // A stable code for programs, and the validator's sentence for people.
    if (!v.ok) return json({ error: "schedule_invalid", message: v.error }, 400);
    // Per-handler limits (no every-minute jobs, Revolut 5 to 15 minutes, ECB on working days).
    const refused = checkScheduleRules(v.schedule, def?.scheduleRules);
    if (refused !== null) return json({ error: "schedule_not_allowed", message: refused }, 400);
    schedule = v.schedule;
    scheduleChanged = true;
  }
  if (schedule === null) return json({ error: "schedule_invalid" }, 400);
  let budget = job.exact_budget;
  if ("exactBudget" in body) {
    const b = body["exactBudget"];
    if (typeof b !== "number" || !Number.isInteger(b) || b < 1 || b > MAX_EXACT_BUDGET) {
      return json({ error: "invalid_budget", max: MAX_EXACT_BUDGET }, 400);
    }
    if (def?.usesExact !== true) return json({ error: "budget_not_applicable" }, 400);
    budget = b;
  }

  // Switching a job on with a schedule stored before these rules existed (or edited directly in
  // D1) is checked like a new schedule: enabling must not bypass the per-handler limits.
  if (!scheduleChanged && enabled && job.enabled !== 1) {
    const refused = checkScheduleRules(schedule, def?.scheduleRules);
    if (refused !== null) return json({ error: "schedule_not_allowed", message: refused }, 400);
  }

  // The Exact jobs together must stay inside the daily budget: fires per Amsterdam day (the 25-hour
  // autumn day counts) x calls per run x attempts, summed over the enabled Exact jobs. Checked on
  // every change that leaves this Exact job on (switching it on, a new budget, a new schedule). A
  // change that lowers the load is always allowed, so an installation that is over the cap (for
  // example from before the cap existed) can be brought down step by step.
  if (def?.usesExact === true && enabled) {
    const all = await ctx.env.DB.prepare("SELECT * FROM jobs ORDER BY id").all<JobRow>();
    const loads = (withChange: boolean): ExactJobLoad[] => {
      const out: ExactJobLoad[] = [];
      for (const other of all.results) {
        const od = handlerFor(other.handler);
        if (od?.usesExact !== true) continue;
        const mine = other.id === job.id && withChange;
        if (!mine && other.enabled !== 1) continue;
        const sch = mine ? schedule : parseSchedule(other.schedule_json);
        if (sch === null) continue;
        out.push({
          schedule: sch,
          budget: mine ? budget : other.exact_budget,
          maxAttempts: od.maxAttempts,
          ...(od.dailyExactCallCap !== undefined ? { dailyCap: od.dailyExactCallCap } : {}),
        });
      }
      return out;
    };
    const projected = projectedExactCalls(loads(true));
    if (
      projected > MAX_PROJECTED_EXACT_CALLS_PER_DAY &&
      projected > projectedExactCalls(loads(false))
    ) {
      return json(
        {
          error: "budget_cap_exceeded",
          projected,
          max: MAX_PROJECTED_EXACT_CALLS_PER_DAY,
          message: `The switched-on Exact jobs would use up to ${projected.toLocaleString("en-US")} calls per administration per day. The most allowed is ${MAX_PROJECTED_EXACT_CALLS_PER_DAY.toLocaleString("en-US")}.`,
        },
        400,
      );
    }
  }

  const before = {
    enabled: job.enabled === 1,
    schedule: parseSchedule(job.schedule_json),
    exactBudget: job.exact_budget,
  };
  const after = { enabled, schedule, exactBudget: budget };
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return json({ id, changed: false });
  }
  // A new schedule, or switching a job on, starts counting from now: no catch-up for the past.
  const restart = scheduleChanged || (enabled && job.enabled !== 1);
  // Otherwise the baseline stays, and the next run is the first slot after it (the one the tick
  // will claim; it may be due right now).
  const baseline = restart
    ? ctx.nowMs
    : Date.parse(job.last_scheduled_at ?? "") || Date.parse(job.created_at) || ctx.nowMs;
  const next = enabled ? nextRun(schedule, baseline) : null;
  const rev = crypto.randomUUID();
  const now = iso(ctx.nowMs);
  const db = ctx.env.DB;
  const [upd, audit] = await db.batch([
    db
      .prepare(
        `UPDATE jobs SET enabled = ?2, schedule_json = ?3, exact_budget = ?4,
           next_run_at = ?5, last_scheduled_at = CASE WHEN ?6 = 1 THEN ?7 ELSE last_scheduled_at END,
           rev = ?8, updated_at = ?7, updated_by = ?9
         WHERE id = ?1 AND rev IS ?10`,
      )
      .bind(
        id,
        enabled ? 1 : 0,
        JSON.stringify(schedule),
        budget,
        next === null ? null : iso(next),
        restart ? 1 : 0,
        now,
        rev,
        email,
        job.rev,
      ),
    auditStatement(
      db,
      {
        actorEmail: email,
        action: "job.update",
        entity: "job",
        entityId: id,
        before: { job: job.name, ...before },
        after: { job: job.name, ...after },
      },
      { sql: "(SELECT rev FROM jobs WHERE id = ?7) = ?8", binds: [id, rev] },
    ),
  ]);
  if (upd?.meta.changes !== 1 || audit?.meta.changes !== 1) {
    // Somebody else changed the job between our read and write; nothing was written.
    return json({ error: "conflict" }, 409);
  }
  return json({ id, changed: true });
}

async function runNow(ctx: Ctx): Promise<Response> {
  const id = jobId(ctx);
  const email = ctx.session?.email;
  if (id === null || !email) return json({ error: "not_found" }, 404);
  const job = await loadJob(ctx, id);
  if (!job) return json({ error: "not_found" }, 404);
  // Who may start this job by hand is part of the handler's contract (review S1).
  const def = handlerFor(job.handler);
  const roles = def?.runRoles ?? DEFAULT_RUN_ROLES;
  if (!ctx.session || !ctx.session.roles.some((r) => roles.includes(r))) {
    return json({ error: "forbidden" }, 403);
  }
  if (def?.stepUp === true && !isStepUpFresh(ctx.session, ctx.nowMs)) {
    return json({ error: "step_up_required" }, 401);
  }
  // A disabled job may run on demand, but only if there is something to run.
  if (!isImplemented(job.handler)) return json({ error: "not_implemented" }, 409);
  if (typeof ctx.env.JOBS_QUEUE?.send !== "function") {
    return json({ error: "queue_not_configured" }, 503);
  }
  const r = await createManualRun(ctx.env, job, email, ctx.nowMs);
  if (!r.ok) {
    if (r.reason === "already_running") return json({ error: "already_running" }, 409);
    return json({ error: "cooldown", retryAfterSeconds: r.retryAfterSeconds }, 429);
  }
  return json({ runId: r.runId, status: "queued" }, 202);
}

export function registerJobRoutes(router: Router): void {
  router.add("GET", "/api/jobs", ANY_ROLE, listJobs);
  router.add("GET", "/api/jobs/:id/runs", ANY_ROLE, listRuns);
  router.add("PATCH", "/api/jobs/:id", ADMIN, patchJob);
  router.add("POST", "/api/jobs/:id/run", ANY_ROLE, runNow);
}
