import { describe, expect, it } from "vitest";
import {
  canonicalSince,
  cappedHorizon,
  ageDaysBetween,
  approvalPriority,
  compareToday,
  decodeTodayCursor,
  encodeTodayCursor,
  pageToday,
  severityOfPriority,
  sortToday,
  todayActions,
  TODAY_KINDS,
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

describe("review D8c: canonical instants and the capped horizon", () => {
  it("spells every instant one way and drops what a cursor could not carry", () => {
    expect(canonicalSince("2026-01-05T10:00:00Z")).toBe("2026-01-05T10:00:00.000Z");
    expect(canonicalSince("2026-01-05T11:00:00+01:00")).toBe("2026-01-05T10:00:00.000Z");
    expect(canonicalSince("+010000-01-01T00:00:00.000Z")).toBeNull();
    expect(canonicalSince("nonsense")).toBeNull();
    expect(canonicalSince(null)).toBeNull();
    expect(canonicalSince(undefined)).toBeNull();
  });

  it("issues only cursors it can decode, and refuses non-canonical ones", () => {
    const c = encodeTodayCursor(row(40, canonicalSince("2026-01-05T10:00:00Z"), "match:1"));
    expect(decodeTodayCursor(c)).toEqual({
      priority: 40,
      since: "2026-01-05T10:00:00.000Z",
      id: "match:1",
    });
    const bad = encodeTodayCursor(row(40, "2026-01-05T10:00:00Z", "match:1"));
    expect(decodeTodayCursor(bad)).toBeNull();
    expect(decodeTodayCursor(encodeTodayCursor(row(40, null, "match:1")))).not.toBeNull();
  });

  it("serves nothing past the earliest last row of a capped source", () => {
    const capped = [
      row(60, "2026-01-01T00:00:00.000Z", "dq:1"),
      row(60, "2026-01-02T00:00:00.000Z", "dq:2"),
    ];
    const others = [
      row(90, "2026-01-09T00:00:00.000Z", "dq:9"),
      row(60, "2026-01-03T00:00:00.000Z", "dq:3"),
      row(40, "2026-01-01T00:00:00.000Z", "approval:1"),
    ];
    const horizon = cappedHorizon([capped[1]!, row(45, null, "match:7")]);
    expect(horizon?.id).toBe("dq:2");
    const { page, nextCursor } = pageToday([...capped, ...others], 50, null, horizon);
    expect(page.map((p) => p.id)).toEqual(["dq:9", "dq:1", "dq:2"]);
    expect(nextCursor).toBeNull();
    // Paging inside the horizon: same items, no repeats.
    const p1 = pageToday([...capped, ...others], 2, null, horizon);
    const p2 = pageToday(
      [...capped, ...others],
      2,
      decodeTodayCursor(p1.nextCursor as string),
      horizon,
    );
    expect([...p1.page, ...p2.page].map((p) => p.id)).toEqual(["dq:9", "dq:1", "dq:2"]);
    expect(p2.nextCursor).toBeNull();
    expect(cappedHorizon([])).toBeNull();
  });
});

describe("F9b: payment kinds (Phase 9 final review S2, ADR 0053)", () => {
  it("ranks a payment waiting for approval above warnings and below critical issues", () => {
    expect(TODAY_PRIORITY.paymentApproval).toBeLessThan(TODAY_PRIORITY.dqCritical);
    expect(TODAY_PRIORITY.paymentApproval).toBeGreaterThan(TODAY_PRIORITY.dqWarning);
    expect(TODAY_PRIORITY.paymentReady).toBeGreaterThan(TODAY_PRIORITY.dqWarning);
    expect(TODAY_PRIORITY.paymentReady).toBeLessThan(TODAY_PRIORITY.paymentApproval);
    expect(severityOfPriority(TODAY_PRIORITY.paymentApproval)).toBe("warning");
    expect(TODAY_KINDS).toContain("payment_approval");
    expect(TODAY_KINDS).toContain("payment_ready");
  });

  it("keeps a total order and stable paging with the new ids, batches included", () => {
    const t = (d: number) => `2026-01-0${d}T00:00:00.000Z`;
    const items = [
      row(TODAY_PRIORITY.paymentApproval, t(1), "payment_approval:12"),
      row(TODAY_PRIORITY.paymentApproval, t(1), "payment_approval:batch-3"),
      row(TODAY_PRIORITY.paymentApproval, t(1), "payment_approval:2"),
      row(TODAY_PRIORITY.paymentApproval, t(2), "payment_approval:1"),
      row(TODAY_PRIORITY.paymentReady, t(1), "payment_ready:7"),
      row(TODAY_PRIORITY.paymentReady, null, "payment_ready:batch-1"),
      row(TODAY_PRIORITY.dqCritical, t(3), "dq:1"),
      row(TODAY_PRIORITY.dqWarning, t(1), "dq:2"),
    ];
    const order = sortToday(items).map((i) => i.id);
    expect(order).toEqual([
      "dq:1",
      "payment_approval:12",
      "payment_approval:2",
      "payment_approval:batch-3",
      "payment_approval:1",
      "payment_ready:7",
      "payment_ready:batch-1",
      "dq:2",
    ]);
    for (const size of [1, 2, 3, 5, 8]) {
      const seen: string[] = [];
      let cursor: TodayCursor | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const { page, nextCursor } = pageToday(items, size, cursor);
        seen.push(...page.map((i) => i.id));
        if (nextCursor === null) break;
        cursor = decodeTodayCursor(nextCursor);
        expect(cursor, `size ${size}`).not.toBeNull();
      }
      expect(seen, `size ${size}`).toEqual(order);
    }
  });

  it("round-trips cursors on payment ids and refuses malformed ones", () => {
    const enc = (id: string) => encodeTodayCursor(row(85, "2026-01-01T00:00:00.000Z", id));
    for (const id of [
      "payment_approval:5",
      "payment_approval:batch-5",
      "payment_ready:9",
      "payment_ready:batch-9",
      "booking:stale-9",
      "booking:9",
      "dq:9",
    ]) {
      expect(decodeTodayCursor(enc(id))?.id).toBe(id);
    }
    for (const bad of [
      "payment_ready:0",
      "payment_ready:batch-",
      "payment_other:1",
      "payment_approval:batch-0",
      // review F9b: each prefix only on the kind that issues it
      "dq:batch-3",
      "approval:stale-3",
      "match:batch-3",
      "payment_ready:stale-3",
      "booking:batch-3",
      "payment_approval:batch-batch-3",
    ]) {
      expect(decodeTodayCursor(enc(bad)), bad).toBeNull();
    }
  });

  it("gives payment actions by role only", () => {
    expect(todayActions("payment_approval", ["approver"], false)).toEqual(["open"]);
    expect(todayActions("payment_approval", ["finance", "approver"], false)).toEqual(["open"]);
    for (const roles of [["finance"], ["admin"], ["viewer"], []] as const) {
      expect(todayActions("payment_approval", roles, false), roles.join()).toEqual([]);
    }
    expect(todayActions("payment_ready", ["finance"], false)).toEqual(["open"]);
    for (const roles of [["approver"], ["admin"], ["viewer"], []] as const) {
      expect(todayActions("payment_ready", roles, false), roles.join()).toEqual([]);
    }
  });

  it("the capped horizon still cuts across the new kinds", () => {
    const a = row(85, "2026-01-02T00:00:00.000Z", "payment_approval:4");
    const b = row(70, "2026-01-01T00:00:00.000Z", "payment_ready:3");
    expect(cappedHorizon([b, a])?.id).toBe("payment_approval:4");
    const items = [a, b, row(60, "2026-01-01T00:00:00.000Z", "dq:1")];
    expect(pageToday(items, 10, null, a).page.map((i) => i.id)).toEqual(["payment_approval:4"]);
  });
});
