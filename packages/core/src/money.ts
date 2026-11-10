/**
 * Money: integer minor units plus an ISO 4217 currency code. Never floats.
 *
 * Minor units follow the currency's ISO 4217 exponent (`currencyScale`): 2 for EUR/USD/GBP,
 * 0 for JPY and friends, 3 for KWD/BHD/... So `{ minor: 1234, currency: "JPY" }` is 1,234 yen.
 *
 * Rounding rule (documented, applied only when a decimal string has more digits than the
 * requested scale): half away from zero on the first dropped digit ("0.005" -> 0.01 and
 * "-0.005" -> -0.01; for JPY "1234.5" -> 1235). Exact normally sends at most the currency's own
 * decimals, so this only matters for rates and tiny exponent values such as 1e-7 (-> 0).
 */

export interface Money {
  /** Integer minor units (cents for EUR). Always a safe integer. */
  readonly minor: number;
  /** ISO 4217 code, upper case. */
  readonly currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const MAX_EXPONENT = 1000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** ISO 4217 currencies whose minor-unit exponent is not 2. Everything else uses 2. */
const SCALE_EXCEPTIONS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

/** Minor-unit exponent for an ISO 4217 code (2 unless listed as an exception). */
export function currencyScale(currency: string): number {
  if (!CURRENCY_RE.test(currency)) throw new RangeError("currency must be an ISO 4217 code");
  return SCALE_EXCEPTIONS[currency] ?? 2;
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 8) {
    throw new RangeError("scale must be an integer between 0 and 8");
  }
}

/**
 * Parse a decimal string ("1234.5", "-0.07", "1e-7", "12E3") into integer minor units at the
 * given scale (default 2). Pure string/BigInt arithmetic: no float is ever involved.
 * Throws RangeError for malformed input or results beyond Number.MAX_SAFE_INTEGER.
 */
export function parseMinor(raw: string, scale = 2): number {
  assertScale(scale);
  const text = raw.trim();
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new RangeError("not a decimal number");
  const sign = m[1] ?? "";
  const intDigits = m[2] ?? "";
  const fracDigits = m[3] ?? "";
  if (intDigits.length + fracDigits.length === 0) throw new RangeError("not a decimal number");
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > MAX_EXPONENT) {
    throw new RangeError("exponent out of range");
  }

  const digits = intDigits + fracDigits;
  const point = intDigits.length + exp; // position of the decimal point within `digits`
  let whole: string;
  let frac: string;
  if (point <= 0) {
    whole = "0";
    frac = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    whole = digits + "0".repeat(point - digits.length);
    frac = "";
  } else {
    whole = digits.slice(0, point);
    frac = digits.slice(point);
  }

  let scaled = BigInt(whole + frac.slice(0, scale).padEnd(scale, "0"));
  const dropped = frac.charAt(scale);
  if (dropped !== "" && dropped >= "5") scaled += 1n;
  if (scaled > MAX_SAFE) throw new RangeError("amount exceeds the safe integer range");
  const n = Number(scaled);
  return sign === "-" && n !== 0 ? -n : n;
}

export function money(minor: number, currency: string): Money {
  if (!Number.isSafeInteger(minor)) throw new RangeError("minor units must be a safe integer");
  if (!CURRENCY_RE.test(currency)) throw new RangeError("currency must be an ISO 4217 code");
  return { minor: minor === 0 ? 0 : minor, currency };
}

/** Parse an Exact-style decimal into Money at the currency's own scale (`currencyScale`). */
export function moneyFromDecimal(raw: string, currency: string): Money {
  return money(parseMinor(raw, currencyScale(currency)), currency);
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new RangeError("currency mismatch");
}

export function addMoney(a: Money, b: Money): Money {
  assertSame(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subMoney(a: Money, b: Money): Money {
  assertSame(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function negateMoney(a: Money): Money {
  return money(-a.minor, a.currency);
}

export function isZeroMoney(a: Money): boolean {
  return a.minor === 0;
}

/** -1, 0 or 1. Throws on mixed currencies: comparing EUR with USD is always a bug. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

/** Format minor units as a plain decimal string ("-12.05"); display formatting lives in the UI. */
export function formatMinor(minor: number, scale = 2): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError("minor units must be a safe integer");
  assertScale(scale);
  const neg = minor < 0;
  const abs = String(Math.abs(minor)).padStart(scale + 1, "0");
  const body = scale === 0 ? abs : `${abs.slice(0, -scale)}.${abs.slice(-scale)}`;
  return neg ? `-${body}` : body;
}

/** Plain decimal string at the currency's own scale ("12.05", JPY "1234", KWD "1.234"). */
export function formatMoney(m: Money): string {
  return formatMinor(m.minor, currencyScale(m.currency));
}
