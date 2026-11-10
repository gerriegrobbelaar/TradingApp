import { parseMinor } from "@camelthorn/core";
import { ExactApiError } from "./transport";

/**
 * Parse JSON while keeping every number as its raw text. Numbers outside strings are rewritten
 * to JSON strings before JSON.parse, so 1234.5, 1e-7 and 64-bit Timestamps are never touched by
 * float conversion. Typed mappers then read them with `minorField` / `intField` / `bigField`.
 */
export function parseJsonRawNumbers(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    if (c === '"') {
      let j = i + 1;
      while (j < n && text.charAt(j) !== '"') j += text.charAt(j) === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(text.charAt(j))) j++;
      out += `"${text.slice(i, j)}"`;
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

/** Exact dates: `/Date(1700000000000)/`, optionally with a `+0100` suffix (ignored; epoch is UTC). */
export function parseExactDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new ExactApiError("Unexpected date value from Exact", 200, "BAD_DATE");
  }
  const m = /^\/Date\((-?\d{1,15})(?:[+-]\d{4})?\)\/$/.exec(raw);
  if (!m) throw new ExactApiError("Unexpected date format from Exact", 200, "BAD_DATE");
  const d = new Date(Number(m[1]));
  if (Number.isNaN(d.getTime())) {
    throw new ExactApiError("Unexpected date value from Exact", 200, "BAD_DATE");
  }
  return d.toISOString();
}

export type Row = Record<string, unknown>;

export function asRow(v: unknown): Row {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ExactApiError("Unexpected row shape from Exact", 200, "BAD_SHAPE");
  }
  return v as Row;
}

export function strField(row: Row, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new ExactApiError(`Unexpected type for ${key}`, 200, "BAD_SHAPE");
  }
  return v;
}

export function reqStr(row: Row, key: string): string {
  const v = strField(row, key);
  if (v === null) throw new ExactApiError(`Missing ${key}`, 200, "BAD_SHAPE");
  return v;
}

/** Trimmed string; Exact left-pads account codes with spaces. Empty becomes null. */
export function trimField(row: Row, key: string): string | null {
  const v = strField(row, key);
  const t = v === null ? "" : v.trim();
  return t === "" ? null : t;
}

export function boolField(row: Row, key: string): boolean {
  return row[key] === true;
}

/** Integer from raw number text. */
export function intField(row: Row, key: string): number | null {
  const v = strField(row, key);
  if (v === null) return null;
  const n = Number(v);
  if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(n)) {
    throw new ExactApiError(`Unexpected integer for ${key}`, 200, "BAD_SHAPE");
  }
  return n;
}

/** 64-bit integer kept as its digit string (Timestamp). */
export function bigField(row: Row, key: string): string | null {
  const v = strField(row, key);
  if (v === null) return null;
  if (!/^\d+$/.test(v)) throw new ExactApiError(`Unexpected integer for ${key}`, 200, "BAD_SHAPE");
  return v.replace(/^0+(?=\d)/, "");
}

/** Decimal amount to integer minor units (null stays null). */
export function minorField(row: Row, key: string, scale = 2): number | null {
  const v = strField(row, key);
  if (v === null) return null;
  try {
    return parseMinor(v, scale);
  } catch {
    throw new ExactApiError(`Unexpected amount for ${key}`, 200, "BAD_SHAPE");
  }
}

export function dateField(row: Row, key: string): string | null {
  return parseExactDate(row[key]);
}
