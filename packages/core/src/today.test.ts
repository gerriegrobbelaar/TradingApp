import { describe, expect, it } from "vitest";
import {
  ageDaysBetween,
  approvalPriority,
  compareToday,
  decodeTodayCursor,
  encodeTodayCursor,
  pageToday,
  severityOfPriority,
  sortToday,
  todayActions,
  TODAY_PRIORITY,
  type TodayCursor,
} from "./today";

const row = (priority: number, since: string | null, id: string) => ({ priority, since, id });

describe("today ranking", () => {
  it("orders by priority, then longest waiting, then id", () => {
    const items = [
      row(40, "2026-01-01T00:00:00.000Z", "approval:1"),
      row(90, "2026-03-01T00:00:00.000Z", "dq:5"),
      row(90, "2026-02-01T00:00:00.000Z", "dq:9"),
      row(90, null, "dq:2"),
      row(90, "2026-02-01T00:00:00.000Z", "dq:10"),
    ];
    expect(sortToday(items).map((i) => i.id)).toEqual([
      "dq:10",
      "dq:9",
      "dq:5",
      "dq:2",
      "approval:1",
    ]);
  });

  it("is a total order and does not mutate its input", () => {
    const items = [row(50, null, "match:2"), row(50, null, "match:1")];
    const copy = [...items];
    expect(sortToday(items).map((i) => i.id)).toEqual(["match:1", "match:2"]);
    expect(items).toEqual(copy);
    expect(compareToday(items[0]!, items[0]!)).toBe(0);
  });

  it("pages without gaps or repeats for every page size", () => {
    const items = Array.from({ length: 23 }, (_, i) =>
      row(
        40 + (i % 3) * 10,
        i % 4 === 0 ? null : `2026-01-${String(1 + (i % 9)).padStart(2, "0")}T00:00:00.000Z`,
        `match:${i + 1}`,
      ),
    );
    const want = sortToday(items).map((i) => i.id);
    for (const size of [1, 2, 5, 7, 23, 50]) {
      const got: string[] = [];
      let cursor: TodayCursor | null = null;
      for (let guard = 0; guard < 40; guard++) {
        const { page, nextCursor } = pageToday(items, size, cursor);
        got.push(...page.map((p) => p.id));
        if (nextCursor === null) break;
        cursor = decodeTodayCursor(nextCursor);
        expect(cursor).not.toBeNull();
      }
      expect(got).toEqual(want);
    }
  });

  it("round-trips a cursor and refuses anything else", () => {
    const c = encodeTodayCursor(row(75, "2026-02-01T00:00:00.000Z", "booking:stale-4"));
    expect(decodeTodayCursor(c)).toEqual({
      priority: 75,
      since: "2026-02-01T00:00:00.000Z",
      id: "booking:stale-4",
    });
    for (const bad of [
      "",
      "x",
      "!!",
      btoa("[1]"),
      btoa('[1,"a","b"]'),
      btoa('[500,"2026-01-01T00:00:00Z","dq:1"]'),
      btoa('[5,"2026-01-01T00:00:00Z","dq:0"]'),
      "a".repeat(300),
    ]) {
      expect(decodeTodayCursor(bad)).toBeNull();
    }
  });

  it("keeps an item with no start time last within its priority", () => {
    const items = [row(60, null, "dq:1"), row(60, "2026-01-01T00:00:00.000Z", "dq:2")];
    const first = pageToday(items, 1, null);
    expect(first.page[0]?.id).toBe("dq:2");
    const next = pageToday(items, 1, decodeTodayCursor(first.nextCursor ?? ""));
    expect(next.page[0]?.id).toBe("dq:1");
    expect(next.nextCursor).toBeNull();
  });

  it("ranks late approvals above waiting ones and maps priority to severity", () => {
    expect(approvalPriority(4)).toBe(TODAY_PRIORITY.approvalLate);
    expect(approvalPriority(3)).toBe(TODAY_PRIORITY.approvalWaiting);
    expect(approvalPriority(null)).toBe(TODAY_PRIORITY.approvalWaiting);
    expect(severityOfPriority(100)).toBe("critical");
    expect(severityOfPriority(80)).toBe("warning");
    expect(severityOfPriority(45)).toBe("info");
  });

  it("gives actions by role", () => {
    expect(todayActions("approval", ["viewer"], false)).toEqual(["open"]);
    expect(todayActions("dq", ["viewer"], true)).toEqual(["open"]);
    expect(todayActions("dq", ["approver"], true)).toEqual(["open"]);
    expect(todayActions("dq", ["finance"], true)).toEqual(["open", "snooze", "resolve"]);
    expect(todayActions("booking", ["finance"], false)).toEqual([]);
    expect(todayActions("booking", ["admin"], false)).toEqual(["open"]);
    expect(todayActions("booking", ["admin"], true)).toEqual(["open", "snooze", "resolve"]);
  });

  it("counts whole days and tolerates bad input", () => {
    const now = Date.parse("2026-02-10T12:00:00Z");
    expect(ageDaysBetween("2026-02-07T13:00:00Z", now)).toBe(2);
    expect(ageDaysBetween("2027-01-01T00:00:00Z", now)).toBe(0);
    expect(ageDaysBetween("nope", now)).toBeNull();
    expect(ageDaysBetween(null, now)).toBeNull();
  });
});
