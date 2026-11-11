/**
 * Processing of one queued Revolut webhook event (queue consumer, task R3a, ADR 0033).
 *
 * The webhook only says WHICH transaction changed. Amounts, state and legs are fetched from the API
 * (`GET /transaction/{id}`, through the gate, priority 'job', budget EVENT_CALL_BUDGET) and
 * upserted by the ingest; nothing in the payload is trusted. The handler is idempotent: a row
 * that is no longer `queued` is acked and skipped, and the upsert itself is idempotent, so a
 * redelivered message cannot change anything.
 *
 * Failure handling: retryable errors (rate limit, gate unavailable, network, token refresh outage)
 * ask the queue to retry with a delay, at most EVENT_MAX_ATTEMPTS deliveries in all (the queue's
 * max_retries is 3); the last attempt records `error` with the code. Permanent errors record
 * `error` at once. The transaction is then still picked up by the poll and the nightly backfill.
 * A 404 for the transaction is retried after 30 s, 2 min and 10 min (the read side can lag the
 * webhook, review S8); if it is still gone after the last delivery (deleted, or an id of another
 * environment) the event is `processed` with the code `transaction_not_found`.
 */
import type { Env } from "../env";
import { classifyRevolutError } from "./errors";
import { upsertTransaction } from "./ingest";
import { startJobClient } from "./job-client";
import { loadRevolutById } from "./store";

/** Gate calls one event may spend: the transaction read and a client retry or two. */
export const EVENT_CALL_BUDGET = 3;
/** Deliveries of one message: the first plus the queue's max_retries (3). */
export const EVENT_MAX_ATTEMPTS = 4;
/**
 * A 404 right after a TransactionCreated is usually Revolut's read side lagging behind its
 * webhook (review S8): the event is redelivered after these delays (seconds, by delivery number)
 * before the 404 is accepted as final.
 */
export const NOT_FOUND_RETRY_SECONDS: readonly number[] = [30, 120, 600];
const TX_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export type EventDisposition =
  { kind: "ack"; reason: string } | { kind: "retry"; delaySeconds: number };

export interface EventDeps {
  now?: () => number;
}

interface EventRow {
  id: number;
  connection_id: number;
  status: string;
  external_id: string | null;
}

export async function processRevolutEvent(
  env: Env,
  webhookEventId: number,
  attempt: number,
  deps: EventDeps = {},
): Promise<EventDisposition> {
  const db = env.DB;
  const clock = deps.now ?? Date.now;
  const row = await db
    .prepare("SELECT id, connection_id, status, external_id FROM webhook_events WHERE id = ?1")
    .bind(webhookEventId)
    .first<EventRow>();
  if (!row) return { kind: "ack", reason: "unknown_event" };
  if (row.status !== "queued") return { kind: "ack", reason: "already_done" };

  const settle = async (
    status: "processed" | "ignored" | "error",
    code: string | null,
  ): Promise<EventDisposition> => {
    await db
      .prepare(
        `UPDATE webhook_events SET status = ?2, error_code = ?3, processed_at = ?4
         WHERE id = ?1 AND status = 'queued'`,
      )
      .bind(row.id, status, code, new Date(clock()).toISOString())
      .run();
    return { kind: "ack", reason: status };
  };

  if (row.external_id === null) return settle("error", "no_transaction_id");
  // The route validated it already; checked again before it becomes part of a gate path.
  if (!TX_ID_RE.test(row.external_id)) return settle("error", "bad_transaction_id");
  const conn = await loadRevolutById(db, row.connection_id);
  if (!conn || conn.status === "disabled") return settle("error", "not_connected");
  // needs_reauth / expired / pending: no usable tokens. The event stays recorded with the status as
  // its code; the poll and backfill after re-authorisation recover the transaction.
  if (conn.status !== "active") return settle("error", conn.status);

  let job;
  try {
    job = await startJobClient(env, conn.id, `revolut-event-${row.id}`, EVENT_CALL_BUDGET);
    const tx = await job.client.getTransaction(row.external_id);
    const r = await upsertTransaction(env, conn.id, tx, "webhook", clock());
    if (r.legs > 0 && r.skipped === r.legs) return await settle("ignored", "no_placeable_legs");
    const blocked = r.blocked.regress + r.blocked.conflict;
    if (blocked > 0) return await settle("processed", "state_change_blocked");
    if (r.frozenConflicts > 0) return await settle("processed", "frozen_conflict");
    if (r.skipped > 0) return await settle("processed", "legs_skipped");
    return await settle("processed", null);
  } catch (e) {
    const c = classifyRevolutError(e);
    if (c.code === "not_found") {
      const delay = NOT_FOUND_RETRY_SECONDS[attempt - 1];
      if (delay !== undefined && attempt < EVENT_MAX_ATTEMPTS) {
        await db
          .prepare("UPDATE webhook_events SET error_code = ?2 WHERE id = ?1 AND status = 'queued'")
          .bind(row.id, "transaction_not_found")
          .run()
          .catch(() => undefined);
        return { kind: "retry", delaySeconds: delay };
      }
      return settle("processed", "transaction_not_found");
    }
    if (c.retryable && attempt < EVENT_MAX_ATTEMPTS) {
      // Visible on the row while it waits; the status stays queued.
      await db
        .prepare("UPDATE webhook_events SET error_code = ?2 WHERE id = ?1 AND status = 'queued'")
        .bind(row.id, c.code)
        .run()
        .catch(() => undefined);
      return { kind: "retry", delaySeconds: c.delaySeconds };
    }
    console.error("revolut event failed", c.code);
    return settle("error", c.code);
  } finally {
    await job?.end();
  }
}
