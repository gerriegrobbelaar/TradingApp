/**
 * Review G9 (ADR 0048): what a caller can reach through a gate stub, and the load-before-use rule.
 *
 * Workers RPC exposes every PROTOTYPE method of a Durable Object (TypeScript `private` and
 * `protected` are not enforced at runtime) and no instance property. Before this review
 * `accessTokenFor` (both gates) returned a plaintext access token over RPC, and `execute` / `send`
 * would have run a request past the door checks (for Revolut: past the allow-list, so a payment
 * path). They are now JS-private or instance properties; the prototype lists below are pinned so
 * any new RPC-reachable method is a reviewed change.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExactGate } from "../src/exact/gate";
import { RevolutGate } from "../src/revolut/gate";
import { registerWebhook } from "../src/revolut/webhooks";
import { loadRevolutConnection } from "../src/revolut/store";
import { gateStub, resetExact, seedConnection, stubExact, type ExactStub } from "./exact-helpers";
import {
  resetRevolut,
  revolutGate,
  rotatedOk,
  rreq,
  seedRevolut,
  stubRevolut,
  type RevolutStub,
} from "./revolut-helpers";

const protoNames = (proto: object): string[] => {
  const out = new Set<string>();
  for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p) as object) {
    if ((p as { constructor: { name: string } }).constructor.name === "DurableObject") break;
    for (const n of Object.getOwnPropertyNames(p)) if (n !== "constructor") out.add(n);
  }
  return [...out].sort();
};

/** Must never be reachable over RPC: tokens, a dispatch past the door, the raw fetch. */
const FORBIDDEN = [
  "accessTokenFor",
  "execute",
  "send",
  "refreshShared",
  "refreshOnce",
  "doRefresh",
  "fetch",
];

// The current RPC-reachable surface (prototype methods). None returns a token or sends a request
// to a provider; ExactGate.refreshAccessToken is the one deliberate exception (ADR 0015: a division
// gate gets its token from the connection's authority, another Durable Object, over RPC).
const CORE = [
  "afterPrune",
  "armAlarm",
  "blockAfter429",
  "call",
  "checkDaily",
  "checkRow",
  "claimRole",
  "defaultBudget",
  "endJob",
  "ensureJob",
  "ensureLoaded",
  "expireWaiting",
  "extraMinuteWait",
  "flushPending",
  "freshState",
  "load",
  "markCredentialsRejected",
  "migrateState",
  "minuteCap",
  "minuteWait",
  "noteClientRejected",
  "noteDispatch",
  "onBlocked",
  "onNewDay",
  "onSameDay",
  "onSpend",
  "persist",
  "pickNext",
  "pruneWindow",
  "pump",
  "purgeOldJobs",
  "request",
  "retryStash",
  "rollover",
  "spend",
  "startJob",
  "unqueue",
  "waitFor",
];
const SHARED_HOOKS = [
  "aad",
  "admit",
  "afterTokensSaved",
  "alarm",
  "apiError",
  "authorityConnectionId",
  "authorize",
  "budgetExhausted",
  "classifyFailure",
  "failureResult",
  "freshExtra",
  "freshMargin",
  "loadConnection",
  "markNeedsReauth",
  "openEndpoint",
  "persistPair",
  "persistTokens",
  "rateLimited",
  "throttle",
  "tokenError",
  "usage",
  "validate",
  "wireError",
];
const EXACT_ONLY = [
  "assertMethodAllowed",
  "authority",
  "blockFor429",
  "dayRemaining",
  "earliestRefreshAt",
  "flushUsage",
  "markDirty",
  "readRateHeaders",
  "refreshAccessToken",
  "reserve",
  "untilDayReset",
];
const REVOLUT_ONLY = ["checkWebhookTarget", "marginFor"];

const sorted = (...lists: string[][]): string[] => [...new Set(lists.flat())].sort();

type Loose = Record<string, (...a: unknown[]) => Promise<unknown>>;
const attempt = (stub: unknown, name: string, args: readonly unknown[]): Promise<string> =>
  Promise.resolve()
    .then(() => (stub as Loose)[name]?.(...args))
    .then(
      (v) => `reached:${JSON.stringify(v ?? null)}`,
      (e: unknown) => `refused:${e instanceof Error ? e.message : String(e)}`,
    );

describe("RPC surface of the gates", () => {
  it("pins the prototype methods of both classes (a new one is a reviewed change)", () => {
    expect(protoNames(ExactGate.prototype)).toEqual(sorted(CORE, SHARED_HOOKS, EXACT_ONLY));
    expect(protoNames(RevolutGate.prototype)).toEqual(sorted(CORE, SHARED_HOOKS, REVOLUT_ONLY));
    for (const n of FORBIDDEN) {
      expect(protoNames(ExactGate.prototype), n).not.toContain(n);
      expect(protoNames(RevolutGate.prototype), n).not.toContain(n);
    }
    expect(protoNames(RevolutGate.prototype)).not.toContain("refreshAccessToken");
  });

  describe("Revolut, through a real stub", () => {
    let rs: RevolutStub;
    beforeEach(async () => {
      await resetRevolut();
      rs = stubRevolut();
    });
    afterEach(() => rs.restore());

    it("no token, no dispatch past the allow-list and no fetch is reachable", async () => {
      const id = await seedRevolut({ expiresInMs: 1000 }); // a call would have to refresh
      const g = revolutGate(id);
      const pay = rreq(id, { method: "POST", path: "/pay", body: "{}" });
      for (const [name, args] of [
        ["accessTokenFor", [{ id, access_token_enc: null, expires_at: null }]],
        ["execute", [{ req: pay, enqueuedAt: 0, retried: false }]],
        ["send", ["https://b2b.revolut.com/api/1.0/pay", { method: "POST", body: "{}" }, {}]],
        ["refreshShared", [id, `connection:${id}`]],
      ] as const) {
        const r = await attempt(g, name, args);
        expect(r, name).toMatch(/^refused:/);
        expect(r).not.toContain("racc-");
      }
      expect(rs.tokenCalls).toHaveLength(0);
      expect(rs.apiCalls).toHaveLength(0);
    });
  });

  describe("Exact, through a real stub", () => {
    let es: ExactStub;
    beforeEach(async () => {
      await resetExact();
      es = stubExact();
    });
    afterEach(() => es.restore());

    it("accessTokenFor, execute, send and refreshShared are not reachable", async () => {
      const id = await seedConnection({ expiresInMs: 1000 });
      const g = gateStub(`exact-token:${id}`);
      for (const [name, args] of [
        ["accessTokenFor", [{ id, access_token_enc: null, expires_at: null }]],
        ["execute", [{ req: {}, enqueuedAt: 0, retried: false }]],
        ["send", ["https://start.exactonline.nl/api/v1/1/x", { method: "POST" }, {}]],
        ["refreshShared", [id, `authority:${id}`]],
      ] as const) {
        const r = await attempt(g, name, args);
        expect(r, name).toMatch(/^refused:/);
        expect(r).not.toContain("acc-");
      }
      expect(es.tokenCalls).toHaveLength(0);
      expect(es.apiCalls).toHaveLength(0);
    });
  });
});

describe("load before use (enforced by the core, not by each subclass)", () => {
  let rs: RevolutStub;
  beforeEach(async () => {
    await resetRevolut();
    rs = stubRevolut();
  });
  afterEach(() => rs.restore());

  type Ctor = new (s: DurableObjectState, e: typeof env) => RevolutGate;

  it("a fresh instance never pins a role over the stored one, even before its load ran", async () => {
    const a = await seedRevolut();
    const b = a + 1000; // another connection id (only one Revolut row may exist)
    expect((await revolutGate(a).call(rreq(a))).ok).toBe(true); // pins connection:a
    const out = await runInDurableObject(revolutGate(a), async (g, state) => {
      const fresh = new (g.constructor as Ctor)(state, env);
      // No explicit load(): the request itself must wait for the persisted role.
      const r = await fresh.call(rreq(b));
      return { r, role: await state.storage.get("role") };
    });
    expect(out.r).toMatchObject({ ok: false, error: { code: "connection_mismatch" } });
    expect(out.role).toBe(`connection:${a}`);
  });

  it("a refresh on a fresh instance never claims the authority over a stored role", async () => {
    const a = await seedRevolut();
    expect((await revolutGate(a).call(rreq(a))).ok).toBe(true); // pins connection:a
    const b = a + 1000;
    const out = await runInDurableObject(revolutGate(a), async (g, state) => {
      const fresh = new (g.constructor as Ctor)(state, env) as unknown as {
        refreshShared: (id: number, role: string) => Promise<{ ok: boolean; code?: string }>;
      };
      const r = await fresh.refreshShared(b, `connection:${b}`);
      return { r, role: await state.storage.get("role") };
    });
    expect(out.r).toEqual({ ok: false, code: "wrong_token_authority", retryable: false });
    expect(out.role).toBe(`connection:${a}`);
    expect(rs.tokenCalls).toHaveLength(0);
  });

  it("an alarm that is the first event after a restart still writes a stashed token pair", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    rs.token = (_f, n) => rotatedOk(n);
    await runInDurableObject(revolutGate(id), (g: RevolutGate) => {
      const orig = g.persistTokens.bind(g);
      let calls = 0;
      g.persistTokens = async (...a: Parameters<RevolutGate["persistTokens"]>) => {
        calls++;
        if (calls <= 2) throw new Error("d1 down");
        return orig(...a);
      };
    });
    expect((await revolutGate(id).call(rreq(id))).ok).toBe(true); // refreshed, pair stashed
    const after = await runInDurableObject(revolutGate(id), async (g, state) => {
      expect(await state.storage.get(`pending:${id}`)).toBeDefined();
      const fresh = new (g.constructor as Ctor)(state, env);
      await fresh.alarm(); // no load() first
      return state.storage.get(`pending:${id}`);
    });
    expect(after).toBeUndefined();
  });
});

describe("callers of a Revolut write after a 401 (write_auth_retry_refused)", () => {
  let rs: RevolutStub;
  beforeEach(async () => {
    await resetRevolut();
    rs = stubRevolut();
  });
  afterEach(() => rs.restore());

  const created = (): Response =>
    Response.json({
      id: "123e4567-e89b-12d3-a456-426614174000",
      url: "https://app.test/api/webhooks/revolut",
      events: ["TransactionCreated", "TransactionStateChanged"],
      signing_secret: "wsk_test_only_secret",
    });

  it("registerWebhook tries the create once more on the healed token and succeeds", async () => {
    await seedRevolut();
    rs.api = (c) => {
      if (c.method === "GET") return Response.json([]);
      return c.headers.authorization === "Bearer racc-0"
        ? new Response("", { status: 401 })
        : created();
    };
    const conn = await loadRevolutConnection(env.DB);
    if (!conn) throw new Error("no connection");
    const r = await registerWebhook(env, conn, "a@camelthorncapital.com", {
      appOrigin: "https://app.test",
    });
    expect(r).toEqual({ status: "registered" });
    expect(rs.apiCalls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("a second refusal is reported, not looped: exactly two creates", async () => {
    await seedRevolut();
    rs.api = (c) => (c.method === "GET" ? Response.json([]) : new Response("", { status: 401 }));
    const conn = await loadRevolutConnection(env.DB);
    if (!conn) throw new Error("no connection");
    const r = await registerWebhook(env, conn, "a@camelthorncapital.com", {
      appOrigin: "https://app.test",
    });
    expect(r).toEqual({ status: "failed", code: "write_auth_retry_refused" });
    expect(rs.apiCalls.filter((c) => c.method === "POST")).toHaveLength(2);
    const row = await loadRevolutConnection(env.DB);
    expect(row?.status).toBe("active"); // a write refusal never wipes or strands the connection
  });
});

describe("ADR 0048 invariant 3: a refused request touches no state", () => {
  const stateOf = (stub: DurableObjectStub<ExactGate> | DurableObjectStub<RevolutGate>) =>
    runInDurableObject(stub, async (_g, state) => ({
      role: await state.storage.get("role"),
      jobs: [...(await state.storage.list({ prefix: "job:" })).keys()],
    }));

  it("Revolut: a payment path refused at the door claims no role and starts no job", async () => {
    const id = 555_555;
    const r = await revolutGate(id).call(
      rreq(id, { method: "POST", path: "/pay", body: "{}", priority: "job", jobId: "pay-run" }),
    );
    expect(r).toMatchObject({ ok: false, error: { kind: "api", status: 400 } });
    expect(await stateOf(revolutGate(id))).toEqual({ role: undefined, jobs: [] });
  });

  it("Exact: a write the policy refuses claims no role and starts no job", async () => {
    const div = 777_777;
    const g = gateStub(`exact:${div}`);
    const r = await g.call({
      api: "rest",
      division: div,
      method: "POST",
      path: "/crm/Accounts",
      body: "{}",
      priority: "job",
      jobId: "write-run",
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "api", status: 403 } });
    expect(await stateOf(g)).toEqual({ role: undefined, jobs: [] });
  });
});
