/**
 * Reading and clearing the sticky `bank_transactions.state_conflict` flag (Phase 5 review Q1, S7 and
 * S9, ADR 0034). The ingest sets the flag when Revolut contradicts a final row (a refused final ->
 * final change) or changes the money data / state of a matched (frozen) row. Only a person clears
 * it, after looking at the row: Phase 7 (review queue) and Phase 8 (Data health) call these
 * functions behind their own routes, which must check the role (finance or admin) and write the
 * audit row in the same batch (done here).
 *
 * Nothing here returns an IBAN, a name or a reference: ids, state, amounts and codes only.
 */
import { auditStatement } from "../db/audit";

export interface StateConflictRow {
  /** bank_transactions.id (internal). */
  id: number;
  /** Revolut transaction id and leg id. */
  externalId: string;
  legId: string;
  state: string;
  matchStatus: string;
  amountMinor: number;
  currency: string;
  /** Last time Revolut told us something about the row (UTC ISO). */
  lastEventAt: string | null;
}

/** Flagged rows of a connection, most recently touched first (at most `limit`, 1..500). */
export async function listStateConflicts(
  db: D1Database,
  connectionId: number,
  limit = 100,
): Promise<StateConflictRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = (
    await db
      .prepare(
        `SELECT id, external_id, leg_id, state, match_status, amount_minor, currency, last_event_at
         FROM bank_transactions WHERE connection_id = ?1 AND state_conflict = 1
         ORDER BY COALESCE(last_event_at, first_seen_at) DESC, id DESC LIMIT ?2`,
      )
      .bind(connectionId, n)
      .all<{
        id: number;
        external_id: string;
        leg_id: string;
        state: string;
        match_status: string;
        amount_minor: number;
        currency: string;
        last_event_at: string | null;
      }>()
  ).results;
  return rows.map((r) => ({
    id: r.id,
    externalId: r.external_id,
    legId: r.leg_id,
    state: r.state,
    matchStatus: r.match_status,
    amountMinor: r.amount_minor,
    currency: r.currency,
    lastEventAt: r.last_event_at,
  }));
}

/** How many rows of a connection carry the flag (for a status line or a data-quality rule). */
export async function countStateConflicts(db: D1Database, connectionId: number): Promise<number> {
  const r = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM bank_transactions WHERE connection_id = ?1 AND state_conflict = 1",
    )
    .bind(connectionId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Clears the flag of one row, with its audit row in the same batch (only when the flag was set).
 * True when it was set and is now cleared. The caller has checked the role.
 */
export async function clearStateConflict(
  db: D1Database,
  bankTransactionId: number,
  actorEmail: string,
  note: string | null = null,
): Promise<boolean> {
  const out = await db.batch([
    // The audit row first, under the same condition as the change (ADR 0013 pattern).
    auditStatement(
      db,
      {
        actorEmail,
        action: "bank_transaction.conflict_cleared",
        entity: "bank_transaction",
        entityId: bankTransactionId,
        before: { stateConflict: 1 },
        after: { stateConflict: 0, ...(note !== null ? { note } : {}) },
      },
      {
        sql: "EXISTS (SELECT 1 FROM bank_transactions WHERE id = ?7 AND state_conflict = 1)",
        binds: [bankTransactionId],
      },
    ),
    db
      .prepare(
        "UPDATE bank_transactions SET state_conflict = 0 WHERE id = ?1 AND state_conflict = 1",
      )
      .bind(bankTransactionId),
  ]);
  return (out[1]?.meta.changes ?? 0) === 1;
}
