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

const isTest = (n: string) => /\.test\.|test-fixtures|test-utils|test-setup/.test(n);
const WEB_ALLOWED = new Set([
  "./components/OpenItemDetailBody.tsx", // the sheet row "Amount as stored"
  "./components/AccountSheet.tsx", // ledger periods, unrelated to open items
  "./pages/Approvals.tsx", // purchase entries, unrelated
]);
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
      .filter(([n]) => !isTest(n) && !WEB_ALLOWED.has(n))
      .filter(([, t]) => /\bamountMinor\b/.test(t))
      .map(([n]) => n);
    expect(offenders).toEqual([]);
  });

  it("core: only the type definitions and the ledger report use amountMinor", () => {
    const offenders = Object.entries(core)
      .filter(([n]) => !/\.test\./.test(n) && !CORE_ALLOWED.has(n))
      .filter(([, t]) => /\bamountMinor\b/.test(t))
      .map(([n]) => n);
    expect(offenders).toEqual([]);
  });

  it("the item sheet labels it as stored, not as the balance", () => {
    const t = web["./components/OpenItemDetailBody.tsx"] ?? "";
    expect(t).toMatch(/Amount as stored/);
    expect(t.match(/amountMinor/g)?.length).toBe(1);
  });
});
