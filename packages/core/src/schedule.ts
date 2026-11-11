/**
 * STUB (task H2). The real implementation, with tests, is owned by task H1 and replaces this file
 * on merge; only the exported interface below is shared. It is good enough for the job runner's
 * tests: five-field cron in Europe/Amsterdam, optional working-days-only (TARGET calendar), and
 * "last working day of the month at HH:MM".
 */
import { amsterdamParts } from "./local-time";

export type Schedule =
  | { kind: "cron"; expr: string; workingDaysOnly?: boolean }
  | { kind: "last_working_day"; time: string };

const RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(text: string, [lo, hi]: readonly [number, number]): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return null;
    let a = lo;
    let b = hi;
    if (m[1] !== "*") {
      const [x, y] = (m[1] as string).split("-");
      a = Number(x);
      b = y === undefined ? (m[2] === undefined ? a : hi) : Number(y);
    }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((p, q) => p - q);
}

function parseCron(expr: string): number[][] | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const parsed = f.map((x, i) => parseField(x, RANGES[i] as readonly [number, number]));
  if (parsed.some((p) => p === null || p.length === 0)) return null;
  return parsed as number[][];
}

const easter = (y: number): Date => {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const g = Math.floor((8 * b + 13) / 25);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
};

const isoOf = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);

export function isTargetWorkingDay(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) return false;
  const y = d.getUTCFullYear();
  const e = easter(y);
  const closed = [
    `${y}-01-01`,
    `${y}-05-01`,
    `${y}-12-25`,
    `${y}-12-26`,
    isoOf(addDays(e, -2)),
    isoOf(addDays(e, 1)),
  ];
  return !closed.includes(iso);
}

export function previousTargetWorkingDay(iso: string): string {
  let d = addDays(new Date(`${iso}T00:00:00Z`), -1);
  while (!isTargetWorkingDay(isoOf(d))) d = addDays(d, -1);
  return isoOf(d);
}

export function lastTargetWorkingDay(y: number, m: number): string {
  let d = new Date(Date.UTC(y, m, 0));
  while (!isTargetWorkingDay(isoOf(d))) d = addDays(d, -1);
  return isoOf(d);
}

export function targetWorkingDaysBetween(a: string, b: string): number {
  let n = 0;
  for (let d = addDays(new Date(`${a}T00:00:00Z`), 1); isoOf(d) <= b; d = addDays(d, 1)) {
    if (isTargetWorkingDay(isoOf(d))) n++;
  }
  return n;
}

/** Instant of a local Amsterdam wall time, or null when it does not exist (spring forward). */
function localToUtc(date: string, hour: number, minute: number): number | null {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const base = Date.parse(`${date}T${hh}:${mm}:00Z`);
  for (const off of [7_200_000, 3_600_000]) {
    const t = base - off;
    const p = amsterdamParts(t);
    if (p.date === date && p.hour === hour && p.minute === minute) return t;
  }
  return null;
}

export function validateSchedule(
  s: unknown,
): { ok: true; schedule: Schedule } | { ok: false; error: string } {
  if (!s || typeof s !== "object") return { ok: false, error: "schedule_invalid" };
  const o = s as Record<string, unknown>;
  if (o["kind"] === "cron" && typeof o["expr"] === "string") {
    if (parseCron(o["expr"]) === null) return { ok: false, error: "cron_invalid" };
    const wd = o["workingDaysOnly"];
    if (wd !== undefined && typeof wd !== "boolean")
      return { ok: false, error: "schedule_invalid" };
    return {
      ok: true,
      schedule: {
        kind: "cron",
        expr: o["expr"].trim().replace(/\s+/g, " "),
        ...(wd === true ? { workingDaysOnly: true } : {}),
      },
    };
  }
  if (o["kind"] === "last_working_day" && typeof o["time"] === "string") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(o["time"])) return { ok: false, error: "time_invalid" };
    return { ok: true, schedule: { kind: "last_working_day", time: o["time"] } };
  }
  return { ok: false, error: "schedule_invalid" };
}

export function nextRun(s: Schedule, afterMs: number): number | null {
  const start = amsterdamParts(afterMs).date;
  for (let i = 0; i < 400; i++) {
    const day = isoOf(addDays(new Date(`${start}T00:00:00Z`), i));
    const [y, mo, dom] = day.split("-").map(Number) as [number, number, number];
    const times: [number, number][] = [];
    if (s.kind === "last_working_day") {
      if (lastTargetWorkingDay(y, mo) !== day) continue;
      const [h, mi] = s.time.split(":").map(Number) as [number, number];
      times.push([h, mi]);
    } else {
      const f = parseCron(s.expr);
      if (f === null) return null;
      const [mins, hours, doms, months, dows] = f as [
        number[],
        number[],
        number[],
        number[],
        number[],
      ];
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      if (!months.includes(mo)) continue;
      const domAny = doms.length === 31;
      const dowAny = new Set(dows.map((d) => d % 7)).size === 7;
      const domOk = doms.includes(dom);
      const dowOk = dows.some((d) => d % 7 === dow);
      const dayOk = domAny && dowAny ? true : domAny ? dowOk : dowAny ? domOk : domOk || dowOk;
      if (!dayOk) continue;
      if (s.workingDaysOnly === true && !isTargetWorkingDay(day)) continue;
      for (const h of hours) for (const m of mins) times.push([h, m]);
    }
    for (const [h, m] of times) {
      const t = localToUtc(day, h, m);
      if (t !== null && t > afterMs) return t;
    }
  }
  return null;
}

export function isDue(
  s: Schedule,
  lastRunMs: number | null,
  nowMs: number,
  createdMs: number,
): boolean {
  const n = nextRun(s, lastRunMs ?? createdMs);
  return n !== null && n <= nowMs;
}

export function describeSchedule(s: Schedule): string {
  if (s.kind === "last_working_day") return `Last working day of the month at ${s.time}`;
  return `${s.workingDaysOnly === true ? "Working days, " : ""}cron ${s.expr}`;
}
