import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEuObject } from "../src/eu-object";
import { createManualRun, executeRun, tickScheduler } from "../src/jobs/runner";
import type { HandlerResult } from "../src/jobs/types";
import { FakeQueue, addJob, addRun, db, def, envWith, ok, runById, runsOf } from "./job-helpers";

const SLOT = Date.parse("2026-03-10T10:00:00.000Z"); // 11:00:00 Amsterdam

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.batch([
    db.prepare("DROP TRIGGER IF EXISTS fail_retry_insert"),
    db.prepare("DELETE FROM job_runs"),
    db.prepare("DELETE FROM jobs"),
    db.prepare("DELETE FROM settings WHERE key IN ('scheduler.last_tick', 'seed.default_jobs')"),
  ]);
});

const jobRow = (id: number) =>
  db
    .prepare("SELECT last_scheduled_at, next_run_at, last_status FROM jobs WHERE id = ?1")
    .bind(id)
    .first<{
      last_scheduled_at: string | null;
      next_run_at: string | null;
      last_status: string | null;
    }>();

describe("S2: the retry attempt is part of the finish batch", () => {
  const partialWithRetry = (): HandlerResult => ({
    status: "partial",
    summary: { n: 1 },
    retry: { delaySeconds: 300 },
  });

  it("finishes the run and creates attempt 2 in one go, then enqueues it with its delay", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r1", handler: "h" });
    const run = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    await executeRun(e, run, {
      handlers: { h: def(async () => partialWithRetry(), { maxAttempts: 3 }) },
    });
    const runs = await runsOf(id);
    expect(runs.map((r) => [r.attempt, r.status, r.trigger])).toEqual([
      [1, "partial", "schedule"],
      [2, "queued", "retry"],
    ]);
    expect(q.sent).toHaveLength(1);
    expect(q.sent[0]).toMatchObject({ body: { runId: runs[1]?.id }, delaySeconds: 300 });
  });

  it("a failing retry insert rolls the whole finish back: the run stays takeover-able and no attempt is lost", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r2", handler: "h" });
    const run = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    let calls = 0;
    const handlers = {
      h: def(async () => (calls++, partialWithRetry()), { maxAttempts: 3 }),
    };
    await db
      .prepare(
        `CREATE TRIGGER fail_retry_insert BEFORE INSERT ON job_runs WHEN NEW.trigger = 'retry'
         BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
      )
      .run();
    await expect(executeRun(e, run, { handlers })).rejects.toThrow();
    // Nothing half-done: still 'running' (not finished), no job summary, no attempt 2, nothing sent.
    const stuck = await runById(run);
    expect(stuck.status).toBe("running");
    expect((await runsOf(id)).map((r) => r.attempt)).toEqual([1]);
    expect((await jobRow(id))?.last_status).toBeNull();
    expect(q.sent).toEqual([]);
    // The queue redelivers while the heartbeat is fresh: someone is on it, look again later.
    expect(await executeRun(e, run, { handlers })).toMatchObject({ kind: "retry" });
    expect(calls).toBe(1);
    // Storage recovers; once the heartbeat is stale the redelivery takes the run over and finishes.
    await db.prepare("DROP TRIGGER fail_retry_insert").run();
    expect(await executeRun(e, run, { handlers, staleMs: 0 })).toEqual({
      kind: "ack",
      reason: "partial",
    });
    expect(calls).toBe(2);
    expect((await runsOf(id)).map((r) => [r.attempt, r.status])).toEqual([
      [1, "partial"],
      [2, "queued"],
    ]);
    expect(q.sent).toHaveLength(1);
  });

  it("a redelivery after the finish does not run again nor add attempts", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r3", handler: "h" });
    const run = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    let calls = 0;
    const handlers = { h: def(async () => (calls++, partialWithRetry()), { maxAttempts: 3 }) };
    await executeRun(e, run, { handlers });
    expect(await executeRun(e, run, { handlers })).toEqual({
      kind: "ack",
      reason: "already_finished",
    });
    expect(calls).toBe(1);
    expect(await runsOf(id)).toHaveLength(2);
    expect(q.sent).toHaveLength(1);
  });

  it("when attempt 2 already exists nothing is duplicated or re-sent", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r4", handler: "h" });
    const run = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z", attempt: 2, trigger: "retry" });
    await executeRun(e, run, {
      handlers: { h: def(async () => partialWithRetry(), { maxAttempts: 3 }) },
    });
    expect(await runsOf(id)).toHaveLength(2);
    expect(q.sent).toEqual([]);
    expect((await runById(run)).status).toBe("partial");
  });

  it("a taken-over executor cannot create the retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r5", handler: "h" });
    const run = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    let n = 0;
    const handlers = {
      h: def(
        async () => {
          if (++n === 1) {
            started();
            await hold;
            return partialWithRetry();
          }
          return ok({ who: "second" });
        },
        { maxAttempts: 3 },
      ),
    };
    const first = executeRun(e, run, { handlers });
    await hasStarted;
    // The lock lease is still held by the first; the takeover is refused and handed back.
    const second = await executeRun(e, run, { handlers, staleMs: 0 });
    expect(second).toMatchObject({ kind: "retry" });
    release();
    expect(await first).toEqual({ kind: "ack", reason: "partial" });
    expect(await runsOf(id)).toHaveLength(2);
  });
});

describe("N1: one dueSlot, and a slot conflict advances the baseline", () => {
  const hourly = { kind: "cron", expr: "0 * * * *" } as const;

  it("a Run now at the exact slot millisecond does not leave the job stuck on that slot", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({
      name: "stuck",
      handler: "h",
      schedule: hourly,
      lastScheduledAt: "2026-03-10T09:00:30.000Z",
    });
    const manual = await createManualRun(e, { id, name: "stuck" }, "a@x.nl", SLOT);
    expect(manual.ok).toBe(true);
    expect((await runsOf(id))[0]?.scheduled_for).toBe(new Date(SLOT).toISOString());
    // The tick finds the slot taken. Before: it retried the same slot on every tick, for ever.
    const first = await tickScheduler(e, SLOT);
    expect(first.claimed).toEqual([]);
    const row = await jobRow(id);
    expect(row?.last_scheduled_at).toBe(new Date(SLOT).toISOString());
    expect(row?.next_run_at).toBe("2026-03-10T11:00:00.000Z");
    // Later ticks in the same hour do not even look at it; the next hour claims normally.
    expect((await tickScheduler(e, SLOT + 60_000)).claimed).toEqual([]);
    expect((await tickScheduler(e, SLOT + 3_600_000)).claimed).toHaveLength(1);
    expect(await runsOf(id)).toHaveLength(2);
  });

  it("a lost race for the slot does not move a baseline that the winner already moved", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({
      name: "race",
      handler: "h",
      schedule: hourly,
      lastScheduledAt: "2026-03-10T09:00:30.000Z",
    });
    await Promise.all([tickScheduler(e, SLOT + 5), tickScheduler(e, SLOT + 5)]);
    expect(await runsOf(id)).toHaveLength(1);
    expect((await jobRow(id))?.last_scheduled_at).toBe(new Date(SLOT + 5).toISOString());
  });

  it("corrupt clock: a baseline days in the future is claimed for the slot of the last minute", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({
      name: "corrupt",
      handler: "h",
      schedule: { kind: "cron", expr: "*/10 * * * *" },
      lastScheduledAt: new Date(SLOT + 5 * 86_400_000).toISOString(),
    });
    const now = SLOT + 10 * 60_000; // 10:10:00.000, a fire time
    const r = await tickScheduler(e, now);
    expect(r.claimed).toHaveLength(1);
    // The slot is the fire in the minute ending now, the same one isDue judged due.
    expect((await runsOf(id))[0]?.scheduled_for).toBe(new Date(now).toISOString());
    expect((await jobRow(id))?.last_scheduled_at).toBe(new Date(now).toISOString());
    expect((await tickScheduler(e, now + 60_000)).claimed).toEqual([]);
  });

  it("corrupt clock with a row already on that slot: the baseline is repaired, not retried for ever", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const future = new Date(SLOT + 5 * 86_400_000).toISOString();
    const id = await addJob({
      name: "corrupt2",
      handler: "h",
      schedule: { kind: "cron", expr: "*/10 * * * *" },
      lastScheduledAt: future,
    });
    const now = SLOT + 10 * 60_000;
    await addRun(id, { scheduledFor: new Date(now).toISOString() });
    expect((await tickScheduler(e, now)).claimed).toEqual([]);
    expect((await jobRow(id))?.last_scheduled_at).toBe(new Date(now).toISOString());
    expect(await runsOf(id)).toHaveLength(1);
  });
});

describe("N2: a lost lease is recorded as lock_lost", () => {
  it("a handler that winds down after its lease was lost ends partial / lock_lost", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "ll", handler: "h" });
    const run = await addRun(id);
    const handlers = {
      h: def(
        (ctx) =>
          new Promise<HandlerResult>((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve({ status: "partial", summary: {} }));
            void vi.waitFor(async () => {
              const got = await getEuObject(env.JOB_LOCK, "job:ll").acquire("thief", 5000);
              if (!got.ok) throw new Error("still held");
            });
          }),
      ),
    };
    await executeRun(e, run, { handlers, lockTtlMs: 40, heartbeatMs: 100 });
    const r = await runById(run);
    expect(r).toMatchObject({ status: "partial", error_code: "lock_lost" });
    await getEuObject(env.JOB_LOCK, "job:ll").release("thief");
  });

  it("a handler that ignores the abort is cut off as error / lock_lost, not timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "ll2", handler: "h" });
    const run = await addRun(id);
    const handlers = {
      h: def(
        () =>
          new Promise<HandlerResult>(() => {
            void vi.waitFor(async () => {
              const got = await getEuObject(env.JOB_LOCK, "job:ll2").acquire("thief", 5000);
              if (!got.ok) throw new Error("still held");
            });
          }),
      ),
    };
    await executeRun(e, run, { handlers, lockTtlMs: 40, heartbeatMs: 100, graceMs: 10 });
    expect(await runById(run)).toMatchObject({ status: "error", error_code: "lock_lost" });
    await getEuObject(env.JOB_LOCK, "job:ll2").release("thief");
  });

  it("a plain timeout is still a timeout", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "to", handler: "h" });
    const run = await addRun(id);
    const handlers = { h: def(() => new Promise<HandlerResult>(() => undefined)) };
    await executeRun(e, run, { handlers, timeoutMs: 20, graceMs: 10 });
    expect(await runById(run)).toMatchObject({ status: "error", error_code: "timeout" });
  });
});

describe("S1: maxLatenessMs", () => {
  const MIN = 60_000;
  const slotIso = new Date(SLOT).toISOString();
  const lateDef = (spy: { n: number }) =>
    def(async () => (spy.n++, ok()), { maxLatenessMs: 10 * MIN });

  it("a scheduled run that starts too long after its slot is skipped as too_late; the next slot runs", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "late", handler: "h" });
    const spy = { n: 0 };
    const handlers = { h: lateDef(spy) };
    const lateRun = await addRun(id, { scheduledFor: slotIso });
    await executeRun(e, lateRun, { handlers, now: () => SLOT + 11 * MIN });
    expect(await runById(lateRun)).toMatchObject({ status: "skipped", error_code: "too_late" });
    expect(JSON.parse((await runById(lateRun)).result_json ?? "{}").summary).toEqual({
      lateMinutes: 11,
    });
    expect(spy.n).toBe(0);
    const next = await addRun(id, { scheduledFor: new Date(SLOT + 60 * MIN).toISOString() });
    await executeRun(e, next, { handlers, now: () => SLOT + 61 * MIN });
    expect((await runById(next)).status).toBe("ok");
    expect(spy.n).toBe(1);
  });

  it("exactly at the limit still runs", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "edge", handler: "h" });
    const spy = { n: 0 };
    const run = await addRun(id, { scheduledFor: slotIso });
    await executeRun(e, run, { handlers: { h: lateDef(spy) }, now: () => SLOT + 10 * MIN });
    expect((await runById(run)).status).toBe("ok");
  });

  it("a late retry attempt is skipped too, a late manual run is not", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "late2", handler: "h" });
    const spy = { n: 0 };
    const handlers = { h: lateDef(spy) };
    const retry = await addRun(id, { scheduledFor: slotIso, attempt: 2, trigger: "retry" });
    await executeRun(e, retry, { handlers, now: () => SLOT + 2 * 60 * MIN });
    expect(await runById(retry)).toMatchObject({ status: "skipped", error_code: "too_late" });
    const manual = await addRun(id, {
      scheduledFor: slotIso,
      attempt: 3,
      trigger: "manual",
      requestedBy: "a@x.nl",
    });
    await executeRun(e, manual, { handlers, now: () => SLOT + 2 * 60 * MIN });
    expect((await runById(manual)).status).toBe("ok");
    expect(spy.n).toBe(1);
  });

  it("no limit means no check", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "nolimit", handler: "h" });
    const run = await addRun(id, { scheduledFor: slotIso });
    await executeRun(e, run, {
      handlers: { h: def(async () => ok()) },
      now: () => SLOT + 48 * 60 * MIN,
    });
    expect((await runById(run)).status).toBe("ok");
  });
});
