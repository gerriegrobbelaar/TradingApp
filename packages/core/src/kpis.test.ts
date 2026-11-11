import { describe, expect, it } from "vitest";
import { addDays } from "./ageing";
import { buildOverviewKpis, type KpiItem } from "./kpis";

const AS_OF = "2026-06-30";
const it_ = (over: Partial<KpiItem>): KpiItem => ({
  kind: "receivable",
  currency: "EUR",
  openMinor: 100,
  dueDate: AS_OF,
  dcMinor: 100,
  ...over,
});

describe("buildOverviewKpis", () => {
  it("is empty without items", () => {
    expect(buildOverviewKpis([], AS_OF)).toEqual({ asOf: AS_OF, receivable: [], payable: [] });
  });

  it("splits receivables and payables, per currency", () => {
    const k = buildOverviewKpis(
      [it_({}), it_({ currency: "USD", openMinor: 5 }), it_({ kind: "payable", openMinor: 40 })],
      AS_OF,
    );
    expect(k.receivable.map((x) => [x.currency, x.total.minor])).toEqual([
      ["EUR", 100],
      ["USD", 5],
    ]);
    expect(k.payable.map((x) => [x.currency, x.total.minor])).toEqual([["EUR", 40]]);
  });

  it("counts overdue, due in 7 and 30 days, and no due date", () => {
    const items = [
      it_({ openMinor: 1, dueDate: addDays(AS_OF, -1) }),
      it_({ openMinor: 2, dueDate: AS_OF }),
      it_({ openMinor: 4, dueDate: addDays(AS_OF, 7) }),
      it_({ openMinor: 8, dueDate: addDays(AS_OF, 8) }),
      it_({ openMinor: 16, dueDate: addDays(AS_OF, 30) }),
      it_({ openMinor: 32, dueDate: addDays(AS_OF, 31) }),
      it_({ openMinor: 64, dueDate: null, dcMinor: null }),
    ];
    const e = buildOverviewKpis(items, AS_OF).receivable[0]!;
    expect(e.total).toEqual({ count: 7, minor: 127, dcMinor: 600, dcComplete: false });
    expect(e.overdue).toMatchObject({ count: 1, minor: 1, dcComplete: true });
    expect(e.due7).toMatchObject({ count: 2, minor: 6 });
    expect(e.due30).toMatchObject({ count: 4, minor: 30 });
    expect(e.noDueDate).toMatchObject({ count: 1, minor: 64, dcComplete: false });
  });

  it("weights average days overdue by amount in integers, rounding half up", () => {
    const items = [
      it_({ openMinor: 100, dueDate: addDays(AS_OF, -10) }),
      it_({ openMinor: 300, dueDate: addDays(AS_OF, -20) }),
    ];
    // (10*100 + 20*300) / 400 = 17.5 -> 18
    expect(buildOverviewKpis(items, AS_OF).receivable[0]!.avgDaysOverdue).toBe(18);
    const one = [it_({ openMinor: 333, dueDate: addDays(AS_OF, -7) })];
    expect(buildOverviewKpis(one, AS_OF).receivable[0]!.avgDaysOverdue).toBe(7);
  });

  it("leaves credit notes out of the weighting and gives null when nothing is overdue", () => {
    const credit = [it_({ openMinor: -500, dueDate: addDays(AS_OF, -40) })];
    const k = buildOverviewKpis(credit, AS_OF).receivable[0]!;
    expect(k.avgDaysOverdue).toBeNull();
    expect(k.overdue.minor).toBe(-500);
    expect(buildOverviewKpis([it_({})], AS_OF).receivable[0]!.avgDaysOverdue).toBeNull();
  });

  it("does not lose precision on large weighted sums", () => {
    const big = 900_000_000_000_000; // 9e14 minor units, times 5000 days overdue exceeds 2^53
    const k = buildOverviewKpis([it_({ openMinor: big, dueDate: addDays(AS_OF, -5000) })], AS_OF);
    expect(k.receivable[0]!.avgDaysOverdue).toBe(5000);
  });
});
