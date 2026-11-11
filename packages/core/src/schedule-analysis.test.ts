/**
 * J1 review: the catch-up slot is the latest missed fire, and analyseSchedule (fast path for
 * ordinary days) agrees with counting real nextRun fires.
 */
import { describe, expect, it } from "vitest";
import { amsterdamParts } from "./local-time";
import { ANALYSIS_DAYS, analyseSchedule, dueSlot, nextRun, type Schedule } from "./schedule";
import { checkScheduleRules, projectedExactCalls } from "./schedule-rules";

const cron = (expr: string, workingDaysOnly?: boolean): Schedule =>
  workingDaysOnly === undefined ? { kind: "cron", expr } : { kind: "cron", expr, workingDaysOnly };
const t = (s: string): number => Date.parse(s);
const DAY = 86_400_000;

describe("dueSlot picks the latest missed slot", () => {
  const created = t("2026-01-01T00:00:00Z");

  it("no missed slot: the one due fire", () => {
    const s = cron("30 * * * *");
    expect(dueSlot(s, t("2026-11-11T09:00:00Z"), t("2026-11-11T09:31:00Z"), created)).toBe(
      t("2026-11-11T09:30:00Z"),
    );
  });

  it("an hourly job after a 3-hour outage claims the last hour, not the first", () => {
    const s = cron("30 * * * *");
    expect(dueSlot(s, t("2026-11-11T06:00:00Z"), t("2026-11-11T09:35:00Z"), created)).toBe(
      t("2026-11-11T09:30:00Z"),
    );
  });

  it("a daily job after three days claims today's slot", () => {
    const s = cron("0 2 * * *");
    // 02:00 Amsterdam (CET) = 01:00 UTC.
    expect(dueSlot(s, t("2026-11-07T12:00:00Z"), t("2026-11-11T03:00:00Z"), created)).toBe(
      t("2026-11-11T01:00:00Z"),
    );
  });

  it("a month-end job caught up days later claims the previous month-end", () => {
    const s: Schedule = { kind: "last_working_day", time: "16:30" };
    // Baseline before the October slot (Friday 30 October 2026, 16:30 CET = 15:30 UTC); now 3 November.
    const slot = dueSlot(s, t("2026-10-20T00:00:00Z"), t("2026-11-03T10:00:00Z"), created);
    expect(slot).toBe(t("2026-10-30T15:30:00Z"));
    expect(amsterdamParts(slot as number).date.slice(0, 7)).toBe("2026-10");
    // Missed two month-ends: the latest (November) wins.
    const later = dueSlot(s, t("2026-10-20T00:00:00Z"), t("2026-12-02T10:00:00Z"), created);
    expect(amsterdamParts(later as number).date.slice(0, 7)).toBe("2026-11");
  });

  it("works from every search window (minutes, days, weeks, months, a year, the reference)", () => {
    const every5 = cron("*/5 * * * *");
    const now = t("2026-11-11T09:37:00Z");
    expect(dueSlot(every5, now - 3 * DAY, now, created)).toBe(t("2026-11-11T09:35:00Z"));
    const weekly = cron("0 9 * * 1"); // Mondays 09:00 Amsterdam
    expect(dueSlot(weekly, now - 40 * DAY, now, created)).toBe(t("2026-11-09T08:00:00Z"));
    const yearly = cron("0 9 1 6 *");
    expect(dueSlot(yearly, t("2026-01-01T00:00:00Z"), t("2027-07-01T00:00:00Z"), created)).toBe(
      t("2027-06-01T07:00:00Z"),
    );
    const leap = cron("0 9 29 2 *");
    expect(dueSlot(leap, t("2026-01-01T00:00:00Z"), t("2029-06-01T00:00:00Z"), created)).toBe(
      t("2028-02-29T08:00:00Z"),
    );
  });

  it("a slot in a weekend gap is found across the day window", () => {
    const s = cron("15 16 * * *", true);
    // Friday 13 November 16:15 is the last fire before Monday 08:00 (UTC+1).
    expect(dueSlot(s, t("2026-11-10T00:00:00Z"), t("2026-11-16T07:00:00Z"), created)).toBe(
      t("2026-11-13T15:15:00Z"),
    );
  });

  it("is fast even for a dense schedule after a long outage", () => {
    const s = cron("*/5 * * * *");
    const now = t("2026-11-11T09:37:00Z");
    const start = performance.now();
    for (let i = 0; i < 20; i++) dueSlot(s, now - 300 * DAY, now, created);
    expect((performance.now() - start) / 20).toBeLessThan(1000);
  });
});

/** Every fire in the analysis window, by stepping nextRun (the oracle). */
function oracle(s: Schedule) {
  const start = t("2026-01-01T00:00:00+01:00");
  const end = start + ANALYSIS_DAYS * DAY;
  const perDay = new Map<string, number>();
  let prev: number | null = null;
  let minGap = Infinity;
  let maxGap = 0;
  for (let f = nextRun(s, start - 1); f !== null && f < end; f = nextRun(s, f)) {
    const d = amsterdamParts(f).date;
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
    if (prev !== null) {
      minGap = Math.min(minGap, f - prev);
      maxGap = Math.max(maxGap, f - prev);
    }
    prev = f;
  }
  return {
    maxFiresPerDay: Math.max(0, ...perDay.values()),
    minGapMinutes: minGap === Infinity ? null : minGap / 60_000,
    maxGapMinutes: minGap === Infinity ? null : maxGap / 60_000,
  };
}

describe("analyseSchedule equals counting real nextRun fires", () => {
  for (const s of [
    cron("30 2 * * *"),
    cron("0,30 2 * * *"),
    cron("*/30 1-3 * * *"),
    cron("0 * * * 0"),
    cron("15 16 * * *", true),
    cron("0 9 29 2 *"),
    cron("0 9 1 * 5"),
    cron("59 23 * * *"),
    { kind: "last_working_day", time: "02:30" } as Schedule,
  ]) {
    it(JSON.stringify(s), () => {
      expect(analyseSchedule(s)).toEqual(oracle(s));
    });
  }

  it("sees the leap day, so a 29 February schedule is counted, not ignored", () => {
    const leapOnly = cron("*/5 * 29 2 *");
    expect(analyseSchedule(leapOnly)?.maxFiresPerDay).toBe(288);
    expect(projectedExactCalls([{ schedule: leapOnly, budget: 40, maxAttempts: 1 }])).toBe(
      288 * 40,
    );
  });

  it("equivalent spellings of every minute are all refused", () => {
    for (const expr of [
      "* * * * *",
      "*/1 * * * *",
      "0-59 * * * *",
      "0,1,2,3,4 * * * *",
      "0-59/1 0-23 * * *",
      "0,4 * * * *",
      "* 3 * * *",
    ]) {
      expect(checkScheduleRules(cron(expr), undefined), expr).toMatch(/more often than every 5/);
    }
  });

  it("an every-minute cron is analysed quickly (runaway-loop guard, not a benchmark)", () => {
    const s = cron("* * * * *");
    analyseSchedule(s);
    const start = performance.now();
    for (let i = 0; i < 5; i++) analyseSchedule(s);
    expect((performance.now() - start) / 5).toBeLessThan(1000);
  });
});

describe("rule sentences", () => {
  it("formatInterval reads naturally", async () => {
    const { formatInterval } = await import("./schedule-rules");
    expect([1, 5, 2.5, 60, 120, 1440, 2880].map(formatInterval)).toEqual([
      "1 minute",
      "5 minutes",
      "2.5 minutes",
      "hour",
      "2 hours",
      "day",
      "2 days",
    ]);
  });
  it("describeScheduleRules states the same limits checkScheduleRules enforces", async () => {
    const { describeScheduleRules } = await import("./schedule-rules");
    expect(describeScheduleRules(undefined)).toBe("It cannot run more often than every 5 minutes.");
    expect(describeScheduleRules({ minIntervalMinutes: 1440 })).toBe(
      "It cannot run more often than every day.",
    );
    expect(describeScheduleRules({ allowedIntervalMinutes: [5, 15] })).toBe(
      "It must run every 5 to 15 minutes, all day.",
    );
    expect(describeScheduleRules({ workingDaysOnly: true, minIntervalMinutes: 60 })).toBe(
      "It cannot run more often than every hour. It runs on working days only.",
    );
    // A whole-day minimum cannot be met by a daily cron: the spring day is 23 hours long.
    expect(checkScheduleRules(cron("0 9 * * *"), { minIntervalMinutes: 1440 })).toMatch(
      /23 hours apart/,
    );
    // 12 hours refuses twice a day 8 hours apart and allows daily and monthly.
    const twelve = { minIntervalMinutes: 720 };
    expect(checkScheduleRules(cron("0 9,17 * * *"), twelve)).toMatch(
      /every 12 hours\. This schedule runs 8 hours apart/,
    );
    expect(checkScheduleRules(cron("0 9 * * *"), twelve)).toBeNull();
    expect(checkScheduleRules({ kind: "last_working_day", time: "16:30" }, twelve)).toBeNull();
  });
});
