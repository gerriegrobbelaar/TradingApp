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
const RATE_RE = /^([0-9]+)(?:\.([0-9]+))?$/;
/**
 * Longest string `parseRate` looks at. Generous for leading zeros ("0000001.5"), but bounded so a
 * hostile field is refused in O(1).
 */
const MAX_RATE_INPUT_CHARS = 64;
const ONE: Dec = { int: 1n, scale: 0 };

/**
 * Strict rate parser. Accepts ASCII digits with an optional single "." followed by digits: no
 * sign, exponent, whitespace, ".5", "5.", or non-ASCII digits. Leading zeros are allowed and
 * removed ("01.50" -> "1.5"). At most 12 integer digits (after leading zeros are removed) and 12
 * fraction digits (before trailing zeros are removed); must be > 0. The result has no trailing
 * zeros and parsing it again returns it unchanged. Linear time on any input: the length is
 * checked before anything else and no regex can backtrack.
 */
export function parseRate(
  s: string,
): { ok: true; rate: RateString } | { ok: false; error: string } {
  if (typeof s !== "string") return { ok: false, error: "not_a_string" };
  if (s.length > MAX_RATE_INPUT_CHARS) return { ok: false, error: "too_long" };
  const m = RATE_RE.exec(s);
  if (!m) return { ok: false, error: "bad_format" };
  const rawWhole = m[1] ?? "";
  const rawFrac = m[2] ?? "";
  if (rawFrac.length > MAX_FRACTION_DIGITS) return { ok: false, error: "too_many_decimals" };
  let w = 0;
  while (w < rawWhole.length - 1 && rawWhole.charCodeAt(w) === 48) w += 1;
  const whole = rawWhole.slice(w);
  if (whole.length > MAX_INTEGER_DIGITS) return { ok: false, error: "too_large" };
  let f = rawFrac.length;
  while (f > 0 && rawFrac.charCodeAt(f - 1) === 48) f -= 1;
  const frac = rawFrac.slice(0, f);
  if (whole === "0" && frac === "") return { ok: false, error: "not_positive" };
  return { ok: true, rate: frac === "" ? whole : `${whole}.${frac}` };
}

function validCode(code: string): boolean {
  return typeof code === "string" && CURRENCY_RE.test(code);
}

/** Rate of a currency as a Dec, or null when missing, malformed or not a valid code. */
function lookup(code: string, table: RateTable): Dec | null {
  if (!validCode(code)) return null;
  if (code === "EUR") return ONE;
  const rates: unknown = typeof table === "object" && table !== null ? table.rates : null;
  if (typeof rates !== "object" || rates === null) return null;
  // Own data properties only: never the prototype chain, never a getter.
  const desc = Object.getOwnPropertyDescriptor(rates, code);
  const raw: unknown = desc === undefined ? undefined : desc.value;
  if (typeof raw !== "string") return null;
  const p = parseRate(raw);
  return p.ok ? parseDecimal(p.rate) : null;
}

function toRateString(d: Dec): RateString | null {
  if (d.int <= 0n) return null;
  return decToString(normaliseDec(d));
}

/**
 * Effective from -> to multiplier (`r_to / r_from`, so EUR -> USD is r_usd and USD -> EUR is
 * 1 / r_usd), rounded half away from zero to 12 decimals, trailing zeros removed. Null when a
 * rate is missing or a code is invalid, and also when the multiplier is below 0.0000000000005 (it
 * would round to 0, which is not a rate). For display and audit only: amounts are never
 * recomputed from it.
 */
export function crossRate(from: string, to: string, table: RateTable): RateString | null {
  if (from === to) return validCode(from) ? "1" : null;
  const rf = lookup(from, table);
  const rt = lookup(to, table);
  if (!rf || !rt) return null;
  return toRateString(divDec(rt, rf, MAX_FRACTION_DIGITS));
}

/**
 * Largest |amount| in minor units accepted (exclusive): 10^30. Far beyond any real balance
 * (10^15 EUR is 10^17 cents), small enough that a crafted bigint cannot make the products
 * below expensive.
 */
const MAX_ABS_AMOUNT = 10n ** 30n;

type AmountResult =
  { ok: true; value: bigint } | { ok: false; error: "bad_amount" | "unsafe_number" };

function toBigint(a: bigint | number): AmountResult {
  if (typeof a === "bigint") {
    if (a >= MAX_ABS_AMOUNT || a <= -MAX_ABS_AMOUNT) return { ok: false, error: "bad_amount" };
    return { ok: true, value: a };
  }
  if (typeof a !== "number" || !Number.isFinite(a) || !Number.isInteger(a)) {
    return { ok: false, error: "bad_amount" };
  }
  if (!Number.isSafeInteger(a)) return { ok: false, error: "unsafe_number" };
  // `-0` becomes 0n.
  return { ok: true, value: BigInt(a) };
}

type ConvertResult =
  | { ok: true; amountMinor: bigint; rateUsed: RateString }
  | { ok: false; error: "missing_rate" | "rate_out_of_range" };

function convertBig(amount: bigint, from: string, to: string, table: RateTable): ConvertResult {
  if (from === to) {
    return validCode(from)
      ? { ok: true, amountMinor: amount, rateUsed: "1" }
      : { ok: false, error: "missing_rate" };
  }
  const rf = lookup(from, table);
  const rt = lookup(to, table);
  if (!rf || !rt) return { ok: false, error: "missing_rate" };
  const rateUsed = toRateString(divDec(rt, rf, MAX_FRACTION_DIGITS));
  if (rateUsed === null) return { ok: false, error: "rate_out_of_range" };
  // minor_to = a * 10^st * rt / (10^sf * rf), rates being int / 10^scale. One exact rational,
  // one rounding (half away from zero) at the end.
  const sf = currencyScale(from);
  const st = currencyScale(to);
  const num = amount * pow10(st) * rt.int * pow10(rf.scale);
  const den = pow10(sf) * rf.int * pow10(rt.scale);
  return { ok: true, amountMinor: divRound(num, den), rateUsed };
}

/**
 * Convert integer minor units from one currency to another through the EUR rate table.
 * `amountMinor` may be a bigint (|a| < 10^30) or a safe-integer number. Errors:
 * `missing_rate` (a code is invalid or has no usable rate), `rate_out_of_range` (the cross
 * rate is below 0.0000000000005, so `rateUsed` could not be recorded; no real ECB pair comes
 * near), `bad_amount` (not an integer, or too large), `unsafe_number` (a number beyond
 * Number.MAX_SAFE_INTEGER: pass a bigint).
 */
export function convertMinor(args: {
  amountMinor: bigint | number;
  from: string;
  to: string;
  table: RateTable;
}):
  | { ok: true; amountMinor: bigint; rateUsed: RateString }
  | {
      ok: false;
      error: "missing_rate" | "rate_out_of_range" | "bad_amount" | "unsafe_number";
    } {
  const a = toBigint(args.amountMinor);
  if (!a.ok) return a;
  return convertBig(a.value, args.from, args.to, args.table);
}

/**
 * Unrealised FX difference of one open item (ADR 0035, "Unrealised difference").
 *
 * Sign convention: `openMinor` and `bookedBaseMinor` are signed the way `open_items.open_minor`
 * and `open_dc_minor` are (ADR 0022): positive for an open invoice and for an open bill alike,
 * negative for a credit note of either kind. `differenceMinor` = `todayBaseMinor` -
 * `bookedBaseMinor`: the change in the item's base-currency value since booking. It is NOT a
 * gain/loss sign; use `unrealisedResultMinor(kind, differenceMinor)` for that (a receivable
 * that is worth more is a gain, a payable that is worth more is a loss).
 *
 * `impliedBookedRate` = booked / open in major units: base-currency units per 1 unit of
 * `currency`, i.e. the same direction as `rateUsed` of `convertMinor(currency -> base)` and the
 * INVERSE of the ECB direction when the base is EUR. 12 dp. Null when the open amount is 0,
 * the booked amount is 0, they have opposite signs, or it rounds to 0.
 *
 * Checks in order: amount valid (`bad_amount`), rate available (`missing_rate` /
 * `rate_out_of_range`), booked known (`booked_unknown`), booked valid (`bad_amount`).
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
  | {
      ok: false;
      error: "missing_rate" | "rate_out_of_range" | "booked_unknown" | "bad_amount";
    } {
  const open = toBigint(args.openMinor);
  if (!open.ok) return { ok: false, error: "bad_amount" };
  const today = convertBig(open.value, args.currency, args.baseCurrency, args.table);
  if (!today.ok) return today;
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
 * Direction of Exact's booked rate (`RateFC`), set by an admin after checking one foreign invoice
 * against Exact (ADR 0038): `base_per_foreign` = division-currency units per 1 unit of the item
 * currency (USD invoice in a EUR division, 0.92); `foreign_per_base` = item-currency units per
 * 1 division-currency unit (the ECB way, 1.087).
 */
export type RateDirection = "base_per_foreign" | "foreign_per_base";
export const isRateDirection = (v: unknown): v is RateDirection =>
  v === "base_per_foreign" || v === "foreign_per_base";

/**
 * The open amount of an item in the division currency at the item's booked rate, in integer minor
 * units, rounded once half away from zero (ADR 0035). Null when the rate is not a plain positive
 * decimal, a currency code is invalid, or the amount is out of range. Same currency in and out
 * returns the amount unchanged. Used only when the booked division-currency amount is not read
 * from Exact (ADR 0038, option 3).
 */
export function bookedAtRate(args: {
  openMinor: bigint | number;
  currency: string;
  baseCurrency: string;
  rate: RateString;
  direction: RateDirection;
}): bigint | null {
  const a = toBigint(args.openMinor);
  if (!a.ok) return null;
  if (!validCode(args.currency) || !validCode(args.baseCurrency)) return null;
  if (args.currency === args.baseCurrency) return a.value;
  const r = parseRate(args.rate);
  if (!r.ok) return null;
  const d = parseDecimal(r.rate);
  if (!d) return null;
  const sf = currencyScale(args.currency);
  const sb = currencyScale(args.baseCurrency);
  return args.direction === "base_per_foreign"
    ? divRound(a.value * pow10(sb) * d.int, pow10(sf) * pow10(d.scale))
    : divRound(a.value * pow10(sb) * pow10(d.scale), pow10(sf) * d.int);
}

/**
 * Gain (positive) or loss (negative) of an unrealised difference, by open-item kind
 * (`open_items.kind`: `invoice` = receivable, `bill` = payable). A receivable whose base value
 * rose is a gain; a payable whose base value rose is a loss. Credit notes need no special case:
 * their negative open balance already flips `differenceMinor`.
 */
export function unrealisedResultMinor(kind: "invoice" | "bill", differenceMinor: bigint): bigint {
  if (kind === "invoice") return differenceMinor;
  if (kind === "bill") return -differenceMinor;
  throw new RangeError("kind must be invoice or bill");
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
