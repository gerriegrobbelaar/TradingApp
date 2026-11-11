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
import { buildXlsx, type Cell, type SheetSpec } from "./xlsx";
import { formatBps, minorToDecimal } from "../lib/format";
import { ageingExport, balanceSheetExport, profitLossExport } from "./report-workbooks";
import { ageingResponse, balanceSheetResponse, profitLossResponse } from "../test-fixtures-reports";
import type { BalanceSheetResponse, ProfitLossResponse } from "@camelthorn/core";

/** What LibreOffice shows for minor units in the #,##0.00 style formats (en-US grouping). */
function shown(minor: number | bigint, scale: number): string {
  const d = minorToDecimal(BigInt(minor), scale);
  const neg = d.startsWith("-");
  const [int, frac] = (neg ? d.slice(1) : d).split(".");
  const grouped = (int ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac === undefined ? "" : `.${frac}`}`;
}

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

    it("money: exact digits for scales 0, 2 and 3, negatives, tiny and huge values; long ones as text", () => {
      const m = (minor: bigint | number, scale: number): Cell => ({ kind: "money", minor, scale });
      const cases: [bigint | number, number, string][] = [
        [5, 2, "0.05"],
        [-5, 2, "-0.05"],
        [100, 2, "1.00"],
        [0, 2, "0.00"],
        [-1, 0, "-1"],
        [123_456, 0, "123,456"],
        [-5, 3, "-0.005"],
        [1_234_567, 3, "1,234.567"],
        [Number.MAX_SAFE_INTEGER, 2, "90071992547409.91"], // 16 digits: exact text
        // 15 digits: still a number. (LibreOffice 24.2 DISPLAYS 9,999,999,999,999.99 as
        // 10,000,000,000,000.00 although it stores the exact value; Excel shows it right.)
        [987_654_321_098_765n, 2, "9,876,543,210,987.65"],
        [-123_456_789_012_345_678n, 2, "-1234567890123456.78"],
        [99_999_999_999_999_999n, 0, "99999999999999999"],
      ];
      const sheets = convert("money", [
        { name: "M", rows: cases.map(([minor, scale]) => [m(minor, scale)]) },
      ]);
      const rows = sheets["M"] ?? Object.values(sheets)[0] ?? [];
      cases.forEach(([, , want], i) => expect(rows[i]?.[0], want).toBe(want));
      // never scientific notation
      expect(rows.flat().some((c) => /e[+-]?\d/i.test(c))).toBe(false);
    });

    it("percentages: LibreOffice shows the same one-decimal figure as the screen", () => {
      const bps = [1234, 1235, -1235, 1245, -1245, 5, 4, -4, 45, -45, 99_995, 0, -10_000, 123_456];
      const sheets = convert("pct", [
        { name: "P", rows: bps.map((b) => [{ kind: "bps", bps: b } as Cell]) },
      ]);
      const rows = sheets["P"] ?? Object.values(sheets)[0] ?? [];
      bps.forEach((b, i) => {
        const screen = formatBps(b).replace(",", ".");
        expect(rows[i]?.[0], `bps ${b}`).toBe(screen);
      });
    });

    it("formula-looking text stays inert text, including after spaces and in full-width forms", () => {
      const evil = ["=1+1", " =1+1", "+1", "-1+1", "@SUM(1)", "\uFF1D1+1", "\u00A0=2+2"];
      const sheets = convert("evil", [
        { name: "E", rows: evil.map((e) => [{ kind: "text", text: e } as Cell]) },
      ]);
      const rows = sheets["E"] ?? Object.values(sheets)[0] ?? [];
      evil.forEach((e, i) => expect(rows[i]?.[0]).toBe(`'${e}`));
      expect(rows.flat()).not.toContain("2");
      expect(rows.flat()).not.toContain("4");
    });

    for (const currency of ["EUR", "JPY", "KWD"] as const) {
      it(`balance sheet and profit and loss in ${currency}: every figure equals the API value`, () => {
        const scale = currency === "JPY" ? 0 : currency === "KWD" ? 3 : 2;
        const div = { ...balanceSheetResponse().division, currency };
        const bs: BalanceSheetResponse = { ...balanceSheetResponse(), division: div };
        const rows =
          Object.values(convert(`bs-${currency}`, balanceSheetExport(bs, CTX).sheets))[0] ?? [];
        const rep = bs.report;
        if (!rep) throw new Error("fixture");
        for (const sec of Object.values(rep.sections)) {
          for (const l of sec.lines) {
            const r = rows.find((x) => x[1] === l.name);
            expect(r?.slice(2), l.name).toEqual([
              shown(l.current, scale),
              l.compare === null ? "" : shown(l.compare, scale),
            ]);
          }
        }
        expect(rows.find((x) => x[1] === "Result for the year to date")?.[2]).toBe(
          shown(rep.result.current, scale),
        );
        const pl: ProfitLossResponse = { ...profitLossResponse(), division: div };
        const plRows =
          Object.values(convert(`pl-${currency}`, profitLossExport(pl, CTX).sheets))[0] ?? [];
        const plRep = pl.report;
        if (!plRep) throw new Error("fixture");
        for (const sec of Object.values(plRep.sections)) {
          for (const l of sec.lines) {
            const r = plRows.find((x) => x[1] === l.name);
            expect(r?.slice(2), l.name).toEqual([
              shown(l.actual, scale),
              l.budget === null ? "" : shown(l.budget, scale),
              l.vsBudget.minor === null ? "" : shown(l.vsBudget.minor, scale),
              formatBps(l.vsBudget.bps).replace(",", ".").replace("—", ""),
              l.lastYear === null ? "" : shown(l.lastYear, scale),
              l.vsLastYear.minor === null ? "" : shown(l.vsLastYear.minor, scale),
              formatBps(l.vsLastYear.bps).replace(",", ".").replace("—", ""),
            ]);
          }
        }
        // costs are negative in the file as on the screen
        expect(plRows.find((x) => x[1] === "Rent")?.[2]?.startsWith("-")).toBe(true);
      });
    }
  },
);
