import { describe, expect, it } from "vitest";
import { ECB_MAX_CSV_CHARS, buildRateTable, ecbRequestUrl, isIsoDate, parseEcbCsv } from "./ecb";
import { convertMinor, crossRate } from "./fx";

const HEADER =
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK,OBS_COM,TIME_FORMAT,BREAKS,COLLECTION,COMPILING_ORG,DISS_ORG,DOM_SER_IDS,PUBL_ECB,PUBL_MU,PUBL_PUBLIC,UNIT_INDEX_BASE,COMPILATION,COVERAGE,DECIMALS,NAT_TITLE,SOURCE_AGENCY,SOURCE_PUB,TITLE,TITLE_COMPL,UNIT,UNIT_MULT";

// 32 currencies; Friday 2026-03-13 and Monday 2026-03-16 (weekend gap), one missing observation.
const FRI: Record<string, string> = {
  USD: "1.0853",
  JPY: "162.45",
  BGN: "1.9558",
  CZK: "25.123",
  DKK: "7.4601",
  GBP: "0.8571",
  HUF: "395.2",
  PLN: "4.3012",
  RON: "4.9775",
  SEK: "11.2",
  CHF: "0.9712",
  ISK: "150.3",
  NOK: "11.65",
  TRY: "35.10",
  AUD: "1.6402",
  BRL: "5.6",
  CAD: "1.4701",
  CNY: "7.8512",
  HKD: "8.4755",
  IDR: "17100.5",
  ILS: "3.9",
  INR: "90.1234",
  KRW: "1450.2",
  MXN: "20.1",
  MYR: "4.8",
  NZD: "1.7801",
  PHP: "61.2",
  SGD: "1.4502",
  THB: "37.7",
  ZAR: "19.8",
  HRK: "7.5",
  XDR: "0.7",
};
const MON: Record<string, string> = { ...FRI, USD: "1.0901", JPY: "163.00" };

function row(cur: string, date: string, val: string, extra = ""): string {
  return `EXR.D.${cur}.EUR.SP00.A,D,${cur},EUR,SP00,A,${date},${val},A,F,,,P1D,,A,4F0,4F0,,,,,,,,4,,4F0,,Euro foreign exchange reference rates,ECB reference exchange rate,${cur}/EUR,,${extra}`.replace(
    /,$/,
    "",
  );
}
function fixture(): string {
  const lines = [HEADER];
  for (const [c, v] of Object.entries(FRI)) lines.push(row(c, "2026-03-13", v));
  for (const [c, v] of Object.entries(MON)) {
    if (c === "TRY")
      lines.push(row(c, "2026-03-16", "")); // missing observation
    else lines.push(row(c, "2026-03-16", v));
  }
  return lines.join("\r\n") + "\r\n";
}

describe("parseEcbCsv with a realistic fixture", () => {
  it("parses both dates, skips the missing observation", () => {
    const r = parseEcbCsv(fixture());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skipped).toBe(1);
    expect(r.observations).toHaveLength(32 + 31);
    expect(r.observations[0]).toEqual({ currency: "AUD", rateDate: "2026-03-13", rate: "1.6402" });
    const jpyMon = r.observations.find((o) => o.currency === "JPY" && o.rateDate === "2026-03-16");
    expect(jpyMon?.rate).toBe("163"); // normalised
    expect(r.observations.some((o) => o.currency === "TRY" && o.rateDate === "2026-03-16")).toBe(
      false,
    );
    // sorted by date then currency
    const keys = r.observations.map((o) => `${o.rateDate}|${o.currency}`);
    expect(keys).toEqual([...keys].sort());
  });
  it("accepts BOM, LF endings, no final newline and a reordered header", () => {
    const csv = "﻿OBS_VALUE,TIME_PERIOD,CURRENCY\n1.5,2026-03-13,USD\n2.5,2026-03-13,GBP";
    const r = parseEcbCsv(csv);
    expect(r).toEqual({
      ok: true,
      skipped: 0,
      observations: [
        { currency: "GBP", rateDate: "2026-03-13", rate: "2.5" },
        { currency: "USD", rateDate: "2026-03-13", rate: "1.5" },
      ],
    });
  });
  it("handles quoted fields, escaped quotes and commas inside quotes", () => {
    const csv =
      'KEY,CURRENCY,TIME_PERIOD,OBS_VALUE,TITLE\r\n"EXR.D.USD, x",USD,2026-03-13,"1.0853","He said ""hi"", ok"\r\n';
    const r = parseEcbCsv(csv);
    expect(r.ok && r.observations).toEqual([
      { currency: "USD", rateDate: "2026-03-13", rate: "1.0853" },
    ]);
  });
  it("skips blank lines, short rows and unwanted rows with a count", () => {
    const csv = [
      "CURRENCY,CURRENCY_DENOM,EXR_TYPE,TIME_PERIOD,OBS_VALUE",
      "",
      "USD,EUR,SP00,2026-03-13,1.1",
      "GBP,USD,SP00,2026-03-13,0.8", // wrong denominator
      "CHF,EUR,EN00,2026-03-13,0.9", // wrong type
      "SEK,EUR,SP00,2026-02-30,11", // bad date
      "usd,EUR,SP00,2026-03-13,1", // bad code
      "EUR,EUR,SP00,2026-03-13,1", // EUR itself
      "NOK,EUR,SP00,2026-03-13,1e3", // bad rate
      "DKK,EUR,SP00,2026-03-13,0", // zero rate
      "PLN,EUR,SP00",
      "",
    ].join("\n");
    const r = parseEcbCsv(csv);
    expect(r.ok && r.observations).toEqual([
      { currency: "USD", rateDate: "2026-03-13", rate: "1.1" },
    ]);
    expect(r.ok && r.skipped).toBe(8);
  });
  it("a later duplicate replaces the earlier one", () => {
    const csv = "CURRENCY,TIME_PERIOD,OBS_VALUE\nUSD,2026-03-13,1.1\nUSD,2026-03-13,1.2\n";
    const r = parseEcbCsv(csv);
    expect(r.ok && r.observations).toEqual([
      { currency: "USD", rateDate: "2026-03-13", rate: "1.2" },
    ]);
  });
  it("lower-case header names and padded fields are accepted", () => {
    const r = parseEcbCsv(" currency , time_period , obs_value \n USD , 2026-03-13 , 1.5 \n");
    expect(r.ok && r.observations).toHaveLength(1);
  });
});

describe("parseEcbCsv hostile input", () => {
  it("rejects an HTML error page", () => {
    const html =
      "<!DOCTYPE html><html><head><title>404</title></head><body>No results found</body></html>";
    expect(parseEcbCsv(html)).toEqual({ ok: false, error: "missing_columns" });
  });
  it("rejects a wrong header", () => {
    expect(parseEcbCsv("A,B,C\n1,2,3\n")).toEqual({ ok: false, error: "missing_columns" });
  });
  it("rejects empty and whitespace-only input", () => {
    expect(parseEcbCsv("")).toEqual({ ok: false, error: "empty" });
    expect(parseEcbCsv("\n\r\n ,\n")).toEqual({ ok: false, error: "empty" });
  });
  it("rejects a truncated file inside a quoted field", () => {
    const csv = fixture();
    expect(parseEcbCsv(csv.slice(0, csv.length - 200) + '\n"cut')).toEqual({
      ok: false,
      error: "malformed_csv",
    });
  });
  it("a file cut mid-row keeps the complete rows and skips the stump", () => {
    const csv = "CURRENCY,TIME_PERIOD,OBS_VALUE\nUSD,2026-03-13,1.1\nGBP,2026-0";
    const r = parseEcbCsv(csv);
    expect(r.ok && r.observations).toHaveLength(1);
    expect(r.ok && r.skipped).toBe(1);
  });
  it("rejects header only (no observations)", () => {
    expect(parseEcbCsv("CURRENCY,TIME_PERIOD,OBS_VALUE\n")).toEqual({
      ok: false,
      error: "no_observations",
    });
  });
  it("rejects input over 5 MB before parsing", () => {
    const big = "CURRENCY,TIME_PERIOD,OBS_VALUE\n" + "x".repeat(6 * 1024 * 1024);
    expect(parseEcbCsv(big)).toEqual({ ok: false, error: "too_large" });
    expect(ECB_MAX_CSV_CHARS).toBe(5 * 1024 * 1024);
  });
  it("accepts a large legitimate input just under the cap", () => {
    const lines = ["CURRENCY,TIME_PERIOD,OBS_VALUE"];
    for (let i = 0; i < 40000; i++) lines.push(`USD,2026-03-13,1.${String(i).padStart(6, "0")}`);
    const text = lines.join("\n");
    expect(text.length).toBeLessThan(ECB_MAX_CSV_CHARS);
    const r = parseEcbCsv(text);
    expect(r.ok && r.observations).toHaveLength(1); // same key, last wins
  });
  it("never throws on non-string input", () => {
    expect(parseEcbCsv(undefined as unknown as string)).toEqual({ ok: false, error: "not_text" });
  });
});

describe("ecbRequestUrl", () => {
  const base = "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?format=csvdata";
  it("builds the URL", () => {
    expect(ecbRequestUrl({})).toBe(base);
    expect(ecbRequestUrl({ startDate: "2026-03-01", endDate: "2026-03-31" })).toBe(
      `${base}&startPeriod=2026-03-01&endPeriod=2026-03-31`,
    );
    expect(ecbRequestUrl({ lastN: 5 })).toBe(`${base}&lastNObservations=5`);
    expect(ecbRequestUrl({ startDate: "2026-03-01" })).toBe(`${base}&startPeriod=2026-03-01`);
    expect(ecbRequestUrl({ endDate: "2024-02-29" })).toBe(`${base}&endPeriod=2024-02-29`);
  });
  it("always targets the ECB host", () => {
    const u = new URL(ecbRequestUrl({ startDate: "2026-01-01", lastN: 1 }));
    expect(u.host).toBe("data-api.ecb.europa.eu");
    expect(u.protocol).toBe("https:");
  });
  it("rejects injection and bad dates", () => {
    for (const d of [
      "2026-3-1",
      "2026-02-30",
      "2026-03-01&x=1",
      "evil.com/",
      "",
      "2026-13-01",
      "2023-02-29",
    ]) {
      expect(() => ecbRequestUrl({ startDate: d })).toThrow(RangeError);
      expect(() => ecbRequestUrl({ endDate: d })).toThrow(RangeError);
    }
    expect(() => ecbRequestUrl({ startDate: "2026-03-02", endDate: "2026-03-01" })).toThrow(
      RangeError,
    );
  });
  it("rejects bad lastN", () => {
    for (const n of [0, -1, 1.5, 1001, Number.NaN]) {
      expect(() => ecbRequestUrl({ lastN: n })).toThrow(RangeError);
    }
  });
});

describe("isIsoDate", () => {
  it("validates calendar dates", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2000-02-29")).toBe(true);
    expect(isIsoDate("1900-02-29")).toBe(false);
    expect(isIsoDate("2026-04-31")).toBe(false);
    expect(isIsoDate("2026-00-10")).toBe(false);
    expect(isIsoDate("2026-01-00")).toBe(false);
    expect(isIsoDate("0000-01-01")).toBe(false);
    expect(isIsoDate("2026-1-01")).toBe(false);
    expect(isIsoDate(5 as unknown as string)).toBe(false);
  });
});

describe("buildRateTable", () => {
  const parsed = parseEcbCsv(fixture());
  const obs = parsed.ok ? parsed.observations : [];

  it("uses the Friday rate on a Monday before publication (asOf = Friday)", () => {
    const t = buildRateTable(obs, "2026-03-15"); // Sunday
    expect(t?.asOf).toBe("2026-03-13");
    expect(t?.rates.USD).toBe("1.0853");
    expect(t?.ratesDate?.USD).toBe("2026-03-13");
    expect(t?.base).toBe("EUR");
    expect(Object.keys(t?.rates ?? {})).toHaveLength(32);
  });
  it("takes the newest rate per currency and keeps per-currency dates", () => {
    const t = buildRateTable(obs, "2026-03-16");
    expect(t?.asOf).toBe("2026-03-16");
    expect(t?.rates.USD).toBe("1.0901");
    expect(t?.rates.TRY).toBe("35.1"); // no Monday observation: Friday's rate, with its date
    expect(t?.ratesDate?.TRY).toBe("2026-03-13");
    expect(t?.ratesDate?.USD).toBe("2026-03-16");
  });
  it("is independent of observation order", () => {
    const a = buildRateTable([...obs].reverse(), "2026-03-16");
    const b = buildRateTable(obs, "2026-03-16");
    expect(a).toEqual(b);
  });
  it("returns null before the first date, for a bad date or without observations", () => {
    expect(buildRateTable(obs, "2026-03-12")).toBeNull();
    expect(buildRateTable(obs, "16-03-2026")).toBeNull();
    expect(buildRateTable([], "2026-03-16")).toBeNull();
  });
  it("ignores bad observations", () => {
    const t = buildRateTable(
      [
        { currency: "EUR", rateDate: "2026-03-13", rate: "1" },
        { currency: "usd", rateDate: "2026-03-13", rate: "1.1" },
        { currency: "USD", rateDate: "bad", rate: "1.1" },
        { currency: "USD", rateDate: "2026-03-13", rate: "0" },
        { currency: "GBP", rateDate: "2026-03-13", rate: "0.85" },
      ],
      "2026-03-14",
    );
    expect(t?.rates).toEqual({ GBP: "0.85" });
  });
  it("feeds convertMinor and crossRate end to end", () => {
    const t = buildRateTable(obs, "2026-03-13");
    if (!t) throw new Error("no table");
    const r = convertMinor({ amountMinor: 10000, from: "EUR", to: "USD", table: t });
    expect(r).toMatchObject({ ok: true, amountMinor: 10853n });
    expect(crossRate("USD", "USD", t)).toBe("1");
    expect(crossRate("ZZZ", "ZZZ", t)).toBe("1");
    expect(crossRate("zz", "zz", t)).toBeNull();
  });
});
