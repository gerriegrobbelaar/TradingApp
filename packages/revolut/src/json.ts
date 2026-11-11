import { currencyScale, parseMinor } from "@camelthorn/core";
import { RevolutApiError } from "./transport";

/** Error for data Revolut sent that we cannot use. Never carries response text (IBANs, names). */
export function badData(message: string, code: string, status = 200): RevolutApiError {
  return new RevolutApiError(status, message, code);
}

/** Strict JSON number grammar (RFC 8259). */
const JSON_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function isNumberChar(c: string): boolean {
  return (c >= "0" && c <= "9") || c === "." || c === "e" || c === "E" || c === "+" || c === "-";
}

/**
 * Parse JSON while keeping every number as its raw text (same technique as packages/exact: a
 * duplicate on purpose, the Exact copy throws Exact errors). Numbers outside strings are
 * rewritten to JSON strings before JSON.parse, so 1234.50 or 0.1 is never converted to a float.
 * Throws RevolutApiError BAD_JSON without any part of the body.
 */
export function parseJsonRawNumbers(text: string): unknown {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        const d = text.charAt(j);
        if (d === "\\") j += 2;
        else if (d === '"') break;
        else j++;
      }
      if (j >= n) throw badData("Revolut returned invalid JSON", "BAD_JSON");
      i = j + 1;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < n && isNumberChar(text.charAt(j))) j++;
      const token = text.slice(i, j);
      if (!JSON_NUMBER_RE.test(token)) throw badData("Revolut returned invalid JSON", "BAD_JSON");
      parts.push(text.slice(start, i), '"', token, '"');
      start = j;
      i = j;
    } else {
      i++;
    }
  }
  parts.push(text.slice(start));
  try {
    return JSON.parse(parts.join("")) as unknown;
  } catch {
    throw badData("Revolut returned invalid JSON", "BAD_JSON");
  }
}

export type Row = Record<string, unknown>;

export function asRow(v: unknown): Row {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw badData("Unexpected row shape from Revolut", "BAD_SHAPE");
  }
  return v as Row;
}

export function strField(row: Row, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw badData(`Unexpected type for ${key}`, "BAD_SHAPE");
  return v;
}

export function reqStr(row: Row, key: string): string {
  const v = strField(row, key);
  if (v === null || v === "") throw badData(`Missing ${key}`, "BAD_SHAPE");
  return v;
}

export function optStr(row: Row, key: string): string | undefined {
  const v = strField(row, key);
  return v === null || v === "" ? undefined : v;
}

export function boolField(row: Row, key: string): boolean | undefined {
  const v = row[key];
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "boolean") throw badData(`Unexpected type for ${key}`, "BAD_SHAPE");
  return v;
}

export function arrField(row: Row, key: string): unknown[] {
  const v = row[key];
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw badData(`Unexpected type for ${key}`, "BAD_SHAPE");
  return v;
}

export function objField(row: Row, key: string): Row | undefined {
  const v = row[key];
  if (v === null || v === undefined) return undefined;
  return asRow(v);
}

const AMOUNT_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/;

/**
 * Fraction digits a decimal string really needs (trailing zeros and the exponent applied), or
 * null when it is not a decimal. "1234.50" -> 1, "1e-7" -> 7, "12E3" -> 0, "-0.00" -> 0.
 */
function neededScale(raw: string): number | null {
  const m = AMOUNT_RE.exec(raw.trim());
  if (!m) return null;
  const intDigits = m[2] ?? "";
  const fracDigits = m[3] ?? "";
  if (intDigits.length + fracDigits.length === 0) return null;
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  const significant = (intDigits + fracDigits).replace(/0+$/, "");
  return Math.max(0, significant.length - (intDigits.length + exp));
}

/**
 * Decimal major-unit amount (Revolut sends 1234.5, -10 or "1234.50") to integer minor units at
 * the currency's ISO 4217 scale (core `currencyScale`; currencies without an exception use 2).
 * Revolut amounts are exact decimals, so MORE decimals than the currency has is an error
 * (BAD_SHAPE), never rounded: "0.005" EUR, "1e-7" EUR and "1.5" JPY all fail loudly. Beyond
 * Number.MAX_SAFE_INTEGER minor units also fails. "-0.00" is 0.
 */
export function minorOf(raw: string, currency: string, key: string): number {
  try {
    const scale = currencyScale(currency);
    const needed = neededScale(raw);
    if (needed === null || needed > scale) throw new RangeError("excess precision");
    return parseMinor(raw, scale);
  } catch {
    throw badData(`Unexpected amount for ${key}`, "BAD_SHAPE");
  }
}

export function reqMinor(row: Row, key: string, currency: string): number {
  return minorOf(reqStr(row, key), currency, key);
}

export function optMinor(row: Row, key: string, currency: string): number | undefined {
  const v = optStr(row, key);
  return v === undefined ? undefined : minorOf(v, currency, key);
}

export function reqCurrency(row: Row, key: string): string {
  const c = reqStr(row, key).toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw badData(`Unexpected currency for ${key}`, "BAD_SHAPE");
  return c;
}

export function optCurrency(row: Row, key: string): string | undefined {
  const v = optStr(row, key);
  if (v === undefined) return undefined;
  const c = v.toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw badData(`Unexpected currency for ${key}`, "BAD_SHAPE");
  return c;
}
