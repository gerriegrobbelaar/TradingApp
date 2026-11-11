/**
 * Read-only ECB rates API (Phase 6, task F2, ADR 0035). Shapes are fixed in packages/core
 * api-types (FxRatesResponse, FxHistoryResponse); the UI (F3) builds against them.
 *
 *  GET /api/fx/rates?date=YYYY-MM-DD       newest rate per currency on or before the date (default
 *                                          today); 400 bad_date / date_in_future
 *  GET /api/fx/history?currency=USD&days=90  one currency, oldest first; days 1..400 (default 90);
 *                                          400 bad_currency / bad_days, 404 unknown_currency
 *
 * Any signed-in role may read; responses are no-store. Rates are public data, so nothing is
 * masked. `stale` follows fx/staleness.ts.
 */
import {
  amsterdamParts,
  addDaysIso,
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

async function ratesHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const today = amsterdamParts(ctx.nowMs).date;
  const raw = ctx.url.searchParams.get("date");
  let date = today;
  if (raw !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new BadRequest("bad_date");
    try {
      date = toCalendarDate(raw);
    } catch {
      throw new BadRequest("bad_date");
    }
    if (date > today) throw new BadRequest("date_in_future");
  }

  const rows = (
    await db
      .prepare(
        `SELECT f.currency, f.rate, f.rate_date FROM fx_rates f
         JOIN (SELECT currency, MAX(rate_date) AS d FROM fx_rates WHERE rate_date <= ?1
               GROUP BY currency) m ON m.currency = f.currency AND m.d = f.rate_date
         ORDER BY f.currency`,
      )
      .bind(date)
      .all<{ currency: string; rate: string; rate_date: string }>()
  ).results;
  const rates: FxRateDto[] = rows.map((r) => ({
    currency: r.currency,
    rate: r.rate,
    rateDate: r.rate_date,
    source: "ECB",
  }));
  const asOf = rates.reduce<string | null>(
    (acc, r) => (acc === null || r.rateDate > acc ? r.rateDate : acc),
    null,
  );
  const any = await db.prepare("SELECT 1 AS x FROM fx_rates LIMIT 1").first<{ x: number }>();
  const state = await db
    .prepare("SELECT last_attempt_at, last_status FROM fx_import_state WHERE id = 1")
    .first<{ last_attempt_at: string | null; last_status: string | null }>();

  // An empty table was never imported; a date before the first stored rate returns no rates but
  // is not a freshness problem.
  const freshness =
    asOf === null && any !== null
      ? { stale: false, staleReason: null, workingDaysOld: null }
      : fxStaleness(asOf, ctx.nowMs);
  const body: FxRatesResponse = {
    base: "EUR",
    asOf,
    rates,
    ...freshness,
    lastImportAt: state?.last_attempt_at ?? null,
    lastImportStatus: state?.last_status ?? null,
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
    await db
      .prepare(
        `SELECT rate_date, rate FROM fx_rates WHERE currency = ?1 AND rate_date >= ?2
         ORDER BY rate_date`,
      )
      .bind(currency, since)
      .all<{ rate_date: string; rate: string }>()
  ).results;
  const body: FxHistoryResponse = {
    currency,
    base: "EUR",
    points: rows.map((r) => ({ rateDate: r.rate_date, rate: r.rate })),
  };
  return json(body);
}

export function registerFxRoutes(router: Router): void {
  router.add("GET", "/api/fx/rates", ANY_ROLE, guarded(ratesHandler));
  router.add("GET", "/api/fx/history", ANY_ROLE, guarded(historyHandler));
}
