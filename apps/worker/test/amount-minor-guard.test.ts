import { describe, expect, it } from "vitest";

/**
 * Review S11: `open_items.amount_minor` is "the amount as stored", which may equal the OPEN
 * balance for rows read from the list endpoints (ADR 0022). Only the upsert in sync.ts and the
 * detail route (which labels it "Amount as stored") may touch it. Everything else must use
 * `open_minor` / `original_minor`.
 */
// vite's glob, typed locally (the worker tsconfig has no vite/client types)
const files = (
  import.meta as unknown as {
    glob: (p: string, o: object) => Record<string, string>;
  }
).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

const ALLOWED = new Set(["../src/exact/sync.ts", "../src/read/routes.ts"]);

/**
 * Source without comments (block and line comments; a `//` inside a string such as a URL is kept
 * because the scan stops at quotes and backticks). Comments may name the column freely.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (quote !== null) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** True when code (comments removed) looks like it touches open_items.amount_minor. */
function touchesOpenItemsAmount(src: string): boolean {
  const code = stripComments(src);
  return (
    /\boi\.amount_minor\b/.test(code) ||
    /\bopen_items\b[\s\S]{0,600}?\bamount_minor\b/.test(code) ||
    /\bamount_minor\b[\s\S]{0,600}?\bopen_items\b/.test(code)
  );
}

describe("the detector itself", () => {
  it("flags readers of the column", () => {
    for (const src of [
      "db.prepare('SELECT amount_minor FROM open_items WHERE id = ?1')",
      "const sql = `SELECT oi.amount_minor FROM open_items oi`;",
      "`SELECT SUM(oi.amount_minor) AS total FROM x`",
      "`UPDATE open_items SET status = 'x', amount_minor = 0`",
      "`SELECT id,\n  amount_minor\n FROM open_items`",
    ]) {
      expect(touchesOpenItemsAmount(src), src).toBe(true);
    }
  });

  it("ignores comments and other tables", () => {
    for (const src of [
      "// open_items.amount_minor is the amount as stored\nconst x = 1;",
      "/* SELECT amount_minor FROM open_items */ const y = 2;",
      "/**\n * open_items: never read amount_minor here\n */\nexport {}",
      "`SELECT amount_minor FROM purchase_entries`",
      "`SELECT open_minor FROM open_items`",
      "const url = 'https://example.com//amount_minor'; // open_items",
    ]) {
      expect(touchesOpenItemsAmount(src), src).toBe(false);
    }
  });
});

describe("open_items.amount_minor is not read outside the allow-list (review S11)", () => {
  it("finds the source files", () => {
    expect(Object.keys(files).length).toBeGreaterThan(20);
    expect(files["../src/exact/sync.ts"]).toBeTruthy();
    expect(files["../src/read/routes.ts"]).toBeTruthy();
  });

  it("no file outside sync.ts (upserts) and the detail route touches it", () => {
    const offenders = Object.entries(files)
      .filter(([name]) => !ALLOWED.has(name))
      .filter(([, text]) => touchesOpenItemsAmount(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("sync.ts only writes it, in the open-item upsert", () => {
    const code = stripComments(files["../src/exact/sync.ts"] ?? "");
    const lines = code.split("\n").filter((l) => /\bamount_minor\b/.test(l));
    // the INSERT column list and the ON CONFLICT assignment, nothing else
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/currency, amount_minor, open_minor/);
    expect(lines[1]).toMatch(/^\s*amount_minor = COALESCE\(excluded\./);
  });

  it("the list and totals queries do not select it; routes.ts only in the detail", () => {
    const q = stripComments(files["../src/read/queries.ts"] ?? "");
    expect(q).not.toMatch(/amount_minor/);
    const routes = stripComments(files["../src/read/routes.ts"] ?? "");
    // inside routes.ts it appears only in the detail row type, DETAIL_SQL and the detail body
    const lines = routes.split("\n").filter((l) => /amount_minor/.test(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\s*amount_minor: number;$/);
    expect(lines[1]).toMatch(/oi\.amount_minor/);
    expect(lines[2]).toMatch(/^\s*amountMinor: row\.amount_minor,$/);
    // DETAIL_SQL is the only statement in routes.ts that names it
    expect(routes.match(/oi\.amount_minor/g)).toHaveLength(1);
  });
});
