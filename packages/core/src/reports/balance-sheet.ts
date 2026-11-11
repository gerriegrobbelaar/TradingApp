/**
 * Balance sheet builder (pure, deterministic, no I/O). ADR 0024 has the assumptions.
 *
 * Inputs are the stored chart, reporting balances (signed debit - credit, division currency) and
 * the options. Output sections are Assets, Liabilities, Equity and Unclassified; the profit or loss
 * of the reporting year so far is its own line on the liabilities and equity side.
 *
 * Display signs: assets are shown as debit - credit, liabilities and equity as credit - debit (a
 * normal balance is positive), unclassified accounts as debit - credit, and the result as
 * credit - debit of the profit and loss accounts (a profit is positive).
 *
 * Check line: `difference = assets - (liabilities + equity + result) + unclassified`, which equals
 * the sum of every account's signed balance. A complete ledger gives 0. It is surfaced, never
 * hidden or "fixed": a non-zero value means missing data (an opening balance, a period not yet
 * synced, a wrong semantics assumption) and the UI must show it.
 *
 * Comparison: with `compareYear` set, the second column is that year at its YEAR END (all periods,
 * including the extra closing periods) when `compareToYearEnd` is true, else at the same period.
 * Each year's own profit and loss accounts make that column's result line, so both columns balance
 * on their own.
 */
import { classifyBalanceSheetAccount, type BalanceSheetSection } from "./classify";
import {
  LAST_PERIOD,
  LEDGER_BALANCE_SEMANTICS,
  compareRefs,
  resolveAccounts,
  signedByAccount,
  toSafe,
  type BalanceSemantics,
  type LedgerAccount,
  type LedgerBalance,
  type ReportAccountRef,
  type ResolvedAccount,
} from "./ledger";

export interface BalanceSheetOptions {
  year: number;
  /** Last period included (the balance sheet is cumulative up to it). */
  period: number;
  /** Year to compare with, or null/undefined for no comparison. */
  compareYear?: number | null;
  /** Compare with the end of `compareYear` (default true); false = the same period of that year. */
  compareToYearEnd?: boolean;
  semantics?: BalanceSemantics;
}

/** A figure for the reporting year and, when a comparison was asked for, for the other year. */
export interface Pair {
  current: number;
  compare: number | null;
}

export interface BalanceSheetLine extends ReportAccountRef, Pair {}

export interface BalanceSheetSectionResult {
  section: BalanceSheetSection;
  lines: BalanceSheetLine[];
  total: Pair;
}

export interface BalanceSheet {
  year: number;
  period: number;
  compareYear: number | null;
  compareBasis: "year_end" | "same_period" | null;
  sections: Record<BalanceSheetSection, BalanceSheetSectionResult>;
  /** Profit (positive) or loss of the reporting year up to `period`. */
  result: Pair;
  /** Liabilities + equity + result. */
  liabilitiesAndEquity: Pair;
  /** Assets - (liabilities + equity + result) + unclassified. 0 for a complete ledger. */
  difference: Pair;
}

export const BALANCE_SHEET_SECTIONS: readonly BalanceSheetSection[] = [
  "assets",
  "liabilities",
  "equity",
  "unclassified",
];

interface Column {
  /** Display value per balance sheet account. */
  lines: Map<string, bigint>;
  /** Signed total of the profit and loss accounts (debit - credit). */
  plSigned: bigint;
}

function column(
  resolved: Map<string, ResolvedAccount>,
  balances: readonly LedgerBalance[],
  year: number,
  lastPeriod: number,
  semantics: BalanceSemantics,
): Column {
  const bs = signedByAccount(balances, year, { from: 0, to: lastPeriod }, semantics);
  const pl = signedByAccount(balances, year, { from: 1, to: lastPeriod }, semantics);
  const lines = new Map<string, bigint>();
  let plSigned = 0n;
  for (const a of resolved.values()) {
    if (a.balanceType === "W") plSigned += pl.get(a.accountId) ?? 0n;
    else lines.set(a.accountId, bs.get(a.accountId) ?? 0n);
  }
  return { lines, plSigned };
}

export function buildBalanceSheet(
  accounts: readonly LedgerAccount[],
  balances: readonly LedgerBalance[],
  opts: BalanceSheetOptions,
): BalanceSheet {
  const semantics = opts.semantics ?? LEDGER_BALANCE_SEMANTICS;
  const compareYear = opts.compareYear ?? null;
  const yearEnd = opts.compareToYearEnd ?? true;
  const resolved = resolveAccounts(accounts, balances);

  const cur = column(resolved, balances, opts.year, opts.period, semantics);
  const cmp =
    compareYear === null
      ? null
      : column(resolved, balances, compareYear, yearEnd ? LAST_PERIOD : opts.period, semantics);

  const sectionOf = (a: ResolvedAccount): BalanceSheetSection => classifyBalanceSheetAccount(a);
  /** Display sign: debit - credit for assets and unclassified, credit - debit otherwise. */
  const flip = (s: BalanceSheetSection): 1n | -1n =>
    s === "liabilities" || s === "equity" ? -1n : 1n;

  const lines: Record<BalanceSheetSection, BalanceSheetLine[]> = {
    assets: [],
    liabilities: [],
    equity: [],
    unclassified: [],
  };
  const totals: Record<BalanceSheetSection, { cur: bigint; cmp: bigint }> = {
    assets: { cur: 0n, cmp: 0n },
    liabilities: { cur: 0n, cmp: 0n },
    equity: { cur: 0n, cmp: 0n },
    unclassified: { cur: 0n, cmp: 0n },
  };
  for (const a of resolved.values()) {
    if (a.balanceType === "W") continue;
    const section = sectionOf(a);
    const sign = flip(section);
    const c = (cur.lines.get(a.accountId) ?? 0n) * sign;
    const k = (cmp?.lines.get(a.accountId) ?? 0n) * sign;
    totals[section].cur += c;
    totals[section].cmp += k;
    if (c === 0n && k === 0n) continue; // nothing to show; totals are unaffected
    lines[section].push({
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      current: toSafe(c),
      compare: cmp === null ? null : toSafe(k),
    });
  }

  const pair = (c: bigint, k: bigint): Pair => ({
    current: toSafe(c),
    compare: cmp === null ? null : toSafe(k),
  });
  const sections = {} as Record<BalanceSheetSection, BalanceSheetSectionResult>;
  for (const s of BALANCE_SHEET_SECTIONS) {
    sections[s] = {
      section: s,
      lines: lines[s].sort(compareRefs),
      total: pair(totals[s].cur, totals[s].cmp),
    };
  }
  const resultCur = -cur.plSigned;
  const resultCmp = cmp === null ? 0n : -cmp.plSigned;
  const leCur = totals.liabilities.cur + totals.equity.cur + resultCur;
  const leCmp = totals.liabilities.cmp + totals.equity.cmp + resultCmp;
  return {
    year: opts.year,
    period: opts.period,
    compareYear,
    compareBasis: compareYear === null ? null : yearEnd ? "year_end" : "same_period",
    sections,
    result: pair(resultCur, resultCmp),
    liabilitiesAndEquity: pair(leCur, leCmp),
    difference: pair(
      totals.assets.cur - leCur + totals.unclassified.cur,
      totals.assets.cmp - leCmp + totals.unclassified.cmp,
    ),
  };
}
