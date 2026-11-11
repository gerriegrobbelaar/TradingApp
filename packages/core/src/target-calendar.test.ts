import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  dayOfWeekIso,
  easterSunday,
  isTargetHoliday,
  isTargetWorkingDay,
  lastTargetWorkingDay,
  previousTargetWorkingDay,
  targetWorkingDaysBetween,
} from "./target-calendar";

describe("easterSunday", () => {
  const known: [number, string][] = [
    [2000, "2000-04-23"],
    [2011, "2011-04-24"],
    [2019, "2019-04-21"],
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2028, "2028-04-16"],
    [2029, "2029-04-01"],
    [2030, "2030-04-21"],
    [2031, "2031-04-13"],
    [2032, "2032-03-28"],
    [2038, "2038-04-25"],
    [2100, "2100-03-28"],
  ];
  it.each(known)("Easter %i is %s", (y, iso) => {
    expect(easterSunday(y)).toBe(iso);
    expect(dayOfWeekIso(iso)).toBe(0);
  });
});

describe("holidays and working days", () => {
  it("knows the TARGET closing days", () => {
    for (const d of [
      "2026-01-01",
      "2026-04-03",
      "2026-04-06",
      "2026-05-01",
      "2026-12-25",
      "2026-12-26",
    ]) {
      expect(isTargetHoliday(d)).toBe(true);
    }
    expect(isTargetHoliday("2026-04-04")).toBe(false);
    expect(isTargetHoliday("2026-04-27")).toBe(false); // King's Day is not a TARGET holiday
    expect(isTargetHoliday("not a date")).toBe(false);
    expect(isTargetHoliday("2026-02-30")).toBe(false);
  });
  it("working day is Mon-Fri and not a holiday", () => {
    expect(isTargetWorkingDay("2026-11-11")).toBe(true); // Wednesday
    expect(isTargetWorkingDay("2026-11-14")).toBe(false); // Saturday
    expect(isTargetWorkingDay("2026-11-15")).toBe(false); // Sunday
    expect(isTargetWorkingDay("2026-04-03")).toBe(false); // Good Friday
    expect(isTargetWorkingDay("2026-04-06")).toBe(false); // Easter Monday
    expect(isTargetWorkingDay("2026-12-25")).toBe(false); // Friday
    expect(isTargetWorkingDay("garbage")).toBe(false);
  });
});

describe("date helpers", () => {
  it("adds days across month and leap boundaries", () => {
    expect(addDaysIso("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysIso("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("throws on malformed dates", () => {
    expect(() => addDaysIso("2026-13-01", 1)).toThrow(RangeError);
    expect(() => dayOfWeekIso("x")).toThrow(RangeError);
    expect(() => previousTargetWorkingDay("2026-02-30")).toThrow(RangeError);
  });
});

describe("lastTargetWorkingDay", () => {
  const cases: [number, number, string][] = [
    [2026, 12, "2026-12-31"], // Thursday
    [2026, 1, "2026-01-30"], // 31st is Saturday
    [2026, 2, "2026-02-27"],
    [2028, 2, "2028-02-29"], // leap year, Tuesday
    [2027, 2, "2027-02-26"], // 28th is Sunday
    [2026, 5, "2026-05-29"], // 31st is Sunday
    [2025, 12, "2025-12-31"], // Wednesday
    [2021, 12, "2021-12-31"], // Friday
    [2027, 4, "2027-04-30"],
    [2018, 3, "2018-03-29"], // Good Friday 30 March 2018
    [2024, 3, "2024-03-28"], // Good Friday 29th, Easter Monday 1 April, 30/31 weekend
    [2022, 4, "2022-04-29"],
  ];
  it.each(cases)("%i-%i is %s", (y, m, iso) => {
    expect(lastTargetWorkingDay(y, m)).toBe(iso);
    expect(isTargetWorkingDay(iso)).toBe(true);
  });
  it("skips a trailing 25/26 December weekend and holidays", () => {
    // 2027: 25 Dec is Saturday, 26 Dec Sunday, 31 Dec Friday is fine; check the helper on Dec 26 instead.
    expect(previousTargetWorkingDay("2027-12-27")).toBe("2027-12-24");
    expect(previousTargetWorkingDay("2026-12-28")).toBe("2026-12-24"); // 25 holiday, 26/27 weekend
  });
  it("rejects bad month", () => {
    expect(() => lastTargetWorkingDay(2026, 0)).toThrow(RangeError);
    expect(() => lastTargetWorkingDay(2026, 13)).toThrow(RangeError);
    expect(() => lastTargetWorkingDay(2026.5, 1)).toThrow(RangeError);
  });
});

describe("previousTargetWorkingDay", () => {
  it("steps over weekends and holidays", () => {
    expect(previousTargetWorkingDay("2026-11-11")).toBe("2026-11-10");
    expect(previousTargetWorkingDay("2026-11-09")).toBe("2026-11-06"); // Monday -> Friday
    expect(previousTargetWorkingDay("2026-04-07")).toBe("2026-04-02"); // after Easter Monday + Good Friday
    expect(previousTargetWorkingDay("2026-01-02")).toBe("2025-12-31");
  });
});

describe("targetWorkingDaysBetween", () => {
  it("counts working days in (from, to]", () => {
    expect(targetWorkingDaysBetween("2026-11-10", "2026-11-10")).toBe(0);
    expect(targetWorkingDaysBetween("2026-11-10", "2026-11-11")).toBe(1);
    expect(targetWorkingDaysBetween("2026-11-06", "2026-11-09")).toBe(1); // Fri -> Mon
    expect(targetWorkingDaysBetween("2026-11-06", "2026-11-08")).toBe(0); // Fri -> Sun
    expect(targetWorkingDaysBetween("2026-04-02", "2026-04-07")).toBe(1); // over Easter: only Tuesday
    expect(targetWorkingDaysBetween("2026-11-02", "2026-11-09")).toBe(5);
  });
  it("is negative when reversed", () => {
    expect(targetWorkingDaysBetween("2026-11-11", "2026-11-09")).toBe(-2);
  });
});
