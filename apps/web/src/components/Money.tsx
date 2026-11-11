import type { ReactNode } from "react";
import { formatMoney, isCredit } from "../lib/format";

/**
 * One amount. A negative amount is a credit: it shows a minus sign and tells screen readers
 * "credit". Tabular figures keep columns aligned.
 */
export function Money({
  minor,
  currency,
  className,
}: {
  minor: number | bigint;
  currency: string;
  className?: string;
}) {
  return (
    <span className={["num", "money", className ?? ""].filter(Boolean).join(" ")}>
      {formatMoney(minor, currency)}
      {isCredit(minor) && <span className="sr-only"> credit</span>}
    </span>
  );
}

export interface CurrencyAmount {
  currency: string;
  minor: number | bigint;
  /** Optional line under the amount (for example a count or an incomplete-total note). */
  note?: ReactNode;
}

/**
 * Totals stacked one line per currency. Amounts in different currencies are never added: there
 * is no FX conversion in this phase (ADR 0022).
 */
export function MoneyByCurrency({
  totals,
  empty = "No amounts",
  className,
}: {
  totals: readonly CurrencyAmount[];
  empty?: string;
  className?: string;
}) {
  if (totals.length === 0) return <span className="muted">{empty}</span>;
  return (
    <ul className={["mbc", className ?? ""].filter(Boolean).join(" ")}>
      {totals.map((t) => (
        <li key={t.currency}>
          <Money minor={t.minor} currency={t.currency} />
          <span className="cap">
            {" "}
            <span className="sr-only">in </span>
            {t.currency}
          </span>
          {t.note && <span className="cap mbc-note">{t.note}</span>}
        </li>
      ))}
    </ul>
  );
}
