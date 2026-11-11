import { describe, expect, it } from "vitest";
import type { FxRatesResponse, RateTable } from "@camelthorn/core";
import { norm } from "../test-norm";
import {
  ageingTotalsInBase,
  rateTableFromResponse,
  chartGeometry,
  differenceOf,
  differenceSentence,
  missingRates,
  rateDateFor,
  rateText,
  resultWord,
  scaledRate,
  signedMoney,
  staleChipText,
  sumInBase,
  toBase,
} from "./fx";

/** ECB-style table, rates in units per 1 EUR. GBP is a week older than the rest. */
const TABLE: RateTable = {
  asOf: "2026-11-10",
  base: "EUR",
  rates: { USD: "1.0853", GBP: "0.872", JPY: "165.5", KWD: "0.3333" },
  ratesDate: { USD: "2026-11-10", GBP: "2026-11-06", JPY: "2026-11-10", KWD: "2026-11-10" },
};
const NO_GBP: RateTable = {
  ...TABLE,
  rates: { USD: "1.0853", JPY: "165.5" },
};

describe("toBase: hand-computed conversions through EUR", () => {
  const cases: [string, number, string, string, bigint][] = [
    // 100,00 USD / 1.0853 = 92.140423... EUR -> 9214 cents
    ["USD to EUR", 10_000, "USD", "EUR", 9214n],
    // 100,00 EUR * 1.0853 = 108,53 USD
    ["EUR to USD", 10_000, "EUR", "USD", 10_853n],
    // 10.000 JPY (no minor unit) / 165.5 = 60.42296 EUR -> 6042 cents
    ["JPY to EUR", 10_000, "JPY", "EUR", 6042n],
    // 1,000 KWD (3 decimals: 1000 fils) / 0.3333 = 3.0003 EUR -> 300 cents
    ["KWD to EUR", 1_000, "KWD", "EUR", 300n],
    // 100,00 USD in a GBP administration: 100 * 0.872 / 1.0853 = 80.34644 GBP -> 8035 pence
    ["USD to GBP via EUR", 10_000, "USD", "GBP", 8035n],
    // 1.000 JPY to USD: 1000 / 165.5 * 1.0853 = 6.55770 USD -> 656 cents
    ["JPY to USD", 1_000, "JPY", "USD", 656n],
    // a credit note converts to the mirror image
    ["USD credit to EUR", -10_000, "USD", "EUR", -9214n],
  ];
  for (const [name, minor, from, to, want] of cases) {
    it(name, () => {
      const r = toBase(TABLE, minor, from, to);
      expect(r.ok && r.minor).toBe(want);
    });
  }

  it("needs no rate for the same currency or for EUR itself", () => {
    expect(toBase({ ...TABLE, rates: {} }, 123, "EUR", "EUR")).toMatchObject({
      ok: true,
      minor: 123n,
    });
  });

  it("reports a missing rate instead of guessing", () => {
    expect(toBase(NO_GBP, 100, "GBP", "EUR")).toEqual({ ok: false, reason: "missing_rate" });
    expect(toBase(NO_GBP, 100, "EUR", "GBP")).toEqual({ ok: false, reason: "missing_rate" });
    expect(missingRates(NO_GBP, "GBP", "EUR")).toEqual(["GBP"]);
    expect(missingRates(NO_GBP, "GBP", "CHF")).toEqual(["GBP", "CHF"]);
    expect(missingRates(TABLE, "USD", "EUR")).toEqual([]);
  });
});

describe("sumInBase: each currency converted once, then added", () => {
  it("rounds once per currency, not once per item", () => {
    // Two items of 0,05 USD. Each alone converts to 0,05 EUR (4.6 cents rounds to 5), which would
    // add up to 10 cents. The currency total 0,10 USD is 9.2139 cents: 9.
    expect(toBase(TABLE, 5, "USD", "EUR")).toMatchObject({ minor: 5n });
    const t = sumInBase(TABLE, "EUR", [
      { currency: "USD", minor: 5 },
      { currency: "USD", minor: 5 },
    ]);
    expect(t.totalMinor).toBe(9n);
    expect(t.included).toEqual(["USD"]);
  });

  it("adds converted totals and base amounts, never raw amounts of different currencies", () => {
    const t = sumInBase(TABLE, "EUR", [
      { currency: "EUR", minor: 1_000 },
      { currency: "USD", minor: 10_000 },
      { currency: "JPY", minor: 10_000 },
    ]);
    // 1000 + 9214 + 6042
    expect(t.totalMinor).toBe(16_256n);
    expect(t.converted).toBe(true);
    expect(t.excluded).toEqual([]);
    expect(t.rateDate).toBe("2026-11-10");
  });

  it("lists currencies without a rate and leaves them out", () => {
    const t = sumInBase(NO_GBP, "EUR", [
      { currency: "EUR", minor: 1_000 },
      { currency: "USD", minor: 10_000 },
      { currency: "GBP", minor: 99_999 },
    ]);
    expect(t.totalMinor).toBe(10_214n);
    expect(t.excluded).toEqual(["GBP"]);
    expect(t.included).toEqual(["EUR", "USD"]);
  });

  it("works in a GBP administration: USD and EUR go through the EUR cross rate", () => {
    const t = sumInBase(TABLE, "GBP", [
      { currency: "GBP", minor: 5_000 },
      { currency: "USD", minor: 10_000 },
      { currency: "EUR", minor: 10_000 },
    ]);
    // 5000 + 8035 (USD) + 8720 (100 EUR * 0.872)
    expect(t.totalMinor).toBe(21_755n);
    // the oldest leg wins: the GBP rate is from 6 Nov
    expect(t.rateDate).toBe("2026-11-06");
  });

  it("a credit note reduces the total", () => {
    const t = sumInBase(TABLE, "EUR", [
      { currency: "USD", minor: 10_000 },
      { currency: "USD", minor: -4_000 },
    ]);
    // 6000 / 1.0853 = 55.2840 EUR -> 5528
    expect(t.totalMinor).toBe(5_528n);
  });

  it("has no date and nothing converted for base-currency amounts only", () => {
    const t = sumInBase(TABLE, "EUR", [{ currency: "EUR", minor: 700 }]);
    expect(t).toMatchObject({ totalMinor: 700n, converted: false, rateDate: null });
  });

  it("keeps exact value for amounts beyond 2^53 (BigInt all the way)", () => {
    const big = 90_071_992_547_409_930n; // > 2^53
    const t = sumInBase(TABLE, "EUR", [{ currency: "EUR", minor: big }]);
    expect(t.totalMinor).toBe(big);
  });
});

describe("rateDateFor and rateText", () => {
  it("takes the oldest non-EUR leg", () => {
    expect(rateDateFor(TABLE, ["USD", "GBP"])).toBe("2026-11-06");
    expect(rateDateFor(TABLE, ["USD", "EUR"])).toBe("2026-11-10");
    expect(rateDateFor(TABLE, ["EUR"])).toBeNull();
  });
  it("shows the ECB number for a EUR administration and a cross rate otherwise", () => {
    expect(rateText(TABLE, "USD", "EUR")).toBe("rate 1,0853");
    expect(rateText(TABLE, "USD", "GBP")).toBe("1 USD = 0,803464 GBP");
    expect(rateText(NO_GBP, "USD", "GBP")).toBeNull();
  });
});

describe("differences against the booked amount (ADR 0035 sign convention)", () => {
  const ARGS = { currency: "USD", base: "EUR" } as const;

  it("receivable worth more today: positive difference, a gain", () => {
    const d = differenceOf(TABLE, {
      ...ARGS,
      kind: "invoice",
      openMinor: 10_000,
      bookedMinor: 9_000,
    });
    expect(d).toMatchObject({
      ok: true,
      todayMinor: 9_214n,
      differenceMinor: 214n,
      resultMinor: 214n,
    });
    expect(norm(differenceSentence("invoice", 10_000, 214n, "EUR"))).toBe(
      "You would receive € 2,14 more than booked.",
    );
  });

  it("payable worth more today: positive difference, a loss", () => {
    const d = differenceOf(TABLE, { ...ARGS, kind: "bill", openMinor: 10_000, bookedMinor: 9_000 });
    expect(d).toMatchObject({ ok: true, differenceMinor: 214n, resultMinor: -214n });
    expect(norm(differenceSentence("bill", 10_000, 214n, "EUR"))).toBe(
      "You would pay € 2,14 more than booked.",
    );
    expect(resultWord(-214n)).toBe("unrealised loss");
  });

  it("worth less today: the words say less", () => {
    const d = differenceOf(TABLE, {
      ...ARGS,
      kind: "invoice",
      openMinor: 10_000,
      bookedMinor: 9_500,
    });
    expect(d).toMatchObject({ ok: true, differenceMinor: -286n, resultMinor: -286n });
    expect(norm(differenceSentence("invoice", 10_000, -286n, "EUR"))).toBe(
      "You would receive € 2,86 less than booked.",
    );
    expect(norm(differenceSentence("bill", 10_000, -286n, "EUR"))).toBe(
      "You would pay € 2,86 less than booked.",
    );
  });

  it("a sales credit note: negative amounts, today's value is more negative, you refund more", () => {
    const d = differenceOf(TABLE, {
      ...ARGS,
      kind: "invoice",
      openMinor: -10_000,
      bookedMinor: -9_000,
    });
    expect(d).toMatchObject({
      ok: true,
      todayMinor: -9_214n,
      differenceMinor: -214n,
      resultMinor: -214n,
    });
    expect(norm(differenceSentence("invoice", -10_000, -214n, "EUR"))).toBe(
      "You would refund € 2,14 more than booked.",
    );
  });

  it("a purchase credit note with the same figures is a gain: you get back more", () => {
    const d = differenceOf(TABLE, {
      ...ARGS,
      kind: "bill",
      openMinor: -10_000,
      bookedMinor: -9_000,
    });
    expect(d).toMatchObject({ ok: true, differenceMinor: -214n, resultMinor: 214n });
    expect(norm(differenceSentence("bill", -10_000, -214n, "EUR"))).toBe(
      "You would get back € 2,14 more than booked.",
    );
    expect(resultWord(214n)).toBe("unrealised gain");
  });

  it("no difference", () => {
    expect(differenceSentence("invoice", 100, 0n, "EUR")).toBe(
      "No difference from the booked amount.",
    );
    expect(resultWord(0n)).toBe("no unrealised result");
  });

  it("an unknown booked amount is not 0", () => {
    expect(
      differenceOf(TABLE, { ...ARGS, kind: "invoice", openMinor: 10_000, bookedMinor: null }),
    ).toEqual({ ok: false, reason: "booked_unknown" });
  });

  it("a missing rate is reported before the booked amount", () => {
    expect(
      differenceOf(NO_GBP, {
        currency: "GBP",
        base: "EUR",
        kind: "invoice",
        openMinor: 100,
        bookedMinor: null,
      }),
    ).toEqual({ ok: false, reason: "missing_rate" });
  });

  it("in a GBP administration the difference is in pence", () => {
    // 100 USD booked at 80,00 GBP; today 80,35 GBP
    const d = differenceOf(TABLE, {
      currency: "USD",
      base: "GBP",
      kind: "invoice",
      openMinor: 10_000,
      bookedMinor: 8_000,
    });
    expect(d).toMatchObject({ ok: true, todayMinor: 8_035n, differenceMinor: 35n });
  });

  it("signs the figure", () => {
    expect(norm(signedMoney(214n, "EUR"))).toBe("+€ 2,14");
    expect(norm(signedMoney(-214n, "EUR"))).toMatch(/^-€ 2,14$|^€ -2,14$/);
    expect(norm(signedMoney(0n, "EUR"))).toBe("€ 0,00");
  });
});

describe("rates response", () => {
  const resp = (over: Partial<FxRatesResponse> = {}): FxRatesResponse => ({
    base: "EUR",
    asOf: "2026-11-06",
    rates: [
      { currency: "USD", rate: "1.0853", rateDate: "2026-11-06", source: "ECB" },
      { currency: "GBP", rate: "0.872", rateDate: "2026-11-05", source: "ECB" },
    ],
    stale: false,
    staleReason: null,
    workingDaysOld: 0,
    lastImportAt: null,
    lastImportStatus: null,
    notice: "n",
    ...over,
  });

  it("builds the table with each currency's own date", () => {
    const t = rateTableFromResponse(resp());
    expect(t).toEqual({
      asOf: "2026-11-06",
      base: "EUR",
      rates: { USD: "1.0853", GBP: "0.872" },
      ratesDate: { USD: "2026-11-06", GBP: "2026-11-05" },
    });
    expect(rateTableFromResponse(null)).toBeNull();
  });

  it("words the stale chip", () => {
    expect(staleChipText(resp())).toBeNull();
    expect(
      staleChipText(
        resp({ stale: true, staleReason: "older_than_one_working_day", workingDaysOld: 1 }),
      ),
    ).toBe("Rates from 6 Nov, one working day old");
    expect(
      staleChipText(
        resp({ stale: true, staleReason: "older_than_one_working_day", workingDaysOld: 3 }),
      ),
    ).toBe("Rates from 6 Nov, 3 working days old");
    expect(
      staleChipText(resp({ asOf: null, rates: [], stale: true, staleReason: "never_imported" })),
    ).toBe("No ECB rates imported yet");
  });
});

describe("ageingTotalsInBase", () => {
  const totals = (currency: string, buckets: Partial<Record<string, number>>, total: number) =>
    ({
      currency,
      totalMinor: total,
      count: 1,
      bucketCounts: {
        not_due: 1,
        d1_30: 1,
        d31_60: 0,
        d61_90: 0,
        d90_plus: 0,
        no_due_date: 0,
      },
      buckets: {
        not_due: 0,
        d1_30: 0,
        d31_60: 0,
        d61_90: 0,
        d90_plus: 0,
        no_due_date: 0,
        ...buckets,
      },
    }) as never;
  const currencies = [
    { currency: "EUR", totals: totals("EUR", { not_due: 1_000 }, 1_000), rows: [] },
    { currency: "USD", totals: totals("USD", { not_due: 10_000, d1_30: 5 }, 10_005), rows: [] },
    { currency: "GBP", totals: totals("GBP", { d90_plus: 500 }, 500), rows: [] },
  ] as never;

  it("converts each currency's bucket once and adds; lists the currency without a rate", () => {
    const t = ageingTotalsInBase(NO_GBP, "EUR", currencies);
    expect(t?.cells.not_due.totalMinor).toBe(1_000n + 9_214n);
    // 5 minor units USD alone: 4.6 cents -> 5
    expect(t?.cells.d1_30.totalMinor).toBe(5n);
    // 10.005 / 1.0853 = 9218.6... -> 9219 (+ 1000 EUR)
    expect(t?.cells.total.totalMinor).toBe(1_000n + 9_219n);
    expect(t?.excluded).toEqual(["GBP"]);
    expect(t?.rateDate).toBe("2026-11-10");
    // three currencies with an item each in not due and 1-30; none in 31-60
    expect(t?.counts.not_due).toBe(3);
    expect(t?.counts.d31_60).toBe(0);
  });

  it("is null when every currency is the base currency", () => {
    expect(
      ageingTotalsInBase(TABLE, "EUR", [
        { currency: "EUR", totals: totals("EUR", {}, 0), rows: [] },
      ] as never),
    ).toBeNull();
  });
});

describe("chart geometry: integer maths", () => {
  it("scales rates to integers without a float", () => {
    expect(scaledRate("1.0853")).toBe(1_085_300_000_000n);
    expect(scaledRate("165.5")).toBe(165_500_000_000_000n);
    expect(scaledRate("nope")).toBeNull();
  });

  it("puts the highest rate at the top and the lowest at the bottom", () => {
    const g = chartGeometry(
      [
        { rateDate: "2026-11-04", rate: "1.1" },
        { rateDate: "2026-11-05", rate: "1.2" },
        { rateDate: "2026-11-06", rate: "1.15" },
      ],
      { width: 600, height: 160 },
    );
    expect(g.points.map((p) => [p.x, p.y])).toEqual([
      [0n, 160n],
      [300n, 0n],
      [600n, 80n],
    ]);
    expect(g.path).toBe("M0 160 L300 0 L600 80");
    expect(g.min).toBe("1.1");
    expect(g.max).toBe("1.2");
    expect(g.lowest?.rateDate).toBe("2026-11-04");
    expect(g.highest?.rateDate).toBe("2026-11-05");
  });

  it("centres a flat series and survives one point or none", () => {
    const flat = chartGeometry(
      [
        { rateDate: "2026-11-04", rate: "1.1" },
        { rateDate: "2026-11-05", rate: "1.1" },
      ],
      { width: 600, height: 160 },
    );
    expect(flat.points.map((p) => p.y)).toEqual([80n, 80n]);
    expect(
      chartGeometry([{ rateDate: "2026-11-04", rate: "1.1" }], { width: 600, height: 160 }).path,
    ).toBe("M300 80");
    expect(chartGeometry([], { width: 600, height: 160 }).points).toEqual([]);
  });
});
