/**
 * Small BigInt decimal helpers for FX maths (ADR 0035). No floats, no dependencies.
 *
 * A `Dec` is the exact value `int / 10^scale`. Everything here is exact except `divRound`,
 * which rounds once, half away from zero.
 */

export interface Dec {
  /** Signed integer numerator. */
  readonly int: bigint;
  /** Number of decimal places, an integer >= 0. */
  readonly scale: number;
}

const PLAIN_DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;
const MAX_DIGITS = 60;

export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw new RangeError("power out of range");
  return 10n ** BigInt(n);
}

/**
 * Parse a plain decimal ("12", "-0.5", "007.250"). No exponent, whitespace, "+", ".5" or "5.".
 * At most 60 digits in total, so hostile input cannot make later arithmetic expensive.
 */
export function parseDecimal(s: string): Dec | null {
  if (typeof s !== "string") return null;
  const m = PLAIN_DECIMAL_RE.exec(s);
  if (!m) return null;
  const whole = m[2] ?? "";
  const frac = m[3] ?? "";
  if (whole.length + frac.length > MAX_DIGITS) return null;
  const int = BigInt(whole + frac);
  return { int: m[1] === "-" ? -int : int, scale: frac.length };
}

/** Plain decimal string with exactly `scale` fraction digits (no trailing-zero stripping). */
export function decToString(d: Dec): string {
  const neg = d.int < 0n;
  const digits = (neg ? -d.int : d.int).toString().padStart(d.scale + 1, "0");
  const body = d.scale === 0 ? digits : `${digits.slice(0, -d.scale)}.${digits.slice(-d.scale)}`;
  return neg ? `-${body}` : body;
}

/** Strip trailing fraction zeros ("1.2300" -> "1.23", "2.000" -> "2"); the sign of zero is dropped. */
export function normaliseDec(d: Dec): Dec {
  let { int, scale } = d;
  while (scale > 0 && int % 10n === 0n) {
    int /= 10n;
    scale -= 1;
  }
  return { int, scale };
}

export function compareDec(a: Dec, b: Dec): -1 | 0 | 1 {
  const s = Math.max(a.scale, b.scale);
  const x = a.int * pow10(s - a.scale);
  const y = b.int * pow10(s - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function mulDec(a: Dec, b: Dec): Dec {
  return { int: a.int * b.int, scale: a.scale + b.scale };
}

/**
 * Integer division of `num` by a non-zero `den`, rounded half away from zero (the one rounding
 * rule of ADR 0035: 2.5 -> 3, -2.5 -> -3, 0.4 -> 0).
 */
export function divRound(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new RangeError("division by zero");
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const neg = n < 0n;
  const abs = neg ? -n : n;
  let q = abs / d;
  if ((abs % d) * 2n >= d) q += 1n;
  return neg ? -q : q;
}

/** Divide two decs and round to `scale` fraction digits (half away from zero). */
export function divDec(a: Dec, b: Dec, scale: number): Dec {
  if (b.int === 0n) throw new RangeError("division by zero");
  // (a.int / 10^a.s) / (b.int / 10^b.s) * 10^scale
  const num = a.int * pow10(b.scale + scale);
  const den = b.int * pow10(a.scale);
  return { int: divRound(num, den), scale };
}

/** Round a dec to at most `scale` fraction digits (half away from zero). */
export function roundDec(d: Dec, scale: number): Dec {
  if (d.scale <= scale) return d;
  return { int: divRound(d.int, pow10(d.scale - scale)), scale };
}
