/**
 * STOPGAP scheduler for the Exact sync. Phase 3 replaces this with the jobs table, job_runs and
 * the cron -> Queue pipeline (CLAUDE.md 4.1); do not extend it. It exists so a connected division
 * stays fresh before that framework lands:
 *   - the cron trigger fires every hour (UTC, see wrangler.toml);
 *   - between 02:00 and 05:59 Amsterdam time the first tick without a completed full sync that
 *     Amsterdam day runs a FULL sync; every other tick runs an INCREMENTAL one.
 * "02:00 Amsterdam" is decided from the Amsterdam wall clock, not from a UTC hour, so it follows
 * daylight saving time: on the spring-forward day 02:00 does not exist (the tick at 03:00 runs the
 * full sync instead), and on the fall-back day 02:00 happens twice (the second one sees today's
 * full sync already done and runs incrementally). The window up to 05:59 lets a partial full sync
 * resume on the next ticks without hammering the Exact budget all day. Only a PARTIAL (or
 * interrupted) full sync is retried in the window: a full sync that ended in `error` or
 * `needs_reauth` is not repeated that day (each attempt costs up to SCHEDULED_FULL_BUDGET of
 * the 5,000 daily calls), the next nightly run tries again.
 * One invocation shares a deadline (SCHEDULED_MAX_MS) and a subrequest meter across divisions;
 * once either runs out the remaining divisions wait for the next tick.
 * Skips silently when there is no Exact connection or it is not active (for example needs_reauth).
 * Never throws: every failure is caught and logged by name only.
 */
import type { Env } from "../env";
import { amsterdamParts } from "./local-time";
import {
  newMeter,
  SUBREQUEST_RESERVE,
  syncDivision,
  type SubrequestMeter,
  type SyncDeps,
  type SyncMode,
} from "./sync";

export const FULL_SYNC_FIRST_HOUR = 2;
export const FULL_SYNC_LAST_HOUR = 5;
export const SCHEDULED_FULL_BUDGET = 600;
export const SCHEDULED_INCREMENTAL_BUDGET = 120;
/**
 * Wall time one scheduled invocation may spend syncing, checked before every Exact call. Below
 * the 15-minute Cron Trigger limit and the 15-minute sync lease.
 */
export const SCHEDULED_MAX_MS = 12 * 60 * 1000;

/** The last run of a division (sync_state entity 'run'). */
export interface LastRun {
  mode: string | null;
  status: string | null;
  startedAt: string | null;
}

const dayOf = (iso: string | null): string | null => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : amsterdamParts(ms).date;
};

/**
 * Pure decision, tested across DST changes. `lastFullOkIso` is sync_state.last_full_completed_at;
 * `lastRun` the last run of the division (to avoid repeating a failed full sync).
 */
export function scheduledMode(
  nowMs: number,
  lastFullOkIso: string | null,
  lastRun: LastRun | null = null,
): SyncMode {
  const local = amsterdamParts(nowMs);
  if (local.hour < FULL_SYNC_FIRST_HOUR || local.hour > FULL_SYNC_LAST_HOUR) return "incremental";
  if (dayOf(lastFullOkIso) === local.date) return "incremental";
  if (
    lastRun !== null &&
    lastRun.mode === "full" &&
    (lastRun.status === "error" || lastRun.status === "needs_reauth") &&
    dayOf(lastRun.startedAt) === local.date
  ) {
    return "incremental";
  }
  return "full";
}

export interface ScheduledResult {
  ran: { divisionId: number; mode: SyncMode; status: string }[];
  skipped: "no_connection" | "not_active" | null;
}

export async function runScheduledExactSync(
  env: Env,
  nowMs: number = Date.now(),
  deps: SyncDeps = {},
  meter: SubrequestMeter = newMeter(),
): Promise<ScheduledResult> {
  const clock = deps.now ?? Date.now;
  const deadlineMs = clock() + SCHEDULED_MAX_MS;
  meter.used += 2;
  const conn = await env.DB.prepare(
    "SELECT id, status FROM connections WHERE kind = 'exact' ORDER BY id LIMIT 1",
  ).first<{ id: number; status: string }>();
  if (!conn) return { ran: [], skipped: "no_connection" };
  if (conn.status !== "active") return { ran: [], skipped: "not_active" };

  const divisions = await env.DB.prepare(
    `SELECT d.id, d.connection_id, d.exact_division, d.base_currency, s.last_full_completed_at,
            s.mode, s.last_status, s.last_started_at
     FROM divisions d
     LEFT JOIN sync_state s ON s.division_id = d.id AND s.entity = 'run'
     WHERE d.connection_id = ?1 ORDER BY d.id`,
  )
    .bind(conn.id)
    .all<{
      id: number;
      connection_id: number;
      exact_division: number;
      base_currency: string;
      last_full_completed_at: string | null;
      mode: string | null;
      last_status: string | null;
      last_started_at: string | null;
    }>();

  const stamp = new Date(nowMs).toISOString().slice(0, 13).replace(/\D/g, "");
  const ran: ScheduledResult["ran"] = [];
  for (const d of divisions.results) {
    // Out of time or subrequests: the remaining divisions wait for the next tick.
    if (clock() >= deadlineMs || meter.used + SUBREQUEST_RESERVE * 2 > meter.limit) break;
    const mode = scheduledMode(nowMs, d.last_full_completed_at, {
      mode: d.mode,
      status: d.last_status,
      startedAt: d.last_started_at,
    });
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
          jobId: `sync:${mode}:${d.exact_division}:${stamp}`,
          mode,
          budget: mode === "full" ? SCHEDULED_FULL_BUDGET : SCHEDULED_INCREMENTAL_BUDGET,
          actor: "system",
          deadlineMs,
          meter,
        },
        deps,
      );
      ran.push({ divisionId: d.id, mode, status: summary.status });
      // No point trying the other divisions of a connection that needs a person.
      if (summary.status === "needs_reauth") break;
    } catch (e) {
      console.error("scheduled exact sync failed", e instanceof Error ? e.name : "unknown");
      ran.push({ divisionId: d.id, mode, status: "error" });
    }
  }
  return { ran, skipped: null };
}
