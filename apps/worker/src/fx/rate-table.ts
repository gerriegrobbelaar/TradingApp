/**
 * Server-side ECB rate tables (Phase 6 review S8, ADR 0039). One place that turns fx_rates rows
 * into a core `RateTable`, so the rates API, the data quality rule "foreign item without rate"
 * (Phase 8) and the month-end revaluation (Phase 12) cannot disagree.
 *
 *  - `loadRateTable(db, onOrBefore)`: the newest rate per currency on or before a date, with the
 *    same cut-off as the API and core `buildRateTable` (a currency whose newest rate is more than
 *    `maxAgeTargetDays` TARGET days older than the newest date is left out: the ECB stopped it).
 *    A Friday rate serves the weekend and Monday morning; holidays reuse the last rate.
 *  - `loadRateTableExactly(db, date, required)`: STRICT, for booking. Only rates dated exactly
 *    `date`; refuses when nothing is stored for that date (`rate_date_mismatch`: the newest rate on
 *    or before it is older), when a required currency has no rate on that date (`missing_rate`),
 *    or when an ECB conflict for that date is unresolved (`unresolved_conflict`).
 *  - `currenciesWithoutRate(db, currencies, onOrBefore)`: which of these currencies a conversion
 *    on that date could not price.
 *
 * Reads only: an index seek for the newest date and one index range for the rows.
 */
import {
  buildRateTable,
  ECB_MAX_RATE_AGE_TARGET_DAYS,
  isIsoDate,
  parseRate,
  previousTargetWorkingDay,
  type RateTable,
} from "@camelthorn/core";

/** Newest stored date on or before ?1 (uses idx_fx_rates_date: one index seek). */
export const SQL_NEWEST_ON_OR_BEFORE =
  "SELECT MAX(rate_date) AS d FROM fx_rates WHERE rate_date <= ?1";
/** Every rate in [?1, ?2] (uses idx_fx_rates_date: an index range, at most ~11 days x currencies). */
export const SQL_RATES_BETWEEN =
  "SELECT currency, rate_date, rate FROM fx_rates WHERE rate_date >= ?1 AND rate_date <= ?2";
/** Every rate dated exactly ?1 (index range of one day). */
const SQL_RATES_ON = "SELECT currency, rate_date, rate FROM fx_rates WHERE rate_date = ?1";
/** Unresolved conflicts dated ?1 (partial index idx_fx_rate_conflicts_open). */
const SQL_OPEN_CONFLICTS_ON =
  "SELECT currency FROM fx_rate_conflicts WHERE rate_date = ?1 AND resolved_at IS NULL ORDER BY currency";

interface RateRow {
  currency: string;
  rate_date: string;
  rate: string;
}

export interface RateTableLookup {
  /** Null when nothing qualifies (no rates on or before the date). */
  table: RateTable | null;
  /** The newest stored date on or before the date asked for (before the age cut-off). */
  newestDate: string | null;
}

/** The table and the newest stored date, for callers that also judge the feed's freshness. */
export async function loadRateTableWithNewest(
  db: D1Database,
  onOrBefore: string,
  opts: { maxAgeTargetDays?: number } = {},
): Promise<RateTableLookup> {
  const maxAge = opts.maxAgeTargetDays ?? ECB_MAX_RATE_AGE_TARGET_DAYS;
  if (!isIsoDate(onOrBefore)) return { table: null, newestDate: null };
  const newest = (
    await db.prepare(SQL_NEWEST_ON_OR_BEFORE).bind(onOrBefore).first<{ d: string | null }>()
  )?.d;
  if (newest == null) return { table: null, newestDate: null };
  // Only the rows buildRateTable can use: older ones fall below its cut-off anyway.
  let cutoff = newest;
  for (let k = 0; k < maxAge; k += 1) cutoff = previousTargetWorkingDay(cutoff);
  const rows = (await db.prepare(SQL_RATES_BETWEEN).bind(cutoff, newest).all<RateRow>()).results;
  const table = buildRateTable(
    rows.map((r) => ({ currency: r.currency, rateDate: r.rate_date, rate: r.rate })),
    onOrBefore,
    { maxAgeTargetDays: maxAge },
  );
  return { table, newestDate: newest };
}

/** The newest rate per currency on or before `onOrBefore`, as core `buildRateTable` selects it. */
export async function loadRateTable(
  db: D1Database,
  onOrBefore: string,
  opts: { maxAgeTargetDays?: number } = {},
): Promise<RateTable | null> {
  return (await loadRateTableWithNewest(db, onOrBefore, opts)).table;
}

export type ExactRateTableError =
  | { error: "bad_date" }
  /** Nothing is stored for exactly that date (the newest on or before it is older, or none). */
  | { error: "rate_date_mismatch"; newestDate: string | null }
  /** The date has rates, but not for these required currencies. */
  | { error: "missing_rate"; missing: string[] }
  /** The ECB later showed a different value for these currencies on that date; an admin decides. */
  | { error: "unresolved_conflict"; currencies: string[] };

export type ExactRateTableResult =
  { ok: true; table: RateTable } | ({ ok: false } & ExactRateTableError);

/**
 * STRICT table for booking (Phase 12 month-end): every rate is dated exactly `date`. `required`
 * are the currencies the booking needs (EUR is implicit and ignored). A date with an unresolved
 * conflict is refused whatever the currency, because the stored rate for it may be the wrong one.
 */
export async function loadRateTableExactly(
  db: D1Database,
  date: string,
  required: readonly string[] = [],
): Promise<ExactRateTableResult> {
  if (!isIsoDate(date)) return { ok: false, error: "bad_date" };
  const open = (await db.prepare(SQL_OPEN_CONFLICTS_ON).bind(date).all<{ currency: string }>())
    .results;
  if (open.length > 0) {
    return { ok: false, error: "unresolved_conflict", currencies: open.map((r) => r.currency) };
  }
  const rows = (await db.prepare(SQL_RATES_ON).bind(date).all<RateRow>()).results;
  const rates: Record<string, string> = {};
  const ratesDate: Record<string, string> = {};
  // Sorted, so the table (and anything derived from it) is the same on every read.
  for (const r of [...rows].sort((a, b) => (a.currency < b.currency ? -1 : 1))) {
    const p = parseRate(r.rate);
    if (!/^[A-Z]{3}$/.test(r.currency) || r.currency === "EUR" || !p.ok) continue;
    rates[r.currency] = p.rate;
    ratesDate[r.currency] = r.rate_date;
  }
  if (Object.keys(rates).length === 0) {
    const newest = (
      await db.prepare(SQL_NEWEST_ON_OR_BEFORE).bind(date).first<{ d: string | null }>()
    )?.d;
    return { ok: false, error: "rate_date_mismatch", newestDate: newest ?? null };
  }
  const missing = [
    ...new Set(required.filter((c) => c !== "EUR" && rates[c] === undefined)),
  ].sort();
  if (missing.length > 0) return { ok: false, error: "missing_rate", missing };
  return { ok: true, table: { asOf: date, base: "EUR", rates, ratesDate } };
}

/**
 * Of `currencies`, those a conversion on `onOrBefore` cannot price (no rate at all, or the ECB
 * stopped publishing it). EUR never needs a rate. Sorted, without duplicates.
 */
export async function currenciesWithoutRate(
  db: D1Database,
  currencies: readonly string[],
  onOrBefore: string,
): Promise<string[]> {
  const wanted = [...new Set(currencies.filter((c) => c !== "EUR"))];
  if (wanted.length === 0) return [];
  const table = await loadRateTable(db, onOrBefore);
  return wanted.filter((c) => table?.rates[c] === undefined).sort();
}
