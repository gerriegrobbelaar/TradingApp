import { formatMoney } from "../lib/format";

/**
 * The one wording for "what this foreign-currency figure is in the administration's own currency,
 * as Exact stored it" (review S3). Used by the Overview figures and the ageing report so they
 * cannot disagree. We never convert: the amount is Exact's own division-currency amount at the
 * rate booked on each item, not today's rate.
 *
 *  - complete: "about € 1.234,00 (booked rate in Exact)"
 *  - some items have no such amount, total above 0: "At least € 500,00 in EUR as stored in Exact.
 *    Some items have no amount in EUR yet."
 *  - some items have none and the total is 0: "Not known yet", never "At least € 0,00".
 */
export function dcLineText(p: {
  dcMinor: number;
  dcComplete: boolean;
  dcCurrency: string;
}): string {
  const cur = p.dcCurrency;
  if (p.dcComplete) return `about ${formatMoney(p.dcMinor, cur)} (booked rate in Exact)`;
  if (p.dcMinor === 0) {
    return `Not known yet. Exact has no amount in ${cur} for these items yet.`;
  }
  return `At least ${formatMoney(p.dcMinor, cur)} in ${cur} as stored in Exact. Some items have no amount in ${cur} yet.`;
}

/**
 * Renders nothing for an amount already in the division currency or for no items at all.
 * `currency` is the currency of the figure it sits under.
 */
export function DcLine({
  currency,
  dcCurrency,
  dcMinor,
  dcComplete,
  count,
}: {
  currency: string;
  dcCurrency: string;
  dcMinor: number;
  dcComplete: boolean;
  count: number;
}) {
  if (currency === dcCurrency || count <= 0) return null;
  return <p className="cap">{dcLineText({ dcMinor, dcComplete, dcCurrency })}</p>;
}

export { DcLine as DivisionCurrencyAmount };
