/**
 * Schedule logic for the job scheduler (CLAUDE.md 4.1). Pure: no I/O, no clock reads.
 *
 * All times are evaluated in Europe/Amsterdam local time; results are epoch ms UTC.
 * See docs/decisions/0020-schedule-semantics.md.
 *
 * DST rules (one rule per transition, decided only by the hour field):
 * - Hour field is a wildcard (`*`, `*\/1` or every hour 0-23): the job fires at every real clock
 *   mark. In spring the missing hour simply has no fires; in autumn the repeated hour fires twice
 *   (once in summer time, once in winter time). So `0 * * * *` fires 23 times on the spring day
 *   and 25 times on the autumn day, always one real hour apart, and `*\/10` stays 10 minutes apart.
 * - Hour field is restricted (for example `30 2 * * *`, `0 *\/2 * * *`, or last_working_day at
 *   02:30): in spring a wall time inside the missing hour (02:00-02:59) fires ONCE at 03:00 local,
 *   the first instant after the gap; in autumn a wall time inside the repeated hour fires ONCE, at
 *   the first (summer time) occurrence.
 * - Day-of-month / day-of-week follow the standard cron rule: when both are restricted (first
 *   character not `*`) either may match, otherwise both must.
 * - `workingDaysOnly` additionally requires the Amsterdam local date to be a TARGET working day.
 * - nextRun looks at most 5 years (5 x 366 days) ahead and returns null beyond that.
 */
import { amsterdamParts } from "./local-time";
import {
  addDaysIso,
  dayOfWeekIso,
  isTargetWorkingDay,
  lastTargetWorkingDay,
} from "./target-calendar";

export type Schedule =
  | { kind: "cron"; expr: string; workingDaysOnly?: boolean }
  | { kind: "last_working_day"; time: string };

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const HORIZON_DAYS = 5 * 366 + 2;
/** Inputs outside this range return null (Intl and Date cannot represent far-off instants). */
const MIN_INPUT_MS = Date.UTC(1970, 0, 1);
const MAX_INPUT_MS = Date.UTC(9000, 0, 1);
/** Fixed reference used by validateSchedule to reject schedules that never fire. */
const VALIDATION_REF_MS = Date.UTC(2025, 0, 1);

// ---------------------------------------------------------------------------------------------
// Cron parsing

interface ParsedCron {
  minutes: number[];
  hours: number[];
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
const MAX_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function parseValue(
  tok: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): number | null {
  const lower = tok.toLowerCase();
  if (names && Object.prototype.hasOwnProperty.call(names, lower)) return names[lower] as number;
  if (!/^\d{1,2}$/.test(tok)) return null;
  const n = Number(tok);
  return n >= min && n <= max ? n : null;
}

function parseField(
  field: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): Set<number> | null {
  const out = new Set<number>();
  for (const item of field.split(",")) {
    const [rangePart, stepPart, ...extra] = item.split("/");
    if (extra.length > 0 || rangePart === undefined || rangePart === "") return null;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d{1,3}$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step < 1 || step > max - min + 1) return null;
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const bounds = rangePart.split("-");
      if (bounds.length !== 2) return null;
      const a = parseValue(bounds[0] as string, min, max, names);
      const b = parseValue(bounds[1] as string, min, max, names);
      if (a === null || b === null || a > b) return null;
      lo = a;
      hi = b;
    } else {
      const a = parseValue(rangePart, min, max, names);
      if (a === null) return null;
      lo = a;
      hi = stepPart !== undefined ? max : a;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr: string): ParsedCron | string {
  if (expr.length > 200) return "Cron expression is too long";
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    return "Cron expression needs 5 fields: minute hour day-of-month month day-of-week";
  const [fMin, fHour, fDom, fMon, fDow] = fields as [string, string, string, string, string];
  const minutes = parseField(fMin, 0, 59);
  if (!minutes) return `Invalid minute field: ${fMin}`;
  const hours = parseField(fHour, 0, 23);
  if (!hours) return `Invalid hour field: ${fHour}`;
  const doms = parseField(fDom, 1, 31);
  if (!doms) return `Invalid day-of-month field: ${fDom}`;
  const months = parseField(fMon, 1, 12, MONTH_NAMES);
  if (!months) return `Invalid month field: ${fMon}`;
  const rawDows = parseField(fDow, 0, 7, DOW_NAMES);
  if (!rawDows) return `Invalid day-of-week field: ${fDow}`;
  const dows = new Set([...rawDows].map((d) => d % 7));
  const domStar = fDom.startsWith("*");
  const dowStar = fDow.startsWith("*");
  // Reject expressions that can never fire (for example 31 February).
  if (domStar || dowStar) {
    let possible = false;
    for (const mo of months)
      for (const d of doms) if (d <= (MAX_DAYS[mo] as number)) possible = true;
    if (!possible) return "Cron expression never fires (no such calendar date)";
  }
  return {
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    doms,
    months,
    dows,
    domStar,
    dowStar,
  };
}

// ---------------------------------------------------------------------------------------------
// Local <-> UTC

/** Amsterdam UTC offset in minutes (60 or 120) at an instant. */
function offsetMin(ms: number): number {
  const p = amsterdamParts(ms);
  const [y, mo, d] = p.date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d, p.hour, p.minute);
  return (wall - Math.floor(ms / MIN_MS) * MIN_MS) / MIN_MS;
}

/**
 * All fire instants (sorted, unique, epoch ms) on one Amsterdam local date for the given hour and
 * minute sets, applying the DST rules documented at the top of this file.
 */
function dayInstants(date: string, hours: readonly number[], minutes: readonly number[]): number[] {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const base = Date.UTC(y, mo - 1, d);
  // DST changes happen at 01:00 UTC, so the offsets at 00:00 UTC and 12:00 UTC bracket the change.
  const o1 = offsetMin(base);
  const o2 = offsetMin(base + 12 * HOUR_MS);
  const hourRestricted = hours.length < 24;
  const out = new Set<number>();
  for (const h of hours) {
    for (const mi of minutes) {
      const wallMin = h * 60 + mi;
      const wall = base + wallMin * MIN_MS;
      const inWindow = wallMin >= 120 && wallMin < 180;
      if (o1 === o2) {
        out.add(wall - o1 * MIN_MS);
      } else if (o1 < o2) {
        // Spring forward: 02:00-02:59 local does not exist.
        if (inWindow) {
          if (hourRestricted) out.add(base + HOUR_MS); // 03:00 local, the first instant after the gap
        } else out.add(wall - (wallMin < 120 ? o1 : o2) * MIN_MS);
      } else if (inWindow) {
        // Fall back: 02:00-02:59 occurs twice (summer time first).
        out.add(wall - o1 * MIN_MS);
        if (!hourRestricted) out.add(wall - o2 * MIN_MS);
      } else {
        out.add(wall - (wallMin < 120 ? o1 : o2) * MIN_MS);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------
// Public API

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateSchedule(
  s: unknown,
): { ok: true; schedule: Schedule } | { ok: false; error: string } {
  if (typeof s !== "object" || s === null || Array.isArray(s))
    return { ok: false, error: "Schedule must be an object" };
  const rec = s as Record<string, unknown>;
  if (rec["kind"] === "cron") {
    const expr = rec["expr"];
    if (typeof expr !== "string") return { ok: false, error: "Cron expression must be a string" };
    const wdo = rec["workingDaysOnly"];
    if (wdo !== undefined && typeof wdo !== "boolean")
      return { ok: false, error: "workingDaysOnly must be true or false" };
    const parsed = parseCron(expr);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    const clean = expr.trim().split(/\s+/).join(" ");
    const schedule: Schedule =
      wdo === undefined
        ? { kind: "cron", expr: clean }
        : { kind: "cron", expr: clean, workingDaysOnly: wdo };
    // For example 25 December on working days only: always a TARGET holiday.
    if (nextRun(schedule, VALIDATION_REF_MS) === null)
      return { ok: false, error: "Schedule never fires within 5 years" };
    return { ok: true, schedule };
  }
  if (rec["kind"] === "last_working_day") {
    const time = rec["time"];
    if (typeof time !== "string" || !TIME.test(time))
      return { ok: false, error: "Time must be HH:mm (00:00 to 23:59)" };
    return { ok: true, schedule: { kind: "last_working_day", time } };
  }
  return { ok: false, error: "Unknown schedule kind" };
}

function dayMatches(p: ParsedCron, date: string, workingDaysOnly: boolean): boolean {
  const month = Number(date.slice(5, 7));
  if (!p.months.has(month)) return false;
  const domOk = p.doms.has(Number(date.slice(8, 10)));
  const dowOk = p.dows.has(dayOfWeekIso(date));
  const dayOk = !p.domStar && !p.dowStar ? domOk || dowOk : domOk && dowOk;
  if (!dayOk) return false;
  return !workingDaysOnly || isTargetWorkingDay(date);
}

/** Next fire strictly after `afterMs` (epoch ms UTC), or null if none within 5 years. */
export function nextRun(s: Schedule, afterMs: number): number | null {
  if (!Number.isFinite(afterMs) || afterMs < MIN_INPUT_MS || afterMs > MAX_INPUT_MS) return null;
  const limit = afterMs + 5 * 366 * DAY_MS;
  if (s.kind === "cron") {
    const p = parseCron(s.expr);
    if (typeof p === "string") return null;
    const start = amsterdamParts(afterMs).date;
    for (let i = 0; i < HORIZON_DAYS; i++) {
      const date = addDaysIso(start, i);
      if (!dayMatches(p, date, s.workingDaysOnly === true)) continue;
      for (const t of dayInstants(date, p.hours, p.minutes)) {
        if (t > afterMs) return t <= limit ? t : null;
      }
    }
    return null;
  }
  const m = TIME.exec(s.time);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const startDate = amsterdamParts(afterMs).date;
  const year = Number(startDate.slice(0, 4));
  const month = Number(startDate.slice(5, 7));
  // A single-entry hour list counts as restricted: a gap time moves to 03:00, a repeated time fires once.
  // This month's fire may already be past; next month's is then always later than afterMs.
  const fireIn = (y: number, mo: number): number =>
    dayInstants(lastTargetWorkingDay(y, mo), [h], [mi])[0] as number;
  const thisMonth = fireIn(year, month);
  if (thisMonth > afterMs) return thisMonth;
  return month === 12 ? fireIn(year + 1, 1) : fireIn(year, month + 1);
}

/**
 * True if a fire time exists in (lastRunMs ?? createdMs, nowMs]. Catches up at most one missed run:
 * the caller runs once and records lastRunMs = now, so a long outage never replays every missed fire.
 *
 * Clock going backwards: if the reference (lastRunMs ?? createdMs) is up to one day in the future,
 * the job waits for the first fire after the reference, so a job that already ran never runs twice
 * for the same slot. A reference more than one day in the future is treated as corrupt: the job then
 * runs on its normal schedule (a fire in the minute ending at nowMs) instead of stalling for good,
 * and recording lastRunMs = now afterwards returns it to normal.
 */
export function isDue(
  s: Schedule,
  lastRunMs: number | null,
  nowMs: number,
  createdMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const ref = lastRunMs ?? createdMs;
  const base = Number.isFinite(ref) && ref - nowMs > DAY_MS ? nowMs - MIN_MS : ref;
  const next = nextRun(s, base);
  return next !== null && next <= nowMs;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** Sentence-case English description. */
export function describeSchedule(s: Schedule): string {
  if (s.kind === "last_working_day") return `Last working day of the month at ${s.time}`;
  if (typeof parseCron(s.expr) === "string")
    return `Invalid schedule (${s.expr.trim().slice(0, 60)})`;
  const fields = s.expr.trim().split(/\s+/);
  const wd = s.workingDaysOnly === true;
  const [fMin = "", fHour = "", fDom = "", fMon = "", fDow = ""] = fields;
  const fallback = `Custom schedule (${s.expr.trim()}) in Amsterdam time${wd ? ", working days only" : ""}`;
  const weekdays = /^(1-5|mon-fri)$/i.test(fDow);
  if (fDom !== "*" || fMon !== "*" || (fDow !== "*" && !weekdays)) return fallback;
  // Working days are a subset of Monday to Friday, so "1-5" adds nothing when the flag is on.
  const suffix = wd ? " on working days" : weekdays ? " on weekdays" : "";
  const step = /^\*\/(\d+)$/.exec(fMin);
  if (fHour === "*" && (fMin === "*" || (step && 60 % Number(step[1]) === 0))) {
    const n = fMin === "*" ? 1 : Number(step?.[1]);
    return (n === 1 ? "Every minute" : `Every ${n} minutes`) + suffix;
  }
  if (fHour === "*" && /^\d{1,2}$/.test(fMin)) {
    return (
      (Number(fMin) === 0 ? "Every hour on the hour" : `Every hour at minute ${Number(fMin)}`) +
      suffix
    );
  }
  if (/^\d{1,2}$/.test(fMin) && /^\d{1,2}$/.test(fHour)) {
    const t = `${two(Number(fHour))}:${two(Number(fMin))}`;
    return wd ? `Working days at ${t}` : weekdays ? `Weekdays at ${t}` : `Daily at ${t}`;
  }
  return fallback;
}
