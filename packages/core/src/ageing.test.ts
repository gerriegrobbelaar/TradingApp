import { describe, expect, it } from "vitest";
import {
  AGEING_BUCKETS,
  addDays,
  ageingBucket,
  buildAgeing,
  dayNumber,
  daysOverdue,
  resolveDcMinor,
  toCalendarDate,
  type AgeingItem,
} from "./ageing";

const AS_OF = "2026-06-30";

describe("calendar dates", () => {
  it("validates and converts", () => {
    expect(toCalendarDate("2026-02-28")).toBe("2026-02-28");
    expect(() => toCalendarDate("2026-02-30")).toThrow(RangeError);
    expect(() => toCalendarDate("26-02-03")).toThrow(RangeError);
    expect(() => toCalendarDate("")).toThrow(RangeError);
    expect(() => toCalendarDate("garbage T")).toThrow(RangeError);
  });

  it("uses the Amsterdam day of an instant", () => {
    // 22:30 UTC on 29 June is 00:30 on 30 June in Amsterdam (summer time).
    expect(toCalendarDate("2026-06-29T22:30:00.000Z")).toBe("2026-06-30");
    expect(toCalendarDate("2026-06-29T21:30:00.000Z")).toBe("2026-06-29");
  });

  it("does date arithmetic across month, year and leap days", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dayNumber("1970-01-02")).toBe(1);
    expect(() => addDays("2026-01-01", 1.5)).toThrow(RangeError);
  });
});

describe("ageingBucket boundaries", () => {
  const cases: [number, string][] = [
    [-5, "not_due"],
    [0, "not_due"],
    [1, "d1_30"],
    [30, "d1_30"],
    [31, "d31_60"],
    [60, "d31_60"],
    [61, "d61_90"],
    [90, "d61_90"],
    [91, "d90_plus"],
    [4000, "d90_plus"],
  ];
  for (const [days, bucket] of cases) {
    it(`${days} days overdue is ${bucket}`, () => {
      const due = addDays(AS_OF, -days);
      expect(daysOverdue(due, AS_OF)).toBe(days);
      expect(ageingBucket(due, AS_OF)).toBe(bucket);
    });
  }

  it("has its own bucket for an unknown due date", () => {
    expect(ageingBucket(null, AS_OF)).toBe("no_due_date");
    expect(daysOverdue(null, AS_OF)).toBeNull();
  });

  it("works on Amsterdam days over a daylight saving change", () => {
    expect(ageingBucket("2026-03-28", "2026-03-30")).toBe("d1_30");
    expect(daysOverdue("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysOverdue("2026-10-24", "2026-10-26")).toBe(2);
  });
});

describe("resolveDcMinor", () => {
  const div = { currency: "EUR", known: true };
  const base = { currency: "USD", openMinor: 100, openDcMinor: null, dcCurrency: null };
  it("prefers the stored division-currency amount", () => {
    expect(resolveDcMinor({ ...base, openDcMinor: 92, dcCurrency: "EUR" }, div)).toBe(92);
    expect(resolveDcMinor({ ...base, openDcMinor: 92 }, div)).toBe(92);
  });
  it("ignores a stored amount in another currency", () => {
    expect(resolveDcMinor({ ...base, openDcMinor: 92, dcCurrency: "GBP" }, div)).toBeNull();
  });
  it("uses the open balance for an item already in the division currency, only when verified", () => {
    expect(resolveDcMinor({ ...base, currency: "EUR" }, div)).toBe(100);
    expect(
      resolveDcMinor({ ...base, currency: "EUR" }, { currency: "EUR", known: false }),
    ).toBeNull();
  });
  it("does not convert", () => {
    expect(resolveDcMinor(base, div)).toBeNull();
  });
});

const item = (over: Partial<AgeingItem>): AgeingItem => ({
  relationKey: "a",
  relationName: "Alpha",
  currency: "EUR",
  openMinor: 100,
  dueDate: AS_OF,
  dcMinor: 100,
  ...over,
});

describe("buildAgeing", () => {
  it("is empty without items", () => {
    expect(buildAgeing([], AS_OF)).toEqual({ asOf: AS_OF, currencies: [], totalsByCurrency: [] });
  });

  it("aggregates per relation and bucket in integer minor units, per currency", () => {
    const items = [
      item({ openMinor: 10, dueDate: addDays(AS_OF, 5) }),
      item({ openMinor: 20, dueDate: addDays(AS_OF, -1) }),
      item({ openMinor: 30, dueDate: addDays(AS_OF, -31) }),
      item({
        relationKey: "b",
        relationName: "Beta",
        openMinor: 500,
        dueDate: addDays(AS_OF, -100),
      }),
      item({ relationKey: "b", relationName: "Beta", openMinor: 7, dueDate: null, dcMinor: null }),
      item({ currency: "USD", openMinor: 9_999, dueDate: addDays(AS_OF, -61), dcMinor: null }),
    ];
    const r = buildAgeing(items, AS_OF);
    expect(r.currencies.map((c) => c.currency)).toEqual(["EUR", "USD"]);
    const eur = r.currencies[0]!;
    expect(eur.rows.map((x) => x.relationKey)).toEqual(["b", "a"]);
    expect(eur.rows[1]!.buckets).toEqual({
      not_due: 10,
      d1_30: 20,
      d31_60: 30,
      d61_90: 0,
      d90_plus: 0,
      no_due_date: 0,
    });
    expect(eur.rows[1]!.dc).toEqual({ minor: 300, complete: true });
    expect(eur.rows[0]!.buckets.d90_plus).toBe(500);
    expect(eur.rows[0]!.buckets.no_due_date).toBe(7);
    expect(eur.rows[0]!.dc).toEqual({ minor: 100, complete: false });
    expect(eur.totals.totalMinor).toBe(567);
    expect(eur.totals.count).toBe(5);
    expect(eur.totals.bucketCounts.d1_30).toBe(1);
    expect(r.totalsByCurrency[1]).toMatchObject({
      currency: "USD",
      totalMinor: 9_999,
      dc: { minor: 0, complete: false },
    });
    expect(r.totalsByCurrency[1]!.buckets.d61_90).toBe(9_999);
  });

  it("can be limited to one currency", () => {
    const r = buildAgeing([item({}), item({ currency: "USD" })], AS_OF, { currency: "USD" });
    expect(r.totalsByCurrency.map((t) => t.currency)).toEqual(["USD"]);
  });

  it("sorts largest outstanding first, then name, then key (stable)", () => {
    const items = [
      item({ relationKey: "z", relationName: "Zed", openMinor: 50 }),
      item({ relationKey: "y", relationName: "Alpha", openMinor: 50 }),
      item({ relationKey: "x", relationName: "Alpha", openMinor: 50 }),
      item({ relationKey: "w", relationName: null, openMinor: 50 }),
      item({ relationKey: "v", relationName: "Big", openMinor: 5_000 }),
      item({ relationKey: "u", relationName: "Credit", openMinor: -300 }),
    ];
    const keys = (xs: AgeingItem[]) =>
      buildAgeing(xs, AS_OF).currencies[0]!.rows.map((x) => x.relationKey);
    expect(keys(items)).toEqual(["v", "w", "x", "y", "z", "u"]);
    expect(keys([...items].reverse())).toEqual(keys(items));
  });

  it("fills in a missing relation name from a later item", () => {
    const r = buildAgeing(
      [item({ relationName: null }), item({ relationName: "Late name" })],
      AS_OF,
    );
    expect(r.currencies[0]!.rows[0]!.relationName).toBe("Late name");
  });

  it("rejects a sum beyond the safe integer range", () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(() => buildAgeing([item({ openMinor: big }), item({ openMinor: 1 })], AS_OF)).toThrow(
      RangeError,
    );
  });

  it("keeps cents exact where floats would not", () => {
    const items = Array.from({ length: 1000 }, () => item({ openMinor: 10, dcMinor: 10 }));
    expect(buildAgeing(items, AS_OF).totalsByCurrency[0]!.totalMinor).toBe(10_000);
  });

  it("property: bucket totals, row totals and counts add up to the grand total", () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 50; round++) {
      const items: AgeingItem[] = [];
      for (let i = 0, n = rnd(80); i < n; i++) {
        const day = rnd(12) === 0 ? null : addDays(AS_OF, rnd(260) - 130);
        items.push(
          item({
            relationKey: `r${rnd(7)}`,
            relationName: `Rel ${rnd(7)}`,
            currency: ["EUR", "USD", "JPY"][rnd(3)]!,
            openMinor: rnd(2_000_000) - 300_000,
            dueDate: day,
            dcMinor: rnd(3) === 0 ? null : rnd(1_000),
          }),
        );
      }
      const r = buildAgeing(items, AS_OF);
      for (const c of r.currencies) {
        const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
        const bucketSum = sum(AGEING_BUCKETS.map((b) => c.totals.buckets[b]));
        expect(bucketSum).toBe(c.totals.totalMinor);
        expect(sum(c.rows.map((x) => x.totalMinor))).toBe(c.totals.totalMinor);
        expect(sum(c.rows.map((x) => x.count))).toBe(c.totals.count);
        expect(sum(AGEING_BUCKETS.map((b) => c.totals.bucketCounts[b]))).toBe(c.totals.count);
        for (const b of AGEING_BUCKETS) {
          expect(sum(c.rows.map((x) => x.buckets[b]))).toBe(c.totals.buckets[b]);
        }
        const expected = sum(
          items.filter((i) => i.currency === c.currency).map((i) => i.openMinor),
        );
        expect(c.totals.totalMinor).toBe(expected);
      }
      expect(r.currencies.reduce((a, c) => a + c.totals.count, 0)).toBe(items.length);
    }
  });
});
