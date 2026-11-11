import { describe, expect, it } from "vitest";
import {
  type RateTable,
  convertMinor,
  crossRate,
  formatRateForDisplay,
  bookedAtRate,
  isRateDirection,
  parseRate,
  unrealisedDifference,
} from "./fx";

const table: RateTable = {
  asOf: "2026-03-13",
  base: "EUR",
  rates: {
    USD: "1.0853",
    GBP: "0.8571",
    JPY: "162.45",
    KWD: "0.3345",
    BHD: "0.4091",
    CHF: "0.9712",
    SEK: "11.2",
  },
};

/** Seeded PRNG (mulberry32), deterministic across runs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const conv = (a: bigint | number, from: string, to: string, t = table): bigint => {
  const r = convertMinor({ amountMinor: a, from, to, table: t });
  if (!r.ok) throw new Error(r.error);
  return r.amountMinor;
};
const abs = (x: bigint): bigint => (x < 0n ? -x : x);

describe("parseRate", () => {
  it.each([
    ["1.0853", "1.0853"],
    ["1", "1"],
    ["1.0", "1"],
    ["1.085300", "1.0853"],
    ["01.5", "1.5"],
    ["0001", "1"],
    ["0.5", "0.5"],
    ["0.000000000001", "0.000000000001"],
    ["123456789012", "123456789012"],
    ["162.45", "162.45"],
  ])("accepts %s -> %s", (input, out) => {
    expect(parseRate(input)).toEqual({ ok: true, rate: out });
  });

  it.each([
    "",
    "1e5",
    "1E5",
    "+1",
    "-1",
    " 1",
    "1 ",
    "1,5",
    ".5",
    "5.",
    "1.2.3",
    "0x10",
    "NaN",
    "Infinity",
    "1_000",
    "１.５",
    "0",
    "0.0",
    "000.000",
    "0.0000000000001",
    "1.1234567890123",
    "1234567890123",
  ])("rejects %j", (input) => {
    expect(parseRate(input).ok).toBe(false);
  });

  it("names the failure", () => {
    expect(parseRate("0")).toEqual({ ok: false, error: "not_positive" });
    expect(parseRate("1e5")).toEqual({ ok: false, error: "bad_format" });
    expect(parseRate("1.1234567890123")).toEqual({ ok: false, error: "too_many_decimals" });
    expect(parseRate("1234567890123")).toEqual({ ok: false, error: "too_large" });
    expect(parseRate(1 as unknown as string)).toEqual({ ok: false, error: "not_a_string" });
  });
});

describe("convertMinor", () => {
  it("EUR to X uses r", () => {
    // 100.00 EUR * 1.0853 = 108.53 USD
    const r = convertMinor({ amountMinor: 10000, from: "EUR", to: "USD", table });
    expect(r).toEqual({ ok: true, amountMinor: 10853n, rateUsed: "1.0853" });
  });
  it("X to EUR uses 1/r with one rounding", () => {
    // 108.53 / 1.0853 = 100.00
    expect(conv(10853, "USD", "EUR")).toBe(10000n);
    // 100.00 USD / 1.0853 = 92.1403...
    expect(conv(10000, "USD", "EUR")).toBe(9214n);
  });
  it("cross rate USD to GBP", () => {
    // 100.00 USD -> 100/1.0853*0.8571 = 78.9736...
    const r = convertMinor({ amountMinor: 10000, from: "USD", to: "GBP", table });
    expect(r).toEqual({ ok: true, amountMinor: 7897n, rateUsed: "0.789735556989" });
  });
  it("rounds half away from zero, once", () => {
    const t: RateTable = { asOf: "2026-01-02", base: "EUR", rates: { XXA: "0.5", JPY: "100" } };
    // 0.01 EUR * 0.5 = 0.005 -> 0.01 (away from zero), and -0.005 -> -0.01
    expect(conv(1, "EUR", "XXA", t)).toBe(1n);
    expect(conv(-1, "EUR", "XXA", t)).toBe(-1n);
    // 1.25 EUR -> JPY 125 exactly
    expect(conv(125, "EUR", "JPY", t)).toBe(125n);
    expect(conv(1, "XXA", "EUR", t)).toBe(2n);
  });
  it("respects target scale: JPY 0, KWD and BHD 3", () => {
    expect(conv(10000, "EUR", "JPY")).toBe(16245n); // 100 EUR = 16245 yen
    expect(conv(16245, "JPY", "EUR")).toBe(10000n);
    expect(conv(10000, "EUR", "KWD")).toBe(33450n); // 33.450 KWD
    expect(conv(33450, "KWD", "EUR")).toBe(10000n);
    expect(conv(1000, "KWD", "BHD")).toBe(1223n); // 1.000 KWD = 1.2231 BHD
    // 100000 JPY / 162.45 * 0.3345 = 205.910 KWD (checked against Python Fractions)
    expect(conv(100000, "JPY", "KWD")).toBe(205910n);
  });
  it("same currency is exact and needs no rate", () => {
    const empty: RateTable = { asOf: "2026-01-02", base: "EUR", rates: {} };
    expect(convertMinor({ amountMinor: 123, from: "ZZZ", to: "ZZZ", table: empty })).toEqual({
      ok: true,
      amountMinor: 123n,
      rateUsed: "1",
    });
    expect(conv(-5n, "USD", "USD")).toBe(-5n);
    expect(conv(0, "EUR", "EUR")).toBe(0n);
  });
  it("same currency with an invalid code is still refused", () => {
    expect(convertMinor({ amountMinor: 1, from: "usd", to: "usd", table })).toEqual({
      ok: false,
      error: "missing_rate",
    });
  });
  it("missing or malformed rates", () => {
    expect(convertMinor({ amountMinor: 1, from: "EUR", to: "XYZ", table })).toEqual({
      ok: false,
      error: "missing_rate",
    });
    expect(convertMinor({ amountMinor: 1, from: "XYZ", to: "EUR", table })).toEqual({
      ok: false,
      error: "missing_rate",
    });
    const bad: RateTable = { asOf: "2026-01-02", base: "EUR", rates: { USD: "1e5", GBP: "0" } };
    expect(convertMinor({ amountMinor: 1, from: "EUR", to: "USD", table: bad }).ok).toBe(false);
    expect(convertMinor({ amountMinor: 1, from: "EUR", to: "GBP", table: bad }).ok).toBe(false);
  });
  it("does not read inherited properties as rates", () => {
    for (const code of ["constructor".toUpperCase().slice(0, 3), "toString"]) {
      expect(convertMinor({ amountMinor: 1, from: "EUR", to: code, table }).ok).toBe(false);
    }
    const t = { asOf: "2026-01-02", base: "EUR", rates: {} } as RateTable;
    expect(convertMinor({ amountMinor: 1, from: "EUR", to: "USD", table: t }).ok).toBe(false);
  });
  it("an explicit EUR entry in the table is ignored", () => {
    const t: RateTable = { ...table, rates: { ...table.rates, EUR: "2" } };
    expect(conv(100, "EUR", "USD", t)).toBe(109n);
  });
  it("amount validation", () => {
    const e = (a: number | bigint) =>
      convertMinor({ amountMinor: a, from: "EUR", to: "USD", table });
    expect(e(1.5)).toEqual({ ok: false, error: "bad_amount" });
    expect(e(Number.NaN)).toEqual({ ok: false, error: "bad_amount" });
    expect(e(Number.POSITIVE_INFINITY)).toEqual({ ok: false, error: "bad_amount" });
    expect(e(2 ** 53)).toEqual({ ok: false, error: "unsafe_number" });
    expect(e(-(2 ** 60))).toEqual({ ok: false, error: "unsafe_number" });
    expect(e("5" as unknown as number)).toEqual({ ok: false, error: "bad_amount" });
    expect(e(Number.MAX_SAFE_INTEGER).ok).toBe(true);
  });
  it("huge amounts via bigint stay exact", () => {
    const big = 10n ** 29n + 7n;
    expect(conv(big, "EUR", "USD")).toBe((big * 10853n + 5000n) / 10000n);
    // 10^29 * 1.0853 = 1.0853e29 exactly (the +7 contributes 7.5971 -> rounds with the rest)
    expect(conv(10n ** 29n, "EUR", "USD")).toBe(10853n * 10n ** 25n);
    expect(conv(-(10n ** 29n), "EUR", "USD")).toBe(-(10853n * 10n ** 25n));
    expect(conv(2n ** 60n, "EUR", "EUR")).toBe(2n ** 60n);
    expect(conv(10n ** 30n - 1n, "EUR", "EUR")).toBe(10n ** 30n - 1n);
  });
  it("refuses bigints of 10^30 or more (no crafted giant products)", () => {
    for (const a of [10n ** 30n, -(10n ** 30n), 10n ** 100000n]) {
      expect(convertMinor({ amountMinor: a, from: "EUR", to: "USD", table })).toEqual({
        ok: false,
        error: "bad_amount",
      });
    }
  });
  it("rateUsed is the 12 dp cross rate", () => {
    const r = convertMinor({ amountMinor: 1, from: "USD", to: "GBP", table });
    expect(r.ok && r.rateUsed).toBe("0.789735556989");
  });
});

describe("crossRate", () => {
  it("is 1 for equal currencies and r for EUR", () => {
    expect(crossRate("USD", "USD", table)).toBe("1");
    expect(crossRate("EUR", "EUR", table)).toBe("1");
    expect(crossRate("EUR", "USD", table)).toBe("1.0853");
    expect(crossRate("USD", "EUR", table)).toBe("0.921404220031");
  });
  it("is null for missing rates and tiny results", () => {
    expect(crossRate("EUR", "XYZ", table)).toBeNull();
    expect(crossRate("XYZ", "EUR", table)).toBeNull();
    const t: RateTable = {
      asOf: "2026-01-02",
      base: "EUR",
      rates: { AAA: "0.000000000001", BBB: "999999999999" },
    };
    expect(crossRate("BBB", "AAA", t)).toBeNull();
  });
});

describe("properties (seeded)", () => {
  const rnd = prng(20260313);
  const codes = ["USD", "GBP", "JPY", "KWD", "BHD", "CHF", "SEK"];
  const pick = () => codes[Math.floor(rnd() * codes.length)] ?? "USD";
  const amount = () => BigInt(Math.floor((rnd() - 0.5) * 2e9));

  it("X -> EUR -> X is bounded by the EUR rounding error scaled back by the rate", () => {
    for (let i = 0; i < 2000; i++) {
      const x = pick();
      const a = amount();
      const eur = conv(a, x, "EUR");
      const back = conv(eur, "EUR", x);
      // EUR rounding error <= 0.5 cent, scaled back by the rate (in target minor units).
      const r = BigInt(Math.ceil(Number(table.rates[x])));
      const scaleUp = x === "JPY" ? 1n : x === "KWD" || x === "BHD" ? 10n : 1n;
      const bound = (r * scaleUp) / 2n + 1n;
      expect(abs(back - a) <= bound).toBe(true);
    }
  });
  it("EUR -> USD -> EUR is within one cent (rate > 1)", () => {
    for (let i = 0; i < 1000; i++) {
      const a = amount();
      expect(abs(conv(conv(a, "EUR", "USD"), "USD", "EUR") - a) <= 1n).toBe(true);
    }
  });
  it("sign symmetry", () => {
    for (let i = 0; i < 1000; i++) {
      const a = amount();
      const from = pick();
      const to = pick();
      expect(conv(-a, from, to)).toBe(-conv(a, from, to));
    }
  });
  it("sum of conversions differs from conversion of sum by at most n/2 units", () => {
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rnd() * 20);
      const parts = Array.from({ length: n }, amount);
      const to = pick();
      const sumOfConv = parts.reduce((s, p) => s + conv(p, "EUR", to), 0n);
      const convOfSum = conv(
        parts.reduce((s, p) => s + p, 0n),
        "EUR",
        to,
      );
      expect(abs(sumOfConv - convOfSum) <= BigInt(n)).toBe(true);
    }
  });
  it("from === to is the identity", () => {
    for (let i = 0; i < 200; i++) {
      const a = amount();
      const c = pick();
      expect(conv(a, c, c)).toBe(a);
    }
  });
  it("conversion is monotone in the amount", () => {
    for (let i = 0; i < 500; i++) {
      const a = amount();
      const b = a + BigInt(Math.floor(rnd() * 1000));
      const from = pick();
      const to = pick();
      expect(conv(a, from, to) <= conv(b, from, to)).toBe(true);
    }
  });
});

describe("unrealisedDifference", () => {
  it("is today minus booked, positive when base value rose", () => {
    // 1000.00 USD booked at 920.00 EUR; today 1000/1.0853 = 921.40
    const r = unrealisedDifference({
      openMinor: 100000,
      currency: "USD",
      bookedBaseMinor: 92000,
      baseCurrency: "EUR",
      table,
    });
    expect(r).toEqual({
      ok: true,
      todayBaseMinor: 92140n,
      bookedBaseMinor: 92000n,
      differenceMinor: 140n,
      impliedBookedRate: "0.92",
    });
  });
  it("negative balances (credit notes) keep their sign", () => {
    const r = unrealisedDifference({
      openMinor: -100000n,
      currency: "USD",
      bookedBaseMinor: -92000n,
      baseCurrency: "EUR",
      table,
    });
    expect(r).toMatchObject({ ok: true, differenceMinor: -140n, impliedBookedRate: "0.92" });
  });
  it("same currency as base has no difference", () => {
    const r = unrealisedDifference({
      openMinor: 5000,
      currency: "EUR",
      bookedBaseMinor: 5000,
      baseCurrency: "EUR",
      table,
    });
    expect(r).toMatchObject({ ok: true, differenceMinor: 0n, impliedBookedRate: "1" });
  });
  it("scale-aware implied rate (JPY booked in EUR)", () => {
    const r = unrealisedDifference({
      openMinor: 162450,
      currency: "JPY",
      bookedBaseMinor: 100000,
      baseCurrency: "EUR",
      table,
    });
    expect(r).toMatchObject({ ok: true, todayBaseMinor: 100000n, differenceMinor: 0n });
    expect(r.ok && r.impliedBookedRate).toBe("0.006155740228");
  });
  it("zero open amount, or sign mismatch, gives no implied rate", () => {
    expect(
      unrealisedDifference({
        openMinor: 0,
        currency: "USD",
        bookedBaseMinor: 0,
        baseCurrency: "EUR",
        table,
      }),
    ).toMatchObject({ ok: true, differenceMinor: 0n, impliedBookedRate: null });
    expect(
      unrealisedDifference({
        openMinor: 100,
        currency: "USD",
        bookedBaseMinor: -5,
        baseCurrency: "EUR",
        table,
      }),
    ).toMatchObject({ ok: true, impliedBookedRate: null });
  });
  it("errors", () => {
    const base = { currency: "USD", baseCurrency: "EUR", table };
    expect(unrealisedDifference({ ...base, openMinor: 1, bookedBaseMinor: null })).toEqual({
      ok: false,
      error: "booked_unknown",
    });
    expect(
      unrealisedDifference({ ...base, currency: "XYZ", openMinor: 1, bookedBaseMinor: 1 }),
    ).toEqual({
      ok: false,
      error: "missing_rate",
    });
    expect(unrealisedDifference({ ...base, openMinor: 1.5, bookedBaseMinor: 1 })).toEqual({
      ok: false,
      error: "bad_amount",
    });
    expect(unrealisedDifference({ ...base, openMinor: 2 ** 60, bookedBaseMinor: 1 })).toEqual({
      ok: false,
      error: "bad_amount",
    });
    expect(unrealisedDifference({ ...base, openMinor: 1, bookedBaseMinor: 0.5 })).toEqual({
      ok: false,
      error: "bad_amount",
    });
  });
});

describe("formatRateForDisplay", () => {
  it("rounds half away from zero and strips zeros", () => {
    expect(formatRateForDisplay("1.0853")).toBe("1.0853");
    expect(formatRateForDisplay("0.921404220031")).toBe("0.921404");
    expect(formatRateForDisplay("0.921404220031", 4)).toBe("0.9214");
    expect(formatRateForDisplay("1.00000049", 6)).toBe("1");
    expect(formatRateForDisplay("0.5", 0)).toBe("1");
    expect(formatRateForDisplay("162.45", 0)).toBe("162");
    expect(formatRateForDisplay("1.5", 20)).toBe("1.5");
  });
  it("returns unusable input unchanged", () => {
    expect(formatRateForDisplay("abc")).toBe("abc");
    expect(formatRateForDisplay("1.5", -1)).toBe("1.5");
    expect(formatRateForDisplay("1.5", 1.5)).toBe("1.5");
  });
});

describe("bookedAtRate (ADR 0038, option 3)", () => {
  it("base_per_foreign multiplies, foreign_per_base divides, rounding once half away from zero", () => {
    // USD 1,000.00 at 0.92 EUR per USD = EUR 920.00
    expect(
      bookedAtRate({
        openMinor: 100000,
        currency: "USD",
        baseCurrency: "EUR",
        rate: "0.92",
        direction: "base_per_foreign",
      }),
    ).toBe(92000n);
    // USD 1,000.00 at 1.25 USD per EUR = EUR 800.00
    expect(
      bookedAtRate({
        openMinor: 100000,
        currency: "USD",
        baseCurrency: "EUR",
        rate: "1.25",
        direction: "foreign_per_base",
      }),
    ).toBe(80000n);
    // tie: 0.01 USD * 0.5 = 0.005 EUR -> 0.01 away from zero; negative mirrors
    const t = (n: number) =>
      bookedAtRate({
        openMinor: n,
        currency: "USD",
        baseCurrency: "EUR",
        rate: "0.5",
        direction: "base_per_foreign",
      });
    expect(t(1)).toBe(1n);
    expect(t(-1)).toBe(-1n);
    expect(t(3)).toBe(2n);
  });

  it("respects currency scales (JPY has none)", () => {
    // JPY 10,000 at 0.0062 EUR per JPY = EUR 62.00
    expect(
      bookedAtRate({
        openMinor: 10000,
        currency: "JPY",
        baseCurrency: "EUR",
        rate: "0.0062",
        direction: "base_per_foreign",
      }),
    ).toBe(6200n);
    // EUR 62.00 in a JPY division at 161.29 JPY per EUR
    expect(
      bookedAtRate({
        openMinor: 6200,
        currency: "EUR",
        baseCurrency: "JPY",
        rate: "161.29",
        direction: "base_per_foreign",
      }),
    ).toBe(10000n);
  });

  it("returns null for bad input and the amount for the same currency", () => {
    const base = {
      openMinor: 100,
      currency: "USD",
      baseCurrency: "EUR",
      direction: "base_per_foreign" as const,
    };
    expect(bookedAtRate({ ...base, rate: "0" })).toBeNull();
    expect(bookedAtRate({ ...base, rate: "-1" })).toBeNull();
    expect(bookedAtRate({ ...base, rate: "1e3" })).toBeNull();
    expect(bookedAtRate({ ...base, rate: "1", currency: "us" })).toBeNull();
    expect(bookedAtRate({ ...base, rate: "1", openMinor: 1.5 })).toBeNull();
    expect(bookedAtRate({ ...base, rate: "1", currency: "EUR" })).toBe(100n);
  });

  it("isRateDirection accepts exactly the two values", () => {
    expect(isRateDirection("base_per_foreign")).toBe(true);
    expect(isRateDirection("foreign_per_base")).toBe(true);
    expect(isRateDirection("x")).toBe(false);
    expect(isRateDirection(null)).toBe(false);
  });
});

describe("bookedAtRate: review of T1 (hand-computed, scales, hostile rates, oracle)", () => {
  const b = (
    openMinor: number | bigint,
    currency: string,
    baseCurrency: string,
    rate: string,
    direction: "base_per_foreign" | "foreign_per_base",
  ) => bookedAtRate({ openMinor, currency, baseCurrency, rate, direction });

  it("USD 1,234.56 both ways, worked by hand", () => {
    // 1,234.56 x 0.92 = 1,135.7952 -> EUR 1,135.80
    expect(b(123456, "USD", "EUR", "0.92", "base_per_foreign")).toBe(113580n);
    // 1,234.56 / 1.0870 = 1,135.74977... -> EUR 1,135.75
    expect(b(123456, "USD", "EUR", "1.0870", "foreign_per_base")).toBe(113575n);
    // trailing zeros and the same rate without them are one value
    expect(b(123456, "USD", "EUR", "1.087", "foreign_per_base")).toBe(113575n);
    // credit note: odd in the sign
    expect(b(-123456, "USD", "EUR", "0.92", "base_per_foreign")).toBe(-113580n);
    expect(b(-123456, "USD", "EUR", "1.0870", "foreign_per_base")).toBe(-113575n);
    expect(b(0, "USD", "EUR", "0.92", "base_per_foreign")).toBe(0n);
  });

  it("JPY (0 decimals) and KWD (3 decimals), worked by hand", () => {
    // JPY 123,456 x 0.0061 = 753.0816 -> EUR 753.08
    expect(b(123456, "JPY", "EUR", "0.0061", "base_per_foreign")).toBe(75308n);
    // JPY 123,456 / 163.25 = 756.23736... -> EUR 756.24
    expect(b(123456, "JPY", "EUR", "163.25", "foreign_per_base")).toBe(75624n);
    // KWD 1.234 / 0.3345 = 3.68908... -> EUR 3.69
    expect(b(1234, "KWD", "EUR", "0.3345", "foreign_per_base")).toBe(369n);
    // KWD 1.234 x 2.99 = 3.68966 -> EUR 3.69
    expect(b(1234, "KWD", "EUR", "2.99", "base_per_foreign")).toBe(369n);
    // EUR 10.00 in a KWD division at 0.3345 KWD per EUR (base_per_foreign from the item's view)
    // = KWD 3.345 exactly
    expect(b(1000, "EUR", "KWD", "0.3345", "base_per_foreign")).toBe(3345n);
    // EUR 10.00 in a JPY division at 163.255 JPY per EUR = 1,632.55 -> JPY 1,633 (half away)
    expect(b(1000, "EUR", "JPY", "163.255", "base_per_foreign")).toBe(1633n);
    expect(b(-1000, "EUR", "JPY", "163.255", "base_per_foreign")).toBe(-1633n);
  });

  it("huge amounts stay exact (BigInt), no float anywhere", () => {
    // 90,071,992,547,409.91 USD (2^53 - 1 cents) x 0.92 = 82,866,233,143,617.1172 -> .12
    expect(b(BigInt(Number.MAX_SAFE_INTEGER), "USD", "EUR", "0.92", "base_per_foreign")).toBe(
      8286623314361712n,
    );
    // beyond the supported money range: null, never a wrapped or float-rounded number
    expect(b(10n ** 30n, "USD", "EUR", "0.5", "base_per_foreign")).toBeNull();
  });

  it("hostile rate strings give null (parsed by core parseRate only)", () => {
    for (const rate of [
      "",
      " 0.92",
      "0.92 ",
      "+0.92",
      "-0.92",
      "0",
      "0.0000",
      "1e3",
      "0x10",
      "Infinity",
      "NaN",
      "0.92.1",
      ".92",
      "92.",
      "1,087",
      "１.0",
      "1".repeat(5000),
      "0." + "0".repeat(5000) + "1",
    ]) {
      expect(b(100, "USD", "EUR", rate, "base_per_foreign"), JSON.stringify(rate)).toBeNull();
      expect(b(100, "USD", "EUR", rate, "foreign_per_base"), JSON.stringify(rate)).toBeNull();
    }
  });

  it("matches an independent rational oracle on many random cases (one rounding only)", () => {
    // Oracle: the major-unit amount and the rate as exact fractions, multiplied or divided, then
    // scaled to minor units and rounded half away from zero ONCE.
    const scale: Record<string, number> = { USD: 2, EUR: 2, JPY: 0, KWD: 3, GBP: 2 };
    const roundHalfAway = (num: bigint, den: bigint): bigint => {
      const neg = num < 0n !== den < 0n;
      const n = num < 0n ? -num : num;
      const d = den < 0n ? -den : den;
      const q = (2n * n + d) / (2n * d);
      return neg ? -q : q;
    };
    let x = 12345;
    const rnd = () => {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      return x;
    };
    const codes = Object.keys(scale);
    for (let i = 0; i < 2000; i++) {
      const cur = codes[rnd() % codes.length] as string;
      let base = codes[rnd() % codes.length] as string;
      if (base === cur) base = cur === "EUR" ? "USD" : "EUR";
      const amount = BigInt(rnd() % 100_000_000) * (rnd() % 2 === 0 ? 1n : -1n);
      const intPart = rnd() % 300;
      const decimals = rnd() % 7;
      const frac = decimals === 0 ? "" : String(rnd() % 10 ** decimals).padStart(decimals, "0");
      const rate = decimals === 0 ? String(intPart || 1) : `${intPart}.${frac}`;
      const [ri, rf = ""] = rate.split(".");
      const rNum = BigInt((ri as string) + rf);
      const rDen = 10n ** BigInt(rf.length);
      if (rNum === 0n) continue;
      const sf = 10n ** BigInt(scale[cur] as number);
      const sb = 10n ** BigInt(scale[base] as number);
      const dir = rnd() % 2 === 0 ? "base_per_foreign" : "foreign_per_base";
      // amount/sf major units; x rate or / rate; x sb minor units of the base
      const want =
        dir === "base_per_foreign"
          ? roundHalfAway(amount * rNum * sb, sf * rDen)
          : roundHalfAway(amount * rDen * sb, sf * rNum);
      expect(b(amount, cur, base, rate, dir), `${amount} ${cur}->${base} ${rate} ${dir}`).toBe(
        want,
      );
    }
  });
});
