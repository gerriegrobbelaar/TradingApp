import { norm } from "../test-norm";
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_VALUE,
  _forceStringFormat,
  describeDue,
  formatCount,
  formatDate,
  formatDateTime,
  formatBps,
  formatDays,
  currentAmsterdamYear,
  scaleOf,
  formatMoney,
  minorToDecimal,
} from "./format";

describe("formatMoney", () => {
  it("formats EUR at two decimals with nl-NL grouping", () => {
    expect(norm(formatMoney(123456, "EUR"))).toBe("€ 1.234,56");
    expect(norm(formatMoney(5, "EUR"))).toBe("€ 0,05");
  });

  it("shows zero with the currency's decimals", () => {
    expect(norm(formatMoney(0, "EUR"))).toBe("€ 0,00");
    expect(norm(formatMoney(0, "JPY"))).toBe("JP¥ 0");
  });

  it("uses the real exponent: JPY has none, KWD has three", () => {
    expect(norm(formatMoney(1234, "JPY"))).toBe("JP¥ 1.234");
    expect(norm(formatMoney(1234, "KWD"))).toBe("KWD 1,234");
    expect(norm(formatMoney(1, "KWD"))).toBe("KWD 0,001");
  });

  it("shows a credit with a minus sign", () => {
    expect(norm(formatMoney(-123456, "EUR"))).toBe("€ -1.234,56");
    expect(norm(formatMoney(-1, "EUR"))).toBe("€ -0,01");
    expect(norm(formatMoney(-1234, "JPY"))).toBe("JP¥ -1.234");
  });

  it("keeps every digit beyond 2^53 when given a bigint", () => {
    const big = 2n ** 60n + 1n; // 1152921504606846977
    expect(norm(formatMoney(big, "EUR"))).toBe("€ 11.529.215.046.068.469,77");
    expect(norm(formatMoney(-big, "EUR"))).toBe("€ -11.529.215.046.068.469,77");
    expect(norm(formatMoney(big, "JPY"))).toBe("JP¥ 1.152.921.504.606.846.977");
  });

  it("does not use float division for large safe integers", () => {
    expect(norm(formatMoney(Number.MAX_SAFE_INTEGER, "EUR"))).toBe("€ 90.071.992.547.409,91");
  });

  it("shows an em dash for a value that is not an integer", () => {
    expect(formatMoney(Number.NaN, "EUR")).toBe(NO_VALUE);
    expect(formatMoney(1.5, "EUR")).toBe(NO_VALUE);
    expect(formatMoney(Number.POSITIVE_INFINITY, "EUR")).toBe(NO_VALUE);
  });

  it("falls back to two decimals for a code it does not know, and still shows the code", () => {
    expect(norm(formatMoney(150, "xx"))).toBe("xx 1,50");
    expect(norm(formatMoney(-150, "EURO"))).toBe("EURO -1,50");
  });

  it("refuses a number that is no longer exact (beyond 2^53) instead of printing a wrong one", () => {
    expect(formatMoney(2 ** 53 + 2, "EUR")).toBe(NO_VALUE);
    expect(formatMoney(-(2 ** 53) - 2, "EUR")).toBe(NO_VALUE);
  });

  it("uses a no-break space between symbol and amount, so the two never wrap apart", () => {
    expect(formatMoney(100, "EUR")).toBe(`€${String.fromCharCode(160)}1,00`);
  });

  it("negative zero is plain zero, not a credit", () => {
    expect(norm(formatMoney(-0, "EUR"))).toBe("€ 0,00");
  });

  it("can use another locale", () => {
    expect(norm(formatMoney(123456, "EUR", "en-GB"))).toBe("€1,234.56");
  });
});

describe("formatMoney without Intl string support (older engines)", () => {
  afterEach(() => _forceStringFormat(null));
  const cases: [bigint, string][] = [
    [0n, "EUR"],
    [5n, "EUR"],
    [-1n, "EUR"],
    [123456n, "EUR"],
    [-123456n, "EUR"],
    [1234n, "JPY"],
    [-1234n, "JPY"],
    [1n, "KWD"],
    [-1234567n, "KWD"],
    [999n, "USD"],
    [100000000n, "GBP"],
    [2n ** 60n + 1n, "EUR"],
    [-(2n ** 60n + 1n), "EUR"],
    [9007199254740991n, "EUR"],
  ];
  it("prints exactly what the string path prints, digit for digit", () => {
    for (const [v, c] of cases) {
      _forceStringFormat(true);
      const expected = formatMoney(v, c);
      _forceStringFormat(false);
      expect(formatMoney(v, c), `${v} ${c}`).toBe(expected);
    }
  });
  it("also in en-GB and for codes Intl does not know", () => {
    for (const [v, c, locale] of [
      [-123456n, "EUR", "en-GB"],
      [2n ** 60n + 1n, "USD", "en-GB"],
      [150n, "xx", "nl-NL"],
    ] as const) {
      _forceStringFormat(true);
      const expected = formatMoney(v, c, locale);
      _forceStringFormat(false);
      expect(formatMoney(v, c, locale)).toBe(expected);
    }
  });
});

describe("minorToDecimal", () => {
  it("pads and places the point exactly", () => {
    expect(minorToDecimal(5n, 2)).toBe("0.05");
    expect(minorToDecimal(-5n, 3)).toBe("-0.005");
    expect(minorToDecimal(1234n, 0)).toBe("1234");
    expect(minorToDecimal(0n, 2)).toBe("0.00");
  });
});

describe("dates and days", () => {
  it("shows a calendar date as written, with no time zone shift", () => {
    expect(formatDate("2026-01-01")).toBe("1 Jan 2026");
    expect(formatDate("2026-12-31")).toBe("31 Dec 2026");
  });

  it("shows an instant in Amsterdam time", () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Amsterdam.
    expect(formatDate("2026-12-31T23:30:00.000Z")).toBe("1 Jan 2027");
    expect(formatDateTime("2026-07-01T10:05:00.000Z")).toContain("12:05");
    expect(formatDateTime("2026-01-01T10:05:00.000Z")).toContain("11:05");
  });

  it("never renders a date as numbers that could be read day-first or month-first", () => {
    for (const d of ["2026-03-04", "2026-11-12", "2026-12-11"]) {
      expect(formatDate(d)).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
    }
    expect(formatDate("2026-03-04")).toBe("4 Mar 2026");
    expect(formatDateTime("2026-11-12T08:00:00.000Z")).toMatch(/^12 Nov 2026, 09:00$/);
  });

  it("shows a dash for an impossible calendar date instead of rolling it over", () => {
    expect(formatDate("2026-02-31")).toBe(NO_VALUE);
    expect(formatDate("2026-13-01")).toBe(NO_VALUE);
    expect(formatDate("0099-01-01")).toBe(NO_VALUE);
    expect(formatDate("2028-02-29")).toBe("29 Feb 2028");
  });

  it("shows an em dash for missing or invalid dates", () => {
    expect(formatDate(null)).toBe(NO_VALUE);
    expect(formatDate("")).toBe(NO_VALUE);
    expect(formatDate("not a date")).toBe(NO_VALUE);
    expect(formatDateTime(undefined)).toBe(NO_VALUE);
  });

  it("pluralises days and describes due dates", () => {
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(0)).toBe("0 days");
    expect(formatDays(-3)).toBe("3 days");
    expect(describeDue(12)).toBe("12 days overdue");
    expect(describeDue(1)).toBe("1 day overdue");
    expect(describeDue(0)).toBe("Due today");
    expect(describeDue(-3)).toBe("Due in 3 days");
    expect(describeDue(null)).toBe("No due date");
    expect(formatCount(1)).toBe("1 item");
    expect(formatCount(2)).toBe("2 items");
  });
});

describe("formatBps (variance percentage from basis points)", () => {
  it("shows one decimal with the Dutch decimal comma", () => {
    expect(formatBps(1234)).toBe("12,3%");
    expect(formatBps(100)).toBe("1,0%");
    expect(formatBps(10_000)).toBe("100,0%");
    expect(formatBps(123_456)).toBe("1234,6%");
  });

  it("rounds half away from zero, in integer math", () => {
    // 12.35 % -> 12.4 %, -12.35 % -> -12.4 %
    expect(formatBps(1235)).toBe("12,4%");
    expect(formatBps(-1235)).toBe("-12,4%");
    expect(formatBps(1234)).toBe("12,3%");
    expect(formatBps(-1234)).toBe("-12,3%");
    expect(formatBps(5)).toBe("0,1%");
    expect(formatBps(4)).toBe("0,0%");
    expect(formatBps(-5)).toBe("-0,1%");
  });

  it("never prints a minus sign for zero, and is exact for huge values", () => {
    expect(formatBps(0)).toBe("0,0%");
    expect(formatBps(-4)).toBe("0,0%");
    expect(formatBps(Number.MAX_SAFE_INTEGER)).toBe("90071992547409,9%");
  });

  it("is an em dash without a base (null) and for non-integers, never 0", () => {
    expect(formatBps(null)).toBe(NO_VALUE);
    expect(formatBps(undefined)).toBe(NO_VALUE);
    expect(formatBps(1.5)).toBe(NO_VALUE);
    expect(formatBps(Number.NaN)).toBe(NO_VALUE);
  });
});

describe("report helpers", () => {
  it("knows the minor-unit decimals of a currency", () => {
    expect([scaleOf("EUR"), scaleOf("JPY"), scaleOf("KWD")]).toEqual([2, 0, 3]);
  });

  it("takes the reporting year in Amsterdam, not UTC", () => {
    // 31 Dec 23:30 UTC is already 1 Jan in Amsterdam.
    expect(currentAmsterdamYear(Date.parse("2026-12-31T23:30:00Z"))).toBe(2027);
    expect(currentAmsterdamYear(Date.parse("2026-12-31T22:30:00Z"))).toBe(2026);
  });
});
