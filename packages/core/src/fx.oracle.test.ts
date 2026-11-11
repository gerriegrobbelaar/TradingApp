/**
 * Independent oracle for the FX maths (review of F1). Nothing here imports `decimal.ts`: rates
 * become exact fractions (numerator / denominator bigints) by our own parser, conversion is one
 * rational expression, and rounding half away from zero is done as floor((2|p| + q) / 2q),
 * a different algorithm from `divRound`. Thousands of seeded cases, compared exactly.
 */
import { describe, expect, it } from "vitest";
import {
  type RateTable,
  convertMinor,
  crossRate,
  unrealisedDifference,
  unrealisedResultMinor,
} from "./fx";

// ---------------------------------------------------------------- oracle (no shared code)

interface Frac {
  n: bigint;
  d: bigint; // > 0
}
const SCALE: Record<string, number> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0,
  ISK: 0,
  IDR: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  CLF: 4,
};
const tenTo = (k: number): bigint => {
  let r = 1n;
  for (let i = 0; i < k; i++) r *= 10n;
  return r;
};
function fracOf(rate: string): Frac {
  const dot = rate.indexOf(".");
  if (dot < 0) return { n: BigInt(rate), d: 1n };
  const fracDigits = rate.length - dot - 1;
  return { n: BigInt(rate.slice(0, dot) + rate.slice(dot + 1)), d: tenTo(fracDigits) };
}
/** Round p/q (q > 0) half away from zero. */
function roundHalfAway(p: bigint, q: bigint): bigint {
  if (q <= 0n) throw new Error("oracle: q must be positive");
  if (p >= 0n) return (2n * p + q) / (2n * q);
  return -((2n * -p + q) / (2n * q));
}
function rateFrac(code: string, rates: Record<string, string>): Frac {
  if (code === "EUR") return { n: 1n, d: 1n };
  const r = rates[code];
  if (r === undefined) throw new Error(`oracle: no rate ${code}`);
  return fracOf(r);
}
/** Exact value of the converted amount, in target minor units, as p/q. */
function exactConv(a: bigint, from: string, to: string, rates: Record<string, string>): Frac {
  const rf = rateFrac(from, rates);
  const rt = rateFrac(to, rates);
  const sf = SCALE[from] ?? 2;
  const st = SCALE[to] ?? 2;
  // a / 10^sf  (major from) / (rf.n/rf.d)  (EUR) * (rt.n/rt.d)  (major to) * 10^st
  return { n: a * rf.d * rt.n * tenTo(st), d: tenTo(sf) * rf.n * rt.d };
}
function oracleConv(a: bigint, from: string, to: string, rates: Record<string, string>): bigint {
  if (from === to) return a;
  const e = exactConv(a, from, to, rates);
  return roundHalfAway(e.n, e.d);
}
/** p/q > 0 to 12 dp half away, trailing zeros stripped; null when it rounds to 0 or below. */
function oracleRate12(p: bigint, q: bigint): string | null {
  const scaled = roundHalfAway(p * tenTo(12), q);
  if (scaled <= 0n) return null;
  const whole = scaled / tenTo(12);
  let frac = (scaled % tenTo(12)).toString();
  while (frac.length < 12) frac = `0${frac}`;
  while (frac.endsWith("0")) frac = frac.slice(0, -1);
  return frac === "" ? whole.toString() : `${whole.toString()}.${frac}`;
}
function oracleCross(from: string, to: string, rates: Record<string, string>): string | null {
  if (from === to) return "1";
  const rf = rateFrac(from, rates);
  const rt = rateFrac(to, rates);
  return oracleRate12(rt.n * rf.d, rt.d * rf.n);
}

// ---------------------------------------------------------------- seeded generators

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
const rnd = prng(0xf1f1);
const int = (n: number): number => Math.floor(rnd() * n);
const digits = (k: number): string => Array.from({ length: k }, () => String(int(10))).join("");
const pickOf = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;

/** A random positive canonical rate: 1-12 fraction digits or none, magnitude 1e-12 .. 1e12. */
function randomRate(): string {
  const kind = int(6);
  let s: string;
  if (kind === 0)
    s = pickOf(["1.0853", "162.45", "0.8571", "0.3345", "17100.5", "1450.2", "150.3"]);
  else if (kind === 1)
    s = `0.${digits(int(12))}${1 + int(9)}`; // tiny, down to 1e-12
  else if (kind === 2)
    s = `${1 + int(9)}${digits(int(5))}.${digits(1 + int(4))}`; // 1 .. 1e6, ECB-like
  else if (kind === 3)
    s = `${1 + int(9)}${digits(int(12))}`.slice(0, 12); // large integer
  else if (kind === 4)
    s = `${1 + int(9)}${digits(int(11))}.${digits(int(12))}${1 + int(9)}`.slice(0, 25);
  else s = pickOf(["0.0001", "40000", "17000", "1500", "0.000000000001", "999999999999"]);
  // canonical form (the table holds parseRate output; strip zeros the same way it would)
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  const [w, f = ""] = s.split(".");
  if ((f ?? "").length > 12)
    s = `${w}.${(f ?? "").slice(0, 12)}`.replace(/0+$/, "").replace(/\.$/, "");
  return /^0*(\.0*)?$/.test(s) ? "1" : s;
}
function randomAmount(): bigint {
  const kind = int(8);
  if (kind === 0) return 0n;
  if (kind === 1) return pickOf([1n, -1n]);
  const sign = rnd() < 0.5 ? -1n : 1n;
  if (kind === 2) return sign * BigInt(int(1000));
  if (kind === 3) return sign * BigInt(int(2 ** 31));
  if (kind === 4) return sign * BigInt(`${1 + int(9)}${digits(15 + int(4))}`); // 10^15 .. 10^19
  if (kind === 5) return sign * BigInt(`${1 + int(9)}${digits(20 + int(8))}`); // up to 10^28
  if (kind === 6) return sign * BigInt(Number.MAX_SAFE_INTEGER);
  return sign * BigInt(int(1e6));
}
const CODES = Object.keys(SCALE);

function tableOf(rates: Record<string, string>): RateTable {
  return { asOf: "2026-11-10", base: "EUR", rates };
}

// ---------------------------------------------------------------- tests

describe("oracle: convertMinor and crossRate over seeded random cases", () => {
  it("match the rational oracle exactly (5,000 cases, all scales, signs, magnitudes)", () => {
    let compared = 0;
    for (let i = 0; i < 5000; i++) {
      const rates: Record<string, string> = {};
      for (const c of CODES) if (c !== "EUR") rates[c] = randomRate();
      const from = pickOf(CODES);
      const to = pickOf(CODES);
      const a = randomAmount();
      const t = tableOf(rates);
      const want = oracleCross(from, to, rates);
      expect(crossRate(from, to, t), `${from}->${to} ${JSON.stringify(rates)}`).toBe(want);
      const got = convertMinor({ amountMinor: a, from, to, table: t });
      if (want === null) {
        expect(got).toEqual({ ok: false, error: "rate_out_of_range" });
        continue;
      }
      expect(got, `${a} ${from}->${to} ${rates[from]} ${rates[to]}`).toEqual({
        ok: true,
        amountMinor: oracleConv(a, from, to, rates),
        rateUsed: want,
      });
      compared++;
    }
    expect(compared).toBeGreaterThan(4000);
  });

  it("number and bigint inputs agree for safe integers", () => {
    for (let i = 0; i < 1000; i++) {
      const rates = { USD: randomRate(), JPY: randomRate(), KWD: randomRate() };
      const from = pickOf(["EUR", "USD", "JPY", "KWD"]);
      const to = pickOf(["EUR", "USD", "JPY", "KWD"]);
      const n = (rnd() < 0.5 ? -1 : 1) * int(Number.MAX_SAFE_INTEGER);
      const t = tableOf(rates);
      const viaNumber = convertMinor({ amountMinor: n, from, to, table: t });
      const viaBig = convertMinor({ amountMinor: BigInt(n), from, to, table: t });
      expect(viaNumber).toEqual(viaBig);
    }
  });

  it("unrealisedDifference matches the oracle (today - booked, implied rate booked/open)", () => {
    for (let i = 0; i < 2000; i++) {
      const cur = pickOf(CODES.filter((c) => c !== "EUR"));
      const base = pickOf(["EUR", "EUR", "USD", "JPY", "KWD"]);
      const rates: Record<string, string> = {};
      for (const c of CODES) if (c !== "EUR") rates[c] = randomRate();
      const open = randomAmount();
      const booked = rnd() < 0.1 ? 0n : randomAmount();
      const t = tableOf(rates);
      const r = unrealisedDifference({
        openMinor: open,
        currency: cur,
        bookedBaseMinor: booked,
        baseCurrency: base,
        table: t,
      });
      if (cur !== base && oracleCross(cur, base, rates) === null) {
        expect(r).toEqual({ ok: false, error: "rate_out_of_range" });
        continue;
      }
      const today = oracleConv(open, cur, base, rates);
      const so = SCALE[cur] ?? 2;
      const sb = SCALE[base] ?? 2;
      let implied: string | null = null;
      if (open !== 0n) {
        // (booked / 10^sb) / (open / 10^so), made positive-denominator
        let p = booked * tenTo(so);
        let q = open * tenTo(sb);
        if (q < 0n) {
          p = -p;
          q = -q;
        }
        implied = p > 0n ? oracleRate12(p, q) : null;
      }
      expect(r).toEqual({
        ok: true,
        todayBaseMinor: today,
        bookedBaseMinor: booked,
        differenceMinor: today - booked,
        impliedBookedRate: implied,
      });
    }
  });
});

describe("rounding rule: half away from zero, once, at the end", () => {
  const conv = (a: bigint, from: string, to: string, rates: Record<string, string>): bigint => {
    const r = convertMinor({ amountMinor: a, from, to, table: tableOf(rates) });
    if (!r.ok) throw new Error(r.error);
    return r.amountMinor;
  };
  it.each([
    // 1 cent EUR at rate r gives r cents of USD exactly
    ["0.5", 1n, 1n],
    ["0.5", -1n, -1n],
    ["1.5", 1n, 2n],
    ["1.5", -1n, -2n],
    ["2.5", 1n, 3n],
    ["2.5", -1n, -3n],
    ["0.4999", 1n, 0n],
    ["0.4999", -1n, 0n],
    ["0.5001", -1n, -1n],
  ])("EUR -> USD at %s: %s cent -> %s", (rate, a, want) => {
    expect(conv(a, "EUR", "USD", { USD: rate })).toBe(want);
  });
  it("ties in a 0-decimal target (JPY) and a 3-decimal target (KWD)", () => {
    expect(conv(1n, "EUR", "JPY", { JPY: "50" })).toBe(1n); // 0.5 yen
    expect(conv(-1n, "EUR", "JPY", { JPY: "50" })).toBe(-1n);
    expect(conv(1n, "EUR", "JPY", { JPY: "250" })).toBe(3n); // 2.5 yen
    expect(conv(1n, "EUR", "KWD", { KWD: "0.05" })).toBe(1n); // 0.0005 KWD = 0.5 fils
    expect(conv(-5n, "EUR", "KWD", { KWD: "0.05" })).toBe(-3n); // -2.5 fils
  });
  it("no intermediate rounding through EUR on a cross conversion", () => {
    // 1 US cent at USD 4, GBP 3: 0.25 EUR cent (would round to 0) -> exactly 0.75 GBP pence -> 1.
    expect(conv(1n, "USD", "GBP", { USD: "4", GBP: "3" })).toBe(1n);
    expect(conv(-1n, "USD", "GBP", { USD: "4", GBP: "3" })).toBe(-1n);
    // 3 yen at JPY 200, KWD 0.3: 0.015 EUR -> 4.5 fils exactly -> 5 (via rounded EUR 0.02 it would be 6).
    expect(conv(3n, "JPY", "KWD", { JPY: "200", KWD: "0.3" })).toBe(5n);
  });
  it("cross-rate direction: ECB rates are units per 1 EUR", () => {
    const rates = { USD: "1.25", GBP: "0.8" };
    expect(conv(10000n, "USD", "EUR", rates)).toBe(8000n); // 100 USD / 1.25 = 80 EUR
    expect(conv(8000n, "EUR", "USD", rates)).toBe(10000n); // 80 EUR * 1.25
    expect(conv(10000n, "USD", "GBP", rates)).toBe(6400n); // 100 / 1.25 * 0.8
    expect(crossRate("USD", "GBP", tableOf(rates))).toBe("0.64");
    expect(crossRate("GBP", "USD", tableOf(rates))).toBe("1.5625");
  });
});

describe("double-conversion drift is bounded by the two roundings", () => {
  it("X -> Y -> X differs from X by at most 1/2 + 1/(2k), k = target minor units per source minor unit", () => {
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const rates: Record<string, string> = {};
      for (const c of CODES) if (c !== "EUR") rates[c] = randomRate();
      const x = pickOf(CODES);
      const y = pickOf(CODES.filter((c) => c !== x));
      if (oracleCross(x, y, rates) === null || oracleCross(y, x, rates) === null) continue;
      const a = randomAmount() % 10n ** 18n; // so the round trip stays below the 10^30 cap
      const t = tableOf(rates);
      const there = convertMinor({ amountMinor: a, from: x, to: y, table: t });
      if (!there.ok) throw new Error(there.error);
      if (there.amountMinor >= 10n ** 30n || there.amountMinor <= -(10n ** 30n)) continue;
      const back = convertMinor({ amountMinor: there.amountMinor, from: y, to: x, table: t });
      if (!back.ok) throw new Error(back.error);
      checked++;
      // k = exact y-minor per x-minor = kn/kd. |back - a| <= 1/2 + 1/(2k)
      //   <=> 2 |back - a| * kn <= kn + kd
      const k = exactConv(1n, x, y, rates);
      const drift = back.amountMinor - a;
      const absDrift = drift < 0n ? -drift : drift;
      expect(2n * absDrift * k.n <= k.n + k.d, `${a} ${x}->${y}->${x}`).toBe(true);
    }
    expect(checked).toBeGreaterThan(2000);
  });
});

describe("unrealisedDifference sign convention for every open-item kind", () => {
  // USD 1.0 per EUR booked; today USD = 0.9 (USD strengthened against EUR)
  const today = tableOf({ USD: "0.9" });
  const run = (openMinor: bigint, bookedBaseMinor: bigint) => {
    const r = unrealisedDifference({
      openMinor,
      currency: "USD",
      bookedBaseMinor,
      baseCurrency: "EUR",
      table: today,
    });
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  it("receivable (invoice) of +100 USD booked at 90 EUR, today worth 92 EUR: +2 EUR, a gain", () => {
    const r = unrealisedDifference({
      openMinor: 10000n,
      currency: "USD",
      bookedBaseMinor: 9000n,
      baseCurrency: "EUR",
      table: tableOf({ USD: "1.086956521739" }), // 100 / 1.0869... = 92.00
    });
    expect(r).toMatchObject({ ok: true, todayBaseMinor: 9200n, differenceMinor: 200n });
    expect(r.ok && unrealisedResultMinor("invoice", r.differenceMinor)).toBe(200n);
    expect(r.ok && r.impliedBookedRate).toBe("0.9"); // EUR per 1 USD, as booked
  });
  it("payable (bill) is positive in open_items too: worth more today is a loss", () => {
    const r = run(9000n, 9000n); // 90 USD booked at 90 EUR, today 100 EUR
    expect(r.differenceMinor).toBe(1000n);
    expect(unrealisedResultMinor("bill", r.differenceMinor)).toBe(-1000n);
  });
  it("credit notes are negative and flip naturally", () => {
    const sales = run(-9000n, -9000n); // sales credit note: we owe 90 USD, now 100 EUR
    expect(sales.differenceMinor).toBe(-1000n);
    expect(unrealisedResultMinor("invoice", sales.differenceMinor)).toBe(-1000n); // loss
    expect(sales.impliedBookedRate).toBe("1");
    const purchase = run(-9000n, -9000n); // purchase credit note: supplier owes us 100 EUR now
    expect(unrealisedResultMinor("bill", purchase.differenceMinor)).toBe(1000n); // gain
  });
  it("zero difference has no sign", () => {
    expect(unrealisedResultMinor("bill", 0n)).toBe(0n);
    expect(Object.is(unrealisedResultMinor("bill", 0n), 0n)).toBe(true);
  });
  it("refuses an unknown kind", () => {
    expect(() => unrealisedResultMinor("x" as "bill", 1n)).toThrow(RangeError);
  });
  it("implied rate is null when open is 0, booked is 0, signs differ, or it rounds to 0", () => {
    expect(run(0n, 500n).impliedBookedRate).toBeNull();
    expect(run(0n, 500n).differenceMinor).toBe(-500n);
    expect(run(100n, 0n).impliedBookedRate).toBeNull();
    expect(run(100n, -100n).impliedBookedRate).toBeNull();
    expect(run(-100n, 100n).impliedBookedRate).toBeNull();
    const tiny = unrealisedDifference({
      openMinor: 10n ** 28n,
      currency: "USD",
      bookedBaseMinor: 1n,
      baseCurrency: "EUR",
      table: today,
    });
    expect(tiny.ok && tiny.impliedBookedRate).toBeNull();
  });
});

describe("hostile tables", () => {
  const conv = (rates: unknown, from = "USD", to = "EUR") =>
    convertMinor({
      amountMinor: 100,
      from,
      to,
      table: { asOf: "2026-11-10", base: "EUR", rates } as RateTable,
    });
  it("prototype keys and inherited properties are never rates", () => {
    for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(conv({}, code)).toEqual({ ok: false, error: "missing_rate" });
      expect(crossRate(code, "EUR", tableOf({}))).toBeNull();
    }
    expect(conv(JSON.parse('{"__proto__":{"USD":"1.1"}}'))).toEqual({
      ok: false,
      error: "missing_rate",
    });
    expect(conv(Object.create({ USD: "1.1" }))).toEqual({ ok: false, error: "missing_rate" });
    expect(conv(Object.assign(Object.create(null), { USD: "1.25" }))).toEqual({
      ok: true,
      amountMinor: 80n,
      rateUsed: "0.8",
    });
  });
  it("non-string values, getters, and missing rates objects are missing", () => {
    for (const v of [1.1, 2n, null, true, ["1.1"], { toString: () => "1.1" }]) {
      expect(conv({ USD: v })).toEqual({ ok: false, error: "missing_rate" });
    }
    let reads = 0;
    const withGetter = Object.defineProperty({}, "USD", {
      enumerable: true,
      get: () => {
        reads++;
        return "1.1";
      },
    });
    expect(conv(withGetter)).toEqual({ ok: false, error: "missing_rate" });
    expect(reads).toBe(0);
    for (const rates of [null, undefined, "USD=1.1", 5]) {
      expect(conv(rates)).toEqual({ ok: false, error: "missing_rate" });
    }
    expect(
      convertMinor({ amountMinor: 1, from: "USD", to: "EUR", table: null as unknown as RateTable }),
    ).toEqual({ ok: false, error: "missing_rate" });
  });
  it("malformed rate strings in the table are missing, never parsed loosely", () => {
    for (const v of [
      "1e3",
      "-1.1",
      " 1.1",
      "0",
      "NaN",
      "Infinity",
      "١٫١",
      "１.１",
      "1.1234567890123",
    ]) {
      expect(conv({ USD: v })).toEqual({ ok: false, error: "missing_rate" });
    }
  });
  it("the table is not mutated", () => {
    const rates = { USD: "1.25" };
    const t = Object.freeze({ ...tableOf(Object.freeze(rates)) });
    expect(conv(rates).ok).toBe(true);
    expect(convertMinor({ amountMinor: 1, from: "USD", to: "EUR", table: t }).ok).toBe(true);
    expect(rates).toEqual({ USD: "1.25" });
  });
  it("rate_out_of_range when the cross rate is below 12 dp", () => {
    const rates = { AAA: "0.000000000001", BBB: "999999999999" };
    expect(conv(rates, "BBB", "AAA")).toEqual({ ok: false, error: "rate_out_of_range" });
    expect(conv(rates, "AAA", "BBB").ok).toBe(true);
  });
});
