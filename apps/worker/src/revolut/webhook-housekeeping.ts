/**
 * Housekeeping of the webhook tables (Phase 5 review S4, ADR 0011 retention, ADR 0033).
 *
 *  - A `queued` webhook_events row older than 15 minutes was never processed (the queue message was
 *    lost or the consumer kept failing). It is re-enqueued, at most MAX_REQUEUES times in total
 *    (the same budget the route uses); after that, or when its body was never parsed (nothing to
 *    enqueue), it ends as `error` with a short code. The poll and the daily backfill recover the
 *    transaction itself either way.
 *  - `processed`, `ignored` and `error` rows are deleted after 30 days, webhook_rejections after 7,
 *    in bounded batches.
 *
 * Called from the scheduler tick (jobs/runner.ts) on one tick in ten (HOUSEKEEPING_MINUTE), so
 * nine idle ticks of ten send no statement. On that tick: an isolate runs it at most once per 10
 * minutes, a settings stamp (one statement, a write only for the winner) lets one isolate per 10
 * minutes win, and the winner first asks ONE query whether anything is due.
 */
import type { Env } from "../env";
import { enqueueEvent, MAX_REQUEUES, UNPARSED } from "./webhook-route";
import { REJECTION_RETENTION_DAYS } from "./webhook-health";

export const HOUSEKEEPING_EVERY_MS = 10 * 60_000;
/** The scheduler tick calls housekeeping only when (minutes since epoch) % 10 equals this. */
export const HOUSEKEEPING_MINUTE = 3;
export const STALE_QUEUED_AFTER_MS = 15 * 60_000;
export const EVENT_RETENTION_DAYS = 30;
/** Rows handled per statement / per run, so one run stays short whatever the backlog. */
export const HOUSEKEEPING_BATCH = 200;
const MAX_BATCHES_PER_RUN = 5;
const STAMP_KEY = "revolut.webhook_housekeeping";

let lastRunMs = Number.NEGATIVE_INFINITY;

/** Test hook. */
export function resetHousekeepingState(): void {
  lastRunMs = Number.NEGATIVE_INFINITY;
}

export interface HousekeepingResult {
  ran: boolean;
  requeued: number;
  failed: number;
  deletedEvents: number;
  deletedRejections: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const IDLE: HousekeepingResult = {
  ran: false,
  requeued: 0,
  failed: 0,
  deletedEvents: 0,
  deletedRejections: 0,
};

export async function housekeepWebhookEvents(
  env: Env,
  nowMs: number = Date.now(),
): Promise<HousekeepingResult> {
  if (nowMs >= lastRunMs && nowMs - lastRunMs < HOUSEKEEPING_EVERY_MS) return IDLE;
  lastRunMs = nowMs;
  const db = env.DB;

  // One isolate per window wins; the others pay one statement that writes nothing.
  const claim = await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_by)
       VALUES (?1, json_object('at', ?2), 'system')
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = ?2
       WHERE COALESCE(json_extract(settings.value_json, '$.at'), '') < ?3
          OR json_extract(settings.value_json, '$.at') > ?2`,
    )
    .bind(STAMP_KEY, iso(nowMs), iso(nowMs - HOUSEKEEPING_EVERY_MS))
    .run();
  if (claim.meta.changes !== 1) return IDLE;

  const staleCut = iso(nowMs - STALE_QUEUED_AFTER_MS);
  const eventCut = iso(nowMs - EVENT_RETENTION_DAYS * 86_400_000);
  const rejectionCut = iso(nowMs - REJECTION_RETENTION_DAYS * 86_400_000);
  const due = await db
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM webhook_events WHERE status = 'queued' AND received_at < ?1) AS stale,
         EXISTS (SELECT 1 FROM webhook_events
                 WHERE status IN ('processed', 'ignored', 'error') AND received_at < ?2) AS old,
         EXISTS (SELECT 1 FROM webhook_rejections WHERE bucket_at < ?3) AS old_rejections`,
    )
    .bind(staleCut, eventCut, rejectionCut)
    .first<{ stale: number; old: number; old_rejections: number }>();
  const result: HousekeepingResult = { ...IDLE, ran: true };
  if (!due || (due.stale === 0 && due.old === 0 && due.old_rejections === 0)) return result;

  if (due.stale === 1) {
    const stale = await db
      .prepare(
        `SELECT id, event_type, requeue_count FROM webhook_events
         WHERE status = 'queued' AND received_at < ?1 ORDER BY id LIMIT ?2`,
      )
      .bind(staleCut, HOUSEKEEPING_BATCH)
      .all<{ id: number; event_type: string; requeue_count: number }>();
    for (const row of stale.results) {
      if (row.event_type === UNPARSED || row.requeue_count >= MAX_REQUEUES) {
        const code = row.event_type === UNPARSED ? "never_parsed" : "requeue_exhausted";
        await db
          .prepare(
            `UPDATE webhook_events SET status = 'error', error_code = ?2, processed_at = ?3
             WHERE id = ?1 AND status = 'queued' AND received_at < ?4`,
          )
          .bind(row.id, code, iso(nowMs), staleCut)
          .run();
        result.failed++;
        continue;
      }
      // Claimed atomically, so a concurrent redelivery or isolate cannot enqueue the same row too.
      const claimed = await db
        .prepare(
          `UPDATE webhook_events SET received_at = ?2, requeue_count = requeue_count + 1
           WHERE id = ?1 AND status = 'queued' AND received_at < ?3 AND requeue_count < ${MAX_REQUEUES}`,
        )
        .bind(row.id, iso(nowMs), staleCut)
        .run();
      if (claimed.meta.changes !== 1) continue;
      if (await enqueueEvent(env, row.id)) {
        result.requeued++;
      } else {
        await db
          .prepare(
            `UPDATE webhook_events SET status = 'error', error_code = 'enqueue_failed'
             WHERE id = ?1 AND status = 'queued'`,
          )
          .bind(row.id)
          .run();
        result.failed++;
      }
    }
  }

  if (due.old === 1) {
    result.deletedEvents = await deleteInBatches(
      db,
      `DELETE FROM webhook_events WHERE id IN (
         SELECT id FROM webhook_events
         WHERE status IN ('processed', 'ignored', 'error') AND received_at < ?1
         ORDER BY id LIMIT ?2)`,
      eventCut,
    );
  }
  if (due.old_rejections === 1) {
    result.deletedRejections = await deleteInBatches(
      db,
      `DELETE FROM webhook_rejections WHERE id IN (
         SELECT id FROM webhook_rejections WHERE bucket_at < ?1 ORDER BY id LIMIT ?2)`,
      rejectionCut,
    );
  }
  return result;
}

async function deleteInBatches(db: D1Database, sql: string, cut: string): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const r = await db.prepare(sql).bind(cut, HOUSEKEEPING_BATCH).run();
    total += r.meta.changes;
    if (r.meta.changes < HOUSEKEEPING_BATCH) break;
  }
  return total;
}
