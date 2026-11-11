import type { ReactNode } from "react";
import { Card } from "@camelthorn/ui";
import { AGEING_BUCKETS, type AgeingBucket, type AgeingReportResponse } from "@camelthorn/core";
import { useFxRates } from "../fx";
import { BUCKET_LABEL } from "../lib/ageing";
import { NO_VALUE, formatDayMonth, formatMoney } from "../lib/format";
import { ageingTotalsInBase, baseLabel, notIncludedText, type ConvertedTotal } from "../lib/fx";
import { FxStaleChip } from "./FxAmount";
import { ScrollRegion } from "./ReportParts";

/** "Total in € at today's ECB rates": the heading every converted total carries. */
export function fxTotalTitle(base: string): string {
  return `Total in ${baseLabel(base)} at today's ECB rates`;
}

/** The converted amount as an estimate ("about € 1.234,00"), or a dash when nothing converted. */
export function ConvertedAmount({ total, base }: { total: ConvertedTotal; base: string }) {
  if (total.included.length === 0) return <span className="muted">{NO_VALUE}</span>;
  return (
    <span className="num money">
      about {formatMoney(total.totalMinor, base)}
      {total.totalMinor < 0n && <span className="sr-only"> credit</span>}
    </span>
  );
}

/** "ECB rates of 10 Nov; for information only" plus the currencies that could not be included. */
export function ConvertedNote({
  total,
  className = "cap",
}: {
  total: ConvertedTotal;
  className?: string;
}) {
  const left = notIncludedText(total);
  return (
    <span className={className}>
      Estimate
      {total.rateDate ? `, ECB rates of ${formatDayMonth(total.rateDate)}` : ""}
      {left && <> · {left}</>}
    </span>
  );
}

/**
 * Explains a block of converted totals once: it is an estimate at today's rates, original
 * amounts are not added together, and the stale chip when the rates are old. Renders nothing when
 * the rates are not there.
 */
export function FxEstimateIntro({ children }: { children?: ReactNode }) {
  const { ready, baseAssumed, base } = useFxRates();
  if (!ready) return null;
  return (
    <div className="fx-intro">
      <p className="cap">
        An estimate at today&apos;s ECB rates, for information only. Each currency is converted
        once, then the results are added. The original amounts stay as they are.
        {baseAssumed && ` The administration currency is not known yet, so ${base} is assumed.`}
      </p>
      {children}
      <FxStaleChip />
    </div>
  );
}

/** The rate-date line under a converted row; also printed. */
export function fxRateLine(rateDate: string | null): string {
  return rateDate
    ? `ECB rates of ${formatDayMonth(rateDate)}; for information only`
    : "For information only";
}

const AGEING_COLUMNS: { key: AgeingBucket | "total"; label: string }[] = [
  ...AGEING_BUCKETS.map((b) => ({ key: b, label: BUCKET_LABEL[b] })),
  { key: "total", label: "Total" },
];

/**
 * "Total in € at today's ECB rates" under an ageing report: one row, a converted total per bucket
 * (each currency converted once, then added). The per-currency tables stay primary. Nothing when
 * the rates are not there, the report is for another administration than the one selected (a
 * switch in progress), or every currency is already the administration currency.
 */
export function AgeingFxTotalsCard({ data }: { data: AgeingReportResponse }) {
  const { table, base, ready } = useFxRates();
  if (!ready || !table || base !== data.division.currency) return null;
  const t = ageingTotalsInBase(table, base, data.currencies);
  if (!t) return null;
  const title = fxTotalTitle(base);
  const left = notIncludedText(t);
  return (
    <Card aria-labelledby="ageing-fx" className="report-card fx-ageing">
      <h2 id="ageing-fx" className="h2">
        {title}
      </h2>
      <FxEstimateIntro />
      <ScrollRegion label={`${title}, per days past due`}>
        <table className="tbl report-table ageing-table">
          <caption className="sr-only">
            {title}: all currencies converted and added, per days past due
          </caption>
          <thead>
            <tr>
              <th scope="col">Currencies</th>
              {AGEING_COLUMNS.map((c) => (
                <th key={c.key} scope="col" className="r">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="totals-row">
              <th scope="row">{title}</th>
              {AGEING_COLUMNS.map((c) => (
                <td key={c.key} className="r">
                  {t.counts[c.key] === 0 ? (
                    <span className="muted">{NO_VALUE}</span>
                  ) : (
                    <ConvertedAmount total={t.cells[c.key]} base={base} />
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </ScrollRegion>
      <p className="cap fx-rate-line">
        {fxRateLine(t.rateDate)}
        {left && <> · {left}</>}
      </p>
    </Card>
  );
}
