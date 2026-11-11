/**
 * Staleness of the newest ECB rate (task F2, ADR 0035): the matrix of weekday x time x newest date.
 */
import { amsterdamParts, isTargetWorkingDay, previousTargetWorkingDay } from "@camelthorn/core";
import { describe, expect, it } from "vitest";
import { expectedNewestRateDate, fxStaleness } from "../src/fx/staleness";

/** Amsterdam wall clock to epoch ms (valid for the dates used: none sits in a DST gap). */
function at(date: string, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  for (const offset of [1, 2]) {
    const ms = Date.parse(`${date}T00:00:00Z`) + (h - offset) * 3_600_000 + m * 60_000;
    const p = amsterdamParts(ms);
    if (p.date === date && p.hour === h && p.minute === m) return ms;
  }
  throw new Error(`no such local time ${date} ${hhmm}`);
}

const stale = (newest: string | null, date: string, hhmm: string) =>
  fxStaleness(newest, at(date, hhmm)).stale;

describe("fxStaleness: named cases", () => {
  it("empty table: stale, never_imported, age unknown", () => {
    expect(fxStaleness(null, at("2026-11-10", "12:00"))).toEqual({
      stale: true,
      staleReason: "never_imported",
      workingDaysOld: null,
    });
  });

  it("Monday morning before publication with Friday as the newest is NOT stale", () => {
    expect(fxStaleness("2026-11-06", at("2026-11-09", "09:00"))).toEqual({
      stale: false,
      staleReason: null,
      workingDaysOld: 1,
    });
    expect(stale("2026-11-06", "2026-11-09", "17:30")).toBe(false);
  });

  it("Monday after 17:30 with Friday as the newest is stale", () => {
    expect(fxStaleness("2026-11-06", at("2026-11-09", "17:31"))).toEqual({
      stale: true,
      staleReason: "older_than_one_working_day",
      workingDaysOld: 1,
    });
  });

  it("Tuesday 18:00 with Monday as the newest is stale; Tuesday 18:00 with Tuesday is not", () => {
    expect(stale("2026-11-09", "2026-11-10", "18:00")).toBe(true);
    expect(stale("2026-11-10", "2026-11-10", "18:00")).toBe(false);
  });

  it("the 17:30 boundary: up to and including 17:30 still expects yesterday's rate", () => {
    expect(stale("2026-11-09", "2026-11-10", "17:30")).toBe(false);
    expect(stale("2026-11-09", "2026-11-10", "17:31")).toBe(true);
    expect(stale("2026-11-09", "2026-11-10", "16:14")).toBe(false);
  });

  it("two working days old is stale at any time of day", () => {
    for (const t of ["00:00", "09:00", "17:30", "23:59"]) {
      expect(stale("2026-11-09", "2026-11-11", t), t).toBe(true);
    }
  });

  it("weekends: Friday's rate is fine all weekend, Thursday's is not", () => {
    for (const d of ["2026-11-07", "2026-11-08"]) {
      expect(stale("2026-11-06", d, "23:59")).toBe(false);
      expect(stale("2026-11-05", d, "08:00")).toBe(true);
    }
  });

  it("TARGET holidays: Good Friday 2026-04-03 and Easter Monday 2026-04-06", () => {
    // Thursday's rate on Good Friday, Saturday, Sunday, Easter Monday, Tuesday morning: fine.
    for (const [d, t] of [
      ["2026-04-03", "20:00"],
      ["2026-04-04", "12:00"],
      ["2026-04-05", "12:00"],
      ["2026-04-06", "20:00"],
      ["2026-04-07", "10:00"],
    ] as const) {
      expect(stale("2026-04-02", d, t), `${d} ${t}`).toBe(false);
    }
    // Tuesday after 17:30 expects Tuesday's rate; Wednesday morning expects Tuesday's.
    expect(stale("2026-04-02", "2026-04-07", "18:00")).toBe(true);
    expect(stale("2026-04-02", "2026-04-08", "09:00")).toBe(true);
    // Age counts working days: Thursday to Tuesday is 1.
    expect(fxStaleness("2026-04-02", at("2026-04-07", "10:00")).workingDaysOld).toBe(1);
    // 25 and 26 December 2026 (Friday and Saturday), 1 January 2027 (Friday).
    expect(stale("2026-12-24", "2026-12-28", "10:00")).toBe(false);
    expect(stale("2026-12-24", "2026-12-28", "18:00")).toBe(true);
    expect(stale("2026-12-31", "2027-01-04", "10:00")).toBe(false);
  });

  it("daylight saving days use local time for 17:30", () => {
    // Monday 30 March 2026 (CEST): 17:30 local is 15:30 UTC.
    expect(stale("2026-03-27", "2026-03-30", "17:30")).toBe(false);
    expect(stale("2026-03-27", "2026-03-30", "17:31")).toBe(true);
    // Monday 26 October 2026 (CET): 17:30 local is 16:30 UTC.
    expect(stale("2026-10-23", "2026-10-26", "17:30")).toBe(false);
    expect(stale("2026-10-23", "2026-10-26", "17:31")).toBe(true);
  });
});

describe("fxStaleness: the whole matrix", () => {
  const days: string[] = [];
  for (
    let d = Date.parse("2026-03-25T00:00:00Z");
    d <= Date.parse("2026-04-12T00:00:00Z");
    d += 86_400_000
  ) {
    days.push(new Date(d).toISOString().slice(0, 10));
  }
  const times = ["00:00", "09:00", "16:15", "17:30", "17:31", "23:59"];

  it("matches the written definition for every day, time and newest date", () => {
    for (const day of days) {
      for (const t of times) {
        const after = t > "17:30";
        const working = isTargetWorkingDay(day);
        // The written rule, spelled out independently of the implementation.
        const expected = working && after ? day : previousTargetWorkingDay(day);
        for (const newest of days.filter((d) => d <= day)) {
          const s = fxStaleness(newest, at(day, t));
          expect(s.stale, `${day} ${t} newest ${newest}`).toBe(newest < expected);
          expect(s.staleReason).toBe(s.stale ? "older_than_one_working_day" : null);
          expect(s.workingDaysOld).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("a rate dated today is never stale; staleness only grows with age", () => {
    for (const day of days) {
      for (const t of times) {
        if (isTargetWorkingDay(day)) expect(stale(day, day, t), `${day} ${t}`).toBe(false);
        let wasStale = false;
        for (const newest of [...days.filter((d) => d <= day)].reverse()) {
          const s = stale(newest, day, t);
          if (wasStale) expect(s, `${day} ${t} ${newest}`).toBe(true);
          wasStale = s;
        }
      }
    }
  });

  it("expectedNewestRateDate is always a TARGET working day", () => {
    for (const day of days) {
      for (const t of times)
        expect(isTargetWorkingDay(expectedNewestRateDate(at(day, t)))).toBe(true);
    }
  });
});
