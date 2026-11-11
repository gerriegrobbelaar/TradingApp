/**
 * Display formatting for money, dates and day counts. Display only: nothing here is used for
 * arithmetic or booking.
 *
 * Locale decision: numbers and currency use nl-NL (1.234,56, as Dutch accountants expect and as
 * Exact shows them); dates use en-GB ("12 Nov 2026") so they read naturally inside the English
 * copy. Both are exported so a user setting can replace them later. Dates are shown in
 * Europe/Amsterdam; calendar dates (YYYY-MM-DD) carry no time zone and are never shifted.
 */
import { currencyScale } from "@camelthorn/core";

export const NUMBER_LOCALE = "nl-NL";
export const DATE_LOCALE = "en-GB";
export const TIME_ZONE = "Europe/Amsterdam";
export const NO_VALUE = "—";

/** Decimal places of a currency's minor unit (JPY 0, EUR 2, KWD 3); 2 for a code core does not know. */
export function scaleOf(currency: string): number {
  try {
    return currencyScale(currency);
  } catch {
    return 2;
  }
}

interface MoneyFormat {
  f: Intl.NumberFormat;
  /** True when Intl does not know the code: the code is then put in front of the number. */
  bare: boolean;
}

const formatters = new Map<string, MoneyFormat>();
function numberFormat(currency: string, scale: number, locale: string): MoneyFormat {
  const key = `${locale}|${currency}|${scale}`;
  let m = formatters.get(key);
  if (!m) {
    const digits = { minimumFractionDigits: scale, maximumFractionDigits: scale };
    try {
      m = {
        f: new Intl.NumberFormat(locale, { style: "currency", currency, ...digits }),
        bare: false,
      };
    } catch {
      // Not a currency code Intl accepts: show the number with the code in front.
      m = { f: new Intl.NumberFormat(locale, digits), bare: true };
    }
    formatters.set(key, m);
  }
  return m;
}

/**
 * Intl.NumberFormat v3 formats a decimal STRING exactly. Older engines convert the string to a
 * float first, which can print the wrong last digit for large amounts, so they take the manual
 * path below instead. Checked once.
 */
let stringFormatSupported: boolean | null = null;
function supportsStringFormat(): boolean {
  if (stringFormatSupported === null) {
    const probe = "9007199254740993"; // 2^53 + 1: a float prints ...992
    const f = new Intl.NumberFormat("en-US", { useGrouping: false });
    stringFormatSupported = (f.format as unknown as (v: string) => string)(probe) === probe;
  }
  return stringFormatSupported;
}

/** Test hook: force the manual path (null restores detection). */
export function _forceStringFormat(v: boolean | null): void {
  stringFormatSupported = v;
}

/**
 * Exact formatting without handing Intl a number: take the locale's layout (symbol position,
 * minus sign, separators, digits) from a sample and put our own digits into it. Grouping is in
 * threes, which is right for nl-NL and en-GB (the locales in use).
 */
function formatManually(
  f: Intl.NumberFormat,
  locale: string,
  value: bigint,
  scale: number,
): string {
  const negative = value < 0n;
  const abs = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const intDigits = abs.slice(0, abs.length - scale);
  const fracDigits = scale > 0 ? abs.slice(abs.length - scale) : "";
  const sample = f.formatToParts(negative ? -1234567 : 1234567);
  const native = new Intl.NumberFormat(locale, { useGrouping: false });
  const digit = (d: string) => native.format(Number(d));
  const toLocal = (s: string) => Array.from(s, digit).join("");
  const group = sample.find((p) => p.type === "group")?.value ?? "";
  const decimal =
    new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
      .formatToParts(1.5)
      .find((p) => p.type === "decimal")?.value ?? ".";
  let grouped = "";
  for (let i = intDigits.length; i > 0; i -= 3) {
    const chunk = toLocal(intDigits.slice(Math.max(0, i - 3), i));
    grouped = i === intDigits.length ? chunk : `${chunk}${group}${grouped}`;
  }
  let out = "";
  let placed = false;
  for (const p of sample) {
    if (p.type === "integer" || p.type === "group") {
      if (!placed) {
        out += grouped + (scale > 0 ? decimal + toLocal(fracDigits) : "");
        placed = true;
      }
    } else if (p.type === "decimal" || p.type === "fraction") {
      // Already written with the integer part.
    } else {
      out += p.value;
    }
  }
  return out;
}

/** Exact decimal text for integer minor units, no float involved ("-1234.50", "-0.005"). */
export function minorToDecimal(minor: bigint, scale: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/** Credit amounts (credit notes, overpayments) are negative. */
export function isCredit(minor: number | bigint): boolean {
  return minor < 0;
}

/**
 * "€ 1.234,56" for integer minor units at the currency's real exponent (JPY 0, KWD 3). The
 * amount goes to Intl as an exact decimal string (or through the manual path on engines without
 * string support), so values beyond 2^53 keep every digit (pass a bigint to hold them in the
 * first place). A negative amount (credit) has a minus sign. A non-integer or non-finite input
 * shows an em dash instead of a wrong number. A code Intl rejects is shown in front ("EURO 1,50").
 */
export function formatMoney(
  minor: number | bigint,
  currency: string,
  locale: string = NUMBER_LOCALE,
): string {
  let value: bigint;
  if (typeof minor === "bigint") value = minor;
  else if (Number.isSafeInteger(minor)) value = BigInt(minor);
  else return NO_VALUE;
  const scale = scaleOf(currency);
  const { f, bare } = numberFormat(currency, scale, locale);
  const text = supportsStringFormat()
    ? // Intl.NumberFormat v3 accepts a decimal string and keeps all digits.
      (f.format as unknown as (v: string) => string)(minorToDecimal(value, scale))
    : formatManually(f, locale, value, scale);
  return bare ? `${currency} ${text}` : text;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const dateFmt = new Intl.DateTimeFormat(DATE_LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const instantDateFmt = new Intl.DateTimeFormat(DATE_LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: TIME_ZONE,
});
const dateTimeFmt = new Intl.DateTimeFormat(DATE_LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

/** "12 Nov 2026" from a calendar date (not shifted) or an instant (Amsterdam day). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return NO_VALUE;
  const m = DATE_ONLY.exec(value);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const at = new Date(Date.UTC(y, mo - 1, d));
    // "2026-02-31" would roll over to 3 March: show a dash, never a different day.
    if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) {
      return NO_VALUE;
    }
    return dateFmt.format(at);
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? instantDateFmt.format(ms) : NO_VALUE;
}

/** "12 Nov 2026, 14:05" in Amsterdam time. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return NO_VALUE;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? dateTimeFmt.format(ms) : NO_VALUE;
}

/** "just now", "3 min ago", "2 h ago", "4 days ago". Future times count as just now. */
export function formatAgo(value: string | null | undefined, nowMs: number = Date.now()): string {
  const ms = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return NO_VALUE;
  const mins = Math.floor((nowMs - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** "1 day", "12 days". */
export function formatDays(days: number): string {
  const n = Math.abs(Math.round(days));
  return `${n} ${n === 1 ? "day" : "days"}`;
}

/** Due date as text: "12 days overdue", "Due today", "Due in 3 days", "No due date". */
export function describeDue(daysOverdue: number | null): string {
  if (daysOverdue === null) return "No due date";
  if (daysOverdue > 0) return `${formatDays(daysOverdue)} overdue`;
  if (daysOverdue === 0) return "Due today";
  return `Due in ${formatDays(daysOverdue)}`;
}

/** "1 item", "12 items". */
export function formatCount(n: number, one = "item", many = "items"): string {
  return `${n} ${n === 1 ? one : many}`;
}

const DECIMAL_SEPARATOR =
  new Intl.NumberFormat(NUMBER_LOCALE, { minimumFractionDigits: 1 })
    .formatToParts(1.5)
    .find((p) => p.type === "decimal")?.value ?? ".";

/**
 * A variance in basis points (1 % = 100 bp) as a percentage with one decimal: 1234 -> "12,3%".
 * Integer math only (BigInt): the tenth of a percent is rounded half away from zero, so 1235 gives
 * "12,4%" and -1235 gives "-12,4%". Null (zero or missing base) is an em dash, never "0%". A value
 * that rounds to zero prints "0,0%" without a minus sign.
 */
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isSafeInteger(bps)) return NO_VALUE;
  const negative = bps < 0;
  const abs = BigInt(negative ? -bps : bps);
  const tenths = (abs + 5n) / 10n; // half up on the magnitude = half away from zero
  const text = `${(tenths / 10n).toString()}${DECIMAL_SEPARATOR}${(tenths % 10n).toString()}%`;
  return negative && tenths > 0n ? `-${text}` : text;
}

const yearFmt = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: TIME_ZONE });
/** The calendar year in Amsterdam right now (the reporting year, ADR 0024). */
export function currentAmsterdamYear(now: number = Date.now()): number {
  return Number(yearFmt.format(now));
}

const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "numeric", timeZone: TIME_ZONE });
/** The calendar month (1-12) in Amsterdam right now: the server's default period. */
export function currentAmsterdamMonth(now: number = Date.now()): number {
  return Number(monthFmt.format(now));
}
