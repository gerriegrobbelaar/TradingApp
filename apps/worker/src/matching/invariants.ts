/**
 * Consistency check of the matching tables (Phase 7, ADR 0042). Read-only; used by the race tests
 * after every interleaving and meant for the Phase 8 data-quality monitor ("matching invariants").
 *
 * Every rule is one SQL query that lists offending ids (at most SAMPLE per rule), so the whole check
 * is a fixed number of queries whatever the data size. Ids and codes only: no bank details or text.
 */

export type InvariantCode =
  /** match_status 'matched' but no live match. */
  | "matched_without_live_match"
  /** A live match whose bank line is not 'matched'. */
  | "live_match_line_not_matched"
  /** More than one live match on one bank line (the partial UNIQUE index forbids it). */
  | "several_live_matches"
  /** A live match with neither allocations nor a ledger account. */
  | "live_match_empty"
  /** A ledger match that also has invoice allocations. */
  | "ledger_match_with_allocations"
  /** The allocations of a match add up to more than the bank amount. */
  | "allocations_exceed_tx"
  /** A live match whose amount or currency differ from its bank line. */
  | "match_differs_from_tx"
  /** An allocation in another currency or administration than its match. */
  | "allocation_scope_mismatch"
  /** Live, not booked allocations of an item exceed its open balance and the match is not flagged. */
  | "item_over_allocated_unflagged"
  /** A live, not booked allocation to a closed item, and the match is not flagged. */
  | "allocation_to_closed_item_unflagged"
  /** Suggestions left on a line that is matched or ignored. */
  | "suggestions_on_decided_line"
  /** matched_in_exact without booked_at (the settlement rule needs it). */
  | "booked_without_booked_at"
  /** A match that was never claimed still has outbox rows. */
  | "not_booked_with_outbox"
  /** A claimed live match (booking, bank_entry_created, booking_failed, outcome_unknown) without outbox rows. */
  | "claimed_without_outbox"
  /** matched_in_exact with an outbox row that is not finished (verified or resolved by a person). */
  | "booked_with_open_outbox"
  /** An outbox row of an undone match. */
  | "outbox_of_undone_match";

export interface InvariantViolation {
  code: InvariantCode;
  /** Offending row ids (match id, bank transaction id or open item id; see the rule). */
  ids: number[];
}

import { allocCounts } from "./store";

const SAMPLE = 20;

const RULES: readonly { code: InvariantCode; sql: string }[] = [
  {
    code: "matched_without_live_match",
    sql: `SELECT t.id FROM bank_transactions t WHERE t.match_status = 'matched'
            AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.bank_transaction_id = t.id AND m.undone_at IS NULL)`,
  },
  {
    code: "live_match_line_not_matched",
    sql: `SELECT m.id FROM matches m JOIN bank_transactions t ON t.id = m.bank_transaction_id
          WHERE m.undone_at IS NULL AND t.match_status <> 'matched'`,
  },
  {
    code: "several_live_matches",
    sql: `SELECT bank_transaction_id AS id FROM matches WHERE undone_at IS NULL
          GROUP BY bank_transaction_id HAVING COUNT(*) > 1`,
  },
  {
    code: "live_match_empty",
    sql: `SELECT m.id FROM matches m WHERE m.undone_at IS NULL AND m.ledger_account_code IS NULL
            AND NOT EXISTS (SELECT 1 FROM match_allocations a WHERE a.match_id = m.id)`,
  },
  {
    code: "ledger_match_with_allocations",
    sql: `SELECT m.id FROM matches m WHERE m.ledger_account_code IS NOT NULL
            AND EXISTS (SELECT 1 FROM match_allocations a WHERE a.match_id = m.id)`,
  },
  {
    code: "allocations_exceed_tx",
    sql: `SELECT m.id FROM matches m
          WHERE (SELECT COALESCE(SUM(a.allocated_minor), 0) FROM match_allocations a WHERE a.match_id = m.id)
                > m.amount_minor`,
  },
  {
    code: "match_differs_from_tx",
    sql: `SELECT m.id FROM matches m JOIN bank_transactions t ON t.id = m.bank_transaction_id
          WHERE m.undone_at IS NULL AND (ABS(t.amount_minor) <> m.amount_minor OR t.currency <> m.currency)`,
  },
  {
    code: "allocation_scope_mismatch",
    sql: `SELECT a.id FROM match_allocations a JOIN matches m ON m.id = a.match_id
            JOIN open_items oi ON oi.id = a.open_item_id
          WHERE a.currency <> m.currency OR oi.currency <> m.currency OR oi.division_id <> m.division_id`,
  },
  {
    code: "item_over_allocated_unflagged",
    sql: `SELECT oi.id FROM open_items oi
          WHERE (SELECT COALESCE(SUM(a.allocated_minor), 0) FROM match_allocations a
                   JOIN matches m ON m.id = a.match_id
                  WHERE a.open_item_id = oi.id AND ${allocCounts("m", "oi")}) > ABS(oi.open_minor)
            AND EXISTS (SELECT 1 FROM match_allocations a JOIN matches m ON m.id = a.match_id
                        WHERE a.open_item_id = oi.id AND m.undone_at IS NULL
                          AND m.exact_state = 'not_booked' AND m.review_reason IS NULL)`,
  },
  {
    code: "allocation_to_closed_item_unflagged",
    sql: `SELECT a.id FROM match_allocations a JOIN matches m ON m.id = a.match_id
            JOIN open_items oi ON oi.id = a.open_item_id
          WHERE m.undone_at IS NULL AND m.exact_state = 'not_booked' AND m.review_reason IS NULL
            AND (oi.status <> 'open' OR oi.open_minor = 0)`,
  },
  {
    code: "suggestions_on_decided_line",
    sql: `SELECT DISTINCT s.bank_transaction_id AS id FROM match_suggestions s
            JOIN bank_transactions t ON t.id = s.bank_transaction_id
          WHERE t.match_status IN ('matched', 'ignored')`,
  },
  {
    code: "booked_without_booked_at",
    sql: `SELECT m.id FROM matches m WHERE m.exact_state = 'matched_in_exact' AND m.booked_at IS NULL`,
  },
  {
    code: "not_booked_with_outbox",
    sql: `SELECT m.id FROM matches m WHERE m.exact_state = 'not_booked'
            AND EXISTS (SELECT 1 FROM exact_write_outbox o WHERE o.match_id = m.id)`,
  },
  {
    code: "claimed_without_outbox",
    sql: `SELECT m.id FROM matches m WHERE m.undone_at IS NULL
            AND m.exact_state IN ('booking', 'bank_entry_created', 'booking_failed', 'outcome_unknown')
            AND NOT EXISTS (SELECT 1 FROM exact_write_outbox o WHERE o.match_id = m.id)`,
  },
  {
    code: "booked_with_open_outbox",
    sql: `SELECT m.id FROM matches m WHERE m.exact_state = 'matched_in_exact'
            AND EXISTS (SELECT 1 FROM exact_write_outbox o WHERE o.match_id = m.id
                          AND o.status NOT IN ('verified', 'resolved_manually'))`,
  },
  {
    code: "outbox_of_undone_match",
    sql: `SELECT o.id FROM exact_write_outbox o JOIN matches m ON m.id = o.match_id
          WHERE m.undone_at IS NOT NULL`,
  },
];

/** Every broken matching invariant (empty when consistent). One batch of read queries. */
export async function checkMatchingInvariants(db: D1Database): Promise<InvariantViolation[]> {
  const results = await db.batch<{ id: number }>(
    RULES.map((r) => db.prepare(`SELECT id FROM (${r.sql}) ORDER BY id LIMIT ${SAMPLE}`)),
  );
  const out: InvariantViolation[] = [];
  RULES.forEach((r, i) => {
    const ids = (results[i]?.results ?? []).map((x) => x.id);
    if (ids.length > 0) out.push({ code: r.code, ids });
  });
  return out;
}
