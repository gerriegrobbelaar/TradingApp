import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { ageingTotalsInBase, buildRateTable } from "../lib/fx";
import { ageingResponse } from "../test-fixtures-reports";
import { fxRatesNoGbp } from "../test-fixtures-fx";
import { ageingExport } from "./report-workbooks";
import { buildXlsx, type SheetSpec } from "./xlsx";

const CTX = {
  administration: "Alpha BV",
  generatedAt: new Date("2026-11-11T13:05:00Z"),
  syncedAt: "2026-11-11T12:40:00Z",
};

/** Cell texts of the first sheet of a one-sheet workbook, rows of strings. */
function table(sheet: SheetSpec): string[][] {
  const zip = unzipSync(buildXlsx([sheet], { createdAt: CTX.generatedAt }));
  const doc = new DOMParser().parseFromString(
    strFromU8(zip["xl/worksheets/sheet1.xml"] as Uint8Array),
    "application/xml",
  );
  return Array.from(doc.getElementsByTagName("row"), (row) =>
    Array.from(row.getElementsByTagName("c"), (c) =>
      c.getAttribute("t") === "inlineStr"
        ? (c.getElementsByTagName("t")[0]?.textContent ?? "")
        : (c.getElementsByTagName("v")[0]?.textContent ?? ""),
    ),
  );
}

const ITEMS = [
  {
    relationId: 1,
    relationName: "Acme",
    currency: "EUR",
    openMinor: 100_000,
    dueDate: "2026-12-01",
  },
  {
    relationId: 2,
    relationName: "Beta",
    currency: "USD",
    openMinor: 10_000,
    dueDate: "2026-12-01",
  },
  { relationId: 2, relationName: "Beta", currency: "USD", openMinor: 5_000, dueDate: "2026-09-01" },
  {
    relationId: 3,
    relationName: "Gamma",
    currency: "GBP",
    openMinor: 7_000,
    dueDate: "2026-12-01",
  },
];

describe("ageing export with the converted total", () => {
  const r = ageingResponse(ITEMS);
  const table0 = buildRateTable(fxRatesNoGbp());
  const fx = ageingTotalsInBase(table0 as NonNullable<typeof table0>, "EUR", r.currencies);

  it("adds one sheet with the rate date, the estimate wording and exact amounts", () => {
    expect(fx).not.toBeNull();
    const out = ageingExport(r, CTX, "outstanding", fx);
    const names = out.sheets.map((s) => s.name);
    expect(names).toEqual(["EUR", "GBP", "USD", "Total in EUR"]);
    const rows = table(out.sheets[3] as SheetSpec);
    const flat = rows.map((x) => x.join("|")).join("\n");
    expect(flat).toContain("ECB rates of 10 Nov; for information only");
    expect(flat).toContain("Not included (no ECB rate): GBP");
    expect(flat).toContain("each currency is converted once");
    const total = rows.find((x) => x[0] === "Total in € at today's ECB rates") as string[];
    // not due 1.092,14; 61-90 days 46,07; overall 1.138,21 (exact number text, not floats)
    expect(total[1]).toBe("1092.14");
    expect(total[4]).toBe("46.07");
    expect(total[7]).toBe("1138.21");
  });

  it("is unchanged without converted totals", () => {
    const out = ageingExport(r, CTX);
    expect(out.sheets.map((s) => s.name)).toEqual(["EUR", "GBP", "USD"]);
    expect(ageingExport(r, CTX, "outstanding", null).sheets).toHaveLength(3);
  });

  it("in a GBP administration without a GBP rate names GBP as the missing rate", () => {
    const gbpReport = ageingResponse(
      [
        {
          relationId: 1,
          relationName: "Acme",
          currency: "GBP",
          openMinor: 5_000,
          dueDate: "2026-12-01",
        },
        {
          relationId: 2,
          relationName: "Beta",
          currency: "USD",
          openMinor: 10_000,
          dueDate: "2026-12-01",
        },
      ],
      "receivable",
    );
    const t = buildRateTable(fxRatesNoGbp());
    const totals = ageingTotalsInBase(t as NonNullable<typeof t>, "GBP", gbpReport.currencies);
    const out = ageingExport(gbpReport, CTX, "outstanding", totals);
    const sheet = out.sheets.at(-1) as SheetSpec;
    expect(sheet.name).toBe("Total in GBP");
    const flat = table(sheet)
      .map((x) => x.join("|"))
      .join("\n");
    expect(flat).toContain("Not included (no ECB rate for GBP): USD");
    // only the GBP amount itself is in the total: 50.00, exact text, no float artefacts
    const row = table(sheet).find((x) => x[0] === "Total in GBP at today's ECB rates") as string[];
    expect(row[1]).toBe("50.00");
    expect(row.every((c) => !/e[+-]|NaN|undefined/.test(c))).toBe(true);
  });
});
