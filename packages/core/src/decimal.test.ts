import { describe, expect, it } from "vitest";
import {
  compareDec,
  decToString,
  divDec,
  divRound,
  mulDec,
  normaliseDec,
  parseDecimal,
  pow10,
  roundDec,
} from "./decimal";

describe("parseDecimal", () => {
  it("parses plain decimals", () => {
    expect(parseDecimal("12")).toEqual({ int: 12n, scale: 0 });
    expect(parseDecimal("-0.50")).toEqual({ int: -50n, scale: 2 });
    expect(parseDecimal("007.250")).toEqual({ int: 7250n, scale: 3 });
  });
  it("rejects everything else", () => {
    for (const s of ["", ".5", "5.", "+1", " 1", "1 ", "1e5", "1,5", "--1", "1.2.3", "abc"]) {
      expect(parseDecimal(s)).toBeNull();
    }
    expect(parseDecimal("1".repeat(61))).toBeNull();
    expect(parseDecimal(5 as unknown as string)).toBeNull();
  });
});

describe("decToString / normaliseDec", () => {
  it("round-trips and pads", () => {
    expect(decToString({ int: 5n, scale: 3 })).toBe("0.005");
    expect(decToString({ int: -1234n, scale: 2 })).toBe("-12.34");
    expect(decToString({ int: 7n, scale: 0 })).toBe("7");
  });
  it("strips trailing zeros", () => {
    expect(normaliseDec({ int: 12300n, scale: 4 })).toEqual({ int: 123n, scale: 2 });
    expect(normaliseDec({ int: 2000n, scale: 3 })).toEqual({ int: 2n, scale: 0 });
    expect(normaliseDec({ int: 100n, scale: 0 })).toEqual({ int: 100n, scale: 0 });
  });
});

describe("compare, multiply, pow10", () => {
  it("compares across scales", () => {
    expect(compareDec({ int: 10n, scale: 1 }, { int: 1n, scale: 0 })).toBe(0);
    expect(compareDec({ int: 11n, scale: 1 }, { int: 1n, scale: 0 })).toBe(1);
    expect(compareDec({ int: -1n, scale: 0 }, { int: 0n, scale: 3 })).toBe(-1);
  });
  it("multiplies exactly", () => {
    expect(mulDec({ int: 15n, scale: 1 }, { int: 25n, scale: 2 })).toEqual({ int: 375n, scale: 3 });
  });
  it("pow10 guards its input", () => {
    expect(pow10(3)).toBe(1000n);
    expect(() => pow10(-1)).toThrow(RangeError);
    expect(() => pow10(1.5)).toThrow(RangeError);
    expect(() => pow10(1001)).toThrow(RangeError);
  });
});

describe("divRound (half away from zero)", () => {
  it.each([
    [5n, 2n, 3n],
    [-5n, 2n, -3n],
    [5n, -2n, -3n],
    [-5n, -2n, 3n],
    [4n, 10n, 0n],
    [5n, 10n, 1n],
    [-4n, 10n, 0n],
    [-5n, 10n, -1n],
    [7n, 7n, 1n],
    [0n, 5n, 0n],
  ])("%s / %s = %s", (n, d, q) => {
    expect(divRound(n, d)).toBe(q);
  });
  it("throws on zero", () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });
});

describe("divDec / roundDec", () => {
  it("divides to a scale", () => {
    expect(decToString(divDec({ int: 1n, scale: 0 }, { int: 3n, scale: 0 }, 4))).toBe("0.3333");
    expect(decToString(divDec({ int: 2n, scale: 0 }, { int: 3n, scale: 0 }, 4))).toBe("0.6667");
    expect(decToString(divDec({ int: 11n, scale: 1 }, { int: 5n, scale: 1 }, 1))).toBe("2.2");
  });
  it("throws on zero divisor", () => {
    expect(() => divDec({ int: 1n, scale: 0 }, { int: 0n, scale: 0 }, 2)).toThrow(RangeError);
  });
  it("roundDec keeps shorter values", () => {
    expect(roundDec({ int: 125n, scale: 2 }, 1)).toEqual({ int: 13n, scale: 1 });
    expect(roundDec({ int: -125n, scale: 2 }, 1)).toEqual({ int: -13n, scale: 1 });
    expect(roundDec({ int: 125n, scale: 2 }, 5)).toEqual({ int: 125n, scale: 2 });
  });
});
