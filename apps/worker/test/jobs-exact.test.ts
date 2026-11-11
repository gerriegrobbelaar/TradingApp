import { amsterdamParts, nextRun } from "@camelthorn/core";
import { ExactApiError, ExactBudgetExhaustedError } from "@camelthorn/exact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CREDENTIALS_REJECTED } from "../src/exact/gate";
import { MAX_TRANSIENT_RETRIES, SUBREQUEST_RESERVE, newMeter } from "../src/exact/sync";
import {
  CREDENTIALS_PROBE_HOUR,
  FULL_SYNC_BUDGET,
  FULL_SYNC_MAX_ATTEMPTS,
  INCREMENTAL_SYNC_BUDGET,
  MAX_INCREMENTAL_RUNS_PER_DAY,
  SCHEDULED_WORST_CASE_CALLS_PER_DAY,
} from "../src/jobs/exact-handlers";
import { DEFAULT_JOBS } from "../src/jobs/defaults";
import { HANDLERS } from "../src/jobs/handlers";
import { runnerOverhead } from "../src/jobs/overhead";
import { callExact, divisionsOf } from "./job-helpers";
import { FakeExact, addDivision, db, fakeGate, resetSync } from "./sync-helpers";

const at = (iso: string) => Date.parse(iso);
const NIGHT = at("2026-07-15T00:00:00Z"); // 02:00 CEST
/** What runExactSync pre-charges for the runner (before, heartbeats to the 12-minute deadline, after). */
const RUNNER = runnerOverhead(12 * 60_000);

async function addSecondDivision(a: { connectionId: number; exactDivision: number }, name = "B") {
  const r = await db
    .prepare(
      "INSERT INTO divisions (connection_id, exact_division, name, sync_enabled) VALUES (?1, ?2, ?3, 1)",
    )
    .bind(a.connectionId, a.exactDivision + 1, name)
    .run();
  return r.meta.last_row_id;
}

describe("exact.full_sync / exact.incremental_sync handlers", () => {
  beforeEach(resetSync);

  it("skips with a code when there is no Exact connection", async () => {
    const r = await callExact("full", NIGHT, {});
    expect(r).toMatchObject({ status: "skipped", code: "no_connection" });
  });

  it("skips when the connection needs re-authorisation and makes no calls", async () => {
    await addDivision({ status: "needs_reauth" });
    const fx = new FakeExact(1);
    const r = await callExact("full", NIGHT, { transport: fx.transport, gate: fakeGate() });
    expect(r).toMatchObject({ status: "skipped", code: "not_active" });
    expect(fx.calls).toHaveLength(0);
  });

  it("skips when no administration is switched on for syncing", async () => {
    const div = await addDivision();
    await db.prepare("UPDATE divisions SET sync_enabled = 0 WHERE id = ?1").bind(div.id).run();
    expect(await callExact("incremental", NIGHT, {})).toMatchObject({
      status: "skipped",
      code: "no_divisions",
    });
  });

  it("runs the full sync with the job's budget, then the incremental one with its own", async () => {
    const div = await addDivision();
    const fx = new FakeExact(div.exactDivision);
    fx.divisions = [{ code: div.exactDivision, description: "BV" }];
    const gate = fakeGate();
    const deps = { transport: fx.transport, gate };

    const full = await callExact("full", NIGHT, deps, { runId: 11 });
    expect(full.status).toBe("ok");
    expect(divisionsOf(full)).toEqual([{ id: div.id, status: "ok" }]);
    expect(gate.started[0]?.jobId).toBe(`sync:full:${div.exactDivision}:r11`);
    expect(gate.started[0]?.budget).toBe(FULL_SYNC_BUDGET);
    expect(full.retry).toBeUndefined();

    const inc = await callExact("incremental", NIGHT + 3_600_000, deps, { runId: 12 });
    expect(inc.status).toBe("ok");
    expect(gate.started[1]?.jobId).toBe(`sync:incremental:${div.exactDivision}:r12`);
    expect(gate.started[1]?.budget).toBe(INCREMENTAL_SYNC_BUDGET);
  });

  it("takes the budget from the job (admin edit) and passes it to the gate", async () => {
    const div = await addDivision();
    const fx = new FakeExact(div.exactDivision);
    fx.divisions = [];
    const gate = fakeGate();
    await callExact("incremental", NIGHT, { transport: fx.transport, gate }, { budget: 77 });
    expect(gate.started[0]?.budget).toBe(77);
  });

  it("an error in one administration does not stop the others", async () => {
    const a = await addDivision();
    const b = await addSecondDivision(a);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fx = new FakeExact(a.exactDivision);
    fx.divisions = [];
    fx.beforeCall = (_n, req) => {
      if (req.division === a.exactDivision) throw new TypeError("boom");
    };
    const r = await callExact("incremental", at("2026-07-15T12:00:00Z"), {
      transport: fx.transport,
      gate: fakeGate(),
    });
    expect(divisionsOf(r)).toEqual([
      { id: a.id, status: "error" },
      { id: b, status: "ok" },
    ]);
    expect(r.status).toBe("partial");
  });

  it("all administrations failing is an error without a retry", async () => {
    const a = await addDivision();
    const fx = new FakeExact(a.exactDivision);
    fx.divisions = [];
    fx.beforeCall = () => {
      throw new ExactApiError(400, "bad");
    };
    const r = await callExact("full", NIGHT, { transport: fx.transport, gate: fakeGate() });
    expect(r.status).toBe("error");
    expect(r.retry).toBeUndefined();
  });

  it("leaves the remaining administrations for the next run once the subrequests run low", async () => {
    const a = await addDivision();
    await addSecondDivision(a);
    const fx = new FakeExact(a.exactDivision);
    fx.divisions = [];
    const meter = newMeter(SUBREQUEST_RESERVE * 2 + RUNNER + 15);
    const r = await callExact(
      "incremental",
      at("2026-07-15T12:00:00Z"),
      { transport: fx.transport, gate: fakeGate() },
      { meter },
    );
    expect(divisionsOf(r).map((d) => d.status)).toEqual(["ok", "partial"]);
    expect(divisionsOf(r)[1]?.why).toBe("not_reached");
    expect(meter.used).toBeLessThanOrEqual(meter.limit);
    expect(r.retry).toBeUndefined(); // the hourly job simply runs again
    // The full job asks to be re-queued for the same situation.
    await resetSync();
    const a2 = await addDivision();
    await addSecondDivision(a2);
    const fx2 = new FakeExact(a2.exactDivision);
    fx2.divisions = [];
    const full = await callExact(
      "full",
      NIGHT,
      { transport: fx2.transport, gate: fakeGate() },
      { meter: newMeter(SUBREQUEST_RESERVE * 2 + RUNNER + 300) },
    );
    if (full.status === "partial") expect(full.retry?.delaySeconds).toBeGreaterThan(0);
  });

  it("an aborted run stops before the next administration", async () => {
    const a = await addDivision();
    await addSecondDivision(a);
    const fx = new FakeExact(a.exactDivision);
    fx.divisions = [];
    const ac = new AbortController();
    ac.abort();
    const r = await callExact(
      "incremental",
      NIGHT,
      { transport: fx.transport, gate: fakeGate() },
      { signal: ac.signal },
    );
    expect(fx.calls).toHaveLength(0);
    expect(divisionsOf(r).every((d) => d.why === "not_reached")).toBe(true);
  });

  it("takes the least recently completed administration first, so a short run rotates", async () => {
    const a = await addDivision();
    const b = await addSecondDivision(a);
    const fx = new FakeExact(a.exactDivision);
    fx.divisions = [];
    const gate = fakeGate();
    let clock = at("2026-07-15T12:00:00Z");
    const deps = { transport: fx.transport, gate, now: () => clock };
    const one = () => newMeter(SUBREQUEST_RESERVE * 2 + RUNNER + 15); // room for one administration only
    const order: number[] = [];
    for (let i = 0; i < 4; i++) {
      clock += 3_600_000;
      const r = await callExact("incremental", clock, deps, { meter: one() });
      order.push(
        ...divisionsOf(r)
          .filter((d) => d.status === "ok")
          .map((d) => d.id),
      );
    }
    expect(order).toEqual([a.id, b, a.id, b]);
  });

  describe("full sync retries", () => {
    // A division whose full sync stops at the job budget (partial), then finishes on a retry.
    function budgetedExact(exactDivision: number, itemCount: number) {
      const fx = new FakeExact(exactDivision);
      fx.divisions = [{ code: exactDivision, description: "BV" }];
      fx.accounts = Array.from({ length: itemCount }, (_, i) => ({
        n: i + 1,
        name: `R${i + 1}`,
        ts: i + 1,
      }));
      let used = 0;
      let budget = 0;
      const gate = fakeGate({
        startJob: async (_id, b) => {
          used = 0;
          budget = b ?? 0;
        },
        endJob: async () => ({ used }),
      });
      fx.beforeCall = () => {
        if (used >= budget) throw new ExactBudgetExhaustedError("x");
        used++;
      };
      return { fx, gate };
    }

    it("a full sync that runs out of budget asks for a retry, which continues where it stopped", async () => {
      const div = await addDivision();
      const { fx, gate } = budgetedExact(div.exactDivision, 40); // 20 pages of 2
      const deps = { transport: fx.transport, gate };
      const first = await callExact("full", NIGHT, deps, { budget: 8, runId: 1 });
      expect(first.status).toBe("partial");
      expect(first.retry?.delaySeconds).toBe(300);
      let r = first;
      let n = 1;
      while (r.retry && n < 10) {
        n++;
        r = await callExact("full", NIGHT + n * 300_000, deps, {
          budget: 8,
          runId: n,
          trigger: "retry",
        });
      }
      expect(r.status).toBe("ok");
      expect(r.retry).toBeUndefined();
    });

    it("a retry only visits administrations whose full sync is not complete today", async () => {
      const a = await addDivision();
      const b = await addSecondDivision(a);
      const fx = new FakeExact(a.exactDivision);
      fx.divisions = [];
      const gate = fakeGate();
      const deps = { transport: fx.transport, gate };
      // Administration a completed its full sync a minute ago; b did not.
      await db
        .prepare(
          `INSERT INTO sync_state (division_id, entity, mode, last_status, last_full_completed_at, last_completed_at)
           VALUES (?1, 'run', 'full', 'ok', ?2, ?2)`,
        )
        .bind(a.id, new Date(NIGHT - 60_000).toISOString())
        .run();
      const r = await callExact("full", NIGHT, deps, { trigger: "retry" });
      expect(divisionsOf(r).sort((x, y) => x.id - y.id)).toEqual([
        { id: a.id, status: "skipped", why: "done_today" },
        { id: b, status: "ok" },
      ]);
      expect(gate.started).toHaveLength(1);
      // "Run now" is a deliberate act: it syncs everything again.
      const manual = await callExact("full", NIGHT + 600_000, deps, { trigger: "manual" });
      expect(divisionsOf(manual).map((d) => d.status)).toEqual(["ok", "ok"]);
    });

    it("a full sync that failed permanently today is not started again that day, but is tomorrow", async () => {
      const div = await addDivision();
      const fx = new FakeExact(div.exactDivision);
      fx.divisions = [{ code: div.exactDivision, description: "BV" }];
      fx.beforeCall = (_n, req) => {
        if (req.path === "/read/financial/PayablesList") throw new ExactApiError(400, "x");
      };
      const deps = { transport: fx.transport, gate: fakeGate() };
      const first = await callExact("full", NIGHT, deps);
      expect(first.status).toBe("error");
      const again = await callExact("full", NIGHT + 3_600_000, deps, { trigger: "retry" });
      // It did not complete OK today: the roll-up says so (review S4).
      expect(again).toMatchObject({ status: "partial", code: "administration_failed" });
      expect(again.retry).toBeUndefined();
      expect(divisionsOf(again)[0]?.why).toBe("failed_today");
      // The next night tries again.
      const tomorrow = await callExact("full", NIGHT + 24 * 3_600_000, deps);
      expect(tomorrow.status).toBe("error");
    });

    describe("roll-up counts administrations that did not complete today (S4)", () => {
      const seed = (divisionId: number, mode: string, status: string, o: { retry?: number } = {}) =>
        db
          .prepare(
            `INSERT INTO sync_state (division_id, entity, mode, last_status, last_started_at,
                                     last_full_completed_at, last_completed_at, retry_count, retry_day)
             VALUES (?1, 'run', ?2, ?3, ?4, ?5, ?5, ?6, '2026-07-15')`,
          )
          .bind(
            divisionId,
            mode,
            status,
            new Date(NIGHT - 60_000).toISOString(),
            status === "ok" ? new Date(NIGHT - 60_000).toISOString() : null,
            o.retry ?? 0,
          )
          .run();

      it("A: one administration partial earlier and ok on the retry, the other done today: ok", async () => {
        const a = await addDivision();
        const b = await addSecondDivision(a);
        const fx = new FakeExact(a.exactDivision);
        fx.divisions = [];
        await seed(b, "full", "ok");
        const r = await callExact(
          "full",
          NIGHT,
          { transport: fx.transport, gate: fakeGate() },
          { trigger: "retry" },
        );
        expect(r.status).toBe("ok");
        expect(r.code).toBeUndefined();
      });

      it("B: one administration ok, the other failed earlier today and is skipped: partial with administration_failed", async () => {
        const a = await addDivision();
        const b = await addSecondDivision(a);
        const fx = new FakeExact(a.exactDivision);
        fx.divisions = [];
        await seed(b, "full", "error");
        const r = await callExact(
          "full",
          NIGHT,
          { transport: fx.transport, gate: fakeGate() },
          { trigger: "retry" },
        );
        expect(r).toMatchObject({ status: "partial", code: "administration_failed" });
        expect(divisionsOf(r).find((d) => d.id === b)?.why).toBe("failed_today");
        expect(r.retry).toBeUndefined();
      });

      it("an administration that used up its retries today counts the same way", async () => {
        const a = await addDivision();
        await seed(a.id, "incremental", "partial", { retry: MAX_TRANSIENT_RETRIES + 1 });
        const r = await callExact("full", NIGHT, {
          transport: new FakeExact(1).transport,
          gate: fakeGate(),
        });
        expect(divisionsOf(r)[0]?.why).toBe("retries_used");
        expect(r).toMatchObject({ status: "partial", code: "administration_failed" });
      });

      it("a manual run ignores earlier failures and reports its own outcome", async () => {
        const a = await addDivision();
        const fx = new FakeExact(a.exactDivision);
        fx.divisions = [];
        await seed(a.id, "full", "error");
        const r = await callExact(
          "full",
          NIGHT,
          { transport: fx.transport, gate: fakeGate() },
          { trigger: "manual" },
        );
        expect(r.status).toBe("ok");
      });
    });

    it("pre-charges the runner overhead on the subrequest meter", async () => {
      const div = await addDivision();
      const fx = new FakeExact(div.exactDivision);
      fx.divisions = [];
      const meter = newMeter();
      await callExact(
        "incremental",
        NIGHT,
        { transport: fx.transport, gate: fakeGate() },
        { meter },
      );
      expect(meter.used).toBeGreaterThanOrEqual(RUNNER + 2);
    });

    it("pre-charges exactly once: before, 25 beats over the 12-minute window, after, own reads", async () => {
      const meter = newMeter();
      const r = await callExact("full", NIGHT, {}, { meter }); // no connection: nothing else spent
      expect(r.code).toBe("no_connection");
      // 3 before + (24 + 1) beats x 2 + 3 after = 56, plus the handler's two reads.
      expect(RUNNER).toBe(56);
      expect(meter.used).toBe(58);
    });

    it("stops retrying after too many transient failures today (the per-day counter)", async () => {
      const div = await addDivision();
      await db
        .prepare(
          `INSERT INTO sync_state (division_id, entity, mode, last_status, retry_count, retry_day)
           VALUES (?1, 'run', 'incremental', 'ok', ?2, '2026-07-15')`,
        )
        .bind(div.id, MAX_TRANSIENT_RETRIES + 1)
        .run();
      const fx = new FakeExact(div.exactDivision);
      const r = await callExact("full", NIGHT, { transport: fx.transport, gate: fakeGate() });
      expect(divisionsOf(r)[0]).toEqual({ id: div.id, status: "skipped", why: "retries_used" });
      expect(fx.calls).toHaveLength(0);
      // Yesterday's count does not carry over.
      const next = await callExact("full", NIGHT + 24 * 3_600_000, {
        transport: fx.transport,
        gate: fakeGate(),
      });
      expect(divisionsOf(next)[0]?.status).toBe("ok");
    });

    it("needs_reauth ends the run as an error, stops at the first administration, and never retries", async () => {
      const a = await addDivision();
      await addSecondDivision(a);
      const fx = new FakeExact(a.exactDivision);
      const { ExactAuthError } = await import("@camelthorn/exact");
      fx.beforeCall = () => {
        throw new ExactAuthError("reauth_required");
      };
      const r = await callExact("full", NIGHT, { transport: fx.transport, gate: fakeGate() });
      expect(r).toMatchObject({ status: "error", code: "needs_reauth" });
      expect(r.retry).toBeUndefined();
      expect(divisionsOf(r)).toHaveLength(1);
    });
  });

  it("skips both jobs while Exact rejects the client credentials, with one daily probe at 03:00", async () => {
    const div = await addDivision();
    await db
      .prepare("UPDATE connections SET last_error = ?2 WHERE id = ?1")
      .bind(div.connectionId, CREDENTIALS_REJECTED)
      .run();
    await addSecondDivision(div);
    const fx = new FakeExact(div.exactDivision);
    fx.divisions = [];
    const gate = fakeGate();
    const deps = { transport: fx.transport, gate };
    for (const iso of ["2026-07-15T00:00:00Z", "2026-07-15T10:00:00Z", "2026-07-15T02:00:00Z"]) {
      expect(await callExact("incremental", at(iso), deps)).toMatchObject({
        status: "skipped",
        code: "credentials_rejected",
      });
    }
    // The full sync never probes, not even at 03:00.
    expect(await callExact("full", at("2026-07-15T01:00:00Z"), deps)).toMatchObject({
      status: "skipped",
      code: "credentials_rejected",
    });
    expect(fx.calls).toHaveLength(0);
    // 01:00 UTC = 03:00 CEST: one incremental run of one administration.
    expect(CREDENTIALS_PROBE_HOUR).toBe(3);
    const probe = await callExact("incremental", at("2026-07-15T01:00:00Z"), deps);
    expect(divisionsOf(probe)).toHaveLength(1);
    expect(gate.started[0]?.budget).toBe(INCREMENTAL_SYNC_BUDGET);
  });

  it("the hourly job is cheap: divisions and relations only", async () => {
    await db.prepare("DELETE FROM settings WHERE key = 'exact.incremental_open_items'").run();
    const div = await addDivision();
    const fx = new FakeExact(div.exactDivision);
    fx.divisions = [{ code: div.exactDivision, description: "BV" }];
    await callExact("incremental", at("2026-07-15T10:00:00Z"), {
      transport: fx.transport,
      gate: fakeGate(),
    });
    expect(fx.pathsCalled().sort()).toEqual(["/sync/CRM/Accounts", "/system/Divisions"]);
  });
});

describe("Exact budget arithmetic (review G1, updated for jobs)", () => {
  it("keeps the worst case per administration at or below 2,000 Exact calls a day", () => {
    // Full sync: the first run plus MAX_TRANSIENT_RETRIES retries, 240 calls each. Hourly job:
    // 25 runs on the fall-back day, 40 calls each.
    expect(FULL_SYNC_MAX_ATTEMPTS).toBe(1 + MAX_TRANSIENT_RETRIES);
    expect(MAX_INCREMENTAL_RUNS_PER_DAY).toBe(25);
    const worst = FULL_SYNC_MAX_ATTEMPTS * FULL_SYNC_BUDGET + 25 * INCREMENTAL_SYNC_BUDGET;
    expect(SCHEDULED_WORST_CASE_CALLS_PER_DAY).toBe(worst);
    expect(worst).toBe(1960);
    expect(worst).toBeLessThanOrEqual(2000);
    // Exact allows 5,000 a day; at least 10 % of it stays for users and 1,000 for later jobs.
    expect(5000 - worst).toBeGreaterThanOrEqual(500 + 1000);
  });

  it("derives the worst case from the real schedules: fires per Amsterdam day over two years incl. DST", () => {
    // Count every fire of each seeded Exact sync job per Amsterdam calendar day, 2026-2027, with
    // the same nextRun the scheduler uses (H1 DST rule: a wildcard hour fires at every real clock
    // mark, so the fall-back day has 25 hourly fires; a fixed hour fires once).
    const maxPerDay = (name: string): number => {
      const job = DEFAULT_JOBS.find((j) => j.name === name);
      if (!job) throw new Error(name);
      const perDay = new Map<string, number>();
      let t = Date.parse("2025-12-31T23:00:00Z") - 1; // 00:00 Amsterdam, 1 January 2026
      const end = Date.parse("2027-12-31T23:00:00Z");
      for (;;) {
        const n = nextRun(job.schedule, t);
        if (n === null || n >= end) break;
        const d = amsterdamParts(n).date;
        perDay.set(d, (perDay.get(d) ?? 0) + 1);
        t = n;
      }
      return Math.max(...perDay.values());
    };
    const fullFires = maxPerDay("exact.full_sync");
    const incFires = maxPerDay("exact.incremental_sync");
    expect(fullFires).toBe(1);
    expect(incFires).toBe(MAX_INCREMENTAL_RUNS_PER_DAY);
    const attempts = (key: string) => HANDLERS[key]?.maxAttempts ?? 0;
    const budget = (n: string) => DEFAULT_JOBS.find((j) => j.name === n)?.exactBudget ?? 0;
    const worst =
      fullFires * attempts("exact.full_sync") * budget("exact.full_sync") +
      incFires * attempts("exact.incremental_sync") * budget("exact.incremental_sync");
    expect(worst).toBe(SCHEDULED_WORST_CASE_CALLS_PER_DAY);
    expect(worst).toBe(1960);
  });

  it("the seeded jobs carry exactly those budgets", () => {
    const budget = (n: string) => DEFAULT_JOBS.find((j) => j.name === n)?.exactBudget;
    expect(budget("exact.full_sync")).toBe(FULL_SYNC_BUDGET);
    expect(budget("exact.incremental_sync")).toBe(INCREMENTAL_SYNC_BUDGET);
  });
});
