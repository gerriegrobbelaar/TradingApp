/**
 * Retention of the booking outbox payloads (ADR 0011, phase 7 review N3).
 *
 * `exact_write_outbox.payload_json` holds counterparty names (personal data). 400 days after a row
 * reached a terminal state (verified, resolved_manually, given_up; `updated_at` is the time of that
 * last change) the payload is replaced by a fixed placeholder; the row, its hash, its status and
 * the audit trail stay. The column is NOT NULL with a JSON check, so the placeholder stands in for
 * NULL. Migration 0025 lets the immutability trigger allow exactly this one change.
 *
 * Bounded: one statement, at most 200 rows per run, oldest first; a backlog drains over runs. The
 * scheduler tick calls it once an hour (jobs/runner.ts).
 */

export const OUTBOX_PAYLOAD_RETENTION_DAYS = 400;
export const OUTBOX_REDACT_BATCH = 200;
export const REDACTED_PAYLOAD = '{"v":1,"stage":"redacted"}';

/** Returns how many payloads were redacted. */
export async function redactOldOutboxPayloads(
  db: D1Database,
  nowMs: number,
  batch: number = OUTBOX_REDACT_BATCH,
): Promise<number> {
  const cutoff = new Date(nowMs - OUTBOX_PAYLOAD_RETENTION_DAYS * 86_400_000).toISOString();
  const out = await db
    .prepare(
      `UPDATE exact_write_outbox SET payload_json = ?1
       WHERE id IN (SELECT id FROM exact_write_outbox
                     WHERE status IN ('verified', 'resolved_manually', 'given_up')
                       AND updated_at < ?2 AND payload_json <> ?1
                     ORDER BY id LIMIT ?3)`,
    )
    .bind(REDACTED_PAYLOAD, cutoff, Math.max(1, Math.min(batch, OUTBOX_REDACT_BATCH)))
    .run();
  return out.meta.changes ?? 0;
}
