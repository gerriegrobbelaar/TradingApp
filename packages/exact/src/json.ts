import { currencyScale, parseMinor } from "@camelthorn/core";
import { ExactApiError } from "./transport";

/** Error for data Exact sent that we cannot use. Never carries response text (IBANs, names). */
export function badData(message: string, code: string, status = 200): ExactApiError {
  return new ExactApiError(status, message, code);
}

/** Strict JSON number grammar (RFC 8259): no leading zeros, no bare "." or "+", no "1.". */
const JSON_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function isNumberChar(c: string): boolean {
  return (c >= "0" && c <= "9") || c === "." || c === "e" || c === "E" || c === "+" || c === "-";
}

/**
 * Parse JSON while keeping every number as its raw text. Numbers outside strings are rewritten
 * to JSON strings before JSON.parse, so 1234.5, 1e-7 and 64-bit Timestamps are never touched by
 * float conversion. Digits inside strings (values or keys) are left alone. Every number token
 * must match the strict JSON grammar (leading zeros such as 007 are rejected, not "fixed").
 * Typed mappers then read the text with `minorField` / `intField` / `bigField`.
 *
 * Throws ExactApiError BAD_JSON without any part of the body: engine SyntaxError messages quote
 * the input, and the input may hold IBANs or personal data.
 */
export function parseJsonRawNumbers(text: string): unknown {
  const parts: string[] = [];
  let start = 0; // start of the pending verbatim run
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
      if (j >= n) throw badData("Exact returned invalid JSON", "BAD_JSON");
      i = j + 1;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < n && isNumberChar(text.charAt(j))) j++;
      const token = text.slice(i, j);
      if (!JSON_NUMBER_RE.test(token)) throw badData("Exact returned invalid JSON", "BAD_JSON");
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
    throw badData("Exact returned invalid JSON", "BAD_JSON");
  }
}

/**
 * Exact dates: `/Date(1700000000000)/`, optionally `/Date(1700000000000+0100)/`. The number is
 * epoch milliseconds in UTC; the offset suffix (WCF style) is informational and ignored.
 * Null/absent stays null. See ADR 0014 item 9 for the date-only caveat.
 */
export function parseExactDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw badData("Unexpected date value from Exact", "BAD_DATE");
  const m = /^\/Date\((-?\d{1,15})(?:[+-]\d{4})?\)\/$/.exec(raw);
  if (!m) throw badData("Unexpected date format from Exact", "BAD_DATE");
  const d = new Date(Number(m[1]));
  if (Number.isNaN(d.getTime())) throw badData("Unexpected date value from Exact", "BAD_DATE");
  return d.toISOString();
}

export type Row = Record<string, unknown>;

export function asRow(v: unknown): Row {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw badData("Unexpected row shape from Exact", "BAD_SHAPE");
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
  if (v === null) throw badData(`Missing ${key}`, "BAD_SHAPE");
  return v;
}

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isGuid(v: string): boolean {
  return GUID_RE.test(v);
}

/** Required GUID, lower-cased so it is a stable key in D1. */
export function reqGuid(row: Row, key: string): string {
  const v = reqStr(row, key);
  if (!isGuid(v)) throw badData(`Unexpected GUID for ${key}`, "BAD_SHAPE");
  return v.toLowerCase();
}

/** Trimmed string; Exact left-pads account codes with spaces. Empty becomes null. */
export function trimField(row: Row, key: string): string | null {
  const v = strField(row, key);
  const t = v === null ? "" : v.trim();
  return t === "" ? null : t;
}

/** Boolean; absent or null is false, anything that is not a boolean is a shape error. */
export function boolField(row: Row, key: string): boolean {
  const v = row[key];
  if (v === null || v === undefined) return false;
  if (typeof v !== "boolean") throw badData(`Unexpected type for ${key}`, "BAD_SHAPE");
  return v;
}

/** Integer from raw number text. */
export function intField(row: Row, key: string): number | null {
  const v = strField(row, key);
  if (v === null) return null;
  const n = Number(v);
  if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(n)) {
    throw badData(`Unexpected integer for ${key}`, "BAD_SHAPE");
  }
  return n === 0 ? 0 : n;
}

/** Unsigned 64-bit integer kept as its digit string (Timestamp), at most 20 digits. */
export function bigField(row: Row, key: string): string | null {
  const v = strField(row, key);
  if (v === null) return null;
  if (!/^\d+$/.test(v)) throw badData(`Unexpected integer for ${key}`, "BAD_SHAPE");
  const t = v.replace(/^0+(?=\d)/, "");
  if (t.length > 20 || BigInt(t) > 18446744073709551615n) {
    throw badData(`Unexpected integer for ${key}`, "BAD_SHAPE");
  }
  return t;
}

/**
 * Decimal amount to integer minor units at the currency's ISO 4217 scale (null stays null).
 * Rounding (only if Exact sends more decimals than the currency has): half away from zero,
 * see packages/core/src/money.ts.
 */
export function minorField(row: Row, key: string, currency: string): number | null {
  const v = strField(row, key);
  if (v === null) return null;
  try {
    return parseMinor(v, currencyScale(currency));
  } catch {
    throw badData(`Unexpected amount for ${key}`, "BAD_SHAPE");
  }
}

export function dateField(row: Row, key: string): string | null {
  return parseExactDate(row[key]);
}
