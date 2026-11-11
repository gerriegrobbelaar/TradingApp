import { env } from "cloudflare:test";
import { ExactApiError } from "@camelthorn/exact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEuObject } from "../src/eu-object";
import {
  MAX_ENQUEUES,
  SWEEP_AFTER_MS,
  TICK_STAMP_EVERY_MS,
  executeRun,
  handleQueue,
  sweep,
  tickScheduler,
} from "../src/jobs/runner";
import type { HandlerResult } from "../src/jobs/types";
import {
  FakeQueue,
  addJob,
  addRun,
  db,
  def,
  envWith,
  ok,
  runById,
  runsOf,
  sleep,
} from "./job-helpers";

const T0 = Date.parse("2026-03-10T10:00:30Z"); // a Tuesday, 11:00:30 Amsterdam
const minute = (n: number) => T0 + n * 60_000;

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.batch([
    db.prepare("DELETE FROM job_runs"),
    db.prepare("DELETE FROM jobs"),
    db.prepare("DELETE FROM settings WHERE key IN ('scheduler.last_tick', 'seed.default_jobs')"),
  ]);
});

const lockOf = (name: string) => getEuObject(env.JOB_LOCK, `job:${name}`);

type RunViewWithToken = Awaited<ReturnType<typeof runById>> & { runner_token: string | null };

describe("scheduler tick: due detection and double-tick safety", () => {
  it("claims a due job once, enqueues it, and moves the baseline and next run", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({
      name: "hourly",
      schedule: { kind: "cron", expr: "0 * * * *" },
      lastScheduledAt: "2026-03-10T09:00:30.000Z",
    });
    // 11:00 Amsterdam = 10:00 UTC has passed at T0 (10:00:30): due.
    const r = await tickScheduler(e, T0);
    expect(r.claimed.map((c) => c.jobName)).toEqual(["hourly"]);
    expect(q.sent).toHaveLength(1);
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", trigger: "schedule", attempt: 1 });
    expect(runs[0]?.scheduled_for).toBe("2026-03-10T10:00:00.000Z");
    const job = await db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<{
      last_scheduled_at: string;
      next_run_at: string;
    }>();
    expect(job?.last_scheduled_at).toBe(new Date(T0).toISOString());
    expect(job?.next_run_at).toBe("2026-03-10T11:00:00.000Z");
  });

  it("a second tick in the same minute, or later before the next slot, claims nothing", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({
      name: "hourly",
      schedule: { kind: "cron", expr: "0 * * * *" },
      lastScheduledAt: "2026-03-10T09:00:30.000Z",
    });
    await tickScheduler(e, T0);
    expect(q.sent).toHaveLength(1);
    expect((await tickScheduler(e, T0)).claimed).toEqual([]);
    expect((await tickScheduler(e, minute(1))).claimed).toEqual([]);
    expect((await tickScheduler(e, minute(30))).claimed).toEqual([]);
    expect(await runsOf(id)).toHaveLength(1);
    // The next hour claims again.
    expect((await tickScheduler(e, minute(60))).claimed).toHaveLength(1);
  });

  it("overlapping ticks (two isolates at once) enqueue the slot exactly once", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({
      name: "hourly",
      schedule: { kind: "cron", expr: "0 * * * *" },
      lastScheduledAt: "2026-03-10T09:00:30.000Z",
    });
    await Promise.all([tickScheduler(e, T0), tickScheduler(e, T0), tickScheduler(e, T0 + 5)]);
    expect(await runsOf(id)).toHaveLength(1);
    expect(q.sent).toHaveLength(1);
  });

  it("the run row for a slot is unique (job, slot, attempt)", async () => {
    const id = await addJob({ name: "u" });
    await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    await expect(addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" })).rejects.toThrow();
    // A retry of the same slot is attempt 2 and fine.
    await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z", attempt: 2 });
  });

  it("missed ticks collapse into one run instead of a burst", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({
      name: "hourly",
      schedule: { kind: "cron", expr: "0 * * * *" },
      lastScheduledAt: "2026-03-10T03:00:30.000Z", // seven slots ago
    });
    await tickScheduler(e, T0);
    await tickScheduler(e, minute(1));
    expect(await runsOf(id)).toHaveLength(1);
  });

  it("does not run a job created after the last slot until its next slot", async () => {
    const q = new FakeQueue();
    const id = await addJob({
      name: "daily",
      schedule: { kind: "cron", expr: "0 2 * * *" },
      createdAt: new Date(T0 - 1000).toISOString(),
    });
    expect((await tickScheduler(envWith(q), T0)).claimed).toEqual([]);
    expect(await runsOf(id)).toEqual([]);
  });

  it("skips disabled jobs", async () => {
    const q = new FakeQueue();
    const id = await addJob({ name: "off", enabled: false });
    await tickScheduler(envWith(q), T0);
    expect(await runsOf(id)).toEqual([]);
  });

  it("one job's bad schedule does not stop the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const q = new FakeQueue();
    await db
      .prepare(
        `INSERT INTO jobs (name, handler, schedule_json, created_at) VALUES ('bad', 'bad', '{"kind":"nope"}', '2026-01-01T00:00:00Z')`,
      )
      .run();
    const good = await addJob({ name: "good" });
    const r = await tickScheduler(envWith(q), T0);
    expect(r.claimed.map((c) => c.jobName)).toEqual(["good"]);
    expect(await runsOf(good)).toHaveLength(1);
  });

  it("records the tick time so the UI can tell whether the cron trigger is set up", async () => {
    await tickScheduler(envWith(new FakeQueue()), T0);
    const v = await db
      .prepare(
        "SELECT json_extract(value_json, '$.at') AS at FROM settings WHERE key = 'scheduler.last_tick'",
      )
      .first<{ at: string }>();
    expect(v?.at).toBe(new Date(T0).toISOString());
  });

  it("rewrites the tick stamp at most every few minutes, not on every tick", async () => {
    const e = envWith(new FakeQueue());
    const at = async () =>
      (
        await db
          .prepare(
            "SELECT json_extract(value_json, '$.at') AS at FROM settings WHERE key = 'scheduler.last_tick'",
          )
          .first<{ at: string }>()
      )?.at;
    await tickScheduler(e, T0);
    await tickScheduler(e, minute(1));
    await tickScheduler(e, minute(3));
    expect(await at()).toBe(new Date(T0).toISOString());
    await tickScheduler(e, T0 + TICK_STAMP_EVERY_MS + 1);
    expect(await at()).toBe(new Date(T0 + TICK_STAMP_EVERY_MS + 1).toISOString());
    // A stamp from the future (the clock jumped back) is replaced at once.
    await tickScheduler(e, T0);
    expect(await at()).toBe(new Date(T0).toISOString());
  });

  it("a tick with nothing due reads the enabled jobs once and writes no rows", async () => {
    await addJob({ name: "idle1", schedule: { kind: "cron", expr: "0 3 * * *" } });
    await addJob({ name: "idle2", schedule: { kind: "cron", expr: "30 * * * *" } });
    await tickScheduler(envWith(new FakeQueue()), T0); // stamps the tick
    const log: { sql: string; changes: number }[] = [];
    const wrap = (st: D1PreparedStatement, sql: string): D1PreparedStatement =>
      new Proxy(st, {
        get(target, prop) {
          if (prop === "bind") return (...a: unknown[]) => wrap(target.bind(...a), sql);
          if (prop === "run" || prop === "all")
            return async () => {
              const res = await target.all();
              log.push({ sql, changes: res.meta.changes ?? 0 });
              return res;
            };
          if (prop === "first")
            return async () => {
              const res = await target.all();
              log.push({ sql, changes: res.meta.changes ?? 0 });
              return res.results[0] ?? null;
            };
          return Reflect.get(target, prop) as unknown;
        },
      });
    const counted = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
        if (prop === "batch")
          return () => {
            throw new Error("no batch expected on an idle tick");
          };
        return Reflect.get(target, prop) as unknown;
      },
    });
    const e = Object.create(envWith(new FakeQueue()), {
      DB: { value: counted, enumerable: true },
    }) as typeof env;
    const r = await tickScheduler(e, minute(1));
    expect(r.claimed).toEqual([]);
    // The stamp upsert (0 rows changed), one SELECT of the enabled jobs, one sweep SELECT.
    expect(log.map((l) => l.sql.trim().split(/\s+/)[0])).toEqual(["INSERT", "SELECT", "SELECT"]);
    expect(log.reduce((n, l) => n + l.changes, 0)).toBe(0);
  });

  it("a queue that refuses the message leaves a queued run for the sweep to re-send", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const q = new FakeQueue();
    q.fail = true;
    const e = envWith(q);
    const id = await addJob({ name: "j", lastScheduledAt: "2026-03-10T09:00:30.000Z" });
    await tickScheduler(e, T0);
    expect((await runsOf(id))[0]?.status).toBe("queued");
    q.fail = false;
    // Within the grace period nothing is re-sent; after it, the message is sent again.
    expect((await sweep(e, T0 + 60_000)).resent).toBe(0);
    expect((await sweep(e, T0 + SWEEP_AFTER_MS + 1000)).resent).toBe(1);
    expect(q.sent).toHaveLength(1);
  });
});

describe("executeRun", () => {
  it("runs the handler, records the result on the run and the job, and frees the lock", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "j1", handler: "h" });
    const run = await addRun(id);
    const calls: string[] = [];
    const handlers = {
      h: def(async (ctx) => {
        calls.push(`${ctx.job.name}:${ctx.run.id}:${ctx.trigger}`);
        return ok({ rows: 3 });
      }),
    };
    const d = await executeRun(e, run, { handlers });
    expect(d).toEqual({ kind: "ack", reason: "ok" });
    expect(calls).toEqual([`j1:${run}:schedule`]);
    const r = await runById(run);
    expect(r.status).toBe("ok");
    expect(JSON.parse(r.result_json ?? "{}")).toMatchObject({ status: "ok", summary: { rows: 3 } });
    const job = await db
      .prepare("SELECT last_status, last_run_at FROM jobs WHERE id = ?1")
      .bind(id)
      .first<{ last_status: string; last_run_at: string }>();
    expect(job?.last_status).toBe("ok");
    expect(job?.last_run_at).toBeTruthy();
    expect(await lockOf("j1").peek()).toBeNull();
  });

  it("two parallel consumers of the same job: one runs, the other is recorded as skipped", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "j2", handler: "h" });
    const a = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    const b = await addRun(id, { scheduledFor: "2026-03-10T10:01:00.000Z" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let running = 0;
    let maxRunning = 0;
    const handlers = {
      h: def(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await gate;
        running--;
        return ok();
      }),
    };
    const first = executeRun(e, a, { handlers });
    await sleep(100); // let the first take the lock
    const second = await executeRun(e, b, { handlers });
    expect(second).toEqual({ kind: "ack", reason: "skipped" });
    release();
    await first;
    expect(maxRunning).toBe(1);
    expect((await runById(a)).status).toBe("ok");
    const skipped = await runById(b);
    expect(skipped.status).toBe("skipped");
    expect(skipped.error_code).toBe("already_running");
    // The skipped one did not free the first's lock early; after both, it is free.
    expect(await lockOf("j2").peek()).toBeNull();
  });

  it("jobs lock independently", async () => {
    const e = envWith(new FakeQueue());
    const x = await addJob({ name: "jx", handler: "h" });
    const y = await addJob({ name: "jy", handler: "h" });
    const rx = await addRun(x);
    const ry = await addRun(y);
    const handlers = { h: def(async () => (await sleep(50), ok())) };
    await Promise.all([executeRun(e, rx, { handlers }), executeRun(e, ry, { handlers })]);
    expect([(await runById(rx)).status, (await runById(ry)).status]).toEqual(["ok", "ok"]);
  });

  it("is idempotent: a redelivered message for a finished run is acked and does nothing", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "j3", handler: "h" });
    const run = await addRun(id);
    let n = 0;
    const handlers = { h: def(async () => (n++, ok())) };
    await executeRun(e, run, { handlers });
    for (const status of ["ok", "error"]) {
      await db.prepare("UPDATE job_runs SET status = ?2 WHERE id = ?1").bind(run, status).run();
      expect(await executeRun(e, run, { handlers })).toEqual({
        kind: "ack",
        reason: "already_finished",
      });
    }
    expect(n).toBe(1);
    expect(await executeRun(e, 999999, { handlers })).toEqual({
      kind: "ack",
      reason: "unknown_run",
    });
  });

  it("a delivery for a run that is running with a fresh heartbeat is retried later, not run twice", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "j4", handler: "h" });
    const now = new Date().toISOString();
    const run = await addRun(id, { status: "running", startedAt: now, heartbeatAt: now });
    let n = 0;
    const d = await executeRun(e, run, { handlers: { h: def(async () => (n++, ok())) } });
    expect(d).toMatchObject({ kind: "retry" });
    expect(n).toBe(0);
    expect((await runById(run)).status).toBe("running");
  });

  it("takes over a run stuck in running (stale heartbeat) and finishes it", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "j5", handler: "h" });
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const run = await addRun(id, { status: "running", startedAt: old, heartbeatAt: old });
    let n = 0;
    const d = await executeRun(e, run, { handlers: { h: def(async () => (n++, ok())) } });
    expect(d).toEqual({ kind: "ack", reason: "ok" });
    expect(n).toBe(1);
    expect((await runById(run)).status).toBe("ok");
  });

  it("an executor that was taken over cannot overwrite the result of the new one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "j6", handler: "h" });
    const run = await addRun(id);
    const handlers = {
      h: def(async () => {
        // Someone else takes the run over while this handler is still working.
        await db
          .prepare("UPDATE job_runs SET runner_token = 'someone-else' WHERE id = ?1")
          .bind(run)
          .run();
        return ok({ late: true });
      }),
    };
    expect(await executeRun(e, run, { handlers })).toEqual({ kind: "ack", reason: "taken_over" });
    const r = await runById(run);
    expect(r.status).toBe("running");
    expect(r.result_json).toBeNull();
  });

  it("a redelivery that finds the run's own executor still holding the lease hands it back (D1 heartbeat lost, executor alive)", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "alive", handler: "h" });
    const run = await addRun(id);
    let calls = 0;
    let second: Awaited<ReturnType<typeof executeRun>> | null = null;
    let during: RunViewWithToken | null = null;
    const handlers = {
      h: def(async () => {
        calls++;
        if (calls > 1) return ok({ who: "second" });
        // The D1 heartbeat writes failed: the row looks stale, but the lease is held and fresh.
        const old = new Date(Date.now() - 10 * 60_000).toISOString();
        await db
          .prepare("UPDATE job_runs SET heartbeat_at = ?2, started_at = ?2 WHERE id = ?1")
          .bind(run, old)
          .run();
        const before = (await runById(run)) as RunViewWithToken;
        second = await executeRun(e, run, { handlers });
        during = (await runById(run)) as RunViewWithToken;
        expect(during.runner_token).toBe(before.runner_token);
        return ok({ who: "first" });
      }),
    };
    expect(await executeRun(e, run, { handlers })).toEqual({ kind: "ack", reason: "ok" });
    // The redelivery did not run the handler, did not mark the run skipped, and will look again.
    expect(calls).toBe(1);
    expect(second).toEqual({ kind: "retry", delaySeconds: 60 });
    expect((during as RunViewWithToken | null)?.status).toBe("running");
    const r = await runById(run);
    expect(r.status).toBe("ok");
    expect(JSON.parse(r.result_json ?? "{}").summary).toEqual({ who: "first" });
    expect(await lockOf("alive").peek()).toBeNull();
  });

  it("lease expired during a long handler: the takeover runs, the old executor is aborted and its later result is discarded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "slow", handler: "h" });
    const run = await addRun(id);
    let firstAborted = false;
    let secondRan = false;
    let calls = 0;
    const handlers = {
      h: def(async (ctx) => {
        if (++calls === 1) {
          // The first executor: its lease (50 ms) lapses before its first beat (at 200 ms).
          return new Promise<HandlerResult>((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              firstAborted = true;
              // It finishes AFTER the takeover finished.
              void sleep(30).then(() => resolve(ok({ who: "first" })));
            });
          });
        }
        secondRan = true;
        return ok({ who: "second" });
      }),
    };
    const first = executeRun(e, run, { handlers, lockTtlMs: 50, heartbeatMs: 200 });
    await sleep(100);
    // A redelivery (sweep resend) treats the run as stale and takes it over with a fresh lease.
    const second = await executeRun(e, run, { handlers, staleMs: 0, lockTtlMs: 5000 });
    expect(second).toEqual({ kind: "ack", reason: "ok" });
    expect(secondRan).toBe(true);
    expect(await first).toEqual({ kind: "ack", reason: "taken_over" });
    expect(firstAborted).toBe(true);
    const r = await runById(run);
    expect(r.status).toBe("ok");
    expect(JSON.parse(r.result_json ?? "{}").summary).toEqual({ who: "second" });
  });

  it("a throwing handler becomes an error run and does not stop other jobs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = envWith(new FakeQueue());
    const bad = await addJob({ name: "bad", handler: "boom" });
    const good = await addJob({ name: "good", handler: "fine" });
    const rb = await addRun(bad);
    const rg = await addRun(good);
    const handlers = {
      boom: def(async () => {
        throw new TypeError("secret detail NL91ABNA0417164300");
      }),
      fine: def(async () => ok()),
    };
    await executeRun(e, rb, { handlers });
    await executeRun(e, rg, { handlers });
    const r = await runById(rb);
    expect(r).toMatchObject({ status: "error", error_code: "handler_error" });
    expect(r.result_json).not.toContain("secret detail");
    expect(r.result_json).not.toContain("NL91");
    expect((await runById(rg)).status).toBe("ok");
    expect(await lockOf("bad").peek()).toBeNull();
  });

  it("times a handler out: the signal aborts, the run is an error, the lock is freed", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "slow", handler: "h" });
    const run = await addRun(id);
    let aborted = false;
    const handlers = {
      h: def(
        (ctx) =>
          new Promise<HandlerResult>(() => {
            ctx.signal.addEventListener("abort", () => (aborted = true));
          }),
      ),
    };
    await executeRun(e, run, { handlers, timeoutMs: 30, graceMs: 30 });
    expect(aborted).toBe(true);
    expect(await runById(run)).toMatchObject({ status: "error", error_code: "timeout" });
    expect(await lockOf("slow").peek()).toBeNull();
  });

  it("hands the handler its context: budget, deadline, trigger, requester", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "ctx", handler: "h", exactBudget: 77 });
    const run = await addRun(id, { trigger: "manual", requestedBy: "a@b.test" });
    let seen: Record<string, unknown> = {};
    const handlers = {
      h: def(async (ctx) => {
        seen = {
          budget: ctx.budget,
          trigger: ctx.trigger,
          by: ctx.run.requestedBy,
          deadlineAhead: ctx.deadlineMs > Date.now(),
          signal: ctx.signal.aborted,
          hasLog: typeof ctx.log,
        };
        return ok();
      }),
    };
    await executeRun(e, run, { handlers });
    expect(seen).toEqual({
      budget: 77,
      trigger: "manual",
      by: "a@b.test",
      deadlineAhead: true,
      signal: false,
      hasLog: "function",
    });
  });

  it("stores only a small, masked summary", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "mask", handler: "h" });
    const run = await addRun(id);
    const big = "x".repeat(6000);
    const handlers = {
      h: def(async () => ok({ iban: "NL91ABNA0417164300", token: "abc", note: big })),
    };
    await executeRun(e, run, { handlers });
    const r = await runById(run);
    expect(r.result_json).not.toContain("NL91ABNA0417164300");
    expect(JSON.parse(r.result_json ?? "{}")).toMatchObject({ status: "ok", truncated: true });
    const run2 = await addRun(id, { scheduledFor: "2026-03-10T12:00:00.000Z" });
    const handlers2 = { h: def(async () => ok({ iban: "NL91ABNA0417164300", token: "abc" })) };
    await executeRun(e, run2, { handlers: handlers2 });
    const s = (await runById(run2)).result_json ?? "";
    expect(s).not.toContain("NL91ABNA0417164300");
    expect(s).not.toContain('"abc"');
  });
});

describe("not built yet, and disabled jobs", () => {
  it("a handler without run is recorded as skipped with code not_implemented, never ok or error", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "later", handler: "later" });
    const run = await addRun(id);
    await executeRun(e, run, { handlers: { later: def(undefined, { phase: "Phase 9" }) } });
    expect(await runById(run)).toMatchObject({ status: "skipped", error_code: "not_implemented" });
    const job = await db
      .prepare("SELECT last_status FROM jobs WHERE id = ?1")
      .bind(id)
      .first<{ last_status: string }>();
    expect(job?.last_status).toBe("skipped");
  });

  it("a handler key that does not exist is treated the same way", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "ghost", handler: "no.such.handler" });
    const run = await addRun(id);
    await executeRun(e, run);
    expect(await runById(run)).toMatchObject({ status: "skipped", error_code: "not_implemented" });
  });

  it("the real registry registers every not-yet-built default as not_implemented", async () => {
    const { HANDLERS } = await import("../src/jobs/handlers");
    for (const k of [
      "revolut.sync",
      "exact.bank_balances",
      "ecb.fx_import",
      "dq.checks",
      "reminders.send",
      "fx.revaluation",
    ]) {
      expect(HANDLERS[k]?.run, k).toBeUndefined();
    }
    for (const k of ["exact.full_sync", "exact.incremental_sync"]) {
      expect(typeof HANDLERS[k]?.run, k).toBe("function");
    }
  });

  it("a scheduled or retried run of a disabled job is skipped (disabled); a manual one still runs", async () => {
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "off", handler: "h", enabled: false });
    let n = 0;
    const handlers = { h: def(async () => (n++, ok())) };
    const sched = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    const manual = await addRun(id, {
      trigger: "manual",
      scheduledFor: "2026-03-10T10:05:00.000Z",
    });
    await executeRun(e, sched, { handlers });
    expect(await runById(sched)).toMatchObject({ status: "skipped", error_code: "disabled" });
    await executeRun(e, manual, { handlers });
    expect((await runById(manual)).status).toBe("ok");
    expect(n).toBe(1);
  });
});

describe("retry policy", () => {
  const partialRetry = (): HandlerResult => ({
    status: "partial",
    code: "rate_limited",
    summary: {},
    retry: { delaySeconds: 120 },
  });

  it("re-enqueues a partial run with a delay, up to maxAttempts, then stops", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r1", handler: "h" });
    const first = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    q.sent.push({ body: { runId: first, jobId: id }, delaySeconds: 0, at: 0 });
    const handlers = { h: def(async () => partialRetry(), { maxAttempts: 3 }) };
    let guard = 0;
    while (q.sent.length > 0 && guard++ < 10) {
      const m = q.sent.shift();
      await executeRun(e, (m as { body: { runId: number } }).body.runId, { handlers });
    }
    const runs = await runsOf(id);
    expect(runs.map((r) => [r.attempt, r.status, r.trigger])).toEqual([
      [1, "partial", "schedule"],
      [2, "partial", "retry"],
      [3, "partial", "retry"],
    ]);
    // Same slot for every attempt.
    expect(new Set(runs.map((r) => r.scheduled_for)).size).toBe(1);
    expect(JSON.parse(runs[0]?.result_json ?? "{}").retry).toEqual({ attempt: 2, inSeconds: 120 });
    expect(JSON.parse(runs[2]?.result_json ?? "{}").retry).toBeUndefined();
  });

  it("sends the retry with the requested delay", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r2", handler: "h" });
    const run = await addRun(id);
    await executeRun(e, run, {
      handlers: { h: def(async () => partialRetry(), { maxAttempts: 2 }) },
    });
    expect(q.sent).toHaveLength(1);
    expect(q.sent[0]?.delaySeconds).toBe(120);
  });

  it("the sweep does not race a delayed retry: it counts from when the message becomes visible", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r2b", handler: "h" });
    const run = await addRun(id);
    const t = Date.now();
    await executeRun(e, run, {
      handlers: {
        h: def(async () => ({ ...partialRetry(), retry: { delaySeconds: 600 } }), {
          maxAttempts: 2,
        }),
      },
      now: () => t,
    });
    expect(q.sent).toHaveLength(1);
    q.sent = [];
    // 5 min + after the retry was queued, but before its 10 min delay ends: no duplicate.
    expect((await sweep(e, t + SWEEP_AFTER_MS + 60_000)).resent).toBe(0);
    // 5 min after it should have been delivered and nobody took it: re-sent.
    expect((await sweep(e, t + 600_000 + SWEEP_AFTER_MS + 1000)).resent).toBe(1);
  });

  it("bounds a handler's retry delay to the queue's 0..12 h", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r2c", handler: "h" });
    const a = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    const b = await addRun(id, { scheduledFor: "2026-03-10T10:01:00.000Z" });
    for (const [run, delay] of [
      [a, 10 ** 9],
      [b, -5],
    ] as const) {
      await executeRun(e, run, {
        handlers: {
          h: def(async () => ({ ...partialRetry(), retry: { delaySeconds: delay } }), {
            maxAttempts: 2,
          }),
        },
      });
    }
    expect(q.sent.map((m) => m.delaySeconds)).toEqual([12 * 3600, 0]);
  });

  it("does not retry errors, manual runs, or jobs with maxAttempts 1", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r3", handler: "h" });
    const err = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    await executeRun(e, err, {
      handlers: {
        h: def(async () => ({ ...partialRetry(), status: "error" }), { maxAttempts: 4 }),
      },
    });
    const manual = await addRun(id, {
      trigger: "manual",
      scheduledFor: "2026-03-10T10:01:00.000Z",
    });
    await executeRun(e, manual, {
      handlers: { h: def(async () => partialRetry(), { maxAttempts: 4 }) },
    });
    const once = await addRun(id, { scheduledFor: "2026-03-10T10:02:00.000Z" });
    await executeRun(e, once, {
      handlers: { h: def(async () => partialRetry(), { maxAttempts: 1 }) },
    });
    expect(q.sent).toEqual([]);
  });

  it("a transient exception (Exact 503) becomes partial and is retried; a permanent one is an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r4", handler: "h" });
    const a = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    await executeRun(e, a, {
      handlers: {
        h: def(
          async () => {
            throw new ExactApiError(503, "x", "gate_unavailable");
          },
          { maxAttempts: 2 },
        ),
      },
    });
    expect((await runById(a)).status).toBe("partial");
    expect(q.sent).toHaveLength(1);
    q.sent = [];
    const b = await addRun(id, { scheduledFor: "2026-03-10T11:00:00.000Z" });
    await executeRun(e, b, {
      handlers: {
        h: def(
          async () => {
            throw new ExactApiError(400, "bad");
          },
          { maxAttempts: 2 },
        ),
      },
    });
    expect((await runById(b)).status).toBe("error");
    expect(q.sent).toEqual([]);
  });

  it("a retry of a job that was switched off meanwhile is skipped", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "r5", handler: "h" });
    const run = await addRun(id);
    const handlers = { h: def(async () => partialRetry(), { maxAttempts: 3 }) };
    await executeRun(e, run, { handlers });
    await db.prepare("UPDATE jobs SET enabled = 0 WHERE id = ?1").bind(id).run();
    const next = q.sent[0]?.body.runId as number;
    await executeRun(e, next, { handlers });
    expect(await runById(next)).toMatchObject({ status: "skipped", error_code: "disabled" });
  });
});

describe("sweep", () => {
  it("re-sends a queued run nobody picked up, then gives up and marks it abandoned", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "s1" });
    const old = new Date(T0 - 10 * 60_000).toISOString();
    const run = await addRun(id, { enqueuedAt: old });
    let t = T0;
    for (let i = 1; i < MAX_ENQUEUES; i++) {
      const r = await sweep(e, t);
      expect(r.resent).toBe(1);
      t += SWEEP_AFTER_MS + 1000;
    }
    expect(q.sent).toHaveLength(MAX_ENQUEUES - 1);
    const last = await sweep(e, t);
    expect(last).toEqual({ resent: 0, abandoned: 1 });
    expect(await runById(run)).toMatchObject({ status: "error", error_code: "abandoned" });
    const job = await db
      .prepare("SELECT last_status FROM jobs WHERE id = ?1")
      .bind(id)
      .first<{ last_status: string }>();
    expect(job?.last_status).toBe("error");
  });

  it("leaves fresh queued and healthy running runs alone, and re-sends a stale running one", async () => {
    const q = new FakeQueue();
    const e = envWith(q);
    const id = await addJob({ name: "s2" });
    const fresh = new Date(T0 - 30_000).toISOString();
    const old = new Date(T0 - 20 * 60_000).toISOString();
    await addRun(id, { scheduledFor: "2026-03-10T09:00:00.000Z", enqueuedAt: fresh });
    await addRun(id, {
      scheduledFor: "2026-03-10T09:01:00.000Z",
      status: "running",
      enqueuedAt: old,
      startedAt: old,
      heartbeatAt: fresh,
    });
    const stale = await addRun(id, {
      scheduledFor: "2026-03-10T09:02:00.000Z",
      status: "running",
      enqueuedAt: old,
      startedAt: old,
      heartbeatAt: old,
    });
    const r = await sweep(e, T0);
    expect(r.resent).toBe(1);
    expect(q.sent.map((m) => m.body.runId)).toEqual([stale]);
  });
});

describe("queue consumer (fake batch)", () => {
  const msg = (body: unknown) => ({
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  });

  it("acks finished and malformed messages, retries a busy one, retries after an internal failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "qc", handler: "h" });
    const ready = await addRun(id, { scheduledFor: "2026-03-10T10:00:00.000Z" });
    const nowIso = new Date().toISOString();
    const busy = await addRun(id, {
      scheduledFor: "2026-03-10T10:01:00.000Z",
      status: "running",
      startedAt: nowIso,
      heartbeatAt: nowIso,
    });
    const handlers = { h: def(async () => ok()) };
    const good = msg({ runId: ready, jobId: id });
    const dupe = msg({ runId: ready, jobId: id });
    const bad = msg({ nope: true });
    const stuck = msg({ runId: busy, jobId: id });
    await handleQueue(
      { messages: [good, dupe, bad, stuck] } as unknown as MessageBatch<unknown>,
      e,
      { handlers },
    );
    expect(good.ack).toHaveBeenCalled();
    expect(dupe.ack).toHaveBeenCalled();
    expect(bad.ack).toHaveBeenCalled();
    expect(stuck.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(stuck.ack).not.toHaveBeenCalled();

    // A D1 failure inside the consumer: the message is retried, not lost.
    const boom = msg({ runId: ready, jobId: id });
    const broken = {
      ...e,
      DB: {
        prepare: () => {
          throw new Error("d1 down");
        },
      },
    } as unknown as typeof e;
    await handleQueue({ messages: [boom] } as unknown as MessageBatch<unknown>, broken, {
      handlers,
    });
    expect(boom.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });
});

describe("heartbeat and entry points", () => {
  it("a long job renews its lease and heartbeat; a lost lease aborts the handler", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = envWith(new FakeQueue());
    const id = await addJob({ name: "hb", handler: "h" });
    const run = await addRun(id);
    let beats = 0;
    const handlers = {
      h: def(async () => {
        const first = (await runById(run)).id;
        await sleep(120);
        const row = await db
          .prepare("SELECT heartbeat_at, started_at FROM job_runs WHERE id = ?1")
          .bind(first)
          .first<{ heartbeat_at: string; started_at: string }>();
        beats = Date.parse(row?.heartbeat_at ?? "") > Date.parse(row?.started_at ?? "") ? 1 : 0;
        // Past the original 60 ms lease, so the heartbeat must have extended it.
        const stolen = await lockOf("hb").acquire("intruder", 1000);
        return ok({ stolen: stolen.ok });
      }),
    };
    await executeRun(e, run, { handlers, lockTtlMs: 60, heartbeatMs: 20 });
    expect(beats).toBe(1);
    const r = await runById(run);
    expect(JSON.parse(r.result_json ?? "{}").summary).toEqual({ stolen: false });
    await lockOf("hb").release("intruder");

    // Lease lost: the signal aborts, the handler winds down.
    const run2 = await addRun(id, { scheduledFor: "2026-03-10T12:00:00.000Z" });
    let sawAbort = false;
    const handlers2 = {
      h: def(
        (ctx) =>
          new Promise<HandlerResult>((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              sawAbort = true;
              resolve({ status: "partial", summary: {}, code: "aborted" });
            });
            // The lease expires (60 ms TTL, first beat at 150 ms) and another run takes the lock.
            void sleep(90).then(async () => {
              await lockOf("hb").acquire("thief", 5000);
            });
          }),
      ),
    };
    await executeRun(e, run2, { handlers: handlers2, lockTtlMs: 60, heartbeatMs: 150 });
    expect(sawAbort).toBe(true);
    expect((await runById(run2)).status).toBe("partial");
    await lockOf("hb").release("thief");
  });

  it("worker.scheduled seeds the default jobs, ticks, and worker.queue runs a message", async () => {
    const { default: worker } = await import("../src/index");
    const { resetDefaultJobsMemoForTests } = await import("../src/jobs/defaults");
    resetDefaultJobsMemoForTests();
    const q = new FakeQueue();
    const e = envWith(q);
    await worker.scheduled?.(
      { scheduledTime: T0, cron: "* * * * *", noRetry() {} } as ScheduledController,
      e,
    );
    const n = await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(n?.n).toBe(8);
    const tick = await db
      .prepare("SELECT value_json FROM settings WHERE key = 'scheduler.last_tick'")
      .first();
    expect(tick).toBeTruthy();
    // A message for an unknown run is acked, not retried.
    const m = { body: { runId: 424242, jobId: 1 }, ack: vi.fn(), retry: vi.fn() };
    await worker.queue?.({ messages: [m] } as unknown as MessageBatch<unknown>, e);
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });
});

describe("JobLock", () => {
  it("grants one holder at a time, refuses others until it expires, and ignores strangers", async () => {
    const lock = lockOf("lock-1");
    expect(await lock.acquire("a", 5000)).toMatchObject({ ok: true });
    expect(await lock.acquire("b", 5000)).toMatchObject({ ok: false });
    expect(await lock.heartbeat("b", 5000)).toBe(false);
    expect(await lock.release("b")).toBe(false);
    expect((await lock.peek())?.holder).toBe("a");
    expect(await lock.heartbeat("a", 5000)).toBe(true);
    expect(await lock.release("a")).toBe(true);
    expect(await lock.acquire("b", 5000)).toMatchObject({ ok: true });
    await lock.release("b");
  });

  it("an expired lease (dead holder) can be taken over, and the dead holder cannot extend it", async () => {
    const lock = lockOf("lock-2");
    expect(await lock.acquire("dead", 20)).toMatchObject({ ok: true });
    await sleep(60);
    expect(await lock.acquire("alive", 5000)).toMatchObject({ ok: true });
    expect(await lock.heartbeat("dead", 5000)).toBe(false);
    expect((await lock.peek())?.holder).toBe("alive");
    await lock.release("alive");
  });

  it("is per job name", async () => {
    expect(await lockOf("lock-3").acquire("a", 5000)).toMatchObject({ ok: true });
    expect(await lockOf("lock-4").acquire("b", 5000)).toMatchObject({ ok: true });
    await lockOf("lock-3").release("a");
    await lockOf("lock-4").release("b");
  });
});
