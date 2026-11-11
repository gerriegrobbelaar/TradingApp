/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * ADR 0037: the FX screens do no floating-point arithmetic. Amounts are BigInt minor units and
 * rates are decimal strings handled by core (`convertMinor`, `unrealisedDifference`,
 * `formatRateForDisplay`). A plain source scan of the FX files for the usual float entry points.
 */
const files = import.meta.glob(
  [
    "./fx.tsx",
    "./lib/fx.ts",
    "./components/FxAmount.tsx",
    "./components/FxTotals.tsx",
    "./components/FxChart.tsx",
    "./pages/FxRates.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const FORBIDDEN: [string, RegExp][] = [
  ["parseFloat", /\bparseFloat\b/],
  ["Number(...)", /\bNumber\s*\(/],
  ["Number.parse*", /\bNumber\s*\.\s*parse/],
  ["toFixed", /\.\s*toFixed\b/],
  ["toPrecision", /\.\s*toPrecision\b/],
  ["Math.round/floor/ceil/trunc", /\bMath\s*\.\s*(round|floor|ceil|trunc)\b/],
  ["unary plus on a value", /[=(,]\s*\+\s*[a-zA-Z_]/],
  ["Intl.NumberFormat on a rate", /Intl\.NumberFormat/],
];

/** Strip comments and string/template text so prose does not trip the scan. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

describe("FX files use no floating point", () => {
  it("finds all six files", () => {
    expect(Object.keys(files).sort()).toEqual([
      "./components/FxAmount.tsx",
      "./components/FxChart.tsx",
      "./components/FxTotals.tsx",
      "./fx.tsx",
      "./lib/fx.ts",
      "./pages/FxRates.tsx",
    ]);
  });

  for (const [name, re] of FORBIDDEN) {
    it(`none of them uses ${name}`, () => {
      const offenders = Object.entries(files)
        .filter(([, src]) => re.test(code(src)))
        .map(([file]) => file);
      expect(offenders).toEqual([]);
    });
  }

  it("the scan itself catches what it should", () => {
    expect(/\bparseFloat\b/.test(code("const x = parseFloat(rate);"))).toBe(true);
    expect(/\bNumber\s*\(/.test(code("const x = Number(rate);"))).toBe(true);
    expect(/\.\s*toFixed\b/.test(code("x.toFixed(2)"))).toBe(true);
    expect(/\bparseFloat\b/.test(code('// parseFloat is not used\nconst s = "parseFloat";'))).toBe(
      false,
    );
  });
});
