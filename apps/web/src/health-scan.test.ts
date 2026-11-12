/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * D8c (ADR 0047): the Data health and Today screens do no floating-point arithmetic, never touch an
 * IBAN, never use an exclamation mark in user text, and keep "later" in localStorage inside
 * try/catch only. A source scan of their files for the usual float entry points, with the few
 * small-integer uses listed and counted.
 */
const all = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const isHealth = (name: string) =>
  name === "./pages/Today.tsx" ||
  name === "./pages/DataHealth.tsx" ||
  name.startsWith("./components/dq/") ||
  name === "./api-dq.ts" ||
  name === "./lib/later.ts" ||
  name === "./lib/dq-labels.ts";

const files = Object.fromEntries(Object.entries(all).filter(([n]) => isHealth(n)));

const FORBIDDEN: [string, RegExp][] = [
  ["parseFloat", /\bparseFloat\b/g],
  ["parseInt", /\bparseInt\b/g],
  ["Number(...)", /\bNumber\s*\(/g],
  ["toFixed", /\.\s*toFixed\b/g],
  ["toPrecision", /\.\s*toPrecision\b/g],
  ["Math.*", /\bMath\s*\.\s*\w+/g],
  ["Intl.NumberFormat", /\bIntl\s*\.\s*NumberFormat\b/g],
  ["division of numbers", /[\w)\]]\s*\/\s*(?:100|1000|10)\b(?!n)/g],
];

/** [file, pattern, exact count, why]. */
const ALLOWED: [string, string, number, string][] = [
  [
    "./components/dq/IssueSheet.tsx",
    "Number(...)",
    1,
    "snooze days from a select of fixed integers",
  ],
  [
    "./components/dq/IssueSheet.tsx",
    "Math.*",
    1,
    "Math.min keeps the snooze inside the server's 90 days (integer milliseconds)",
  ],
  ["./components/dq/RuleSheet.tsx", "Number(...)", 1, "an integer threshold typed as digits only"],
  [
    "./pages/Today.tsx",
    "Math.*",
    2,
    "Math.min and Math.max keep the selected index inside the list",
  ],
];

/** Code with comments removed (strings stay: user text is scanned too). */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("health and today sources", () => {
  it("finds the files", () => {
    expect(Object.keys(files).sort()).toEqual([
      "./api-dq.ts",
      "./components/dq/IssueSheet.tsx",
      "./components/dq/RuleSheet.tsx",
      "./lib/dq-labels.ts",
      "./lib/later.ts",
      "./pages/DataHealth.tsx",
      "./pages/Today.tsx",
    ]);
  });

  for (const [pattern, re] of FORBIDDEN) {
    it(`uses no ${pattern} beyond the listed uses`, () => {
      const found: string[] = [];
      for (const [name, src] of Object.entries(files)) {
        const n = (stripComments(src).match(re) ?? []).length;
        const allowed = ALLOWED.find((a) => a[0] === name && a[1] === pattern)?.[2] ?? 0;
        if (n !== allowed) found.push(`${name}: ${n} (allowed ${allowed})`);
      }
      expect(found).toEqual([]);
    });
  }

  it("never reads or names an IBAN", () => {
    const found = Object.entries(files)
      .filter(([, src]) => /iban/i.test(stripComments(src)))
      .map(([n]) => n);
    expect(found).toEqual([]);
  });

  it("has no exclamation mark in a string literal (the rendered text is checked in the page tests)", () => {
    const found = Object.entries(files)
      .filter(([, src]) =>
        [...stripComments(src).matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)].some((m) =>
          /!/.test(m[1] ?? m[2] ?? ""),
        ),
      )
      .map(([n]) => n);
    expect(found).toEqual([]);
  });

  it("touches localStorage only in lib/later.ts, and only inside try", () => {
    const users = Object.entries(files)
      .filter(([, src]) => /localStorage/.test(stripComments(src)))
      .map(([n]) => n);
    expect(users).toEqual(["./lib/later.ts"]);
    const src = stripComments(files["./lib/later.ts"] as string);
    const calls = [...src.matchAll(/localStorage\./g)].length;
    const tries = [...src.matchAll(/\btry\s*\{/g)].length;
    expect(calls).toBe(2);
    expect(tries).toBeGreaterThanOrEqual(2);
  });

  it("builds Fix links only from the fix-path table or the app-path check", () => {
    const today = stripComments(files["./pages/Today.tsx"] as string);
    expect(today).toMatch(/navigate\(todayFixPath\(item\)\)/);
    expect(today).not.toMatch(/navigate\((?!todayFixPath)/);
    expect(today).not.toMatch(/safeAppPath|\.fixPath\b/);
    const health = stripComments(files["./pages/DataHealth.tsx"] as string);
    expect(health).toMatch(/to=\{fixPathOf\(r\.fix\)\}/);
    expect(health).not.toMatch(/\.fixPath/);
  });
});
