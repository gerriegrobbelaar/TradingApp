/**
 * Read-only ECB rates API (Phase 6, task F2, ADR 0036). Shapes are fixed in packages/core
 * api-types (FxRatesResponse, FxHistoryResponse); the UI (F3) builds against them.
 *
 *  GET /api/fx/rates?date=YYYY-MM-DD       newest rate per currency on or before the date (default
 *                                          today); 400 bad_date / date_in_future
 *  GET /api/fx/history?currency=USD&days=90  one currency, oldest first; days 1..400 (default 90);
 *                                          400 bad_currency / bad_days, 404 unknown_currency
 *
 * Any signed-in role may read; responses are no-store. Rates are public data, so nothing is
 * masked. `stale` follows fx/staleness.ts and describes the newest stored rate (the feed), not
 * the `date` asked for. Currencies the ECB stopped publishing drop out as in core buildRateTable.
 */
import {
  amsterdamParts,
  addDaysIso,
  buildRateTable,
  ECB_MAX_RATE_AGE_TARGET_DAYS,
  isIsoDate,
  parseRate,
  previousTargetWorkingDay,
  toCalendarDate,
  type FxHistoryResponse,
  type FxRateDto,
  type FxRatesResponse,
} from "@camelthorn/core";
import { fxStaleness } from "../fx/staleness";
import { json, type Ctx, type Router } from "../router";
import { ANY_ROLE, BadRequest, guarded } from "./routes";

export const FX_NOTICE =
  "ECB reference rates are for information only. Confirm with your accountant before using them for revaluation.";
export const FX_HISTORY_DEFAULT_DAYS = 90;
export const FX_HISTORY_MAX_DAYS = 400;

/** Newest stored date on or before ?1 (uses idx_fx_rates_date: one index seek). */
export const SQL_NEWEST_ON_OR_BEFORE =
  "SELECT MAX(rate_date) AS d FROM fx_rates WHERE rate_date <= ?1";
/** Every rate in [?1, ?2] (uses idx_fx_rates_date: an index range, at most ~11 days x currencies). */
export const SQL_RATES_BETWEEN =
  "SELECT currency, rate_date, rate FROM fx_rates WHERE rate_date >= ?1 AND rate_date <= ?2";
/** One currency's history from ?2 (uses the primary key (currency, rate_date)). */
export const SQL_HISTORY =
  "SELECT rate_date, rate FROM fx_rates WHERE currency = ?1 AND rate_date >= ?2 ORDER BY rate_date";

async function ratesHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const today = amsterdamParts(ctx.nowMs).date;
  const raw = ctx.url.searchParams.get("date");
  let date = today;
  if (raw !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !isIsoDate(raw)) throw new BadRequest("bad_date");
    try {
      date = toCalendarDate(raw);
    } catch {
      throw new BadRequest("bad_date");
    }
    if (date > today) throw new BadRequest("date_in_future");
  }

  // The newest date on or before `date`, then only the rows core buildRateTable can use: a
  // currency whose last rate is more than ECB_MAX_RATE_AGE_TARGET_DAYS TARGET days older than
  // that (HRK, RUB) is left out, exactly as a conversion would treat it (missing_rate).
  const newestOnDate = (
    await db.prepare(SQL_NEWEST_ON_OR_BEFORE).bind(date).first<{ d: string | null }>()
  )?.d;
  let rates: FxRateDto[] = [];
  let asOf: string | null = null;
  if (newestOnDate != null) {
    let cutoff = newestOnDate;
    for (let k = 0; k < ECB_MAX_RATE_AGE_TARGET_DAYS; k += 1) {
      cutoff = previousTargetWorkingDay(cutoff);
    }
    const rows = (
      await db
        .prepare(SQL_RATES_BETWEEN)
        .bind(cutoff, newestOnDate)
        .all<{ currency: string; rate: string; rate_date: string }>()
    ).results;
    const table = buildRateTable(
      rows.map((r) => ({ currency: r.currency, rateDate: r.rate_date, rate: r.rate })),
      date,
    );
    if (table !== null) {
      asOf = table.asOf;
      rates = Object.keys(table.rates)
        .sort()
        .map((currency) => ({
          currency,
          rate: table.rates[currency] as string,
          rateDate: table.ratesDate?.[currency] as string,
          source: "ECB",
        }));
    }
  }

  // Freshness is about the feed, whatever `date` asks for: the newest rate stored at all (up to
  // today) against the clock. An empty table is never_imported.
  const newest =
    date === today
      ? newestOnDate
      : (await db.prepare(SQL_NEWEST_ON_OR_BEFORE).bind(today).first<{ d: string | null }>())?.d;
  const state = await db
    .prepare(
      "SELECT last_attempt_at, last_status, last_error_code FROM fx_import_state WHERE id = 1",
    )
    .first<{
      last_attempt_at: string | null;
      last_status: string | null;
      last_error_code: string | null;
    }>();

  const body: FxRatesResponse = {
    base: "EUR",
    asOf,
    rates,
    ...fxStaleness(newest ?? null, ctx.nowMs),
    lastImportAt: state?.last_attempt_at ?? null,
    lastImportStatus: state?.last_status ?? null,
    lastImportCode: state?.last_error_code ?? null,
    notice: FX_NOTICE,
  };
  return json(body);
}

async function historyHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const rawCurrency = ctx.url.searchParams.get("currency");
  if (rawCurrency === null || !/^[A-Za-z]{3}$/.test(rawCurrency)) {
    throw new BadRequest("bad_currency");
  }
  const currency = rawCurrency.toUpperCase();
  const rawDays = ctx.url.searchParams.get("days");
  let days = FX_HISTORY_DEFAULT_DAYS;
  if (rawDays !== null) {
    if (!/^[1-9]\d{0,3}$/.test(rawDays)) throw new BadRequest("bad_days");
    days = Number(rawDays);
    if (days > FX_HISTORY_MAX_DAYS) throw new BadRequest("bad_days");
  }
  const since = addDaysIso(amsterdamParts(ctx.nowMs).date, -days);
  const known = await db
    .prepare("SELECT 1 AS x FROM fx_rates WHERE currency = ?1 LIMIT 1")
    .bind(currency)
    .first<{ x: number }>();
  if (known === null) throw new BadRequest("unknown_currency", 404);
  const rows = (
    await db.prepare(SQL_HISTORY).bind(currency, since).all<{ rate_date: string; rate: string }>()
  ).results;
  const body: FxHistoryResponse = {
    currency,
    base: "EUR",
    points: rows.map((r) => {
      const p = parseRate(r.rate);
      return { rateDate: r.rate_date, rate: p.ok ? p.rate : r.rate };
    }),
  };
  return json(body);
}

export function registerFxRoutes(router: Router): void {
  router.add("GET", "/api/fx/rates", ANY_ROLE, guarded(ratesHandler));
  router.add("GET", "/api/fx/history", ANY_ROLE, guarded(historyHandler));
}
