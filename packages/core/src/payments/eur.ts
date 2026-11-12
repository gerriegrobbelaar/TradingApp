/**
 * EUR equivalent of a payment amount, for limits (ADR 0049). The ECB rate table is the one the UI
 * uses (ADR 0037); rounding is `convertMinor`'s: half away from zero, once, at the end.
 */
import { convertMinor, type RateTable } from "../fx";

export interface EurAmount {
  /** Integer minor units of EUR. */
  minor: number;
  /** The rate used as a decimal string ("1" for EUR). */
  rate: string;
  currency: string;
}

/** Null when the amount cannot be converted (no rate, not a safe amount): callers fail closed. */
export function eurEquivalent(
  amountMinor: number,
  currency: string,
  rates: RateTable | null,
): EurAmount | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return null;
  if (currency === "EUR") return { minor: amountMinor, rate: "1", currency };
  if (rates === null) return null;
  const r = convertMinor({ amountMinor, from: currency, to: "EUR", table: rates });
  if (!r.ok) return null;
  if (r.amountMinor > BigInt(Number.MAX_SAFE_INTEGER) || r.amountMinor < 0n) return null;
  return { minor: Number(r.amountMinor), rate: r.rateUsed, currency };
}

/**
 * Is this amount ABOVE the limit? EUR: strictly above (exactly at the limit is allowed). Another
 * currency: at or above, because the rounded EUR figure can hide a fraction of a cent over the
 * line; the conservative side is a second approver. Null (no rate) is always "above".
 */
export function isAboveLimit(eur: EurAmount | null, limitMinor: number): boolean {
  if (eur === null) return true;
  return eur.currency === "EUR" ? eur.minor > limitMinor : eur.minor >= limitMinor;
}
