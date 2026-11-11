/**
 * The entry point of the lazily loaded export chunk: pages call it through a dynamic import, so
 * the writer, the report layouts and fflate stay out of the main bundle.
 */
import type {
  AgeingReportResponse,
  BalanceSheetResponse,
  ProfitLossResponse,
} from "@camelthorn/core";
import type { AgeingSort } from "../lib/ageing";
import { exportFileName } from "../lib/report-files";
import {
  ageingExport,
  balanceSheetExport,
  profitLossExport,
  type ExportContext,
  type ReportExport,
} from "./report-workbooks";
import { buildXlsx, XLSX_MIME } from "./xlsx";

/** Save bytes as a file through a temporary link. Nothing leaves the browser. */
export function saveBlob(bytes: Uint8Array, fileName: string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL is released.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Builds and saves the workbook; returns the file name. */
export function downloadReport(report: ReportExport, ctx: ExportContext): string {
  const bytes = buildXlsx(report.sheets, { createdAt: ctx.generatedAt, title: report.title });
  const fileName = exportFileName(report.slug, ctx.administration, report.asOfPart);
  saveBlob(bytes, fileName, XLSX_MIME);
  return fileName;
}

export const exportAgeing = (
  r: AgeingReportResponse,
  ctx: ExportContext,
  sort: AgeingSort = "outstanding",
): string => downloadReport(ageingExport(r, ctx, sort), ctx);
export const exportBalanceSheet = (r: BalanceSheetResponse, ctx: ExportContext): string =>
  downloadReport(balanceSheetExport(r, ctx), ctx);
export const exportProfitLoss = (r: ProfitLossResponse, ctx: ExportContext): string =>
  downloadReport(profitLossExport(r, ctx), ctx);
