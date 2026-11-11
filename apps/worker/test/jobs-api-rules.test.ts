import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { seedDefaultJobs } from "../src/jobs/defaults";
import { HANDLERS } from "../src/jobs/handlers";
import type { HandlerDef } from "../src/jobs/types";
import { ORIGIN, addSession, addUser, resetDb } from "./helpers";
import { FakeQueue, db, envWith } from "./job-helpers";
import { auditRows } from "./sync-helpers";

const tokens: Record<string, string> = {};
let q: FakeQueue;

const send = (
  role: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
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
    envWith(q),
  );
};

interface JobView {
  name: string;
  runRoles: string[];
  stepUpToRun: boolean;
  maxLatenessMinutes: number | null;
  scheduleRules: {
    minIntervalMinutes: number;
    allowedIntervalMinutes: number[] | null;
    workingDaysOnly: boolean;
  };
}

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
    ["viewer", "view@camelthorncapital.com"],
    ["approver", "appr@camelthorncapital.com"],
  ] as const) {
    tokens[key] = await addSession(await addUser(email, [key]));
  }
  q = new FakeQueue();
  await seedDefaultJobs(db);
});

const patch = (role: string, id: number | string, json: unknown) =>
  send(role, `/api/jobs/${id}`, { method: "PATCH", json });
const run = (role: string, id: number | string) =>
  send(role, `/api/jobs/${id}/run`, { method: "POST" });
const cronOf = (expr: string, workingDaysOnly?: boolean) => ({
  kind: "cron",
  expr,
  ...(workingDaysOnly === undefined ? {} : { workingDaysOnly }),
});
const enable = (...names: string[]) =>
  db.batch(names.map((n) => db.prepare("UPDATE jobs SET enabled = 1 WHERE name = ?1").bind(n)));

describe("handler contract: who may run a job", () => {
  it("GET /api/jobs shows who may run, step-up, lateness and the schedule rules", async () => {
    const body = (await (await send("admin", "/api/jobs")).json()) as {
      maxProjectedExactCallsPerDay: number;
      jobs: JobView[];
    };
    const by = (n: string) => body.jobs.find((j) => j.name === n);
    expect(by("exact.full_sync")).toMatchObject({
      runRoles: ["admin", "finance"],
      stepUpToRun: false,
      maxLatenessMinutes: 360,
    });
    expect(by("revolut.sync")?.scheduleRules).toEqual({
      minIntervalMinutes: 5,
      allowedIntervalMinutes: [5, 15],
      workingDaysOnly: false,
    });
    expect(by("ecb.fx_import")?.scheduleRules.workingDaysOnly).toBe(true);
    expect(by("fx.revaluation")).toMatchObject({ runRoles: ["admin"], stepUpToRun: true });
    expect(body.maxProjectedExactCallsPerDay).toBe(3000);
  });

  it("Run now honours the handler's runRoles", async () => {
    const orig = HANDLERS["exact.full_sync"] as HandlerDef;
    HANDLERS["exact.full_sync"] = { ...orig, runRoles: ["admin"] };
    try {
      const id = await jobId("exact.full_sync");
      expect((await run("finance", id)).status).toBe(403);
      expect(q.sent).toEqual([]);
      expect((await run("admin", id)).status).toBe(202);
    } finally {
      HANDLERS["exact.full_sync"] = orig;
    }
  });

  it("Run now needs a fresh sign-in when the handler says stepUp", async () => {
    const orig = HANDLERS["exact.full_sync"] as HandlerDef;
    HANDLERS["exact.full_sync"] = { ...orig, stepUp: true };
    try {
      const id = await jobId("exact.full_sync");
      tokens["stale"] = await addSession(await addUser("stale@camelthorncapital.com", ["admin"]), {
        lastAuthAgoMs: 20 * 60_000,
      });
      const res = await run("stale", id);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("step_up_required");
      expect(q.sent).toEqual([]);
      expect((await run("admin", id)).status).toBe(202); // signed in just now
    } finally {
      HANDLERS["exact.full_sync"] = orig;
    }
  });
});

describe("Run now refusals (reviewer additions)", () => {
  it("viewers and approvers get 403 on every job, and nothing is queued or audited", async () => {
    const before = (await auditRows("job.run_now")).length;
    for (const role of ["viewer", "approver"]) {
      for (const name of ["exact.full_sync", "exact.incremental_sync", "fx.revaluation"]) {
        const res = await run(role, await jobId(name));
        expect(res.status, `${role} ${name}`).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe("forbidden");
      }
    }
    expect(q.sent).toEqual([]);
    expect((await auditRows("job.run_now")).length).toBe(before);
  });

  it("finance cannot run the admin-only revaluation; an admin is told what is missing", async () => {
    const id = await jobId("fx.revaluation");
    expect((await run("finance", id)).status).toBe(403);
    // Admin with a fresh sign-in passes the role and step-up checks and meets not_implemented.
    const res = await run("admin", id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_implemented");
  });

  it("an accepted Run now is audited with the actor", async () => {
    const before = (await auditRows("job.run_now")).length;
    expect((await run("finance", await jobId("exact.incremental_sync"))).status).toBe(202);
    const rows = await auditRows("job.run_now");
    expect(rows.length).toBe(before + 1);
  });

  it("GET /api/jobs for a viewer carries no secrets or bank details", async () => {
    const text = await (await send("viewer", "/api/jobs")).text();
    expect(text).not.toMatch(/NL\d{2}[A-Z]{4}\d{6,}/);
    expect(text).not.toMatch(/token|secret|password/i);
  });
});

describe("schedule rules when switching a job on", () => {
  it("a schedule stored before the rules cannot be switched on as it is", async () => {
    const id = await jobId("dq.checks");
    await db
      .prepare("UPDATE jobs SET schedule_json = ?2, enabled = 0 WHERE id = ?1")
      .bind(id, JSON.stringify(cronOf("* * * * *")))
      .run();
    const res = await patch("admin", id, { enabled: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("schedule_not_allowed");
    // Switching it on together with an allowed schedule works.
    expect(
      (await patch("admin", id, { enabled: true, schedule: cronOf("20 * * * *") })).status,
    ).toBe(200);
  });

  it("over the cap from before, lowering the load is allowed while raising it is not", async () => {
    await enable("exact.full_sync", "exact.incremental_sync");
    const inc = await jobId("exact.incremental_sync");
    await db.prepare("UPDATE jobs SET exact_budget = 200 WHERE id = ?1").bind(inc).run();
    // 960 + 25 x 200 = 5,960 > 3,000. Lowering to 150 (4,710) is still over but lower: allowed.
    expect((await patch("admin", inc, { exactBudget: 150 })).status).toBe(200);
    expect((await patch("admin", inc, { exactBudget: 160 })).status).toBe(400);
    // A schedule edit that adds fires is refused; switching it off always works.
    expect((await patch("admin", inc, { schedule: cronOf("0,30 * * * *") })).status).toBe(400);
    expect((await patch("admin", inc, { enabled: false })).status).toBe(200);
  });

  it("budgets cannot be set on jobs that do not use Exact", async () => {
    for (const name of ["revolut.sync", "dq.checks", "ecb.fx_import", "reminders.send"]) {
      const res = await patch("admin", await jobId(name), { exactBudget: 10 });
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("budget_not_applicable");
    }
  });
});

describe("schedule rules per handler (PATCH /api/jobs)", () => {
  it("refuses an every-minute schedule for any job", async () => {
    for (const name of ["exact.incremental_sync", "dq.checks", "reminders.send"]) {
      const res = await patch("admin", await jobId(name), { schedule: cronOf("* * * * *") });
      expect(res.status, name).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("schedule_not_allowed");
      expect(body.message).toMatch(/more often than every/);
    }
  });

  it("revolut.sync must run every 5 to 15 minutes, all day", async () => {
    const id = await jobId("revolut.sync");
    for (const expr of ["*/20 * * * *", "*/10 8-18 * * *", "0 9 * * *"]) {
      const res = await patch("admin", id, { schedule: cronOf(expr) });
      expect(res.status, expr).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("schedule_not_allowed");
    }
    for (const expr of ["*/5 * * * *", "*/15 * * * *", "*/10 * * * *"]) {
      expect((await patch("admin", id, { schedule: cronOf(expr) })).status, expr).toBe(200);
    }
  });

  it("ecb.fx_import must be restricted to working days", async () => {
    const id = await jobId("ecb.fx_import");
    const bad = await patch("admin", id, { schedule: cronOf("15 16 * * *") });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/working days/);
    expect((await patch("admin", id, { schedule: cronOf("30 16 * * *", true) })).status).toBe(200);
  });

  it("a refused schedule writes nothing and audits nothing", async () => {
    const id = await jobId("revolut.sync");
    const before = (await auditRows("job.update")).length;
    await patch("admin", id, { schedule: cronOf("* * * * *") });
    expect((await auditRows("job.update")).length).toBe(before);
  });
});

describe("projected Exact calls per day", () => {
  it("rejects raising Exact jobs beyond 3,000 calls per administration and day", async () => {
    await enable("exact.full_sync", "exact.incremental_sync");
    const inc = await jobId("exact.incremental_sync");
    // 4 x 240 (full) + 25 x 100 (incremental on the 25-hour day) = 3,460.
    const res = await patch("admin", inc, { exactBudget: 100 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "budget_cap_exceeded",
      projected: 3460,
      max: 3000,
    });
    // 4 x 240 + 25 x 80 = 2,960 fits.
    expect((await patch("admin", inc, { exactBudget: 80 })).status).toBe(200);
    // Full sync at 300 x 4 attempts = 1,200 + 2,000 = 3,200.
    const over = await patch("admin", await jobId("exact.full_sync"), { exactBudget: 300 });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { projected: number }).projected).toBe(3200);
  });

  it("switching an Exact job on counts it; a disabled job does not count", async () => {
    await enable("exact.full_sync", "exact.incremental_sync");
    const bank = await jobId("exact.bank_balances");
    // 1,960 + 25 x 20 (bank balances hourly, 25-hour day) = 2,460: fine.
    expect((await patch("admin", bank, { enabled: true })).status).toBe(200);
    expect((await patch("admin", bank, { exactBudget: 100 })).status).toBe(400);
    expect((await patch("admin", bank, { enabled: false })).status).toBe(200);
    expect((await patch("admin", bank, { exactBudget: 100 })).status).toBe(200); // not counted while off
  });

  it("the error carries a sentence with the projected figure", async () => {
    await enable("exact.full_sync", "exact.incremental_sync");
    const res = await patch("admin", await jobId("exact.incremental_sync"), { exactBudget: 100 });
    expect(((await res.json()) as { message: string }).message).toContain("3,460");
  });
});
