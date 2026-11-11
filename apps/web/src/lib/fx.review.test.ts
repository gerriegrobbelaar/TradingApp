/**
 * Review F3: the screen-side FX helpers checked against an INDEPENDENT calculation. The oracle
 * below shares no code with core: rates are read digit by digit into a fraction, the amount is
 * converted as one exact fraction and rounded half away from zero by comparing twice the
 * remainder with the denominator (core divides with a different algorithm). Expected values were
 * also worked out by hand (comments) so the oracle itself is checked.
 */
import { describe, expect, it } from "vitest";
import type { AgeingReportResponse, RateTable } from "@camelthorn/core";
import { norm } from "../test-norm";
import {
  ageingTotalsInBase,
  differenceOf,
  differenceSentence,
  resultWord,
  sumInBase,
  toBase,
} from "./fx";

const TABLE: RateTable = {
  asOf: "2026-11-10",
  base: "EUR",
  rates: { USD: "1.0853", GBP: "0.872", JPY: "165.5", KWD: "0.3333" },
  ratesDate: { USD: "2026-11-10", GBP: "2026-11-06", JPY: "2026-11-10", KWD: "2026-11-10" },
};
const SCALE: Record<string, number> = { EUR: 2, USD: 2, GBP: 2, JPY: 0, KWD: 3 };

/** "1.0853" -> [10853n, 10000n]; plain decimal only. */
function frac(rate: string): [bigint, bigint] {
  const [i, f = ""] = rate.split(".");
  let num = 0n;
  for (const ch of `${i}${f}`) num = num * 10n + BigInt(ch.charCodeAt(0) - 48);
  let den = 1n;
  for (let k = 0; k < f.length; k += 1) den *= 10n;
  return [num, den];
}
const pow10 = (n: number) => {
  let p = 1n;
  for (let k = 0; k < n; k += 1) p *= 10n;
  return p;
};
/** Units per EUR as a fraction; EUR itself is 1/1. */
const perEur = (c: string): [bigint, bigint] =>
  c === "EUR" ? [1n, 1n] : frac(TABLE.rates[c] as string);

/** amount (minor of `from`) -> minor of `to`: a / 10^sf / r_from * r_to * 10^st, one rounding. */
function oracle(minor: bigint, from: string, to: string): bigint {
  const [fn, fd] = perEur(from);
  const [tn, td] = perEur(to);
  const num = minor * fd * tn * pow10(SCALE[to] as number);
  const den = pow10(SCALE[from] as number) * fn * td;
  const neg = num < 0n;
  const n = neg ? -num : num;
  let q = n / den;
  if ((n - q * den) * 2n >= den) q += 1n;
  return neg ? -q : q;
}

const conv = (minor: number | bigint, from: string, to: string) => {
  const r = toBase(TABLE, minor, from, to);
  if (!r.ok) throw new Error(`no conversion ${from} ${to}`);
  return r.minor;
};

describe("conversions against an independent fraction calculation", () => {
  const cases: [string, bigint, string, string, bigint][] = [
    // 1.234,56 USD / 1.0853 = 1.137,5288 EUR
    ["USD receivable 1,234.56 to EUR", 123_456n, "USD", "EUR", 113_753n],
    // 987,65 GBP / 0.872 = 1.132,6261 EUR
    ["GBP payable 987.65 to EUR", 98_765n, "GBP", "EUR", 113_263n],
    // 1.234.567 JPY (no minor unit) / 165.5 = 7.459,6193 EUR
    ["JPY 1,234,567 to EUR", 1_234_567n, "JPY", "EUR", 745_962n],
    // 12,345 KWD (3 decimals) / 0.3333 = 37,0387 EUR
    ["KWD 12.345 to EUR", 12_345n, "KWD", "EUR", 3_704n],
    // 100,00 EUR * 0.3333 = 33,330 KWD (fils)
    ["EUR 100 to KWD", 10_000n, "EUR", "KWD", 33_330n],
    // a GBP administration with a USD item: 1.234,56 * 0.872 / 1.0853 = 991,9295 GBP
    ["USD 1,234.56 in a GBP administration", 123_456n, "USD", "GBP", 99_193n],
    // credit note: the mirror image (half away from zero, not half up)
    ["USD credit note -500.00 to EUR", -50_000n, "USD", "EUR", -46_070n],
  ];
  for (const [name, minor, from, to, want] of cases) {
    it(name, () => {
      expect(oracle(minor, from, to)).toBe(want); // the hand figure
      expect(conv(minor, from, to)).toBe(want);
    });
  }

  it("USD to GBP is ONE conversion with one rounding, not USD -> EUR (rounded) -> GBP", () => {
    // 1,05 USD: 1.05 * 0.872 / 1.0853 = 0,8436 GBP -> 84 pence. Two steps would be
    // 1,05 / 1.0853 = 0,97 EUR (rounded) * 0.872 = 0,8458 -> 85 pence.
    expect(conv(105, "USD", "GBP")).toBe(84n);
    const twoStep = oracle(oracle(105n, "USD", "EUR"), "EUR", "GBP");
    expect(twoStep).toBe(85n);
  });

  it("rounds half away from zero, once", () => {
    // 1 JPY = 1/165.5 EUR = 0,604 cent -> 1 cent; -1 JPY -> -1 cent (not 0, not -0)
    expect(conv(1, "JPY", "EUR")).toBe(1n);
    expect(conv(-1, "JPY", "EUR")).toBe(-1n);
    // an exact half: 1 fils of KWD with a table where 1 KWD = 2 EUR... use EUR -> KWD:
    // 0,01 EUR * 0.3333 = 0,003333 KWD = 3,333 fils -> 3; 0,15 EUR = 49,995 fils -> 50
    expect(conv(15, "EUR", "KWD")).toBe(50n);
    expect(conv(-15, "EUR", "KWD")).toBe(-50n);
  });

  it("agrees with the oracle over a spread of amounts, signs and currencies", () => {
    const codes = ["EUR", "USD", "GBP", "JPY", "KWD"];
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 2_000; i += 1) {
      const from = codes[next() % codes.length] as string;
      const to = codes[next() % codes.length] as string;
      const magnitude = BigInt(next()) * BigInt(next() % 1000);
      const minor = next() % 2 === 0 ? magnitude : -magnitude;
      expect(conv(minor, from, to), `${minor} ${from}->${to}`).toBe(
        from === to ? minor : oracle(minor, from, to),
      );
    }
  });

  it("stays exact above 2^53", () => {
    const big = 2n ** 60n + 7n;
    expect(conv(big, "USD", "EUR")).toBe(oracle(big, "USD", "EUR"));
    expect(conv(big, "USD", "EUR")).toBe(1_062_306_739_709_616_680n);
    const t = sumInBase(TABLE, "EUR", [
      { currency: "USD", minor: big },
      { currency: "USD", minor: big },
    ]);
    expect(t.totalMinor).toBe(oracle(2n * big, "USD", "EUR"));
  });
});

describe("sumInBase: add per currency first, convert once per currency, then add (ADR 0037)", () => {
  it("equals the oracle of each currency's raw sum, not the sum of item conversions", () => {
    const parts = [
      { currency: "USD", minor: 5 },
      { currency: "USD", minor: 5 },
      { currency: "GBP", minor: 3 },
      { currency: "GBP", minor: 3 },
      { currency: "GBP", minor: 3 },
      { currency: "GBP", minor: 3 },
      { currency: "EUR", minor: 1 },
    ];
    const t = sumInBase(TABLE, "EUR", parts);
    // 0,10 USD = 9,21 cents -> 9; 0,12 GBP = 13,76 cents -> 14; plus 1 cent EUR = 24
    const want = oracle(10n, "USD", "EUR") + oracle(12n, "GBP", "EUR") + 1n;
    expect(want).toBe(24n);
    expect(t.totalMinor).toBe(want);
    // item by item: 2 x 5 cents (4,6 -> 5) + 4 x 3 cents (3,44 -> 3) + 1 = 23: not what is shown
    const itemByItem = 2n * oracle(5n, "USD", "EUR") + 4n * oracle(3n, "GBP", "EUR") + 1n;
    expect(itemByItem).toBe(23n);
    // the oldest rate used (GBP of 6 Nov) is the date shown
    expect(t.rateDate).toBe("2026-11-06");
  });

  it("never throws on an amount that is not a safe integer: the currency is left out and named", () => {
    const t = sumInBase(TABLE, "EUR", [
      { currency: "USD", minor: 1.5 },
      { currency: "USD", minor: 100 },
      { currency: "GBP", minor: Number.MAX_SAFE_INTEGER + 2 },
      { currency: "JPY", minor: 1000 },
    ]);
    expect(t.invalid.sort()).toEqual(["GBP", "USD"]);
    expect(t.included).toEqual(["JPY"]);
    expect(t.totalMinor).toBe(oracle(1000n, "JPY", "EUR"));
    expect(t.excluded).toEqual([]);
  });

  it("an ageing currency missing from one bucket's conversion is named once", () => {
    const zero = { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, no_due_date: 0 };
    const cur = (currency: string, buckets: typeof zero) =>
      ({
        currency,
        totals: {
          buckets,
          bucketCounts: { ...zero, not_due: 1 },
          totalMinor: Object.values(buckets).reduce((a, b) => a + b, 0),
          count: 1,
          dcMinor: 0,
          dcComplete: false,
        },
      }) as unknown as AgeingReportResponse["currencies"][number];
    const noGbp: RateTable = { ...TABLE, rates: { USD: "1.0853" } };
    const t = ageingTotalsInBase(noGbp, "EUR", [
      cur("USD", { ...zero, not_due: 10_000 }),
      cur("GBP", { ...zero, not_due: 7_000 }),
    ]);
    expect(t?.excluded).toEqual(["GBP"]);
    expect(t?.invalid).toEqual([]);
    expect(t?.cells.not_due.totalMinor).toBe(oracle(10_000n, "USD", "EUR"));
  });
});

describe("difference direction and words, every case", () => {
  // [kind, open USD minor, booked EUR minor, expected sentence, expected result word]
  // today's value of 500,00 USD = 460,70 EUR; of -500,00 USD = -460,70 EUR.
  const cases: [string, "invoice" | "bill", number, number, string, string][] = [
    [
      "receivable, worth more",
      "invoice",
      50_000,
      45_000,
      "You would receive € 10,70 more than booked.",
      "unrealised gain",
    ],
    [
      "receivable, worth less",
      "invoice",
      50_000,
      47_000,
      "You would receive € 9,30 less than booked.",
      "unrealised loss",
    ],
    [
      "payable, costs more",
      "bill",
      50_000,
      45_000,
      "You would pay € 10,70 more than booked.",
      "unrealised loss",
    ],
    [
      "payable, costs less",
      "bill",
      50_000,
      47_000,
      "You would pay € 9,30 less than booked.",
      "unrealised gain",
    ],
    [
      "sales credit note, refund more",
      "invoice",
      -50_000,
      -45_000,
      "You would refund € 10,70 more than booked.",
      "unrealised loss",
    ],
    [
      "sales credit note, refund less",
      "invoice",
      -50_000,
      -47_000,
      "You would refund € 9,30 less than booked.",
      "unrealised gain",
    ],
    [
      "purchase credit note, get back more",
      "bill",
      -50_000,
      -45_000,
      "You would get back € 10,70 more than booked.",
      "unrealised gain",
    ],
    [
      "purchase credit note, get back less",
      "bill",
      -50_000,
      -47_000,
      "You would get back € 9,30 less than booked.",
      "unrealised loss",
    ],
  ];
  for (const [name, kind, open, booked, sentence, word] of cases) {
    it(name, () => {
      const d = differenceOf(TABLE, {
        kind,
        openMinor: open,
        currency: "USD",
        bookedMinor: booked,
        base: "EUR",
      });
      if (!d.ok) throw new Error("expected a difference");
      // difference = today's value minus booked (ADR 0035), checked against the oracle
      expect(d.differenceMinor).toBe(oracle(BigInt(open), "USD", "EUR") - BigInt(booked));
      expect(norm(differenceSentence(kind, open, d.differenceMinor, "EUR"))).toBe(sentence);
      expect(resultWord(d.resultMinor)).toBe(word);
    });
  }

  it("zero difference has no direction and no result", () => {
    const d = differenceOf(TABLE, {
      kind: "invoice",
      openMinor: 50_000,
      currency: "USD",
      bookedMinor: 46_070,
      base: "EUR",
    });
    expect(d).toMatchObject({ ok: true, differenceMinor: 0n, resultMinor: 0n });
    for (const k of ["invoice", "bill"] as const) {
      for (const open of [50_000, -50_000]) {
        expect(differenceSentence(k, open, 0n, "EUR")).toBe(
          "No difference from the booked amount.",
        );
      }
    }
  });

  it("a booked amount that is not known is never treated as 0", () => {
    expect(
      differenceOf(TABLE, {
        kind: "invoice",
        openMinor: 50_000,
        currency: "USD",
        bookedMinor: null,
        base: "EUR",
      }),
    ).toEqual({ ok: false, reason: "booked_unknown" });
  });
});
