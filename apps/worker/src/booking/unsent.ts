/**
 * Claimed matches that provably never reached Exact (Phase 7 review B1, ADR 0044 "Final review").
 *
 * Before U1 the executor claimed a match it could not plan and parked it as `manual_required` with
 * a stage 'none' outbox row that cannot be undone or retried. Those rows hold no payload and were
 * never sent: a match whose outbox rows are ALL such rows may be undone, or retried (back to
 * `not_booked`, the rows deleted), by a person. The same predicate is in migration 0024
 * (`matches_guard_undo_claimed`, `matches_guard_exact_state`), which is the database's last word.
 */
import { auditStatement } from "../db/audit";
import { GUARD } from "./outbox";

/** The outbox row that holds no payload and was never sent. `o` is the alias of the outbox table. */
export const UNSENT_ROW = (o: string): string =>
  `(json_extract(${o}.payload_json, '$.stage') = 'none' AND ${o}.status = 'manual_required'
    AND ${o}.attempts = 0 AND ${o}.exact_ref IS NULL)`;

/**
 * True for a live, claimed match that HAS outbox rows and whose rows are ALL unsent stage 'none'
 * rows: nothing of it can be in Exact. `m` is the alias of the matches table.
 */
export const MATCH_UNSENT = (m: string): string =>
  `(${m}.undone_at IS NULL AND ${m}.exact_state = 'manual_required'
    AND EXISTS (SELECT 1 FROM exact_write_outbox oy WHERE oy.match_id = ${m}.id)
    AND NOT EXISTS (SELECT 1 FROM exact_write_outbox ox WHERE ox.match_id = ${m}.id
                      AND NOT ${UNSENT_ROW("ox")}))`;

export type UnsentResult = { kind: "done" } | { kind: "not_unsent" };

/** Undo of an unsent claim: rows deleted, match undone, line back to unmatched, one audit row. */
export async function undoUnsentClaim(
  db: D1Database,
  matchId: number,
  actor: string,
  reason: string,
  nowIso: string,
): Promise<UnsentResult> {
  const m = await db
    .prepare("SELECT bank_transaction_id, source, exact_state FROM matches WHERE id = ?1")
    .bind(matchId)
    .first<{ bank_transaction_id: number; source: string; exact_state: string }>();
  if (m === null) return { kind: "not_unsent" };
  const cond = MATCH_UNSENT("mm");
  const guard = `EXISTS (SELECT 1 FROM matches mm WHERE mm.id = ?7 AND ${cond})`;
  const done = `EXISTS (SELECT 1 FROM matches WHERE id = ?1 AND undone_at = ?2 AND undone_by = ?3)`;
  const out = await db.batch([
    auditStatement(
      db,
      {
        actorEmail: actor,
        action: "match.undo",
        entity: "match",
        entityId: matchId,
        before: { status: "live", source: m.source, exactState: m.exact_state },
        after: { status: "undone", reason, unsentClaim: true },
      },
      { sql: guard, binds: [matchId] },
    ),
    db
      .prepare(
        `UPDATE matches SET undone_at = ?2, undone_by = ?3, undo_reason = ?4
         WHERE id = ?1 AND ${MATCH_UNSENT("matches")} AND ${GUARD}`,
      )
      .bind(matchId, nowIso, actor, reason),
    // The rows of an undone match go (nothing was ever sent): after the update, which needs them.
    db
      .prepare(
        `DELETE FROM exact_write_outbox WHERE match_id = ?1 AND ${GUARD}
           AND EXISTS (SELECT 1 FROM matches mm WHERE mm.id = ?1 AND mm.undone_at = ?2 AND mm.undone_by = ?3)`,
      )
      .bind(matchId, nowIso, actor),
    db
      .prepare(
        `UPDATE bank_transactions SET match_status = 'unmatched', match_checked_at = NULL
         WHERE id = ?4 AND match_status = 'matched' AND ${done}`,
      )
      .bind(matchId, nowIso, actor, m.bank_transaction_id),
    db
      .prepare(`DELETE FROM match_suggestions WHERE bank_transaction_id = ?4 AND ${done}`)
      .bind(matchId, nowIso, actor, m.bank_transaction_id),
  ]);
  return (out[1]?.meta.changes ?? 0) >= 1 ? { kind: "done" } : { kind: "not_unsent" };
}

/**
 * Retry of an unsent claim (resolve route): the rows are deleted and the match returns to
 * `not_booked`, so the next run plans it again (or defers it with a code). One audit row.
 */
export async function retryUnsentClaim(
  db: D1Database,
  matchId: number,
  actor: string,
  note: string,
): Promise<UnsentResult> {
  const cond = MATCH_UNSENT("mm");
  const out = await db.batch([
    auditStatement(
      db,
      {
        actorEmail: actor,
        action: "booking.retry_unsent",
        entity: "match",
        entityId: matchId,
        before: { exactState: "manual_required" },
        after: { exactState: "not_booked", note },
      },
      { sql: `EXISTS (SELECT 1 FROM matches mm WHERE mm.id = ?7 AND ${cond})`, binds: [matchId] },
    ),
    db
      .prepare(
        `DELETE FROM exact_write_outbox WHERE match_id = ?1 AND ${GUARD}
           AND EXISTS (SELECT 1 FROM matches mm WHERE mm.id = ?1 AND ${cond})`,
      )
      .bind(matchId),
    db
      .prepare(
        `UPDATE matches SET exact_state = 'not_booked', exact_note = NULL
         WHERE id = ?1 AND undone_at IS NULL AND exact_state = 'manual_required'
           AND NOT EXISTS (SELECT 1 FROM exact_write_outbox o WHERE o.match_id = ?1)`,
      )
      .bind(matchId),
  ]);
  return (out[2]?.meta.changes ?? 0) >= 1 ? { kind: "done" } : { kind: "not_unsent" };
}
