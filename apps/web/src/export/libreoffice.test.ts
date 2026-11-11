/**
 * Opens the generated workbooks in LibreOffice (when it is installed) and compares what it reads
 * with what we wrote: real files, real spreadsheet engine. Skipped where `soffice` is missing,
 * so CI without LibreOffice stays green; the XML checks in xlsx.test.ts always run.
 *
 * Conversion: `soffice --headless --convert-to csv` with every sheet exported
 * (`...,-1` as the last filter token) and cell contents "as shown", so number formats count too.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildXlsx, type SheetSpec } from "./xlsx";
import { ageingExport, balanceSheetExport, profitLossExport } from "./report-workbooks";
import { ageingResponse, balanceSheetResponse, profitLossResponse } from "../test-fixtures-reports";

function sofficeVersion(): string | null {
  const r = spawnSync("soffice", ["--version"], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}
const VERSION = sofficeVersion();
const CTX = {
  administration: "Alpha BV",
  generatedAt: new Date("2026-11-11T13:05:00Z"),
  syncedAt: "2026-11-11T12:40:00Z",
};

/** Minimal CSV reader (quotes, doubled quotes, commas, newlines in quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function convert(name: string, sheets: SheetSpec[]): Record<string, string[][]> {
  const dir = mkdtempSync(join(tmpdir(), "camelthorn-xlsx-"));
  try {
    const file = join(dir, `${name}.xlsx`);
    writeFileSync(file, buildXlsx(sheets, { createdAt: CTX.generatedAt, title: name }));
    execFileSync(
      "soffice",
      [
        "--headless",
        "-env:UserInstallation=file://" + join(dir, "profile"),
        "--convert-to",
        // separator, quote, charset UTF-8, first line 1, formats default, language default,
        // quote all text off, detect special numbers off, save as shown ON, export formulas off,
        // remove spaces off, sheet -1 = every sheet to its own file.
        "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,false,true,false,false,-1",
        "--outdir",
        dir,
        file,
      ],
      { timeout: 120_000, stdio: "pipe" },
    );
    const out: Record<string, string[][]> = {};
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".csv")) continue;
      const sheet = f.replace(`${name}-`, "").replace(/\.csv$/, "");
      out[sheet] = parseCsv(readFileSync(join(dir, f), "utf8"));
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(VERSION === null)(
  `LibreOffice reads the exports (${VERSION ?? "not installed"})`,
  () => {
    it("ageing: one sheet per currency, amounts as numbers in the right format, formulas inert", () => {
      const r = ageingResponse(
        [
          {
            relationId: 1,
            relationName: "Acme BV",
            currency: "EUR",
            openMinor: 123_456_789,
            dueDate: "2026-11-30",
          },
          {
            relationId: 2,
            relationName: "=1+1",
            currency: "EUR",
            openMinor: -2_500,
            dueDate: "2026-06-01",
          },
          {
            relationId: 3,
            relationName: "Tokyo KK",
            currency: "JPY",
            openMinor: 123_456,
            dueDate: "2026-11-01",
          },
          {
            relationId: 4,
            relationName: "Kuwait Co",
            currency: "KWD",
            openMinor: 1_234_567,
            dueDate: "2026-11-01",
          },
        ],
        "payable",
      );
      const sheets = convert("ageing", ageingExport(r, CTX).sheets);
      expect(Object.keys(sheets).sort()).toEqual(["EUR", "JPY", "KWD"]);
      const eur = sheets["EUR"] as string[][];
      expect(eur[0]?.[0]).toBe("Creditors age analysis");
      const acme = eur.find((x) => x[0] === "Acme BV") as string[];
      // Number format #,##0.00 as LibreOffice shows it; 1,234,567.89 not due.
      expect(acme.slice(1, 3)).toEqual(["1,234,567.89", "0.00"]);
      expect(acme[7]).toBe("1,234,567.89");
      // The formula-looking name is text with a leading apostrophe, not 2.
      expect(eur.some((x) => x[0] === "'=1+1")).toBe(true);
      expect(eur.some((x) => x[0] === "2")).toBe(false);
      expect((sheets["JPY"] as string[][]).find((x) => x[0] === "Tokyo KK")?.[2]).toBe("123,456");
      expect((sheets["KWD"] as string[][]).find((x) => x[0] === "Kuwait Co")?.[2]).toBe(
        "1,234.567",
      );
    });

    it("balance sheet and profit and loss: values equal what the API returned", () => {
      const bs = convert("bs", balanceSheetExport(balanceSheetResponse(), CTX).sheets);
      const rows = Object.values(bs)[0] as string[][];
      expect(rows.find((x) => x[1] === "Bank ING")).toEqual([
        "1100",
        "Bank ING",
        "24,000.00",
        "15,000.00",
      ]);
      expect(rows.find((x) => x[1] === "Total assets")?.[2]).toBe("25,000.00");
      expect(rows.find((x) => x[1] === "Difference (should be 0)")?.slice(2)).toEqual([
        "0.00",
        "0.00",
      ]);

      const pl = convert("pl", profitLossExport(profitLossResponse(), CTX).sheets);
      const plRows = Object.values(pl)[0] as string[][];
      const rev = plRows.find((x) => x[1] === "Consulting revenue") as string[];
      expect(rev.slice(2)).toEqual([
        "11,500.00",
        "11,000.00",
        "500.00",
        "4.6%",
        "6,000.00",
        "5,500.00",
        "91.7%",
      ]);
      expect(plRows.find((x) => x[1] === "Result")?.[2]).toBe("10,000.00");
    });
  },
);
