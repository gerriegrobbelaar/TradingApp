/**
 * Retention of the booking outbox payloads (ADR 0011, phase 7 review N3).
 *
 * `exact_write_outbox.payload_json` holds counterparty names (personal data). 400 days after a row
 * reached a terminal state (verified, resolved_manually, given_up; `updated_at` is the time of that
 * last change) the payload is replaced by its redacted form (REDACTED_PAYLOAD_SQL): only
 * `input.bankEntryNumber` survives, because the executor's "bank line already used by another
 * MatchSet of ours" check reads it from every row that is not given up. The row, its hash, its
 * status and the audit trail stay. The column is NOT NULL with a JSON check, so the redacted form
 * stands in for NULL. Migration 0025 lets the immutability trigger allow exactly this one change,
 * computed from the old payload by the same expression.
 *
 * Bounded: one statement, at most 200 rows per run, oldest first; a backlog drains over runs. The
 * scheduler tick calls it once an hour (jobs/runner.ts).
 */

export const OUTBOX_PAYLOAD_RETENTION_DAYS = 400;
export const OUTBOX_REDACT_BATCH = 200;
/** The redacted payload of a row whose payload has no bank entry number. */
export const REDACTED_PAYLOAD = '{"v":1,"stage":"redacted","input":{"bankEntryNumber":null}}';
/** The redacted form of `payload_json` (same expression as trigger outbox_guard_update, 0025). */
export const REDACTED_PAYLOAD_SQL =
  "json_object('v', 1, 'stage', 'redacted', 'input', json_object('bankEntryNumber', json_extract(payload_json, '$.input.bankEntryNumber')))";

/** Returns how many payloads were redacted. */
export async function redactOldOutboxPayloads(
  db: D1Database,
  nowMs: number,
  batch: number = OUTBOX_REDACT_BATCH,
): Promise<number> {
  const cutoff = new Date(nowMs - OUTBOX_PAYLOAD_RETENTION_DAYS * 86_400_000).toISOString();
  const out = await db
    .prepare(
      `UPDATE exact_write_outbox SET payload_json = ${REDACTED_PAYLOAD_SQL}
       WHERE id IN (SELECT id FROM exact_write_outbox
                     WHERE status IN ('verified', 'resolved_manually', 'given_up')
                       AND updated_at < ?1 AND json_extract(payload_json, '$.stage') IS NOT 'redacted'
                     ORDER BY id LIMIT ?2)`,
    )
    .bind(cutoff, Math.max(1, Math.min(batch, OUTBOX_REDACT_BATCH)))
    .run();
  return out.meta.changes ?? 0;
}
