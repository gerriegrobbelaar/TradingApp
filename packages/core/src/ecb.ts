/**
 * ECB euro foreign exchange reference rates (EXR dataset, SDMX-CSV). Pure parsing, no I/O.
 *
 * Source: https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?format=csvdata
 * Rates are "units of currency per 1 EUR", published around 16:00 CET on TARGET working days.
 */
import { type RateString, type RateTable, parseRate } from "./fx";
import { previousTargetWorkingDay } from "./target-calendar";

export interface EcbObservation {
  currency: string;
  /** YYYY-MM-DD */
  rateDate: string;
  rate: RateString;
}

/**
 * Input larger than this many bytes of UTF-8 is refused before any parsing (5 MiB). Measured
 * on the string as UTF-8 (`utf8ByteLength`), the same unit a fetch body cap uses.
 */
export const ECB_MAX_CSV_BYTES = 5 * 1024 * 1024;
/** @deprecated Same value as `ECB_MAX_CSV_BYTES`; the cap is measured in UTF-8 bytes. */
export const ECB_MAX_CSV_CHARS = ECB_MAX_CSV_BYTES;
/** A data row longer than this (UTF-16 units, line ending excluded) is skipped and counted. */
export const ECB_MAX_ROW_CHARS = 8 * 1024;
const ECB_BASE = "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A";
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_LAST_N = 1000;

/** True for a real calendar date written YYYY-MM-DD (years 1900-2999). */
export function isIsoDate(s: string): boolean {
  if (typeof s !== "string" || s.length !== 10) return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;
  return d <= dim;
}

/**
 * UTF-8 byte length of a JS string without allocating (lone surrogates count 3, as
 * TextEncoder writes U+FFFD). Stops counting once `limit` is exceeded.
 */
export function utf8ByteLength(text: string, limit = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  const n = text.length;
  for (let i = 0; i < n && bytes <= limit; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const QUOTE = 34;
const COMMA = 44;
const CR = 13;
const LF = 10;

/**
 * RFC 4180 style split, one pass, O(n): unquoted fields are sliced, never built char by char.
 * Line endings CRLF, LF or a lone CR. A quoted field may hold commas, line breaks and "" for a
 * quote; text after its closing quote up to the next comma is appended as is (lenient). A quote
 * inside an unquoted field is literal. Calls `onRow(fields, chars)` per row (`chars` = row
 * length without its line ending). Returns false when a quoted field is never closed.
 */
function forEachCsvRow(text: string, onRow: (fields: string[], chars: number) => void): boolean {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const rowStart = i;
    const fields: string[] = [];
    let endOfRow = false;
    while (!endOfRow) {
      let value = "";
      if (i < n && text.charCodeAt(i) === QUOTE) {
        i += 1;
        let closed = false;
        while (i < n) {
          const q = text.indexOf('"', i);
          if (q < 0) break;
          value += text.slice(i, q);
          if (text.charCodeAt(q + 1) === QUOTE) {
            value += '"';
            i = q + 2;
          } else {
            i = q + 1;
            closed = true;
            break;
          }
        }
        if (!closed) return false;
      }
      const start = i;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === COMMA || c === CR || c === LF) break;
        i += 1;
      }
      value += text.slice(start, i);
      fields.push(value);
      if (i >= n) {
        endOfRow = true;
      } else {
        const c = text.charCodeAt(i);
        if (c === COMMA) {
          i += 1;
          // A comma at the very end of the input still ends a (last, empty) field.
          if (i >= n) {
            fields.push("");
            endOfRow = true;
          }
        } else {
          endOfRow = true;
          const rowEnd = i;
          i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
          onRow(fields, rowEnd - rowStart);
          break;
        }
      }
      if (endOfRow && i >= n) {
        onRow(fields, n - rowStart);
        return true;
      }
    }
  }
  return true;
}

const isBlankRow = (r: string[]): boolean => r.length === 1 && (r[0] ?? "").trim() === "";

/**
 * Parse the ECB SDMX-CSV (`format=csvdata`). Columns are found by header name (case-insensitive,
 * trimmed); CURRENCY, TIME_PERIOD and OBS_VALUE are required and must each appear once
 * (`ambiguous_columns` otherwise). Optional FREQ, CURRENCY_DENOM, EXR_TYPE and EXR_SUFFIX, when
 * present, must read D, EUR, SP00 and A. Rows are skipped (and counted) when any of those
 * differ, the currency is not three upper-case letters or is EUR, the date is not a real daily
 * YYYY-MM-DD (monthly "2026-11" and quarterly "2026-Q1" are skipped), the observation is empty,
 * "NaN", signed, in exponent form or not > 0, or the row is longer than `ECB_MAX_ROW_CHARS`.
 * Later duplicates of (currency, date) replace earlier ones. Input over `ECB_MAX_CSV_BYTES`
 * UTF-8 bytes is refused before parsing. Linear time; never throws.
 */
export function parseEcbCsv(
  text: string,
): { ok: true; observations: EcbObservation[]; skipped: number } | { ok: false; error: string } {
  if (typeof text !== "string") return { ok: false, error: "not_text" };
  // UTF-8 never has fewer bytes than UTF-16 units, so a long string is refused without counting.
  if (text.length > ECB_MAX_CSV_BYTES) return { ok: false, error: "too_large" };
  if (
    text.length * 3 > ECB_MAX_CSV_BYTES &&
    utf8ByteLength(text, ECB_MAX_CSV_BYTES) > ECB_MAX_CSV_BYTES
  ) {
    return { ok: false, error: "too_large" };
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let header: string[] | null = null;
  let headerError: string | null = null;
  let iCur = -1;
  let iDate = -1;
  let iVal = -1;
  const optional: { idx: number; want: string }[] = [];
  const byKey = new Map<string, EcbObservation>();
  let skipped = 0;

  const complete = forEachCsvRow(body, (r, chars) => {
    if (headerError !== null) return;
    if (header === null) {
      if (r.every((f) => f.trim() === "")) return;
      header = r.map((h) => h.trim().toUpperCase());
      const h = header;
      const one = (name: string): number => {
        const first = h.indexOf(name);
        if (first >= 0 && h.indexOf(name, first + 1) >= 0) headerError = "ambiguous_columns";
        return first;
      };
      iCur = one("CURRENCY");
      iDate = one("TIME_PERIOD");
      iVal = one("OBS_VALUE");
      if (headerError === null && (iCur < 0 || iDate < 0 || iVal < 0)) {
        headerError = "missing_columns";
      }
      for (const [name, want] of [
        ["FREQ", "D"],
        ["CURRENCY_DENOM", "EUR"],
        ["EXR_TYPE", "SP00"],
        ["EXR_SUFFIX", "A"],
      ] as const) {
        const idx = h.indexOf(name);
        if (idx >= 0) optional.push({ idx, want });
      }
      return;
    }
    if (isBlankRow(r)) return;
    if (chars > ECB_MAX_ROW_CHARS) {
      skipped += 1;
      return;
    }
    for (const o of optional) {
      if ((r[o.idx] ?? "").trim() !== o.want) {
        skipped += 1;
        return;
      }
    }
    const cur = (r[iCur] ?? "").trim();
    const date = (r[iDate] ?? "").trim();
    const rate = parseRate((r[iVal] ?? "").trim());
    if (!CURRENCY_RE.test(cur) || cur === "EUR" || !isIsoDate(date) || !rate.ok) {
      skipped += 1;
      return;
    }
    byKey.set(`${cur}|${date}`, { currency: cur, rateDate: date, rate: rate.rate });
  });
  if (!complete) return { ok: false, error: "malformed_csv" };
  if (header === null) return { ok: false, error: "empty" };
  if (headerError !== null) return { ok: false, error: headerError };
  if (byKey.size === 0) return { ok: false, error: "no_observations" };
  const observations = [...byKey.values()].sort((a, b) =>
    a.rateDate === b.rateDate
      ? a.currency < b.currency
        ? -1
        : a.currency > b.currency
          ? 1
          : 0
      : a.rateDate < b.rateDate
        ? -1
        : 1,
  );
  return { ok: true, observations, skipped };
}

/**
 * Build the only URL the importer may call. Throws RangeError on a malformed date or count,
 * so nothing from outside can alter the host or path.
 */
export function ecbRequestUrl(args: {
  startDate?: string;
  endDate?: string;
  lastN?: number;
}): string {
  const parts = ["format=csvdata"];
  if (args.startDate !== undefined) {
    if (!isIsoDate(args.startDate)) throw new RangeError("startDate must be YYYY-MM-DD");
    parts.push(`startPeriod=${args.startDate}`);
  }
  if (args.endDate !== undefined) {
    if (!isIsoDate(args.endDate)) throw new RangeError("endDate must be YYYY-MM-DD");
    parts.push(`endPeriod=${args.endDate}`);
  }
  if (args.startDate !== undefined && args.endDate !== undefined && args.startDate > args.endDate) {
    throw new RangeError("startDate is after endDate");
  }
  if (args.lastN !== undefined) {
    if (!Number.isInteger(args.lastN) || args.lastN < 1 || args.lastN > MAX_LAST_N) {
      throw new RangeError("lastN must be an integer from 1 to 1000");
    }
    parts.push(`lastNObservations=${args.lastN}`);
  }
  return `${ECB_BASE}?${parts.join("&")}`;
}

/** Default for `buildRateTable`'s `maxAgeTargetDays`. */
export const ECB_MAX_RATE_AGE_TARGET_DAYS = 10;

/**
 * Latest observation per currency on or before `onOrBefore`. `asOf` is the newest date used;
 * `ratesDate` keeps each currency's own date so a currency the ECB skipped one day stays visible
 * with its older date (a Monday before 16:00 CET uses Friday's rates, `asOf` = Friday).
 *
 * A currency whose latest observation is more than `maxAgeTargetDays` TARGET working days
 * (default 10) older than `asOf` is left out: the ECB stopped publishing it (for example HRK
 * after 2022-12-30, RUB after 2022-03-01), and a stale rate silently used for a conversion is a
 * money error, so it reads as `missing_rate` instead. How old `asOf` itself is relative to
 * today is the caller's check (the "rate older than one working day" alert, CLAUDE.md 3).
 *
 * Returns null for a bad date or when nothing qualifies. Invalid observations are ignored.
 * Throws RangeError for a `maxAgeTargetDays` that is not an integer from 0 to 260.
 */
export function buildRateTable(
  observations: EcbObservation[],
  onOrBefore: string,
  opts: { maxAgeTargetDays?: number } = {},
): RateTable | null {
  const maxAge = opts.maxAgeTargetDays ?? ECB_MAX_RATE_AGE_TARGET_DAYS;
  if (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > 260) {
    throw new RangeError("maxAgeTargetDays must be an integer from 0 to 260");
  }
  if (!isIsoDate(onOrBefore) || !Array.isArray(observations)) return null;
  const latest = new Map<string, { date: string; rate: RateString }>();
  let asOf = "";
  for (const o of observations) {
    if (typeof o !== "object" || o === null) continue;
    const { currency, rateDate } = o;
    if (typeof currency !== "string" || !CURRENCY_RE.test(currency) || currency === "EUR") {
      continue;
    }
    if (!isIsoDate(rateDate) || rateDate > onOrBefore) continue;
    const p = parseRate(o.rate);
    if (!p.ok) continue;
    const prev = latest.get(currency);
    if (prev !== undefined && prev.date > rateDate) continue;
    latest.set(currency, { date: rateDate, rate: p.rate });
    if (rateDate > asOf) asOf = rateDate;
  }
  if (asOf === "") return null;
  // Oldest date still current: maxAge TARGET working days before asOf (asOf itself counts as 0).
  let cutoff = asOf;
  for (let k = 0; k < maxAge; k += 1) cutoff = previousTargetWorkingDay(cutoff);
  const rates: Record<string, RateString> = {};
  const ratesDate: Record<string, string> = {};
  for (const [currency, v] of [...latest.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (v.date < cutoff) continue;
    rates[currency] = v.rate;
    ratesDate[currency] = v.date;
  }
  return { asOf, base: "EUR", rates, ratesDate };
}
