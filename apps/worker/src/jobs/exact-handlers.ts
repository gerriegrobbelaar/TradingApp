/**
 * The Exact sync jobs `exact.full_sync` (daily 02:00 Amsterdam) and `exact.incremental_sync`
 * (hourly). They replace the Phase 2 stopgap in exact/scheduled.ts and keep its behaviour:
 *
 *  - When a job runs is decided by its own schedule (so 02:00 Amsterdam follows daylight saving
 *    time by itself); a full sync is never started by an hourly tick any more.
 *  - A full sync that stops partway (budget, rate limit, time, transient Exact failure) is
 *    re-queued by the runner with a delay, at most FULL_SYNC_MAX_ATTEMPTS attempts in all, and a
 *    retry only visits divisions that have not completed a full sync today. A full sync that
 *    failed permanently (error, needs_reauth) is not retried. The per-day transient counter in
 *    sync_state (MAX_TRANSIENT_RETRIES) still turns an endless transient failure into an error.
 *  - Skips when there is no Exact connection or it is not active (needs_reauth). While Exact
 *    rejects the app's client credentials (connections.last_error = CREDENTIALS_REJECTED) both
 *    jobs skip; once a day, at CREDENTIALS_PROBE_HOUR, the incremental job probes with one
 *    incremental run of one division (a successful refresh clears last_error).
 *  - One invocation shares a deadline and a subrequest meter across divisions; divisions are
 *    taken least recently completed first, so a slow one cannot starve the others. Only divisions
 *    with sync_enabled = 1 are synced. Hourly runs refresh divisions and relations only; open
 *    items are read by the nightly full pass unless the admin setting
 *    `exact.incremental_open_items` is on (review S4).
 *
 * Calls per administration and day, worst case (ADR 0017, updated for jobs): a full sync costs
 * `exact_budget` (240) per attempt and has at most 4 attempts; the hourly job (40 per run) runs at
 * most 25 times on the fall-back day: 4 x 240 + 25 x 40 = 1,960 of Exact's 5,000, which leaves
 * 3,000 for people and later jobs. Manual runs come on top (the gate still enforces 5,000).
 */
import { amsterdamParts } from "@camelthorn/core";
import { CREDENTIALS_REJECTED } from "../exact/gate";
import {
  MAX_TRANSIENT_RETRIES,
  newMeter,
  SUBREQUEST_RESERVE,
  syncDivision,
  type SubrequestMeter,
  type SyncMode,
} from "../exact/sync";
import type { HandlerResult, JobContext } from "./types";

/** Exact calls per run and administration (the defaults of the two jobs). */
export const FULL_SYNC_BUDGET = 240;
export const INCREMENTAL_SYNC_BUDGET = 40;
/** The first run plus MAX_TRANSIENT_RETRIES retries. */
export const FULL_SYNC_MAX_ATTEMPTS = 1 + MAX_TRANSIENT_RETRIES;
/** Most runs of the hourly job in one Amsterdam day (the fall-back day has 25 hours). */
export const MAX_INCREMENTAL_RUNS_PER_DAY = 25;
export const SCHEDULED_WORST_CASE_CALLS_PER_DAY =
  FULL_SYNC_MAX_ATTEMPTS * FULL_SYNC_BUDGET +
  MAX_INCREMENTAL_RUNS_PER_DAY * INCREMENTAL_SYNC_BUDGET;
/** Wait before a partial full sync continues. */
export const FULL_SYNC_RETRY_DELAY_SECONDS = 300;
/** Wall time one run may spend syncing; below the 15-minute queue consumer limit. */
export const SYNC_MAX_MS = 12 * 60 * 1000;
/** Amsterdam hour of the daily probe while the client credentials are rejected (exists every day). */
export const CREDENTIALS_PROBE_HOUR = 3;

interface DivisionRow {
  id: number;
  connection_id: number;
  exact_division: number;
  base_currency: string;
  last_full_completed_at: string | null;
  mode: string | null;
  last_status: string | null;
  last_started_at: string | null;
  retry_count: number | null;
  retry_day: string | null;
}

const dayOf = (iso: string | null): string | null => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : amsterdamParts(ms).date;
};

type DivisionOutcome = "ok" | "partial" | "error" | "needs_reauth" | "skipped";

export async function runExactSync(
  mode: SyncMode,
  ctx: JobContext,
  meter: SubrequestMeter = newMeter(),
): Promise<HandlerResult> {
  const { env } = ctx;
  const deps = ctx.syncDeps ?? {};
  const clock = deps.now ?? ctx.now;
  const nowMs = clock();
  const deadlineMs = Math.min(ctx.deadlineMs, clock() + SYNC_MAX_MS);
  meter.used += 2;

  const conn = await env.DB.prepare(
    "SELECT id, status, last_error FROM connections WHERE kind = 'exact' ORDER BY id LIMIT 1",
  ).first<{ id: number; status: string; last_error: string | null }>();
  if (!conn) return { status: "skipped", code: "no_connection", summary: {} };
  if (conn.status !== "active") return { status: "skipped", code: "not_active", summary: {} };
  const rejected = conn.last_error === CREDENTIALS_REJECTED;
  const probe =
    rejected && mode === "incremental" && amsterdamParts(nowMs).hour === CREDENTIALS_PROBE_HOUR;
  if (rejected && !probe) return { status: "skipped", code: "credentials_rejected", summary: {} };

  const divisions = await env.DB.prepare(
    `SELECT d.id, d.connection_id, d.exact_division, d.base_currency, s.last_full_completed_at,
            s.mode, s.last_status, s.last_started_at, s.retry_count, s.retry_day
     FROM divisions d
     LEFT JOIN sync_state s ON s.division_id = d.id AND s.entity = 'run'
     WHERE d.connection_id = ?1 AND d.sync_enabled = 1
     ORDER BY COALESCE(s.last_completed_at, '') ASC, d.id`,
  )
    .bind(conn.id)
    .all<DivisionRow>();
  if (divisions.results.length === 0) {
    return { status: "skipped", code: "no_divisions", summary: {} };
  }

  const today = amsterdamParts(nowMs).date;
  const manual = ctx.trigger === "manual";
  const rows: { id: number; status: DivisionOutcome; why?: string }[] = [];
  let calls = 0;
  let retryWanted = false;
  let errorCode: string | undefined;

  for (const d of divisions.results) {
    // Out of time, subrequests or aborted: the remaining divisions wait for the next run.
    if (
      ctx.signal.aborted ||
      clock() >= deadlineMs ||
      meter.used + SUBREQUEST_RESERVE * 2 > meter.limit
    ) {
      rows.push({ id: d.id, status: "partial", why: "not_reached" });
      retryWanted = true;
      continue;
    }
    if (mode === "full" && !manual) {
      // A retry only visits divisions whose full sync is not finished today; a full sync that
      // failed permanently today, or ran out of transient retries, is left to tomorrow.
      if (dayOf(d.last_full_completed_at) === today) {
        rows.push({ id: d.id, status: "skipped", why: "done_today" });
        continue;
      }
      if (
        d.mode === "full" &&
        (d.last_status === "error" || d.last_status === "needs_reauth") &&
        dayOf(d.last_started_at) === today
      ) {
        rows.push({ id: d.id, status: "skipped", why: "failed_today" });
        continue;
      }
      if (d.retry_day === today && (d.retry_count ?? 0) > MAX_TRANSIENT_RETRIES) {
        rows.push({ id: d.id, status: "skipped", why: "retries_used" });
        continue;
      }
    }
    try {
      const summary = await syncDivision(
        env,
        {
          id: d.id,
          connectionId: d.connection_id,
          exactDivision: d.exact_division,
          currency: d.base_currency,
        },
        {
          jobId: `sync:${mode}:${d.exact_division}:r${ctx.run.id}`,
          mode,
          budget: ctx.budget,
          actor: ctx.run.requestedBy,
          deadlineMs,
          meter,
        },
        deps,
      );
      calls += summary.callsUsed;
      if (summary.status === "locked" || summary.status === "cooldown") {
        // Another sync of this administration is running (for example the hourly run meeting the
        // nightly one): nothing to do now; a full sync tries again.
        rows.push({ id: d.id, status: "skipped", why: "sync_locked" });
        if (mode === "full") retryWanted = true;
      } else {
        rows.push({ id: d.id, status: summary.status });
        if (summary.status === "partial" && mode === "full") retryWanted = true;
        if (summary.status === "error" || summary.status === "partial") {
          const failed = Object.values(summary.entities).find(
            (e) => e.error !== undefined && e.status !== "ok" && e.status !== "skipped",
          );
          errorCode ??= failed?.error;
        }
      }
      // No point trying the other divisions of a connection that needs a person; a probe is one
      // division only.
      if (summary.status === "needs_reauth" || probe) break;
    } catch (e) {
      console.error("exact sync job failed", e instanceof Error ? e.name : "unknown");
      rows.push({ id: d.id, status: "error", why: "internal_error" });
      errorCode ??= "internal_error";
      if (probe) break;
    }
  }

  const count = (s: DivisionOutcome) => rows.filter((r) => r.status === s).length;
  const ok = count("ok");
  const partial = count("partial");
  const error = count("error");
  const reauth = count("needs_reauth");
  const summary = {
    mode,
    divisions: rows.map((r) =>
      r.why ? { id: r.id, status: r.status, why: r.why } : { id: r.id, status: r.status },
    ),
    calls,
  };
  let status: HandlerResult["status"];
  let code: string | undefined;
  if (reauth > 0) {
    status = "error";
    code = "needs_reauth";
    retryWanted = false;
  } else if (ok + partial + error === 0) {
    const locked = rows.some((r) => r.why === "sync_locked");
    status = "skipped";
    code = locked ? "sync_locked" : "nothing_to_do";
  } else if (error > 0 && ok === 0 && partial === 0) {
    status = "error";
    code = errorCode ?? "error";
  } else if (error === 0 && partial === 0) {
    status = "ok";
  } else {
    status = "partial";
    code = errorCode;
  }
  return {
    status,
    summary,
    callsUsed: calls,
    ...(code !== undefined ? { code } : {}),
    ...(retryWanted && mode === "full" && status !== "error"
      ? { retry: { delaySeconds: FULL_SYNC_RETRY_DELAY_SECONDS } }
      : {}),
  };
}
