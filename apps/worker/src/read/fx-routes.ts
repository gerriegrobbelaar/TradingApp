/**
 * Read-only ECB rates API (Phase 6, task F2, ADR 0036). Shapes are fixed in packages/core
 * api-types (FxRatesResponse, FxHistoryResponse); the UI (F3) builds against them.
 *
 *  GET /api/fx/rates?date=YYYY-MM-DD       newest rate per currency on or before the date (default
 *                                          today); 400 bad_date / date_in_future
 *  GET /api/fx/history?currency=USD&days=90  one currency, oldest first; days 1..400 (default 90);
 *                                          400 bad_currency / bad_days, 404 unknown_currency
 *  GET /api/fx/conflicts[?resolved=1]      admin, finance: stored ECB rates the ECB later showed
 *                                          differently (ADR 0039); unresolved first
 *  POST /api/fx/conflicts/:id/resolve      admin + step-up: {resolution:'kept'|'accepted',
 *                                          confirm:true}; 'accepted' replaces the stored rate
 *                                          (audited before/after, one batch); 404, 409
 *                                          already_resolved_differently / stale_conflict /
 *                                          bad_conflict_rate
 *
 * Any signed-in role may read; responses are no-store. Rates are public data, so nothing is
 * masked. `stale` follows fx/staleness.ts and describes the newest stored rate (the feed), not
 * the `date` asked for. Currencies the ECB stopped publishing drop out as in core buildRateTable.
 */
import {
  amsterdamParts,
  addDaysIso,
  isIsoDate,
  parseRate,
  toCalendarDate,
  type FxConflictResolveResponse,
  type FxConflictsResponse,
  type FxHistoryResponse,
  type FxRateDto,
  type FxRatesResponse,
} from "@camelthorn/core";
import {
  loadRateTableWithNewest,
  SQL_NEWEST_ON_OR_BEFORE,
  SQL_RATES_BETWEEN,
} from "../fx/rate-table";
import {
  CONFLICT_COLUMNS,
  resolveConflict,
  toConflictDto,
  unresolvedConflictCount,
  type ConflictRow,
} from "../fx/conflicts";
import { fxStaleness } from "../fx/staleness";
import { json, type Ctx, type Router } from "../router";
import { ANY_ROLE, BadRequest, guarded } from "./routes";

export const FX_NOTICE =
  "ECB reference rates are for information only. Confirm with your accountant before using them for revaluation.";
export const FX_HISTORY_DEFAULT_DAYS = 90;
export const FX_HISTORY_MAX_DAYS = 400;

// Re-exported for the query plan tests; the SQL lives with the table loader (fx/rate-table.ts).
export { SQL_NEWEST_ON_OR_BEFORE, SQL_RATES_BETWEEN };
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
  const { table, newestDate: newestOnDate } = await loadRateTableWithNewest(db, date);
  let rates: FxRateDto[] = [];
  let asOf: string | null = null;
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
    unresolvedConflicts: await unresolvedConflictCount(db),
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

const CONFLICT_READERS = { roles: ["admin", "finance"] } as const;
const CONFLICT_RESOLVERS = { roles: ["admin"], stepUp: true } as const;
const MAX_CONFLICTS_LISTED = 200;

async function conflictsHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const withResolved = ctx.url.searchParams.get("resolved") === "1";
  const rows = (
    await db
      .prepare(
        `SELECT ${CONFLICT_COLUMNS} FROM fx_rate_conflicts
         WHERE ?1 = 1 OR resolved_at IS NULL
         ORDER BY resolved_at IS NOT NULL, rate_date DESC, currency, id LIMIT ?2`,
      )
      .bind(withResolved ? 1 : 0, MAX_CONFLICTS_LISTED)
      .all<ConflictRow>()
  ).results;
  const body: FxConflictsResponse = {
    unresolvedCount: await unresolvedConflictCount(db),
    conflicts: rows.map(toConflictDto),
  };
  return json(body);
}

async function resolveHandler(ctx: Ctx): Promise<Response> {
  const session = ctx.session;
  if (!session) throw new BadRequest("unauthenticated");
  const id = Number(ctx.params["id"]);
  if (!/^[1-9]\d{0,9}$/.test(ctx.params["id"] ?? "")) throw new BadRequest("not_found", 404);
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    throw new BadRequest("bad_request");
  }
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  const rec = b as Record<string, unknown> | null;
  if (rec === null || Object.keys(rec).some((k) => k !== "resolution" && k !== "confirm")) {
    throw new BadRequest("bad_request");
  }
  const resolution = rec["resolution"];
  if (resolution !== "kept" && resolution !== "accepted") throw new BadRequest("bad_resolution");
  // A deliberate act: the caller has to say so (the UI shows the two rates first).
  if (rec["confirm"] !== true) throw new BadRequest("confirm_required");

  const out = await resolveConflict(
    ctx.env.DB,
    id,
    resolution,
    session.email,
    new Date(ctx.nowMs).toISOString(),
  );
  switch (out.kind) {
    case "not_found":
      throw new BadRequest("not_found", 404);
    case "conflicting_resolution":
      return json({ error: "already_resolved_differently" }, 409);
    case "stale":
      return json({ error: "stale_conflict" }, 409);
    case "bad_rate":
      return json({ error: "bad_conflict_rate" }, 409);
    case "resolved":
    case "already_resolved": {
      const res: FxConflictResolveResponse = {
        conflict: toConflictDto(out.conflict),
        alreadyResolved: out.kind === "already_resolved",
      };
      return json(res);
    }
  }
}

export function registerFxRoutes(router: Router): void {
  router.add("GET", "/api/fx/rates", ANY_ROLE, guarded(ratesHandler));
  router.add("GET", "/api/fx/history", ANY_ROLE, guarded(historyHandler));
  router.add("GET", "/api/fx/conflicts", CONFLICT_READERS, guarded(conflictsHandler));
  router.add("POST", "/api/fx/conflicts/:id/resolve", CONFLICT_RESOLVERS, guarded(resolveHandler));
}
