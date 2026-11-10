import { describe, expect, it } from "vitest";
import { AMSTERDAM, amsterdamDate, amsterdamParts } from "./local-time";

describe("amsterdamParts", () => {
  it("uses CET in winter and CEST in summer", () => {
    expect(amsterdamParts(Date.UTC(2026, 0, 15, 11, 30))).toEqual({
      date: "2026-01-15",
      hour: 12,
      minute: 30,
    });
    expect(amsterdamParts(Date.UTC(2026, 6, 15, 11, 30))).toEqual({
      date: "2026-07-15",
      hour: 13,
      minute: 30,
    });
  });

  it("moves to the next calendar day after 22:00 or 23:00 UTC", () => {
    expect(amsterdamParts(Date.UTC(2026, 0, 15, 23, 5)).date).toBe("2026-01-16");
    expect(amsterdamParts(Date.UTC(2026, 6, 15, 22, 5)).date).toBe("2026-07-16");
    expect(amsterdamParts(Date.UTC(2026, 6, 15, 21, 59)).date).toBe("2026-07-15");
  });

  it("follows daylight saving time (spring forward 2026-03-29, fall back 2026-10-25)", () => {
    // 01:00 UTC on 29 March 2026: clocks jump from 02:00 CET to 03:00 CEST.
    expect(amsterdamParts(Date.UTC(2026, 2, 29, 0, 59)).hour).toBe(1);
    expect(amsterdamParts(Date.UTC(2026, 2, 29, 1, 0)).hour).toBe(3);
    // 00:30 UTC on 25 October is 02:30 CEST; 01:30 UTC is 02:30 CET (the hour happens twice).
    expect(amsterdamParts(Date.UTC(2026, 9, 25, 0, 30))).toMatchObject({ hour: 2, minute: 30 });
    expect(amsterdamParts(Date.UTC(2026, 9, 25, 1, 30))).toMatchObject({ hour: 2, minute: 30 });
  });

  it("never reports hour 24", () => {
    expect(amsterdamParts(Date.UTC(2026, 0, 14, 23, 0)).hour).toBe(0);
  });

  it("exports the zone name", () => {
    expect(AMSTERDAM).toBe("Europe/Amsterdam");
  });
});

describe("amsterdamDate", () => {
  it("maps local midnight (22:00 or 23:00 UTC the day before) to the intended day", () => {
    expect(amsterdamDate("2026-01-14T23:00:00.000Z")).toBe("2026-01-15");
    expect(amsterdamDate("2026-07-14T22:00:00.000Z")).toBe("2026-07-15");
  });

  it("gives the same day for a UTC midnight instant", () => {
    expect(amsterdamDate("2026-07-15T00:00:00.000Z")).toBe("2026-07-15");
  });

  it("returns null for null and unparseable input", () => {
    expect(amsterdamDate(null)).toBeNull();
    expect(amsterdamDate("not a date")).toBeNull();
  });
});
