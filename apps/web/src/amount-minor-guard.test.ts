/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * Review S10/S11: `OpenItemDetail.storedMinor` is the amount as stored, which may equal the open
 * balance (ADR 0022). It is shown on the item sheet under that label and must never feed a list
 * row, a total or a report. Lists use `openMinor` / `originalMinor`. A plain name scan: the name
 * may appear only in the files below (tests and fixtures excepted).
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

const NAME = /\bstoredMinor\b/;
const isTest = (n: string) => /\.test\.|test-fixtures|test-utils|test-setup/.test(n);
const WEB_ALLOWED = new Set(["./components/OpenItemDetailBody.tsx"]); // the "Amount as stored" row
const CORE_ALLOWED = new Set(["../../../packages/core/src/api-types.ts"]); // the type definition

describe("OpenItemDetail.storedMinor stays out of lists and totals", () => {
  it("finds the sources", () => {
    expect(Object.keys(web).length).toBeGreaterThan(20);
    expect(Object.keys(core).length).toBeGreaterThan(10);
    for (const f of WEB_ALLOWED) expect(web[f], f).toBeTruthy();
    for (const f of CORE_ALLOWED) expect(core[f], f).toBeTruthy();
  });

  it("web: only the item sheet names it", () => {
    const offenders = Object.entries(web)
      .filter(([n]) => !isTest(n) && !WEB_ALLOWED.has(n))
      .filter(([, t]) => NAME.test(t))
      .map(([n]) => n);
    expect(offenders).toEqual([]);
  });

  it("core: only the type definition names it", () => {
    const offenders = Object.entries(core)
      .filter(([n]) => !/\.test\./.test(n) && !CORE_ALLOWED.has(n))
      .filter(([, t]) => NAME.test(t))
      .map(([n]) => n);
    expect(offenders).toEqual([]);
  });

  it("the item sheet labels it as stored, not as the balance", () => {
    const t = web["./components/OpenItemDetailBody.tsx"] ?? "";
    expect(t).toMatch(/Amount as stored/);
    expect(t.match(/storedMinor/g)?.length).toBe(1);
  });
});
