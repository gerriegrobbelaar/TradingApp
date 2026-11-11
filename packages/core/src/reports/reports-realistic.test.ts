/**
 * Review K2: a hand-built, realistic chart and two years of ledger, including opening balances
 * (period 0), a closing period (13), an unclassifiable contra account and accounts whose side
 * contradicts their type. Every figure below is computed by hand in the comments. The same ledger
 * is also fed in "cumulative" form (each row the balance at the end of its period) and must give
 * the same reports, so both semantic modes reconcile.
 */
import { describe, expect, it } from "vitest";
import {
  BALANCE_SHEET_SECTIONS,
  buildBalanceSheet,
  buildProfitAndLoss,
  type BalanceSemantics,
  type LedgerAccount,
  type LedgerBalance,
  type LedgerBudget,
} from "./index";

const id = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const acc = (n: number, code: string, name: string, o: Partial<LedgerAccount>): LedgerAccount => ({
  exactId: id(n),
  code,
  name,
  type: null,
  typeDescription: null,
  balanceSide: null,
  balanceType: "B",
  isActive: true,
  ...o,
});

// Balance sheet accounts
const BANK = acc(1, "1100", "ING current account", { type: 12, balanceSide: "D" });
const DEBTORS = acc(2, "1300", "Debtors", { type: 20, balanceSide: "D" });
const FIXED = acc(3, "0200", "Equipment", { typeDescription: "Fixed assets", balanceSide: "D" });
// contra asset: credit balance, no keyword -> unclassified (shown on its own, debit - credit)
const DEPR = acc(4, "0210", "Accumulated depreciation", {
  typeDescription: "Accumulated depreciation",
  balanceSide: "C",
});
const CREDITORS = acc(5, "1600", "Creditors", { type: 22, balanceSide: "C" });
const VAT = acc(6, "1500", "VAT payable", { typeDescription: "VAT", balanceSide: "C" });
const CAPITAL = acc(7, "0500", "Share capital", { typeDescription: "Capital", balanceSide: "C" });
const RETAINED = acc(8, "0600", "Retained earnings", {
  typeDescription: "Retained earnings",
  balanceSide: "C",
});
// a bank-coded account that Exact says is credit side: contradiction -> unclassified
const OVERDRAFT = acc(9, "1110", "Credit card", { type: 12, balanceSide: "C" });
// Profit and loss accounts
const REVENUE = acc(20, "8000", "Consulting revenue", { balanceType: "W", balanceSide: "C" });
const COGS = acc(21, "7000", "Subcontractors", { balanceType: "W", balanceSide: "D" });
const SALARIES = acc(22, "4000", "Salaries", { balanceType: "W", balanceSide: "D" });
const DEPREXP = acc(23, "4800", "Depreciation", { balanceType: "W", balanceSide: "D" });
const INTEREST = acc(24, "8900", "Interest income", { balanceType: "W", balanceSide: "C" });
const CHART = [
  BANK,
  DEBTORS,
  FIXED,
  DEPR,
  CREDITORS,
  VAT,
  CAPITAL,
  RETAINED,
  OVERDRAFT,
  REVENUE,
  COGS,
  SALARIES,
  DEPREXP,
  INTEREST,
];

type Entry = [account: number, amountMinor: number];
const post = (year: number, period: number, ...lines: Entry[]): LedgerBalance[] => {
  const sum = lines.reduce((t, [, a]) => t + a, 0);
  if (sum !== 0) throw new Error(`unbalanced journal ${year}/${period}: ${sum}`);
  return lines.map(([n, a]) => ({
    glAccountExactId: id(n),
    year,
    period,
    amountMinor: a,
    balanceType: n >= 20 ? "W" : "B",
  }));
};

/**
 * Movements, debit - credit, cents. Each journal balances.
 * 2025
 *   p0  capital paid in: bank 10,000.00 / capital 10,000.00; equipment bought 3,000.00 from bank
 *   p3  invoice 12,100.00 incl. VAT: debtors 12,100 / revenue 10,000 / VAT 2,100
 *   p5  subcontractor bill 2,000.00: COGS 2,000 / creditors 2,000
 *   p6  salaries 4,000.00 from bank; debtor pays 12,100.00 into bank
 *   p12 depreciation 600.00; interest 50.00 received
 *   p13 (closing) VAT paid 2,100.00 from bank
 * 2025 result: 10,000 + 50 - 2,000 - 4,000 - 600 = 3,450.00 profit
 * 2026
 *   p0  opening: bank 13,050, equipment 3,000, depr -600, creditors -2,000, capital -10,000,
 *       retained -3,450 (last year's profit carried forward)  -> sums to 0
 *   p1  invoice 6,050 incl VAT: debtors 6,050 / revenue 5,000 / VAT 1,050; pay creditors 2,000
 *   p2  salaries 4,500 from bank; credit card spend 300 on subcontractors (card is credit side)
 *   p3  revenue 1,000 cash (later than the period asked for in most tests)
 */
const LEDGER: LedgerBalance[] = [
  ...post(2025, 0, [1, 1_000_000], [7, -1_000_000]),
  ...post(2025, 0, [3, 300_000], [1, -300_000]),
  ...post(2025, 3, [2, 1_210_000], [20, -1_000_000], [6, -210_000]),
  ...post(2025, 5, [21, 200_000], [5, -200_000]),
  ...post(2025, 6, [22, 400_000], [1, -400_000]),
  ...post(2025, 6, [1, 1_210_000], [2, -1_210_000]),
  ...post(2025, 12, [23, 60_000], [4, -60_000]),
  ...post(2025, 12, [1, 5_000], [24, -5_000]),
  ...post(2025, 13, [6, 210_000], [1, -210_000]),
  ...post(
    2026,
    0,
    [1, 1_305_000],
    [3, 300_000],
    [4, -60_000],
    [5, -200_000],
    [7, -1_000_000],
    [8, -345_000],
  ),
  ...post(2026, 1, [2, 605_000], [20, -500_000], [6, -105_000]),
  ...post(2026, 1, [5, 200_000], [1, -200_000]),
  ...post(2026, 2, [22, 450_000], [1, -450_000]),
  ...post(2026, 2, [21, 30_000], [9, -30_000]),
  ...post(2026, 3, [1, 100_000], [20, -100_000]),
];

/**
 * The same ledger as "cumulative" rows: each account gets a row for every period from its first
 * movement to 13 holding its balance at the end of that period (balance sheet: from period 0,
 * profit and loss: year to date from period 1).
 */
function toCumulative(rows: readonly LedgerBalance[]): LedgerBalance[] {
  const out: LedgerBalance[] = [];
  const keys = new Set(rows.map((r) => `${r.glAccountExactId}|${r.year}|${r.balanceType}`));
  for (const k of keys) {
    const [acct, y, bt] = k.split("|") as [string, string, "B" | "W"];
    const year = Number(y);
    const mine = rows.filter((r) => r.glAccountExactId === acct && r.year === year);
    const first = Math.min(...mine.map((r) => r.period));
    let run = 0;
    for (let p = 0; p <= 13; p++) {
      run += mine.filter((r) => r.period === p).reduce((t, r) => t + r.amountMinor, 0);
      if (p >= first) {
        out.push({ glAccountExactId: acct, year, period: p, amountMinor: run, balanceType: bt });
      }
    }
  }
  return out;
}

const MODES: { semantics: BalanceSemantics; rows: LedgerBalance[] }[] = [
  { semantics: "movement", rows: LEDGER },
  { semantics: "cumulative", rows: toCumulative(LEDGER) },
];

describe.each(MODES)("a realistic ledger read as $semantics", ({ semantics, rows }) => {
  it("reconciles 2026 period 2 against the 2025 year end, closing period included", () => {
    const bs = buildBalanceSheet(CHART, rows, {
      year: 2026,
      period: 2,
      compareYear: 2025,
      compareToYearEnd: true,
      semantics,
    });
    const s = bs.sections;
    // assets 2026 p2: bank 13,050 - 2,000 - 4,500 = 6,550; debtors 6,050; equipment 3,000.
    // 2025 year end: bank 10,000 - 3,000 - 4,000 + 12,100 + 50 - 2,100 = 13,050
    expect(s.assets.lines.map((l) => [l.code, l.current, l.compare])).toEqual([
      ["0200", 300_000, 300_000],
      ["1100", 655_000, 1_305_000],
      ["1300", 605_000, 0],
    ]);
    expect(s.assets.total).toEqual({ current: 1_560_000, compare: 1_605_000 });
    // unclassified (debit - credit): depreciation -600 both years; credit card -300 this year
    expect(s.unclassified.lines.map((l) => [l.code, l.current, l.compare])).toEqual([
      ["0210", -60_000, -60_000],
      ["1110", -30_000, 0],
    ]);
    expect(s.unclassified.total).toEqual({ current: -90_000, compare: -60_000 });
    // liabilities (credit - debit): creditors 0 now, 2,000 at year end; VAT 1,050 now, 0 at year
    // end (paid in closing period 13, which the year-end column includes)
    expect(s.liabilities.lines.map((l) => [l.code, l.current, l.compare])).toEqual([
      ["1500", 105_000, 0],
      ["1600", 0, 200_000],
    ]);
    expect(s.liabilities.total).toEqual({ current: 105_000, compare: 200_000 });
    // equity: capital 10,000; retained 3,450 only from the 2026 opening
    expect(s.equity.total).toEqual({ current: 1_345_000, compare: 1_000_000 });
    // result: 2026 to p2 = 5,000 - 300 - 4,500 = 200; 2025 whole year 3,450
    expect(bs.result).toEqual({ current: 20_000, compare: 345_000 });
    // assets + unclassified = liabilities + equity + result, in both columns
    expect(bs.liabilitiesAndEquity).toEqual({ current: 1_470_000, compare: 1_545_000 });
    expect(s.assets.total.current + s.unclassified.total.current).toBe(1_470_000);
    expect((s.assets.total.compare ?? 0) + (s.unclassified.total.compare ?? 0)).toBe(1_545_000);
    expect(bs.difference).toEqual({ current: 0, compare: 0 });
    expect(bs.hasOpeningBalances).toEqual({ current: true, compare: true });
    for (const k of BALANCE_SHEET_SECTIONS) {
      expect(s[k].lines.reduce((t, l) => t + l.current, 0)).toBe(s[k].total.current);
    }
  });

  it("reconciles at every period of both years", () => {
    for (const year of [2025, 2026]) {
      for (let period = 0; period <= 13; period++) {
        const bs = buildBalanceSheet(CHART, rows, { year, period, semantics });
        expect(bs.difference.current, `${year}/${period}`).toBe(0);
      }
    }
  });

  it("gives the year-to-date profit and loss with last year's same periods", () => {
    const budgets: LedgerBudget[] = [
      // revenue budget 5,500 a month (debit - credit, so negative), salaries 4,000 a month
      ...[1, 2, 3].map((p) => ({
        glAccountExactId: id(20),
        year: 2026,
        period: p,
        amountMinor: -550_000,
      })),
      ...[1, 2, 3].map((p) => ({
        glAccountExactId: id(22),
        year: 2026,
        period: p,
        amountMinor: 400_000,
      })),
    ];
    const pl = buildProfitAndLoss(CHART, rows, budgets, { year: 2026, periodTo: 6, semantics });
    // 2026 to p6: revenue 5,000 + 1,000 = 6,000; costs: subcontractors -300, salaries -4,500
    expect(pl.sections.revenue.total).toMatchObject({ actual: 600_000, budget: 1_650_000 });
    // 2025 p1..6: revenue 10,000; subcontractors 2,000; salaries 4,000 (p12 depreciation and
    // interest are outside the range)
    expect(pl.sections.revenue.total.lastYear).toBe(1_000_000);
    expect(pl.sections.costs.total).toMatchObject({
      actual: -480_000,
      lastYear: -600_000,
      budget: -1_200_000,
      // -480,000 vs -600,000: 120,000 better, 20 % of |-600,000|
      vsLastYear: { minor: 120_000, bps: 2000 },
      // -480,000 vs -1,200,000: 720,000 under budget = +60 %
      vsBudget: { minor: 720_000, bps: 6000 },
    });
    expect(pl.result).toMatchObject({ actual: 120_000, lastYear: 400_000, budget: 450_000 });
    // 120,000 vs 400,000: -280,000 = -70 %
    expect(pl.result.vsLastYear).toEqual({ minor: -280_000, bps: -7000 });
    // the balance sheet's result to the same period is the profit and loss result
    const bs = buildBalanceSheet(CHART, rows, { year: 2026, period: 6, semantics });
    expect(bs.result.current).toBe(pl.result.actual);
  });
});

describe("opening balances", () => {
  it("flags a year without any period 0 row, which the check line cannot catch", () => {
    const noOpening = LEDGER.filter((b) => !(b.year === 2026 && b.period === 0));
    const bs = buildBalanceSheet(CHART, noOpening, { year: 2026, period: 2, compareYear: 2025 });
    // the movements alone still "balance"...
    expect(bs.difference.current).toBe(0);
    // ...so the flag is what tells a screen that the figures are movements, not balances
    expect(bs.hasOpeningBalances).toEqual({ current: false, compare: true });
    const none = buildBalanceSheet(CHART, noOpening, { year: 2026, period: 2 });
    expect(none.hasOpeningBalances).toEqual({ current: false, compare: null });
  });

  it("shows an opening that does not include last year's result as a difference", () => {
    // Exact carrying assets forward but not yet the result into retained earnings
    const unclosed = LEDGER.filter(
      (b) => !(b.year === 2026 && b.period === 0 && b.glAccountExactId === id(8)),
    );
    const bs = buildBalanceSheet(CHART, unclosed, { year: 2026, period: 2 });
    expect(bs.difference.current).toBe(345_000);
  });
});

describe("profit and loss edge cases (review K2)", () => {
  it("gives null last-year figures, not zeros, when the compare year is not available", () => {
    const pl = buildProfitAndLoss(CHART, LEDGER, null, {
      year: 2026,
      periodTo: 2,
      compareYear: null,
    });
    expect(pl.compareYear).toBeNull();
    expect(pl.result).toMatchObject({
      actual: 20_000,
      lastYear: null,
      vsLastYear: { minor: null, bps: null },
    });
    expect(pl.sections.revenue.lines.every((l) => l.lastYear === null)).toBe(true);
  });

  it("variance in basis points of a negative base, a zero base, and rounding", () => {
    const one = (actual: number, budget: number) =>
      buildProfitAndLoss(
        [SALARIES],
        [
          {
            glAccountExactId: id(22),
            year: 2026,
            period: 1,
            amountMinor: actual,
            balanceType: "W",
          },
        ],
        [{ glAccountExactId: id(22), year: 2026, period: 1, amountMinor: budget }],
        { year: 2026, periodTo: 1 },
      ).result.vsBudget;
    // cost 150 against a budget of 100 (shown -150 vs -100): 50 worse, -50 % of |-100|
    expect(one(15_000, 10_000)).toEqual({ minor: -5_000, bps: -5000 });
    // cost against no budget: no percentage
    expect(one(15_000, 0)).toEqual({ minor: -15_000, bps: null });
    // 1 cent over a 3-cent budget: -33.33 %, half away from zero at 4 decimals
    expect(one(4, 3)).toEqual({ minor: -1, bps: -3333 });
    // 1 cent over 2 * 10,000 cents: -0.005 % rounds away from zero to -1 bp
    expect(one(20_001, 20_000)).toEqual({ minor: -1, bps: -1 });
  });

  it("keeps a budget for an account the chart does not know on the profit and loss", () => {
    const pl = buildProfitAndLoss(
      CHART,
      LEDGER,
      [{ glAccountExactId: id(99), year: 2026, period: 1, amountMinor: 1_000 }],
      { year: 2026, periodTo: 2 },
    );
    expect(pl.sections.unclassified.lines).toEqual([
      expect.objectContaining({ code: null, budget: -1_000, actual: 0 }),
    ]);
    expect(pl.result.budget).toBe(-1_000);
  });

  it("refuses a total beyond the safe integer range instead of rounding it", () => {
    const half = 2 ** 52;
    const rows: LedgerBalance[] = [
      { glAccountExactId: id(1), year: 2026, period: 1, amountMinor: half, balanceType: "B" },
      { glAccountExactId: id(1), year: 2026, period: 2, amountMinor: half, balanceType: "B" },
    ];
    expect(() => buildBalanceSheet(CHART, rows, { year: 2026, period: 2 })).toThrow(RangeError);
  });
});
