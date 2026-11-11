import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildXlsx, type SheetSpec } from "./xlsx";
import {
  ageingExport,
  balanceSheetExport,
  headerBlock,
  profitLossExport,
} from "./report-workbooks";
import { exportFileName, slugify } from "../lib/report-files";
import { ageingResponse, balanceSheetResponse, profitLossResponse } from "../test-fixtures-reports";

const CTX = {
  administration: "Alpha BV",
  generatedAt: new Date("2026-11-11T13:05:00Z"),
  syncedAt: "2026-11-11T12:40:00Z",
};

/** Text and numbers of a sheet as rows of strings (inline strings and <v>). */
function table(sheet: SheetSpec, createdAt = CTX.generatedAt): string[][] {
  const zip = unzipSync(buildXlsx([sheet], { createdAt }));
  const doc = new DOMParser().parseFromString(
    strFromU8(zip["xl/worksheets/sheet1.xml"] as Uint8Array),
    "application/xml",
  );
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  const rows: string[][] = [];
  for (const row of Array.from(doc.getElementsByTagName("row"))) {
    const out: string[] = [];
    for (const c of Array.from(row.getElementsByTagName("c"))) {
      const ref = c.getAttribute("r") as string;
      const col =
        ref
          .replace(/\d+/g, "")
          .split("")
          .reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      out[col] =
        c.getAttribute("t") === "inlineStr"
          ? (c.getElementsByTagName("t")[0]?.textContent ?? "")
          : (c.getElementsByTagName("v")[0]?.textContent ?? "");
    }
    rows[Number(row.getAttribute("r")) - 1] = out;
  }
  return Array.from(rows, (r) => r ?? []);
}

const ITEMS = [
  {
    relationId: 1,
    relationName: "Acme BV",
    currency: "EUR",
    openMinor: 100_000,
    dueDate: "2026-11-30",
  },
  {
    relationId: 1,
    relationName: "Acme BV",
    currency: "EUR",
    openMinor: 50_000,
    dueDate: "2026-10-20",
  },
  {
    relationId: 2,
    relationName: '=HYPERLINK("http://x")',
    currency: "EUR",
    openMinor: -2_500,
    dueDate: "2026-06-01",
  },
  { relationId: null, relationName: null, currency: "EUR", openMinor: 700, dueDate: null },
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
];

describe("ageing workbook", () => {
  const r = ageingResponse(ITEMS, "payable");
  const out = ageingExport(r, CTX);

  it("has one sheet per currency and never adds across them", () => {
    expect(out.sheets.map((s) => s.name)).toEqual(["EUR", "JPY", "KWD"]);
    expect(out.slug).toBe("creditors-ageing");
    expect(out.asOfPart).toBe("2026-11-11");
  });

  it("starts with the header block, then a frozen table header", () => {
    const eur = out.sheets[0] as SheetSpec;
    const rows = table(eur);
    expect(rows[0]?.[0]).toBe("Creditors age analysis");
    expect(rows[1]?.[0]).toBe("Administration: Alpha BV");
    expect(rows[2]?.[0]).toBe("As of: 11 Nov 2026");
    expect(rows[3]?.[0]).toContain("Currency: EUR");
    expect(rows[4]?.[0]).toBe("Generated: 11 Nov 2026, 14:05 (Europe/Amsterdam)");
    expect(rows[5]?.[0]).toBe("Source: Exact Online, synced 11 Nov 2026, 13:40 (Amsterdam)");
    expect(rows[7]).toEqual([
      "Supplier",
      "Not due",
      "1–30 days",
      "31–60 days",
      "61–90 days",
      "90+ days",
      "No due date",
      "Total",
      "Items",
    ]);
    expect(eur.freezeRows).toBe(8);
  });

  it("holds exact amounts per relation and a totals row", () => {
    const rows = table(out.sheets[0] as SheetSpec);
    const acme = rows.find((r) => r[0] === "Acme BV");
    // 1,000.00 not due, 500.00 in 1-30 days, 1,500.00 in total over two items.
    expect(acme).toEqual([
      "Acme BV",
      "1000.00",
      "500.00",
      "0.00",
      "0.00",
      "0.00",
      "0.00",
      "1500.00",
      "2",
    ]);
    const total = rows[rows.length - 1];
    expect(total?.[0]).toBe("Total");
    expect(total?.[7]).toBe("1482.00");
    expect(total?.[8]).toBe("4");
  });

  it("neutralises a formula in a relation name and names the unknown relation", () => {
    const rows = table(out.sheets[0] as SheetSpec);
    expect(rows.some((r) => r[0] === `'=HYPERLINK("http://x")`)).toBe(true);
    expect(rows.some((r) => r[0] === "Unknown relation")).toBe(true);
  });

  it("uses each currency's decimals (JPY 0, KWD 3)", () => {
    const jpy = table(out.sheets[1] as SheetSpec).find((r) => r[0] === "Tokyo KK");
    expect(jpy?.[7]).toBe("123456");
    const kwd = table(out.sheets[2] as SheetSpec).find((r) => r[0] === "Kuwait Co");
    expect(kwd?.[7]).toBe("1234.567");
  });

  it("makes a single explanatory sheet when nothing is open", () => {
    const empty = ageingExport(ageingResponse([], "receivable"), CTX);
    expect(empty.sheets).toHaveLength(1);
    expect(table(empty.sheets[0] as SheetSpec).flat()).toContain("No open invoices.");
    expect(empty.slug).toBe("receivables-ageing");
  });
});

describe("balance sheet workbook", () => {
  const out = balanceSheetExport(balanceSheetResponse(), CTX);
  const rows = table(out.sheets[0] as SheetSpec);

  it("names the period and the comparison", () => {
    expect(out.asOfPart).toBe("2026-p02");
    expect(rows[2]?.[0]).toBe("Period: 2026, up to period 2");
    const head = rows.find((r) => r[0] === "Code");
    expect(head).toEqual(["Code", "Account", "2026, up to period 2", "Year end 2025"]);
  });

  it("holds the lines, totals and a zero difference for a balanced ledger", () => {
    const line = (name: string) => rows.find((r) => r[1] === name);
    expect(line("Bank ING")).toEqual(["1100", "Bank ING", "24000.00", "15000.00"]);
    expect(line("Total assets")?.[2]).toBe("25000.00");
    expect(line("Total liabilities and equity")?.[2]).toBe("25000.00");
    expect(line("Difference (should be 0)")).toEqual([
      "",
      "Difference (should be 0)",
      "0.00",
      "0.00",
    ]);
    expect(rows.flat().some((c) => c.startsWith("Warning"))).toBe(false);
  });

  it("flags an unbalanced sheet and missing opening balances in the file too", () => {
    const bad = balanceSheetResponse(
      {},
      {
        balances: [
          {
            glAccountExactId: "a-bank",
            year: 2026,
            period: 1,
            amountMinor: 12_345,
            balanceType: "B",
          },
        ],
      },
    );
    const text = table(balanceSheetExport(bad, CTX).sheets[0] as SheetSpec).flat();
    expect(text).toContain("Warning: the balance sheet does not balance. Check opening balances.");
    expect(text).toContain("Warning: no opening balances (period 0) found for 2026.");
  });

  it("writes a short note instead of an empty sheet", () => {
    const empty = balanceSheetExport(
      balanceSheetResponse({ status: "not_synced", report: null, compareYear: null }),
      CTX,
    );
    expect(table(empty.sheets[0] as SheetSpec).flat()).toContain("Not synced yet.");
  });
});

describe("profit and loss workbook", () => {
  it("has actual, budget, last year and variances with percentages as exact fractions", () => {
    const out = balanceSheetLike();
    const rows = table(out.sheets[0] as SheetSpec);
    const head = rows.find((r) => r[0] === "Code") as string[];
    expect(head).toEqual([
      "Code",
      "Account",
      "Actual",
      "Budget",
      "Variance vs budget",
      "Variance vs budget %",
      "Last year (2025)",
      "Variance vs last year",
      "Variance vs last year %",
    ]);
    const rev = rows.find((r) => r[1] === "Consulting revenue");
    // Actual 11,500.00 vs budget 11,000.00 (+500.00 = +4.5455 %), last year 6,000.00.
    expect(rev).toEqual([
      "8000",
      "Consulting revenue",
      "11500.00",
      "11000.00",
      "500.00",
      "0.0455",
      "6000.00",
      "5500.00",
      "0.9167",
    ]);
    const rent = rows.find((r) => r[1] === "Rent");
    expect(rent?.[2]).toBe("-1500.00");
    const result = rows.find((r) => r[1] === "Result");
    expect(result?.[2]).toBe("10000.00");
  });

  it("drops the budget columns and says why when budgets are unavailable; blanks a missing last year", () => {
    const r = profitLossResponse({}, { budgets: null, compareYear: null });
    const out = profitLossExport(r, CTX);
    const rows = table(out.sheets[0] as SheetSpec);
    expect(rows.find((x) => x[0] === "Code")).toEqual([
      "Code",
      "Account",
      "Actual",
      "Last year (2025)",
      "Variance vs last year",
      "Variance vs last year %",
    ]);
    const rev = rows.find((x) => x[1] === "Consulting revenue") as string[];
    expect(rev[2]).toBe("11500.00");
    expect(rev[3]).toBeUndefined(); // blank, never 0
    const flat = rows.flat();
    expect(flat).toContain("Budget is not available in Exact for this administration.");
    expect(flat.some((c) => c.includes("has not been synced"))).toBe(true);
  });

  function balanceSheetLike() {
    return profitLossExport(profitLossResponse(), CTX);
  }
});

describe("header block and file names", () => {
  it("says never synced", () => {
    const rows = headerBlock("T", { ...CTX, syncedAt: null }, "As of: x");
    const last = rows[rows.length - 2]?.[0];
    expect(last).toMatchObject({ text: "Source: Exact Online, never synced" });
  });

  it("builds camelthorn-<report>-<administration>-<asOf>.xlsx from safe characters only", () => {
    expect(exportFileName("creditors-ageing", "Alpha B.V. (Test)", "2026-11-11")).toBe(
      "camelthorn-creditors-ageing-alpha-b-v-test-2026-11-11.xlsx",
    );
    expect(exportFileName("balance-sheet", "Café Zoë / Ünït ../../etc", "2026-p10")).toBe(
      "camelthorn-balance-sheet-cafe-zoe-unit-etc-2026-p10.xlsx",
    );
    expect(slugify("   ")).toBe("administration");
    expect(slugify("日本語")).toBe("administration");
    expect(slugify("a".repeat(100)).length).toBe(40);
    expect(exportFileName("profit-loss", "A", "x/../y")).toBe("camelthorn-profit-loss-a-x-y.xlsx");
  });
});
