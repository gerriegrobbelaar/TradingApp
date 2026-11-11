import { describe, expect, it } from "vitest";
import { amsterdamParts } from "./local-time";
import { analyseSchedule, dueSlot, isDue, nextRun, type Schedule } from "./schedule";
import {
  checkScheduleRules,
  GLOBAL_MIN_INTERVAL_MINUTES,
  projectedExactCalls,
  type ScheduleRules,
} from "./schedule-rules";

const cron = (expr: string, workingDaysOnly?: boolean): Schedule =>
  workingDaysOnly === undefined ? { kind: "cron", expr } : { kind: "cron", expr, workingDaysOnly };
const t = (s: string): number => Date.parse(s);

describe("dueSlot", () => {
  const s = cron("0 9 * * *");
  const created = t("2026-11-01T12:00:00Z");
  it("returns the slot that isDue is true for, and null otherwise", () => {
    expect(dueSlot(s, null, t("2026-11-02T07:59:59Z"), created)).toBeNull();
    expect(dueSlot(s, null, t("2026-11-02T08:00:00Z"), created)).toBe(t("2026-11-02T08:00:00Z"));
    expect(dueSlot(s, null, t("2026-11-11T12:00:00Z"), created)).toBe(t("2026-11-02T08:00:00Z"));
  });
  it("isDue and dueSlot agree for every minute of a day and several baselines", () => {
    for (const last of [null, t("2026-11-10T08:00:00Z"), t("2026-11-11T07:00:00Z")]) {
      for (let now = t("2026-11-11T00:00:00Z"); now < t("2026-11-12T00:00:00Z"); now += 60_000) {
        expect(isDue(s, last, now, created)).toBe(dueSlot(s, last, now, created) !== null);
      }
    }
  });
  it("corrupt clock: a baseline more than a day ahead uses the minute ending now", () => {
    const every10 = cron("*/10 * * * *");
    const now = t("2026-11-11T12:10:00Z");
    const slot = dueSlot(every10, now + 3 * 86_400_000, now, created);
    expect(slot).toBe(now);
    // Within a day ahead it waits instead.
    expect(dueSlot(every10, now + 3_600_000, now, created)).toBeNull();
  });
  it("is null for a non-finite clock or an invalid schedule", () => {
    expect(dueSlot(s, null, Number.NaN, created)).toBeNull();
    expect(dueSlot(cron("bad"), null, t("2026-11-11T12:00:00Z"), created)).toBeNull();
  });
});

describe("analyseSchedule", () => {
  it("counts 25 fires on the autumn day for an hourly cron, 24 at most otherwise... and 23 in spring", () => {
    const a = analyseSchedule(cron("30 * * * *"));
    expect(a).toEqual({ maxFiresPerDay: 25, minGapMinutes: 60, maxGapMinutes: 60 });
  });
  it("matches a count of real nextRun fires on 2026-10-25 (25 hours)", () => {
    const s = cron("*/10 * * * *");
    let n = 0;
    let at = t("2026-10-24T22:00:00Z"); // 00:00 Amsterdam on the 25th (CEST)
    for (;;) {
      const f = nextRun(s, at - 1);
      if (f === null || amsterdamParts(f).date !== "2026-10-25") break;
      n++;
      at = f + 1;
    }
    expect(n).toBe(150);
    expect(analyseSchedule(s)).toMatchObject({ maxFiresPerDay: 150, minGapMinutes: 10 });
  });
  it("working days only never exceeds the weekday count and skips holidays", () => {
    expect(analyseSchedule(cron("15 16 * * *", true))).toEqual({
      maxFiresPerDay: 1,
      minGapMinutes: 24 * 60,
      maxGapMinutes: 5 * 24 * 60,
    });
  });
  it("handles last_working_day (monthly) and returns null for bad or never-firing schedules", () => {
    const a = analyseSchedule({ kind: "last_working_day", time: "16:30" });
    expect(a?.maxFiresPerDay).toBe(1);
    expect(a?.minGapMinutes).toBeGreaterThan(27 * 24 * 60);
    expect(analyseSchedule(cron("bad"))).toBeNull();
    expect(analyseSchedule(cron("0 0 25 12 *", true))).toBeNull();
  });
  it("a single fire has no gaps", () => {
    expect(analyseSchedule(cron("0 9 1 6 *"))).toEqual({
      maxFiresPerDay: 1,
      minGapMinutes: null,
      maxGapMinutes: null,
    });
  });
  it("sees gaps across midnight", () => {
    // 23:00, 23:58 and 00:00, 00:58: the closest pair is 23:58 -> 00:00.
    expect(analyseSchedule(cron("0,58 23,0 * * *"))?.minGapMinutes).toBe(2);
  });
});

describe("checkScheduleRules", () => {
  it("refuses every minute for any job, even without rules", () => {
    expect(checkScheduleRules(cron("* * * * *"), undefined)).toMatch(/more often than every 5/);
    expect(checkScheduleRules(cron("*/2 * * * *"), {})).not.toBeNull();
    expect(checkScheduleRules(cron(`*/${GLOBAL_MIN_INTERVAL_MINUTES} * * * *`), {})).toBeNull();
  });
  it("honours a handler minimum", () => {
    const rules: ScheduleRules = { minIntervalMinutes: 30 };
    expect(checkScheduleRules(cron("*/10 * * * *"), rules)).toMatch(/every 30 minutes/);
    expect(checkScheduleRules(cron("0,30 * * * *"), rules)).toBeNull();
  });
  it("allowedIntervalMinutes demands a continuous 5 to 15 minute rhythm", () => {
    const rules: ScheduleRules = { allowedIntervalMinutes: [5, 15] };
    expect(checkScheduleRules(cron("*/10 * * * *"), rules)).toBeNull();
    expect(checkScheduleRules(cron("*/5 * * * *"), rules)).toBeNull();
    expect(checkScheduleRules(cron("*/15 * * * *"), rules)).toBeNull();
    expect(checkScheduleRules(cron("*/20 * * * *"), rules)).toMatch(/5 to 15 minutes/);
    expect(checkScheduleRules(cron("*/10 8-18 * * *"), rules)).toMatch(/gaps of/);
    expect(checkScheduleRules(cron("0 9 1 6 *"), rules)).toMatch(/all day/);
  });
  it("workingDaysOnly is required when asked", () => {
    const rules: ScheduleRules = { workingDaysOnly: true };
    expect(checkScheduleRules(cron("15 16 * * *"), rules)).toMatch(/working days/);
    expect(checkScheduleRules({ kind: "last_working_day", time: "16:30" }, rules)).toMatch(
      /working days/,
    );
    expect(checkScheduleRules(cron("15 16 * * *", true), rules)).toBeNull();
  });
  it("lets an unparsable schedule through (validateSchedule reports it)", () => {
    expect(checkScheduleRules(cron("bad"), {})).toBeNull();
  });
});

describe("projectedExactCalls", () => {
  it("multiplies real fires per day by budget and attempts", () => {
    expect(
      projectedExactCalls([
        { schedule: cron("0 2 * * *"), budget: 240, maxAttempts: 4 },
        { schedule: cron("30 * * * *"), budget: 40, maxAttempts: 1 },
      ]),
    ).toBe(1960);
  });
  it("is zero for no jobs and ignores never-firing schedules", () => {
    expect(projectedExactCalls([])).toBe(0);
    expect(projectedExactCalls([{ schedule: cron("bad"), budget: 10, maxAttempts: 1 }])).toBe(0);
  });
});
