/**
 * Money: integer minor units plus an ISO 4217 currency code. Never floats.
 *
 * Rounding rule (documented, applied only when a decimal string has more digits than the
 * requested scale): half away from zero on the first dropped digit ("0.005" -> 0.01 and
 * "-0.005" -> -0.01). Exact normally sends at most the currency's own decimals, so this only
 * matters for rates and tiny exponent values such as 1e-7 (-> 0).
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

/**
 * Parse a decimal string ("1234.5", "-0.07", "1e-7", "12E3") into integer minor units at the
 * given scale (default 2). Pure string/BigInt arithmetic: no float is ever involved.
 * Throws RangeError for malformed input or results beyond Number.MAX_SAFE_INTEGER.
 */
export function parseMinor(raw: string, scale = 2): number {
  if (!Number.isInteger(scale) || scale < 0 || scale > 8) {
    throw new RangeError("scale must be an integer between 0 and 8");
  }
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

/** Parse an Exact-style decimal into Money (scale 2). */
export function moneyFromDecimal(raw: string, currency: string, scale = 2): Money {
  return money(parseMinor(raw, scale), currency);
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

/** Format minor units as a plain decimal string ("-12.05"); display formatting lives in the UI. */
export function formatMinor(minor: number, scale = 2): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError("minor units must be a safe integer");
  const neg = minor < 0;
  const abs = String(Math.abs(minor)).padStart(scale + 1, "0");
  const body = scale === 0 ? abs : `${abs.slice(0, -scale)}.${abs.slice(-scale)}`;
  return neg ? `-${body}` : body;
}
