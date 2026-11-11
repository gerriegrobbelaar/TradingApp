/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * Review S11: `OpenItemDetail.amountMinor` is the amount as stored, which may equal the open
 * balance (ADR 0022). It is shown on the item sheet under that label and must never feed a list
 * row, a total or a report. Lists use `openMinor` / `originalMinor`.
 */
const web = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const core = import.meta.glob("../../../packages/core/src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Code without block and line comments (a comment may name the field; `://` in URLs is kept). */
const code = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const isTest = (n: string) => /\.test\.|test-fixtures|test-utils|test-setup/.test(n);
const WEB_ALLOWED = new Set([
  "./components/OpenItemDetailBody.tsx", // the sheet row "Amount as stored"
  "./components/AccountSheet.tsx", // ledger periods, unrelated to open items
  "./pages/Approvals.tsx", // purchase entries, unrelated
]);
/**
 * Bank screen (R3b): BankTransactionDto.amountMinor is the signed leg amount, unrelated to open
 * items. Allowed only in these files, only on the named bank-transaction variables, and only in
 * files that never touch an OpenItem type.
 */
const BANK_ALLOWED: Record<string, readonly string[]> = {
  "./pages/Bank.tsx": ["r"],
  "./components/BankTransactionSheet.tsx": ["detail", "l"],
};
const CORE_ALLOWED = new Set([
  "../../../packages/core/src/api-types.ts",
  "../../../packages/core/src/reports/ledger.ts",
]);

describe("OpenItemDetail.amountMinor stays out of lists and totals (review S11)", () => {
  it("finds the sources", () => {
    expect(Object.keys(web).length).toBeGreaterThan(20);
    expect(Object.keys(core).length).toBeGreaterThan(10);
  });

  it("web: only the item sheet uses amountMinor", () => {
    const offenders = Object.entries(web)
      .filter(([n]) => !isTest(n) && !WEB_ALLOWED.has(n) && !(n in BANK_ALLOWED))
      .filter(([, t]) => /\bamountMinor\b/.test(code(t)))
      .map(([n]) => n);
    expect(offenders).toEqual([]);
  });

  it("web: bank files use amountMinor only on bank-transaction variables", () => {
    for (const [file, vars] of Object.entries(BANK_ALLOWED)) {
      const t = code(web[file] ?? "");
      expect(t, file).not.toBe("");
      expect(t, `${file} must not touch open items`).not.toMatch(/\bOpenItem/);
      const uses = [...t.matchAll(/(\w+)?(\??\.)?\bamountMinor\b/g)].map((m) => m[1] ?? "");
      expect(uses.length, file).toBeGreaterThan(0);
      for (const u of uses) expect(vars, `${file}: ${u}.amountMinor`).toContain(u);
    }
  });

  it("core: only the type definitions and the ledger report use amountMinor", () => {
    const offenders = Object.entries(core)
      .filter(([n]) => !/\.test\./.test(n) && !CORE_ALLOWED.has(n))
      .filter(([, t]) => /\bamountMinor\b/.test(code(t)))
      .map(([n]) => n);
    expect(offenders).toEqual([]);
  });

  it("the comment filter keeps code and drops comments", () => {
    expect(code("// amountMinor here\nconst a = 1;")).not.toMatch(/amountMinor/);
    expect(code("/* amountMinor */ x")).not.toMatch(/amountMinor/);
    expect(code("const v = d.amountMinor; // note")).toMatch(/amountMinor/);
    expect(code("const u = 'https://x.y'; d.amountMinor")).toMatch(/amountMinor/);
  });

  it("the item sheet labels it as stored, not as the balance", () => {
    const t = web["./components/OpenItemDetailBody.tsx"] ?? "";
    expect(t).toMatch(/Amount as stored/);
    expect(t.match(/amountMinor/g)?.length).toBe(1);
  });
});
