/**
 * Review S6: the converted ageing row cross-foots. The Total cell is the SUM of the bucket cells,
 * for any report, on screen, in print (same numbers) and in the Excel file. Each bucket is still
 * converted once per currency, so the Total may differ by a few cents from one conversion of the
 * summed amounts (shown below, so the documented consequence is real and not hypothetical).
 */
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { AGEING_BUCKETS, addDays } from "@camelthorn/core";
import { ageingExport } from "../export/report-workbooks";
import { buildXlsx, type SheetSpec } from "../export/xlsx";
import { fxRates, fxRatesNoGbp } from "../test-fixtures-fx";
import { ageingResponse, type AgeingFixtureItem } from "../test-fixtures-reports";
import { ageingTotalsInBase, rateTableFromResponse, sumInBase } from "./fx";
import { minorToDecimal } from "./format";

/** Small deterministic generator (mulberry32): the same reports on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CURRENCIES = ["EUR", "USD", "GBP", "JPY", "KWD"] as const;
const AS_OF = "2026-11-11";

function randomItems(rand: () => number): AgeingFixtureItem[] {
  const n = 1 + Math.floor(rand() * 25);
  const items: AgeingFixtureItem[] = [];
  for (let i = 0; i < n; i++) {
    const currency = CURRENCIES[Math.floor(rand() * CURRENCIES.length)] as string;
    const sign = rand() < 0.1 ? -1 : 1;
    items.push({
      relationId: 1 + Math.floor(rand() * 4),
      relationName: `Relation ${i}`,
      currency,
      openMinor: sign * (1 + Math.floor(rand() * 5_000_000)),
      dueDate: rand() < 0.05 ? null : addDays(AS_OF, 40 - Math.floor(rand() * 160)),
    });
  }
  return items;
}

describe("the converted ageing row cross-foots (S6)", () => {
  const full = rateTableFromResponse(fxRates()) as NonNullable<
    ReturnType<typeof rateTableFromResponse>
  >;
  const noGbp = rateTableFromResponse(fxRatesNoGbp()) as NonNullable<
    ReturnType<typeof rateTableFromResponse>
  >;

  it("the Total cell is exactly the sum of the bucket cells, for 400 random reports", () => {
    const rand = prng(20261111);
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const report = ageingResponse(randomItems(rand));
      for (const [table, base] of [
        [full, "EUR"],
        [noGbp, "EUR"],
        [full, "GBP"],
        [noGbp, "USD"],
      ] as const) {
        const t = ageingTotalsInBase(table, base, report.currencies);
        if (!t) continue;
        let sum = 0n;
        for (const b of AGEING_BUCKETS) sum += t.cells[b].totalMinor;
        expect(t.cells.total.totalMinor).toBe(sum);
        // every cell leaves out the same currencies, so no column mixes in one another lacks
        for (const k of [...AGEING_BUCKETS, "total"] as const) {
          expect(t.cells[k].excluded).toEqual(t.excluded);
          expect(t.cells[k].invalid).toEqual(t.invalid);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("the Excel row holds the same numbers as the screen cells, and cross-foots", () => {
    const rand = prng(7);
    const ctx = {
      administration: "Alpha BV",
      generatedAt: new Date("2026-11-11T13:05:00Z"),
      syncedAt: "2026-11-11T12:40:00Z",
    };
    let compared = 0;
    for (let i = 0; i < 60; i++) {
      const report = ageingResponse(randomItems(rand));
      const t = ageingTotalsInBase(full, "EUR", report.currencies);
      if (!t) continue;
      const out = ageingExport(report, ctx, "outstanding", t);
      const sheet = out.sheets.at(-1) as SheetSpec;
      const zip = unzipSync(buildXlsx([sheet], { createdAt: ctx.generatedAt }));
      const doc = new DOMParser().parseFromString(
        strFromU8(zip["xl/worksheets/sheet1.xml"] as Uint8Array),
        "application/xml",
      );
      const rows = Array.from(doc.getElementsByTagName("row"), (row) =>
        Array.from(row.getElementsByTagName("c"), (c) =>
          c.getAttribute("t") === "inlineStr"
            ? (c.getElementsByTagName("t")[0]?.textContent ?? "")
            : (c.getElementsByTagName("v")[0]?.textContent ?? ""),
        ),
      );
      const line = rows.find((r) => r[0] === "Total in € at today's ECB rates") as string[];
      AGEING_BUCKETS.forEach((b, j) => {
        const empty = t.counts[b] === 0 || t.cells[b].included.length === 0;
        expect(line[1 + j] ?? "").toBe(empty ? "" : minorToDecimal(t.cells[b].totalMinor, 2));
      });
      const empty = t.counts.total === 0 || t.cells.total.included.length === 0;
      const last = line[1 + AGEING_BUCKETS.length] ?? "";
      expect(last).toBe(empty ? "" : minorToDecimal(t.cells.total.totalMinor, 2));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(30);
  });

  it("can differ by a few cents from one conversion of the summed amounts (documented)", () => {
    const rand = prng(99);
    let differing = 0;
    for (let i = 0; i < 300; i++) {
      const report = ageingResponse(randomItems(rand));
      const t = ageingTotalsInBase(full, "EUR", report.currencies);
      if (!t) continue;
      // one conversion per currency of its grand total, the way the Total used to be built
      const once = sumInBase(
        full,
        "EUR",
        report.currencies.map((c) => ({ currency: c.currency, minor: c.totals.totalMinor })),
      );
      const diff = t.cells.total.totalMinor - once.totalMinor;
      // at most half a cent per bucket and currency
      const limit = BigInt(report.currencies.length * AGEING_BUCKETS.length);
      expect(diff <= limit && -diff <= limit).toBe(true);
      if (diff !== 0n) differing += 1;
    }
    expect(differing).toBeGreaterThan(0);
  });
});
