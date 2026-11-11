/**
 * Read-only ledger API: balance sheet, profit and loss, the chart of accounts and the balances of
 * one account (Phase 4, task K2, ADR 0024).
 *
 *  GET /api/reports/balance-sheet     ?year&period&compare=yearend|period|none[&compareYear]
 *  GET /api/reports/profit-loss       ?year&periodTo[&scenario=<guid>|none]
 *  GET /api/ledger/accounts           the chart with flags and report sections
 *  GET /api/ledger/accounts/:id/balances?year   period rows of one account
 *
 * Same rules as the open-item reads (ADR 0022): any signed-in role, `?division=<divisions.id>`
 * validated against the readable divisions (404 for another or a disabled one), rows are reached
 * through their division (an account id of a division the user cannot read is a 404), responses are
 * `no-store`. Amounts are integer minor units in the DIVISION currency. A division whose ledger was
 * never synced answers 200 with `status: "not_synced"` and no report, so a screen can show an empty
 * state. Freshness is reported per ledger entity; budgets are optional (`budgetsAvailable`).
 */
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  classifyBalanceSheetAccount,
  classifyProfitLossAccount,
  amsterdamParts,
  resolveAccounts,
  toSafe,
  type LedgerAccount,
  type LedgerAccountBalancesResponse,
  type LedgerAccountRow,
  type LedgerAccountsResponse,
  type LedgerBalance,
  type LedgerBudget,
  type LedgerEntity,
  type LedgerFreshness,
  type LedgerFreshnessEntry,
  type LedgerPeriodRow,
  type BalanceSheetResponse,
  type ProfitLossResponse,
} from "@camelthorn/core";
import { json, type Ctx, type Router } from "../router";
import {
  ANY_ROLE,
  BadRequest,
  STALE_AFTER_HOURS,
  divisionById,
  guarded,
  positiveIntParam,
  resolveDivision,
  toRef,
} from "./routes";

/** Budgets are read weekly, so they are stale only after a week and a day. */
export const BUDGETS_STALE_AFTER_HOURS = 8 * 24;
/** The most chart rows one answer holds (a chart has a few hundred). */
export const MAX_ACCOUNT_ROWS = 5000;
/** Reporting periods the API accepts (12 months and the extra closing periods). */
export const MAX_REQUEST_PERIOD = 16;

function yearParam(raw: string | null, name: string, fallback: number): number {
  if (raw === null) return fallback;
  if (!/^[12]\d{3}$/.test(raw)) throw new BadRequest(`bad_${name}`);
  const n = Number(raw);
  if (n < 1900 || n > 2200) throw new BadRequest(`bad_${name}`);
  return n;
}

function periodParam(raw: string | null, name: string, fallback: number): number {
  if (raw === null) return fallback;
  if (!/^[1-9]\d?$/.test(raw)) throw new BadRequest(`bad_${name}`);
  const n = Number(raw);
  if (n > MAX_REQUEST_PERIOD) throw new BadRequest(`bad_${name}`);
  return n;
}

/** The current Amsterdam year and month. */
function nowParts(nowMs: number): { year: number; month: number } {
  const [y, m] = amsterdamParts(nowMs).date.split("-");
  return { year: Number(y), month: Number(m) };
}

/** Default period: the current month in the current year, else the whole year. */
const defaultPeriod = (year: number, nowMs: number): number => {
  const now = nowParts(nowMs);
  return year === now.year ? now.month : 12;
};

// ---- state and freshness --------------------------------------------------------------------

interface LedgerState {
  freshness: LedgerFreshness;
  budgetsAvailable: boolean;
  /** Reporting years whose balances / budgets were read completely. */
  balanceYears: Set<number>;
  budgetYears: Set<number>;
  accountsSynced: boolean;
}

function entry(at: string | null, staleAfterHours: number, nowMs: number): LedgerFreshnessEntry {
  const t = at === null ? NaN : Date.parse(at);
  return {
    lastCompletedAt: Number.isNaN(t) ? null : at,
    stale: !(nowMs - t <= staleAfterHours * 3_600_000),
    staleAfterHours,
  };
}

async function ledgerState(
  db: D1Database,
  divisionId: number,
  year: number,
  nowMs: number,
): Promise<LedgerState> {
  const [years, sync] = await db.batch<{
    entity: string;
    year: number;
    completed_at: string;
    unavailable_until: string | null;
    last_completed_at: string | null;
  }>([
    db
      .prepare("SELECT entity, year, completed_at FROM gl_sync_years WHERE division_id = ?1")
      .bind(divisionId),
    db
      .prepare(
        `SELECT entity, last_completed_at, unavailable_until FROM sync_state
         WHERE division_id = ?1 AND entity IN ('gl_accounts', 'gl_budgets')`,
      )
      .bind(divisionId),
  ]);
  const yearRows = years?.results ?? [];
  const stateRows = sync?.results ?? [];
  const at = (entity: LedgerEntity): string | null =>
    yearRows.find((r) => r.entity === entity && r.year === year)?.completed_at ?? null;
  const accounts = stateRows.find((r) => r.entity === "gl_accounts")?.last_completed_at ?? null;
  const until = stateRows.find((r) => r.entity === "gl_budgets")?.unavailable_until ?? null;
  return {
    freshness: {
      gl_accounts: entry(accounts, STALE_AFTER_HOURS, nowMs),
      gl_balances: entry(at("gl_balances"), STALE_AFTER_HOURS, nowMs),
      gl_budgets: entry(at("gl_budgets"), BUDGETS_STALE_AFTER_HOURS, nowMs),
    },
    budgetsAvailable: until === null || !(Date.parse(until) > nowMs),
    balanceYears: new Set(yearRows.filter((r) => r.entity === "gl_balances").map((r) => r.year)),
    budgetYears: new Set(yearRows.filter((r) => r.entity === "gl_budgets").map((r) => r.year)),
    accountsSynced: accounts !== null,
  };
}

// ---- stored rows ----------------------------------------------------------------------------

interface AccountSql {
  id: number;
  exact_id: string;
  code: string | null;
  name: string;
  type: number | null;
  type_description: string | null;
  balance_side: "D" | "C" | null;
  balance_type: "B" | "W" | null;
  is_blocked: number;
  is_active: number;
}

const ACCOUNT_SQL = `SELECT id, exact_id, code, name, type, type_description, balance_side,
    balance_type, is_blocked, is_active FROM gl_accounts WHERE division_id = ?1`;

const toLedgerAccount = (a: AccountSql): LedgerAccount => ({
  exactId: a.exact_id,
  code: a.code,
  name: a.name,
  type: a.type,
  typeDescription: a.type_description,
  balanceSide: a.balance_side,
  balanceType: a.balance_type,
  isActive: a.is_active === 1,
});

function accountRow(a: AccountSql): LedgerAccountRow {
  const resolved = resolveAccounts([toLedgerAccount(a)], []).get(a.exact_id);
  const profitLoss = resolved?.balanceType === "W";
  return {
    id: a.id,
    exactId: a.exact_id,
    code: a.code,
    name: a.name,
    type: a.type,
    typeDescription: a.type_description,
    balanceSide: a.balance_side,
    balanceType: a.balance_type,
    isBlocked: a.is_blocked === 1,
    isActive: a.is_active === 1,
    statement: profitLoss ? "profit_loss" : "balance_sheet",
    section:
      resolved === undefined
        ? "unclassified"
        : profitLoss
          ? classifyProfitLossAccount(resolved)
          : classifyBalanceSheetAccount(resolved),
  };
}

interface BalanceSql {
  id: string;
  year: number;
  period: number;
  amount_minor: number;
  balance_type: "B" | "W" | null;
}

const toBalance = (r: BalanceSql): LedgerBalance => ({
  glAccountExactId: r.id,
  year: r.year,
  period: r.period,
  amountMinor: r.amount_minor,
  balanceType: r.balance_type,
});

// ---- balance sheet --------------------------------------------------------------------------

async function balanceSheetHandler(ctx: Ctx): Promise<Response> {
  const division = await resolveDivision(ctx);
  const ref = toRef(division);
  const p = ctx.url.searchParams;
  const now = nowParts(ctx.nowMs);
  const year = yearParam(p.get("year"), "year", now.year);
  const period = periodParam(p.get("period"), "period", defaultPeriod(year, ctx.nowMs));
  const compare = p.get("compare") ?? "yearend";
  if (compare !== "yearend" && compare !== "period" && compare !== "none") {
    throw new BadRequest("bad_compare");
  }
  const wantYear =
    compare === "none" ? null : yearParam(p.get("compareYear"), "compare_year", year - 1);
  if (wantYear === year) throw new BadRequest("bad_compare_year");

  const db = ctx.env.DB;
  const state = await ledgerState(db, division.id, year, ctx.nowMs);
  const synced = state.balanceYears.has(year);
  const compareSynced = wantYear !== null && state.balanceYears.has(wantYear);
  const base = {
    division: ref,
    year,
    period,
    freshness: state.freshness,
    budgetsAvailable: state.budgetsAvailable,
  };
  if (!synced) {
    const body: BalanceSheetResponse = {
      ...base,
      status: "not_synced",
      compareYear: null,
      compareMissing: wantYear !== null,
      report: null,
    };
    return json(body);
  }

  // Only the periods the report adds up: up to `period` of the year, and of the compare year
  // either all of them (year end) or up to `period` too.
  const compareLimit = compare === "yearend" ? 99 : period;
  const [accounts, balances] = await db.batch<AccountSql | BalanceSql>([
    db.prepare(ACCOUNT_SQL).bind(division.id),
    db
      .prepare(
        `SELECT gl_account_exact_id AS id, year, period, SUM(amount_minor) AS amount_minor,
                MIN(balance_type) AS balance_type
         FROM gl_balances
         WHERE division_id = ?1 AND ((year = ?2 AND period <= ?3) OR (year = ?4 AND period <= ?5))
         GROUP BY gl_account_exact_id, year, period`,
      )
      .bind(division.id, year, period, compareSynced ? wantYear : -1, compareLimit),
  ]);
  const report = buildBalanceSheet(
    ((accounts?.results ?? []) as AccountSql[]).map(toLedgerAccount),
    ((balances?.results ?? []) as BalanceSql[]).map(toBalance),
    {
      year,
      period,
      compareYear: compareSynced ? wantYear : null,
      compareToYearEnd: compare === "yearend",
    },
  );
  const body: BalanceSheetResponse = {
    ...base,
    status: "ok",
    compareYear: compareSynced ? wantYear : null,
    compareMissing: wantYear !== null && !compareSynced,
    report,
  };
  return json(body);
}

// ---- profit and loss ------------------------------------------------------------------------

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function profitLossHandler(ctx: Ctx): Promise<Response> {
  const division = await resolveDivision(ctx);
  const ref = toRef(division);
  const p = ctx.url.searchParams;
  const now = nowParts(ctx.nowMs);
  const year = yearParam(p.get("year"), "year", now.year);
  const periodTo = periodParam(p.get("periodTo"), "period_to", defaultPeriod(year, ctx.nowMs));
  const rawScenario = p.get("scenario");
  let wanted: string | null = null;
  if (rawScenario !== null) {
    const v = rawScenario.toLowerCase();
    if (v !== "none" && !GUID.test(v)) throw new BadRequest("bad_scenario");
    wanted = v === "none" ? "" : v;
  }
  const compareYear = year - 1;

  const db = ctx.env.DB;
  const state = await ledgerState(db, division.id, year, ctx.nowMs);
  const base = {
    division: ref,
    year,
    periodTo,
    compareYear,
    freshness: state.freshness,
    budgetsAvailable: state.budgetsAvailable,
  };
  if (!state.balanceYears.has(year)) {
    const body: ProfitLossResponse = {
      ...base,
      status: "not_synced",
      compareMissing: true,
      report: null,
      budgetScenario: null,
      budgetScenarios: [],
    };
    return json(body);
  }

  const useBudgets = state.budgetsAvailable && state.budgetYears.has(year);
  const [accounts, balances, scenarios] = await db.batch<AccountSql | BalanceSql | { s: string }>([
    db.prepare(ACCOUNT_SQL).bind(division.id),
    db
      .prepare(
        `SELECT b.gl_account_exact_id AS id, b.year, b.period, SUM(b.amount_minor) AS amount_minor,
                MIN(b.balance_type) AS balance_type
         FROM gl_balances b
         LEFT JOIN gl_accounts a ON a.division_id = b.division_id AND a.exact_id = b.gl_account_exact_id
         WHERE b.division_id = ?1 AND b.year IN (?2, ?3) AND b.period BETWEEN 1 AND ?4
           AND COALESCE(a.balance_type, b.balance_type) = 'W'
         GROUP BY b.gl_account_exact_id, b.year, b.period`,
      )
      // a year that was never read completely may hold partial rows: not shown
      .bind(division.id, year, state.balanceYears.has(compareYear) ? compareYear : -1, periodTo),
    db
      .prepare(
        "SELECT DISTINCT scenario AS s FROM gl_budgets WHERE division_id = ?1 AND year = ?2 ORDER BY scenario",
      )
      .bind(division.id, useBudgets ? year : -1),
  ]);
  const scenarioList = ((scenarios?.results ?? []) as { s: string }[]).map((r) => r.s);
  if (wanted !== null && useBudgets && !scenarioList.includes(wanted)) {
    throw new BadRequest("unknown_scenario");
  }
  const scenario = !useBudgets ? null : (wanted ?? scenarioList[0] ?? "");
  let budgets: LedgerBudget[] | null = null;
  if (useBudgets && scenario !== null) {
    const rows = (
      await db
        .prepare(
          `SELECT gl_account_exact_id AS id, year, period, SUM(amount_minor) AS amount_minor
           FROM gl_budgets
           WHERE division_id = ?1 AND year = ?2 AND scenario = ?3 AND period BETWEEN 1 AND ?4
           GROUP BY gl_account_exact_id, year, period`,
        )
        .bind(division.id, year, scenario, periodTo)
        .all<{ id: string; year: number; period: number; amount_minor: number }>()
    ).results;
    budgets = rows.map((r) => ({
      glAccountExactId: r.id,
      year: r.year,
      period: r.period,
      amountMinor: r.amount_minor,
    }));
  }
  const report = buildProfitAndLoss(
    ((accounts?.results ?? []) as AccountSql[]).map(toLedgerAccount),
    ((balances?.results ?? []) as BalanceSql[]).map(toBalance),
    budgets,
    { year, periodTo, compareYear },
  );
  const body: ProfitLossResponse = {
    ...base,
    status: "ok",
    compareMissing: !state.balanceYears.has(compareYear),
    report,
    budgetScenario: scenario,
    budgetScenarios: scenarioList,
  };
  return json(body);
}

// ---- chart and drill-down -------------------------------------------------------------------

async function accountsHandler(ctx: Ctx): Promise<Response> {
  const division = await resolveDivision(ctx);
  const db = ctx.env.DB;
  const state = await ledgerState(db, division.id, nowParts(ctx.nowMs).year, ctx.nowMs);
  const rows = (
    await db
      .prepare(`${ACCOUNT_SQL} ORDER BY code IS NULL, code, name, id LIMIT ${MAX_ACCOUNT_ROWS}`)
      .bind(division.id)
      .all<AccountSql>()
  ).results;
  const accounts = rows.map(accountRow);
  const body: LedgerAccountsResponse = {
    division: toRef(division),
    status: state.accountsSynced ? "ok" : "not_synced",
    accounts,
    unclassifiedCount: accounts.filter((a) => a.section === "unclassified").length,
    freshness: state.freshness,
  };
  return json(body);
}

async function accountBalancesHandler(ctx: Ctx): Promise<Response> {
  const id = positiveIntParam(ctx.params["id"] ?? null, "id");
  if (id === null) throw new BadRequest("bad_id");
  const db = ctx.env.DB;
  const account = await db
    .prepare(
      `SELECT id, exact_id, code, name, type, type_description, balance_side, balance_type,
              is_blocked, is_active, division_id FROM gl_accounts WHERE id = ?1`,
    )
    .bind(id)
    .first<AccountSql & { division_id: number }>();
  if (!account) throw new BadRequest("not_found", 404);
  const division = await divisionById(db, account.division_id);
  if (!division) throw new BadRequest("not_found", 404);
  const year = yearParam(ctx.url.searchParams.get("year"), "year", nowParts(ctx.nowMs).year);
  const state = await ledgerState(db, division.id, year, ctx.nowMs);
  const rows = (
    await db
      .prepare(
        `SELECT period, SUM(amount_minor) AS amount_minor,
                CASE WHEN COUNT(debit_minor) = COUNT(*) THEN SUM(debit_minor) END AS debit_minor,
                CASE WHEN COUNT(credit_minor) = COUNT(*) THEN SUM(credit_minor) END AS credit_minor,
                COUNT(*) AS rows
         FROM gl_balances
         WHERE division_id = ?1 AND gl_account_exact_id = ?2 AND year = ?3
         GROUP BY period ORDER BY period`,
      )
      .bind(division.id, account.exact_id, year)
      .all<{
        period: number;
        amount_minor: number;
        debit_minor: number | null;
        credit_minor: number | null;
        rows: number;
      }>()
  ).results;
  const periods: LedgerPeriodRow[] = rows.map((r) => ({
    period: r.period,
    amountMinor: r.amount_minor,
    debitMinor: r.debit_minor,
    creditMinor: r.credit_minor,
    rows: r.rows,
  }));
  const body: LedgerAccountBalancesResponse = {
    division: toRef(division),
    status: state.balanceYears.has(year) ? "ok" : "not_synced",
    year,
    account: accountRow(account),
    periods,
    totalMinor: toSafe(periods.reduce((t, r) => t + BigInt(r.amountMinor), 0n)),
    freshness: state.freshness,
  };
  return json(body);
}

export function registerLedgerRoutes(router: Router): void {
  router.add("GET", "/api/reports/balance-sheet", ANY_ROLE, guarded(balanceSheetHandler));
  router.add("GET", "/api/reports/profit-loss", ANY_ROLE, guarded(profitLossHandler));
  router.add("GET", "/api/ledger/accounts", ANY_ROLE, guarded(accountsHandler));
  router.add("GET", "/api/ledger/accounts/:id/balances", ANY_ROLE, guarded(accountBalancesHandler));
}
