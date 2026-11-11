/**
 * TARGET (T2) calendar: pure date arithmetic on ISO dates (YYYY-MM-DD), no I/O.
 * Closing days: 1 Jan, Good Friday, Easter Monday, 1 May, 25 Dec, 26 Dec, plus weekends.
 * Easter is computed (anonymous Gregorian algorithm), so no tables are needed for any year.
 */

const DAY_MS = 86_400_000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a strict ISO calendar date to UTC-midnight ms, or null if malformed or not a real date. */
function parseIso(iso: string): number | null {
  const m = ISO.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d)
    return null;
  return ms;
}

function mustParse(iso: string): number {
  const ms = parseIso(iso);
  if (ms === null) throw new RangeError(`Invalid ISO date: ${iso}`);
  return ms;
}

function fmt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Add whole days to an ISO date. Throws RangeError on a malformed date. */
export function addDaysIso(iso: string, days: number): string {
  return fmt(mustParse(iso) + days * DAY_MS);
}

/** Day of week of an ISO date, 0 = Sunday. Throws RangeError on a malformed date. */
export function dayOfWeekIso(iso: string): number {
  return new Date(mustParse(iso)).getUTCDay();
}

/** Easter Sunday (Gregorian) as an ISO date. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return fmt(Date.UTC(year, month - 1, day));
}

/** True for a TARGET closing day that is not a weekend (a malformed date returns false). */
export function isTargetHoliday(isoDate: string): boolean {
  const ms = parseIso(isoDate);
  if (ms === null) return false;
  const md = isoDate.slice(5);
  if (md === "01-01" || md === "05-01" || md === "12-25" || md === "12-26") return true;
  const easter = mustParse(easterSunday(Number(isoDate.slice(0, 4))));
  return ms === easter - 2 * DAY_MS || ms === easter + DAY_MS;
}

/** Monday to Friday and not a TARGET holiday. A malformed date returns false. */
export function isTargetWorkingDay(isoDate: string): boolean {
  const ms = parseIso(isoDate);
  if (ms === null) return false;
  const dow = new Date(ms).getUTCDay();
  return dow !== 0 && dow !== 6 && !isTargetHoliday(isoDate);
}

/** The latest TARGET working day strictly before the given date. */
export function previousTargetWorkingDay(isoDate: string): string {
  let ms = mustParse(isoDate) - DAY_MS;
  while (!isTargetWorkingDay(fmt(ms))) ms -= DAY_MS;
  return fmt(ms);
}

/** The last TARGET working day of a month (month is 1-12). */
export function lastTargetWorkingDay(year: number, month1to12: number): string {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month1to12) ||
    month1to12 < 1 ||
    month1to12 > 12
  ) {
    throw new RangeError(`Invalid year/month: ${year}/${month1to12}`);
  }
  // Day 0 of the next month is the last calendar day of this one; step back to a working day.
  let ms = Date.UTC(year, month1to12, 0);
  while (!isTargetWorkingDay(fmt(ms))) ms -= DAY_MS;
  return fmt(ms);
}

/**
 * Number of TARGET working days in the half-open range (from, to], i.e. how many working days
 * have passed since `from`. A rate dated Friday checked on Monday is 1 working day old.
 * If `to` is before `from` the result is the negated count for (to, from].
 */
export function targetWorkingDaysBetween(fromIso: string, toIso: string): number {
  const from = mustParse(fromIso);
  const to = mustParse(toIso);
  if (to < from) return -targetWorkingDaysBetween(toIso, fromIso);
  let n = 0;
  for (let ms = from + DAY_MS; ms <= to; ms += DAY_MS) if (isTargetWorkingDay(fmt(ms))) n++;
  return n;
}
