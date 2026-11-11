import { describe, expect, it } from "vitest";
import { amsterdamParts } from "./local-time";
import { describeSchedule, isDue, nextRun, validateSchedule, type Schedule } from "./schedule";

const t = (iso: string) => Date.parse(iso);
const cron = (expr: string, workingDaysOnly?: boolean): Schedule =>
  workingDaysOnly === undefined ? { kind: "cron", expr } : { kind: "cron", expr, workingDaysOnly };
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const local = (ms: number) => {
  const p = amsterdamParts(ms);
  return `${p.date} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

describe("validateSchedule", () => {
  const good: [unknown, string][] = [
    [{ kind: "cron", expr: "*/10 * * * *" }, "*/10 * * * *"],
    [{ kind: "cron", expr: "  15   16 * * 1-5 " }, "15 16 * * 1-5"],
    [{ kind: "cron", expr: "0 9 1,15 jan-mar *" }, "0 9 1,15 jan-mar *"],
    [{ kind: "cron", expr: "0 0 * * 7" }, "0 0 * * 7"],
    [{ kind: "cron", expr: "0 0 29 2 *" }, "0 0 29 2 *"],
    [{ kind: "cron", expr: "0 0 31 2 1" }, "0 0 31 2 1"], // dow rescues it (either may match)
    [{ kind: "cron", expr: "5/20 * * * MON,fri" }, "5/20 * * * MON,fri"],
  ];
  it.each(good)("accepts %j", (input, expr) => {
    const r = validateSchedule(input);
    expect(r.ok).toBe(true);
    if (r.ok && r.schedule.kind === "cron") expect(r.schedule.expr).toBe(expr);
  });
  it("keeps workingDaysOnly and last_working_day", () => {
    expect(validateSchedule({ kind: "cron", expr: "15 16 * * *", workingDaysOnly: true })).toEqual({
      ok: true,
      schedule: { kind: "cron", expr: "15 16 * * *", workingDaysOnly: true },
    });
    expect(validateSchedule({ kind: "last_working_day", time: "16:30", extra: 1 })).toEqual({
      ok: true,
      schedule: { kind: "last_working_day", time: "16:30" },
    });
  });
  const bad: unknown[] = [
    null,
    undefined,
    5,
    "x",
    [],
    {},
    { kind: "nope" },
    { kind: "cron" },
    { kind: "cron", expr: 5 },
    { kind: "cron", expr: "" },
    { kind: "cron", expr: "* * * *" },
    { kind: "cron", expr: "* * * * * *" },
    { kind: "cron", expr: "60 * * * *" },
    { kind: "cron", expr: "* 24 * * *" },
    { kind: "cron", expr: "* * 0 * *" },
    { kind: "cron", expr: "* * 32 * *" },
    { kind: "cron", expr: "* * * 0 *" },
    { kind: "cron", expr: "* * * 13 *" },
    { kind: "cron", expr: "* * * * 8" },
    { kind: "cron", expr: "*/0 * * * *" },
    { kind: "cron", expr: "*/61 * * * *" },
    { kind: "cron", expr: "5-1 * * * *" },
    { kind: "cron", expr: "1-2-3 * * * *" },
    { kind: "cron", expr: "1/2/3 * * * *" },
    { kind: "cron", expr: "a * * * *" },
    { kind: "cron", expr: "1,,2 * * * *" },
    { kind: "cron", expr: ",1 * * * *" },
    { kind: "cron", expr: "1- * * * *" },
    { kind: "cron", expr: "*/x * * * *" },
    { kind: "cron", expr: "-1 * * * *" },
    { kind: "cron", expr: "@daily" },
    { kind: "cron", expr: "0 0 * foo *" },
    { kind: "cron", expr: "0 0 * * funday" },
    { kind: "cron", expr: "0 0 1 * * ".repeat(50) },
    { kind: "cron", expr: "0 0 31 2 *" },
    { kind: "cron", expr: "0 0 30 2 *" },
    { kind: "cron", expr: "0 0 31 4,6,9,11 *" },
    { kind: "cron", expr: "123 * * * *" },
    { kind: "cron", expr: "* * * * *", workingDaysOnly: "yes" },
    { kind: "last_working_day" },
    { kind: "last_working_day", time: "24:00" },
    { kind: "last_working_day", time: "9:00" },
    { kind: "last_working_day", time: "09:60" },
    { kind: "last_working_day", time: 1630 },
  ];
  it.each(bad.map((b) => [JSON.stringify(b) ?? "undefined", b] as const))(
    "rejects %s",
    (_n, input) => {
      const r = validateSchedule(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    },
  );
  it("never throws on garbage (fuzz)", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const alphabet = "0123456789*/,- abcdefjmnstuw@#\t\n$%";
    for (let i = 0; i < 3000; i++) {
      let expr = "";
      const len = Math.floor(rnd() * 30);
      for (let j = 0; j < len; j++) expr += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = validateSchedule({ kind: "cron", expr });
      expect(typeof r.ok).toBe("boolean");
      if (r.ok) expect(nextRun(r.schedule, t("2026-11-11T10:00:00Z"))).not.toBeUndefined();
    }
    const weird: unknown[] = [
      Symbol.iterator,
      () => 1,
      1n,
      NaN,
      new Date(),
      { kind: {} },
      { kind: "cron", expr: {} },
    ];
    for (const w of weird) expect(() => validateSchedule(w)).not.toThrow();
  });
});

describe("nextRun cron basics", () => {
  it("every 10 minutes lands on real marks and is strictly after", () => {
    expect(iso(nextRun(cron("*/10 * * * *"), t("2026-11-11T10:03:20Z")))).toBe(
      "2026-11-11T10:10:00.000Z",
    );
    expect(iso(nextRun(cron("*/10 * * * *"), t("2026-11-11T10:10:00Z")))).toBe(
      "2026-11-11T10:20:00.000Z",
    );
    expect(iso(nextRun(cron("*/10 * * * *"), t("2026-11-11T10:10:00.001Z")))).toBe(
      "2026-11-11T10:20:00.000Z",
    );
  });
  it("daily at a local time (winter and summer offsets)", () => {
    expect(iso(nextRun(cron("0 2 * * *"), t("2026-01-15T12:00:00Z")))).toBe(
      "2026-01-16T01:00:00.000Z",
    );
    expect(iso(nextRun(cron("0 2 * * *"), t("2026-07-15T12:00:00Z")))).toBe(
      "2026-07-16T00:00:00.000Z",
    );
  });
  it("rolls over midnight local, not UTC", () => {
    // 23:30 UTC on 14 Jan is 00:30 on 15 Jan in Amsterdam
    expect(local(nextRun(cron("45 0 * * *"), t("2026-01-14T23:30:00Z")) as number)).toBe(
      "2026-01-15 00:45",
    );
  });
  it("hourly, lists, ranges, steps with start", () => {
    expect(iso(nextRun(cron("0 * * * *"), t("2026-11-11T10:30:00Z")))).toBe(
      "2026-11-11T11:00:00.000Z",
    );
    expect(local(nextRun(cron("0,30 9-10 * * *"), t("2026-11-11T08:00:00Z")) as number)).toBe(
      "2026-11-11 09:30",
    );
    expect(local(nextRun(cron("5/20 8 * * *"), t("2026-11-11T07:06:00Z")) as number)).toBe(
      "2026-11-11 08:25",
    );
  });
  it("day of week: 0 and 7 are Sunday, names work", () => {
    const sun0 = nextRun(cron("0 12 * * 0"), t("2026-11-11T00:00:00Z"));
    const sun7 = nextRun(cron("0 12 * * 7"), t("2026-11-11T00:00:00Z"));
    const sunN = nextRun(cron("0 12 * * SUN"), t("2026-11-11T00:00:00Z"));
    expect(local(sun0 as number)).toBe("2026-11-15 12:00");
    expect(sun7).toBe(sun0);
    expect(sunN).toBe(sun0);
    expect(local(nextRun(cron("0 12 * * 5-7"), t("2026-11-11T00:00:00Z")) as number)).toBe(
      "2026-11-13 12:00",
    );
  });
  it("dom and dow both restricted: either may match", () => {
    // 13th of the month OR Monday. After Wed 11 Nov 2026 the first is Fri 13th.
    expect(local(nextRun(cron("0 8 13 * 1"), t("2026-11-11T12:00:00Z")) as number)).toBe(
      "2026-11-13 08:00",
    );
    // then Monday 16th
    expect(local(nextRun(cron("0 8 13 * 1"), t("2026-11-13T12:00:00Z")) as number)).toBe(
      "2026-11-16 08:00",
    );
    // when only one is restricted both must match (AND with star): */2 counts as star in dom
    expect(local(nextRun(cron("0 8 */2 * 1"), t("2026-11-11T12:00:00Z")) as number)).toBe(
      "2026-11-23 08:00",
    );
  });
  it("month names and month restriction", () => {
    expect(local(nextRun(cron("0 6 1 mar,JUN *"), t("2026-11-11T12:00:00Z")) as number)).toBe(
      "2027-03-01 06:00",
    );
  });
  it("handles 29 February", () => {
    expect(local(nextRun(cron("0 0 29 2 *"), t("2026-11-11T12:00:00Z")) as number)).toBe(
      "2028-02-29 00:00",
    );
  });
  it("returns null for far-future fires, bad input and invalid expressions", () => {
    expect(nextRun(cron("0 0 29 2 *"), t("2096-03-01T00:00:00Z"))).toBeNull(); // next is 2104
    expect(nextRun(cron("nonsense"), 0)).toBeNull();
    expect(nextRun(cron("* * * * *"), Number.NaN)).toBeNull();
    expect(nextRun({ kind: "last_working_day", time: "bad" }, 0)).toBeNull();
  });
});

describe("working days only", () => {
  const s = cron("15 16 * * *", true);
  it("skips weekends", () => {
    // Friday 13 Nov 2026 16:15 passed -> Monday 16 Nov
    expect(local(nextRun(s, t("2026-11-13T16:00:00Z")) as number)).toBe("2026-11-16 16:15");
  });
  it("skips TARGET holidays (Good Friday, Easter Monday)", () => {
    expect(local(nextRun(s, t("2026-04-02T15:00:00Z")) as number)).toBe("2026-04-07 16:15");
    expect(local(nextRun(s, t("2026-12-24T16:00:00Z")) as number)).toBe("2026-12-28 16:15");
    expect(local(nextRun(s, t("2026-12-31T16:00:00Z")) as number)).toBe("2027-01-04 16:15");
  });
  it("without the flag holidays still fire", () => {
    expect(local(nextRun(cron("15 16 * * *"), t("2026-04-02T12:00:00Z")) as number)).toBe(
      "2026-04-02 16:15",
    );
    expect(local(nextRun(cron("15 16 * * *"), t("2026-04-02T15:30:00Z")) as number)).toBe(
      "2026-04-03 16:15",
    );
  });
  it("uses the Amsterdam date, not the UTC date", () => {
    // Sunday 15 Nov 2026 23:30 UTC is Monday 00:30 local; job at 00:45 on working days fires that Monday.
    expect(local(nextRun(cron("45 0 * * *", true), t("2026-11-15T23:30:00Z")) as number)).toBe(
      "2026-11-16 00:45",
    );
  });
});

describe("DST transitions (Europe/Amsterdam)", () => {
  // [year, spring-forward date, fall-back date]
  const years: [number, string, string][] = [
    [2025, "2025-03-30", "2025-10-26"],
    [2026, "2026-03-29", "2026-10-25"],
    [2027, "2027-03-28", "2027-10-31"],
    [2028, "2028-03-26", "2028-10-29"],
  ];
  describe.each(years)("%i", (_y, spring, fall) => {
    it("spring forward: 02:30 fires once at 03:00 local (01:00 UTC)", () => {
      const s = cron("30 2 * * *");
      const before = t(`${spring}T00:00:00Z`).valueOf() - 3 * 3_600_000;
      const first = nextRun(s, before) as number;
      expect(iso(first)).toBe(`${spring}T01:00:00.000Z`);
      expect(local(first)).toBe(`${spring} 03:00`);
      // the next fire is the next day at the real 02:30 local
      const second = nextRun(s, first) as number;
      expect(local(second)).not.toBe(`${spring} 03:00`);
      expect(second - first).toBeGreaterThan(20 * 3_600_000);
      expect(local(second).endsWith("02:30")).toBe(true);
    });
    it("spring forward: hourly job has no fire in the missing hour", () => {
      const fires: string[] = [];
      let cur = t(`${spring}T00:00:00Z`) - 1;
      for (let i = 0; i < 5; i++) {
        cur = nextRun(cron("0 * * * *"), cur) as number;
        fires.push(local(cur));
      }
      expect(fires).toEqual([
        `${spring} 01:00`,
        `${spring} 03:00`,
        `${spring} 04:00`,
        `${spring} 05:00`,
        `${spring} 06:00`,
      ]);
      expect(fires.some((f) => f.endsWith("02:00"))).toBe(false);
    });
    it("spring forward: */10 keeps real 10-minute marks", () => {
      let cur = t(`${spring}T00:30:00Z`);
      const gaps = new Set<number>();
      for (let i = 0; i < 12; i++) {
        const n = nextRun(cron("*/10 * * * *"), cur) as number;
        gaps.add(n - cur);
        cur = n;
      }
      expect([...gaps]).toEqual([600_000]);
    });
    it("fall back: 02:30 fires once, at the first occurrence (summer time)", () => {
      const s = cron("30 2 * * *");
      const first = nextRun(s, t(`${fall}T00:00:00Z`) - 4 * 3_600_000) as number;
      expect(iso(first)).toBe(`${fall}T00:30:00.000Z`);
      const second = nextRun(s, first) as number;
      expect(second - first).toBeGreaterThan(23 * 3_600_000);
      expect(local(second).endsWith("02:30")).toBe(true);
      expect(local(second).startsWith(fall)).toBe(false);
    });
    it("fall back: hourly job fires at every real hour, the repeated hour twice", () => {
      const fires: number[] = [];
      let cur = t(`${fall}T00:00:00Z`) - 2 * 3_600_000;
      for (let i = 0; i < 6; i++) {
        cur = nextRun(cron("0 * * * *"), cur) as number;
        fires.push(cur);
      }
      for (let i = 1; i < fires.length; i++)
        expect((fires[i] as number) - (fires[i - 1] as number)).toBe(3_600_000);
      const twoAm = fires.filter((f) => local(f) === `${fall} 02:00`);
      expect(twoAm.map(iso)).toEqual([`${fall}T00:00:00.000Z`, `${fall}T01:00:00.000Z`]);
    });
    it("fall back: */10 fires at every real mark, the repeated hour twice", () => {
      let cur = t(`${fall}T00:00:00Z`) - 1;
      const seen: number[] = [];
      for (let i = 0; i < 18; i++) {
        cur = nextRun(cron("*/10 * * * *"), cur) as number;
        seen.push(cur);
      }
      for (let i = 1; i < seen.length; i++)
        expect((seen[i] as number) - (seen[i - 1] as number)).toBe(600_000);
      // 02:00-02:59 local occurs twice in this span
      expect(seen.filter((s) => local(s) === `${fall} 02:00`)).toHaveLength(2);
    });
    it("last_working_day at 02:30 is unaffected on other days", () => {
      expect(
        nextRun({ kind: "last_working_day", time: "02:30" }, t(`${spring}T00:00:00Z`)),
      ).not.toBeNull();
    });
  });

  it("restricted-hour job in the repeated hour fires once even with several minutes", () => {
    const s = cron("0,30 2 * * *");
    const a = nextRun(s, t("2026-10-24T23:59:00Z")) as number; // before fall back (25 Oct)
    expect(iso(a)).toBe("2026-10-25T00:00:00.000Z");
    const b = nextRun(s, a) as number;
    expect(iso(b)).toBe("2026-10-25T00:30:00.000Z");
    const c = nextRun(s, b) as number;
    expect(local(c)).toBe("2026-10-26 02:00");
  });
  it("restricted-hour */10 job in the gap collapses to one fire at 03:00", () => {
    const s = cron("*/10 2 * * *");
    const a = nextRun(s, t("2026-03-28T23:59:00Z")) as number;
    expect(iso(a)).toBe("2026-03-29T01:00:00.000Z");
    expect(local(nextRun(s, a) as number)).toBe("2026-03-30 02:00");
  });
  it("a job at 03:00 in the spring gap day does not fire twice", () => {
    const s = cron("0 2,3 * * *");
    const a = nextRun(s, t("2026-03-28T23:59:00Z")) as number;
    const b = nextRun(s, a) as number;
    expect(iso(a)).toBe("2026-03-29T01:00:00.000Z");
    expect(local(b)).toBe("2026-03-30 02:00");
  });
  it("jobs just before and after the gap behave normally", () => {
    expect(iso(nextRun(cron("59 1 * * *"), t("2026-03-28T23:59:00Z")))).toBe(
      "2026-03-29T00:59:00.000Z",
    );
    expect(iso(nextRun(cron("0 3 * * *"), t("2026-03-28T23:59:00Z")))).toBe(
      "2026-03-29T01:00:00.000Z",
    );
    expect(iso(nextRun(cron("59 2 * * *"), t("2026-10-24T23:59:00Z")))).toBe(
      "2026-10-25T00:59:00.000Z",
    );
    expect(iso(nextRun(cron("0 3 * * *"), t("2026-10-24T23:59:00Z")))).toBe(
      "2026-10-25T02:00:00.000Z",
    );
  });
});

describe("last_working_day", () => {
  const s: Schedule = { kind: "last_working_day", time: "16:30" };
  const expectations: [string, string][] = [
    ["2026-11-11T10:00:00Z", "2026-11-30 16:30"], // Monday
    ["2026-11-30T15:31:00Z", "2026-12-31 16:30"], // after the Nov fire: Thursday 31 Dec
    ["2026-12-31T15:31:00Z", "2027-01-29 16:30"], // 31 Jan 2027 is Sunday -> Fri 29th
    ["2027-02-01T00:00:00Z", "2027-02-26 16:30"], // 28 Feb Sunday
    ["2028-02-01T00:00:00Z", "2028-02-29 16:30"], // leap year
    ["2024-03-01T00:00:00Z", "2024-03-28 16:30"], // Good Friday 29th, Easter Monday 1 Apr
    ["2026-04-01T00:00:00Z", "2026-04-30 16:30"],
    ["2026-05-01T00:00:00Z", "2026-05-29 16:30"], // 31 May Sunday
  ];
  it.each(expectations)("after %s fires %s", (after, want) => {
    expect(local(nextRun(s, t(after)) as number)).toBe(want);
  });
  it("is strictly after: at the fire instant the next month is returned", () => {
    const fire = nextRun(s, t("2026-11-11T10:00:00Z")) as number;
    expect(local(nextRun(s, fire) as number)).toBe("2026-12-31 16:30");
    expect(local(nextRun(s, fire - 1) as number)).toBe("2026-11-30 16:30");
  });
  it("uses summer-time offset when the month ends in summer", () => {
    expect(iso(nextRun(s, t("2026-07-01T00:00:00Z")))).toBe("2026-07-31T14:30:00.000Z");
  });
  it("crosses the year boundary", () => {
    expect(local(nextRun(s, t("2026-12-31T15:31:00Z")) as number).startsWith("2027-01")).toBe(true);
  });
  it("handles DST edge times on a last working day", () => {
    // 31 Oct 2025 and 29 Mar 2024 are ordinary days; DST days never are the last working day of the
    // month except none for Amsterdam, but the time still resolves via the shared day logic.
    expect(
      local(
        nextRun({ kind: "last_working_day", time: "02:30" }, t("2025-10-01T00:00:00Z")) as number,
      ),
    ).toBe("2025-10-31 02:30");
  });
});

describe("isDue catch-up semantics", () => {
  const s = cron("0 9 * * *"); // daily 09:00 local
  const created = t("2026-11-01T12:00:00Z");
  it("is not due before the first fire time", () => {
    expect(isDue(s, null, t("2026-11-02T07:59:59Z"), created)).toBe(false);
  });
  it("is due exactly at the fire time (inclusive)", () => {
    expect(isDue(s, null, t("2026-11-02T08:00:00Z"), created)).toBe(true);
  });
  it("a never-run job created in the past fires once, not retroactively for every missed slot", () => {
    const now = t("2026-11-11T12:00:00Z");
    expect(isDue(s, null, now, created)).toBe(true);
    // After the one catch-up run is recorded at now, it is not due again until the next slot.
    expect(isDue(s, now, now + 1000, created)).toBe(false);
    expect(isDue(s, now, t("2026-11-12T07:59:00Z"), created)).toBe(false);
    expect(isDue(s, now, t("2026-11-12T08:00:00Z"), created)).toBe(true);
  });
  it("a long outage yields exactly one catch-up run", () => {
    const last = t("2026-10-01T08:00:00Z");
    const now = t("2026-11-11T12:00:00Z");
    let runs = 0;
    let lastRun: number | null = last;
    for (let tick = now; tick < now + 5 * 60_000; tick += 60_000) {
      if (isDue(s, lastRun, tick, created)) {
        runs++;
        lastRun = tick;
      }
    }
    expect(runs).toBe(1);
  });
  it("uses lastRun over createdMs when present", () => {
    expect(isDue(s, t("2026-11-11T08:00:00Z"), t("2026-11-11T20:00:00Z"), created)).toBe(false);
  });
  it("is false when the schedule has no next run", () => {
    expect(isDue(cron("bad"), null, t("2026-11-11T12:00:00Z"), created)).toBe(false);
  });
  it("works for last_working_day", () => {
    const l: Schedule = { kind: "last_working_day", time: "16:30" };
    expect(isDue(l, t("2026-10-30T16:00:00Z"), t("2026-11-30T15:29:00Z"), created)).toBe(false);
    expect(isDue(l, t("2026-10-30T16:00:00Z"), t("2026-11-30T15:30:00Z"), created)).toBe(true);
  });
});

describe("nextRun property checks", () => {
  const schedules: Schedule[] = [
    cron("*/10 * * * *"),
    cron("*/5 * * * *"),
    cron("0 * * * *"),
    cron("30 2 * * *"),
    cron("15 16 * * *", true),
    cron("0 9 * * 1-5"),
    cron("0 0 1 * *"),
    cron("0,30 2 * * *"),
    { kind: "last_working_day", time: "16:30" },
    { kind: "last_working_day", time: "02:30" },
  ];
  it.each(schedules.map((s) => [describeSchedule(s), s] as const))(
    "%s is strictly increasing and > after",
    (_n, s) => {
      for (const start of [
        "2025-03-29T12:00:00Z",
        "2026-03-28T12:00:00Z",
        "2026-10-24T12:00:00Z",
        "2027-10-30T12:00:00Z",
        "2026-12-20T00:00:00Z",
      ]) {
        let cur = t(start);
        const steps = s.kind === "cron" && s.expr.startsWith("*/") ? 400 : 60;
        for (let i = 0; i < steps; i++) {
          const n = nextRun(s, cur);
          expect(n).not.toBeNull();
          expect(n as number).toBeGreaterThan(cur);
          // nothing is skipped: a query just before n returns n
          expect(nextRun(s, (n as number) - 1)).toBe(n);
          cur = n as number;
        }
      }
    },
  );
  it("is greater than after for odd offsets within a minute", () => {
    const s = cron("*/10 * * * *");
    for (const off of [0, 1, 999, 59_999, 60_000, 599_999, 600_000]) {
      const after = t("2026-10-25T00:00:00Z") + off;
      expect(nextRun(s, after) as number).toBeGreaterThan(after);
    }
  });
});

describe("describeSchedule", () => {
  const cases: [Schedule, string][] = [
    [cron("*/10 * * * *"), "Every 10 minutes"],
    [cron("*/5 * * * *"), "Every 5 minutes"],
    [cron("* * * * *"), "Every minute"],
    [cron("*/1 * * * *"), "Every minute"],
    [cron("*/10 * * * *", true), "Every 10 minutes on working days"],
    [cron("0 * * * *"), "Every hour on the hour"],
    [cron("30 * * * *"), "Every hour at minute 30"],
    [cron("0 2 * * *"), "Daily at 02:00"],
    [cron("15 16 * * *", true), "Working days at 16:15"],
    [cron("0 9 * * *"), "Daily at 09:00"],
    [{ kind: "last_working_day", time: "16:30" }, "Last working day of the month at 16:30"],
    [cron("*/7 * * * *"), "Custom schedule (*/7 * * * *) in Amsterdam time"],
    [cron("0 9 1 * *", true), "Custom schedule (0 9 1 * *) in Amsterdam time, working days only"],
    [cron("bad"), "Invalid schedule (bad)"],
    [cron("15 16 * * 1-5", true), "Working days at 16:15"],
    [cron("0 9 * * mon-fri"), "Weekdays at 09:00"],
    [cron("*/10 * * * 1-5"), "Every 10 minutes on weekdays"],
    [cron("0,30 9 * * *"), "Custom schedule (0,30 9 * * *) in Amsterdam time"],
  ];
  it.each(cases)("%j", (s, want) => {
    expect(describeSchedule(s)).toBe(want);
  });
});
