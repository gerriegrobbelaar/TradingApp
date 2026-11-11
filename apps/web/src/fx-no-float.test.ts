/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * ADR 0037: the FX screens do no floating-point arithmetic. Amounts are BigInt minor units and
 * rates are decimal strings handled by core (`convertMinor`, `unrealisedDifference`,
 * `formatRateForDisplay`). A source scan for the usual float entry points.
 *
 * Which files: every non-test source file whose name says FX (`fx*`, `Fx*`) AND every file that
 * imports the FX modules (lib/fx, the FX provider, the Fx components). So a new FX file, or a
 * screen that starts using FX, is scanned without anyone remembering to add it here. A file that
 * legitimately uses a float entry point for something else is listed in ALLOWED with the exact
 * number of uses and why: one more use (FX code in that file, say) fails the test.
 *
 * Review F3: the earlier scan blanked whole template literals, so `${Number(rate)}` inside one
 * was invisible, and a `//` inside a string removed the rest of the line. The tokenizer below
 * keeps template expressions and only blanks string and comment text.
 */
const all = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FX_IMPORT =
  /from\s+["'](?:\.\.?\/)+(?:lib\/fx|fx|components\/Fx\w*|Fx\w*)["']|from\s+["']\.\/(?:fx|Fx\w*)["']/;
const FX_NAME = /\/(?:fx|Fx)[\w-]*\.tsx?$/;

const files = Object.fromEntries(
  Object.entries(all).filter(
    ([name, src]) => !name.includes("test-fixtures") && (FX_NAME.test(name) || FX_IMPORT.test(src)),
  ),
);

const FORBIDDEN: [string, RegExp][] = [
  ["parseFloat", /\bparseFloat\b/g],
  ["Number(...)", /\bNumber\s*\(/g],
  ["Number.parse*", /\bNumber\s*\.\s*parse/g],
  ["toFixed", /\.\s*toFixed\b/g],
  ["toPrecision", /\.\s*toPrecision\b/g],
  ["Math.*", /\bMath\s*\.\s*\w+/g],
  ["unary plus on a value", /(?:^|[=(,:?!&|[{;]|return)\s*\+\s*[a-zA-Z_$(]/gm],
  ["Intl.NumberFormat", /\bIntl\s*\.\s*NumberFormat\b/g],
  ["division of numbers", /[\w)\]]\s*\/\s*(?:100|1000|10)\b(?!n)/g],
];

/**
 * Uses that are not FX: [file, pattern name, exact count, why]. Anything else, or one more, fails.
 */
const ALLOWED: [string, string, number, string][] = [
  ["./pages/AgeingReport.tsx", "Number(...)", 1, "bucket share of the mix bar, basis points"],
  ["./pages/AgeingReport.tsx", "Math.*", 1, "rounding the mix bar percentage label"],
  ["./pages/AgeingReport.tsx", "division of numbers", 1, "basis points to percent, mix bar"],
  ["./pages/OpenItemsPage.tsx", "Number(...)", 1, "relation id from the URL"],
];

/** Code with comment and string TEXT blanked; template `${...}` expressions are kept. */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  // Stack of open template literals: the brace depth at which each `${` started.
  const templates: number[] = [];
  let depth = 0;
  let inTemplateText = false;
  while (i < n) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (inTemplateText) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        out += "`";
        inTemplateText = false;
        i += 1;
        continue;
      }
      if (c === "$" && next === "{") {
        out += "${";
        templates.push(depth);
        depth += 1;
        inTemplateText = false;
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i += 1;
      while (i < n && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      out += c;
      i += 1;
      continue;
    }
    if (c === "`") {
      out += "`";
      inTemplateText = true;
      i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        out += "}";
        inTemplateText = true;
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;

describe("FX files use no floating point", () => {
  it("finds the FX files and the screens that use them", () => {
    const names = Object.keys(files);
    for (const must of [
      "./fx.tsx",
      "./lib/fx.ts",
      "./components/FxAmount.tsx",
      "./components/FxTotals.tsx",
      "./components/FxChart.tsx",
      "./pages/FxRates.tsx",
      "./pages/Overview.tsx",
      "./pages/Bank.tsx",
      "./pages/AgeingReport.tsx",
      "./pages/OpenItemsPage.tsx",
      "./components/OpenItemDetailBody.tsx",
      "./components/BankTransactionSheet.tsx",
      "./export/report-workbooks.ts",
    ]) {
      expect(names, must).toContain(must);
    }
  });

  for (const [name, re] of FORBIDDEN) {
    it(`none of them uses ${name} (beyond the listed non-FX uses)`, () => {
      const offenders: string[] = [];
      for (const [file, src] of Object.entries(files)) {
        const found = count(re, codeOnly(src));
        const allowed = ALLOWED.find(([f, p]) => f === file && p === name)?.[2] ?? 0;
        if (found !== allowed) offenders.push(`${file}: ${found} (allowed ${allowed})`);
      }
      expect(offenders).toEqual([]);
    });
  }

  it("the scan itself catches what it should", () => {
    const hit = (re: RegExp, s: string) => count(re, codeOnly(s)) > 0;
    const [, num] = FORBIDDEN[1] as [string, RegExp];
    expect(hit(/\bparseFloat\b/g, "const x = parseFloat(rate);")).toBe(true);
    expect(hit(num, "const x = Number(rate);")).toBe(true);
    expect(hit(/\.\s*toFixed\b/g, "x.toFixed(2)")).toBe(true);
    // inside a template expression: still code
    expect(hit(num, "const s = `about ${Number(rate)} EUR`;")).toBe(true);
    expect(hit(num, "const s = `a ${`b ${Number(r)}`} c`;")).toBe(true);
    // a // inside a string does not hide the rest of the line
    expect(hit(num, 'const u = "a//b"; const x = Number(r);')).toBe(true);
    // prose in comments, strings and template text is not code
    expect(hit(/\bparseFloat\b/g, '// parseFloat is not used\nconst s = "parseFloat";')).toBe(
      false,
    );
    expect(hit(num, "const s = `Number(x) is ${y}`;")).toBe(false);
    const [, plus] = FORBIDDEN[6] as [string, RegExp];
    expect(hit(plus, "const x = +rate;")).toBe(true);
    expect(hit(plus, "return +rate;")).toBe(true);
    expect(hit(plus, "const x = a + b;")).toBe(false);
    const [, math] = FORBIDDEN[5] as [string, RegExp];
    expect(hit(math, "Math.pow(10, 2)")).toBe(true);
  });
});
