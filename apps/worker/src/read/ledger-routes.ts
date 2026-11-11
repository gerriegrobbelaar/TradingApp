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
 * state; a year that was read completely but holds no rows at all (a new year before Exact has
 * figures for it, a new administration) answers `status: "no_data"`, also without a report, so an
 * empty sheet is never presented as a real one. Freshness is reported per ledger entity (the
 * balances of the current year are read nightly, other years at most weekly, budgets weekly) and
 * for the compare year; budgets are optional (`budgetsAvailable`). `splitKeys` counts figures that
 * Exact split over a field we do not read (they may be low, ADR 0024).
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
  type LedgerReportStatus,
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
/** The previous year's balances are read at most weekly too (ADR 0024): same rule. */
export const OTHER_YEAR_STALE_AFTER_HOURS = BUDGETS_STALE_AFTER_HOURS;
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

interface YearInfo {
  completedAt: string | null;
  splitKeys: number;
  /** Any stored balance row for the year. */
  hasRows: boolean;
}

interface LedgerState {
  freshness: LedgerFreshness;
  budgetsAvailable: boolean;
  /** Reporting years whose balances / budgets were read completely. */
  balanceYears: Set<number>;
  budgetYears: Set<number>;
  accountsSynced: boolean;
  /** The requested year and the compare year (when asked for). */
  balances: Map<number, YearInfo>;
  budgetSplitKeys: number;
  currentYear: number;
}

function entry(at: string | null, staleAfterHours: number, nowMs: number): LedgerFreshnessEntry {
  const t = at === null ? NaN : Date.parse(at);
  return {
    lastCompletedAt: Number.isNaN(t) ? null : at,
    stale: !(nowMs - t <= staleAfterHours * 3_600_000),
    staleAfterHours,
  };
}

/** Balances of the current year are read nightly; any other year at most weekly. */
const balancesStaleAfter = (year: number, currentYear: number): number =>
  year === currentYear ? STALE_AFTER_HOURS : OTHER_YEAR_STALE_AFTER_HOURS;

async function ledgerState(
  db: D1Database,
  divisionId: number,
  year: number,
  nowMs: number,
  compareYear: number | null = null,
): Promise<LedgerState> {
  const currentYear = nowParts(nowMs).year;
  const asked = compareYear === null ? [year] : [year, compareYear];
  const [years, sync, present] = await db.batch<{
    entity: string;
    year: number;
    completed_at: string;
    split_keys: number;
    unavailable_until: string | null;
    last_completed_at: string | null;
  }>([
    db
      .prepare(
        "SELECT entity, year, completed_at, split_keys FROM gl_sync_years WHERE division_id = ?1",
      )
      .bind(divisionId),
    db
      .prepare(
        `SELECT entity, last_completed_at, unavailable_until FROM sync_state
         WHERE division_id = ?1 AND entity IN ('gl_accounts', 'gl_budgets')`,
      )
      .bind(divisionId),
    // one indexed probe per asked year (idx_gl_balances_year)
    db
      .prepare(
        `SELECT y.value AS year FROM json_each(?2) y
         WHERE EXISTS (SELECT 1 FROM gl_balances b WHERE b.division_id = ?1 AND b.year = y.value)`,
      )
      .bind(divisionId, JSON.stringify(asked)),
  ]);
  const yearRows = years?.results ?? [];
  const stateRows = sync?.results ?? [];
  const withRows = new Set((present?.results ?? []).map((r) => Number(r.year)));
  const row = (entity: LedgerEntity, y: number) =>
    yearRows.find((r) => r.entity === entity && r.year === y);
  const accounts = stateRows.find((r) => r.entity === "gl_accounts")?.last_completed_at ?? null;
  const until = stateRows.find((r) => r.entity === "gl_budgets")?.unavailable_until ?? null;
  const balances = new Map<number, YearInfo>(
    asked.map((y) => [
      y,
      {
        completedAt: row("gl_balances", y)?.completed_at ?? null,
        splitKeys: row("gl_balances", y)?.split_keys ?? 0,
        hasRows: withRows.has(y),
      },
    ]),
  );
  return {
    freshness: {
      gl_accounts: entry(accounts, STALE_AFTER_HOURS, nowMs),
      gl_balances: entry(
        row("gl_balances", year)?.completed_at ?? null,
        balancesStaleAfter(year, currentYear),
        nowMs,
      ),
      gl_budgets: entry(
        row("gl_budgets", year)?.completed_at ?? null,
        BUDGETS_STALE_AFTER_HOURS,
        nowMs,
      ),
    },
    budgetsAvailable: until === null || !(Date.parse(until) > nowMs),
    balanceYears: new Set(yearRows.filter((r) => r.entity === "gl_balances").map((r) => r.year)),
    budgetYears: new Set(yearRows.filter((r) => r.entity === "gl_budgets").map((r) => r.year)),
    accountsSynced: accounts !== null,
    balances,
    budgetSplitKeys: row("gl_budgets", year)?.split_keys ?? 0,
    currentYear,
  };
}

/** Freshness of the compare year's balances, or null when there is no comparison. */
function compareFreshness(
  state: LedgerState,
  compareYear: number | null,
  nowMs: number,
): LedgerFreshnessEntry | null {
  if (compareYear === null) return null;
  return entry(
    state.balances.get(compareYear)?.completedAt ?? null,
    balancesStaleAfter(compareYear, state.currentYear),
    nowMs,
  );
}

/** Report status of the requested year: never read, read but empty, or ok. */
function yearStatus(state: LedgerState, year: number): LedgerReportStatus {
  if (!state.balanceYears.has(year)) return "not_synced";
  return state.balances.get(year)?.hasRows === true ? "ok" : "no_data";
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
  const state = await ledgerState(db, division.id, year, ctx.nowMs, wantYear);
  const status = yearStatus(state, year);
  const compareSynced = wantYear !== null && state.balanceYears.has(wantYear);
  const base = {
    division: ref,
    year,
    period,
    freshness: state.freshness,
    compareFreshness: compareFreshness(state, compareSynced ? wantYear : null, ctx.nowMs),
    budgetsAvailable: state.budgetsAvailable,
    splitKeys:
      (state.balances.get(year)?.splitKeys ?? 0) +
      (compareSynced && wantYear !== null ? (state.balances.get(wantYear)?.splitKeys ?? 0) : 0),
  };
  if (status !== "ok") {
    const body: BalanceSheetResponse = {
      ...base,
      status,
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
  const state = await ledgerState(db, division.id, year, ctx.nowMs, compareYear);
  const status = yearStatus(state, year);
  const compareSynced = state.balanceYears.has(compareYear);
  const useBudgets = state.budgetsAvailable && state.budgetYears.has(year);
  const base = {
    division: ref,
    year,
    periodTo,
    compareYear,
    freshness: state.freshness,
    compareFreshness: compareFreshness(state, compareSynced ? compareYear : null, ctx.nowMs),
    budgetsAvailable: state.budgetsAvailable,
    splitKeys:
      (state.balances.get(year)?.splitKeys ?? 0) +
      (compareSynced ? (state.balances.get(compareYear)?.splitKeys ?? 0) : 0) +
      (useBudgets ? state.budgetSplitKeys : 0),
  };
  if (status !== "ok") {
    const body: ProfitLossResponse = {
      ...base,
      status,
      compareMissing: !compareSynced,
      report: null,
      budgetScenario: null,
      budgetScenarios: [],
    };
    return json(body);
  }

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
      .bind(division.id, year, compareSynced ? compareYear : -1, periodTo),
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
  // Budgets read completely but none for the year: no budget column (null figures), not zeros.
  const scenario =
    !useBudgets || (wanted === null && scenarioList.length === 0)
      ? null
      : (wanted ?? scenarioList[0] ?? null);
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
    // a compare year never read completely gives null last-year figures, not zeros
    { year, periodTo, compareYear: compareSynced ? compareYear : null },
  );
  const body: ProfitLossResponse = {
    ...base,
    status: "ok",
    compareMissing: !compareSynced,
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
      .prepare(`${ACCOUNT_SQL} ORDER BY code IS NULL, code, name, id LIMIT ${MAX_ACCOUNT_ROWS + 1}`)
      .bind(division.id)
      .all<AccountSql>()
  ).results;
  const truncated = rows.length > MAX_ACCOUNT_ROWS;
  const accounts = rows.slice(0, MAX_ACCOUNT_ROWS).map(accountRow);
  const body: LedgerAccountsResponse = {
    division: toRef(division),
    status: state.accountsSynced ? "ok" : "not_synced",
    truncated,
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
