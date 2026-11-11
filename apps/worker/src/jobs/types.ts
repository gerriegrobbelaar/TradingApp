/** Shared types of the job runner (CLAUDE.md 4.1). */
import type { Env } from "../env";
import type { SyncDeps } from "../exact/sync";

/** The queue message. Only ids: the row in job_runs is the source of truth. */
export interface JobMessage {
  runId: number;
  jobId: number;
}

/** Final outcome of a run. */
export type RunOutcome = "ok" | "partial" | "error" | "skipped";
export type RunStatus = "queued" | "running" | RunOutcome;
export type RunTrigger = "schedule" | "manual" | "retry";

export const TERMINAL: ReadonlySet<string> = new Set(["ok", "partial", "error", "skipped"]);

/** What a handler sees of its job and run. */
export interface JobContext {
  env: Env;
  job: { id: number; name: string; handler: string; exactBudget: number };
  run: {
    id: number;
    attempt: number;
    scheduledFor: string;
    /** User email for a manual run, else `system`. */
    requestedBy: string;
  };
  trigger: RunTrigger;
  /** Exact calls this run may spend per administration (jobs.exact_budget). */
  budget: number;
  /** Epoch ms after which the handler must stop starting new work. */
  deadlineMs: number;
  /** Aborted at the deadline, or when the lock lease was lost. */
  signal: AbortSignal;
  /** Structured log line: an event name and small, non-secret fields only. */
  log: (event: string, fields?: Record<string, string | number | boolean | null>) => void;
  now: () => number;
  /** Test seam: replaces the Exact transport and gate. Never set in production. */
  syncDeps?: SyncDeps;
}

export interface HandlerResult {
  status: RunOutcome;
  /** Small summary: counts and codes only (no tokens, IBANs, bodies). Truncated when stored. */
  summary: Record<string, unknown>;
  /** Machine-readable reason for skipped / error / partial. */
  code?: string;
  /** Exact calls used, if known. */
  callsUsed?: number;
  /** Ask the runner to run this job again soon (bounded by the handler's maxAttempts). */
  retry?: { delaySeconds: number };
}

export interface HandlerDef {
  title: string;
  description: string;
  /** Spends Exact calls (the budget field applies). */
  usesExact: boolean;
  /** The phase that builds it, shown while it is `not_implemented`. */
  phase: string | null;
  /** Total attempts including the first; retries only apply to scheduled runs. */
  maxAttempts: number;
  /** Undefined = not implemented yet: runs are recorded as skipped with code not_implemented. */
  run?: (ctx: JobContext) => Promise<HandlerResult>;
}

export interface JobRow {
  id: number;
  name: string;
  handler: string;
  kind: string;
  schedule_json: string;
  timezone: string;
  enabled: number;
  exact_budget: number;
  created_at: string;
  last_scheduled_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_result_json: string | null;
  next_run_at: string | null;
  rev: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface RunRow {
  id: number;
  job_id: number;
  scheduled_for: string;
  attempt: number;
  status: RunStatus;
  trigger: RunTrigger;
  requested_by: string;
  queued_at: string;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  runner_token: string | null;
  result_json: string | null;
  error_code: string | null;
  calls_used: number;
  enqueue_count: number;
}
