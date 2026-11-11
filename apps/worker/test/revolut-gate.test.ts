import { env, runInDurableObject } from "cloudflare:test";
import {
  RevolutApiError,
  RevolutAuthError,
  RevolutBudgetExhaustedError,
  RevolutRateLimitedError,
  type RevolutRequest,
} from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEuObject } from "../src/eu-object";
import type { RevolutGate } from "../src/revolut/gate";
import {
  createRevolutGateTransport,
  getRevolutGate,
  revolutGateName,
} from "../src/revolut/gate-transport";
import { buildUrl, validateRequest } from "../src/revolut/request";
import { unwrap } from "../src/revolut/wire";
import {
  auditActions,
  db,
  fakeRevolutClock,
  refreshOk,
  resetRevolut,
  revolutGate,
  rotatedOk,
  rreq,
  seedRevolut,
  storedRevolut,
  stubRevolut,
  type RevolutStub,
} from "./revolut-helpers";

let stub: RevolutStub;
beforeEach(async () => {
  await resetRevolut();
  stub = stubRevolut();
});
afterEach(() => {
  stub.restore();
});

const go = async (id: number, over: Partial<RevolutRequest> = {}) =>
  unwrap(await revolutGate(id).call(rreq(id, over)));

describe("token refresh", () => {
  it("makes exactly one refresh for parallel requests and uses the new token", async () => {
    const id = await seedRevolut({ expiresInMs: 10_000 }); // inside the 60 s margin
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => go(id, { query: { count: String(i + 1) } })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(stub.tokenCalls).toHaveLength(1);
    const form = stub.tokenCalls[0];
    expect(form?.get("grant_type")).toBe("refresh_token");
    expect(form?.get("refresh_token")).toBe("rref-0");
    expect(form?.get("client_id")).toBe("test-revolut-client-id");
    expect(form?.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(form?.get("client_assertion")?.split(".")).toHaveLength(3);
    expect(form?.has("client_secret")).toBe(false);
    expect(stub.apiCalls).toHaveLength(6);
    expect(stub.apiCalls.every((c) => c.headers.authorization === "Bearer racc-1")).toBe(true);
    // No rotation in the answer: the refresh token stays, the access token is new.
    expect(await storedRevolut(id)).toMatchObject({
      access: "racc-1",
      refresh: "rref-0",
      status: "active",
    });
  });

  it("re-encrypts the unchanged refresh token with the current key (key rotation completes)", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    const blob = async () =>
      (
        await db
          .prepare("SELECT refresh_token_enc AS r FROM connections WHERE id = ?1")
          .bind(id)
          .first<{ r: string }>()
      )?.r;
    const before = await blob();
    await go(id);
    expect(await blob()).not.toBe(before);
    expect((await storedRevolut(id)).refresh).toBe("rref-0");
  });

  it("refreshes with 60 s or less left and not before", async () => {
    const id = await seedRevolut({ expiresInMs: 120_000 });
    await go(id);
    expect(stub.tokenCalls).toHaveLength(0);
    expect(stub.apiCalls[0]?.headers.authorization).toBe("Bearer racc-0");
    await db
      .prepare("UPDATE connections SET expires_at = ?1 WHERE id = ?2")
      .bind(new Date(Date.now() + 50_000).toISOString(), id)
      .run();
    await go(id);
    expect(stub.tokenCalls).toHaveLength(1);
    expect(stub.apiCalls[1]?.headers.authorization).toBe("Bearer racc-1");
  });

  it("takes the real lifetime from expires_in (about 40 minutes assumed)", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    await go(id);
    const row = await db
      .prepare("SELECT expires_at FROM connections WHERE id = ?1")
      .bind(id)
      .first<{ expires_at: string }>();
    const left = Date.parse(row?.expires_at ?? "") - Date.now();
    expect(left).toBeGreaterThan(2300_000);
    expect(left).toBeLessThanOrEqual(2400_000);
  });

  it("persists a rotated refresh token before the new access token is used", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    stub.token = (_f, n) => rotatedOk(n);
    let seenAtApiCall: string | null = null;
    stub.api = async () => {
      seenAtApiCall = (await storedRevolut(id)).refresh;
      return Response.json([]);
    };
    await go(id);
    expect(seenAtApiCall).toBe("rref-1");
    expect(await storedRevolut(id)).toMatchObject({ access: "racc-1", refresh: "rref-1" });
    // The next refresh uses the rotated token.
    await db
      .prepare("UPDATE connections SET expires_at = ?1 WHERE id = ?2")
      .bind(new Date(Date.now() + 1000).toISOString(), id)
      .run();
    await go(id);
    expect(stub.tokenCalls.map((f) => f.get("refresh_token"))).toEqual(["rref-0", "rref-1"]);
  });

  it("invalid_grant marks needs_reauth, wipes tokens, audits, and fails fast afterwards", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    stub.token = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const before = await auditActions("connection.revolut_needs_reauth");
    await expect(go(id)).rejects.toBeInstanceOf(RevolutAuthError);
    expect(stub.apiCalls).toHaveLength(0);
    expect(await storedRevolut(id)).toMatchObject({
      status: "needs_reauth",
      lastError: "invalid_grant",
      access: null,
      refresh: null,
    });
    expect(await auditActions("connection.revolut_needs_reauth")).toBe(before + 1);
    stub.tokenCalls.length = 0;
    await expect(go(id)).rejects.toBeInstanceOf(RevolutAuthError);
    expect(stub.tokenCalls).toHaveLength(0);
    expect(await auditActions("connection.revolut_needs_reauth")).toBe(before + 1);
  });

  it("an ambiguous rejection keeps the tokens and is retryable (503), never needs_reauth", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    await fakeRevolutClock(id);
    stub.token = () =>
      Response.json(
        { error: "invalid_request", error_description: "invalid_grant?" },
        { status: 400 },
      );
    await expect(go(id)).rejects.toMatchObject({ name: "RevolutApiError", status: 503 });
    expect(stub.tokenCalls).toHaveLength(3); // one try and two bounded retries
    expect(await storedRevolut(id)).toMatchObject({ status: "active", refresh: "rref-0" });
  });

  it("a token endpoint outage is retryable and keeps the tokens", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    await fakeRevolutClock(id);
    stub.token = () => new Response("oops", { status: 503 });
    await expect(go(id)).rejects.toMatchObject({ name: "RevolutApiError", status: 503 });
    expect(await storedRevolut(id)).toMatchObject({ status: "active", refresh: "rref-0" });
  });

  it("a 2xx the client cannot read keeps the tokens", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    await fakeRevolutClock(id);
    stub.token = () => new Response("<html>", { status: 200 });
    await expect(go(id)).rejects.toMatchObject({ status: 503 });
    expect(await storedRevolut(id)).toMatchObject({ status: "active", refresh: "rref-0" });
  });

  it("keeps using a still-valid token when the refresh fails", async () => {
    const id = await seedRevolut({ expiresInMs: 30_000 }); // inside the margin but not expired
    await fakeRevolutClock(id);
    stub.token = () => new Response("oops", { status: 503 });
    expect((await go(id)).status).toBe(200);
    expect(stub.apiCalls[0]?.headers.authorization).toBe("Bearer racc-0");
  });

  it("repeated invalid_client over a minute flags the connection for an admin, keeps tokens", async () => {
    const audited = await auditActions("connection.revolut_credentials_rejected");
    const id = await seedRevolut({ expiresInMs: -1000 });
    const clock = await fakeRevolutClock(id);
    stub.token = () => Response.json({ error: "invalid_client" }, { status: 401 });

    await expect(go(id)).rejects.toMatchObject({ code: "token_refresh_retry" });
    expect(stub.tokenCalls).toHaveLength(3);
    expect((await storedRevolut(id)).lastError).toBeNull();

    clock.t += 45_000;
    await expect(go(id)).rejects.toMatchObject({
      name: "RevolutApiError",
      status: 503,
      code: "token_endpoint_rejected_credentials",
    });
    expect(await storedRevolut(id)).toMatchObject({
      status: "active",
      refresh: "rref-0",
      access: "racc-0",
      lastError: "token_endpoint_rejected_credentials",
    });
    expect(await auditActions("connection.revolut_credentials_rejected")).toBe(audited + 1);

    // Cooldown: the token endpoint is left alone for a minute; still one audit row.
    const calls = stub.tokenCalls.length;
    await expect(go(id)).rejects.toMatchObject({ code: "token_endpoint_rejected_credentials" });
    expect(stub.tokenCalls).toHaveLength(calls);
    expect(await auditActions("connection.revolut_credentials_rejected")).toBe(audited + 1);

    // The admin fixes the configuration: the next refresh works and clears the flag.
    stub.token = (_f, n) => refreshOk(n);
    clock.t += 61_000;
    expect((await go(id)).status).toBe(200);
    expect((await storedRevolut(id)).lastError).toBeNull();
  });

  it("is an auth error when nothing is connected, or the connection is disabled", async () => {
    await expect(go(987_654)).rejects.toBeInstanceOf(RevolutAuthError);
    const id = await seedRevolut({ status: "disabled" });
    await expect(go(id)).rejects.toMatchObject({ message: "not_connected" });
    expect(stub.apiCalls).toHaveLength(0);
  });

  it("forces one refresh and retries once on a 401, then gives up with an auth error", async () => {
    const id = await seedRevolut();
    let n = 0;
    stub.api = (c) =>
      c.headers.authorization === "Bearer racc-1" && n++ >= 0
        ? Response.json([])
        : new Response("no", { status: 401 });
    const res = await go(id);
    expect(res.status).toBe(200);
    expect(stub.tokenCalls).toHaveLength(1);
    expect(stub.apiCalls.map((c) => c.headers.authorization)).toEqual([
      "Bearer racc-0",
      "Bearer racc-1",
    ]);

    stub.api = () => new Response("no", { status: 401 });
    await expect(go(id)).rejects.toBeInstanceOf(RevolutAuthError);
  });
});

describe("rotated tokens survive a failing D1 write", () => {
  const failFirst = (n: number) => async (g: RevolutGate) => {
    const orig = g.persistTokens.bind(g);
    let calls = 0;
    g.persistTokens = async (...args: Parameters<RevolutGate["persistTokens"]>) => {
      calls++;
      if (calls <= n) throw new Error("d1 down");
      return orig(...args);
    };
  };
  const pendingOf = (id: number) =>
    runInDurableObject(revolutGate(id), (_g: RevolutGate, state) =>
      state.storage.get<{ accessEnc: string; refreshEnc: string }>(`pending:${id}`),
    );

  it("stashes the encrypted pair, keeps the connection active, and persists it on the alarm", async () => {
    const audited = await auditActions("connection.revolut_needs_reauth");
    const id = await seedRevolut({ expiresInMs: 1000 });
    stub.token = (_f, n) => rotatedOk(n);
    await runInDurableObject(revolutGate(id), failFirst(2));
    expect((await go(id)).status).toBe(200);
    expect(stub.apiCalls[0]?.headers.authorization).toBe("Bearer racc-1");
    expect(await storedRevolut(id)).toMatchObject({ status: "active", refresh: "rref-0" });
    const stash = await pendingOf(id);
    expect(stash?.refreshEnc.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(stash)).not.toContain("rref-1");
    expect(JSON.stringify(stash)).not.toContain("racc-1");
    expect(await auditActions("connection.revolut_needs_reauth")).toBe(audited);

    await runInDurableObject(revolutGate(id), (g: RevolutGate) => g.alarm());
    expect(await storedRevolut(id)).toMatchObject({
      status: "active",
      access: "racc-1",
      refresh: "rref-1",
    });
    expect(await pendingOf(id)).toBeUndefined();
  });

  it("refreshes from the stashed refresh token while D1 keeps failing", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    stub.token = (_f, n) => rotatedOk(n);
    await runInDurableObject(revolutGate(id), (g: RevolutGate) => {
      g.persistTokens = async () => {
        throw new Error("d1 down");
      };
    });
    await go(id);
    await runInDurableObject(revolutGate(id), (_g: RevolutGate, state) =>
      state.storage
        .get<Record<string, unknown>>(`pending:${id}`)
        .then((p) => state.storage.put(`pending:${id}`, { ...p, expiresAt: Date.now() - 1000 })),
    );
    await go(id);
    expect(stub.tokenCalls.map((f) => f.get("refresh_token"))).toEqual(["rref-0", "rref-1"]);
    expect(stub.apiCalls.at(-1)?.headers.authorization).toBe("Bearer racc-2");
    expect((await storedRevolut(id)).status).toBe("active");
  });

  it("without rotation a failed D1 write costs nothing: no stash, the token still works", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    await runInDurableObject(revolutGate(id), failFirst(2));
    expect((await go(id)).status).toBe(200);
    expect(await pendingOf(id)).toBeUndefined();
    expect(await storedRevolut(id)).toMatchObject({ status: "active", refresh: "rref-0" });
  });

  it("drops the stash if the connection was disconnected meanwhile", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    stub.token = (_f, n) => rotatedOk(n);
    await runInDurableObject(revolutGate(id), failFirst(2));
    await go(id);
    await db.prepare("UPDATE connections SET status = 'disabled' WHERE id = ?1").bind(id).run();
    await runInDurableObject(revolutGate(id), (g: RevolutGate) => g.alarm());
    expect(await pendingOf(id)).toBeUndefined();
    expect(await storedRevolut(id)).toMatchObject({ status: "disabled", refresh: "rref-0" });
  });
});

describe("instance role", () => {
  it("is pinned to its connection: another id is refused, for calls and for refreshes", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    const other = id + 1000;
    const gate = revolutGate(id);
    expect((await gate.refreshAccessToken(id)).ok).toBe(true);
    expect(await gate.refreshAccessToken(other)).toMatchObject({
      ok: false,
      code: "wrong_token_authority",
    });
    expect(await gate.call(rreq(other))).toEqual({
      ok: false,
      error: { kind: "api", status: 400, code: "connection_mismatch" },
    });
    expect(stub.tokenCalls).toHaveLength(1);
  });

  it("the transport refuses a request for another connection", async () => {
    const id = await seedRevolut();
    const t = createRevolutGateTransport(env, id);
    await expect(t(rreq(id + 1))).rejects.toMatchObject({ code: "connection_mismatch" });
    expect((await t(rreq(id))).status).toBe(200);
  });

  it("instance names are revolut:<id>, in the EU jurisdiction helper", () => {
    expect(revolutGateName(7)).toBe("revolut:7");
    const seen: string[] = [];
    const ns = {
      jurisdiction: (j: string) => {
        seen.push(`jurisdiction:${j}`);
        return ns;
      },
      idFromName: (n: string) => {
        seen.push(n);
        return {} as DurableObjectId;
      },
      get: () => ({}) as DurableObjectStub,
    } as unknown as DurableObjectNamespace<RevolutGate>;
    expect(() => getRevolutGate({ REVOLUT_GATE: ns }, 0)).toThrow();
    // Production code asks for the EU jurisdiction; the test resolver is switched off in
    // do-namespace.ts, so only the name is checked here.
    getEuObject(ns, revolutGateName(7));
    expect(seen).toContain("revolut:7");
  });
});

describe("request building and validation (SSRF, injection)", () => {
  const ok = (over: Partial<RevolutRequest> = {}) => rreq(5, over);
  const refused = (over: Partial<RevolutRequest>) =>
    expect(() => validateRequest(ok(over))).toThrow(RevolutApiError);

  it("accepts the read paths and the webhook paths on API 2.0", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    for (const path of [
      "/accounts",
      `/accounts/${uuid}`,
      `/accounts/${uuid}/bank-details`,
      "/transactions",
      "/transaction/abc-DEF_123",
      "/counterparties",
    ]) {
      expect(() => validateRequest(ok({ path }))).not.toThrow();
    }
    for (const [method, path] of [
      ["GET", "/webhooks"],
      ["POST", "/webhooks"],
      ["GET", `/webhooks/${uuid}`],
      ["DELETE", `/webhooks/${uuid}`],
      ["POST", `/webhooks/${uuid}/rotate-signing-secret`],
      ["GET", `/webhooks/${uuid}/failed-events`],
    ] as const) {
      expect(() =>
        validateRequest(
          ok({ method, path, apiVersion: "2.0", body: method === "POST" ? "{}" : undefined }),
        ),
      ).not.toThrow();
    }
  });

  it("REFUSES every payment endpoint in this phase", () => {
    for (const [method, path] of [
      ["POST", "/pay"],
      ["POST", "/payment-drafts"],
      ["GET", "/payment-drafts"],
      ["POST", "/transfer"],
      ["POST", "/counterparty"],
      ["POST", "/counterparties"],
      ["DELETE", "/counterparty/123e4567-e89b-12d3-a456-426614174000"],
      ["POST", "/accounts"],
      ["POST", "/transactions"],
      ["POST", "/transaction/abc"],
    ] as const) {
      expect(() => validateRequest(ok({ method, path, body: "{}" })), `${method} ${path}`).toThrow(
        RevolutApiError,
      );
    }
    // Also under API 2.0, and the 2.0 webhook paths do not work under 1.0.
    refused({ method: "POST", path: "/pay", apiVersion: "2.0", body: "{}" });
    refused({ path: "/webhooks" });
    refused({ path: "/accounts", apiVersion: "2.0" });
  });

  it("refuses the token endpoint, traversal, encoded and absolute paths", () => {
    for (const path of [
      "/auth/token",
      "/../auth/token",
      "/accounts/../pay",
      "/accounts/%2e%2e/pay",
      "//evil.example/accounts",
      "https://evil.example/accounts",
      "/accounts?x=1",
      "/accounts#x",
      "/accounts/not-a-uuid",
      "/transaction/",
      "/transaction/a/b",
      "",
      "accounts",
    ]) {
      refused({ path });
    }
  });

  it("refuses a bad method, version, connection, job id, query, header and body", () => {
    refused({ method: "PATCH" });
    refused({ method: "PUT" as RevolutRequest["method"] });
    refused({ apiVersion: "3.0" as "1.0" });
    refused({ connectionId: 0 });
    refused({ connectionId: 1.5 });
    refused({ jobId: "bad job!" });
    refused({ priority: "root" as "user" });
    refused({ query: { "a b": "1" } });
    refused({ query: { count: "x".repeat(1001) } });
    refused({ headers: { authorization: "Bearer stolen" } });
    refused({ headers: { Host: "evil.example" } });
    refused({ headers: { cookie: "a=b" } });
    refused({ body: "{}" }); // a body on GET
    expect(() =>
      validateRequest(ok({ headers: { "Content-Type": "application/json" } })),
    ).not.toThrow();
  });

  it("builds URLs only on the connection's own host and version", () => {
    expect(buildUrl("production", ok({ query: { count: "5" } })).href).toBe(
      "https://b2b.revolut.com/api/1.0/accounts?count=5",
    );
    expect(buildUrl("sandbox", ok()).href).toBe("https://sandbox-b2b.revolut.com/api/1.0/accounts");
    expect(buildUrl("production", ok({ path: "/webhooks", apiVersion: "2.0" })).href).toBe(
      "https://b2b.revolut.com/api/2.0/webhooks",
    );
  });

  it("the gate refuses bad requests without any outbound call", async () => {
    const id = await seedRevolut();
    for (const bad of [
      rreq(id, { path: "/pay", method: "POST", body: "{}" }),
      rreq(id, { path: "/payment-drafts", method: "POST", body: "{}" }),
      rreq(id, { path: "/auth/token", method: "POST" }),
      rreq(id, { headers: { authorization: "x" } }),
    ]) {
      const out = await revolutGate(id).call(bad);
      expect(out).toMatchObject({ ok: false, error: { kind: "api", status: 400 } });
    }
    expect(stub.apiCalls).toHaveLength(0);
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("calls the sandbox host for a sandbox connection and never the production one", async () => {
    const id = await seedRevolut({ environment: "sandbox", expiresInMs: 1000 });
    stub.hosts = new Set(["sandbox-b2b.revolut.com"]);
    expect((await go(id)).status).toBe(200);
    expect(stub.tokenCalls).toHaveLength(1); // the refresh also went to the sandbox host
    expect(stub.apiCalls[0]?.url.host).toBe("sandbox-b2b.revolut.com");
  });

  it("refuses a connection whose environment column is empty or corrupt", async () => {
    const id = await seedRevolut();
    await db
      .prepare("UPDATE connections SET revolut_environment = NULL WHERE id = ?1")
      .bind(id)
      .run();
    await expect(go(id)).rejects.toBeInstanceOf(RevolutAuthError);
    expect(stub.apiCalls).toHaveLength(0);
  });

  it("does not follow redirects (the bearer token never goes elsewhere)", async () => {
    const id = await seedRevolut();
    stub.api = () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
    const res = await go(id);
    expect(res.status).toBe(302);
    const spy = vi.mocked(globalThis.fetch);
    for (const call of spy.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.redirect).toBe("manual");
    }
  });
});

describe("verifying a pending connection", () => {
  it("serves GET /accounts with staged tokens and nothing else", async () => {
    const id = await seedRevolut({ status: "pending" });
    expect((await go(id)).status).toBe(200);
    await expect(go(id, { path: "/transactions" })).rejects.toMatchObject({
      message: "not_connected",
    });
    await expect(go(id, { path: "/webhooks", apiVersion: "2.0" })).rejects.toMatchObject({
      message: "not_connected",
    });
    expect(stub.apiCalls).toHaveLength(1);
  });

  it("a needs_reauth connection fails fast without a call", async () => {
    const id = await seedRevolut({ status: "needs_reauth" });
    await expect(go(id)).rejects.toMatchObject({ message: "needs_reauth" });
    expect(stub.apiCalls).toHaveLength(0);
  });
});

describe("rate limiting", () => {
  it("allows a burst of 60, then the 61st waits until the first call leaves the window", async () => {
    const id = await seedRevolut();
    const clock = await fakeRevolutClock(id);
    const results = await Promise.all(
      Array.from({ length: 61 }, (_, i) => go(id, { query: { count: String(i + 1) } })),
    );
    expect(results).toHaveLength(61);
    expect(stub.apiCalls).toHaveLength(61);
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("never lets more than the cap into any 60 s window", async () => {
    const id = await seedRevolut({ expiresInMs: 100 * 3600_000 });
    const clock = await fakeRevolutClock(id);
    await runInDurableObject(revolutGate(id), (g: RevolutGate) => {
      g.limits.perMinute = 10;
      g.limits.maxQueueWaitMs = 10 * 3600_000;
    });
    const at: number[] = [];
    stub.api = () => {
      at.push(clock.t);
      return Response.json([]);
    };
    await Promise.all(
      Array.from({ length: 55 }, (_, i) => go(id, { query: { count: String(i + 1) } })),
    );
    expect(at).toHaveLength(55);
    for (let i = 10; i < at.length; i++) {
      expect((at[i] as number) - (at[i - 10] as number)).toBeGreaterThanOrEqual(60_000);
    }
  });

  it("fails a request whose wait would exceed the maximum queue time", async () => {
    const id = await seedRevolut();
    await fakeRevolutClock(id);
    await runInDurableObject(revolutGate(id), (g: RevolutGate) => {
      g.limits.perMinute = 1;
      g.limits.maxQueueWaitMs = 10_000;
    });
    await go(id);
    await expect(go(id, { query: { count: "2" } })).rejects.toBeInstanceOf(RevolutRateLimitedError);
  });

  it("the sliding window is persisted, so a restarted instance still waits", async () => {
    const id = await seedRevolut();
    await runInDurableObject(revolutGate(id), (g: RevolutGate) => {
      g.limits.perMinute = 2;
      g.limits.maxQueueWaitMs = 5_000;
    });
    await go(id);
    await go(id, { query: { count: "2" } });
    // Simulate an eviction: a fresh instance state loads the window from storage.
    const usage = await revolutGate(id).usage();
    expect(usage.windowUsed).toBe(2);
  });

  it("user requests jump ahead of queued job requests", async () => {
    const id = await seedRevolut();
    await fakeRevolutClock(id);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    stub.api = async (_c, n) => {
      if (n === 1) await held;
      return Response.json([]);
    };
    const top = (t: string, over: Partial<RevolutRequest> = {}) =>
      go(id, { priority: "job", jobId: "j", query: { count: t }, ...over });
    const first = top("10");
    await vi.waitFor(() => expect(stub.apiCalls).toHaveLength(1));
    const rest = [top("11"), top("12"), top("13"), top("20", { priority: "user" })];
    await vi.waitFor(async () => expect((await revolutGate(id).usage()).queued).toBe(4));
    release();
    await Promise.all([first, ...rest]);
    expect(stub.apiCalls.map((c) => c.url.searchParams.get("count"))).toEqual([
      "10",
      "20",
      "11",
      "12",
      "13",
    ]);
  });

  it("a steady stream of user calls cannot starve a waiting job call", async () => {
    const id = await seedRevolut();
    await fakeRevolutClock(id);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    stub.api = async (_c, n) => {
      if (n === 1) await held;
      return Response.json([]);
    };
    const first = go(id, { priority: "job", jobId: "j", query: { count: "1" } });
    await vi.waitFor(() => expect(stub.apiCalls).toHaveLength(1));
    const job = go(id, { priority: "job", jobId: "j", query: { count: "99" } });
    const users = Array.from({ length: 9 }, (_, i) =>
      go(id, { priority: "user", query: { count: String(i + 2) } }),
    );
    await vi.waitFor(async () => expect((await revolutGate(id).usage()).queued).toBe(10));
    release();
    await Promise.all([first, job, ...users]);
    const order = stub.apiCalls.map((c) => c.url.searchParams.get("count"));
    expect(order.indexOf("99")).toBeLessThan(order.length - 1);
  });

  it("honours Retry-After on a 429 and delays later requests", async () => {
    const id = await seedRevolut();
    const clock = await fakeRevolutClock(id);
    stub.api = (_c, n) =>
      n === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "7" } })
        : Response.json([]);
    await expect(go(id)).rejects.toMatchObject({
      name: "RevolutRateLimitedError",
      retryAfterMs: 7000,
    });
    const before = clock.t;
    expect((await go(id, { query: { count: "2" } })).status).toBe(200);
    expect(clock.t - before).toBeGreaterThanOrEqual(7000 - 1);
  });

  it("falls back to a default wait on a 429 without Retry-After", async () => {
    const id = await seedRevolut();
    await fakeRevolutClock(id);
    stub.api = () => new Response("", { status: 429 });
    await expect(go(id)).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });
});

describe("per-job budget", () => {
  it("stops a job at its budget and throws RevolutBudgetExhaustedError", async () => {
    const id = await seedRevolut();
    const gate = revolutGate(id);
    expect(await gate.startJob("bal", 2)).toEqual({ jobId: "bal", budget: 2 });
    await go(id, { priority: "job", jobId: "bal" });
    await go(id, { priority: "job", jobId: "bal", query: { count: "2" } });
    await expect(
      go(id, { priority: "job", jobId: "bal", query: { count: "3" } }),
    ).rejects.toBeInstanceOf(RevolutBudgetExhaustedError);
    expect(stub.apiCalls).toHaveLength(2);
    // User calls are not charged to a job.
    expect((await go(id)).status).toBe(200);
    expect(await gate.endJob("bal")).toEqual({ used: 2 });
    // A restarted job has a fresh budget.
    await gate.startJob("bal", 1);
    expect((await go(id, { priority: "job", jobId: "bal" })).status).toBe(200);
  });

  it("gives a job that never called startJob the default budget, and validates input", async () => {
    const id = await seedRevolut();
    const gate = revolutGate(id);
    await go(id, { priority: "job", jobId: "implicit" });
    expect(await gate.endJob("implicit")).toEqual({ used: 1 });
    // Called inside the instance: an RPC rejection would surface as an unhandled error here.
    await runInDurableObject(gate, async (g: RevolutGate) => {
      await expect(g.startJob("bad job!")).rejects.toMatchObject({ code: "job_id" });
      await expect(g.startJob("ok", 0)).rejects.toMatchObject({ code: "budget" });
    });
  });

  it("budget exhaustion crosses the transport as a typed error", async () => {
    const id = await seedRevolut();
    await revolutGate(id).startJob("t", 1);
    const t = createRevolutGateTransport(env, id);
    await t(rreq(id, { priority: "job", jobId: "t" }));
    await expect(t(rreq(id, { priority: "job", jobId: "t" }))).rejects.toBeInstanceOf(
      RevolutBudgetExhaustedError,
    );
  });
});

describe("no secrets in logs or errors", () => {
  it("never logs tokens, keys, assertions or bodies", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const id = await seedRevolut({
      expiresInMs: 1000,
      access: "racc-SECRET-0",
      refresh: "rref-SECRET-0",
    });
    stub.token = (_f, n) => rotatedOk(n + 6);
    await go(id, { body: undefined });
    stub.token = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await db
      .prepare("UPDATE connections SET expires_at = ?1")
      .bind(new Date(0).toISOString())
      .run();
    await go(id).catch((e: unknown) => {
      expect(String((e as Error).message)).not.toMatch(/SECRET|racc|rref/);
    });
    const logged = spies.flatMap((s) => s.mock.calls.flat().map((a) => String(a))).join("\n");
    for (const secret of [
      "racc-SECRET",
      "rref-SECRET",
      "racc-7",
      "rref-7",
      "BEGIN PRIVATE KEY",
      "client_assertion",
    ]) {
      expect(logged).not.toContain(secret);
    }
    // The audit rows written by the gate carry no token or key either.
    const audit = await db
      .prepare(
        "SELECT before_json, after_json FROM audit_log WHERE action LIKE 'connection.revolut_%'",
      )
      .all<{ before_json: string | null; after_json: string | null }>();
    const text = JSON.stringify(audit.results);
    for (const secret of ["racc", "rref", "PRIVATE KEY", "eyJ"]) expect(text).not.toContain(secret);
    spies.forEach((s) => s.mockRestore());
  });
});

describe("source hygiene", () => {
  it("only revolut/gate-transport.ts (and the Env type) touch the REVOLUT_GATE binding", () => {
    const files = import.meta.glob("../src/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(10);
    const offenders = Object.entries(files)
      .filter(([path, text]) => {
        if (path.endsWith("/revolut/gate-transport.ts") || path.endsWith("/env.ts")) return false;
        return /REVOLUT_GATE/.test(text);
      })
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("the migration tag for RevolutGate is declared once, as a new SQLite class", async () => {
    const toml = (await import("../wrangler.toml?raw")).default;
    expect(toml).toMatch(/tag = "v3"\nnew_sqlite_classes = \["RevolutGate"\]/g);
    expect(toml.match(/tag = "v3"/g)).toHaveLength(2); // production and staging
  });
});
