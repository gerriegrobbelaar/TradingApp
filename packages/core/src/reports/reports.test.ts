import { describe, expect, it } from "vitest";
import {
  BALANCE_SHEET_SECTIONS,
  LEDGER_BALANCE_SEMANTICS,
  PROFIT_LOSS_SECTIONS,
  buildBalanceSheet,
  buildProfitAndLoss,
  classifyBalanceSheetAccount,
  classifyProfitLossAccount,
  compareRefs,
  resolveAccounts,
  signedByAccount,
  sumMinor,
  toSafe,
  varianceBps,
  type BalanceSheet,
  type LedgerAccount,
  type LedgerBalance,
  type LedgerBudget,
} from "./index";

const id = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const acc = (
  n: number,
  code: string | null,
  name: string,
  over: Partial<LedgerAccount> = {},
): LedgerAccount => ({
  exactId: id(n),
  code,
  name,
  type: null,
  typeDescription: null,
  balanceSide: null,
  balanceType: "B",
  isActive: true,
  ...over,
});

/** A small chart, hand-built. */
const BANK = acc(1, "1100", "Bank", { type: 12, balanceSide: "D" });
const DEBTORS = acc(2, "1300", "Receivables", { type: 20, balanceSide: "D" });
const CREDITORS = acc(3, "1600", "Creditors", { type: 21, balanceSide: "C" });
const CAPITAL = acc(4, "0500", "Share capital", {
  type: 40,
  typeDescription: "Equity",
  balanceSide: "C",
});
const REVENUE = acc(5, "4000", "Consulting revenue", { balanceType: "W", balanceSide: "C" });
const SALARIES = acc(6, "6000", "Salaries", { balanceType: "W", balanceSide: "D" });
const MYSTERY = acc(7, "9999", "Mystery", { typeDescription: "Other", balanceSide: "D" });
const CHART = [BANK, DEBTORS, CREDITORS, CAPITAL, REVENUE, SALARIES, MYSTERY];

const bal = (
  n: number,
  year: number,
  period: number,
  amountMinor: number,
  balanceType: "B" | "W" | null = null,
): LedgerBalance => ({ glAccountExactId: id(n), year, period, amountMinor, balanceType });

/**
 * Debit - credit, in cents. Every period nets to zero, as a trial balance does.
 *   2026 p0 (opening)  bank +100.00, receivables +50.00, creditors -30.00, capital -120.00
 *   2026 p1            bank +20.00, revenue -50.00, salaries +30.00
 *   2026 p2            bank +15.00, revenue -25.00, salaries +10.00
 *   2026 p3 (later)    bank +1.00, revenue -1.00
 *   2025 p0            bank +80.00, capital -80.00
 *   2025 p1            bank +10.00, revenue -40.00, salaries +30.00
 *   2025 p12           bank +5.00, revenue -5.00
 */
const LEDGER: LedgerBalance[] = [
  bal(1, 2026, 0, 10000),
  bal(2, 2026, 0, 5000),
  bal(3, 2026, 0, -3000),
  bal(4, 2026, 0, -12000),
  bal(1, 2026, 1, 2000),
  bal(5, 2026, 1, -5000),
  bal(6, 2026, 1, 3000),
  bal(1, 2026, 2, 1500),
  bal(5, 2026, 2, -2500),
  bal(6, 2026, 2, 1000),
  bal(1, 2026, 3, 100),
  bal(5, 2026, 3, -100),
  bal(1, 2025, 0, 8000),
  bal(4, 2025, 0, -8000),
  bal(1, 2025, 1, 1000),
  bal(5, 2025, 1, -4000),
  bal(6, 2025, 1, 3000),
  bal(1, 2025, 12, 500),
  bal(5, 2025, 12, -500),
];

const section = (bs: BalanceSheet, s: (typeof BALANCE_SHEET_SECTIONS)[number]) => bs.sections[s];

describe("balance sheet (hand-computed)", () => {
  const bs = buildBalanceSheet(CHART, LEDGER, {
    year: 2026,
    period: 2,
    compareYear: 2025,
    compareToYearEnd: true,
  });

  it("uses the documented default semantics", () => {
    expect(LEDGER_BALANCE_SEMANTICS).toBe("movement");
  });

  it("is cumulative up to the period and ignores later periods", () => {
    // bank: 100.00 + 20.00 + 15.00 = 135.00 (the +1.00 in period 3 is not included)
    expect(section(bs, "assets").lines).toEqual([
      { accountId: id(1), code: "1100", name: "Bank", current: 13500, compare: 9500 },
      { accountId: id(2), code: "1300", name: "Receivables", current: 5000, compare: 0 },
    ]);
    expect(section(bs, "assets").total).toEqual({ current: 18500, compare: 9500 });
  });

  it("shows liabilities and equity as positive balances", () => {
    expect(section(bs, "liabilities").lines).toEqual([
      { accountId: id(3), code: "1600", name: "Creditors", current: 3000, compare: 0 },
    ]);
    expect(section(bs, "equity").lines).toEqual([
      { accountId: id(4), code: "0500", name: "Share capital", current: 12000, compare: 8000 },
    ]);
    expect(section(bs, "liabilities").total).toEqual({ current: 3000, compare: 0 });
    expect(section(bs, "equity").total).toEqual({ current: 12000, compare: 8000 });
  });

  it("adds the year's result and compares with the previous YEAR END, which includes period 12", () => {
    // 2026 to period 2: revenue 75.00 - salaries 40.00 = 35.00; 2025 whole year: 45.00 - 30.00 = 15.00
    expect(bs.result).toEqual({ current: 3500, compare: 1500 });
    expect(bs.liabilitiesAndEquity).toEqual({ current: 18500, compare: 9500 });
    expect(bs.compareBasis).toBe("year_end");
    expect(bs.difference).toEqual({ current: 0, compare: 0 });
    expect(section(bs, "unclassified").lines).toEqual([]);
  });

  it("can compare with the same period of the other year instead", () => {
    const same = buildBalanceSheet(CHART, LEDGER, {
      year: 2026,
      period: 2,
      compareYear: 2025,
      compareToYearEnd: false,
    });
    // 2025 up to period 2: bank 80.00 + 10.00 = 90.00; period 12 is not included
    expect(section(same, "assets").total.compare).toBe(9000);
    expect(same.compareBasis).toBe("same_period");
    expect(same.result.compare).toBe(1000);
    expect(same.difference.compare).toBe(0);
  });

  it("has no comparison column without a compare year", () => {
    const one = buildBalanceSheet(CHART, LEDGER, { year: 2026, period: 2 });
    expect(one.compareYear).toBeNull();
    expect(one.compareBasis).toBeNull();
    expect(one.result.compare).toBeNull();
    expect(section(one, "assets").lines.every((l) => l.compare === null)).toBe(true);
    expect(one.difference).toEqual({ current: 0, compare: null });
  });

  it("puts accounts it cannot classify on their own line and keeps the totals reconciling", () => {
    const ledger = [...LEDGER, bal(7, 2026, 1, 700), bal(1, 2026, 1, -700)];
    const r = buildBalanceSheet(CHART, ledger, { year: 2026, period: 2 });
    expect(section(r, "unclassified").lines).toEqual([
      { accountId: id(7), code: "9999", name: "Mystery", current: 700, compare: null },
    ]);
    expect(section(r, "assets").total.current).toBe(17800);
    // assets 178.00 + unclassified 7.00 = liabilities and equity 185.00: difference 0
    expect(r.difference.current).toBe(0);
  });

  it("surfaces missing data as a non-zero difference instead of hiding it", () => {
    const noOpening = LEDGER.filter((b) => !(b.year === 2026 && b.period === 0));
    const r = buildBalanceSheet(CHART, noOpening, { year: 2026, period: 2 });
    // without any opening balances assets 35.00 equal the result 35.00: still balanced.
    // Drop only the capital opening and the difference is exactly the missing 120.00.
    const noCapital = LEDGER.filter(
      (b) => !(b.year === 2026 && b.period === 0 && b.glAccountExactId === id(4)),
    );
    const s = buildBalanceSheet(CHART, noCapital, { year: 2026, period: 2 });
    expect(r.difference.current).toBe(0);
    expect(s.difference.current).toBe(12000);
  });

  it("keeps accounts that are not in the chart, as unclassified, and reconciles", () => {
    const orphan = [...LEDGER, bal(99, 2026, 1, 250, "B"), bal(1, 2026, 1, -250)];
    const r = buildBalanceSheet(CHART, orphan, { year: 2026, period: 2 });
    const line = section(r, "unclassified").lines[0];
    expect(line).toMatchObject({ accountId: id(99), code: null, current: 250 });
    expect(line?.name).toBe("Unknown account 00000000");
    expect(r.difference.current).toBe(0);
  });

  it("adds rows of the same account and period (cost centre or status splits)", () => {
    const split = [bal(1, 2026, 1, 1000), bal(1, 2026, 1, 500), bal(4, 2026, 1, -1500)];
    const r = buildBalanceSheet(CHART, split, { year: 2026, period: 1 });
    expect(section(r, "assets").total.current).toBe(1500);
    expect(r.difference.current).toBe(0);
  });

  it("reads cumulative semantics as the latest period at or before the asked one", () => {
    const cumulative: LedgerBalance[] = [
      bal(1, 2026, 1, 12000),
      bal(1, 2026, 2, 13500),
      bal(1, 2026, 3, 13600),
      bal(4, 2026, 2, -13500),
    ];
    const r = buildBalanceSheet(CHART, cumulative, {
      year: 2026,
      period: 2,
      semantics: "cumulative",
    });
    expect(section(r, "assets").total.current).toBe(13500);
    expect(section(r, "equity").total.current).toBe(13500);
    expect(r.difference.current).toBe(0);
  });

  it("returns an empty report for an empty ledger", () => {
    const r = buildBalanceSheet([], [], { year: 2026, period: 12, compareYear: 2025 });
    for (const s of BALANCE_SHEET_SECTIONS) {
      expect(r.sections[s].lines).toEqual([]);
      expect(r.sections[s].total).toEqual({ current: 0, compare: 0 });
    }
    expect(r.difference).toEqual({ current: 0, compare: 0 });
  });

  it("treats an account with no balance type as a balance sheet account", () => {
    const loose = acc(8, "8000", "Loose", { balanceType: null, type: 12, balanceSide: "D" });
    const r = buildBalanceSheet([loose], [bal(8, 2026, 1, 10)], { year: 2026, period: 1 });
    expect(section(r, "assets").total.current).toBe(10);
  });
});

describe("profit and loss (hand-computed)", () => {
  const budgets: LedgerBudget[] = [
    { glAccountExactId: id(5), year: 2026, period: 1, amountMinor: -6000 },
    { glAccountExactId: id(5), year: 2026, period: 2, amountMinor: -3000 },
    { glAccountExactId: id(5), year: 2026, period: 3, amountMinor: -1000 },
    { glAccountExactId: id(6), year: 2026, period: 1, amountMinor: 3500 },
    { glAccountExactId: id(6), year: 2026, period: 2, amountMinor: 1000 },
  ];
  const pl = buildProfitAndLoss(CHART, LEDGER, budgets, { year: 2026, periodTo: 2 });

  it("shows revenue positive and costs negative, so the result is the sum of the lines", () => {
    expect(pl.sections.revenue.lines).toHaveLength(1);
    expect(pl.sections.revenue.lines[0]).toMatchObject({ code: "4000", actual: 7500 });
    expect(pl.sections.costs.lines[0]).toMatchObject({ code: "6000", actual: -4000 });
    expect(pl.sections.revenue.total.actual).toBe(7500);
    expect(pl.sections.costs.total.actual).toBe(-4000);
    expect(pl.result.actual).toBe(3500);
  });

  it("compares with budget, year to date only", () => {
    // budget: revenue 60.00 + 30.00 = 90.00 (period 3 excluded), costs -(35.00 + 10.00) = -45.00
    expect(pl.budgetsIncluded).toBe(true);
    expect(pl.sections.revenue.total).toMatchObject({
      budget: 9000,
      vsBudget: { minor: -1500, bps: -1667 }, // -1500 / 9000 = -16.67 %
    });
    expect(pl.sections.costs.total).toMatchObject({
      budget: -4500,
      vsBudget: { minor: 500, bps: 1111 }, // cost 5.00 under budget = +11.11 %
    });
    expect(pl.result).toMatchObject({ budget: 4500, vsBudget: { minor: -1000, bps: -2222 } });
  });

  it("compares with the same periods last year", () => {
    // 2025 periods 1..2: revenue 40.00, salaries 30.00 (period 12 is not included)
    expect(pl.compareYear).toBe(2025);
    expect(pl.sections.revenue.total).toMatchObject({
      lastYear: 4000,
      vsLastYear: { minor: 3500, bps: 8750 },
    });
    expect(pl.sections.costs.total).toMatchObject({
      lastYear: -3000,
      vsLastYear: { minor: -1000, bps: -3333 },
    });
    expect(pl.result).toMatchObject({ lastYear: 1000, vsLastYear: { minor: 2500, bps: 25000 } });
  });

  it("gives null budget figures, not zeros, when budgets are not available", () => {
    const r = buildProfitAndLoss(CHART, LEDGER, null, { year: 2026, periodTo: 2 });
    expect(r.budgetsIncluded).toBe(false);
    expect(r.result.budget).toBeNull();
    expect(r.result.vsBudget).toEqual({ minor: null, bps: null });
    expect(r.sections.revenue.lines[0]?.budget).toBeNull();
    expect(r.result.actual).toBe(3500);
  });

  it("is safe against a zero base and shows a budget-only account", () => {
    const only: LedgerBudget[] = [
      { glAccountExactId: id(5), year: 2026, period: 1, amountMinor: 0 },
    ];
    const r = buildProfitAndLoss(CHART, [], only, { year: 2026, periodTo: 12 });
    expect(r.result).toMatchObject({ actual: 0, budget: 0, vsBudget: { minor: 0, bps: null } });
    const b = buildProfitAndLoss(
      CHART,
      [],
      [{ glAccountExactId: id(6), year: 2026, period: 1, amountMinor: 500 }],
      { year: 2026, periodTo: 12 },
    );
    expect(b.sections.costs.lines[0]).toMatchObject({
      budget: -500,
      actual: 0,
      vsBudget: { minor: 500, bps: 10000 },
      vsLastYear: { minor: 0, bps: null },
    });
  });

  it("keeps a profit and loss account without a side in unclassified, counted in the result", () => {
    const odd = acc(8, "7000", "Odd", { balanceType: "W" });
    const r = buildProfitAndLoss(
      [...CHART, odd],
      [...LEDGER, bal(8, 2026, 1, 100), bal(1, 2026, 1, -100)],
      null,
      {
        year: 2026,
        periodTo: 2,
      },
    );
    expect(r.sections.unclassified.lines[0]).toMatchObject({ code: "7000", actual: -100 });
    expect(r.result.actual).toBe(3400);
  });

  it("applies the budget sign constant through the documented convention", () => {
    // revenue budget stored as debit - credit is negative; shown positive
    expect(pl.sections.revenue.lines[0]?.budget).toBe(9000);
  });

  it("uses an explicit compare year and cumulative semantics when asked", () => {
    const cumulative: LedgerBalance[] = [
      bal(5, 2026, 1, -5000, "W"),
      bal(5, 2026, 2, -7500, "W"),
      bal(5, 2026, 3, -7600, "W"),
      bal(5, 2024, 2, -100, "W"),
    ];
    const r = buildProfitAndLoss(CHART, cumulative, null, {
      year: 2026,
      periodTo: 2,
      compareYear: 2024,
      semantics: "cumulative",
    });
    expect(r.result).toMatchObject({ actual: 7500, lastYear: 100 });
    expect(r.compareYear).toBe(2024);
  });

  it("ignores balance sheet accounts", () => {
    const r = buildProfitAndLoss([BANK], [bal(1, 2026, 1, 999)], null, { year: 2026, periodTo: 1 });
    expect(r.result.actual).toBe(0);
  });
});

describe("scales: JPY has no minor unit, KWD has three decimals", () => {
  // The builders add integers whatever the currency; the scale is applied when Exact's decimal
  // text is read (packages/exact) and when an amount is shown. Amounts here are far beyond what a
  // 32-bit or double-rounded sum would keep exactly.
  it("sums yen without scaling", () => {
    const yen = [bal(1, 2026, 1, 123_456_789_012), bal(4, 2026, 1, -123_456_789_012)];
    const r = buildBalanceSheet(CHART, yen, { year: 2026, period: 1 });
    expect(section(r, "assets").total.current).toBe(123_456_789_012);
    expect(r.difference.current).toBe(0);
  });

  it("keeps KWD fils exact", () => {
    // 1,234.567 KWD = 1234567 fils; three of them plus 0.001
    const kwd = [
      bal(5, 2026, 1, -1_234_567),
      bal(5, 2026, 2, -1_234_567),
      bal(5, 2026, 3, -1_234_567),
      bal(5, 2026, 4, -1),
    ];
    const r = buildProfitAndLoss(CHART, kwd, null, { year: 2026, periodTo: 4 });
    expect(r.result.actual).toBe(3_703_702);
  });
});

describe("helpers", () => {
  it("sums as BigInt and refuses results outside the safe range", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(sumMinor([max, max, -max])).toBe(max);
    expect(sumMinor([])).toBe(0);
    expect(() => sumMinor([max, 1])).toThrow(RangeError);
    expect(() => sumMinor([0.5])).toThrow(RangeError);
    expect(toSafe(-0n)).toBe(0);
    expect(Object.is(toSafe(0n), 0)).toBe(true);
    expect(() => toSafe(BigInt(max) + 1n)).toThrow(RangeError);
    expect(() => toSafe(-BigInt(max) - 1n)).toThrow(RangeError);
  });

  it("builders refuse unsafe stored amounts", () => {
    expect(() =>
      signedByAccount([bal(1, 2026, 1, 1.5)], 2026, { from: 0, to: 12 }, "movement"),
    ).toThrow(RangeError);
  });

  it("rounds basis points half away from zero and handles zero bases", () => {
    expect(varianceBps(1, 0)).toBeNull();
    expect(varianceBps(1, 8)).toBe(1250);
    expect(varianceBps(1, 3)).toBe(3333);
    expect(varianceBps(-1, 3)).toBe(-3333);
    expect(varianceBps(1, 20000)).toBe(1); // 0.5 rounds away from zero
    expect(varianceBps(-1, 20000)).toBe(-1);
    expect(varianceBps(1, -8)).toBe(1250); // percentage of the absolute base
    expect(varianceBps(0, 5)).toBe(0);
  });

  it("orders lines by code, numerically, then name, then id", () => {
    const refs = [
      { accountId: "b", code: "10", name: "x" },
      { accountId: "a", code: "9", name: "x" },
      { accountId: "c", code: null, name: "a" },
      { accountId: "d", code: "9", name: "a" },
      { accountId: "e", code: "9", name: "a" },
    ];
    expect([...refs].sort(compareRefs).map((r) => r.accountId)).toEqual(["d", "e", "a", "b", "c"]);
    const first = refs[0] ?? { accountId: "", code: null, name: "" };
    expect(compareRefs(first, first)).toBe(0);
  });

  it("resolves accounts, with row types for the ones not in the chart", () => {
    const m = resolveAccounts(
      [BANK],
      [
        { glAccountExactId: id(1), balanceType: "W" },
        { glAccountExactId: id(50), balanceType: "W" },
        { glAccountExactId: id(51) },
      ],
    );
    expect(m.get(id(1))?.balanceType).toBe("B"); // the chart wins
    expect(m.get(id(50))).toMatchObject({ balanceType: "W", inChart: false, code: null });
    expect(m.get(id(51))?.balanceType).toBe("B");
  });
});

describe("account classification", () => {
  it("maps by Exact type code, then by description, then gives up", () => {
    const c = classifyBalanceSheetAccount;
    expect(c({ type: 12, typeDescription: null, balanceSide: "D" })).toBe("assets");
    expect(c({ type: 21, typeDescription: null, balanceSide: "C" })).toBe("liabilities");
    expect(c({ type: 99, typeDescription: "Equity", balanceSide: "C" })).toBe("equity");
    expect(c({ type: null, typeDescription: "Eigen vermogen", balanceSide: null })).toBe("equity");
    expect(c({ type: null, typeDescription: "Crediteuren", balanceSide: "C" })).toBe("liabilities");
    expect(c({ type: null, typeDescription: "VAT payable", balanceSide: null })).toBe(
      "liabilities",
    );
    expect(c({ type: null, typeDescription: "Debiteuren", balanceSide: "D" })).toBe("assets");
    expect(c({ type: null, typeDescription: "Something else", balanceSide: "D" })).toBe(
      "unclassified",
    );
    expect(c({ type: null, typeDescription: null, balanceSide: null })).toBe("unclassified");
  });

  it("does not trust a guess that contradicts the account's side", () => {
    const c = classifyBalanceSheetAccount;
    expect(c({ type: 12, typeDescription: null, balanceSide: "C" })).toBe("unclassified");
    expect(c({ type: 21, typeDescription: null, balanceSide: "D" })).toBe("unclassified");
    expect(c({ type: null, typeDescription: "Equity", balanceSide: "D" })).toBe("unclassified");
  });

  it("splits profit and loss by side", () => {
    expect(classifyProfitLossAccount({ balanceSide: "C" })).toBe("revenue");
    expect(classifyProfitLossAccount({ balanceSide: "D" })).toBe("costs");
    expect(classifyProfitLossAccount({ balanceSide: null })).toBe("unclassified");
    expect(PROFIT_LOSS_SECTIONS).toEqual(["revenue", "costs", "unclassified"]);
  });
});

// ---- property tests: deterministic pseudo-random ledgers ---------------------------------------

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("properties over random ledgers", () => {
  const TYPES = [12, 20, 21, 10, null, 77];
  const DESCRIPTIONS = [null, "Equity", "Other", "Creditors", "Debtors", "Fixed assets"];
  const SIDES: ("D" | "C" | null)[] = ["D", "C", null];

  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}: totals equal the sum of lines and the check line is the plain sum`, () => {
      const rnd = lcg(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const n = 3 + Math.floor(rnd() * 12);
      const accounts: LedgerAccount[] = Array.from({ length: n }, (_, i) =>
        acc(
          i + 1,
          rnd() < 0.1 ? null : String(1000 + Math.floor(rnd() * 9000)),
          `Account ${i + 1}`,
          {
            type: pick(TYPES),
            typeDescription: pick(DESCRIPTIONS),
            balanceSide: pick(SIDES),
            balanceType: rnd() < 0.4 ? "W" : rnd() < 0.1 ? null : "B",
          },
        ),
      );
      const balances: LedgerBalance[] = [];
      for (let k = 0; k < 60; k++) {
        // some rows belong to accounts that are not in the chart
        const who = Math.floor(rnd() * (n + 2)) + 1;
        balances.push(
          bal(
            who,
            rnd() < 0.5 ? 2026 : 2025,
            Math.floor(rnd() * 14),
            Math.round((rnd() - 0.5) * 2_000_000),
            rnd() < 0.5 ? "B" : "W",
          ),
        );
      }
      const period = 1 + Math.floor(rnd() * 12);

      const bs = buildBalanceSheet(accounts, balances, { year: 2026, period, compareYear: 2025 });
      const resolved = resolveAccounts(accounts, balances);
      const cur = signedByAccount(balances, 2026, { from: 0, to: period }, "movement");
      const curPl = signedByAccount(balances, 2026, { from: 1, to: period }, "movement");
      let plain = 0n;
      for (const a of resolved.values()) {
        plain += (a.balanceType === "W" ? curPl : cur).get(a.accountId) ?? 0n;
      }
      // The check line is the plain sum of every account, however they were classified.
      expect(BigInt(bs.difference.current)).toBe(plain);
      for (const s of BALANCE_SHEET_SECTIONS) {
        const r = bs.sections[s];
        expect(sumMinor(r.lines.map((l) => l.current))).toBe(r.total.current);
        expect(sumMinor(r.lines.map((l) => l.compare ?? 0))).toBe(r.total.compare);
      }
      // No account with a balance is lost: every balance sheet account's value is in some section.
      const shown = new Set(
        BALANCE_SHEET_SECTIONS.flatMap((s) => bs.sections[s].lines.map((l) => l.accountId)),
      );
      for (const a of resolved.values()) {
        if (a.balanceType === "B" && (cur.get(a.accountId) ?? 0n) !== 0n) {
          expect(shown.has(a.accountId)).toBe(true);
        }
      }

      const budgets: LedgerBudget[] = balances
        .filter((_, i) => i % 3 === 0)
        .map((b) => ({
          glAccountExactId: b.glAccountExactId,
          year: b.year,
          period: b.period,
          amountMinor: b.amountMinor,
        }));
      const pl = buildProfitAndLoss(accounts, balances, budgets, { year: 2026, periodTo: period });
      const lineSum = (
        pick2: (l: { actual: number; budget: number | null; lastYear: number }) => number,
      ) => sumMinor(PROFIT_LOSS_SECTIONS.flatMap((s) => pl.sections[s].lines.map(pick2)));
      expect(lineSum((l) => l.actual)).toBe(pl.result.actual);
      expect(lineSum((l) => l.budget ?? 0)).toBe(pl.result.budget);
      expect(lineSum((l) => l.lastYear)).toBe(pl.result.lastYear);
      for (const s of PROFIT_LOSS_SECTIONS) {
        const t = pl.sections[s].total;
        expect(t.vsBudget.minor).toBe(t.actual - (t.budget ?? 0));
        expect(t.vsLastYear.minor).toBe(t.actual - t.lastYear);
      }
      // Result = revenue + costs + unclassified.
      expect(pl.result.actual).toBe(
        sumMinor(PROFIT_LOSS_SECTIONS.map((s) => pl.sections[s].total.actual)),
      );
    });
  }
});
