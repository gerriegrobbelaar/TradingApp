/**
 * STUB (task F2): minimal stand-in for F1's packages/core/src/fx.ts so the worker typechecks
 * before F1 merges. F1's version replaces this file wholesale on merge; the exported names and
 * signatures below are the fixed interface agreed between F1 and F2.
 */
import type { EcbObservation } from "./ecb";

export type RateString = string;

export interface RateTable {
  asOf: string;
  base: "EUR";
  rates: Record<string, RateString>;
  ratesDate?: Record<string, string>;
}

const RATE_RE = /^[0-9]+(?:\.[0-9]+)?$/;

/** A positive decimal string such as `1.0842`; never a float, never an exponent. */
export function parseRate(
  s: string,
): { ok: true; rate: RateString } | { ok: false; error: string } {
  const t = s.trim();
  if (!RATE_RE.test(t) || t.length > 24) return { ok: false, error: "bad_rate" };
  if (/^0+(?:\.0+)?$/.test(t)) return { ok: false, error: "zero_rate" };
  return { ok: true, rate: t };
}

/** The newest observation per currency on or before the date; null if there is none. */
export function buildRateTable(
  observations: EcbObservation[],
  onOrBefore: string,
): RateTable | null {
  const rates: Record<string, RateString> = {};
  const ratesDate: Record<string, string> = {};
  for (const o of observations) {
    if (o.rateDate > onOrBefore) continue;
    const seen = ratesDate[o.currency];
    if (seen === undefined || o.rateDate > seen) {
      rates[o.currency] = o.rate;
      ratesDate[o.currency] = o.rateDate;
    }
  }
  const dates = Object.values(ratesDate);
  if (dates.length === 0) return null;
  return { asOf: dates.reduce((a, b) => (a > b ? a : b)), base: "EUR", rates, ratesDate };
}
