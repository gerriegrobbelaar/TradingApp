import { useCallback, useState, type ReactNode } from "react";
import type { Freshness, LedgerFreshnessEntry } from "@camelthorn/core";
import { Button } from "@camelthorn/ui";
import { useToast } from "../toasts";
import { formatDateTime } from "../lib/format";
import { printReport } from "../lib/print";
import { FreshnessStamp } from "./FreshnessStamp";

/** A ledger freshness entry in the shape the shared stamp takes. */
export function asFreshness(e: LedgerFreshnessEntry): Freshness {
  return {
    lastCompletedAt: e.lastCompletedAt,
    basis: [],
    stale: e.stale,
    staleAfterHours: e.staleAfterHours,
  };
}

/**
 * Freshness of the ledger entities a report uses: one stamp for the balances; the other entities
 * (chart of accounts, comparison year, budgets) only speak up when they are out of date or were
 * never read, so a healthy report shows one calm line.
 */
export function LedgerStamps({
  balances,
  others,
}: {
  balances: LedgerFreshnessEntry | null;
  others: { what: string; entry: LedgerFreshnessEntry | null }[];
}) {
  return (
    <div className="stamps no-print">
      <FreshnessStamp freshness={balances ? asFreshness(balances) : null} what="Ledger balances" />
      {balances?.lastCompletedAt !== null &&
        others.map(
          (o) =>
            o.entry &&
            (o.entry.stale || o.entry.lastCompletedAt === null) && (
              <FreshnessStamp key={o.what} freshness={asFreshness(o.entry)} what={o.what} />
            ),
        )}
    </div>
  );
}

/** The oldest last complete read of the ledger entities a report is built from, for the print header and the Excel header. */
export function oldestRead(entries: (LedgerFreshnessEntry | null)[]): string | null {
  let oldest: string | null = null;
  for (const e of entries) {
    if (!e) continue;
    if (e.lastCompletedAt === null) return null;
    if (oldest === null || e.lastCompletedAt < oldest) oldest = e.lastCompletedAt;
  }
  return oldest;
}

/** Header that only the printed page shows: what, where, as of when, source. */
export function PrintMeta({
  administration,
  lines,
  syncedAt,
}: {
  administration: string;
  lines: string[];
  syncedAt: string | null;
}) {
  return (
    <div className="print-meta print-only">
      <p>
        <b>Administration:</b> {administration}
      </p>
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      <p>
        <b>Source:</b> Exact Online,{" "}
        {syncedAt === null ? "never synced" : `synced ${formatDateTime(syncedAt)} (Amsterdam)`}
      </p>
      <p>
        <b>Printed:</b> {formatDateTime(new Date().toISOString())} (Europe/Amsterdam)
      </p>
    </div>
  );
}

/** Wide table inside its own focusable scroll region (no page-level sideways scroll). */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="report-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

/**
 * Export buttons. Excel builds the file in a lazily loaded chunk (`run` imports it); PDF opens the
 * print dialog, where the user picks "Save as PDF". Both are off while there is nothing to export.
 */
export function ExportButtons({
  disabled,
  pdfFileBase,
  runExcel,
}: {
  disabled: boolean;
  /** Suggested PDF name (without extension). */
  pdfFileBase: string;
  /** Builds and saves the workbook; resolves with its file name. */
  runExcel: () => Promise<string>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const excel = useCallback(async () => {
    setBusy(true);
    try {
      const name = await runExcel();
      toast.show(`Saved ${name}`);
    } catch {
      toast.show("Could not create the Excel file. Try again.");
    } finally {
      setBusy(false);
    }
  }, [runExcel, toast]);
  return (
    <div className="export-actions no-print" role="group" aria-label="Export">
      <Button size="sm" disabled={disabled || busy} onClick={() => void excel()}>
        {busy ? "Creating Excel file…" : "Export Excel"}
      </Button>
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => {
          try {
            printReport(pdfFileBase);
          } catch {
            toast.show("Could not open the print dialog. Use your browser's print command.");
          }
        }}
        aria-describedby="pdf-hint"
      >
        Export PDF
      </Button>
      <span id="pdf-hint" className="cap">
        PDF opens the print dialog: choose Save as PDF.
      </span>
    </div>
  );
}
