/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * M7d (ADR 0043): the matching screens do no floating-point arithmetic and never show a full IBAN.
 * Allocation maths is BigInt on minor units; typed amounts are read as decimal TEXT. A source scan
 * of every matching file (the lib files, the matching components and pages, the API calls) for the
 * usual float entry points, with the few legitimate small-integer uses listed and counted.
 */
const all = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const isMatching = (name: string) =>
  name === "./lib/allocation.ts" ||
  /^\.\/lib\/matching-[\w-]+\.ts$/.test(name) ||
  name.startsWith("./components/matching/") ||
  name === "./api-matching.ts" ||
  name === "./pages/MatchingSettings.tsx";

const files = Object.fromEntries(
  Object.entries(all).filter(([name]) => isMatching(name) && !name.includes("test-fixtures")),
);

const FORBIDDEN: [string, RegExp][] = [
  ["parseFloat", /\bparseFloat\b/g],
  ["parseInt", /\bparseInt\b/g],
  ["Number(...)", /\bNumber\s*\(/g],
  ["Number.parse*", /\bNumber\s*\.\s*parse/g],
  ["toFixed", /\.\s*toFixed\b/g],
  ["toPrecision", /\.\s*toPrecision\b/g],
  ["Math.*", /\bMath\s*\.\s*\w+/g],
  ["unary plus on a value", /(?:^|[=(,:?!&|[{;]|return)\s*\+\s*[a-zA-Z_$(]/gm],
  ["Intl.NumberFormat", /\bIntl\s*\.\s*NumberFormat\b/g],
  ["division of numbers", /[\w)\]]\s*\/\s*(?:100|1000|10)\b(?!n)/g],
];

/** The legitimate uses: [file, pattern, exact count, why]. Anything else, or one more, fails. */
const ALLOWED: [string, string, number, string][] = [
  ["./lib/allocation.ts", "Number(...)", 1, "a checked safe-integer BigInt as the JSON number"],
  [
    "./lib/matching-settings.ts",
    "Number(...)",
    2,
    "whole numbers 0..999999999 and 1..15 digits, after a digits-only test",
  ],
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

describe("matching files use no floating point", () => {
  it("finds the matching files", () => {
    const names = Object.keys(files);
    for (const must of [
      "./lib/allocation.ts",
      "./lib/matching-labels.ts",
      "./lib/matching-settings.ts",
      "./api-matching.ts",
      "./pages/MatchingSettings.tsx",
      "./components/matching/MatchSheet.tsx",
      "./components/matching/MatchChooser.tsx",
      "./components/matching/AllocationEditor.tsx",
      "./components/matching/ReviewQueue.tsx",
      "./components/matching/AutoMatchedList.tsx",
      "./components/matching/IgnoredList.tsx",
      "./components/matching/BookingCard.tsx",
    ]) {
      expect(names, must).toContain(must);
    }
  });

  for (const [name, re] of FORBIDDEN) {
    it(`none of them uses ${name} (beyond the listed uses)`, () => {
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
    const num = FORBIDDEN[2]?.[1] as RegExp;
    expect(hit(num, "const x = Number(text);")).toBe(true);
    expect(hit(num, "const s = `about ${Number(text)} EUR`;")).toBe(true);
    expect(hit(num, "const s = `Number(x) is ${y}`;")).toBe(false);
    expect(hit(/\bparseInt\b/g, "parseInt(a, 10)")).toBe(true);
  });
});

describe("matching files never show a full IBAN", () => {
  it("only the masked counterparty account is read, and it goes through maskIban", () => {
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(files)) {
      const code = codeOnly(src);
      for (const m of code.matchAll(/\bcounterpartyIban\w*/g)) {
        if (m[0] !== "counterpartyIbanMasked") offenders.push(`${file}: ${m[0]}`);
      }
      if (/\bcounterpartyIbanMasked\b/.test(code) && !/\bmaskIban\b/.test(code)) {
        offenders.push(`${file}: reads counterpartyIbanMasked without maskIban`);
      }
      if (/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/.test(src)) offenders.push(`${file}: IBAN-like text`);
    }
    expect(offenders).toEqual([]);
  });

  it("ibanMasked of the account map is shown through maskIban too", () => {
    const card = files["./components/matching/AccountMapCard.tsx"] ?? "";
    expect(card).toMatch(/maskIban\(account\.ibanMasked\)/);
  });
});
