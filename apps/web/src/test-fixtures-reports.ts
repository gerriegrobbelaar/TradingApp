/** Fixtures for the reporting screens (K3b): ageing, balance sheet, profit and loss, accounts. */
import {
  AGEING_BUCKETS,
  addDays,
  buildAgeing,
  buildBalanceSheet,
  buildProfitAndLoss,
  type AgeingBucket,
  type AgeingReportResponse,
  type AgeingReportTotals,
  type BalanceSheetResponse,
  type LedgerAccount,
  type LedgerAccountBalancesResponse,
  type LedgerAccountRow,
  type LedgerAccountsResponse,
  type LedgerBalance,
  type LedgerBudget,
  type LedgerFreshness,
  type ProfitLossResponse,
} from "@camelthorn/core";
import { DIV_REF, FRESH } from "./test-fixtures";

/** Same filters as the worker's bucketQuery (apps/worker/src/read/routes.ts). */
export function bucketQuery(bucket: AgeingBucket | "total", asOf: string): Record<string, string> {
  switch (bucket) {
    case "total":
      return {};
    case "not_due":
      return { dueAfter: addDays(asOf, -1) };
    case "d1_30":
      return { dueAfter: addDays(asOf, -31), dueBefore: asOf };
    case "d31_60":
      return { dueAfter: addDays(asOf, -61), dueBefore: addDays(asOf, -30) };
    case "d61_90":
      return { dueAfter: addDays(asOf, -91), dueBefore: addDays(asOf, -60) };
    case "d90_plus":
      return { dueBefore: addDays(asOf, -90) };
    case "no_due_date":
      return { noDueDate: "1" };
  }
}

export interface AgeingFixtureItem {
  relationId: number | null;
  relationName: string | null;
  currency: string;
  openMinor: number;
  dueDate: string | null;
  dcMinor?: number | null;
}

const keyOf = (id: number | null): string => (id === null ? "" : `rel-${id}`);

/** An ageing response built with core's buildAgeing, like the worker does. */
export function ageingResponse(
  items: AgeingFixtureItem[],
  kind: "receivable" | "payable" = "receivable",
  over: Partial<AgeingReportResponse> = {},
  asOf = "2026-11-11",
): AgeingReportResponse {
  const path = kind === "receivable" ? "/api/invoices" : "/api/bills";
  const report = buildAgeing(
    items.map((i) => ({
      relationKey: keyOf(i.relationId),
      relationName: i.relationName,
      currency: i.currency,
      openMinor: i.openMinor,
      dueDate: i.dueDate,
      dcMinor: i.dcMinor === undefined ? (i.currency === "EUR" ? i.openMinor : null) : i.dcMinor,
    })),
    asOf,
  );
  const ids = new Map(items.map((i) => [keyOf(i.relationId), i.relationId]));
  const totalsDto = (t: (typeof report.totalsByCurrency)[number]): AgeingReportTotals => ({
    currency: t.currency,
    buckets: t.buckets,
    bucketCounts: t.bucketCounts,
    totalMinor: t.totalMinor,
    count: t.count,
    dcMinor: t.dc.minor,
    dcComplete: t.dc.complete,
    drilldown: Object.fromEntries(
      [...AGEING_BUCKETS, "total" as const].map((b) => [
        b,
        { path, query: { status: "open", currency: t.currency, ...bucketQuery(b, asOf) } },
      ]),
    ) as unknown as AgeingReportTotals["drilldown"],
  });
  return {
    division: DIV_REF,
    kind,
    asOf,
    currencies: report.currencies.map((c) => ({
      currency: c.currency,
      totals: totalsDto(c.totals),
      rows: c.rows.map((row) => ({
        relation: { id: ids.get(row.relationKey) ?? null, name: row.relationName },
        buckets: row.buckets,
        bucketCounts: row.bucketCounts,
        totalMinor: row.totalMinor,
        count: row.count,
        dcMinor: row.dc.minor,
        dcComplete: row.dc.complete,
      })),
    })),
    totalsByCurrency: report.totalsByCurrency.map(totalsDto),
    freshness: { ...FRESH, basis: [kind === "receivable" ? "receivables" : "payables"] },
    ...over,
  };
}

const entry = (minutesAgo: number, hours = 36) => ({
  lastCompletedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  stale: false,
  staleAfterHours: hours,
});
export const LEDGER_FRESH: LedgerFreshness = {
  gl_accounts: entry(20),
  gl_balances: entry(20),
  gl_budgets: entry(3 * 1440, 192),
};
export const LEDGER_NEVER: LedgerFreshness = {
  gl_accounts: { lastCompletedAt: null, stale: true, staleAfterHours: 36 },
  gl_balances: { lastCompletedAt: null, stale: true, staleAfterHours: 36 },
  gl_budgets: { lastCompletedAt: null, stale: true, staleAfterHours: 192 },
};

const acct = (
  exactId: string,
  code: string,
  name: string,
  type: number | null,
  typeDescription: string,
  balanceSide: "D" | "C",
  balanceType: "B" | "W",
): LedgerAccount => ({
  exactId,
  code,
  name,
  type,
  typeDescription,
  balanceSide,
  balanceType,
  isActive: true,
});

/** A small chart of accounts. */
export const CHART: LedgerAccount[] = [
  acct("a-bank", "1100", "Bank ING", 12, "Bank", "D", "B"),
  acct("a-debt", "1300", "Debtors", 20, "Accounts receivable", "D", "B"),
  acct("a-cred", "1600", "Creditors", 22, "Accounts payable", "C", "B"),
  acct("a-cap", "0500", "Share capital", null, "Equity capital", "C", "B"),
  acct("a-ret", "0600", "Retained earnings", null, "Retained earnings", "C", "B"),
  acct("a-rev", "8000", "Consulting revenue", null, "Revenue", "C", "W"),
  acct("a-rent", "4100", "Rent", null, "Costs", "D", "W"),
];

const bal = (
  id: string,
  year: number,
  period: number,
  amountMinor: number,
  balanceType: "B" | "W",
): LedgerBalance => ({ glAccountExactId: id, year, period, amountMinor, balanceType });

/** Balanced two-year ledger (debit - credit); period 0 holds the opening balance. EUR. */
export const LEDGER: LedgerBalance[] = [
  bal("a-bank", 2025, 0, 1_000_000, "B"),
  bal("a-cap", 2025, 0, -1_000_000, "B"),
  bal("a-bank", 2025, 1, 500_000, "B"),
  bal("a-rev", 2025, 1, -600_000, "W"),
  bal("a-rent", 2025, 1, 100_000, "W"),
  bal("a-bank", 2026, 0, 1_400_000, "B"),
  bal("a-cap", 2026, 0, -1_000_000, "B"),
  bal("a-ret", 2026, 0, -400_000, "B"),
  bal("a-debt", 2026, 0, 100_000, "B"),
  bal("a-cred", 2026, 0, -100_000, "B"),
  bal("a-bank", 2026, 1, 800_000, "B"),
  bal("a-rev", 2026, 1, -900_000, "W"),
  bal("a-rent", 2026, 1, 100_000, "W"),
  bal("a-bank", 2026, 2, 200_000, "B"),
  bal("a-rev", 2026, 2, -250_000, "W"),
  bal("a-rent", 2026, 2, 50_000, "W"),
];
export const BUDGETS: LedgerBudget[] = [
  { glAccountExactId: "a-rev", year: 2026, period: 1, amountMinor: -800_000 },
  { glAccountExactId: "a-rev", year: 2026, period: 2, amountMinor: -300_000 },
  { glAccountExactId: "a-rent", year: 2026, period: 1, amountMinor: 100_000 },
  { glAccountExactId: "a-rent", year: 2026, period: 2, amountMinor: 100_000 },
];

/** Highest period 1 and up of a year in the given rows, as the API reports it. */
export function latestPeriod(balances: LedgerBalance[], year: number): number | null {
  const ps = balances.filter((b) => b.year === year && b.period >= 1).map((b) => b.period);
  return ps.length === 0 ? null : Math.max(...ps);
}

export function balanceSheetResponse(
  over: Partial<BalanceSheetResponse> = {},
  opts: {
    year?: number;
    period?: number;
    accounts?: LedgerAccount[];
    balances?: LedgerBalance[];
    compareToYearEnd?: boolean;
  } = {},
): BalanceSheetResponse {
  const year = opts.year ?? 2026;
  const period = opts.period ?? 2;
  return {
    division: DIV_REF,
    status: "ok",
    year,
    period,
    latestPeriodWithData: latestPeriod(opts.balances ?? LEDGER, year),
    compareYear: year - 1,
    compareMissing: false,
    report: buildBalanceSheet(opts.accounts ?? CHART, opts.balances ?? LEDGER, {
      year,
      period,
      compareYear: year - 1,
      compareToYearEnd: opts.compareToYearEnd ?? true,
    }),
    freshness: LEDGER_FRESH,
    compareFreshness: LEDGER_FRESH.gl_balances,
    budgetsAvailable: true,
    splitKeys: 0,
    ...over,
  };
}

export function profitLossResponse(
  over: Partial<ProfitLossResponse> = {},
  opts: { budgets?: LedgerBudget[] | null; compareYear?: number | null; periodTo?: number } = {},
): ProfitLossResponse {
  const periodTo = opts.periodTo ?? 2;
  const budgets = opts.budgets === undefined ? BUDGETS : opts.budgets;
  const compareYear = opts.compareYear === undefined ? 2025 : opts.compareYear;
  return {
    division: DIV_REF,
    status: "ok",
    year: 2026,
    periodTo,
    latestPeriodWithData: latestPeriod(LEDGER, 2026),
    compareYear: compareYear ?? 2025,
    compareMissing: compareYear === null,
    report: buildProfitAndLoss(CHART, LEDGER, budgets, { year: 2026, periodTo, compareYear }),
    budgetScenario: budgets === null ? null : "",
    budgetScenarios: budgets === null ? [] : [""],
    freshness: LEDGER_FRESH,
    compareFreshness: LEDGER_FRESH.gl_balances,
    budgetsAvailable: budgets !== null,
    splitKeys: 0,
    ...over,
  };
}

export function chartResponse(): LedgerAccountsResponse {
  return {
    division: DIV_REF,
    status: "ok",
    truncated: false,
    accounts: CHART.map((a, i) => ({
      id: 100 + i,
      exactId: a.exactId,
      code: a.code,
      name: a.name,
      type: a.type,
      typeDescription: a.typeDescription,
      balanceSide: a.balanceSide,
      balanceType: a.balanceType,
      isBlocked: false,
      isActive: true,
      statement: a.balanceType === "W" ? "profit_loss" : "balance_sheet",
      section: a.balanceType === "W" ? (a.balanceSide === "C" ? "revenue" : "costs") : "assets",
    })),
    unclassifiedCount: 0,
    freshness: LEDGER_FRESH,
  };
}

export function accountBalancesResponse(
  accountId: number,
  year = 2026,
): LedgerAccountBalancesResponse {
  const account = chartResponse().accounts.find((a) => a.id === accountId) as LedgerAccountRow;
  const periods = LEDGER.filter((b) => b.glAccountExactId === account.exactId && b.year === year)
    .sort((a, b) => a.period - b.period)
    .map((b) => ({
      period: b.period,
      amountMinor: b.amountMinor,
      debitMinor: b.amountMinor > 0 ? b.amountMinor : 0,
      creditMinor: b.amountMinor < 0 ? -b.amountMinor : 0,
      rows: 1,
    }));
  return {
    division: DIV_REF,
    status: "ok",
    year,
    account,
    periods,
    totalMinor: periods.reduce((s, p) => s + p.amountMinor, 0),
    freshness: LEDGER_FRESH,
  };
}
