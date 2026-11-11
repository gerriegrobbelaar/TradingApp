import { describe, expect, it } from "vitest";

/**
 * Review S10/S11: `open_items.stored_minor` is "the amount as stored". It may equal the OPEN
 * balance (ADR 0022), so it must not feed a list, a total or a report. A plain name scan: the
 * column name may appear only in the files below. Everything else uses `open_minor` and
 * `original_minor`. (Other tables keep their own `amount_minor` columns; the name differs on
 * purpose, so this scan cannot trip over them.)
 */
// vite's glob, typed locally (the worker tsconfig has no vite/client types)
const files = (
  import.meta as unknown as {
    glob: (p: string, o: object) => Record<string, string>;
  }
).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

const NAME = /\bstored_minor\b|\bstoredMinor\b/;
const ALLOWED = new Set([
  "../src/exact/sync.ts", // the open-item upsert
  "../src/read/routes.ts", // the detail route
]);

describe("open_items.stored_minor stays inside its allow-list", () => {
  it("finds the source files", () => {
    expect(Object.keys(files).length).toBeGreaterThan(20);
    for (const f of ALLOWED) expect(files[f], f).toBeTruthy();
  });

  it("no source file outside the allow-list names it", () => {
    const offenders = Object.entries(files)
      .filter(([name]) => !ALLOWED.has(name))
      .filter(([, text]) => NAME.test(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("the list and totals queries do not name it", () => {
    expect(files["../src/read/queries.ts"] ?? "").not.toMatch(NAME);
  });

  // The exact line counts below are deliberate: a new use inside an allowed file (a second query
  // in routes.ts, say) must fail here and be reviewed. Reformatting that moves the name to another
  // line also fails; update the expected lines in the same diff.
  it("sync.ts names it only in the upsert (column list and conflict assignment)", () => {
    const lines = (files["../src/exact/sync.ts"] ?? "").split("\n").filter((l) => NAME.test(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/currency, stored_minor, open_minor/);
    expect(lines[1]).toMatch(/^\s*stored_minor = COALESCE\(excluded\./);
  });

  it("routes.ts names it only in the detail row type, DETAIL_SQL and the detail body", () => {
    const lines = (files["../src/read/routes.ts"] ?? "").split("\n").filter((l) => NAME.test(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\s*stored_minor: number;$/);
    expect(lines[1]).toMatch(/oi\.stored_minor/);
    expect(lines[2]).toMatch(/^\s*storedMinor: row\.stored_minor,$/);
  });

  // A star select would carry the column without naming it, so the name scan would not see it.
  const starFromOpenItems = (s: string) =>
    /\bSELECT\b(?:(?!\bFROM\b)[\s\S])*?(?:^|[\s,.])\*(?:(?!\bFROM\b)[\s\S])*?\bFROM\s+open_items\b/i.test(
      s.replace(/\(\s*\*\s*\)/g, "()"),
    );

  it("no source file selects * (or oi.*) from open_items", () => {
    const offenders = Object.entries(files)
      .filter(([, text]) => starFromOpenItems(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("the star check itself works", () => {
    const hit = starFromOpenItems;
    expect(hit("SELECT * FROM open_items")).toBe(true);
    expect(hit("select oi.* from open_items oi")).toBe(true);
    expect(hit("SELECT id,\n  oi.*\nFROM open_items oi")).toBe(true);
    expect(hit("SELECT COUNT(*) FROM open_items")).toBe(false);
    expect(hit("SELECT * FROM jobs; SELECT id FROM open_items")).toBe(false);
  });

  it("the name check itself works", () => {
    expect(NAME.test("SELECT oi.stored_minor FROM open_items oi")).toBe(true);
    expect(NAME.test("detail.storedMinor")).toBe(true);
    expect(NAME.test("SELECT amount_minor FROM bank_transactions")).toBe(false);
    expect(NAME.test("restored_minors")).toBe(false);
  });
});
