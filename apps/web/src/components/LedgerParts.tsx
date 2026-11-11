import type { ReactNode } from "react";
import { NO_VALUE, currentAmsterdamYear, formatBps, formatMoney } from "../lib/format";

const YEAR = /^[12]\d{3}$/;
const PERIOD = /^([1-9]|1[0-6])$/;

/** A year from the address, or undefined when it is not a plausible year (never sent then). */
export function parseYear(raw: string | null): number | undefined {
  if (raw === null || !YEAR.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1900 && n <= 2200 ? n : undefined;
}

/** A period 1..16 from the address, or undefined. */
export function parsePeriod(raw: string | null): number | undefined {
  return raw !== null && PERIOD.test(raw) ? Number(raw) : undefined;
}

/**
 * Year and period selectors. Native selects: keyboard operable everywhere. The shown value is the
 * one the report answered with (`year`, `period`), so the control always matches the figures.
 */
export function PeriodControls({
  year,
  period,
  periodLabel,
  onYear,
  onPeriod,
  disabled,
}: {
  year: number;
  period: number;
  periodLabel: string;
  onYear: (y: number) => void;
  onPeriod: (p: number) => void;
  disabled?: boolean;
}) {
  const now = currentAmsterdamYear();
  const years = new Set<number>();
  for (let y = now; y >= now - 6; y--) years.add(y);
  years.add(year);
  const periods = new Set<number>();
  for (let p = 1; p <= 12; p++) periods.add(p);
  periods.add(period);
  return (
    <div className="period-controls" role="group" aria-label="Period">
      <label className="field-inline">
        <span className="cap">Year</span>
        <select
          className="input"
          value={year}
          disabled={disabled}
          onChange={(e) => onYear(Number(e.target.value))}
        >
          {[...years]
            .sort((a, b) => b - a)
            .map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
        </select>
      </label>
      <label className="field-inline">
        <span className="cap">{periodLabel}</span>
        <select
          className="input"
          value={period}
          disabled={disabled}
          onChange={(e) => onPeriod(Number(e.target.value))}
        >
          {[...periods]
            .sort((a, b) => a - b)
            .map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}

/** A ledger amount (division currency). Negative is a minus sign; null is an em dash. */
export function LedgerAmount({
  minor,
  currency,
  bold,
}: {
  minor: number | null;
  currency: string;
  bold?: boolean;
}) {
  if (minor === null) {
    return (
      <span className="muted">
        <span aria-hidden="true">{NO_VALUE}</span>
        <span className="sr-only">not available</span>
      </span>
    );
  }
  return <span className={`num${bold ? " strong" : ""}`}>{formatMoney(minor, currency)}</span>;
}

/** Variance percentage from basis points: one decimal, an em dash without a base. */
export function Percent({ bps }: { bps: number | null }) {
  if (bps === null) {
    return (
      <span className="muted">
        <span aria-hidden="true">{NO_VALUE}</span>
        <span className="sr-only">not available</span>
      </span>
    );
  }
  return <span className="num">{formatBps(bps)}</span>;
}

/** A section heading row: the name sits in the pinned first column. */
export function SectionRow({ children, span }: { children: ReactNode; span: number }) {
  return (
    <tr className="section-row">
      <th scope="row">{children}</th>
      <td colSpan={span - 1} />
    </tr>
  );
}

/** A line of explanation inside a table. It stays in view while the table scrolls sideways. */
export function NoteRow({ children, span }: { children: ReactNode; span: number }) {
  return (
    <tr>
      <td colSpan={span} className="note-cell">
        <div className="sticky-note cap">{children}</div>
      </td>
    </tr>
  );
}
