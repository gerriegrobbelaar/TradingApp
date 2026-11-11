/**
 * J1 review (reviewer additions): lateness after the lease, the ECB 17:30 window end to end,
 * catch-up claims the latest slot, fx.revaluation has no lateness limit.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEuObject } from "../src/eu-object";
import { HANDLERS } from "../src/jobs/handlers";
import { executeRun, tickScheduler } from "../src/jobs/runner";
import type { HandlerDef, HandlerResult } from "../src/jobs/types";
import { FakeQueue, addJob, addRun, db, def, envWith, ok, runById, runsOf } from "./job-helpers";

const MIN = 60_000;

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.batch([db.prepare("DELETE FROM job_runs"), db.prepare("DELETE FROM jobs")]);
});

describe("too_late is decided only while holding the lease", () => {
  it("a takeover of a live executor's run is handed back, not recorded too_late", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "live-late", handler: "h" });
    const slot = Date.parse("2026-03-10T10:00:00.000Z");
    const run = await addRun(id, { scheduledFor: new Date(slot).toISOString() });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    const handlers = {
      h: def(async () => (started(), await hold, ok({ who: "first" })), {
        maxLatenessMs: 10 * MIN,
      }),
    };
    const first = executeRun(e, run, { handlers, now: () => slot + MIN });
    await hasStarted;
    // A redelivery an hour later sees a stale heartbeat, but the lease is the first executor's.
    const second = await executeRun(e, run, { handlers, staleMs: 0, now: () => slot + 60 * MIN });
    expect(second).toMatchObject({ kind: "retry" });
    expect((await runById(run)).status).toBe("running");
    release();
    expect(await first).toEqual({ kind: "ack", reason: "ok" });
    expect(await runById(run)).toMatchObject({ status: "ok", error_code: null });
  });

  it("a too_late run releases the lease it took", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "late-release", handler: "h" });
    const slot = Date.parse("2026-03-10T10:00:00.000Z");
    const run = await addRun(id, { scheduledFor: new Date(slot).toISOString() });
    const handlers = { h: def(async () => ok(), { maxLatenessMs: MIN }) };
    await executeRun(e, run, { handlers, now: () => slot + 5 * MIN });
    expect((await runById(run)).error_code).toBe("too_late");
    expect(await getEuObject(env.JOB_LOCK, "job:late-release").peek()).toBeNull();
  });
});

describe("ecb.fx_import: retries stop at 17:30", () => {
  const ecb = HANDLERS["ecb.fx_import"] as HandlerDef;

  it("16:15 + maxLatenessMs is 17:30, and the attempts fit inside it", () => {
    expect(ecb.maxLatenessMs).toBe(75 * MIN);
    // Seven retries ten minutes apart start by 17:25 at the earliest; the limit, not the count,
    // ends the window when attempts run late.
    expect((ecb.maxAttempts - 1) * 10 * MIN).toBeLessThanOrEqual(ecb.maxLatenessMs as number);
  });

  it("an attempt chain that drifts past 17:30 is cut off there, not at attempt 8", async () => {
    const q = new FakeQueue(() => clock);
    const e = envWith(q);
    // Monday 16 November 2026, 16:15 CET = 15:15 UTC.
    const slot = Date.parse("2026-11-16T15:15:00.000Z");
    let clock = slot;
    const id = await addJob({ name: "ecb", handler: "ecb" });
    const first = await addRun(id, { scheduledFor: new Date(slot).toISOString() });
    const notYet = (): Promise<HandlerResult> =>
      Promise.resolve({
        status: "skipped",
        code: "not_published",
        summary: {},
        retry: { delaySeconds: 600 },
      });
    const handlers = { ecb: { ...ecb, run: notYet } };
    let runId: number | undefined = first;
    const starts: number[] = [];
    while (runId !== undefined) {
      starts.push((clock - slot) / MIN);
      await executeRun(e, runId, { handlers, now: () => clock });
      // Each attempt takes a minute, then the 10-minute delay: 11 minutes per attempt.
      clock += 11 * MIN;
      runId = q.sent.shift()?.body.runId;
    }
    const runs = await runsOf(id);
    expect(starts).toEqual([0, 11, 22, 33, 44, 55, 66, 77]);
    expect(runs.map((r) => r.error_code)).toEqual([
      ...Array<string>(7).fill("not_published"),
      "too_late",
    ]);
  });
});

describe("catch-up after an outage", () => {
  it("claims the latest missed slot, which is then not too late", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({
      name: "inc",
      handler: "h",
      schedule: { kind: "cron", expr: "30 * * * *" },
      lastScheduledAt: "2026-03-10T06:31:00.000Z",
    });
    const now = Date.parse("2026-03-10T10:35:00.000Z"); // four slots missed
    expect((await tickScheduler(e, now)).claimed).toHaveLength(1);
    const [run] = await runsOf(id);
    expect(run?.scheduled_for).toBe("2026-03-10T10:30:00.000Z");
    const handlers = { h: def(async () => ok(), { maxLatenessMs: 45 * MIN }) };
    await executeRun(e, run?.id as number, { handlers, now: () => now + 10_000 });
    expect((await runById(run?.id as number)).status).toBe("ok");
  });
});

describe("fx.revaluation lateness", () => {
  it("has no lateness limit, so a month-end caught up days later still books that month", async () => {
    const fx = HANDLERS["fx.revaluation"] as HandlerDef;
    expect(fx.maxLatenessMs).toBeUndefined();
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "fxr", handler: "fxr" });
    const slot = "2026-10-30T15:30:00.000Z"; // last working day of October, 16:30 CET
    const run = await addRun(id, { scheduledFor: slot });
    let month: string | null = null;
    const { scheduledMonth } = await import("../src/jobs/period");
    const handlers = {
      fxr: {
        ...fx,
        run: async (ctx: Parameters<NonNullable<HandlerDef["run"]>>[0]) => {
          month = scheduledMonth(ctx);
          return ok();
        },
      },
    };
    await executeRun(e, run, { handlers, now: () => Date.parse("2026-11-04T09:00:00.000Z") });
    expect((await runById(run)).status).toBe("ok");
    expect(month).toBe("2026-10");
  });
});
