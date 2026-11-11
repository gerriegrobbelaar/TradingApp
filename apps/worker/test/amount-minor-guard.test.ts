import { describe, expect, it } from "vitest";

/**
 * Review S11: `open_items.amount_minor` is "the amount as stored", which may equal the OPEN
 * balance for rows read from the list endpoints (ADR 0022). Only the upsert in sync.ts and the
 * detail route (which labels it "Amount as stored") may touch it. Everything else must use
 * `open_minor` / `original_minor`.
 */
const files = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ALLOWED = new Set(["../src/exact/sync.ts", "../src/read/routes.ts"]);

describe("open_items.amount_minor is not read outside the allow-list (review S11)", () => {
  it("finds the source files", () => {
    expect(Object.keys(files).length).toBeGreaterThan(20);
    expect(files["../src/exact/sync.ts"]).toBeTruthy();
  });

  it("only sync.ts (upserts) and the detail route mention it", () => {
    const offenders = Object.entries(files)
      .filter(([name]) => !ALLOWED.has(name))
      .filter(
        ([, text]) =>
          /\boi\.amount_minor\b/.test(text) ||
          /open_items[\s\S]{0,600}?\bamount_minor\b/.test(text) ||
          /\bamount_minor\b[\s\S]{0,600}?open_items/.test(text),
      )
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("the list and totals queries do not select it", () => {
    const q = files["../src/read/queries.ts"] ?? "";
    expect(q).not.toMatch(/amount_minor/);
    const routes = files["../src/read/routes.ts"] ?? "";
    // inside routes.ts it appears only in the detail row type, DETAIL_SQL and the detail body
    const lines = routes.split("\n").filter((l) => /amount_minor/.test(l));
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const l of lines) expect(l).toMatch(/amount_minor: number|oi\.amount_minor|row\.amount_minor/);
  });
});
