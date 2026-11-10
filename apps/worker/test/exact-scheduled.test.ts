import { env } from "cloudflare:test";
import { ExactApiError, ExactAuthError } from "@camelthorn/exact";
import { CREDENTIALS_REJECTED } from "../src/exact/gate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FULL_WINDOW_TICKS,
  MAX_TICKS_PER_DAY,
  SCHEDULED_FULL_BUDGET,
  SCHEDULED_INCREMENTAL_BUDGET,
  SCHEDULED_WORST_CASE_CALLS_PER_DAY,
  runScheduledExactSync,
  scheduledMode,
} from "../src/exact/scheduled";
import { SUBREQUEST_RESERVE, newMeter } from "../src/exact/sync";
import { FakeExact, addDivision, db, fakeGate, resetSync } from "./sync-helpers";

describe("scheduledMode (02:00 Amsterdam, across daylight saving time)", () => {
  const at = (iso: string) => Date.parse(iso);

  it("summer: 00:00 UTC is 02:00 CEST, the daily full sync", () => {
    expect(scheduledMode(at("2026-07-15T00:00:00Z"), null)).toBe("full");
    expect(scheduledMode(at("2026-07-15T00:00:00Z"), "2026-07-14T00:10:00Z")).toBe("full");
    // 22:00 UTC = 00:00 and 23:00 UTC = 01:00 local: too early
    expect(scheduledMode(at("2026-07-14T23:00:00Z"), null)).toBe("incremental");
  });

  it("winter: 01:00 UTC is 02:00 CET, the daily full sync; 00:00 UTC is only 01:00", () => {
    expect(scheduledMode(at("2026-01-15T01:00:00Z"), null)).toBe("full");
    expect(scheduledMode(at("2026-01-15T00:00:00Z"), null)).toBe("incremental");
  });

  it("spring forward (2026-03-29): 02:00 never exists, the 03:00 CEST tick runs the full sync", () => {
    expect(scheduledMode(at("2026-03-29T00:00:00Z"), null)).toBe("incremental"); // 01:00 CET
    expect(scheduledMode(at("2026-03-29T01:00:00Z"), null)).toBe("full"); // 03:00 CEST
    expect(scheduledMode(at("2026-03-29T02:00:00Z"), "2026-03-29T01:05:00Z")).toBe("incremental");
  });

  it("fall back (2026-10-25): 02:00 happens twice, only the first runs the full sync", () => {
    expect(scheduledMode(at("2026-10-25T00:00:00Z"), null)).toBe("full"); // 02:00 CEST
    const done = "2026-10-25T00:07:00Z";
    expect(scheduledMode(at("2026-10-25T01:00:00Z"), done)).toBe("incremental"); // 02:00 CET
    expect(scheduledMode(at("2026-10-25T02:00:00Z"), done)).toBe("incremental"); // 03:00 CET
  });

  it("retries a partial full sync on later ticks inside the window, then stops at 06:00", () => {
    expect(scheduledMode(at("2026-07-15T01:00:00Z"), null)).toBe("full"); // 03:00
    expect(scheduledMode(at("2026-07-15T03:00:00Z"), null)).toBe("full"); // 05:00
    expect(scheduledMode(at("2026-07-15T04:00:00Z"), null)).toBe("incremental"); // 06:00
  });

  it("does not repeat a full sync that failed today, but retries a partial or interrupted one", () => {
    const now = at("2026-07-15T02:00:00Z"); // 04:00 CEST
    const today = "2026-07-15T00:00:05Z";
    for (const status of ["error", "needs_reauth"]) {
      expect(scheduledMode(now, null, { mode: "full", status, startedAt: today })).toBe(
        "incremental",
      );
    }
    for (const status of ["partial", "running"]) {
      expect(scheduledMode(now, null, { mode: "full", status, startedAt: today })).toBe("full");
    }
    // A failed full sync yesterday does not block today's.
    expect(
      scheduledMode(now, null, {
        mode: "full",
        status: "error",
        startedAt: "2026-07-14T00:00:05Z",
      }),
    ).toBe("full");
    // An incremental error does not block the full sync.
    expect(
      scheduledMode(now, null, { mode: "incremental", status: "error", startedAt: today }),
    ).toBe("full");
  });

  it("judges 'today' by the Amsterdam date, not the UTC date", () => {
    // full finished 23:59 CEST on the 15th (21:59 UTC): the next day's 02:00 still runs full
    expect(scheduledMode(at("2026-07-16T00:00:00Z"), "2026-07-15T21:59:00Z")).toBe("full");
    // full finished 00:30 CEST on the 16th (22:30 UTC on the 15th) counts for the 16th
    expect(scheduledMode(at("2026-07-16T01:00:00Z"), "2026-07-15T22:30:00Z")).toBe("incremental");
  });
});

describe("runScheduledExactSync", () => {
  beforeEach(resetSync);

  it("skips silently when there is no Exact connection", async () => {
    const r = await runScheduledExactSync(env, Date.parse("2026-07-15T00:00:00Z"));
    expect(r).toEqual({ ran: [], skipped: "no_connection" });
  });

  it("skips silently when the connection needs re-authorisation", async () => {
    await addDivision({ status: "needs_reauth" });
    const fx = new FakeExact(1);
    const r = await runScheduledExactSync(env, Date.parse("2026-07-15T00:00:00Z"), {
      transport: fx.transport,
      gate: fakeGate(),
    });
    expect(r).toEqual({ ran: [], skipped: "not_active" });
    expect(fx.calls).toHaveLength(0);
  });

  it("runs the full sync at 02:00 Amsterdam, then incremental on the next tick", async () => {
    const div = await addDivision();
    const fx = new FakeExact(div.exactDivision);
    fx.divisions = [{ code: div.exactDivision, description: "BV" }];
    const gate = fakeGate();
    // The run stamps its state with the clock it is given, so simulate time for both.
    let clock = Date.parse("2026-07-15T00:00:00Z");
    const deps = { transport: fx.transport, gate, now: () => clock };

    const t1 = await runScheduledExactSync(env, clock, deps);
    expect(t1.ran).toEqual([{ divisionId: div.id, mode: "full", status: "ok" }]);
    expect(gate.started[0]?.jobId).toMatch(/^sync:full:/);
    expect(gate.started[0]?.budget).toBe(SCHEDULED_FULL_BUDGET);

    clock = Date.parse("2026-07-15T01:00:00Z");
    const t2 = await runScheduledExactSync(env, clock, deps);
    expect(t2.ran).toEqual([{ divisionId: div.id, mode: "incremental", status: "ok" }]);
    expect(gate.started[1]?.budget).toBe(SCHEDULED_INCREMENTAL_BUDGET);

    const audit = await db
      .prepare("SELECT actor_email FROM audit_log WHERE action = 'exact.sync' AND entity_id = ?1")
      .bind(String(div.id))
      .all<{ actor_email: string }>();
    expect(audit.results.map((a) => a.actor_email)).toEqual(["system", "system"]);
  });

  it("stops after needs_reauth instead of trying the connection's other divisions", async () => {
    const div = await addDivision();
    // second division on the same connection
    await db
      .prepare("INSERT INTO divisions (connection_id, exact_division, name) VALUES (?1, ?2, 'B')")
      .bind(div.connectionId, div.exactDivision + 1)
      .run();
    const fx = new FakeExact(div.exactDivision);
    fx.beforeCall = () => {
      throw new ExactAuthError("needs_reauth");
    };
    const r = await runScheduledExactSync(env, Date.parse("2026-07-15T00:00:00Z"), {
      transport: fx.transport,
      gate: fakeGate(),
    });
    expect(r.ran).toEqual([{ divisionId: div.id, mode: "full", status: "needs_reauth" }]);
    expect(fx.calls).toHaveLength(1);
  });

  it("an error in one division does not stop the others", async () => {
    const a = await addDivision();
    const bExact = a.exactDivision + 1;
    const b = await db
      .prepare("INSERT INTO divisions (connection_id, exact_division, name) VALUES (?1, ?2, 'B')")
      .bind(a.connectionId, bExact)
      .run();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fx = new FakeExact(a.exactDivision);
    fx.divisions = [];
    fx.beforeCall = (_n, req) => {
      if (req.division === a.exactDivision) throw new TypeError("boom");
    };
    const r = await runScheduledExactSync(env, Date.parse("2026-07-15T12:00:00Z"), {
      transport: fx.transport,
      gate: fakeGate(),
    });
    expect(r.ran).toEqual([
      { divisionId: a.id, mode: "incremental", status: "error" },
      { divisionId: b.meta.last_row_id, mode: "incremental", status: "ok" },
    ]);
  });

  it("leaves the remaining divisions for the next tick once the invocation's subrequests run low", async () => {
    const a = await addDivision();
    await db
      .prepare("INSERT INTO divisions (connection_id, exact_division, name) VALUES (?1, ?2, 'B')")
      .bind(a.connectionId, a.exactDivision + 1)
      .run();
    const fx = new FakeExact(a.exactDivision);
    fx.divisions = [];
    const meter = newMeter(SUBREQUEST_RESERVE * 2 + 15);
    const r = await runScheduledExactSync(
      env,
      Date.parse("2026-07-15T12:00:00Z"),
      { transport: fx.transport, gate: fakeGate() },
      meter,
    );
    expect(r.ran).toHaveLength(1);
    expect(meter.used).toBeLessThanOrEqual(meter.limit);
  });
});

describe("budgets and fairness (review G1)", () => {
  beforeEach(resetSync);

  it("keeps the scheduled worst case per division at or below 2,000 Exact calls a day", () => {
    // 25 ticks on the fall-back day, 5 of them in the 02:00-05:59 window (hours 2, 2, 3, 4, 5).
    expect(MAX_TICKS_PER_DAY).toBe(25);
    expect(MAX_FULL_WINDOW_TICKS).toBe(5);
    const worst = 5 * SCHEDULED_FULL_BUDGET + 20 * SCHEDULED_INCREMENTAL_BUDGET;
    expect(SCHEDULED_WORST_CASE_CALLS_PER_DAY).toBe(worst);
    expect(worst).toBeLessThanOrEqual(2000);
    // Exact allows 5,000 a day; at least 10 % of it stays for users and 1,000 for later jobs.
    expect(5000 - worst).toBeGreaterThanOrEqual(500 + 1000);
  });

  it("stops retrying a full sync after too many transient failures today", () => {
    const now = Date.parse("2026-07-15T02:00:00Z"); // 04:00 CEST
    const base = { mode: "incremental", status: "ok", startedAt: "2026-07-15T01:00:00Z" };
    expect(scheduledMode(now, null, { ...base, retryDay: "2026-07-15", retryCount: 3 })).toBe(
      "full",
    );
    expect(scheduledMode(now, null, { ...base, retryDay: "2026-07-15", retryCount: 4 })).toBe(
      "incremental",
    );
    // Yesterday's count does not carry over.
    expect(scheduledMode(now, null, { ...base, retryDay: "2026-07-14", retryCount: 9 })).toBe(
      "full",
    );
  });

  it("takes the least recently completed division first, so a short invocation rotates", async () => {
    const a = await addDivision();
    const bRow = await db
      .prepare("INSERT INTO divisions (connection_id, exact_division, name) VALUES (?1, ?2, 'B')")
      .bind(a.connectionId, a.exactDivision + 1)
      .run();
    const b = bRow.meta.last_row_id;
    const fx = new FakeExact(a.exactDivision);
    fx.divisions = [];
    const gate = fakeGate();
    let clock = Date.parse("2026-07-15T12:00:00Z");
    const deps = { transport: fx.transport, gate, now: () => clock };
    const one = () => newMeter(SUBREQUEST_RESERVE * 2 + 15); // room for one division only
    const order: number[] = [];
    for (let i = 0; i < 4; i++) {
      clock += 3_600_000;
      const r = await runScheduledExactSync(env, clock, deps, one());
      order.push(...r.ran.map((x) => x.divisionId));
    }
    expect(order).toEqual([a.id, b, a.id, b]);
  });
});

describe("no endless retries (review G1)", () => {
  beforeEach(resetSync);

  it("a full sync that failed permanently is not retried later in the window, even after an incremental tick", async () => {
    const div = await addDivision();
    const fx = new FakeExact(div.exactDivision);
    fx.divisions = [{ code: div.exactDivision, description: "BV" }];
    fx.beforeCall = (_n, req) => {
      if (req.path === "/read/financial/PayablesList") throw new ExactApiError(400, "x");
    };
    const gate = fakeGate();
    let clock = Date.parse("2026-07-15T00:00:00Z"); // 02:00 CEST
    const deps = { transport: fx.transport, gate, now: () => clock };
    const modes: string[] = [];
    for (let h = 0; h < 4; h++) {
      clock = Date.parse("2026-07-15T00:00:00Z") + h * 3_600_000; // 02:00 .. 05:00
      const r = await runScheduledExactSync(env, clock, deps);
      modes.push(`${r.ran[0]?.mode}:${r.ran[0]?.status}`);
    }
    expect(modes).toEqual(["full:error", "incremental:ok", "incremental:ok", "incremental:ok"]);
    // The next night tries again.
    clock = Date.parse("2026-07-16T00:00:00Z");
    expect((await runScheduledExactSync(env, clock, deps)).ran[0]?.mode).toBe("full");
  });

  it("skips while Exact rejects the client credentials, with one daily probe at 03:00", async () => {
    const div = await addDivision();
    await db
      .prepare("UPDATE connections SET last_error = ?2 WHERE id = ?1")
      .bind(div.connectionId, CREDENTIALS_REJECTED)
      .run();
    await db
      .prepare("INSERT INTO divisions (connection_id, exact_division, name) VALUES (?1, ?2, 'B')")
      .bind(div.connectionId, div.exactDivision + 1)
      .run();
    const fx = new FakeExact(div.exactDivision);
    fx.divisions = [];
    const gate = fakeGate();
    const deps = { transport: fx.transport, gate, now: () => Date.parse("2026-07-15T00:00:00Z") };
    for (const iso of ["2026-07-15T00:00:00Z", "2026-07-15T10:00:00Z", "2026-07-15T02:00:00Z"]) {
      expect(await runScheduledExactSync(env, Date.parse(iso), deps)).toEqual({
        ran: [],
        skipped: "credentials_rejected",
      });
    }
    expect(fx.calls).toHaveLength(0);
    // 01:00 UTC = 03:00 CEST: one incremental run of one division.
    const probe = await runScheduledExactSync(env, Date.parse("2026-07-15T01:00:00Z"), deps);
    expect(probe.skipped).toBeNull();
    expect(probe.ran).toHaveLength(1);
    expect(probe.ran[0]?.mode).toBe("incremental");
    expect(gate.started[0]?.budget).toBe(SCHEDULED_INCREMENTAL_BUDGET);
  });
});
