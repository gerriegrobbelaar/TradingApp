/**
 * From a report API response to the sheets of its Excel file. Pure: no DOM, no network. Money
 * stays integer minor units here (the writer turns them into exact number text), so what the
 * file holds is what the API returned.
 */
import type {
  AgeingBucket,
  AgeingReportResponse,
  BalanceSheetResponse,
  ProfitLossResponse,
} from "@camelthorn/core";
import { AGEING_BUCKETS } from "@camelthorn/core";
import { BUCKET_LABEL } from "../lib/ageing";
import { formatDate, formatDateTime, scaleOf } from "../lib/format";
import type { ReportSlug } from "../lib/report-files";
import type { Cell, SheetSpec } from "./xlsx";

export interface ExportContext {
  administration: string;
  generatedAt: Date;
  /** The report's data freshness: last complete read from Exact, or null when never. */
  syncedAt: string | null;
}

export interface ReportExport {
  slug: ReportSlug;
  title: string;
  /** The date part of the file name: the as-of date, or the year and period. */
  asOfPart: string;
  sheets: SheetSpec[];
}

const text = (t: string, style: Extract<Cell, { kind: "text" }>["style"] = {}): Cell => ({
  kind: "text",
  text: t,
  style,
});
const bold = { bold: true } as const;

/** Title, administration, as-of, generated at (Amsterdam), source: the block above every table. */
export function headerBlock(
  title: string,
  ctx: ExportContext,
  asOfLine: string,
  extra: string[] = [],
): (Cell | null)[][] {
  const synced =
    ctx.syncedAt === null ? "never synced" : `synced ${formatDateTime(ctx.syncedAt)} (Amsterdam)`;
  return [
    [text(title, { title: true })],
    [text(`Administration: ${ctx.administration}`)],
    [text(asOfLine)],
    ...extra.map((e) => [text(e)]),
    [text(`Generated: ${formatDateTime(ctx.generatedAt.toISOString())} (Europe/Amsterdam)`)],
    [text(`Source: Exact Online, ${synced}`)],
    [],
  ];
}

const money = (
  minor: number | bigint,
  scale: number,
  style?: { bold?: boolean; total?: boolean },
): Cell => ({
  kind: "money",
  minor,
  scale,
  ...(style ? { style } : {}),
});

const header = (labels: string[], rightFrom = 1): Cell[] =>
  labels.map((l, i) =>
    text(l, { header: true, ...(i >= rightFrom ? { align: "right" as const } : {}), wrap: true }),
  );

// ---- ageing -------------------------------------------------------------------------------------

export function ageingExport(r: AgeingReportResponse, ctx: ExportContext): ReportExport {
  const payable = r.kind === "payable";
  const title = payable ? "Creditors age analysis" : "Receivables age analysis";
  const relationLabel = payable ? "Supplier" : "Customer";
  const heads = [
    relationLabel,
    ...AGEING_BUCKETS.map((b: AgeingBucket) => BUCKET_LABEL[b]),
    "Total",
    "Items",
  ];
  const sheets: SheetSpec[] = r.currencies.map((c) => {
    const scale = scaleOf(c.currency);
    const block = headerBlock(title, ctx, `As of: ${formatDate(r.asOf)}`, [
      `Currency: ${c.currency} (amounts in different currencies are never added together)`,
    ]);
    const body: (Cell | null)[][] = c.rows.map((row) => [
      text(row.relation.name ?? "Unknown relation"),
      ...AGEING_BUCKETS.map((b) => money(row.buckets[b], scale)),
      money(row.totalMinor, scale, { bold: true }),
      { kind: "int", value: row.count },
    ]);
    body.push([
      text("Total", { total: true }),
      ...AGEING_BUCKETS.map((b) => money(c.totals.buckets[b], scale, { total: true })),
      money(c.totals.totalMinor, scale, { total: true }),
      { kind: "int", value: c.totals.count, style: { total: true } },
    ]);
    return {
      name: c.currency,
      rows: [...block, header(heads), ...body],
      columnWidths: [36, 16, 16, 16, 16, 16, 16, 17, 8],
      freezeRows: block.length + 1,
      freezeColumns: 1,
      landscape: true,
    };
  });
  if (sheets.length === 0) {
    const block = headerBlock(title, ctx, `As of: ${formatDate(r.asOf)}`);
    sheets.push({
      name: title,
      rows: [...block, [text(payable ? "No open bills." : "No open invoices.")]],
      columnWidths: [60],
      landscape: true,
    });
  }
  return {
    slug: payable ? "creditors-ageing" : "receivables-ageing",
    title,
    asOfPart: r.asOf,
    sheets,
  };
}

// ---- balance sheet ------------------------------------------------------------------------------

export function balanceSheetExport(r: BalanceSheetResponse, ctx: ExportContext): ReportExport {
  const title = "Balance sheet";
  const rep = r.report;
  const scale = scaleOf(r.division.currency);
  const periodLine = `${r.year}, up to period ${r.period}`;
  const block = headerBlock(title, ctx, `Period: ${periodLine}`, [
    `Currency: ${r.division.currency}`,
  ]);
  const rows: (Cell | null)[][] = [...block];
  const hasCompare = rep !== null && rep.compareYear !== null;
  const compareHead =
    rep && rep.compareYear !== null
      ? rep.compareBasis === "year_end"
        ? `Year end ${rep.compareYear}`
        : `${rep.compareYear}, up to period ${r.period}`
      : "";
  const heads = ["Code", "Account", periodLine, ...(hasCompare ? [compareHead] : [])];
  rows.push(header(heads, 2));
  const pairCells = (
    p: { current: number; compare: number | null },
    s?: { bold?: boolean; total?: boolean },
  ): Cell[] => [
    money(p.current, scale, s),
    ...(hasCompare ? [p.compare === null ? text("") : money(p.compare, scale, s)] : []),
  ];
  const sectionRows = (
    section: "assets" | "liabilities" | "equity" | "unclassified",
    heading: string,
    totalLabel: string,
  ) => {
    if (!rep) return;
    const s = rep.sections[section];
    rows.push([text(heading, bold)]);
    for (const l of s.lines) rows.push([text(l.code ?? ""), text(l.name), ...pairCells(l)]);
    rows.push([
      text("", { total: true }),
      text(totalLabel, { total: true }),
      ...pairCells(s.total, { total: true }),
    ]);
  };
  if (rep) {
    sectionRows("assets", "Assets", "Total assets");
    sectionRows("liabilities", "Liabilities", "Total liabilities");
    sectionRows("equity", "Equity", "Total equity");
    rows.push([text(""), text("Result for the year to date"), ...pairCells(rep.result)]);
    rows.push([
      text("", { total: true }),
      text("Total liabilities and equity", { total: true }),
      ...pairCells(rep.liabilitiesAndEquity, { total: true }),
    ]);
    if (
      rep.sections.unclassified.lines.length > 0 ||
      rep.sections.unclassified.total.current !== 0
    ) {
      sectionRows("unclassified", "Unclassified (not placed in a section)", "Total unclassified");
    }
    rows.push([]);
    rows.push([
      text(""),
      text("Difference (should be 0)", bold),
      ...pairCells(rep.difference, { bold: true }),
    ]);
    if (rep.difference.current !== 0 || (rep.difference.compare ?? 0) !== 0) {
      rows.push([text("Warning: the balance sheet does not balance. Check opening balances.")]);
    }
    if (!rep.hasOpeningBalances.current) {
      rows.push([text(`Warning: no opening balances (period 0) found for ${r.year}.`)]);
    }
    if (rep.hasOpeningBalances.compare === false) {
      rows.push([text(`Warning: no opening balances (period 0) found for ${rep.compareYear}.`)]);
    }
    if (r.splitKeys > 0) {
      rows.push([
        text(
          `Warning: ${r.splitKeys} figures were split by Exact over a field we do not read and may be too low.`,
        ),
      ]);
    }
  } else {
    rows.push([text(r.status === "not_synced" ? "Not synced yet." : "No figures for this year.")]);
  }
  return {
    slug: "balance-sheet",
    title,
    asOfPart: `${r.year}-p${String(r.period).padStart(2, "0")}`,
    sheets: [
      {
        name: title,
        rows,
        columnWidths: [12, 46, 24, 24],
        freezeRows: block.length + 1,
        landscape: false,
      },
    ],
  };
}

// ---- profit and loss ----------------------------------------------------------------------------

export function profitLossExport(r: ProfitLossResponse, ctx: ExportContext): ReportExport {
  const title = "Profit and loss";
  const rep = r.report;
  const scale = scaleOf(r.division.currency);
  const periodLine = `${r.year}, periods 1 to ${r.periodTo}`;
  const withBudget = rep?.budgetsIncluded ?? false;
  const block = headerBlock(title, ctx, `Period: ${periodLine} (year to date)`, [
    `Currency: ${r.division.currency}`,
    "Revenue is positive and costs are negative; a positive variance is good for the result.",
  ]);
  const heads = [
    "Code",
    "Account",
    "Actual",
    ...(withBudget ? ["Budget", "Variance vs budget", "Variance vs budget %"] : []),
    `Last year (${r.compareYear})`,
    "Variance vs last year",
    "Variance vs last year %",
  ];
  const rows: (Cell | null)[][] = [...block, header(heads, 2)];
  type Fig = NonNullable<typeof rep>["result"];
  const figCells = (f: Fig, s?: { bold?: boolean; total?: boolean }): (Cell | null)[] => [
    money(f.actual, scale, s),
    ...(withBudget
      ? [
          f.budget === null ? null : money(f.budget, scale, s),
          f.vsBudget.minor === null ? null : money(f.vsBudget.minor, scale, s),
          f.vsBudget.bps === null
            ? null
            : { kind: "bps" as const, bps: f.vsBudget.bps, ...(s ? { style: s } : {}) },
        ]
      : []),
    f.lastYear === null ? null : money(f.lastYear, scale, s),
    f.vsLastYear.minor === null ? null : money(f.vsLastYear.minor, scale, s),
    f.vsLastYear.bps === null
      ? null
      : { kind: "bps" as const, bps: f.vsLastYear.bps, ...(s ? { style: s } : {}) },
  ];
  if (rep) {
    const sections: ["revenue" | "costs" | "unclassified", string, string][] = [
      ["revenue", "Revenue", "Total revenue"],
      ["costs", "Costs", "Total costs"],
      ["unclassified", "Unclassified (not placed in a section)", "Total unclassified"],
    ];
    for (const [key, heading, totalLabel] of sections) {
      const s = rep.sections[key];
      if (key === "unclassified" && s.lines.length === 0 && s.total.actual === 0) continue;
      rows.push([text(heading, bold)]);
      for (const l of s.lines) rows.push([text(l.code ?? ""), text(l.name), ...figCells(l)]);
      rows.push([
        text("", { total: true }),
        text(totalLabel, { total: true }),
        ...figCells(s.total, { total: true }),
      ]);
    }
    rows.push([]);
    rows.push([
      text("", { total: true }),
      text("Result", { total: true }),
      ...figCells(rep.result, { total: true }),
    ]);
    if (!withBudget) rows.push([text("Budget is not available in Exact for this administration.")]);
    if (r.compareMissing)
      rows.push([
        text(`Last year (${r.compareYear}) has not been synced; last-year figures are blank.`),
      ]);
    if (r.splitKeys > 0) {
      rows.push([
        text(
          `Warning: ${r.splitKeys} figures were split by Exact over a field we do not read and may be too low.`,
        ),
      ]);
    }
  } else {
    rows.push([text(r.status === "not_synced" ? "Not synced yet." : "No figures for this year.")]);
  }
  return {
    slug: "profit-loss",
    title,
    asOfPart: `${r.year}-p${String(r.periodTo).padStart(2, "0")}`,
    sheets: [
      {
        name: title,
        rows,
        columnWidths: [12, 40, 16, ...(withBudget ? [16, 18, 14] : []), 18, 18, 14],
        freezeRows: block.length + 1,
        landscape: true,
      },
    ],
  };
}
