/**
 * FX maths on integer minor units and decimal-string rates (ADR 0035). All arithmetic is BigInt.
 *
 * Rate convention is the ECB's: a rate is "units of the currency per 1 EUR". A cross rate
 * from -> to is therefore r_to / r_from. Conversion is exact rational arithmetic with ONE
 * rounding at the end, half away from zero, to the target currency's minor unit.
 */
import { currencyScale } from "./money";
import {
  type Dec,
  decToString,
  divDec,
  divRound,
  normaliseDec,
  parseDecimal,
  pow10,
} from "./decimal";

/** Positive plain decimal, e.g. "1.0853": units of the currency per 1 EUR. */
export type RateString = string;

export interface RateTable {
  /** YYYY-MM-DD ECB reference date (the newest date used). */
  asOf: string;
  base: "EUR";
  /** ISO code -> rate. EUR is implicit ("1"). */
  rates: Record<string, RateString>;
  /** Optional: the date each rate comes from (per-currency staleness). */
  ratesDate?: Record<string, string>;
}

const MAX_FRACTION_DIGITS = 12;
const MAX_INTEGER_DIGITS = 12;
const CURRENCY_RE = /^[A-Z]{3}$/;
const RATE_RE = /^(\d+)(?:\.(\d+))?$/;
const ONE: Dec = { int: 1n, scale: 0 };

/**
 * Strict rate parser. Accepts digits with an optional single "." followed by digits: no sign,
 * exponent, whitespace, ".5" or "5.". Leading zeros are allowed and removed ("01.50" -> "1.5").
 * At most 12 integer and 12 fraction digits; must be > 0. Result has no trailing zeros.
 */
export function parseRate(
  s: string,
): { ok: true; rate: RateString } | { ok: false; error: string } {
  if (typeof s !== "string") return { ok: false, error: "not_a_string" };
  const m = RATE_RE.exec(s);
  if (!m) return { ok: false, error: "bad_format" };
  const rawFrac = m[2] ?? "";
  const whole = (m[1] ?? "").replace(/^0+(?=\d)/, "");
  const frac = rawFrac.replace(/0+$/, "");
  if (whole.length > MAX_INTEGER_DIGITS) return { ok: false, error: "too_large" };
  if (rawFrac.length > MAX_FRACTION_DIGITS) return { ok: false, error: "too_many_decimals" };
  if (/^0*$/.test(whole + frac)) return { ok: false, error: "not_positive" };
  return { ok: true, rate: frac === "" ? whole : `${whole}.${frac}` };
}

function validCode(code: string): boolean {
  return typeof code === "string" && CURRENCY_RE.test(code);
}

/** Rate of a currency as a Dec, or null when missing, malformed or not a valid code. */
function lookup(code: string, table: RateTable): Dec | null {
  if (!validCode(code)) return null;
  if (code === "EUR") return ONE;
  if (!Object.prototype.hasOwnProperty.call(table.rates, code)) return null;
  const raw = table.rates[code];
  if (raw === undefined) return null;
  const p = parseRate(raw);
  return p.ok ? parseDecimal(p.rate) : null;
}

function toRateString(d: Dec): RateString | null {
  if (d.int <= 0n) return null;
  return decToString(normaliseDec(d));
}

/** Effective from -> to multiplier to 12 decimals, or null when a rate is missing. */
export function crossRate(from: string, to: string, table: RateTable): RateString | null {
  if (from === to) return validCode(from) ? "1" : null;
  const rf = lookup(from, table);
  const rt = lookup(to, table);
  if (!rf || !rt) return null;
  return toRateString(divDec(rt, rf, MAX_FRACTION_DIGITS));
}

type AmountResult =
  { ok: true; value: bigint } | { ok: false; error: "bad_amount" | "unsafe_number" };

function toBigint(a: bigint | number): AmountResult {
  if (typeof a === "bigint") return { ok: true, value: a };
  if (typeof a !== "number" || !Number.isFinite(a) || !Number.isInteger(a)) {
    return { ok: false, error: "bad_amount" };
  }
  if (!Number.isSafeInteger(a)) return { ok: false, error: "unsafe_number" };
  return { ok: true, value: BigInt(a) };
}

function convertBig(
  amount: bigint,
  from: string,
  to: string,
  table: RateTable,
): { amountMinor: bigint; rateUsed: RateString } | null {
  if (from === to) return validCode(from) ? { amountMinor: amount, rateUsed: "1" } : null;
  const rf = lookup(from, table);
  const rt = lookup(to, table);
  if (!rf || !rt) return null;
  // minor_to = a * 10^st * rt / (10^sf * rf), rates being int / 10^scale.
  const sf = currencyScale(from);
  const st = currencyScale(to);
  const num = amount * pow10(st) * rt.int * pow10(rf.scale);
  const den = pow10(sf) * rf.int * pow10(rt.scale);
  return {
    amountMinor: divRound(num, den),
    rateUsed: toRateString(divDec(rt, rf, MAX_FRACTION_DIGITS)) ?? "0",
  };
}

export function convertMinor(args: {
  amountMinor: bigint | number;
  from: string;
  to: string;
  table: RateTable;
}):
  | { ok: true; amountMinor: bigint; rateUsed: RateString }
  | { ok: false; error: "missing_rate" | "bad_amount" | "unsafe_number" } {
  const a = toBigint(args.amountMinor);
  if (!a.ok) return a;
  const r = convertBig(a.value, args.from, args.to, args.table);
  if (!r) return { ok: false, error: "missing_rate" };
  return { ok: true, ...r };
}

/**
 * Open foreign-currency balance valued at today's table versus the base-currency amount it was
 * booked at. `differenceMinor` = today - booked. `impliedBookedRate` is booked / open (base
 * per 1 unit of `currency`, 12 dp) or null when it is not positive or the open amount is 0.
 */
export function unrealisedDifference(args: {
  openMinor: bigint | number;
  currency: string;
  bookedBaseMinor: bigint | number | null;
  baseCurrency: string;
  table: RateTable;
}):
  | {
      ok: true;
      todayBaseMinor: bigint;
      bookedBaseMinor: bigint;
      differenceMinor: bigint;
      impliedBookedRate: RateString | null;
    }
  | { ok: false; error: "missing_rate" | "booked_unknown" | "bad_amount" } {
  const open = toBigint(args.openMinor);
  if (!open.ok) return { ok: false, error: "bad_amount" };
  const today = convertBig(open.value, args.currency, args.baseCurrency, args.table);
  if (!today) return { ok: false, error: "missing_rate" };
  if (args.bookedBaseMinor === null) return { ok: false, error: "booked_unknown" };
  const booked = toBigint(args.bookedBaseMinor);
  if (!booked.ok) return { ok: false, error: "bad_amount" };

  let implied: RateString | null = null;
  if (open.value !== 0n) {
    const b: Dec = { int: booked.value, scale: currencyScale(args.baseCurrency) };
    const o: Dec = { int: open.value, scale: currencyScale(args.currency) };
    implied = toRateString(divDec(b, o, MAX_FRACTION_DIGITS));
  }
  return {
    ok: true,
    todayBaseMinor: today.amountMinor,
    bookedBaseMinor: booked.value,
    differenceMinor: today.amountMinor - booked.value,
    impliedBookedRate: implied,
  };
}

/**
 * Plain string for display: rounded half away from zero to `maxFractionDigits` (default 6,
 * at most 12), trailing zeros removed. Input that is not a plain decimal is returned unchanged.
 */
export function formatRateForDisplay(rate: RateString, maxFractionDigits = 6): string {
  const d = parseDecimal(rate);
  if (!d || !Number.isInteger(maxFractionDigits) || maxFractionDigits < 0) return rate;
  const scale = Math.min(maxFractionDigits, 12);
  const rounded = d.scale <= scale ? d : divDec(d, ONE, scale);
  return decToString(normaliseDec(rounded));
}
