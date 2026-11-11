/** Shared types of the job runner (CLAUDE.md 4.1). */
import type { ScheduleRules } from "@camelthorn/core";
import type { Role } from "../auth/session";
import type { Env } from "../env";
import type { SyncDeps } from "../exact/sync";

/** Roles that may start a job by hand unless the handler says otherwise. */
export const DEFAULT_RUN_ROLES: readonly Role[] = ["admin", "finance"];

/** The queue message. Only ids: the row in job_runs is the source of truth. */
export interface JobMessage {
  runId: number;
  jobId: number;
}

/**
 * A Revolut webhook event to process (task R3a): ids only. The webhook_events row says which
 * transaction to refresh; amounts and state always come from the API, never from the payload.
 */
export interface RevolutEventMessage {
  type: "revolut_event";
  webhookEventId: number;
}

/** Everything that travels on the jobs queue. */
export type QueueMessage = JobMessage | RevolutEventMessage;

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

/**
 * HANDLER CONTRACT (review S1, ADR 0021). Every handler must obey it; the contract test
 * (apps/worker/test/jobs-contract.test.ts) runs each implemented handler twice.
 *
 *  1. At-least-once, rarely concurrent. A run may execute more than once (queue redelivery, a
 *     takeover after a stale heartbeat, a retry) and may briefly overlap a zombie executor whose
 *     lock lease expired. Handlers must be safe to repeat.
 *  2. Idempotency keys come from the BUSINESS object (invoice id, payment id, month), never from
 *     `run.id` or `run.attempt`: those differ between two executions of the same work. Claim the key
 *     (idempotency_keys) before an external write and skip the write if it is already claimed.
 *  3. Derive periods from `run.scheduledFor` (see jobs/period.ts), never from the clock. A late or
 *     retried run of the 31 October slot still works on October.
 *  4. Lateness: a scheduled run that starts later than the handler's `maxLatenessMs` after its slot
 *     is recorded `skipped` / `too_late` by the runner (or `error` / `too_late` when the handler
 *     sets `tooLateIsFailure`); the next slot proceeds as normal. Manual runs are never too late.
 *  5. Check `ctx.signal` between items and stop starting new work once it is aborted (deadline or
 *     lost lease). JavaScript cannot kill a promise; cooperation is the only way to stop a zombie.
 *  6. Retry ONLY by returning `partial` or `skipped` with `retry`. Never throw to get a retry
 *     (apart from transient failures `sync.ts` classifies), never loop on your own.
 *  7. Audit every external write (who, what, when, before/after; CLAUDE.md section 5).
 *  8. The result summary holds counts and codes only: no names, IBANs, e-mail addresses, tokens
 *     or bodies. It is masked and capped at 4,000 characters when stored.
 *  9. Who may start it by hand: `runRoles` (default admin and finance) and, for jobs that move
 *     money or send mail, `stepUp` (a Google sign-in within 15 minutes).
 */
export interface HandlerDef {
  title: string;
  description: string;
  /** Spends Exact calls (the budget field applies). */
  usesExact: boolean;
  /**
   * The handler stops by itself once it used this many Exact calls in an Amsterdam day (and only
   * spends calls when there is work), so the budget projection uses it instead of fires x budget.
   */
  dailyExactCallCap?: number;
  /** The phase that builds it, shown while it is `not_implemented`. */
  phase: string | null;
  /** Total attempts including the first; retries only apply to scheduled runs. */
  maxAttempts: number;
  /** Roles that may use "Run now" (any of them). Default: admin and finance. */
  runRoles?: readonly Role[];
  /** "Run now" needs a Google sign-in within the last 15 minutes. Default false. */
  stepUp?: boolean;
  /**
   * A scheduled (or retry) run that starts more than this long after its slot is recorded
   * `skipped` / `too_late`. Undefined = no limit. Never applies to manual runs.
   */
  maxLatenessMs?: number;
  /**
   * Record a too-late run as `error` / `too_late` instead of `skipped`: for a job whose slot
   * matters (the day's ECB rates), missing it is a failure that alerts must see. Default false.
   */
  tooLateIsFailure?: boolean;
  /**
   * Called (best effort, errors swallowed) when the runner records a run too_late without calling
   * `run`, so a handler that keeps its own health row can record the outcome truthfully.
   */
  onTooLate?: (env: Env, nowMs: number) => Promise<void>;
  /** What an admin may set as the schedule (checked in PATCH /api/jobs, shown in the editor). */
  scheduleRules?: ScheduleRules;
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
