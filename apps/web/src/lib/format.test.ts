import { norm } from "../test-norm";
import { describe, expect, it } from "vitest";
import {
  NO_VALUE,
  describeDue,
  formatCount,
  formatDate,
  formatDateTime,
  formatDays,
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

  it("falls back to two decimals for a code it does not know", () => {
    expect(norm(formatMoney(150, "xx"))).toContain("1,50");
  });

  it("can use another locale", () => {
    expect(norm(formatMoney(123456, "EUR", "en-GB"))).toBe("€1,234.56");
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
