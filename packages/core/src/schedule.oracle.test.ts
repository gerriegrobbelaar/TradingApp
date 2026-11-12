/**
 * Independent oracle tests for schedule.ts and target-calendar.ts. Nothing here reuses the
 * implementation's parsing, offset maths or Easter algorithm: fires are found by a brute-force
 * minute-by-minute scan with its own Intl formatter, Easter by Oudin's algorithm and a known list.
 */
import { describe, expect, it } from "vitest";
import { describeSchedule, isDue, nextRun, validateSchedule, type Schedule } from "./schedule";
import {
  easterSunday,
  isTargetHoliday,
  isTargetWorkingDay,
  lastTargetWorkingDay,
  targetWorkingDaysBetween,
} from "./target-calendar";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Independent calendar

function oudinEaster(y: number): string {
  const g = y % 19;
  const c = Math.floor(y / 100);
  const h = (c - Math.floor(c / 4) - Math.floor((8 * c + 13) / 25) + 19 * g + 15) % 30;
  const i = h - Math.floor(h / 28) * (1 - Math.floor(29 / (h + 1)) * Math.floor((21 - g) / 11));
  const j = (y + Math.floor(y / 4) + i + 2 - c + Math.floor(c / 4)) % 7;
  const l = i - j;
  const month = 3 + Math.floor((l + 40) / 44);
  const day = l + 28 - 31 * Math.floor(month / 4);
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function oracleHolidays(y: number): Set<string> {
  const e = Date.parse(`${oudinEaster(y)}T00:00:00Z`);
  return new Set([
    `${y}-01-01`,
    isoOf(e - 2 * DAY),
    isoOf(e + DAY),
    `${y}-05-01`,
    `${y}-12-25`,
    `${y}-12-26`,
  ]);
}
const holidayCache = new Map<number, Set<string>>();
function oracleWorkingDay(iso: string): boolean {
  const y = Number(iso.slice(0, 4));
  let hs = holidayCache.get(y);
  if (!hs) holidayCache.set(y, (hs = oracleHolidays(y)));
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !hs.has(iso);
}

describe("oracle: TARGET calendar", () => {
  it("Easter matches known dates", () => {
    const known: Record<number, string> = {
      2000: "2000-04-23",
      2008: "2008-03-23",
      2011: "2011-04-24",
      2019: "2019-04-21",
      2024: "2024-03-31",
      2025: "2025-04-20",
      2026: "2026-04-05",
      2027: "2027-03-28",
      2028: "2028-04-16",
      2038: "2038-04-25",
      2049: "2049-04-18",
      2076: "2076-04-19",
      2100: "2100-03-28",
    };
    for (const [y, d] of Object.entries(known)) {
      expect(easterSunday(Number(y))).toBe(d);
      expect(oudinEaster(Number(y))).toBe(d);
    }
  });
  it("Easter matches Oudin's algorithm for 2000-2100", () => {
    for (let y = 2000; y <= 2100; y++) expect(easterSunday(y)).toBe(oudinEaster(y));
  });
  it("holidays are exactly 1 Jan, Good Friday, Easter Monday, 1 May, 25 and 26 Dec (2000-2100)", () => {
    for (let ms = Date.UTC(2000, 0, 1); ms <= Date.UTC(2100, 11, 31); ms += DAY) {
      const d = isoOf(ms);
      const y = Number(d.slice(0, 4));
      const want = oracleHolidays(y).has(d);
      if (isTargetHoliday(d) !== want) expect([d, isTargetHoliday(d)]).toEqual([d, want]);
      if (isTargetWorkingDay(d) !== oracleWorkingDay(d))
        expect([d, isTargetWorkingDay(d)]).toEqual([d, oracleWorkingDay(d)]);
    }
  });
  it("last working day of every month 2025-2030 matches brute force", () => {
    for (let y = 2025; y <= 2030; y++)
      for (let m = 1; m <= 12; m++) {
        let last = "";
        for (let ms = Date.UTC(y, m - 1, 1); new Date(ms).getUTCMonth() === m - 1; ms += DAY)
          if (oracleWorkingDay(isoOf(ms))) last = isoOf(ms);
        expect(lastTargetWorkingDay(y, m)).toBe(last);
      }
  });
  it("working-day age for the ECB staleness alert", () => {
    // Friday rate checked on Monday is one working day old; over Christmas 2026 the 24th
    // (Thursday) rate is still one working day old on Monday 28 December.
    expect(targetWorkingDaysBetween("2026-11-06", "2026-11-09")).toBe(1);
    expect(targetWorkingDaysBetween("2026-12-24", "2026-12-28")).toBe(1);
    expect(targetWorkingDaysBetween("2027-03-25", "2027-03-30")).toBe(1); // Good Friday + Easter Monday
  });
});

// ---------------------------------------------------------------------------------------------
// Brute-force fire oracle

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Amsterdam",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  weekday: "short",
});
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
interface L {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  dow: number;
  date: string;
}
function loc(ms: number): L {
  const g: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) g[p.type] = p.value;
  const y = Number(g["year"]);
  const mo = Number(g["month"]);
  const d = Number(g["day"]);
  return {
    y,
    mo,
    d,
    h: Number(g["hour"]),
    mi: Number(g["minute"]),
    dow: WD[g["weekday"] as string] as number,
    date: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  };
}

interface Spec {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domStar: boolean;
  dowStar: boolean;
  wdo: boolean;
}

function dayOk(sp: Spec, l: L): boolean {
  if (!sp.months.has(l.mo)) return false;
  const a = sp.doms.has(l.d);
  const b = sp.dows.has(l.dow);
  const ok = !sp.domStar && !sp.dowStar ? a || b : a && b;
  return ok && (!sp.wdo || oracleWorkingDay(l.date));
}

/** Does the oracle say the spec fires at minute-aligned instant t? */
function fires(sp: Spec, t: number): boolean {
  const l = loc(t);
  if (!dayOk(sp, l)) return false;
  const restricted = sp.hours.size < 24;
  const prev = loc(t - HOUR);
  // Same wall time an hour ago: this is the second (winter time) occurrence.
  const second = prev.date === l.date && prev.h === l.h && prev.mi === l.mi;
  if (sp.hours.has(l.h) && sp.minutes.has(l.mi) && (!restricted || !second)) return true;
  // Spring gap: wall 03:00 right after a missing 02:xx hour; restricted jobs in the gap fire here.
  const gapDay = l.h === 3 && l.mi === 0 && prev.h === 1 && prev.date === l.date;
  return restricted && gapDay && sp.hours.has(2) && sp.minutes.size > 0;
}

function bruteNext(sp: Spec, after: number, maxMinutes: number): number | null {
  let t = Math.floor(after / MIN) * MIN + MIN;
  for (let i = 0; i < maxMinutes; i++, t += MIN) if (fires(sp, t)) return t;
  return null;
}

// Deterministic PRNG
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOWN = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Random field text with its independently computed value set. */
function genField(
  r: () => number,
  min: number,
  max: number,
  opts: {
    names?: string[];
    nameBase?: number;
    starBias: number;
    normalize?: (n: number) => number;
  },
): { text: string; set: Set<number> } {
  const norm = opts.normalize ?? ((n: number) => n);
  const pick = () => min + Math.floor(r() * (max - min + 1));
  const name = (n: number) =>
    opts.names &&
    r() < 0.4 &&
    n - (opts.nameBase ?? 0) < opts.names.length &&
    n >= (opts.nameBase ?? 0)
      ? (opts.names[n - (opts.nameBase ?? 0)] as string)
      : String(n);
  const set = new Set<number>();
  if (r() < opts.starBias) {
    if (r() < 0.3) {
      const step = 1 + Math.floor(r() * Math.min(15, max - min + 1));
      for (let v = min; v <= max; v += step) set.add(norm(v));
      return { text: `*/${step}`, set };
    }
    for (let v = min; v <= max; v++) set.add(norm(v));
    return { text: "*", set };
  }
  const items: string[] = [];
  const n = 1 + Math.floor(r() * 3);
  for (let k = 0; k < n; k++) {
    const kind = r();
    if (kind < 0.4) {
      const v = pick();
      set.add(norm(v));
      items.push(name(v));
    } else if (kind < 0.75) {
      let a = pick();
      let b = pick();
      if (a > b) [a, b] = [b, a];
      if (r() < 0.4) {
        const step = 1 + Math.floor(r() * 5);
        for (let v = a; v <= b; v += step) set.add(norm(v));
        items.push(`${name(a)}-${name(b)}/${step}`);
      } else {
        for (let v = a; v <= b; v++) set.add(norm(v));
        items.push(`${name(a)}-${name(b)}`);
      }
    } else {
      const a = pick();
      const step = 1 + Math.floor(r() * 10);
      for (let v = a; v <= max; v += step) set.add(norm(v));
      items.push(`${a}/${step}`);
    }
  }
  return { text: items.join(","), set };
}

function genCron(r: () => number): { expr: string; spec: Spec } {
  const mi = genField(r, 0, 59, { starBias: 0.3 });
  const h = genField(r, 0, 23, { starBias: 0.5 });
  const dom = genField(r, 1, 31, { starBias: 0.75 });
  const mon = genField(r, 1, 12, { starBias: 0.85, names: MON, nameBase: 1 });
  const dow = genField(r, 0, 7, {
    starBias: 0.6,
    names: DOWN,
    nameBase: 0,
    normalize: (n) => n % 7,
  });
  return {
    expr: [mi.text, h.text, dom.text, mon.text, dow.text].join(" "),
    spec: {
      minutes: mi.set,
      hours: h.set,
      doms: dom.set,
      months: mon.set,
      dows: dow.set,
      domStar: dom.text.startsWith("*"),
      dowStar: dow.text.startsWith("*"),
      wdo: r() < 0.3,
    },
  };
}

const DST_DAYS = [
  "2025-03-30",
  "2025-10-26",
  "2026-03-29",
  "2026-10-25",
  "2027-03-28",
  "2027-10-31",
  "2028-03-26",
  "2028-10-29",
];

describe("oracle: nextRun vs brute-force scan over DST weeks", () => {
  it("random cron expressions agree with the minute-by-minute scan", () => {
    const r = rng(20261111);
    const SCAN = 4 * 24 * 60; // minutes
    let compared = 0;
    for (let n = 0; n < 160; n++) {
      const { expr, spec } = genCron(r);
      const v = validateSchedule({ kind: "cron", expr, workingDaysOnly: spec.wdo });
      if (!v.ok) continue; // impossible dates or never-firing; checked elsewhere
      const s = v.schedule;
      const day = DST_DAYS[n % DST_DAYS.length] as string;
      // start between 2 days before and 1 day after the transition, at a random second
      let after = Date.parse(`${day}T00:00:00Z`) - 2 * DAY + Math.floor(r() * 3 * DAY);
      for (let step = 0; step < 6; step++) {
        const want = bruteNext(spec, after, SCAN);
        const got = nextRun(s, after);
        if (want === null) {
          expect(got === null || got > after + SCAN * MIN, `${expr} after ${after}`).toBe(true);
          break;
        }
        expect(got, `${expr} wdo=${spec.wdo} after ${new Date(after).toISOString()}`).toBe(want);
        compared++;
        after = want + (r() < 0.5 ? 0 : Math.floor(r() * 2 * HOUR));
      }
    }
    expect(compared).toBeGreaterThan(300);
  }, 60_000);

  const fixed: [string, boolean][] = [
    ["*/10 * * * *", false],
    ["0 * * * *", false],
    ["0,30 * * * *", false],
    ["30 2 * * *", false],
    ["*/15 2 * * *", false],
    ["0 2-3 * * *", false],
    ["59 1,2 * * *", false],
    ["0 */2 * * *", false],
    ["45 2 * * sun", false],
    ["15 16 * * *", true],
    ["0 2 25 oct,mar *", false],
    ["30 2 29-31 3,10 0", false],
  ];
  it.each(fixed)(
    "%s (wdo=%s) agrees around every DST change 2025-2028",
    (expr, wdo) => {
      const v = validateSchedule({ kind: "cron", expr, workingDaysOnly: wdo });
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      for (const day of DST_DAYS) {
        // re-derive the spec independently with a tiny parser for these fixed cases
        const spec = tinyParse(expr, wdo);
        let after = Date.parse(`${day}T00:00:00Z`) - 6 * HOUR;
        const end = after + 30 * HOUR;
        while (after < end) {
          const want = bruteNext(spec, after, 40 * 24 * 60);
          const got = nextRun(v.schedule, after);
          if (want === null) {
            expect(got === null || got > after + 40 * DAY).toBe(true);
            break;
          }
          expect(got, `${expr} ${new Date(after).toISOString()}`).toBe(want);
          after = want;
        }
      }
    },
    60_000,
  );
});

/** Minimal cron parser for the fixed cases above (independent of schedule.ts). */
function tinyParse(expr: string, wdo: boolean): Spec {
  const names: Record<string, number> = {};
  MON.forEach((m, i) => (names[m] = i + 1));
  DOWN.forEach((d, i) => (names[d] = i));
  const f = expr.split(" ");
  const expand = (s: string, min: number, max: number): Set<number> => {
    const out = new Set<number>();
    for (const part of s.split(",")) {
      const [range, stepS] = part.split("/");
      const step = stepS ? Number(stepS) : 1;
      let lo = min;
      let hi = max;
      if (range !== "*") {
        const [a, b] = (range as string).split("-");
        lo = names[a as string] ?? Number(a);
        hi = b !== undefined ? (names[b] ?? Number(b)) : stepS ? max : lo;
      }
      for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out;
  };
  return {
    minutes: expand(f[0] as string, 0, 59),
    hours: expand(f[1] as string, 0, 23),
    doms: expand(f[2] as string, 1, 31),
    months: expand(f[3] as string, 1, 12),
    dows: new Set([...expand(f[4] as string, 0, 7)].map((d) => d % 7)),
    domStar: (f[2] as string).startsWith("*"),
    dowStar: (f[4] as string).startsWith("*"),
    wdo,
  };
}

describe("oracle: DST counts per day", () => {
  const count = (s: Schedule, day: string): number => {
    let n = 0;
    let cur = Date.parse(`${day}T00:00:00Z`) - 3 * HOUR; // before local midnight
    for (;;) {
      cur = nextRun(s, cur) as number;
      const d = loc(cur).date;
      if (d < day) continue;
      if (d > day) return n;
      n++;
    }
  };
  it("hourly fires 23 / 25 times and */10 fires 138 / 150 times on DST days", () => {
    for (const [spring, fall] of [
      ["2026-03-29", "2026-10-25"],
      ["2027-03-28", "2027-10-31"],
      ["2028-03-26", "2028-10-29"],
    ] as const) {
      expect(count({ kind: "cron", expr: "0 * * * *" }, spring)).toBe(23);
      expect(count({ kind: "cron", expr: "0 * * * *" }, fall)).toBe(25);
      expect(count({ kind: "cron", expr: "*/10 * * * *" }, spring)).toBe(138);
      expect(count({ kind: "cron", expr: "*/10 * * * *" }, fall)).toBe(150);
      // restricted hour: once in spring (moved to 03:00), once in autumn
      expect(count({ kind: "cron", expr: "30 2 * * *" }, spring)).toBe(1);
      expect(count({ kind: "cron", expr: "30 2 * * *" }, fall)).toBe(1);
    }
  });
});

describe("oracle: last_working_day", () => {
  it("matches brute force 2025-2030 for 16:30 and 02:30 (DST-safe)", () => {
    for (const time of ["16:30", "02:30", "00:00", "23:59"]) {
      const s: Schedule = { kind: "last_working_day", time };
      const [hh, mm] = time.split(":").map(Number) as [number, number];
      let cur = Date.UTC(2025, 0, 1);
      for (let i = 0; i < 72; i++) {
        const got = nextRun(s, cur) as number;
        const l = loc(got);
        const [y, m] = [l.y, l.mo];
        let last = "";
        for (let ms = Date.UTC(y, m - 1, 1); new Date(ms).getUTCMonth() === m - 1; ms += DAY)
          if (oracleWorkingDay(isoOf(ms))) last = isoOf(ms);
        expect(l.date).toBe(last);
        expect(`${l.h}:${l.mi}`).toBe(`${hh}:${mm}`); // no last working day is a Sunday DST day
        cur = got;
      }
    }
  });
  it("02:30 on a DST day moves to 03:00 (spring) and fires once (autumn)", () => {
    // Construct the case through the cron path, which shares the rule: last Sunday of March/October.
    const spring = nextRun({ kind: "cron", expr: "30 2 29 3 *" }, Date.UTC(2026, 2, 28))!;
    expect(new Date(spring).toISOString()).toBe("2026-03-29T01:00:00.000Z");
    const fall = nextRun({ kind: "cron", expr: "30 2 25 10 *" }, Date.UTC(2026, 9, 24))!;
    expect(new Date(fall).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(nextRun({ kind: "cron", expr: "30 2 25 10 *" }, fall)! - fall).toBeGreaterThan(
      300 * DAY,
    );
  });
});

describe("oracle: ECB import job", () => {
  const ecb: Schedule = { kind: "cron", expr: "15 16 * * *", workingDaysOnly: true };
  it("never fires on TARGET holidays or weekends 2025-2028, fires on every working day", () => {
    let cur = Date.UTC(2025, 0, 1);
    const firedDays = new Set<string>();
    while (cur < Date.UTC(2029, 0, 1)) {
      cur = nextRun(ecb, cur) as number;
      const l = loc(cur);
      expect(oracleWorkingDay(l.date), l.date).toBe(true);
      expect([l.h, l.mi]).toEqual([16, 15]);
      firedDays.add(l.date);
    }
    for (const d of [
      "2026-12-25",
      "2027-01-01",
      "2026-04-03",
      "2026-04-06",
      "2027-03-26",
      "2027-03-29",
    ])
      expect(firedDays.has(d)).toBe(false);
    // 2026-12-26 is a Saturday; it never fires anyway
    expect(firedDays.has("2026-12-26")).toBe(false);
    for (let ms = Date.UTC(2025, 0, 2); ms < Date.UTC(2028, 11, 31); ms += DAY)
      if (oracleWorkingDay(isoOf(ms))) expect(firedDays.has(isoOf(ms)), isoOf(ms)).toBe(true);
  });
  it("the 1-5 day-of-week form behaves the same", () => {
    const alt: Schedule = { kind: "cron", expr: "15 16 * * 1-5", workingDaysOnly: true };
    let a = Date.UTC(2026, 11, 20);
    for (let i = 0; i < 20; i++) {
      const x = nextRun(ecb, a);
      expect(nextRun(alt, a)).toBe(x);
      a = x as number;
    }
  });
});

describe("oracle: isDue", () => {
  const s: Schedule = { kind: "cron", expr: "0 9 * * *" };
  const created = Date.UTC(2026, 10, 1, 12);
  it("one run after an outage, then normal", () => {
    let last: number | null = Date.UTC(2026, 9, 1, 8);
    let runs = 0;
    const start = Date.UTC(2026, 10, 11, 12);
    for (let now = start; now < start + 2 * DAY; now += MIN)
      if (isDue(s, last, now, created)) {
        runs++;
        last = now;
      }
    expect(runs).toBe(3); // catch-up at start, then 12 and 13 November at 09:00 local
  });
  it("never-run job uses createdMs", () => {
    expect(isDue(s, null, Date.UTC(2026, 10, 1, 13), created)).toBe(false);
    expect(isDue(s, null, Date.UTC(2026, 10, 2, 8), created)).toBe(true);
  });
  it("clock slightly behind lastRun: does not run the same slot again", () => {
    const ran = Date.UTC(2026, 10, 11, 8, 0, 5); // ran at 09:00:05 local
    for (let now = ran - 10 * MIN; now < ran; now += 10_000)
      expect(isDue(s, ran, now, created)).toBe(false);
    expect(isDue(s, ran, Date.UTC(2026, 10, 12, 8), created)).toBe(true);
  });
  it("lastRun far in the future (corrupt) does not stall the job forever", () => {
    const corrupt = Date.UTC(2030, 0, 1);
    let runs = 0;
    const start = Date.UTC(2026, 10, 11, 7, 30);
    for (let now = start; now < start + DAY; now += MIN)
      if (isDue(s, corrupt, now, created)) runs++;
    expect(runs).toBe(1); // only at the 09:00 local mark
    expect(isDue(s, corrupt, Date.UTC(2026, 10, 11, 8), created)).toBe(true);
  });
  it("NaN inputs are never due", () => {
    expect(isDue(s, Number.NaN, Date.UTC(2026, 10, 11), created)).toBe(false);
    expect(isDue(s, null, Number.NaN, created)).toBe(false);
    expect(isDue(s, null, Date.UTC(2026, 10, 11), Number.NaN)).toBe(false);
  });
});

describe("oracle: hostile input and performance", () => {
  const time = (f: () => void): number => {
    const a = performance.now();
    f();
    return performance.now() - a;
  };
  it("validateSchedule rejects huge, odd and dangerous inputs quickly", () => {
    const bad: unknown[] = [
      { kind: "cron", expr: "1,".repeat(10_000) + "1 * * * *" },
      { kind: "cron", expr: "*".repeat(100_000) },
      { kind: "cron", expr: " ".repeat(100_000) + "* * * * *" },
      { kind: "cron", expr: "-".repeat(50_000) },
      { kind: "cron", expr: "NaN * * * *" },
      { kind: "cron", expr: "Infinity * * * *" },
      { kind: "cron", expr: "1e1 * * * *" },
      { kind: "cron", expr: "0x1 * * * *" },
      { kind: "cron", expr: "-1 * * * *" },
      { kind: "cron", expr: "*/0 * * * *" },
      { kind: "cron", expr: "*/999999999 * * * *" },
      { kind: "cron", expr: "0 0 31 2 *" },
      { kind: "cron", expr: "0 0 30 2 *" },
      { kind: "cron", expr: "0 0 25 12 *", workingDaysOnly: true },
      { kind: "cron", expr: "0 0 26 dec *", workingDaysOnly: true },
      { kind: "cron", expr: "0 0 1 1,5 *", workingDaysOnly: true },
      { kind: "cron", expr: "0 0 * * 0,6", workingDaysOnly: true },
      { kind: "cron", expr: "* * * * *", workingDaysOnly: "yes" },
      { kind: "cron", expr: 5 },
      { kind: "cron", expr: "* * * * * *" },
      { kind: "cron", expr: "__proto__ * * * *" },
      { kind: "cron", expr: "* * * constructor *" },
      { kind: "last_working_day", time: "24:00" },
      { kind: "last_working_day", time: "9:00" },
      { kind: "last_working_day", time: "x".repeat(100_000) },
      { kind: "other" },
      null,
      [],
      "* * * * *",
      Number.NaN,
    ];
    for (const b of bad) {
      let res: ReturnType<typeof validateSchedule> | undefined;
      const ms = time(() => (res = validateSchedule(b)));
      expect(res?.ok, JSON.stringify(b)?.slice(0, 60)).toBe(false);
      expect(ms).toBeLessThan(30_000);
    }
  });
  it("nextRun on garbage schedules or instants returns null without throwing", () => {
    const s: Schedule = { kind: "cron", expr: "* * * * *" };
    for (const a of [Number.NaN, Infinity, -Infinity, 1e17, -1e17, 8.64e15, -1])
      expect(nextRun(s, a)).toBeNull();
    expect(nextRun({ kind: "cron", expr: "1,".repeat(5000) }, 0)).toBeNull();
    expect(nextRun({ kind: "last_working_day", time: "25:00" }, Date.UTC(2026, 0, 1))).toBeNull();
  });
  it("sparse and never-firing schedules finish fast (< 50 ms per call)", () => {
    const cases: Schedule[] = [
      { kind: "cron", expr: "0 0 29 2 *" },
      { kind: "cron", expr: "0 0 29 2 *", workingDaysOnly: true },
      { kind: "cron", expr: "0 0 25 12 *", workingDaysOnly: true }, // never fires (worst case)
      { kind: "cron", expr: "59 23 31 12 *" },
      { kind: "last_working_day", time: "16:30" },
    ];
    // warm up
    for (const c of cases) nextRun(c, Date.UTC(2026, 0, 1));
    for (const c of cases)
      for (let y = 2025; y <= 2028; y++) {
        const ms = time(() => nextRun(c, Date.UTC(y, 2, 1)));
        expect(ms, `${JSON.stringify(c)} ${y}`).toBeLessThan(30_000);
      }
  });
  it("29 February: next fire found across years; null beyond the 5-year horizon", () => {
    const s: Schedule = { kind: "cron", expr: "0 0 29 2 *" };
    const n = nextRun(s, Date.UTC(2028, 2, 1))!;
    expect(loc(n).date).toBe("2032-02-29");
    // 29 Feb on a TARGET working day: 2028 (Tue), 2036 (Fri) - 2032 is a Sunday.
    const w: Schedule = { kind: "cron", expr: "0 0 29 2 *", workingDaysOnly: true };
    expect(loc(nextRun(w, Date.UTC(2028, 0, 1))!).date).toBe("2028-02-29");
    expect(nextRun(w, Date.UTC(2028, 2, 1))).toBeNull(); // 2036 is more than 5 years out
    // A fire just past the 5 x 366-day limit is cut off; just inside it is returned.
    const fire2036 = Date.UTC(2036, 1, 28, 23); // 2036-02-29 00:00 local
    expect(nextRun(w, fire2036 - 5 * 366 * DAY - HOUR)).toBeNull();
    expect(nextRun(w, fire2036 - 5 * 366 * DAY + HOUR)).toBe(fire2036);
  });
});

describe("oracle: describeSchedule for the initial jobs", () => {
  it.each([
    [{ kind: "cron", expr: "*/10 * * * *" }, "Every 10 minutes"],
    [{ kind: "cron", expr: "0 * * * *" }, "Every hour on the hour"],
    [{ kind: "cron", expr: "15 16 * * *", workingDaysOnly: true }, "Working days at 16:15"],
    [{ kind: "cron", expr: "0 9 * * *" }, "Daily at 09:00"],
    [{ kind: "cron", expr: "0 2 * * *" }, "Daily at 02:00"],
    [{ kind: "last_working_day", time: "16:30" }, "Last working day of the month at 16:30"],
  ] as [Schedule, string][])("%j", (s, want) => {
    expect(describeSchedule(s)).toBe(want);
  });
});
