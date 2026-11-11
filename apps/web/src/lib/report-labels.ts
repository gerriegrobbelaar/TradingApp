/**
 * Labels and notes of the balance sheet and profit and loss, shared by the screen (and so the
 * print view) and the Excel file, so the three outputs never word a column or a warning
 * differently (review K3b). Pure: no DOM.
 */
import type { BalanceSheetResponse, ProfitLossResponse } from "@camelthorn/core";
import { formatMoney } from "./format";

/** "2026, up to period 10": the balance at the end of that period. */
export const upToPeriod = (year: number, period: number): string =>
  `${year}, up to period ${period}`;

/** Column heads of the balance sheet: the period and, when there is one, the comparison. */
export function balanceSheetHeads(r: BalanceSheetResponse): {
  current: string;
  compare: string | null;
} {
  const rep = r.report;
  const current = upToPeriod(r.year, r.period);
  if (!rep || rep.compareYear === null) return { current, compare: null };
  return {
    current,
    compare:
      rep.compareBasis === "year_end"
        ? `Year end ${rep.compareYear} (all periods)`
        : upToPeriod(rep.compareYear, r.period),
  };
}

export const BS_RESULT_LABEL = "Result for the year to date";
export const BS_DIFFERENCE_LABEL = "Difference (should be 0)";

export type NoteTone = "alert" | "warn" | "info";
export interface ReportNote {
  tone: NoteTone;
  text: string;
}

const splitNote = (n: number): ReportNote => ({
  tone: "warn",
  text: `${n} ${n === 1 ? "figure was" : "figures were"} split by Exact over a field this app does not read, so some amounts may be too low.`,
});

/** Checks of a balance sheet, most serious first. Empty for a clean report. */
export function balanceSheetNotes(r: BalanceSheetResponse): ReportNote[] {
  const rep = r.report;
  const out: ReportNote[] = [];
  if (!rep) return out;
  const cur = r.division.currency;
  const dc = rep.difference.current;
  const dp = rep.difference.compare;
  if (dc !== 0 || (dp !== null && dp !== 0)) {
    const parts: string[] = [];
    if (dc !== 0) parts.push(`${formatMoney(dc, cur)} in ${upToPeriod(r.year, r.period)}`);
    if (dp !== null && dp !== 0) parts.push(`${formatMoney(dp, cur)} in the comparison column`);
    out.push({
      tone: "alert",
      text: `Does not balance: difference ${parts.join(" and ")}. Check opening balances.`,
    });
  }
  if (!rep.hasOpeningBalances.current) {
    out.push({
      tone: "warn",
      text: `No opening balances (period 0) are in Exact for ${r.year}. Balance sheet lines may show this year's movements only.`,
    });
  }
  if (rep.hasOpeningBalances.compare === false) {
    out.push({
      tone: "warn",
      text: `No opening balances (period 0) are in Exact for ${rep.compareYear}, so the comparison column may be incomplete.`,
    });
  }
  if (r.compareMissing) {
    out.push({
      tone: "warn",
      text: `The balances of ${r.compareYear ?? r.year - 1} have not been read from Exact yet, so there is no comparison column.`,
    });
  }
  if (r.splitKeys > 0) out.push(splitNote(r.splitKeys));
  return out;
}

export const BUDGET_UNAVAILABLE = "Budget is not available in Exact for this administration.";

/** Notes of a profit and loss report (budget, last year, split figures). */
export function profitLossNotes(r: ProfitLossResponse): ReportNote[] {
  const rep = r.report;
  const out: ReportNote[] = [];
  if (!rep) return out;
  if (!rep.budgetsIncluded) {
    out.push({
      tone: "info",
      text: r.budgetsAvailable
        ? `No budget has been entered in Exact for ${r.year}.`
        : BUDGET_UNAVAILABLE,
    });
  } else if (r.budgetScenarios.length > 1) {
    out.push({
      tone: "info",
      text: `Exact holds ${r.budgetScenarios.length} budget scenarios for ${r.year}; this report uses the first one.`,
    });
  }
  if (r.compareMissing) {
    out.push({
      tone: "warn",
      text: `The balances of ${r.compareYear} have not been read from Exact yet, so the last-year figures are not available.`,
    });
  }
  if (r.splitKeys > 0) out.push(splitNote(r.splitKeys));
  return out;
}

export const PL_SIGN_NOTE =
  "Revenue is positive and costs are negative; a positive variance is good for the result.";

/** Profit and loss column heads after "Account", in order. */
export function profitLossHeads(r: ProfitLossResponse): string[] {
  const withBudget = r.report?.budgetsIncluded ?? false;
  return [
    "Actual",
    ...(withBudget ? ["Budget", "Variance to budget", "Variance to budget %"] : []),
    `Last year (${r.compareYear})`,
    "Variance to last year",
    "Variance to last year %",
  ];
}

/** "2026, periods 1 to 10 (year to date)". */
export const ytdLine = (year: number, periodTo: number): string =>
  `${year}, periods 1 to ${periodTo} (year to date)`;

/**
 * A short line when the shown period is not the latest one with figures, so a reader knows
 * whether a later period exists (or the shown one is past the last booking). Null otherwise.
 */
export function latestPeriodNote(
  shown: number,
  latest: number | null,
  status: "ok" | "not_synced" | "no_data",
): string | null {
  if (status !== "ok" || latest === null || latest === shown) return null;
  return latest > shown
    ? `Exact has figures up to period ${latest}.`
    : `Exact has no figures after period ${latest}.`;
}
