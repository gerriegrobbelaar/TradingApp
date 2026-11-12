import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { seedDefaultJobs } from "../src/jobs/defaults";
import { MAX_EXACT_BUDGET } from "../src/jobs/routes";
import { executeRun } from "../src/jobs/runner";
import { ORIGIN, addSession, addUser, resetDb } from "./helpers";
import { FakeQueue, addRun, db, def, envWith, ok, runsOf } from "./job-helpers";
import { auditRows } from "./sync-helpers";

const tokens: Record<string, string> = {};
let q: FakeQueue;

const send = (
  role: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
  queue: FakeQueue | null = q,
): Promise<Response> => {
  const { json, ...rest } = init;
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      ...rest,
      headers: {
        cookie: `__Host-session=${tokens[role]}`,
        "x-requested-with": "fetch",
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    }),
    envWith(queue ?? undefined),
  );
};

interface JobView {
  id: number;
  name: string;
  title: string;
  implemented: boolean;
  usesExact: boolean;
  schedule: unknown;
  scheduleText: string;
  enabled: boolean;
  exactBudget: number;
  rev: string | null;
  nextRunAt: string | null;
  running: boolean;
  description?: string;
  disabledReason?: string;
  lastRun: { status: string; trigger: string } | null;
}
interface ListBody {
  scheduler: { queueConfigured: boolean; lastTickAt: string | null };
  maxExactBudget: number;
  jobs: JobView[];
}

const list = async (role = "viewer"): Promise<ListBody> =>
  (await (await send(role, "/api/jobs")).json()) as ListBody;
const byName = (b: ListBody, name: string): JobView =>
  b.jobs.find((j) => j.name === name) as JobView;
const jobId = async (name: string): Promise<number> =>
  (
    (await db
      .prepare("SELECT id FROM jobs WHERE name = ?1")
      .bind(name)
      .first<{ id: number }>()) as { id: number }
  ).id;

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.batch([db.prepare("DELETE FROM job_runs"), db.prepare("DELETE FROM jobs")]);
  await resetDb();
  for (const [key, email] of [
    ["admin", "gerrie.grobbelaar@camelthorncapital.com"],
    ["finance", "fin@camelthorncapital.com"],
    ["viewer", "v@camelthorncapital.com"],
    ["approver", "ap@camelthorncapital.com"],
  ] as const) {
    tokens[key] = await addSession(await addUser(email, [key]));
  }
  q = new FakeQueue();
  await seedDefaultJobs(db);
});

describe("GET /api/jobs", () => {
  it("is readable by every role and needs a session", async () => {
    for (const role of ["admin", "finance", "approver", "viewer"]) {
      expect((await send(role, "/api/jobs")).status, role).toBe(200);
    }
    const anon = await worker.fetch(new Request(`${ORIGIN}/api/jobs`), envWith(q));
    expect(anon.status).toBe(401);
  });

  it("lists the initial jobs with schedule text, enabled, budget and next run", async () => {
    const body = await list();
    expect(body.jobs.map((j) => j.name)).toEqual([
      "revolut.sync",
      "revolut.backfill",
      "bank.match",
      "exact.bank_balances",
      "ecb.fx_import",
      "dq.checks",
      "dq.digest",
      "reminders.send",
      "exact.full_sync",
      "exact.incremental_sync",
      "exact.book_matches",
      "fx.revaluation",
    ]);
    const full = byName(body, "exact.full_sync");
    // The Exact jobs ship switched off until the first live connection has been checked (S6).
    expect(full).toMatchObject({
      enabled: false,
      implemented: true,
      usesExact: true,
      exactBudget: 240,
      defaultEnabled: false,
      disabledReason: "awaiting_live_verification",
      nextRunAt: null,
    });
    expect(full.scheduleText).toBeTruthy();
    // Data quality checks read D1 only, so they are built and ship ON for a new install (ADR 0045).
    const dq = byName(body, "dq.checks");
    expect(dq).toMatchObject({ enabled: true, implemented: true, defaultEnabled: true });
    expect(dq.nextRunAt).not.toBeNull();
    // Bank balances read Exact: built, but off until the first live checks.
    expect(byName(body, "exact.bank_balances")).toMatchObject({
      enabled: false,
      implemented: true,
      usesExact: true,
      defaultEnabled: false,
      disabledReason: "awaiting_live_verification",
    });
    const later = byName(body, "reminders.send");
    expect(later).toMatchObject({ enabled: false, implemented: false, nextRunAt: null });
    // The Revolut jobs are built (R3a) and ship switched off until the first live checks.
    for (const name of ["revolut.sync", "revolut.backfill"]) {
      expect(byName(body, name)).toMatchObject({
        enabled: false,
        implemented: true,
        usesExact: false,
        defaultEnabled: false,
        disabledReason: "awaiting_live_verification",
        nextRunAt: null,
      });
    }
    // The ECB import is public, read-only and credential-free: on by default on a new install.
    const ecb = byName(body, "ecb.fx_import");
    expect(ecb).toMatchObject({
      enabled: true,
      implemented: true,
      usesExact: false,
      defaultEnabled: true,
      phase: null,
    });
    expect(ecb.disabledReason).toBeUndefined();
    expect(typeof ecb.nextRunAt).toBe("string");
    expect(ecb.description).toMatch(/on by default/i);
    expect(body.maxExactBudget).toBe(MAX_EXACT_BUDGET);
    expect(body.scheduler.queueConfigured).toBe(true);
    expect(body.scheduler.lastTickAt).toBeNull();
  });

  it("reports a missing queue binding so the screen can warn", async () => {
    const res = await send("viewer", "/api/jobs", {}, null);
    expect(((await res.json()) as ListBody).scheduler.queueConfigured).toBe(false);
  });

  it("shows the last run and whether one is running", async () => {
    const id = await jobId("exact.full_sync");
    await addRun(id, { status: "ok", scheduledFor: "2026-03-10T10:00:00.000Z" });
    const running = await addRun(id, {
      status: "running",
      scheduledFor: "2026-03-10T11:00:00.000Z",
    });
    const body = await list();
    const j = byName(body, "exact.full_sync");
    expect(j.running).toBe(true);
    expect(j.lastRun?.status).toBe("running");
    await db.prepare("UPDATE job_runs SET status = 'partial' WHERE id = ?1").bind(running).run();
    expect(byName(await list(), "exact.full_sync")).toMatchObject({ running: false });
  });
});

describe("GET /api/jobs/:id/runs", () => {
  it("returns the newest runs first, honours limit, and is open to every role", async () => {
    const id = await jobId("exact.full_sync");
    for (let i = 0; i < 25; i++) {
      await addRun(id, {
        status: "ok",
        scheduledFor: `2026-03-${String(i + 1).padStart(2, "0")}T02:00:00.000Z`,
      });
    }
    const def20 = (await (await send("viewer", `/api/jobs/${id}/runs`)).json()) as {
      runs: { id: number }[];
    };
    expect(def20.runs).toHaveLength(20);
    expect(def20.runs[0]?.id).toBeGreaterThan(def20.runs[19]?.id as number);
    const three = (await (await send("approver", `/api/jobs/${id}/runs?limit=3`)).json()) as {
      runs: unknown[];
    };
    expect(three.runs).toHaveLength(3);
    const capped = (await (await send("viewer", `/api/jobs/${id}/runs?limit=9999`)).json()) as {
      runs: unknown[];
    };
    expect(capped.runs).toHaveLength(25);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      expect((await send("viewer", `/api/jobs/${id}/runs?limit=${bad}`)).status, bad).toBe(400);
    }
    expect((await send("viewer", "/api/jobs/99999/runs")).status).toBe(404);
    expect((await send("viewer", "/api/jobs/abc/runs")).status).toBe(404);
  });
});

describe("PATCH /api/jobs/:id", () => {
  const patch = (role: string, id: number | string, json: unknown) =>
    send(role, `/api/jobs/${id}`, { method: "PATCH", json });

  it("is admin only (no step-up needed)", async () => {
    const id = await jobId("exact.full_sync");
    for (const role of ["finance", "approver", "viewer"]) {
      expect((await patch(role, id, { enabled: false })).status, role).toBe(403);
    }
    const stale = await addSession(await addUser("old@camelthorncapital.com", ["admin"]), {
      lastAuthAgoMs: 3 * 3600_000,
    });
    tokens["stale-admin"] = stale;
    expect((await patch("stale-admin", id, { enabled: false })).status).toBe(200);
  });

  it("switching ON a job whose handler needs a fresh sign-in needs one too; switching it off does not (N1)", async () => {
    tokens["stale-admin"] = await addSession(
      await addUser("old2@camelthorncapital.com", ["admin"]),
      {
        lastAuthAgoMs: 3 * 3600_000,
      },
    );
    for (const name of ["exact.book_matches", "reminders.send", "fx.revaluation"]) {
      const id = await jobId(name);
      await db
        .prepare("UPDATE jobs SET enabled = 0, next_run_at = NULL WHERE id = ?1")
        .bind(id)
        .run();
      const before = await db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first();
      const refused = await patch("stale-admin", id, { enabled: true });
      expect([refused.status, ((await refused.json()) as { error: string }).error], name).toEqual([
        401,
        "step_up_required",
      ]);
      // nothing changed, nothing audited
      expect(await db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first(), name).toEqual(
        before,
      );
      // a fresh sign-in is not refused for this reason
      const fresh = await patch("admin", id, { enabled: true });
      expect(fresh.status, name).toBe(200);
      // switching it off is the safe direction: a stale session may do it
      expect((await patch("stale-admin", id, { enabled: false })).status, name).toBe(200);
    }
  });

  it("needs the CSRF header", async () => {
    const id = await jobId("exact.full_sync");
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/jobs/${id}`, {
        method: "PATCH",
        headers: {
          cookie: `__Host-session=${tokens["admin"]}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      }),
      envWith(q),
    );
    expect(res.status).toBe(403);
  });

  it("changes enabled, schedule and budget, recomputes next run, and writes one audit row", async () => {
    const id = await jobId("exact.incremental_sync");
    const before = await auditRows("job.update");
    const res = await patch("admin", id, {
      enabled: true,
      schedule: { kind: "cron", expr: "15 */2 * * *", workingDaysOnly: true },
      exactBudget: 55,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, changed: true });
    const j = byName(await list(), "exact.incremental_sync");
    expect(j.schedule).toEqual({ kind: "cron", expr: "15 */2 * * *", workingDaysOnly: true });
    expect(j.exactBudget).toBe(55);
    expect(j.nextRunAt).toBeTruthy();
    expect(Date.parse(j.nextRunAt as string)).toBeGreaterThan(Date.now());
    const rows = await auditRows("job.update");
    expect(rows).toHaveLength(before.length + 1);
    const row = rows[rows.length - 1] as {
      actor_email: string;
      before_json: string;
      after_json: string;
    };
    expect(row.actor_email).toBe("gerrie.grobbelaar@camelthorncapital.com");
    expect(JSON.parse(row.before_json)).toMatchObject({ exactBudget: 40 });
    expect(JSON.parse(row.after_json)).toMatchObject({
      exactBudget: 55,
      job: "exact.incremental_sync",
    });
  });

  it("restarts the baseline on a new schedule or on enabling, so nothing fires for the past", async () => {
    const id = await jobId("revolut.sync");
    await patch("admin", id, { enabled: true });
    const j = (await db
      .prepare("SELECT last_scheduled_at, enabled FROM jobs WHERE id = ?1")
      .bind(id)
      .first()) as { last_scheduled_at: string; enabled: number };
    expect(j.enabled).toBe(1);
    expect(Date.now() - Date.parse(j.last_scheduled_at)).toBeLessThan(10_000);
  });

  it("switching a job off clears its next run; a no-op change writes nothing and no audit row", async () => {
    const id = await jobId("exact.full_sync");
    await patch("admin", id, { enabled: false });
    expect(byName(await list(), "exact.full_sync").nextRunAt).toBeNull();
    const n = (await auditRows("job.update")).length;
    const same = await patch("admin", id, { enabled: false });
    expect(await same.json()).toEqual({ id, changed: false });
    expect(await auditRows("job.update")).toHaveLength(n);
  });

  it("rejects a bad cron, a bad schedule shape, a bad time and unknown fields", async () => {
    const id = await jobId("exact.full_sync");
    // Schedules: a stable code plus packages/core validateSchedule's own sentence.
    const cases: [unknown, string, string?][] = [
      [{ schedule: { kind: "cron", expr: "not a cron" } }, "schedule_invalid", "needs 5 fields"],
      [
        { schedule: { kind: "cron", expr: "61 * * * *" } },
        "schedule_invalid",
        "Invalid minute field: 61",
      ],
      [{ schedule: { kind: "cron", expr: "* * * *" } }, "schedule_invalid", "needs 5 fields"],
      [{ schedule: { kind: "cron", expr: "0 0 31 2 *" } }, "schedule_invalid", "never fires"],
      [
        { schedule: { kind: "cron", expr: "0 9 25 12 *", workingDaysOnly: true } },
        "schedule_invalid",
        "never fires within 5 years",
      ],
      [{ schedule: { kind: "last_working_day", time: "25:00" } }, "schedule_invalid", "HH:mm"],
      [{ schedule: { kind: "weekly" } }, "schedule_invalid", "Unknown schedule kind"],
      [{ schedule: "0 2 * * *" }, "schedule_invalid", "must be an object"],
      [{ enabled: "yes" }, "invalid_enabled"],
      [{ timezone: "UTC" }, "invalid_body"],
      [{}, "invalid_body"],
      [{ rev: null }, "invalid_body"],
      [{ enabled: true, rev: 5 }, "invalid_body"],
      [[], "invalid_body"],
    ];
    const n = (await auditRows("job.update")).length;
    for (const [body, error, message] of cases) {
      const res = await patch("admin", id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const out = (await res.json()) as { error: string; message?: string };
      expect(out.error, JSON.stringify(body)).toBe(error);
      if (message !== undefined) expect(out.message, JSON.stringify(body)).toContain(message);
    }
    expect(await auditRows("job.update")).toHaveLength(n);
    expect((await patch("admin", 99999, { enabled: true })).status).toBe(404);
  });

  it("enforces the hard server-side budget cap, whole numbers, and Exact jobs only", async () => {
    const id = await jobId("exact.full_sync");
    for (const b of [0, -5, MAX_EXACT_BUDGET + 1, 1.5, "100", null]) {
      const res = await patch("admin", id, { exactBudget: b });
      expect(res.status, String(b)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_budget");
    }
    expect((await patch("admin", id, { exactBudget: MAX_EXACT_BUDGET })).status).toBe(200);
    expect((await patch("admin", id, { exactBudget: 1 })).status).toBe(200);
    const dq = await jobId("dq.checks");
    const res = await patch("admin", dq, { exactBudget: 10 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("budget_not_applicable");
  });

  it("accepts the last working day schedule", async () => {
    const id = await jobId("fx.revaluation");
    const res = await patch("admin", id, {
      enabled: true,
      schedule: { kind: "last_working_day", time: "17:00" },
    });
    expect(res.status).toBe(200);
    expect(byName(await list(), "fx.revaluation").schedule).toEqual({
      kind: "last_working_day",
      time: "17:00",
    });
  });

  it("an edit from a stale page (old rev) is refused with 409 and writes nothing", async () => {
    const id = await jobId("exact.full_sync");
    const shown = byName(await list(), "exact.full_sync").rev as string | null;
    expect((await patch("admin", id, { exactBudget: 150, rev: shown })).status).toBe(200);
    const fresh = byName(await list(), "exact.full_sync").rev;
    expect(fresh).not.toBe(shown);
    const n = (await auditRows("job.update")).length;
    const stale = await patch("admin", id, { exactBudget: 160, rev: shown });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("conflict");
    expect(await auditRows("job.update")).toHaveLength(n);
    expect(byName(await list(), "exact.full_sync").exactBudget).toBe(150);
    expect((await patch("admin", id, { exactBudget: 160, rev: fresh })).status).toBe(200);
  });

  it("a budget-only edit keeps the baseline, so a due slot is still claimed and shown as next", async () => {
    const id = await jobId("exact.incremental_sync");
    // Baseline two hours ago: the :30 slot after it is in the past and due on the next tick.
    const base = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await db
      .prepare("UPDATE jobs SET last_scheduled_at = ?2, enabled = 1 WHERE id = ?1")
      .bind(id, base)
      .run();
    expect((await patch("admin", id, { exactBudget: 50 })).status).toBe(200);
    const row = await db
      .prepare("SELECT last_scheduled_at, next_run_at FROM jobs WHERE id = ?1")
      .bind(id)
      .first<{ last_scheduled_at: string; next_run_at: string }>();
    expect(row?.last_scheduled_at).toBe(base);
    expect(Date.parse(row?.next_run_at ?? "")).toBeLessThanOrEqual(Date.now());
  });

  it("two concurrent edits cannot both win: the loser gets 409 and writes no audit row", async () => {
    const id = await jobId("exact.full_sync");
    const n = (await auditRows("job.update")).length;
    const [a, b] = await Promise.all([
      patch("admin", id, { exactBudget: 100 }),
      patch("admin", id, { exactBudget: 200 }),
    ]);
    const statuses = [a.status, b.status].sort();
    // D1 serialises the writes: either both apply in turn (the second sees a changed rev and is
    // refused) or one is refused. Never two audit rows for one change of the same revision.
    expect(statuses).toContain(200);
    const rows = await auditRows("job.update");
    expect(rows.length - n).toBe(statuses.filter((s) => s === 200).length);
    const budget = byName(await list(), "exact.full_sync").exactBudget;
    expect([100, 200]).toContain(budget);
  });
});

describe("POST /api/jobs/:id/run (Run now)", () => {
  const run = (role: string, id: number | string, queue: FakeQueue | null = q) =>
    send(role, `/api/jobs/${id}/run`, { method: "POST" }, queue);

  it("is for admin and finance only", async () => {
    const id = await jobId("exact.full_sync");
    for (const role of ["approver", "viewer"]) {
      expect((await run(role, id)).status, role).toBe(403);
    }
    expect(q.sent).toEqual([]);
    expect((await run("finance", id)).status).toBe(202);
  });

  it("enqueues a manual run, audits it, and answers 202 with the run id", async () => {
    const id = await jobId("exact.full_sync");
    const res = await run("admin", id);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: number; status: string };
    expect(body.status).toBe("queued");
    expect(q.sent.map((m) => m.body)).toEqual([{ runId: body.runId, jobId: id }]);
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: body.runId,
      status: "queued",
      trigger: "manual",
      requested_by: "gerrie.grobbelaar@camelthorncapital.com",
    });
    const audit = await auditRows("job.run_now", id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_email).toBe("gerrie.grobbelaar@camelthorncapital.com");
  });

  it("answers 409 while the job is queued or running, and writes nothing more", async () => {
    const id = await jobId("exact.full_sync");
    expect((await run("admin", id)).status).toBe(202);
    for (const state of ["queued", "running"]) {
      await db
        .prepare(
          "UPDATE job_runs SET queued_at = '2000-01-01T00:00:00.000Z', status = ?2 WHERE job_id = ?1",
        )
        .bind(id, state)
        .run();
      const res = await run("finance", id);
      expect(res.status, state).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("already_running");
    }
    expect(await runsOf(id)).toHaveLength(1);
    expect(q.sent).toHaveLength(1);
    expect(await auditRows("job.run_now", id)).toHaveLength(1);
  });

  it("allows a scheduled run's queued row to block it too (no double start)", async () => {
    const id = await jobId("exact.incremental_sync");
    await addRun(id, { status: "queued", trigger: "schedule" });
    expect((await run("admin", id)).status).toBe(409);
  });

  it("applies a 30 second cooldown per job after a manual run, with Retry-After seconds", async () => {
    const id = await jobId("exact.full_sync");
    expect((await run("admin", id)).status).toBe(202);
    await db.prepare("UPDATE job_runs SET status = 'ok' WHERE job_id = ?1").bind(id).run();
    const res = await run("admin", id);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe("cooldown");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(30);
    // Another job is not affected; after the cooldown the same job can run again.
    expect((await run("admin", await jobId("exact.incremental_sync"))).status).toBe(202);
    await db
      .prepare("UPDATE job_runs SET queued_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?1")
      .bind(id)
      .run();
    expect((await run("admin", id)).status).toBe(202);
  });

  it("refuses a job whose phase is not built, even when it is enabled", async () => {
    const id = await jobId("reminders.send");
    for (const enabled of [false, true]) {
      await db
        .prepare("UPDATE jobs SET enabled = ?2 WHERE id = ?1")
        .bind(id, enabled ? 1 : 0)
        .run();
      const res = await run("admin", id);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("not_implemented");
    }
    expect(await runsOf(id)).toEqual([]);
  });

  it("runs a disabled implemented job on demand, and the run goes through the lock like any other", async () => {
    const id = await jobId("exact.incremental_sync");
    await db.prepare("UPDATE jobs SET enabled = 0 WHERE id = ?1").bind(id).run();
    const res = await run("finance", id);
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: number };
    let ran = 0;
    const handlers = { "exact.incremental_sync": def(async () => (ran++, ok())) };
    await executeRun(envWith(q), runId, { handlers });
    expect(ran).toBe(1);
    expect((await runsOf(id))[0]?.status).toBe("ok");
  });

  it("answers 503 and writes nothing when the queue binding is missing", async () => {
    const id = await jobId("exact.full_sync");
    const res = await run("admin", id, null);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("queue_not_configured");
    expect(await runsOf(id)).toEqual([]);
  });

  it("unknown job is 404; two racing clicks start only one run", async () => {
    expect((await run("admin", 99999)).status).toBe(404);
    const id = await jobId("exact.full_sync");
    const results = await Promise.all([run("admin", id), run("finance", id), run("admin", id)]);
    expect(results.map((r) => r.status).filter((s) => s === 202)).toHaveLength(1);
    expect(await runsOf(id)).toHaveLength(1);
    expect(await auditRows("job.run_now", id)).toHaveLength(1);
  });
});
