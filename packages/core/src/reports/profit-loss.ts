/**
 * Profit and loss builder (pure, deterministic, no I/O). ADR 0024 has the assumptions.
 *
 * Year to date (periods 1..periodTo) actual, budget and last year's same periods.
 *
 * SIGN CONVENTION (chosen and tested): every figure is credit - debit of the ledger, so revenue is
 * POSITIVE and costs are NEGATIVE, and the result is simply the sum of the lines: a profit is
 * positive. Section totals and the result are sums of the lines shown, in every column. A variance
 * is `actual - comparison` on these signed figures, so a positive variance is always good for the
 * result (more revenue, or a smaller cost) and a negative one bad.
 *
 * Variance percentages are integer basis points (1 % = 100) of the absolute comparison figure,
 * rounded half away from zero; null when the comparison is 0 or not available.
 *
 * Budgets are assumed to use the same sign convention as the ledger (debit - credit); when Exact
 * turns out to store them as natural amounts, flip `BUDGET_SIGN` (verify with credentials).
 * `budgets: null` means budgets are not available: every budget figure is then null, not 0.
 *
 * Classification: accounts with BalanceType 'W' only, by BalanceSide (credit side = revenue, debit
 * side = costs). An account without a side is "unclassified" and still counted in the result.
 */
import { classifyProfitLossAccount, type ProfitLossSection } from "./classify";
import {
  LEDGER_BALANCE_SEMANTICS,
  compareRefs,
  resolveAccounts,
  signedByAccount,
  toSafe,
  varianceBps,
  type BalanceSemantics,
  type LedgerAccount,
  type LedgerBalance,
  type LedgerBudget,
  type ReportAccountRef,
  type ResolvedAccount,
} from "./ledger";

/** Budgets use debit - credit like the ledger (assumption, ADR 0024). */
export const BUDGET_SIGN: 1n | -1n = 1n;

export interface ProfitLossOptions {
  year: number;
  /** Last period of the year to date (1..). */
  periodTo: number;
  /**
   * Year for the last-year column; default year - 1. `null` = that year is not available (never
   * synced): every last-year figure is then null, not 0, exactly like missing budgets.
   */
  compareYear?: number | null;
  semantics?: BalanceSemantics;
}

export interface Variance {
  /** actual - comparison; null when there is no comparison. */
  minor: number | null;
  /** Basis points of |comparison|; null when the comparison is 0 or missing. */
  bps: number | null;
}

export interface ProfitLossFigures {
  actual: number;
  budget: number | null;
  /** Null when the compare year is not available. */
  lastYear: number | null;
  vsBudget: Variance;
  vsLastYear: Variance;
}

export interface ProfitLossLine extends ReportAccountRef, ProfitLossFigures {}

export interface ProfitLossSectionResult {
  section: ProfitLossSection;
  lines: ProfitLossLine[];
  total: ProfitLossFigures;
}

export interface ProfitLoss {
  year: number;
  periodTo: number;
  /** Null when the last-year column is not available. */
  compareYear: number | null;
  budgetsIncluded: boolean;
  sections: Record<ProfitLossSection, ProfitLossSectionResult>;
  /** Revenue + costs + unclassified (a profit is positive). */
  result: ProfitLossFigures;
}

export const PROFIT_LOSS_SECTIONS: readonly ProfitLossSection[] = [
  "revenue",
  "costs",
  "unclassified",
];

interface Acc {
  actual: bigint;
  budget: bigint;
  lastYear: bigint;
}
const zero = (): Acc => ({ actual: 0n, budget: 0n, lastYear: 0n });

function figures(a: Acc, withBudget: boolean, withLastYear: boolean): ProfitLossFigures {
  const actual = toSafe(a.actual);
  const lastYear = withLastYear ? toSafe(a.lastYear) : null;
  const budget = withBudget ? toSafe(a.budget) : null;
  return {
    actual,
    budget,
    lastYear,
    vsBudget:
      budget === null
        ? { minor: null, bps: null }
        : {
            minor: toSafe(a.actual - a.budget),
            bps: varianceBps(toSafe(a.actual - a.budget), budget),
          },
    vsLastYear:
      lastYear === null
        ? { minor: null, bps: null }
        : {
            minor: toSafe(a.actual - a.lastYear),
            bps: varianceBps(toSafe(a.actual - a.lastYear), lastYear),
          },
  };
}

export function buildProfitAndLoss(
  accounts: readonly LedgerAccount[],
  balances: readonly LedgerBalance[],
  budgets: readonly LedgerBudget[] | null,
  opts: ProfitLossOptions,
): ProfitLoss {
  const semantics = opts.semantics ?? LEDGER_BALANCE_SEMANTICS;
  const compareYear = opts.compareYear === undefined ? opts.year - 1 : opts.compareYear;
  const withLastYear = compareYear !== null;
  const range = { from: 1, to: opts.periodTo };
  // Budgets exist for profit and loss accounts only, so a budget row is evidence of 'W' for an
  // account the chart does not know (balance rows, listed first, still win).
  const resolved = resolveAccounts(accounts, [
    ...balances,
    ...(budgets ?? []).map((b) => ({
      glAccountExactId: b.glAccountExactId,
      balanceType: "W" as const,
    })),
  ]);

  const actual = signedByAccount(balances, opts.year, range, semantics);
  const last =
    compareYear === null
      ? new Map<string, bigint>()
      : signedByAccount(balances, compareYear, range, semantics);
  // Budgets are per-period amounts whatever the ledger semantics: always added up.
  const budget = signedByAccount(
    (budgets ?? []).map((b) => ({ ...b, balanceType: null })),
    opts.year,
    range,
    "movement",
  );

  const sectionOf = (a: ResolvedAccount): ProfitLossSection => classifyProfitLossAccount(a);
  const lines: Record<ProfitLossSection, ProfitLossLine[]> = {
    revenue: [],
    costs: [],
    unclassified: [],
  };
  const totals: Record<ProfitLossSection, Acc> = {
    revenue: zero(),
    costs: zero(),
    unclassified: zero(),
  };
  const withBudget = budgets !== null;
  for (const a of resolved.values()) {
    if (a.balanceType !== "W") continue;
    // credit - debit: the ledger value negated; budgets negated after their own sign convention.
    const acc: Acc = {
      actual: -(actual.get(a.accountId) ?? 0n),
      budget: -(budget.get(a.accountId) ?? 0n) * BUDGET_SIGN,
      lastYear: -(last.get(a.accountId) ?? 0n),
    };
    const section = sectionOf(a);
    const t = totals[section];
    t.actual += acc.actual;
    t.budget += acc.budget;
    t.lastYear += acc.lastYear;
    if (acc.actual === 0n && acc.lastYear === 0n && (!withBudget || acc.budget === 0n)) continue;
    lines[section].push({
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      ...figures(acc, withBudget, withLastYear),
    });
  }
  const sections = {} as Record<ProfitLossSection, ProfitLossSectionResult>;
  const grand = zero();
  for (const s of PROFIT_LOSS_SECTIONS) {
    sections[s] = {
      section: s,
      lines: lines[s].sort(compareRefs),
      total: figures(totals[s], withBudget, withLastYear),
    };
    grand.actual += totals[s].actual;
    grand.budget += totals[s].budget;
    grand.lastYear += totals[s].lastYear;
  }
  return {
    year: opts.year,
    periodTo: opts.periodTo,
    compareYear,
    budgetsIncluded: withBudget,
    sections,
    result: figures(grand, withBudget, withLastYear),
  };
}
