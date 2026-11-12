import { describe, expect, it } from "vitest";
import {
  OPENING_BALANCE_MAX_MINOR,
  controlAccountsMissing,
  openingBalanceErrorText,
  openingBalanceRequest,
  openingBalanceText,
  parseOpeningBalance,
} from "./account-map";

const ok = (t: string, c = "EUR") => {
  const r = parseOpeningBalance(t, c);
  return r.ok ? r.minor : r.error;
};

describe("parseOpeningBalance: exact decimal text to signed minor units", () => {
  it("reads the currency's real scale, with comma or point", () => {
    expect(ok("1234,50")).toBe(123450n);
    expect(ok("1234.5")).toBe(123450n);
    expect(ok("1,5")).toBe(150n);
    expect(ok("0")).toBe(0n);
    expect(ok("  7 ")).toBe(700n);
    expect(ok("1250", "JPY")).toBe(1250n);
    expect(ok("1,5", "JPY")).toBe("decimals");
    expect(ok("1,234", "KWD")).toBe(1234n);
    expect(ok("1,2345", "KWD")).toBe("decimals");
  });

  it("empty is 'not set'", () => {
    expect(ok("")).toBeNull();
    expect(ok("   ")).toBeNull();
  });

  it("allows exactly one leading ASCII minus for an overdrawn journal", () => {
    expect(ok("-250,50")).toBe(-25050n);
    expect(ok("-0")).toBe(0n);
    for (const t of ["+5", "5-", "--5", "- 5", "−5", "-", "-+5"]) {
      expect(ok(t), t).toBe("sign");
    }
  });

  it("refuses floats, exponents, separators and non-ASCII digits", () => {
    for (const t of ["1e3", "1E3", "1,234.50", "1 000", "abc", "0x10", "Infinity", "NaN"]) {
      expect(typeof ok(t), t).toBe("string");
    }
    expect(ok("١٢")).toBe("format");
    expect(ok("１２")).toBe("format");
    expect(ok("12.345")).toBe("decimals");
  });

  it("keeps to the server's bound of 1e13 minor units, both signs", () => {
    expect(ok("100000000000")).toBe(OPENING_BALANCE_MAX_MINOR);
    expect(ok("-100000000000")).toBe(-OPENING_BALANCE_MAX_MINOR);
    expect(ok("100000000000,01")).toBe("too_large");
    expect(ok("-100000000000,01")).toBe("too_large");
    expect(ok("9".repeat(30))).toBe("too_large");
  });

  it("the request value is an exact JSON integer or null", () => {
    expect(openingBalanceRequest(parseOpeningBalance("-100000000000", "EUR"))).toBe(-1e13);
    expect(openingBalanceRequest(parseOpeningBalance("", "EUR"))).toBeNull();
    expect(openingBalanceRequest(parseOpeningBalance("x", "EUR"))).toBeNull();
  });
});

describe("openingBalanceText", () => {
  it("prefills a stored signed integer and drops anything malformed", () => {
    expect(openingBalanceText(123450, "EUR")).toBe("1234.50");
    expect(openingBalanceText(-2550, "EUR")).toBe("-25.50");
    expect(openingBalanceText(0, "EUR")).toBe("0.00");
    expect(openingBalanceText(1250, "JPY")).toBe("1250");
    expect(openingBalanceText(null, "EUR")).toBe("");
    expect(openingBalanceText(undefined, "EUR")).toBe("");
    expect(openingBalanceText(1.5, "EUR")).toBe("");
    expect(openingBalanceText(Number.MAX_SAFE_INTEGER, "EUR")).toBe("");
    // round trip
    for (const n of [1, -1, 99, -1e13, 1e13]) {
      expect(openingBalanceRequest(parseOpeningBalance(openingBalanceText(n, "EUR"), "EUR"))).toBe(
        n,
      );
    }
  });

  it("explains every refusal without a raw code", () => {
    for (const e of ["sign", "format", "decimals", "too_large", "empty", "zero"] as const) {
      const t = openingBalanceErrorText(e, "JPY");
      expect(t).toMatch(/^[A-Z]/);
      expect(t).not.toContain("_");
    }
  });
});

describe("controlAccountsMissing", () => {
  it("only for a mapped account without both codes", () => {
    expect(controlAccountsMissing({ divisionId: null })).toBe(false);
    expect(controlAccountsMissing({ divisionId: 1 })).toBe(true);
    expect(
      controlAccountsMissing({
        divisionId: 1,
        receivableGlAccountCode: "1300",
        payableGlAccountCode: "",
      }),
    ).toBe(true);
    expect(
      controlAccountsMissing({
        divisionId: 1,
        receivableGlAccountCode: "1300",
        payableGlAccountCode: "1600",
      }),
    ).toBe(false);
  });
});
