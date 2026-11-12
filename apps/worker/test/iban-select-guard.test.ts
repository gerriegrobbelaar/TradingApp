import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Review N10: full IBANs are read only where they are needed, and read routes only ever return
 * masked ones. A source scan of apps/worker/src (no database writes):
 *  1. the IBAN-holding columns and tables are read from the MIGRATED schema (every column named
 *     `iban` or `<something>_iban`), so a new table or column from a later migration is covered
 *     without editing this file;
 *  2. the prefixed column names (`counterparty_iban`, `relation_iban`, ...) appear only in files
 *     on the allow-list;
 *  3. a SELECT list or RETURNING clause that names a bare `iban` column (also qualified `x.iban`,
 *     quoted `"iban"`, any case), or a `*` / `t.*` select whose FROM / JOIN part names a table
 *     that holds IBANs, appears only in allow-listed files;
 *  4. every file under src/read/ that selects an IBAN column calls `maskIban(`, and every
 *     IBAN-named field it puts in an object is named `...Masked`.
 *
 * Limits (a source scan, not a SQL parser): a column or table name built at run time
 * (`"ib" + "an"`, `${col}`), a SELECT list or FROM part held in a separate constant and joined in
 * with `${...}`, or SQL read from a file is not seen. Those patterns are not used for IBAN reads;
 * reviewers must reject them. To add a reader (matching, a gate lookup) add its file here WITH the
 * reason, in a reviewed diff.
 */
const files = (
  import.meta as unknown as {
    glob: (p: string, o: object) => Record<string, string>;
  }
).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

/** File to reason. */
const ALLOWED_COLUMN_NAMES: Record<string, string> = {
  "../src/payments/iban-store.ts":
    "the one payments module that holds IBANs: stores the beneficiary IBAN of a request for sending and reads it only to mask it (ADR 0049)",
  "../src/revolut/ingest.ts":
    "stores the counterparty IBAN of a transaction and compares it on update",
  "../src/read/bank-routes.ts": "reads it only to mask it (counterpartyIbanMasked)",
  "../src/revolut/counterparties.ts":
    "copies a looked-up counterparty IBAN to UNMATCHED bank_transactions rows for matching rule 2 (never returned or logged, ADR 0034)",
  "../src/matching/assemble.ts":
    "reads counterparty and relation IBANs into memory for the matching engine (never returned or logged, ADR 0042)",
  "../src/matching/config.ts":
    "reads bank_accounts.iban for the engine's own-IBAN list (in memory only)",
  "../src/matching/dto.ts": "reads counterparty_iban only to mask it (counterpartyIbanMasked)",
  "../src/matching/routes.ts":
    "reads bank_accounts.iban only to mask it (ibanMasked) and counterparty_iban for the different-relation check on a manual match (in memory, never returned or logged)",
};
const ALLOWED_SELECT_IBAN: Record<string, string> = {
  "../src/payments/iban-store.ts":
    "reads relations.iban and open_items.relation_iban (in memory, to fingerprint and compare), bank_accounts.iban and payments.beneficiary_iban only to mask them (ADR 0049)",
  "../src/exact/sync.ts":
    "reconciles relation and relation_bank_accounts rows (never returned to a client)",
  "../src/read/bank-routes.ts": "reads bank_accounts.iban only to mask it (ibanMasked)",
  "../src/revolut/counterparties.ts":
    "reads revolut_counterparties.iban (the lookup cache) to fill unmatched transactions; never returned or logged (ADR 0034)",
  "../src/matching/assemble.ts":
    "reads relations.iban and bank_transactions.counterparty_iban for the matching engine (in memory only, ADR 0042)",
  "../src/matching/config.ts":
    "reads bank_accounts.iban for the engine's own-IBAN list (in memory only)",
  "../src/matching/dto.ts": "selects counterparty_iban only to mask it (counterpartyIbanMasked)",
  "../src/matching/routes.ts":
    "selects bank_accounts.iban only to mask it (ibanMasked) and counterparty_iban for the different-relation check on a manual match (in memory, never returned or logged)",
};

/** A column that holds a full IBAN: `iban` or `<prefix>_iban` (not `iban_changed_at`). */
const IBAN_COLUMN = /^(?:\w+_)?iban$/i;

interface Schema {
  tables: string[];
  prefixedColumns: string[];
}

async function ibanSchema(): Promise<Schema> {
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>()
  ).results.map((r) => r.name);
  const out: Schema = { tables: [], prefixedColumns: [] };
  for (const t of tables) {
    const cols = (
      await env.DB.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all<{
        name: string;
      }>()
    ).results
      .map((c) => c.name)
      .filter((c) => IBAN_COLUMN.test(c));
    if (cols.length === 0) continue;
    out.tables.push(t);
    for (const c of cols) {
      if (c.toLowerCase() !== "iban" && !out.prefixedColumns.includes(c)) {
        out.prefixedColumns.push(c);
      }
    }
  }
  out.tables.sort();
  out.prefixedColumns.sort();
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The detectors for one schema. Exported shape kept small so the self-tests can drive them. */
function detectors(schema: Schema) {
  const columnName = new RegExp(`\\b(?:${schema.prefixedColumns.map(escape).join("|")})\\b`, "i");
  const tableName = new RegExp(`\\b(?:${schema.tables.map(escape).join("|")})\\b`, "i");
  /** A bare iban column in a select list: start, after a comma, a dot, a paren or a quote. */
  const bareIban = /(?:^|[\s,.(["`'])iban\b/i;
  const namesIban = (list: string) => bareIban.test(list) || columnName.test(list);
  /** A star select (`*`, `t.*`), not COUNT(*). */
  const isStar = (list: string) => /(?:^|[\s,.])\*/.test(list.replace(/\(\s*\*\s*\)/g, ""));

  /** `SELECT <list> FROM <tables up to WHERE/GROUP/ORDER/LIMIT/end of the string>`. */
  function selects(src: string): { list: string; from: string }[] {
    return [
      ...src.matchAll(
        /\bSELECT\b([\s\S]*?)\bFROM\b([\s\S]*?)(?=\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bUNION\b|;|`|$)/gi,
      ),
    ].map((m) => ({ list: m[1] ?? "", from: m[2] ?? "" }));
  }

  function selectsIban(src: string): boolean {
    for (const { list, from } of selects(src)) {
      if (namesIban(list)) return true;
      if (isStar(list) && tableName.test(from)) return true;
    }
    for (const m of src.matchAll(/\bRETURNING\b([^;`]*)/gi)) {
      const list = m[1] ?? "";
      if (namesIban(list) || isStar(list)) return true;
    }
    return false;
  }

  return { columnName, selectsIban };
}

/** IBAN-named fields put into an object (not row type declarations such as `iban: string | null`). */
function ibanFields(src: string): string[] {
  return [...src.matchAll(/\b(\w*[iI]ban\w*)\s*:\s*(?!\s|string\b)/g)].map((m) => m[1] ?? "");
}

let schema: Schema;
let d: ReturnType<typeof detectors>;
beforeAll(async () => {
  schema = await ibanSchema();
  d = detectors(schema);
});

describe("the IBAN schema read from the migrations", () => {
  it("holds the known IBAN tables and columns", () => {
    for (const t of [
      "bank_accounts",
      "bank_transactions",
      "open_items",
      "payments",
      "relation_bank_accounts",
      "relations",
    ]) {
      expect(schema.tables, t).toContain(t);
    }
    for (const c of ["beneficiary_iban", "counterparty_iban", "relation_iban"]) {
      expect(schema.prefixedColumns, c).toContain(c);
    }
    // Flags about an IBAN are not IBANs.
    expect(schema.prefixedColumns).not.toContain("iban_changed_at");
    expect(schema.prefixedColumns).not.toContain("iban_added_at");
  });
});

describe("the detectors", () => {
  it("see column names and select lists, in any case and with quotes or aliases", () => {
    expect(d.columnName.test("SELECT counterparty_iban FROM bank_transactions")).toBe(true);
    expect(d.columnName.test("select COUNTERPARTY_IBAN from x")).toBe(true);
    expect(d.selectsIban("SELECT id, name, iban, is_active FROM bank_accounts")).toBe(true);
    expect(d.selectsIban("SELECT r.iban FROM relations r")).toBe(true);
    expect(d.selectsIban("select r.IBAN as x from relations r")).toBe(true);
    expect(d.selectsIban('SELECT "iban" FROM bank_accounts')).toBe(true);
    expect(d.selectsIban("SELECT `iban` FROM bank_accounts")).toBe(true);
    expect(d.selectsIban("SELECT [iban] FROM bank_accounts")).toBe(true);
    expect(d.selectsIban("SELECT a, (SELECT iban FROM relations) AS b FROM x")).toBe(true);
    expect(d.selectsIban("const q = `SELECT\n  id,\n  iban\nFROM bank_accounts`;")).toBe(true);
  });

  it("see star selects on every IBAN table, including joins and lower case", () => {
    expect(d.selectsIban("SELECT * FROM relations WHERE id = 1")).toBe(true);
    expect(d.selectsIban("SELECT t.* FROM bank_transactions t")).toBe(true);
    expect(d.selectsIban("select * from relation_bank_accounts")).toBe(true);
    expect(d.selectsIban("SELECT x.id, r.* FROM jobs x JOIN relations r ON r.id = x.id")).toBe(
      true,
    );
    expect(d.selectsIban("SELECT oi.* FROM open_items oi")).toBe(true);
    expect(d.selectsIban("SELECT *\n  FROM payments")).toBe(true);
  });

  it("see RETURNING clauses", () => {
    expect(d.selectsIban("UPDATE relations SET x = 1 RETURNING id, iban")).toBe(true);
    expect(d.selectsIban("INSERT INTO payments (a) VALUES (1) RETURNING *")).toBe(true);
    expect(d.selectsIban("UPDATE jobs SET x = 1 RETURNING id")).toBe(false);
  });

  it("ignore IBANs in WHERE clauses, other tables and look-alike names", () => {
    expect(d.selectsIban("SELECT id FROM bank_accounts WHERE iban IS NULL")).toBe(false);
    expect(d.selectsIban("SELECT id FROM bank_accounts ORDER BY iban")).toBe(false);
    expect(d.selectsIban("SELECT * FROM jobs")).toBe(false);
    expect(d.selectsIban("SELECT r.* FROM job_runs r")).toBe(false);
    expect(d.selectsIban("SELECT COUNT(*) FROM bank_accounts")).toBe(false);
    expect(d.selectsIban("SELECT ibanish_flag FROM x")).toBe(false);
    expect(d.selectsIban("SELECT iban_changed_at FROM relations")).toBe(false);
  });

  it("find IBAN fields in objects but not row types", () => {
    expect(ibanFields("ibanMasked: maskIban(x), iban: r.iban")).toEqual(["ibanMasked", "iban"]);
    expect(ibanFields("  iban: string | null;")).toEqual([]);
  });
});

describe("IBAN columns are read only where they are allowed (review N10)", () => {
  it("finds the source files and the allow-listed ones", () => {
    expect(Object.keys(files).length).toBeGreaterThan(20);
    for (const f of [...Object.keys(ALLOWED_COLUMN_NAMES), ...Object.keys(ALLOWED_SELECT_IBAN)]) {
      expect(files[f], f).toBeTruthy();
    }
  });

  it("the prefixed IBAN column names appear only in the allow-list", () => {
    const offenders = Object.entries(files)
      .filter(([name]) => !(name in ALLOWED_COLUMN_NAMES))
      .filter(([, text]) => d.columnName.test(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("no SELECT of an IBAN column (or select star on an IBAN table) outside the allow-list", () => {
    const offenders = Object.entries(files)
      .filter(([name]) => !(name in ALLOWED_SELECT_IBAN) && !(name in ALLOWED_COLUMN_NAMES))
      .filter(([, text]) => d.selectsIban(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("read routes that select an IBAN mask it and name every IBAN field Masked", () => {
    const readFiles = Object.entries(files).filter(([name]) => name.startsWith("../src/read/"));
    expect(readFiles.length).toBeGreaterThan(3);
    let checked = 0;
    for (const [name, text] of readFiles) {
      if (!d.selectsIban(text) && !d.columnName.test(text)) continue;
      checked += 1;
      expect(text, `${name} selects an IBAN but never calls maskIban(`).toMatch(/\bmaskIban\(/);
    }
    expect(checked).toBeGreaterThan(0);
    for (const [name, text] of readFiles) {
      for (const field of ibanFields(text)) {
        expect(field, `${name}: response field ${field} must be masked`).toMatch(/Masked$/);
      }
    }
  });

  it("the read routes never import the raw IBAN helpers of the Exact sync", () => {
    for (const [name, text] of Object.entries(files)) {
      if (!name.startsWith("../src/read/")) continue;
      expect(text, name).not.toMatch(/from\s+"\.\.\/exact\/sync"/);
    }
  });
});
