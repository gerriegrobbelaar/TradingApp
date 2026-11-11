import type { ReactNode } from "react";
import { useFxRates } from "../fx";
import { NO_VALUE, formatDayMonth, formatMoney } from "../lib/format";
import { baseLabel, type ConvertedTotal } from "../lib/fx";
import { FxStaleChip } from "./FxAmount";

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
  return (
    <span className={className}>
      Estimate
      {total.rateDate ? `, ECB rates of ${formatDayMonth(total.rateDate)}` : ""}
      {total.excluded.length > 0 && <> · Not included: {total.excluded.join(", ")} (no ECB rate)</>}
    </span>
  );
}

/**
 * Explains a block of converted totals once: it is an estimate at today's rates, original
 * amounts are not added together, and the stale chip when the rates are old. Renders nothing when
 * the rates are not there.
 */
export function FxEstimateIntro({ children }: { children?: ReactNode }) {
  const { table, baseAssumed, base } = useFxRates();
  if (!table) return null;
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
