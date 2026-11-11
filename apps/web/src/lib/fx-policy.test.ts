import { describe, expect, it } from "vitest";
import { fxOutage, fxRates, fxStale } from "../test-fixtures-fx";
import { formatEcbRate, formatRate } from "./format";
import {
  ecbEquation,
  estimatesHidden,
  hiddenNoticeText,
  isTodaysRate,
  rateTableFromResponse,
  rateWording,
  staleChipText,
} from "./fx";

describe("formatRate (N1): the number locale, at least four fraction digits, from the string", () => {
  it.each([
    ["1.0853", "1,0853"],
    ["1.082", "1,0820"],
    ["1.08", "1,0800"],
    ["165.5", "165,5000"],
    ["0.3333", "0,3333"],
    ["1", "1,0000"],
    ["1.0853000", "1,0853"],
    ["1.08530001", "1,0853"],
    ["1.0853006", "1,085301"],
    ["17000.12", "17.000,1200"],
    ["1234567.5", "1.234.567,5000"],
    ["0.803464", "0,803464"],
  ])("%s -> %s", (input, out) => {
    expect(formatRate(input)).toBe(out);
  });

  it("can ask for fewer or more digits", () => {
    expect(formatRate("0.92", 2)).toBe("0,92");
    expect(formatRate("1.0856", 2)).toBe("1,0856");
    expect(formatRate("1.0853", 4, 4)).toBe("1,0853");
    expect(formatRate("1.08536", 4, 4)).toBe("1,0854");
  });

  it("is exact for digits a double cannot hold, and leaves non-decimals alone", () => {
    expect(formatRate("1.234567890123")).toBe("1,234568");
    expect(formatRate("9007199254740993.5")).toBe("9.007.199.254.740.993,5000");
    expect(formatRate("abc")).toBe("abc");
    expect(formatRate("1e3")).toBe("1e3");
    expect(formatRate("")).toBe("");
  });
});

describe("formatEcbRate: a published ECB rate, every digit, never rounded (review T2)", () => {
  it.each([
    ["1.0853", "1,0853"],
    ["0.872", "0,8720"],
    ["0.85305", "0,85305"],
    ["0.000123", "0,000123"],
    ["0.123456789012", "0,123456789012"],
    ["123456789012.123456789012", "123.456.789.012,123456789012"],
    ["15890.12", "15.890,1200"],
    ["1000", "1.000,0000"],
    ["999.5", "999,5000"],
    ["01.50", "1,5000"],
    ["00.0853", "0,0853"],
  ])("%s -> %s", (input, out) => {
    expect(formatEcbRate(input)).toBe(out);
  });

  it("formatRate (computed rates) rounds a 12-digit rate to 6 for display, half away from zero", () => {
    expect(formatRate("0.921404220031")).toBe("0,921404");
    expect(formatRate("0.0000005")).toBe("0,000001");
    expect(formatRate("0.0000004")).toBe("0,0000");
  });
});

describe("how old rates are used (S7)", () => {
  it("is fresh, stale (shown with a date) or hidden by the API's workingDaysOld", () => {
    expect(estimatesHidden(fxRates())).toBe(false);
    expect(estimatesHidden(fxStale())).toBe(false);
    for (const [days, hidden] of [
      [0, false],
      [1, false],
      [4, false],
      [5, false],
      [6, true],
      [7, true],
      [30, true],
    ] as const) {
      expect(estimatesHidden(fxRates({ workingDaysOld: days, stale: days > 1 }))).toBe(hidden);
    }
    expect(estimatesHidden(fxRates({ workingDaysOld: null }))).toBe(false);
    expect(estimatesHidden(null)).toBe(false);
  });

  it("words the notice with the number of working days", () => {
    expect(hiddenNoticeText(fxOutage())).toBe(
      "ECB rates are 7 working days old; estimates are hidden",
    );
    expect(hiddenNoticeText(fxStale())).toBeNull();
    expect(hiddenNoticeText(null)).toBeNull();
  });

  it("calls a rate 'today's' only when the feed is fresh and the rate is the newest", () => {
    const fresh = fxRates();
    expect(rateWording(fresh, "2026-11-10")).toBe("at today's ECB rate");
    // a currency the ECB stopped publishing keeps its old date
    expect(rateWording(fresh, "2026-11-06")).toBe("at the ECB rate of 6 Nov");
    expect(rateWording(fxStale(), "2026-11-06")).toBe("at the ECB rate of 6 Nov");
    expect(rateWording(fxStale(), null)).toBe("at the latest ECB rate");
    expect(isTodaysRate(null, "2026-11-10")).toBe(false);
  });

  it("the stale chip names the oldest date and the age in working days", () => {
    expect(staleChipText(fxStale())).toBe("Rates from 6 Nov, 3 working days old");
  });

  it("writes the ECB rate in its own direction, in the number locale", () => {
    const t = rateTableFromResponse(fxRates()) as NonNullable<
      ReturnType<typeof rateTableFromResponse>
    >;
    expect(ecbEquation(t, "USD", "EUR")).toBe("1 EUR = 1,0853 USD");
    expect(ecbEquation(t, "JPY", "EUR")).toBe("1 EUR = 165,5000 JPY");
    expect(ecbEquation(t, "USD", "GBP")).toBe("1 USD = 0,803464 GBP");
    expect(ecbEquation(t, "CHF", "EUR")).toBeNull();
  });
});
