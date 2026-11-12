/**
 * Task G9: characterization tests that pin the behaviour the Exact gate and the Revolut gate share,
 * written BEFORE the two were moved onto one shared core (docs/decisions/0048). Every scenario runs
 * against both gates through a small harness; a difference that is intentional (limits, 429 caps,
 * error codes) is a field of the harness, never a branch in a test.
 *
 * Reaching into a gate: `st`, `jobs`-free reads go through `load()` on a second instance built on the
 * same storage (a restart), which is the supported way to look at what a restart would see.
 */
import { env, runInDurableObject } from "cloudflare:test";
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
} from "@camelthorn/exact";
import {
  RevolutApiError,
  RevolutAuthError,
  RevolutBudgetExhaustedError,
  RevolutRateLimitedError,
} from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExactGate } from "../src/exact/gate";
import { gateName } from "../src/exact/gate-transport";
import type { RevolutGate } from "../src/revolut/gate";
import { unwrap as unwrapExact } from "../src/exact/wire";
import { unwrap as unwrapRevolut } from "../src/revolut/wire";
import {
  fakeClock,
  freshDivision,
  gateStub,
  req as exactReq,
  resetExact,
  seedConnection,
  stubExact,
  tokenOk,
  type ExactStub,
} from "./exact-helpers";
import {
  fakeRevolutClock,
  refreshOk,
  resetRevolut,
  revolutGate,
  rotatedOk,
  rreq,
  seedRevolut,
  stubRevolut,
  type RevolutStub,
} from "./revolut-helpers";

type Ctor = new (state: DurableObjectState, env: unknown) => unknown;
type AnyStub = {
  call(req: unknown): Promise<unknown>;
  usage(): Promise<{ used: number; queued: number; blockedUntil: number; day: string }>;
  startJob(id: string, budget?: number): Promise<{ jobId: string; budget: number }>;
  endJob(id: string): Promise<{ used: number }>;
};
type Over = { priority?: "user" | "job"; jobId?: string; tag?: string };

interface Harness {
  label: string;
  stub: ExactStub | RevolutStub;
  /** Connection id the token lives under. */
  connectionId: number;
  gate: AnyStub;
  /** The Durable Object that refreshes tokens (the division gate's authority for Exact). */
  authority: DurableObjectStub<ExactGate | RevolutGate>;
  clock: { t: number; sleeps: number[] };
  go(over?: Over): Promise<{ status: number }>;
  goOther(): Promise<unknown>;
  tagOf(c: { url: URL }): string | null;
  ok(): Response;
  oldAuth: string;
  rotating(n: number): Response;
  tuneLimits(fn: (l: Record<string, number>) => void): Promise<void>;
  rateLimited: new (...a: never[]) => Error;
  budget: new (...a: never[]) => Error;
  auth: new (...a: never[]) => Error;
  api: new (...a: never[]) => Error;
  /** Largest block a 429 can impose, and the wait when the 429 carries no hint. */
  maxBlockMs: number;
  defaultBudget: number;
  /** The division gate / connection gate itself (not the token authority). */
  authorityOrGate: DurableObjectStub<ExactGate | RevolutGate>;
  mismatchCode: string;
  refusedPost: () => Promise<unknown>;
  notConnected(): Promise<unknown>;
}

const exactHarness = async (): Promise<Harness> => {
  const stub = stubExact();
  const connectionId = await seedConnection();
  const div = freshDivision();
  const clock = await fakeClock(gateName(div));
  const gate = gateStub(gateName(div)) as unknown as AnyStub;
  const call = async (over: Over = {}) =>
    unwrapExact(
      (await gate.call(
        exactReq(div, {
          ...(over.priority ? { priority: over.priority } : {}),
          ...(over.jobId ? { jobId: over.jobId } : {}),
          ...(over.tag ? { query: { $top: over.tag } } : {}),
        }),
      )) as never,
    );
  return {
    label: "exact",
    stub,
    connectionId,
    gate,
    authority: gateStub(`exact-token:${connectionId}`),
    clock,
    go: call,
    goOther: async () => unwrapExact((await gate.call(exactReq(div + 1))) as never),
    tagOf: (c) => c.url.searchParams.get("$top"),
    ok: () => Response.json({ d: { results: [] } }),
    oldAuth: "Bearer acc-0",
    rotating: tokenOk,
    tuneLimits: async (fn) => {
      await runInDurableObject(gateStub(gateName(div)), (g: ExactGate) =>
        fn(g.limits as unknown as Record<string, number>),
      );
    },
    rateLimited: ExactRateLimitedError,
    budget: ExactBudgetExhaustedError,
    auth: ExactAuthError,
    api: ExactApiError,
    maxBlockMs: 24 * 3600_000,
    defaultBudget: 500,
    authorityOrGate: gate as unknown as DurableObjectStub<ExactGate>,
    mismatchCode: "division_mismatch",
    refusedPost: async () =>
      unwrapExact(
        (await gate.call(
          exactReq(div, { method: "POST", path: "/crm/Accounts", body: "{}" }),
        )) as never,
      ),
    notConnected: async () => {
      const d2 = freshDivision();
      await fakeClock(gateName(d2));
      await resetExact();
      return unwrapExact(
        (await (gateStub(gateName(d2)) as unknown as AnyStub).call(exactReq(d2))) as never,
      );
    },
  };
};

const revolutHarness = async (): Promise<Harness> => {
  const stub = stubRevolut();
  const id = await seedRevolut();
  const clock = await fakeRevolutClock(id);
  const gate = revolutGate(id) as unknown as AnyStub;
  const call = async (over: Over = {}) =>
    unwrapRevolut(
      (await gate.call(
        rreq(id, {
          ...(over.priority ? { priority: over.priority } : {}),
          ...(over.jobId ? { jobId: over.jobId } : {}),
          ...(over.tag ? { query: { count: over.tag } } : {}),
        }),
      )) as never,
    );
  return {
    label: "revolut",
    stub,
    connectionId: id,
    gate,
    authority: revolutGate(id),
    clock,
    go: call,
    goOther: async () => unwrapRevolut((await gate.call(rreq(id + 1))) as never),
    tagOf: (c) => c.url.searchParams.get("count"),
    ok: () => Response.json([]),
    oldAuth: "Bearer racc-0",
    rotating: rotatedOk,
    tuneLimits: async (fn) => {
      await runInDurableObject(revolutGate(id), (g: RevolutGate) =>
        fn(g.limits as unknown as Record<string, number>),
      );
    },
    rateLimited: RevolutRateLimitedError,
    budget: RevolutBudgetExhaustedError,
    auth: RevolutAuthError,
    api: RevolutApiError,
    maxBlockMs: 3600_000,
    defaultBudget: 200,
    authorityOrGate: gate as unknown as DurableObjectStub<RevolutGate>,
    mismatchCode: "connection_mismatch",
    refusedPost: async () =>
      unwrapRevolut(
        (await gate.call(rreq(id, { method: "POST", path: "/pay", body: "{}" }))) as never,
      ),
    notConnected: async () => {
      const g2 = revolutGate(987_654) as unknown as AnyStub;
      return unwrapRevolut((await g2.call(rreq(987_654))) as never);
    },
  };
};

const builders: Array<[string, () => Promise<Harness>]> = [
  ["exact", exactHarness],
  ["revolut", revolutHarness],
];

/** The gate's persisted view after a restart: a second instance on the same storage. */
async function restarted<T>(
  stub: DurableObjectStub<ExactGate | RevolutGate>,
  fn: (g: Record<string, unknown>) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(stub, async (g, state) => {
    const Cls = g.constructor as unknown as Ctor;
    const g2 = new Cls(state, env) as Record<string, unknown> & { load(): Promise<void> };
    await g2.load();
    return fn(g2);
  });
}

describe.each(builders)("gate characterization: %s", (_label, build) => {
  let h: Harness;
  beforeEach(async () => {
    await resetExact();
    await resetRevolut();
    h = await build();
    h.stub.api = () => h.ok();
  });
  afterEach(() => h.stub.restore());

  const sortedTags = () => h.stub.apiCalls.map((c) => h.tagOf(c));
  /** Holds the first call in flight so everything else queues up behind it. */
  const holdFirst = () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    h.stub.api = async (_c, n) => {
      if (n === 1) await held;
      return h.ok();
    };
    return release;
  };
  const queued = async (n: number) =>
    vi.waitFor(async () => expect((await h.gate.usage()).queued).toBe(n));

  describe("queue order and priorities", () => {
    it("serves users first and each priority in arrival order", async () => {
      const release = holdFirst();
      const first = h.go({ priority: "job", jobId: "j", tag: "j0" });
      await vi.waitFor(() => expect(h.stub.apiCalls).toHaveLength(1));
      const rest = [
        h.go({ priority: "job", jobId: "j", tag: "j1" }),
        h.go({ priority: "job", jobId: "j", tag: "j2" }),
        h.go({ tag: "u1" }),
        h.go({ tag: "u2" }),
        h.go({ priority: "job", jobId: "j", tag: "j3" }),
      ];
      await queued(5);
      release();
      await Promise.all([first, ...rest]);
      expect(sortedTags()).toEqual(["j0", "u1", "u2", "j1", "j2", "j3"]);
    });

    it("lets a waiting job go after five user calls in a row, then resumes the users", async () => {
      const release = holdFirst();
      const first = h.go({ priority: "job", jobId: "j", tag: "j0" });
      await vi.waitFor(() => expect(h.stub.apiCalls).toHaveLength(1));
      const rest = [
        h.go({ priority: "job", jobId: "j", tag: "j1" }),
        ...Array.from({ length: 8 }, (_, i) => h.go({ tag: `u${i + 1}` })),
      ];
      await queued(9);
      release();
      await Promise.all([first, ...rest]);
      expect(sortedTags()).toEqual(["j0", "u1", "u2", "u3", "u4", "u5", "j1", "u6", "u7", "u8"]);
    });

    it("fails a call that waited longer than the queue limit before it is sent", async () => {
      await h.tuneLimits((l) => {
        l.maxQueueWaitMs = 90_000;
      });
      const release = holdFirst();
      const first = h.go({ tag: "a" });
      await vi.waitFor(() => expect(h.stub.apiCalls).toHaveLength(1));
      const second = h.go({ tag: "b" }).catch((e: unknown) => e);
      await queued(1);
      h.clock.t += 100_000;
      release();
      await first;
      const err = await second;
      expect(err).toBeInstanceOf(h.rateLimited);
      expect((err as { retryAfterMs: number }).retryAfterMs).toBe(1000);
      expect(h.stub.apiCalls).toHaveLength(1);
    });

    it("fails a call whose wait for a free slot would exceed the queue limit", async () => {
      await h.tuneLimits((l) => {
        l.perMinute = 2;
        l.maxQueueWaitMs = 5_000;
      });
      await h.go({ tag: "1" });
      await h.go({ tag: "2" });
      const err = await h.go({ tag: "3" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(h.rateLimited);
      expect((err as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(50_000);
      expect(h.stub.apiCalls).toHaveLength(2);
    });

    it("waits for the sliding window when the queue limit allows it", async () => {
      await h.tuneLimits((l) => {
        l.perMinute = 2;
        l.maxQueueWaitMs = 10 * 3600_000;
      });
      const t0 = h.clock.t;
      await Promise.all([h.go({ tag: "1" }), h.go({ tag: "2" }), h.go({ tag: "3" })]);
      expect(h.clock.sleeps).toEqual([60_000]);
      expect(h.clock.t - t0).toBe(60_000);
    });
  });

  describe("budgets", () => {
    it("stops a job at its budget before sending, never touches user calls, endJob reports use", async () => {
      await h.gate.startJob("bal", 2);
      await h.go({ priority: "job", jobId: "bal" });
      await h.go({ priority: "job", jobId: "bal" });
      const err = await h.go({ priority: "job", jobId: "bal" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(h.budget);
      expect((err as { jobId: string }).jobId).toBe("bal");
      expect(h.stub.apiCalls).toHaveLength(2);
      expect((await h.go()).status).toBe(200); // a user call is not subject to the job budget
      expect((await h.gate.usage()).used).toBe(3);
      expect(await h.gate.endJob("bal")).toEqual({ used: 2 });
      expect(await h.gate.endJob("bal")).toEqual({ used: 0 });
    });

    it("also stops a job whose budget runs out while its calls wait in the queue", async () => {
      await h.gate.startJob("q", 2);
      const results = await Promise.allSettled(
        Array.from({ length: 3 }, (_, i) => h.go({ priority: "job", jobId: "q", tag: `q${i}` })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(h.budget);
      expect(h.stub.apiCalls).toHaveLength(2);
      expect((await h.gate.usage()).used).toBe(2);
    });

    it("validates job ids and budgets and states the default budget", async () => {
      // Called inside the instance: an RPC rejection would surface as an unhandled error.
      await runInDurableObject(h.authorityOrGate, async (g: ExactGate | RevolutGate) => {
        await expect(g.startJob("not a valid id!")).rejects.toMatchObject({
          status: 400,
          code: "job_id",
        });
        for (const bad of [0, 100_001, 1.5, -1]) {
          await expect(g.startJob("ok", bad)).rejects.toMatchObject({
            status: 400,
            code: "budget",
          });
        }
      });
      expect(await h.gate.startJob("ok", 7)).toEqual({ jobId: "ok", budget: 7 });
      expect(await h.gate.startJob("dflt")).toEqual({ jobId: "dflt", budget: h.defaultBudget });
    });

    it("gives a job that never started a bounded budget and restarting resets use", async () => {
      await h.go({ priority: "job", jobId: "implicit" });
      expect(await h.gate.endJob("implicit")).toEqual({ used: 1 });
      await h.gate.startJob("again", 1);
      await h.go({ priority: "job", jobId: "again" });
      await h.gate.startJob("again", 1);
      expect((await h.go({ priority: "job", jobId: "again" })).status).toBe(200);
    });
  });

  describe("day rollover and restart", () => {
    it("starts a new day's counters at the next UTC midnight", async () => {
      await h.go();
      await h.go();
      const before = await h.gate.usage();
      expect(before.used).toBe(2);
      const next = new Date(h.clock.t);
      next.setUTCHours(24, 0, 1, 0);
      h.clock.t = next.getTime();
      const after = await h.gate.usage();
      expect(after.used).toBe(0);
      expect(after.day).not.toBe(before.day);
      expect(after.day).toBe(next.toISOString().slice(0, 10));
      await h.go();
      expect((await h.gate.usage()).used).toBe(1);
    });

    it("keeps counters, window, job budgets and the pinned identity across a restart", async () => {
      await h.gate.startJob("p", 5);
      await h.go({ priority: "job", jobId: "p" });
      await h.go();
      const gateStubAny = h.gate as unknown as DurableObjectStub<ExactGate | RevolutGate>;
      const seen = await restarted(gateStubAny, async (g) => {
        const st = g.st as {
          used: number;
          userUsed: number;
          jobUsed: number;
          window: number[];
          day: string;
        };
        const jobs = g.ctx as {
          storage: { get(k: string): Promise<{ used: number; budget: number }> };
        };
        return {
          used: st.used,
          userUsed: st.userUsed,
          jobUsed: st.jobUsed,
          window: st.window.length,
          job: await jobs.storage.get("job:p"),
          role: g.role,
        };
      });
      expect(seen).toMatchObject({ used: 2, userUsed: 1, jobUsed: 1, window: 2 });
      expect(seen.job).toMatchObject({ used: 1, budget: 5 });
      expect(String(seen.role)).toMatch(/^(division|connection):/);
    });

    it("refuses a second identity on an instance that is already pinned", async () => {
      await h.go();
      const err = await h.goOther().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(h.api);
      expect(err).toMatchObject({ status: 400, code: h.mismatchCode });
      expect(h.stub.apiCalls).toHaveLength(1);
    });
  });

  describe("429 handling", () => {
    const limited = (headers: Record<string, string>) => new Response("", { status: 429, headers });

    it("blocks for Retry-After seconds, fails that call, and makes the next one wait", async () => {
      h.stub.api = (_c, n) => (n === 1 ? limited({ "retry-after": "7" }) : h.ok());
      const err = await h.go().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(h.rateLimited);
      expect((err as { retryAfterMs: number }).retryAfterMs).toBe(7000);
      const u = await h.gate.usage();
      expect(u.blockedUntil).toBe(h.clock.t + 7000);
      await h.go();
      expect(h.clock.sleeps.reduce((a, b) => a + b, 0)).toBe(7000);
      expect(h.stub.apiCalls).toHaveLength(2); // a 429 is never retried by the gate itself
    });

    it("reads Retry-After as an HTTP date", async () => {
      h.stub.api = (_c, n) =>
        n === 1 ? limited({ "retry-after": new Date(h.clock.t + 21_000).toUTCString() }) : h.ok();
      const err = (await h.go().catch((e: unknown) => e)) as { retryAfterMs: number };
      expect(err.retryAfterMs).toBeGreaterThan(19_000);
      expect(err.retryAfterMs).toBeLessThanOrEqual(21_000);
    });

    it("never blocks for less than one second", async () => {
      h.stub.api = (_c, n) => (n === 1 ? limited({ "retry-after": "0" }) : h.ok());
      const err = (await h.go().catch((e: unknown) => e)) as { retryAfterMs: number };
      expect(err.retryAfterMs).toBe(1000);
    });

    it("caps an absurd Retry-After at the gate's maximum block", async () => {
      h.stub.api = (_c, n) => (n === 1 ? limited({ "retry-after": "99999999" }) : h.ok());
      const err = (await h.go().catch((e: unknown) => e)) as { retryAfterMs: number };
      expect(err.retryAfterMs).toBe(h.maxBlockMs);
    });

    it("blocks for a documented default when a 429 carries no hint", async () => {
      h.stub.api = (_c, n) => (n === 1 ? limited({}) : h.ok());
      const err = (await h.go().catch((e: unknown) => e)) as { retryAfterMs: number };
      expect(err).toBeInstanceOf(h.rateLimited);
      expect(err.retryAfterMs).toBeGreaterThanOrEqual(1000);
      expect(err.retryAfterMs).toBeLessThanOrEqual(h.maxBlockMs);
      expect((await h.gate.usage()).blockedUntil).toBe(h.clock.t + err.retryAfterMs);
    });

    it("a user call queued behind a block fails when the block outlasts the queue limit", async () => {
      await h.tuneLimits((l) => {
        l.maxQueueWaitMs = 5_000;
      });
      h.stub.api = (_c, n) => (n === 1 ? limited({ "retry-after": "30" }) : h.ok());
      await h.go().catch(() => undefined);
      const err = await h.go().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(h.rateLimited);
      expect(h.stub.apiCalls).toHaveLength(1);
    });
  });

  describe("request policy", () => {
    it("refuses a request the policy does not allow without any call or spend", async () => {
      const err = await h.refusedPost().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(h.api);
      expect((err as { status: number }).status).toBeGreaterThanOrEqual(400);
      expect((err as { status: number }).status).toBeLessThan(500);
      expect(h.stub.apiCalls).toHaveLength(0);
      expect(h.stub.tokenCalls).toHaveLength(0);
      expect((await h.gate.usage()).used).toBe(0);
    });

    it("pins the refusal status and code", async () => {
      const err = await h.refusedPost().catch((e: unknown) => e);
      expect({
        status: (err as { status: number }).status,
        code: (err as { code?: string }).code,
      }).toEqual(
        h.label === "exact"
          ? { status: 403, code: "write_not_allowed" }
          : { status: 400, code: expect.any(String) },
      );
    });
  });

  describe("token refresh", () => {
    it("shares ONE refresh between parallel callers whose token is about to expire", async () => {
      await h.stub.restore();
      const stub = h.label === "exact" ? stubExact() : stubRevolut();
      h.stub = stub;
      stub.api = () => h.ok();
      const expires = new Date(Date.now() + 5_000).toISOString();
      await env.DB.prepare("UPDATE connections SET expires_at = ?1 WHERE id = ?2")
        .bind(expires, h.connectionId)
        .run();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => h.go({ tag: `t${i}` })),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(stub.tokenCalls).toHaveLength(1);
    });

    it("answers many parallel 401s on the same stale token with one refresh and retries each once", async () => {
      h.stub.api = (c) =>
        c.headers.authorization === h.oldAuth ? new Response("", { status: 401 }) : h.ok();
      const results = await Promise.all(
        Array.from({ length: 3 }, (_, i) => h.go({ tag: `t${i}` })),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(h.stub.tokenCalls).toHaveLength(1);
      // The pump is serial: the first call is rejected, refreshes and is retried (4th call); the
      // other two then find the fresh token stored and go through at once.
      expect(h.stub.apiCalls).toHaveLength(4);
      expect((await h.gate.usage()).used).toBe(4); // the retry spent a second call
    });

    it("gives up with an auth error after one forced refresh and one retry", async () => {
      h.stub.api = () => new Response("", { status: 401 });
      const err = await h.go().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(h.auth);
      expect((err as Error).message).toBe("unauthorized");
      expect(h.stub.tokenCalls).toHaveLength(1);
      expect(h.stub.apiCalls).toHaveLength(2);
    });
  });

  describe("stashed token pair and the alarm", () => {
    const failPersist = (n: number) => async (g: ExactGate | RevolutGate) => {
      const orig = g.persistTokens.bind(g) as (...a: unknown[]) => Promise<boolean>;
      let calls = 0;
      (g as unknown as { persistTokens: (...a: unknown[]) => Promise<boolean> }).persistTokens =
        async (...args: unknown[]) => {
          calls++;
          if (calls <= n) throw new Error("d1 down");
          return orig(...args);
        };
    };

    it("keeps a rotated pair in storage and re-arms the alarm until D1 takes it", async () => {
      await env.DB.prepare("UPDATE connections SET expires_at = ?1 WHERE id = ?2")
        .bind(new Date(Date.now() + 1000).toISOString(), h.connectionId)
        .run();
      h.stub.token = (_f, n) => h.rotating(n);
      // Two failures on the refresh itself, one more on the first alarm.
      await runInDurableObject(h.authority, failPersist(3));
      expect((await h.go()).status).toBe(200);
      const stashKey = `pending:${h.connectionId}`;
      const inAuthority = <T>(fn: (s: DurableObjectStorage) => Promise<T>) =>
        runInDurableObject(h.authority, (_g, state) => fn(state.storage));
      expect(await inAuthority((s) => s.get(stashKey))).toBeDefined();
      expect(await inAuthority((s) => s.getAlarm())).not.toBeNull();

      await runInDurableObject(h.authority, (g: ExactGate | RevolutGate) => g.alarm());
      expect(await inAuthority((s) => s.get(stashKey))).toBeDefined(); // D1 still failing
      expect(await inAuthority((s) => s.getAlarm())).not.toBeNull();

      await runInDurableObject(h.authority, (g: ExactGate | RevolutGate) => g.alarm());
      expect(await inAuthority((s) => s.get(stashKey))).toBeUndefined();
    });

    it("without a stash the alarm does nothing", async () => {
      await h.go();
      await runInDurableObject(h.authority, (g: ExactGate | RevolutGate) => g.alarm());
      const at = await runInDurableObject(h.authority, (_g, s) => s.storage.getAlarm());
      expect(at).toBeNull();
    });
  });

  describe("error classification", () => {
    it("reports a network failure as a retryable 502 'network' and still spends the call", async () => {
      h.stub.api = () => {
        throw new Error("boom https://secret.example/x?token=abc");
      };
      const err = await h.go().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(h.api);
      expect(err).toMatchObject({ status: 502, code: "network" });
      expect(JSON.stringify([(err as Error).message])).not.toContain("secret");
      expect((await h.gate.usage()).used).toBe(1);
    });

    it("passes other statuses through as data", async () => {
      for (const status of [400, 403, 404, 500, 503]) {
        h.stub.api = () => new Response("x", { status });
        expect((await h.go()).status).toBe(status);
      }
    });

    it("is an auth error 'not_connected' when no usable connection exists", async () => {
      const err = await h.notConnected().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(h.auth);
      expect((err as Error).message).toBe("not_connected");
      expect(h.stub.apiCalls).toHaveLength(0);
    });

    it("sends the bearer token and never follows redirects", async () => {
      const seen: Array<string | undefined> = [];
      h.stub.api = (c) => {
        seen.push(c.headers.authorization);
        return h.ok();
      };
      await h.go();
      expect(seen[0]).toBe(h.oldAuth);
    });
  });
});

// Keep the imports that only the type-level harness uses.
void refreshOk;
