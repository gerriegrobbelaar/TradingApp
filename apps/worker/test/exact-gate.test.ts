import { runInDurableObject } from "cloudflare:test";
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  type ExactRequest,
} from "@camelthorn/exact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateTransport, gateName } from "../src/exact/gate-transport";
import type { ExactGate } from "../src/exact/gate";
import { buildUrl, validateRequest } from "../src/exact/request";
import { unwrap } from "../src/exact/wire";
import {
  auditActions,
  db,
  fakeClock,
  freshDivision,
  gateStub,
  req,
  resetExact,
  seedConnection,
  stubExact,
  storedTokens,
  tokenOk,
  type ExactStub,
} from "./exact-helpers";
import { env } from "cloudflare:test";

let stub: ExactStub;
beforeEach(async () => {
  await resetExact();
  stub = stubExact();
});
afterEach(() => {
  stub.restore();
});

const go = async (division: number, over: Partial<ExactRequest> = {}) =>
  unwrap(await gateStub(gateName(division)).call(req(division, over)));

describe("token refresh", () => {
  it("makes exactly one refresh for parallel requests and uses the new token", async () => {
    const id = await seedConnection({ expiresInMs: 10_000 }); // inside the 60 s margin
    const div = freshDivision();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => go(div, { query: { $top: String(i) } })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(stub.tokenCalls).toHaveLength(1);
    expect(stub.tokenCalls[0]?.get("grant_type")).toBe("refresh_token");
    expect(stub.tokenCalls[0]?.get("refresh_token")).toBe("ref-0");
    expect(stub.apiCalls).toHaveLength(6);
    expect(stub.apiCalls.every((c) => c.headers.authorization === "Bearer acc-1")).toBe(true);
    const stored = await storedTokens(id);
    expect(stored).toMatchObject({ access: "acc-1", refresh: "ref-1", status: "active" });
  });

  it("does not refresh again while the new token is fresh, across divisions", async () => {
    await seedConnection({ expiresInMs: 10_000 });
    await Promise.all([go(freshDivision()), go(freshDivision()), go(freshDivision())]);
    expect(stub.tokenCalls).toHaveLength(1);
    await go(freshDivision());
    expect(stub.tokenCalls).toHaveLength(1);
  });

  it("does not refresh when the token is valid for more than 60 seconds", async () => {
    await seedConnection({ expiresInMs: 120_000 });
    await go(freshDivision());
    expect(stub.tokenCalls).toHaveLength(0);
    expect(stub.apiCalls[0]?.headers.authorization).toBe("Bearer acc-0");
  });

  it("persists the rotated refresh token before the new access token is used", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    let seenAtApiCall: string | null = null;
    stub.api = async () => {
      seenAtApiCall = (await storedTokens(id)).refresh;
      return Response.json({ d: { results: [] } });
    };
    await go(freshDivision());
    expect(seenAtApiCall).toBe("ref-1");
  });

  it("marks needs_reauth and never uses the new token when persistence fails", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    const authority = gateStub(`exact-token:${id}`);
    await runInDurableObject(authority, (g: ExactGate) => {
      g.persistTokens = async () => {
        throw new Error("d1 down");
      };
    });
    const before = await auditActions("connection.exact_needs_reauth");
    await expect(go(freshDivision())).rejects.toBeInstanceOf(ExactAuthError);
    expect(stub.apiCalls).toHaveLength(0);
    const s = await storedTokens(id);
    expect(s).toMatchObject({
      status: "needs_reauth",
      access: null,
      refresh: null,
      lastError: "token_persist_failed",
    });
    expect(await auditActions("connection.exact_needs_reauth")).toBe(before + 1);
  });

  it("invalid_grant marks needs_reauth, audits, and throws ExactAuthError", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    stub.token = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const before = await auditActions("connection.exact_needs_reauth");
    await expect(go(freshDivision())).rejects.toBeInstanceOf(ExactAuthError);
    expect(stub.apiCalls).toHaveLength(0);
    expect((await storedTokens(id)).status).toBe("needs_reauth");
    expect((await storedTokens(id)).lastError).toBe("invalid_grant");
    expect(await auditActions("connection.exact_needs_reauth")).toBe(before + 1);
    // Further calls fail fast without touching Exact.
    stub.tokenCalls.length = 0;
    await expect(go(freshDivision())).rejects.toBeInstanceOf(ExactAuthError);
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("treats a transient token endpoint failure as retryable and keeps the tokens", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    stub.token = () => new Response("oops", { status: 503 });
    await expect(go(freshDivision())).rejects.toMatchObject({ name: "ExactApiError", status: 503 });
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-0" });
  });

  it("does not wipe tokens when Exact rejects our client credentials", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    stub.token = () => Response.json({ error: "invalid_client" }, { status: 401 });
    await expect(go(freshDivision())).rejects.toBeInstanceOf(ExactAuthError);
    expect((await storedTokens(id)).status).toBe("active");
  });

  it("is an auth error when nothing is connected", async () => {
    await expect(go(freshDivision())).rejects.toMatchObject({
      name: "ExactAuthError",
      message: "not_connected",
    });
    expect(stub.apiCalls).toHaveLength(0);
  });

  it("forces one refresh and retries once on a 401, then gives up", async () => {
    const id = await seedConnection({ expiresInMs: 3600_000 });
    stub.api = (_c, n) =>
      n === 1 ? new Response("", { status: 401 }) : Response.json({ d: { results: [] } });
    const res = await go(freshDivision());
    expect(res.status).toBe(200);
    expect(stub.tokenCalls).toHaveLength(1);
    expect(stub.apiCalls.map((c) => c.headers.authorization)).toEqual([
      "Bearer acc-0",
      "Bearer acc-1",
    ]);
    expect((await storedTokens(id)).refresh).toBe("ref-1");

    stub.api = () => new Response("", { status: 401 });
    await expect(go(freshDivision())).rejects.toBeInstanceOf(ExactAuthError);
  });
});

describe("request building", () => {
  it("builds the REST URL with division, bearer and JSON accept", async () => {
    await seedConnection();
    const div = freshDivision();
    await go(div, { path: "/crm/Accounts", query: { $select: "ID,Name", $top: "5" } });
    const c = stub.apiCalls[0];
    expect(c?.url.origin).toBe("https://start.exactonline.nl");
    expect(c?.url.pathname).toBe(`/api/v1/${div}/crm/Accounts`);
    expect(c?.url.searchParams.get("$select")).toBe("ID,Name");
    expect(c?.headers.accept).toBe("application/json");
    expect(c?.headers.authorization).toBe("Bearer acc-0");
  });

  it("uses /current for division 0 (Me) and the division query param for XML", async () => {
    await seedConnection();
    await go(0, { path: "/Me" });
    expect(stub.apiCalls[0]?.url.pathname).toBe("/api/v1/current/Me");
    const div = freshDivision();
    await go(div, {
      api: "xml",
      method: "POST",
      path: "/docs/XMLUpload.aspx",
      query: { Topic: "MatchSets" },
      body: "<eExact/>",
      headers: { "Content-Type": "text/xml" },
    });
    const x = stub.apiCalls[1];
    expect(x?.url.pathname).toBe("/docs/XMLUpload.aspx");
    expect(x?.url.searchParams.get("_Division_")).toBe(String(div));
    expect(x?.url.searchParams.get("Topic")).toBe("MatchSets");
    expect(x?.body).toBe("<eExact/>");
    expect(x?.headers["content-type"]).toBe("text/xml");
    expect(x?.headers.accept).toBeUndefined();
  });

  it("answers non-2xx statuses as data, except 429 and 401", async () => {
    await seedConnection();
    stub.api = () => new Response('{"error":"bad"}', { status: 400 });
    const r = await go(freshDivision());
    expect(r.status).toBe(400);
    expect(r.body).toBe('{"error":"bad"}');
  });

  it("refuses a different division on an existing gate", async () => {
    await seedConnection();
    const div = freshDivision();
    await go(div);
    await expect(go(div + 1)).resolves.toBeDefined(); // a different gate: fine
    const wrong = await gateStub(gateName(div)).call(req(div + 1));
    expect(wrong).toEqual({
      ok: false,
      error: { kind: "api", status: 400, code: "division_mismatch" },
    });
  });

  it("transport rejects a request for another division than its gate", async () => {
    const t = createGateTransport(env, 5);
    await expect(t(req(6))).rejects.toMatchObject({ code: "division_mismatch" });
  });
});

describe("path and header validation (SSRF, injection)", () => {
  const bad = [
    "",
    "crm/Accounts",
    "/../etc/passwd",
    "/crm/../x",
    "//evil.example/x",
    "/crm//Accounts",
    "https://evil.example/x",
    "http://start.exactonline.nl/x",
    "/\\evil.example",
    "/%2e%2e/x",
    "/crm/Accounts%00",
    "/crm/Accounts?x=1",
    "/crm/Accounts#frag",
    "@evil.example/x",
    "/crm/./Accounts",
    "/crm/Acc ounts",
    "/crm/Accounts\n",
    `/${"a".repeat(600)}`,
  ];
  it.each(bad)("rejects path %j", (path) => {
    expect(() => validateRequest(req(1, { path }))).toThrow(ExactApiError);
  });

  it("accepts normal OData paths", () => {
    for (const path of [
      "/crm/Accounts",
      "/financialtransaction/TransactionLines",
      "/bulk/CRM/Accounts",
      "/crm/Accounts(guid'11111111-2222-3333-4444-555555555555')",
    ]) {
      expect(() => validateRequest(req(1, { path }))).not.toThrow();
    }
  });

  it("restricts XML to the two XML endpoints and needs a division", () => {
    expect(() => validateRequest(req(1, { api: "xml", path: "/api/v1/1/crm/Accounts" }))).toThrow();
    expect(() => validateRequest(req(1, { api: "xml", path: "/docs/Other.aspx" }))).toThrow();
    expect(() => validateRequest(req(0, { api: "xml", path: "/docs/XMLUpload.aspx" }))).toThrow();
    expect(() =>
      validateRequest(req(1, { api: "xml", path: "/docs/XMLUpload.aspx" })),
    ).not.toThrow();
  });

  it("allows division 0 only for /Me", () => {
    expect(() => validateRequest(req(0, { path: "/Me" }))).not.toThrow();
    expect(() => validateRequest(req(0, { path: "/crm/Accounts" }))).toThrow();
    expect(() => validateRequest(req(-1))).toThrow();
    expect(() => validateRequest(req(1.5))).toThrow();
  });

  it("rejects caller-set Authorization/Host headers and a forged _Division_", () => {
    expect(() => validateRequest(req(1, { headers: { Authorization: "Bearer x" } }))).toThrow();
    expect(() => validateRequest(req(1, { headers: { host: "evil.example" } }))).toThrow();
    expect(() => validateRequest(req(1, { query: { _Division_: "9" } }))).toThrow();
    expect(() => validateRequest(req(1, { query: { "a b": "1" } }))).toThrow();
    expect(() => validateRequest(req(1, { jobId: "bad id!" }))).toThrow();
    expect(() =>
      validateRequest(req(1, { headers: { "Content-Type": "text/xml" } })),
    ).not.toThrow();
  });

  it("never builds a URL on another host, even for a poisoned region_host", () => {
    expect(() => buildUrl("evil.example", req(1))).toThrow(ExactApiError);
    expect(() => buildUrl("start.exactonline.nl.evil.example", req(1))).toThrow(ExactApiError);
    const u = buildUrl("start.exactonline.nl", req(1, { query: { x: "a&b=c#d" } }));
    expect(u.host).toBe("start.exactonline.nl");
    expect(u.searchParams.get("x")).toBe("a&b=c#d");
    expect(u.hash).toBe("");
  });

  it("the gate returns an error and makes no call for a bad path", async () => {
    await seedConnection();
    await expect(go(freshDivision(), { path: "//evil.example/x" })).rejects.toMatchObject({
      status: 400,
      code: "path",
    });
    expect(stub.apiCalls).toHaveLength(0);
  });
});

describe("rate limiting", () => {
  it("allows a burst of 60 per minute, then waits for the bucket to refill", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    const results = await Promise.all(
      Array.from({ length: 61 }, (_, i) => go(div, { query: { $top: String(i) } })),
    );
    expect(results).toHaveLength(61);
    expect(stub.apiCalls).toHaveLength(61);
    // 60 immediate, then exactly one wait of about a second for the 61st.
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(950);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(1050);
  });

  it("fails a request whose wait would exceed the maximum queue time", async () => {
    await seedConnection();
    const div = freshDivision();
    await fakeClock(gateName(div));
    await runInDurableObject(gateStub(gateName(div)), (g: ExactGate) => {
      g.limits.maxQueueWaitMs = 500;
    });
    const settled = await Promise.allSettled(Array.from({ length: 62 }, () => go(div)));
    const failed = settled.filter((s) => s.status === "rejected");
    expect(failed.length).toBe(2);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(ExactRateLimitedError);
  });

  it("enforces the daily counter and keeps a reserve for user priority", async () => {
    await seedConnection();
    const div = freshDivision();
    await fakeClock(gateName(div));
    await runInDurableObject(gateStub(gateName(div)), (g: ExactGate) => {
      g.limits.perDay = 10; // reserve = ceil(10 * 0.1) = 1
    });
    for (let i = 0; i < 9; i++) {
      expect((await go(div, { priority: "job", jobId: "bulk" })).status).toBe(200);
    }
    await expect(go(div, { priority: "job", jobId: "bulk" })).rejects.toBeInstanceOf(
      ExactRateLimitedError,
    );
    expect((await go(div, { priority: "user" })).status).toBe(200); // the reserved call
    const err = await go(div, { priority: "user" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExactRateLimitedError);
    expect((err as ExactRateLimitedError).retryAfterMs).toBeGreaterThan(0);
    expect(stub.apiCalls).toHaveLength(10);
  });

  it("lets user requests jump ahead of queued job requests", async () => {
    await seedConnection();
    const div = freshDivision();
    await fakeClock(gateName(div));
    // Hold the first call in flight so the rest queue up behind it.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    stub.api = async (_c, n) => {
      if (n === 1) await held;
      return Response.json({ d: { results: [] } });
    };
    const top = (t: string, over: Partial<ExactRequest> = {}) =>
      go(div, { priority: "job", jobId: "j", query: { $top: t }, ...over });
    const first = top("j0");
    await vi.waitFor(() => expect(stub.apiCalls).toHaveLength(1));
    const rest = [top("j1"), top("j2"), top("j3"), top("u1", { priority: "user" })];
    await new Promise((r) => setTimeout(r, 50)); // let all four reach the queue
    release();
    await Promise.all([first, ...rest]);
    expect(stub.apiCalls.map((c) => c.url.searchParams.get("$top"))).toEqual([
      "j0",
      "u1",
      "j1",
      "j2",
      "j3",
    ]);
  });

  it("honours Retry-After on a 429 and delays later requests", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    stub.api = (_c, n) =>
      n === 1
        ? new Response("", { status: 429, headers: { "retry-after": "7" } })
        : Response.json({ d: { results: [] } });
    const err = await go(div).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExactRateLimitedError);
    expect((err as ExactRateLimitedError).retryAfterMs).toBe(7000);
    await go(div);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(7000);
  });

  it("falls back to the minutely reset header when a 429 has no Retry-After", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    stub.api = () =>
      new Response("", {
        status: 429,
        headers: { "x-ratelimit-minutely-reset": String(clock.t + 12_000) },
      });
    const err = (await go(div).catch((e: unknown) => e)) as ExactRateLimitedError;
    expect(err.retryAfterMs).toBeGreaterThanOrEqual(11_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(12_000);
  });

  it("trusts Exact's X-RateLimit headers over its own counters", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    stub.api = () =>
      Response.json(
        { d: { results: [] } },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "300", // locally we have used 1 call, Exact says 300 left
            "x-ratelimit-reset": String(clock.t + 3600_000),
            "x-ratelimit-minutely-limit": "60",
            "x-ratelimit-minutely-remaining": "0",
            "x-ratelimit-minutely-reset": String(clock.t + 10_000),
          },
        },
      );
    await go(div);
    const usage = await gateStub(gateName(div)).usage();
    expect(usage.remaining).toBe(300);
    expect(usage.used).toBe(1);
    // 300 is below the 10% reserve (500): jobs are refused, users are not.
    await expect(go(div, { priority: "job", jobId: "x" })).rejects.toBeInstanceOf(
      ExactRateLimitedError,
    );
    stub.api = () => Response.json({ d: { results: [] } });
    await go(div, { priority: "user" });
    // The minute bucket was reported empty, so the user call had to wait for the reset.
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(9000);
  });

  it("writes a daily summary row to D1", async () => {
    await seedConnection();
    const div = freshDivision();
    await fakeClock(gateName(div));
    await go(div, { priority: "user" });
    await go(div, { priority: "job", jobId: "j" });
    await gateStub(gateName(div)).flushUsage();
    const row = await db
      .prepare("SELECT calls, user_calls, job_calls FROM exact_usage WHERE division = ?1")
      .bind(div)
      .first<{ calls: number; user_calls: number; job_calls: number }>();
    expect(row).toEqual({ calls: 2, user_calls: 1, job_calls: 1 });
  });
});

describe("per-job budget", () => {
  it("stops a job at its budget and throws ExactBudgetExhaustedError", async () => {
    await seedConnection();
    const div = freshDivision();
    await fakeClock(gateName(div));
    const gate = gateStub(gateName(div));
    expect(await gate.startJob("sync", 3)).toEqual({ jobId: "sync", budget: 3 });
    for (let i = 0; i < 3; i++) await go(div, { priority: "job", jobId: "sync" });
    const err = await go(div, { priority: "job", jobId: "sync" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExactBudgetExhaustedError);
    expect((err as ExactBudgetExhaustedError).jobId).toBe("sync");
    // Users and other jobs are not affected.
    expect((await go(div, { priority: "user", jobId: "sync" })).status).toBe(200);
    expect((await go(div, { priority: "job", jobId: "other" })).status).toBe(200);
    expect(await gate.endJob("sync")).toEqual({ used: 3 });
    expect(stub.apiCalls).toHaveLength(5);
  });

  it("takes the default budget from jobs.exact_budget, else 500", async () => {
    const gate = gateStub(gateName(freshDivision()));
    await db
      .prepare("INSERT INTO jobs (name, cron, exact_budget) VALUES ('nightly', '0 2 * * *', 42)")
      .run();
    expect(await gate.startJob("nightly")).toEqual({ jobId: "nightly", budget: 42 });
    expect(await gate.startJob("unknown-job")).toEqual({ jobId: "unknown-job", budget: 500 });
    const fail = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        () => "rejected",
      );
    expect(await fail(gate.startJob("x", 0))).toBe("rejected");
    expect(await fail(gate.startJob("bad id"))).toBe("rejected");
  });

  it("budget exhaustion crosses the transport as a typed error", async () => {
    await seedConnection();
    const div = freshDivision();
    await fakeClock(gateName(div));
    await gateStub(gateName(div)).startJob("tiny", 1);
    const transport = createGateTransport(env, div);
    await transport(req(div, { priority: "job", jobId: "tiny" }));
    await expect(transport(req(div, { priority: "job", jobId: "tiny" }))).rejects.toBeInstanceOf(
      ExactBudgetExhaustedError,
    );
  });
});

describe("no secrets in logs or errors", () => {
  it("never logs tokens, secrets or bodies", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await seedConnection({ expiresInMs: 1000, access: "acc-SECRET-0", refresh: "ref-SECRET-0" });
    stub.token = () => tokenOk(7);
    const div = freshDivision();
    await go(div, { body: undefined });
    stub.token = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await db
      .prepare("UPDATE connections SET expires_at = ?1")
      .bind(new Date(0).toISOString())
      .run();
    await go(div).catch(() => undefined);
    const logged = spies.flatMap((s) => s.mock.calls.flat().map((a) => String(a))).join("\n");
    for (const secret of [
      "acc-SECRET",
      "ref-SECRET",
      "acc-7",
      "ref-7",
      "test-exact-client-secret",
    ]) {
      expect(logged).not.toContain(secret);
    }
    spies.forEach((s) => s.mockRestore());
  });
});

describe("review E2: single-flight refresh lives only in the token authority", () => {
  it("a division gate refuses to refresh and makes no token call", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    const div = freshDivision();
    await go(div); // the instance is now a division gate (one refresh, via the authority)
    expect(stub.tokenCalls).toHaveLength(1);
    await db
      .prepare("UPDATE connections SET expires_at = ?1")
      .bind(new Date(0).toISOString())
      .run();
    const r = await gateStub(gateName(div)).refreshAccessToken(id);
    expect(r).toEqual({ ok: false, code: "wrong_token_authority", retryable: false });
    expect(stub.tokenCalls).toHaveLength(1);
  });

  it("the token authority refuses to act as a division gate", async () => {
    const id = await seedConnection();
    const authority = gateStub(`exact-token:${id}`);
    expect((await authority.refreshAccessToken(id)).ok).toBe(true);
    const out = await authority.call(req(freshDivision()));
    expect(out).toEqual({
      ok: false,
      error: { kind: "api", status: 400, code: "division_mismatch" },
    });
    expect(stub.apiCalls).toHaveLength(0);
  });

  it("an authority for one connection never refreshes another", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    const authority = gateStub(`exact-token:${id}`);
    expect((await authority.refreshAccessToken(id)).ok).toBe(true);
    const r = await authority.refreshAccessToken(id + 1000);
    expect(r).toMatchObject({ ok: false, code: "wrong_token_authority" });
    expect(stub.tokenCalls).toHaveLength(1);
  });

  it("parallel refreshes across many division gates hit the token endpoint once", async () => {
    await seedConnection({ expiresInMs: 1000 });
    const divs = Array.from({ length: 5 }, () => freshDivision());
    await Promise.all(divs.flatMap((d) => [go(d), go(d)]));
    expect(stub.tokenCalls).toHaveLength(1);
    expect(new Set(stub.apiCalls.map((c) => c.headers.authorization))).toEqual(
      new Set(["Bearer acc-1"]),
    );
  });
});

describe("review E2: headers can only tighten the limiter", () => {
  it("ignores a remaining count or limits above the configured caps", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    await runInDurableObject(gateStub(gateName(div)), (g: ExactGate) => {
      g.limits.perDay = 100;
    });
    stub.api = () =>
      Response.json(
        { d: { results: [] } },
        {
          headers: {
            "x-ratelimit-limit": "1000000",
            "x-ratelimit-remaining": "999999",
            "x-ratelimit-reset": String(clock.t + 3600_000),
            "x-ratelimit-minutely-limit": "100000",
            "x-ratelimit-minutely-remaining": "100000",
          },
        },
      );
    await go(div);
    const usage = await gateStub(gateName(div)).usage();
    expect(usage.remaining).toBe(99);
    // The minute bucket stays at 60: 61 more calls need one refill wait.
    await Promise.all(
      Array.from({ length: 61 }, (_, i) => go(div, { query: { $top: String(i) } })),
    );
    expect(clock.sleeps.length).toBeGreaterThanOrEqual(1);
    // Reserve is 10% of the configured 100, not of the header's 1,000,000.
    for (let i = 0; i < 100; i++) {
      const r = await go(div, { priority: "job", jobId: "big" }).catch((e: unknown) => e);
      if (r instanceof ExactRateLimitedError) break;
    }
    expect((await gateStub(gateName(div)).usage()).remaining).toBe(10);
  });

  it("keeps Exact's window across UTC midnight until its own reset", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    const midnight = new Date(clock.t);
    midnight.setUTCHours(24, 0, 0, 0);
    clock.t = midnight.getTime() - 60_000; // 23:59 UTC
    stub.api = () =>
      Response.json(
        { d: { results: [] } },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(midnight.getTime() + 3600_000), // 01:00 UTC
          },
        },
      );
    await go(div);
    clock.t = midnight.getTime() + 60_000; // 00:01 UTC: new local day, Exact not yet reset
    const err = await go(div).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExactRateLimitedError);
    expect((err as ExactRateLimitedError).retryAfterMs).toBe(3600_000 - 60_000);
    expect(stub.apiCalls).toHaveLength(1);
  });
});

describe("review E2: priority without starvation", () => {
  it("lets a waiting job through after a burst of user calls", async () => {
    await seedConnection();
    const div = freshDivision();
    await fakeClock(gateName(div));
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    stub.api = async (_c, n) => {
      if (n === 1) await held;
      return Response.json({ d: { results: [] } });
    };
    const first = go(div, { query: { $top: "u0" } });
    await vi.waitFor(() => expect(stub.apiCalls).toHaveLength(1));
    const job = go(div, { priority: "job", jobId: "j", query: { $top: "job" } });
    const users = Array.from({ length: 10 }, (_, i) => go(div, { query: { $top: `u${i + 1}` } }));
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([first, job, ...users]);
    const order = stub.apiCalls.map((c) => c.url.searchParams.get("$top"));
    // u0 was in flight; then 5 user calls jump ahead, then the job, then the rest.
    expect(order.indexOf("job")).toBe(6);
  });
});

describe("review E2: budget accounting", () => {
  it("a 401 retry costs a second call from the job's budget", async () => {
    await seedConnection({ expiresInMs: 3600_000 });
    const div = freshDivision();
    await fakeClock(gateName(div));
    const gate = gateStub(gateName(div));
    await gate.startJob("r", 2);
    stub.api = (_c, n) =>
      n === 1 ? new Response("", { status: 401 }) : Response.json({ d: { results: [] } });
    expect((await go(div, { priority: "job", jobId: "r" })).status).toBe(200);
    await expect(go(div, { priority: "job", jobId: "r" })).rejects.toBeInstanceOf(
      ExactBudgetExhaustedError,
    );
    expect(await gate.endJob("r")).toEqual({ used: 2 });
  });

  it("a job's budget survives an instance restart (persisted per job)", async () => {
    await seedConnection();
    const div = freshDivision();
    await fakeClock(gateName(div));
    const gate = gateStub(gateName(div));
    await gate.startJob("p", 3);
    await go(div, { priority: "job", jobId: "p" });
    const saved = await runInDurableObject(gate, (_g: ExactGate, state) =>
      state.storage.get<{ used: number }>("job:p"),
    );
    expect(saved?.used).toBe(1);
  });
});

describe("review E2: RPC failures are typed and retryable", () => {
  it("turns a failed gate RPC (eviction, reset) into ExactApiError 503 gate_unavailable", async () => {
    const fakeNs = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        call: () => Promise.reject(new Error("Durable Object reset because its code was updated")),
      }),
    } as unknown as DurableObjectNamespace<ExactGate>;
    const transport = createGateTransport({ EXACT_GATE: fakeNs }, 5);
    const err = await transport(req(5)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExactApiError);
    expect(err).toMatchObject({ status: 503, code: "gate_unavailable" });
  });

  it("an unknown error inside the gate crosses as 503 gate_unavailable without details", async () => {
    const { toWire } = await import("../src/exact/wire");
    expect(toWire(new Error("secret detail"))).toEqual({
      kind: "api",
      status: 503,
      code: "gate_unavailable",
    });
  });
});

describe("review E2: token endpoint hygiene", () => {
  it("never follows a redirect from the token endpoint and keeps the tokens", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    stub.token = () =>
      new Response(null, { status: 307, headers: { location: "https://evil.test/t" } });
    await expect(go(freshDivision())).rejects.toBeInstanceOf(ExactAuthError);
    const tokenInit = vi
      .mocked(globalThis.fetch)
      .mock.calls.map((c) => c[1])
      .find((i) => String(i?.body ?? "").includes("grant_type"));
    expect(tokenInit?.redirect).toBe("manual");
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-0" });
  });

  it("refuses to send the client secret to a non-Exact region_host", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    await db
      .prepare("UPDATE connections SET region_host = 'evil.test' WHERE id = ?1")
      .bind(id)
      .run();
    const r = await gateStub(`exact-token:${id}`).refreshAccessToken(id);
    expect(r).toMatchObject({ ok: false, code: "token_rejected" });
    expect(stub.tokenCalls).toHaveLength(0);
  });
});
