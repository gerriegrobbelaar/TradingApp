/**
 * Booking health counts (Phase 7 review S10, N6) for Phase 8's data-quality rules and for
 * GET /api/matching/stats. Read-only, one batch, counts only (no ids, no bank text).
 *
 *  - A match booked in Exact whose bank line LATER got a state conflict or became 'reverted': the
 *    booking stays in Exact, the bank no longer agrees. Nothing else in the app notices this.
 *  - Outbox rows that need a person (manual_required, outcome_unknown, waiting_for_bank_line).
 *  - Live matches the executor cannot book yet (booking_deferred_code).
 */
import type { MatchBookingHealth } from "@camelthorn/core";

export async function bookingHealth(db: D1Database): Promise<MatchBookingHealth> {
  const [rows, matches] = await db.batch<Record<string, number>>([
    db.prepare(
      `SELECT o.status AS status, COUNT(*) AS n FROM exact_write_outbox o
         JOIN matches m ON m.id = o.match_id
       WHERE m.undone_at IS NULL AND o.status IN ('manual_required', 'outcome_unknown', 'waiting_for_bank_line')
       GROUP BY o.status`,
    ),
    db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN m.exact_state = 'not_booked' AND m.booking_deferred_code IS NOT NULL THEN 1 ELSE 0 END), 0) AS deferred,
         COALESCE(SUM(CASE WHEN m.exact_state = 'matched_in_exact' AND t.state_conflict = 1 THEN 1 ELSE 0 END), 0) AS conflict,
         COALESCE(SUM(CASE WHEN m.exact_state = 'matched_in_exact' AND t.state = 'reverted' THEN 1 ELSE 0 END), 0) AS reverted,
         COALESCE(SUM(CASE WHEN m.exact_note = 'already_matched_in_exact' THEN 1 ELSE 0 END), 0) AS already,
         COALESCE(SUM(CASE WHEN m.manually_booked = 1 THEN 1 ELSE 0 END), 0) AS manual
       FROM matches m JOIN bank_transactions t ON t.id = m.bank_transaction_id
       WHERE m.undone_at IS NULL`,
    ),
  ]);
  const byStatus = new Map(
    (rows?.results ?? []).map((r) => [
      String((r as Record<string, unknown>)["status"]),
      Number(r["n"]),
    ]),
  );
  const m = matches?.results?.[0] ?? {};
  return {
    manualRequired: byStatus.get("manual_required") ?? 0,
    outcomeUnknown: byStatus.get("outcome_unknown") ?? 0,
    waitingForBankLine: byStatus.get("waiting_for_bank_line") ?? 0,
    deferred: Number(m["deferred"] ?? 0),
    bookedLineConflict: Number(m["conflict"] ?? 0),
    bookedLineReverted: Number(m["reverted"] ?? 0),
    alreadyMatchedInExact: Number(m["already"] ?? 0),
    bookedManually: Number(m["manual"] ?? 0),
  };
}
