/**
 * The settlement predicate: ONE definition (ADR 0042 addendum, phase 7 review S5).
 *
 * An allocation (alias `a`) of a match (alias `m`) against an open item (alias `oi`) COUNTS against
 * the item's open balance while the match is live, EXCEPT when it is RELEASED. It is released only
 * when all of these hold:
 *   - the match is booked in Exact (`matched_in_exact`, `booked_at` set);
 *   - the item was re-read from Exact after the booking (`booked_at < oi.synced_at`);
 *   - the balance recorded when the match was claimed is known (`open_before_minor` not NULL; NULL
 *     means "unknown" and keeps counting);
 *   - and Exact's own balance now proves the payment: the item is closed or has no balance, or its
 *     open balance FELL by at least the allocated amount since `open_before_minor`.
 * A read that lags the MatchSet (the item reappears fully open) therefore keeps counting, so the
 * same money can never be allocated twice. Nothing is released automatically after a timeout: an
 * allocation still counting 48 hours after booking is a data-quality signal (`staleSettlements`).
 *
 * The text below is copied verbatim into migration 0025 (the triggers); a test compares the
 * normalised trigger text in sqlite_master with this constant, so the two cannot drift.
 */

/** Aliases: m = matches, a = match_allocations, oi = open_items. Single line, no comments. */
export const SETTLEMENT_PREDICATE =
  "m.undone_at IS NULL AND NOT (m.exact_state = 'matched_in_exact' AND m.booked_at IS NOT NULL AND m.booked_at < oi.synced_at AND a.open_before_minor IS NOT NULL AND (oi.status <> 'open' OR oi.open_minor = 0 OR ABS(a.open_before_minor) - ABS(oi.open_minor) >= a.allocated_minor))";

/** Hours after booking before a still-counting settlement is reported as stale. */
export const STALE_SETTLEMENT_HOURS = 48;

/**
 * The predicate for other aliases (`m2`, `oi`, `a2`, ...). Only the three alias prefixes are
 * rewritten; the text is otherwise identical.
 */
export const allocCounts = (m: string, oi: string, a = "a"): string => {
  for (const alias of [m, oi, a]) {
    if (!/^[a-z][a-z0-9_]{0,15}$/.test(alias)) throw new RangeError("bad SQL alias");
  }
  return SETTLEMENT_PREDICATE.replace(/\b(m|oi|a)\.(?=[a-z_])/g, (_s, k: string) =>
    k === "m" ? `${m}.` : k === "oi" ? `${oi}.` : `${a}.`,
  );
};

/**
 * Records, per allocation of the match, Exact's open balance NOW (`open_before_minor`). Called when
 * a match is created (store.applyMatch writes it in the same batch) and again by the booking
 * executor right BEFORE the claim, so the baseline is the balance of the last read before the
 * MatchSet. A database trigger refuses the write once the match left `not_booked`. Returns the
 * number of allocations written.
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
