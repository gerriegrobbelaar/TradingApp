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
 * resume on the next ticks without hammering the Exact budget all day.
 * Skips silently when there is no Exact connection or it is not active (for example needs_reauth).
 */
import type { Env } from "../env";
import { amsterdamParts } from "./local-time";
import { syncDivision, type SyncDeps, type SyncMode } from "./sync";

export const FULL_SYNC_FIRST_HOUR = 2;
export const FULL_SYNC_LAST_HOUR = 5;
export const SCHEDULED_FULL_BUDGET = 600;
export const SCHEDULED_INCREMENTAL_BUDGET = 120;

/** Pure decision, tested across DST changes. `lastFullOkIso` is sync_state.last_full_completed_at. */
export function scheduledMode(nowMs: number, lastFullOkIso: string | null): SyncMode {
  const local = amsterdamParts(nowMs);
  if (local.hour < FULL_SYNC_FIRST_HOUR || local.hour > FULL_SYNC_LAST_HOUR) return "incremental";
  const lastFullDay =
    lastFullOkIso === null ? null : amsterdamParts(Date.parse(lastFullOkIso)).date;
  return lastFullDay === local.date ? "incremental" : "full";
}

export interface ScheduledResult {
  ran: { divisionId: number; mode: SyncMode; status: string }[];
  skipped: "no_connection" | "not_active" | null;
}

export async function runScheduledExactSync(
  env: Env,
  nowMs: number = Date.now(),
  deps: SyncDeps = {},
): Promise<ScheduledResult> {
  const conn = await env.DB.prepare(
    "SELECT id, status FROM connections WHERE kind = 'exact' ORDER BY id LIMIT 1",
  ).first<{ id: number; status: string }>();
  if (!conn) return { ran: [], skipped: "no_connection" };
  if (conn.status !== "active") return { ran: [], skipped: "not_active" };

  const divisions = await env.DB.prepare(
    `SELECT d.id, d.connection_id, d.exact_division, s.last_full_completed_at
     FROM divisions d
     LEFT JOIN sync_state s ON s.division_id = d.id AND s.entity = 'run'
     WHERE d.connection_id = ?1 ORDER BY d.id`,
  )
    .bind(conn.id)
    .all<{
      id: number;
      connection_id: number;
      exact_division: number;
      last_full_completed_at: string | null;
    }>();

  const stamp = new Date(nowMs).toISOString().slice(0, 13).replace(/\D/g, "");
  const ran: ScheduledResult["ran"] = [];
  for (const d of divisions.results) {
    const mode = scheduledMode(nowMs, d.last_full_completed_at);
    try {
      const summary = await syncDivision(
        env,
        { id: d.id, connectionId: d.connection_id, exactDivision: d.exact_division },
        {
          jobId: `sync:${mode}:${d.exact_division}:${stamp}`,
          mode,
          budget: mode === "full" ? SCHEDULED_FULL_BUDGET : SCHEDULED_INCREMENTAL_BUDGET,
          actor: "system",
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
