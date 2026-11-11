import { env } from "cloudflare:test";
import type { Schedule } from "@camelthorn/core";
import type { Env } from "../src/env";
import type { SubrequestMeter, SyncDeps } from "../src/exact/sync";
import {
  FULL_SYNC_BUDGET,
  INCREMENTAL_SYNC_BUDGET,
  runExactSync,
} from "../src/jobs/exact-handlers";
import { executeRun, type RunnerDeps } from "../src/jobs/runner";
import type { HandlerDef, HandlerResult, JobContext, JobMessage } from "../src/jobs/types";

export const db = env.DB;

/** Records what the scheduler enqueues; nothing is delivered by itself (tests drive the consumer). */
export class FakeQueue {
  sent: { body: JobMessage; delaySeconds: number; at: number }[] = [];
  fail = false;
  constructor(private readonly clock: () => number = Date.now) {}
  async send(body: JobMessage, opts?: { delaySeconds?: number }): Promise<void> {
    if (this.fail) throw new Error("queue down");
    this.sent.push({ body, delaySeconds: opts?.delaySeconds ?? 0, at: this.clock() });
  }
  /** Removes and returns the messages whose delay has passed at `nowMs`. */
  due(nowMs: number): JobMessage[] {
    const ready = this.sent.filter((m) => m.at + m.delaySeconds * 1000 <= nowMs);
    this.sent = this.sent.filter((m) => !ready.includes(m));
    return ready.map((m) => m.body);
  }
}

/** The test env with a recording queue instead of the real binding. */
export function envWith(queue: FakeQueue | undefined): Env {
  return Object.create(env, {
    JOBS_QUEUE: { value: queue, enumerable: true },
  }) as Env;
}

export async function addJob(
  j: {
    name: string;
    handler?: string;
    schedule?: Schedule;
    enabled?: boolean;
    exactBudget?: number;
    createdAt?: string;
    lastScheduledAt?: string | null;
  } = { name: "t.job" },
): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO jobs (name, handler, kind, schedule_json, enabled, exact_budget, created_at, last_scheduled_at)
       VALUES (?1, ?2, 'system', ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      j.name,
      j.handler ?? j.name,
      JSON.stringify(j.schedule ?? { kind: "cron", expr: "* * * * *" }),
      j.enabled === false ? 0 : 1,
      j.exactBudget ?? 0,
      j.createdAt ?? "2026-01-01T00:00:00.000Z",
      j.lastScheduledAt ?? null,
    )
    .run();
  return r.meta.last_row_id;
}

export async function addRun(
  jobId: number,
  o: {
    status?: string;
    trigger?: string;
    scheduledFor?: string;
    attempt?: number;
    heartbeatAt?: string | null;
    startedAt?: string | null;
    enqueuedAt?: string;
    enqueueCount?: number;
    requestedBy?: string;
  } = {},
): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO job_runs (job_id, scheduled_for, attempt, status, trigger, requested_by, queued_at,
                             enqueued_at, started_at, heartbeat_at, enqueue_count)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      jobId,
      o.scheduledFor ?? new Date().toISOString(),
      o.attempt ?? 1,
      o.status ?? "queued",
      o.trigger ?? "schedule",
      o.requestedBy ?? "system",
      o.enqueuedAt ?? new Date().toISOString(),
      o.startedAt ?? null,
      o.heartbeatAt ?? null,
      o.enqueueCount ?? 1,
    )
    .run();
  return r.meta.last_row_id;
}

export interface RunView {
  id: number;
  job_id: number;
  status: string;
  trigger: string;
  attempt: number;
  error_code: string | null;
  result_json: string | null;
  scheduled_for: string;
  requested_by: string;
}

export async function runsOf(jobId: number): Promise<RunView[]> {
  return (
    await db
      .prepare("SELECT * FROM job_runs WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<RunView>()
  ).results;
}

export async function runById(id: number): Promise<RunView> {
  return (await db
    .prepare("SELECT * FROM job_runs WHERE id = ?1")
    .bind(id)
    .first<RunView>()) as RunView;
}

export const def = (
  run: ((ctx: JobContext) => Promise<HandlerResult>) | undefined,
  o: Partial<HandlerDef> = {},
): HandlerDef => ({
  title: "Test",
  description: "",
  usesExact: false,
  phase: null,
  maxAttempts: 1,
  ...(run ? { run } : {}),
  ...o,
});

export const ok = (summary: Record<string, unknown> = {}): HandlerResult => ({
  status: "ok",
  summary,
});

/** Delivers every due message once; returns the run ids that were delivered. */
export async function deliver(
  e: Env,
  q: FakeQueue,
  nowMs: number,
  deps: RunnerDeps,
): Promise<number[]> {
  const delivered: number[] = [];
  for (const m of q.due(nowMs)) {
    delivered.push(m.runId);
    await executeRun(e, m.runId, deps);
  }
  return delivered;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Calls the Exact sync handler directly with a hand-made context (the unit under test). */
export async function callExact(
  mode: "full" | "incremental",
  nowMs: number,
  syncDeps: SyncDeps,
  o: {
    trigger?: "schedule" | "manual" | "retry";
    meter?: SubrequestMeter;
    budget?: number;
    runId?: number;
    signal?: AbortSignal;
  } = {},
): Promise<HandlerResult> {
  const ctx: JobContext = {
    env,
    job: { id: 1, name: `exact.${mode}_sync`, handler: `exact.${mode}_sync`, exactBudget: 0 },
    run: {
      id: o.runId ?? 1,
      attempt: 1,
      scheduledFor: new Date(nowMs).toISOString(),
      requestedBy: "system",
    },
    trigger: o.trigger ?? "schedule",
    budget: o.budget ?? (mode === "full" ? FULL_SYNC_BUDGET : INCREMENTAL_SYNC_BUDGET),
    deadlineMs: nowMs + 60 * 60_000,
    signal: o.signal ?? new AbortController().signal,
    log: () => undefined,
    now: () => nowMs,
    syncDeps: { ...syncDeps, now: syncDeps.now ?? (() => nowMs) },
  };
  return runExactSync(mode, ctx, o.meter);
}

/** `summary.divisions` of an Exact job result. */
export const divisionsOf = (r: HandlerResult): { id: number; status: string; why?: string }[] =>
  (r.summary["divisions"] as { id: number; status: string; why?: string }[] | undefined) ?? [];
