/**
 * ECB euro foreign exchange reference rates (EXR dataset, SDMX-CSV). Pure parsing, no I/O.
 *
 * Source: https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?format=csvdata
 * Rates are "units of currency per 1 EUR", published around 16:00 CET on TARGET working days.
 */
import { type RateString, type RateTable, parseRate } from "./fx";

export interface EcbObservation {
  currency: string;
  /** YYYY-MM-DD */
  rateDate: string;
  rate: RateString;
}

/** Input larger than this many UTF-16 units is refused before any parsing. */
export const ECB_MAX_CSV_CHARS = 5 * 1024 * 1024;
const ECB_BASE = "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A";
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_LAST_N = 1000;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  if (typeof s !== "string") return false;
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

/** RFC 4180 style split. Returns null when a quoted field is never closed. */
function parseCsvRows(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += c;
      }
      i += 1;
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text.charAt(i + 1) === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
    i += 1;
  }
  if (inQuotes) return null;
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse the ECB SDMX-CSV. Column positions come from the header. Rows are skipped (and
 * counted) when the currency/date/rate is bad, the observation is empty, the denominator is
 * not EUR or the rate type is not SP00. Later duplicates of (currency, date) replace earlier
 * ones. Never throws.
 */
export function parseEcbCsv(
  text: string,
): { ok: true; observations: EcbObservation[]; skipped: number } | { ok: false; error: string } {
  if (typeof text !== "string") return { ok: false, error: "not_text" };
  if (text.length > ECB_MAX_CSV_CHARS) return { ok: false, error: "too_large" };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = parseCsvRows(body);
  if (!rows) return { ok: false, error: "malformed_csv" };

  const headerIdx = rows.findIndex((r) => r.some((f) => f.trim() !== ""));
  if (headerIdx < 0) return { ok: false, error: "empty" };
  const header = (rows[headerIdx] ?? []).map((h) => h.trim().toUpperCase());
  const col = (name: string): number => header.indexOf(name);
  const iCur = col("CURRENCY");
  const iDate = col("TIME_PERIOD");
  const iVal = col("OBS_VALUE");
  if (iCur < 0 || iDate < 0 || iVal < 0) return { ok: false, error: "missing_columns" };
  const iDenom = col("CURRENCY_DENOM");
  const iType = col("EXR_TYPE");

  const byKey = new Map<string, EcbObservation>();
  let skipped = 0;
  for (const r of rows.slice(headerIdx + 1)) {
    if (r.length === 1 && (r[0] ?? "").trim() === "") continue; // blank line
    const cur = (r[iCur] ?? "").trim();
    const date = (r[iDate] ?? "").trim();
    const val = (r[iVal] ?? "").trim();
    if (iDenom >= 0 && (r[iDenom] ?? "").trim() !== "EUR") {
      skipped += 1;
      continue;
    }
    if (iType >= 0 && (r[iType] ?? "").trim() !== "SP00") {
      skipped += 1;
      continue;
    }
    const rate = parseRate(val);
    if (!CURRENCY_RE.test(cur) || cur === "EUR" || !isIsoDate(date) || !rate.ok) {
      skipped += 1;
      continue;
    }
    byKey.set(`${cur}|${date}`, { currency: cur, rateDate: date, rate: rate.rate });
  }
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

/**
 * Latest observation per currency on or before `onOrBefore`. `asOf` is the newest date used;
 * `ratesDate` keeps each currency's own date so stale currencies stay visible. Returns null
 * for a bad date or when nothing qualifies. Invalid rates are ignored.
 */
export function buildRateTable(
  observations: EcbObservation[],
  onOrBefore: string,
): RateTable | null {
  if (!isIsoDate(onOrBefore)) return null;
  const rates: Record<string, RateString> = Object.create(null) as Record<string, RateString>;
  const ratesDate: Record<string, string> = Object.create(null) as Record<string, string>;
  let asOf = "";
  for (const o of observations) {
    if (!CURRENCY_RE.test(o.currency) || o.currency === "EUR") continue;
    if (!isIsoDate(o.rateDate) || o.rateDate > onOrBefore) continue;
    const p = parseRate(o.rate);
    if (!p.ok) continue;
    const prev = ratesDate[o.currency];
    if (prev !== undefined && prev > o.rateDate) continue;
    rates[o.currency] = p.rate;
    ratesDate[o.currency] = o.rateDate;
    if (o.rateDate > asOf) asOf = o.rateDate;
  }
  if (asOf === "") return null;
  return { asOf, base: "EUR", rates: { ...rates }, ratesDate: { ...ratesDate } };
}
