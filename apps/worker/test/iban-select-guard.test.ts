import { describe, expect, it } from "vitest";

/**
 * Review N10: full IBANs are read only where they are needed, and read routes only ever return
 * masked ones. A source scan (no database):
 *  1. the IBAN column names `counterparty_iban`, `relation_iban`, `beneficiary_iban` appear only in
 *     the allow-list below;
 *  2. a SELECT list that names a bare `iban` column (or `*` from a table that holds IBANs) appears
 *     only in the allow-list;
 *  3. every file under src/read/ that selects an IBAN column uses `maskIban(`, and every IBAN
 *     field it puts in a response is named `...Masked`.
 *
 * To add a reader (matching, a gate lookup) add its file here WITH the reason, in a reviewed diff.
 */
const files = (
  import.meta as unknown as {
    glob: (p: string, o: object) => Record<string, string>;
  }
).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

/** File to reason. */
const ALLOWED_COLUMN_NAMES: Record<string, string> = {
  "../src/revolut/ingest.ts":
    "stores the counterparty IBAN of a transaction and compares it on update",
  "../src/read/bank-routes.ts": "reads it only to mask it (counterpartyIbanMasked)",
};
const ALLOWED_SELECT_IBAN: Record<string, string> = {
  "../src/exact/sync.ts":
    "reconciles relation and relation_ibans rows (never returned to a client)",
  "../src/read/bank-routes.ts": "reads bank_accounts.iban only to mask it (ibanMasked)",
};

const COLUMN_NAME = /\b(?:counterparty_iban|relation_iban|beneficiary_iban)\b/;
const IBAN_TABLES = "bank_transactions|bank_accounts|relations|relation_ibans|payments";

/** Text of every `SELECT ... FROM` list in the source. */
function selectLists(src: string): string[] {
  return [...src.matchAll(/\bSELECT\b([\s\S]*?)\bFROM\b/g)].map((m) => m[1] ?? "");
}

/** True when a SELECT list names a bare iban column or selects `*` from a table that holds IBANs. */
function selectsIban(src: string): boolean {
  if (selectLists(src).some((l) => /(?:^|[\s,.(])iban\b/i.test(l) || COLUMN_NAME.test(l))) {
    return true;
  }
  return new RegExp(`\\bSELECT\\s+(?:\\w+\\.)?\\*\\s+FROM\\s+(?:${IBAN_TABLES})\\b`).test(src);
}

/** IBAN-named fields put into an object (not row type declarations such as `iban: string | null`). */
function ibanFields(src: string): string[] {
  return [...src.matchAll(/\b(\w*[iI]ban\w*)\s*:\s*(?!\s|string\b)/g)].map((m) => m[1] ?? "");
}

describe("the detectors", () => {
  it("see column names and select lists", () => {
    expect(COLUMN_NAME.test("SELECT counterparty_iban FROM bank_transactions")).toBe(true);
    expect(selectsIban("SELECT id, name, iban, is_active FROM bank_accounts")).toBe(true);
    expect(selectsIban("SELECT r.iban FROM relations r")).toBe(true);
    expect(selectsIban("SELECT * FROM relations WHERE id = 1")).toBe(true);
    expect(selectsIban("SELECT t.* FROM bank_transactions t")).toBe(true);
    expect(selectsIban("SELECT COUNT(*) FROM bank_accounts")).toBe(false);
  });

  it("ignore IBANs in WHERE clauses and other tables", () => {
    expect(selectsIban("SELECT id FROM bank_accounts WHERE iban IS NULL")).toBe(false);
    expect(selectsIban("SELECT * FROM jobs")).toBe(false);
    expect(selectsIban("SELECT ibanish_flag FROM x")).toBe(false);
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

  it("the IBAN column names appear only in the allow-list", () => {
    const offenders = Object.entries(files)
      .filter(([name]) => !(name in ALLOWED_COLUMN_NAMES))
      .filter(([, text]) => COLUMN_NAME.test(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("no SELECT of an IBAN column (or select star on an IBAN table) outside the allow-list", () => {
    const offenders = Object.entries(files)
      .filter(([name]) => !(name in ALLOWED_SELECT_IBAN) && !(name in ALLOWED_COLUMN_NAMES))
      .filter(([, text]) => selectsIban(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("read routes that select an IBAN mask it and name every IBAN field Masked", () => {
    const readFiles = Object.entries(files).filter(([name]) => name.startsWith("../src/read/"));
    expect(readFiles.length).toBeGreaterThan(3);
    let checked = 0;
    for (const [name, text] of readFiles) {
      if (!selectsIban(text) && !COLUMN_NAME.test(text)) continue;
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
