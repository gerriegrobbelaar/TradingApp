/**
 * The one-off initial backfill after a Revolut connection is confirmed (task R3a, ADR 0032): the
 * 90-day request is stored in revolut_sync_state (so it survives a refused or delayed run and is
 * picked up by the next `revolut.backfill` run), then a manual run of the job is enqueued through
 * the normal "Run now" path (audited, JobLock, queue). Idempotent: asking again re-walks the same
 * window and the ingest changes nothing.
 */
import type { Env } from "../env";
import { createManualRun } from "../jobs/runner";
import { INITIAL_BACKFILL_DAYS, requestBackfill } from "./sync";

export type InitialBackfill = "queued" | "requested";

export async function queueInitialBackfill(
  env: Env,
  connectionId: number,
  actorEmail: string,
  nowMs: number,
): Promise<InitialBackfill> {
  await requestBackfill(env.DB, connectionId, INITIAL_BACKFILL_DAYS);
  const job = await env.DB.prepare(
    "SELECT id, name FROM jobs WHERE name = 'revolut.backfill'",
  ).first<{
    id: number;
    name: string;
  }>();
  // No job row (seeding failed) or a run already queued/in cooldown: the request is stored and the
  // next scheduled or manual run of the job performs it.
  if (!job) return "requested";
  const r = await createManualRun(env, job, actorEmail, nowMs);
  return r.ok ? "queued" : "requested";
}
