/**
 * The settlement predicate: ONE definition (ADR 0042 addendum, phase 7 review S5).
 *
 * An allocation (alias `a`) of a match (alias `m`) against an open item (alias `oi`) COUNTS against
 * the item's open balance while the match is live, EXCEPT when it is RELEASED. It is released only
 * when all of these hold:
 *   - the match is booked in Exact (`matched_in_exact`, `booked_at` set);
 *   - the item was re-read from Exact after the booking (`booked_at < oi.synced_at`);
 *   - the balance recorded for the allocation is known (`open_before_minor` not NULL; NULL means
 *     "unknown" and keeps counting);
 *   - and Exact's own balance now proves the payment: the item is closed or has no balance, or its
 *     open balance FELL since `open_before_minor` by at least the SUM of this allocation and every
 *     other booked allocation on the same item that could still hide in that same decrease
 *     (aggregate rule, review U2). "Could hide" = booked no later than this one (booked_at, then
 *     allocation id) with a baseline no higher than this one's: an allocation booked earlier whose
 *     baseline is HIGHER was already visible when this baseline was taken (the balance had fallen
 *     since), so it is not part of this decrease.
 *
 * Why the sum: two booked allocations A and B of 100 on an item of 300, both with baseline 300,
 * and one re-read showing 200 (only one MatchSet visible yet). Compared one by one, both would be
 * released (300 - 200 >= 100 each) and 100 could be allocated twice. With the sum, A (booked
 * first) needs 100 and is released, B needs 200 and keeps counting: free = 200 - 100 = 100, which
 * is exactly what is free once B shows in Exact. The released allocations of a baseline group are
 * always a prefix in booking order whose total is at most the observed decrease.
 *
 * A read that lags the MatchSet (the item reappears fully open) therefore keeps counting, so the
 * same money can never be allocated twice. An item whose balance ROSE after the booking (a new
 * credit note reversed, a correction) shows a smaller or negative decrease and keeps counting:
 * safe, and reported as stale after 48 h. A payment booked in Exact by someone else between the
 * baseline and the re-read looks like our MatchSet; that is the one case balance evidence cannot
 * tell apart (documented limit, ADR 0042 addendum). Nothing is released after a timeout: an
 * allocation still counting 48 hours after booking is a data-quality signal (`staleSettlements`).
 *
 * The text below is copied verbatim into migration 0025 (the trigger); tests compare the
 * normalised trigger text in sqlite_master and the migration file with this constant, and a source
 * scan refuses any other copy of the rule.
 */

/**
 * Aliases: m = matches, a = match_allocations, oi = open_items; the inner sum uses s_m and s_a,
 * which callers may not use. Single line, no comments.
 */
export const SETTLEMENT_PREDICATE =
  "m.undone_at IS NULL AND NOT (m.exact_state = 'matched_in_exact' AND m.booked_at IS NOT NULL AND m.booked_at < oi.synced_at AND a.open_before_minor IS NOT NULL AND (oi.status <> 'open' OR oi.open_minor = 0 OR ABS(a.open_before_minor) - ABS(oi.open_minor) >= (SELECT SUM(s_a.allocated_minor) FROM match_allocations s_a JOIN matches s_m ON s_m.id = s_a.match_id WHERE s_a.open_item_id = a.open_item_id AND s_m.undone_at IS NULL AND s_m.exact_state = 'matched_in_exact' AND s_m.booked_at IS NOT NULL AND s_a.open_before_minor IS NOT NULL AND ABS(s_a.open_before_minor) <= ABS(a.open_before_minor) AND (s_m.booked_at < m.booked_at OR (s_m.booked_at = m.booked_at AND s_a.id <= a.id)))))";

/** Hours after booking before a still-counting settlement is reported as stale. */
export const STALE_SETTLEMENT_HOURS = 48;

/**
 * The predicate for other aliases (`m2`, `oi`, `a2`, ...). Only the three alias prefixes are
 * rewritten; the text is otherwise identical.
 */
export const allocCounts = (m: string, oi: string, a = "a"): string => {
  for (const alias of [m, oi, a]) {
    if (!/^[a-z][a-z0-9_]{0,15}$/.test(alias) || alias === "s_a" || alias === "s_m") {
      throw new RangeError("bad SQL alias");
    }
  }
  return SETTLEMENT_PREDICATE.replace(/\b(m|oi|a)\.(?=[a-z_])/g, (_s, k: string) =>
    k === "m" ? `${m}.` : k === "oi" ? `${oi}.` : `${a}.`,
  );
};

/**
 * Records, per allocation of the match, Exact's open balance NOW (`open_before_minor`). The match
 * creation writes it (store.applyMatch, same batch) and the claim refreshes it automatically
 * (trigger matches_settlement_baseline, migration 0025), so callers do not need this; it stays for
 * an explicit refresh while the match is `not_booked`. After the claim a trigger refuses the write:
 * this THROWS (`match_err:immutable`), it never silently changes a booked baseline. Returns the
 * number of allocations written (0 for an unknown match).
 */
export async function recordOpenBefore(db: D1Database, matchId: number): Promise<number> {
  const out = await db
    .prepare(
      `UPDATE match_allocations
         SET open_before_minor = (SELECT oi.open_minor FROM open_items oi
                                   WHERE oi.id = match_allocations.open_item_id)
       WHERE match_id = ?1`,
    )
    .bind(matchId)
    .run();
  return out.meta.changes ?? 0;
}

/**
 * Allocations of matches booked in Exact more than 48 hours ago that STILL count: Exact has not
 * shown the payment (or the item was never re-read, or the baseline is unknown). Phase 8 raises a
 * data-quality issue from this; nothing here releases anything.
 */
export async function staleSettlements(db: D1Database, nowIso: string): Promise<number> {
  const cutoff = new Date(Date.parse(nowIso) - STALE_SETTLEMENT_HOURS * 3_600_000).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM match_allocations a
         JOIN matches m ON m.id = a.match_id
         JOIN open_items oi ON oi.id = a.open_item_id
       WHERE m.exact_state = 'matched_in_exact' AND m.booked_at < ?1 AND ${SETTLEMENT_PREDICATE}`,
    )
    .bind(cutoff)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
