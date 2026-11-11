/** Adversarial input for the rate parser, the ECB CSV parser and buildRateTable (review of F1). */
import { describe, expect, it } from "vitest";
import {
  ECB_MAX_CSV_BYTES,
  ECB_MAX_CSV_CHARS,
  ECB_MAX_RATE_AGE_TARGET_DAYS,
  ECB_MAX_ROW_CHARS,
  type EcbObservation,
  buildRateTable,
  ecbRequestUrl,
  parseEcbCsv,
  utf8ByteLength,
} from "./ecb";
import { convertMinor, parseRate } from "./fx";
import { MAX_DECIMAL_DIGITS, parseDecimal } from "./decimal";

const H = "CURRENCY,TIME_PERIOD,OBS_VALUE";
const ok = (text: string) => {
  const r = parseEcbCsv(text);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("parseRate hostile input", () => {
  it.each([
    "١٫٥", // Arabic-Indic digits and separator
    "١.٥",
    "۱.۵", // extended Arabic-Indic
    "１.５", // full-width
    "1.５",
    "𝟏.𝟓", // mathematical bold digits
    "1 ", // nbsp
    "​1", // zero width space
    "1.0\n",
    "1\u0000",
    "0.0",
    "0.000000000000",
    "0000000000000000.0000",
  ])("rejects %j", (s) => {
    expect(parseRate(s).ok).toBe(false);
  });
  it("accepts the extremes of the documented range", () => {
    expect(parseRate("0.000000000001")).toEqual({ ok: true, rate: "0.000000000001" });
    expect(parseRate("999999999999.999999999999")).toEqual({
      ok: true,
      rate: "999999999999.999999999999",
    });
    expect(parseRate("0000999999999999")).toEqual({ ok: true, rate: "999999999999" });
    expect(parseRate("1000000000000")).toEqual({ ok: false, error: "too_large" });
    expect(parseRate("1.0000000000000")).toEqual({ ok: false, error: "too_many_decimals" });
    expect(parseRate("00")).toEqual({ ok: false, error: "not_positive" });
  });
  it("is linear: megabyte inputs are refused at once", () => {
    const inputs = [
      `1.${"0".repeat(1_000_000)}1`, // the old /0+$/ backtracked quadratically on this
      `${"0".repeat(1_000_000)}1`,
      "9".repeat(1_000_000),
      `1.${"0".repeat(1_000_000)}`,
      "1".repeat(1_000_000) + "x",
    ];
    const t0 = performance.now();
    for (const s of inputs) expect(parseRate(s)).toEqual({ ok: false, error: "too_long" });
    expect(performance.now() - t0).toBeLessThan(5000); // runaway guard, not a benchmark
  });
  it("is idempotent on its own output", () => {
    for (const s of ["01.50", "1.0853000", "000.000000000001", "162.450", "7"]) {
      const a = parseRate(s);
      if (!a.ok) throw new Error(s);
      expect(parseRate(a.rate)).toEqual(a);
    }
  });
});

describe("parseDecimal limits", () => {
  it("rejects digit bombs before building a bigint", () => {
    expect(parseDecimal(`1${"0".repeat(1_000_000)}`)).toBeNull();
    expect(parseDecimal("9".repeat(MAX_DECIMAL_DIGITS))).not.toBeNull();
    expect(parseDecimal("9".repeat(MAX_DECIMAL_DIGITS + 1))).toBeNull();
    expect(parseDecimal(`-${"9".repeat(30)}.${"9".repeat(30)}`)).not.toBeNull();
    expect(parseDecimal("١")).toBeNull();
  });
});

describe("parseEcbCsv real-world variations", () => {
  it("CR-only line endings and a BOM", () => {
    const r = ok(`\ufeff${H}\rUSD,2026-03-13,1.0853\rJPY,2026-03-13,162.45\r`);
    expect(r.observations).toHaveLength(2);
  });
  it("quoted fields with commas and newlines in other columns", () => {
    const text = `KEY,CURRENCY,TITLE,TIME_PERIOD,OBS_VALUE\r\nk,USD,"US dollar, ""USD""\r\nsecond line",2026-03-13,1.0853\r\n`;
    expect(ok(text).observations).toEqual([
      { currency: "USD", rateDate: "2026-03-13", rate: "1.0853" },
    ]);
  });
  it("trailing commas, extra columns and missing optional columns", () => {
    const r = ok(`${H},EXTRA,\nUSD,2026-03-13,1.0853,x,\nGBP,2026-03-13,0.85,,,,,\n`);
    expect(r.observations.map((o) => o.currency)).toEqual(["GBP", "USD"]);
  });
  it("a trailing comma at the very end of the input", () => {
    expect(ok(`${H}\nUSD,2026-03-13,1.0853,`).observations).toHaveLength(1);
  });
  it("duplicate names of a required column are refused as ambiguous", () => {
    expect(parseEcbCsv("CURRENCY,TIME_PERIOD,OBS_VALUE,obs_value\nUSD,2026-03-13,1,2\n")).toEqual({
      ok: false,
      error: "ambiguous_columns",
    });
  });
  it("duplicate names of an unused column are harmless", () => {
    expect(ok(`TITLE,${H},TITLE\nx,USD,2026-03-13,1.08,y\n`).observations).toHaveLength(1);
  });
  it("only daily, real calendar dates", () => {
    const rows = [
      "USD,2026-11,1.1",
      "USD,2026-Q1,1.1",
      "USD,2026-W01,1.1",
      "USD,2026,1.1",
      "USD,2026-02-29,1.1",
      "USD,2025-02-29,1.1",
      "USD,2026-04-31,1.1",
      "USD,2026-13-01,1.1",
      "USD,2026-3-13,1.1",
      "USD,13/03/2026,1.1",
      "USD,2026-03-13T00:00:00,1.1",
      "USD,2024-02-29,1.2", // leap day: kept
    ];
    const r = ok(`${H}\n${rows.join("\n")}\n`);
    expect(r.observations).toEqual([{ currency: "USD", rateDate: "2024-02-29", rate: "1.2" }]);
    expect(r.skipped).toBe(11);
  });
  it("skips bad observation values and bad codes", () => {
    const vals = ["NaN", "-", "", "1e3", "-1.1", "0", "0.0000", " ", '"1,1"', "Inf"];
    const codes = ["usd", "EUR", "US", "USDX", "U5D", "ÜSD"];
    const text = [
      H,
      ...vals.map((v) => `USD,2026-03-13,${v}`),
      ...codes.map((c) => `${c},2026-03-13,1.1`),
      "GBP,2026-03-13,0.85",
    ].join("\n");
    const r = ok(text);
    expect(r.observations).toEqual([{ currency: "GBP", rateDate: "2026-03-13", rate: "0.85" }]);
    expect(r.skipped).toBe(vals.length + codes.length);
  });
  it("present optional columns must be D / EUR / SP00 / A", () => {
    const hdr = "FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE";
    const r = ok(
      [
        hdr,
        "D,USD,EUR,SP00,A,2026-03-13,1.0853",
        "M,USD,EUR,SP00,A,2026-03-13,1.2",
        "D,USD,USD,SP00,A,2026-03-13,1.2",
        "D,USD,EUR,SP00,E,2026-03-13,1.2",
        "D,USD,EUR,EN00,A,2026-03-13,1.2",
      ].join("\n"),
    );
    expect(r.observations).toEqual([{ currency: "USD", rateDate: "2026-03-13", rate: "1.0853" }]);
    expect(r.skipped).toBe(4);
  });
  it("a row longer than the per-row cap is skipped and counted", () => {
    const long = `USD,2026-03-13,1.0853,${"x".repeat(ECB_MAX_ROW_CHARS)}`;
    const r = ok(`${H}\n${long}\nGBP,2026-03-13,0.85\n`);
    expect(r.observations.map((o) => o.currency)).toEqual(["GBP"]);
    expect(r.skipped).toBe(1);
  });
  it("a megabyte OBS_VALUE is skipped quickly (no backtracking)", () => {
    const t0 = performance.now();
    const r = ok(`${H}\nUSD,2026-03-13,1.${"0".repeat(1_000_000)}1\nGBP,2026-03-13,0.85\n`);
    expect(performance.now() - t0).toBeLessThan(5000); // runaway guard, not a benchmark
    expect(r.skipped).toBe(1);
  });
});

describe("parseEcbCsv size limits in bytes", () => {
  it("measures UTF-8 bytes", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("€")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("\ud800")).toBe(3); // lone surrogate -> U+FFFD
    expect(utf8ByteLength("\ud800x")).toBe(4);
    const s = "a€😀é\udc00";
    expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length);
    expect(ECB_MAX_CSV_CHARS).toBe(ECB_MAX_CSV_BYTES);
  });
  it("refuses multi-byte text under the char count but over the byte cap", () => {
    // 2 M euro signs: 2 M UTF-16 units (under the cap) but 6 MB of UTF-8.
    const text = `${H}\nUSD,2026-03-13,1.08,${"€".repeat(2 * 1024 * 1024)}\n`;
    expect(text.length).toBeLessThan(ECB_MAX_CSV_BYTES);
    expect(parseEcbCsv(text)).toEqual({ ok: false, error: "too_large" });
  });
  it("accepts exactly the cap and refuses one byte more", () => {
    const head = `${H}\nUSD,2026-03-13,1.08\n`;
    const pad = (n: number) => head + "\n".repeat(n - head.length);
    expect(parseEcbCsv(pad(ECB_MAX_CSV_BYTES)).ok).toBe(true);
    expect(parseEcbCsv(pad(ECB_MAX_CSV_BYTES + 1))).toEqual({ ok: false, error: "too_large" });
  });
  it("parses 5 MB of tiny rows well under a second", () => {
    const lines = [H];
    let size = H.length;
    for (let i = 0; size < ECB_MAX_CSV_BYTES - 64; i++) {
      const line = `USD,2026-01-${String((i % 28) + 1).padStart(2, "0")},1.${i % 10000}`;
      lines.push(line);
      size += line.length + 1;
    }
    const text = lines.join("\n");
    const t0 = performance.now();
    const r = ok(text);
    const ms = performance.now() - t0;
    expect(r.observations).toHaveLength(28);
    expect(ms).toBeLessThan(10_000); // runaway guard (quadratic parsing would take minutes)
  });
});

describe("ecbRequestUrl", () => {
  it("matches the ECB Data Portal API (key D..EUR.SP00.A, csvdata, SDMX period parameters)", () => {
    const u = new URL(ecbRequestUrl({ startDate: "2026-03-01", endDate: "2026-03-13", lastN: 5 }));
    expect(u.origin).toBe("https://data-api.ecb.europa.eu");
    expect(u.pathname).toBe("/service/data/EXR/D..EUR.SP00.A");
    expect([...u.searchParams.keys()].sort()).toEqual([
      "endPeriod",
      "format",
      "lastNObservations",
      "startPeriod",
    ]);
    expect(u.searchParams.get("format")).toBe("csvdata");
  });
  it("hostile arguments cannot change host, path or add parameters", () => {
    for (const bad of [
      "2026-03-13&format=jsondata",
      "2026-03-13/../../x",
      "2026-03-13#",
      "//evil.example",
      "2026-03-13\u0000",
      "２０２６-03-13",
    ]) {
      expect(() => ecbRequestUrl({ startDate: bad })).toThrow(RangeError);
      expect(() => ecbRequestUrl({ endDate: bad })).toThrow(RangeError);
    }
    for (const n of [0, -1, 1.5, Number.NaN, Infinity, 1001]) {
      expect(() => ecbRequestUrl({ lastN: n })).toThrow(RangeError);
    }
    expect(() => ecbRequestUrl({ lastN: "5" as unknown as number })).toThrow(RangeError);
  });
});

describe("buildRateTable staleness cut-off", () => {
  const obs = (currency: string, rateDate: string, rate = "1.5"): EcbObservation => ({
    currency,
    rateDate,
    rate,
  });
  it("leaves out currencies the ECB stopped publishing long ago", () => {
    const t = buildRateTable(
      [obs("USD", "2026-11-10"), obs("HRK", "2022-12-30", "7.5365"), obs("RUB", "2022-03-01")],
      "2026-11-11",
    );
    expect(t?.rates).toEqual({ USD: "1.5" });
    expect(t?.ratesDate).toEqual({ USD: "2026-11-10" });
    expect(convertMinor({ amountMinor: 100, from: "HRK", to: "EUR", table: t! })).toEqual({
      ok: false,
      error: "missing_rate",
    });
  });
  it("keeps a currency exactly 10 TARGET days old, drops one at 11", () => {
    expect(ECB_MAX_RATE_AGE_TARGET_DAYS).toBe(10);
    // asOf Tue 2026-11-10. 10 TARGET working days back: Tue 2026-10-27; 11: Mon 2026-10-26.
    const t = buildRateTable(
      [obs("USD", "2026-11-10"), obs("AAA", "2026-10-27"), obs("BBB", "2026-10-26")],
      "2026-11-10",
    );
    expect(Object.keys(t?.rates ?? {})).toEqual(["AAA", "USD"]);
  });
  it("counts TARGET holidays, not calendar days, across Christmas and New Year", () => {
    // asOf Fri 2027-01-15. Working days back: 14,13,12,11,8,7,6,5,4 Jan, then 31 Dec (10th).
    // 1 Jan 2027 (Friday) is a TARGET holiday and is skipped.
    const t = buildRateTable(
      [obs("USD", "2027-01-15"), obs("AAA", "2026-12-31"), obs("BBB", "2026-12-30")],
      "2027-01-15",
    );
    expect(Object.keys(t?.rates ?? {})).toEqual(["AAA", "USD"]);
  });
  it("Friday rates carry over a weekend and an Easter holiday", () => {
    // Good Friday 2026-04-03, Easter Monday 2026-04-06: Thursday's rate is used on Tuesday morning.
    const t = buildRateTable(
      [obs("USD", "2026-04-02", "1.1"), obs("USD", "2026-04-07", "1.2")],
      "2026-04-06",
    );
    expect(t).toEqual({
      asOf: "2026-04-02",
      base: "EUR",
      rates: { USD: "1.1" },
      ratesDate: { USD: "2026-04-02" },
    });
  });
  it("the cut-off is configurable and validated", () => {
    const list = [obs("USD", "2026-11-10"), obs("AAA", "2026-11-09")];
    expect(
      Object.keys(buildRateTable(list, "2026-11-10", { maxAgeTargetDays: 0 })?.rates ?? {}),
    ).toEqual(["USD"]);
    expect(
      Object.keys(buildRateTable(list, "2026-11-10", { maxAgeTargetDays: 1 })?.rates ?? {}),
    ).toEqual(["AAA", "USD"]);
    for (const bad of [-1, 1.5, 261, Number.NaN]) {
      expect(() => buildRateTable(list, "2026-11-10", { maxAgeTargetDays: bad })).toThrow(
        RangeError,
      );
    }
  });
  it("ignores hostile observation entries", () => {
    const list = [
      null,
      42,
      { currency: "__proto__", rateDate: "2026-11-10", rate: "1" },
      { currency: "USD", rateDate: "2026-11-10", rate: 1.1 },
      { currency: "USD", rateDate: "2026-11-10", rate: "1.1" },
    ] as unknown as EcbObservation[];
    const t = buildRateTable(list, "2026-11-10");
    expect(t?.rates).toEqual({ USD: "1.1" });
    expect(Object.getPrototypeOf(t?.rates)).toBe(Object.prototype);
    expect(buildRateTable("x" as unknown as EcbObservation[], "2026-11-10")).toBeNull();
  });
});
