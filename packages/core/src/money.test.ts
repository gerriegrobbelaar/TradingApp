import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  currencyScale,
  formatMoney,
  formatMinor,
  isZeroMoney,
  money,
  moneyFromDecimal,
  negateMoney,
  parseMinor,
  subMoney,
} from "./money";

describe("parseMinor", () => {
  it.each([
    ["0", 0],
    ["1234.5", 123450],
    ["1234.50", 123450],
    ["-1234.5", -123450],
    ["+7", 700],
    [".5", 50],
    ["5.", 500],
    ["0.07", 7],
    ["-0.07", -7],
    ["-0", 0],
    ["-0.00", 0],
    ["1e-7", 0],
    ["1E2", 10000],
    ["1.5e1", 1500],
    ["12e-1", 120],
    ["0.005", 1],
    ["-0.005", -1],
    ["0.004", 0],
    ["0.0049999", 0],
    ["1.999", 200],
    ["  42.10 ", 4210],
    ["90071992547409.91", 9007199254740991],
  ])("parses %s", (raw, expected) => {
    expect(parseMinor(raw)).toBe(expected);
  });

  it("honours the scale argument", () => {
    expect(parseMinor("1.234", 3)).toBe(1234);
    expect(parseMinor("1234", 0)).toBe(1234);
    expect(parseMinor("1234.5", 0)).toBe(1235);
    expect(parseMinor("0.00000001", 8)).toBe(1);
  });

  it.each(["", ".", "abc", "1.2.3", "1e", "--1", "1,5", "e5"])("rejects %j", (raw) => {
    expect(() => parseMinor(raw)).toThrow(RangeError);
  });

  it("rejects huge values and absurd exponents", () => {
    expect(() => parseMinor("90071992547409.92")).toThrow(/safe integer/);
    expect(() => parseMinor("1e30")).toThrow(/safe integer/);
    expect(() => parseMinor("1e5000")).toThrow(/exponent/);
    expect(() => parseMinor("1e-5000")).toThrow(/exponent/);
  });

  it("rejects an invalid scale", () => {
    expect(() => parseMinor("1", -1)).toThrow(RangeError);
    expect(() => parseMinor("1", 9)).toThrow(RangeError);
    expect(() => parseMinor("1", 1.5)).toThrow(RangeError);
  });
});

describe("Money helpers", () => {
  it("validates construction", () => {
    expect(money(100, "EUR")).toEqual({ minor: 100, currency: "EUR" });
    expect(money(-0, "EUR").minor).toBe(0);
    expect(Object.is(money(-0, "EUR").minor, 0)).toBe(true);
    expect(() => money(1.5, "EUR")).toThrow(RangeError);
    expect(() => money(1, "eur")).toThrow(RangeError);
  });

  it("parses decimals into Money", () => {
    expect(moneyFromDecimal("12.34", "USD")).toEqual({ minor: 1234, currency: "USD" });
    expect(moneyFromDecimal("1.234", "KWD")).toEqual({ minor: 1234, currency: "KWD" });
    expect(moneyFromDecimal("1234", "JPY")).toEqual({ minor: 1234, currency: "JPY" });
    expect(moneyFromDecimal("1234.5", "JPY")).toEqual({ minor: 1235, currency: "JPY" });
    expect(moneyFromDecimal("-1234.5", "JPY")).toEqual({ minor: -1235, currency: "JPY" });
    expect(() => moneyFromDecimal("1", "eur")).toThrow(RangeError);
  });

  it("knows each currency's minor-unit exponent", () => {
    expect(currencyScale("EUR")).toBe(2);
    expect(currencyScale("ZAR")).toBe(2);
    expect(currencyScale("JPY")).toBe(0);
    expect(currencyScale("KWD")).toBe(3);
    expect(currencyScale("CLF")).toBe(4);
    expect(() => currencyScale("EURO")).toThrow(RangeError);
  });

  it("compares and refuses mixed currencies", () => {
    expect(compareMoney(money(1, "EUR"), money(2, "EUR"))).toBe(-1);
    expect(compareMoney(money(2, "EUR"), money(2, "EUR"))).toBe(0);
    expect(compareMoney(money(3, "EUR"), money(2, "EUR"))).toBe(1);
    expect(() => compareMoney(money(1, "EUR"), money(1, "USD"))).toThrow(/mismatch/);
  });

  it("refuses results outside the safe integer range", () => {
    const max = money(Number.MAX_SAFE_INTEGER, "EUR");
    expect(() => addMoney(max, money(1, "EUR"))).toThrow(RangeError);
    expect(() => subMoney(negateMoney(max), money(1, "EUR"))).toThrow(RangeError);
  });

  it("adds, subtracts, negates", () => {
    const a = money(500, "EUR");
    const b = money(200, "EUR");
    expect(addMoney(a, b).minor).toBe(700);
    expect(subMoney(a, b).minor).toBe(300);
    expect(negateMoney(a).minor).toBe(-500);
    expect(isZeroMoney(subMoney(a, a))).toBe(true);
    expect(isZeroMoney(a)).toBe(false);
    expect(() => addMoney(a, money(1, "USD"))).toThrow(/mismatch/);
    expect(() => subMoney(a, money(1, "USD"))).toThrow(/mismatch/);
  });

  it("formats minor units", () => {
    expect(formatMinor(1205)).toBe("12.05");
    expect(formatMinor(-1205)).toBe("-12.05");
    expect(formatMinor(5)).toBe("0.05");
    expect(formatMinor(0)).toBe("0.00");
    expect(formatMinor(1234, 0)).toBe("1234");
    expect(formatMinor(1234, 3)).toBe("1.234");
    expect(() => formatMinor(0.5)).toThrow(RangeError);
    expect(() => formatMinor(1, -1)).toThrow(RangeError);
    expect(() => formatMinor(1, 9)).toThrow(RangeError);
  });

  it("formats Money at the currency scale", () => {
    expect(formatMoney(money(1205, "EUR"))).toBe("12.05");
    expect(formatMoney(money(-1234, "JPY"))).toBe("-1234");
    expect(formatMoney(money(1234, "KWD"))).toBe("1.234");
  });
});
