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

function scaleOf(currency: string): number {
  try {
    return currencyScale(currency);
  } catch {
    return 2;
  }
}

const formatters = new Map<string, Intl.NumberFormat>();
function numberFormat(currency: string, scale: number, locale: string): Intl.NumberFormat {
  const key = `${locale}|${currency}|${scale}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: scale,
        maximumFractionDigits: scale,
      });
    } catch {
      // Not a currency code Intl knows: show the number with the code in front.
      f = new Intl.NumberFormat(locale, {
        minimumFractionDigits: scale,
        maximumFractionDigits: scale,
      });
    }
    formatters.set(key, f);
  }
  return f;
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
 * amount goes to Intl as an exact decimal string, so values beyond 2^53 keep every digit (pass a
 * bigint to hold them in the first place). A negative amount (credit) has a minus sign. A
 * non-integer or non-finite input shows an em dash instead of a wrong number.
 */
export function formatMoney(
  minor: number | bigint,
  currency: string,
  locale: string = NUMBER_LOCALE,
): string {
  let value: bigint;
  if (typeof minor === "bigint") value = minor;
  else if (Number.isInteger(minor)) value = BigInt(minor);
  else return NO_VALUE;
  const scale = scaleOf(currency);
  const f = numberFormat(currency, scale, locale);
  // Intl.NumberFormat v3 accepts a decimal string and keeps all digits.
  return (f.format as unknown as (v: string) => string)(minorToDecimal(value, scale));
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
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(ms) ? dateFmt.format(ms) : NO_VALUE;
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
