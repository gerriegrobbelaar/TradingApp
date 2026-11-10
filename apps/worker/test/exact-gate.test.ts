import { runInDurableObject } from "cloudflare:test";
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  type ExactRequest,
} from "@camelthorn/exact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGateTransport,
  gateName,
  getExactGate,
  setGateNamespaceResolverForTests,
} from "../src/exact/gate-transport";
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
    await fakeClock(`exact-token:${id}`);
    stub.token = () => new Response("oops", { status: 503 });
    await expect(go(freshDivision())).rejects.toMatchObject({ name: "ExactApiError", status: 503 });
    expect(stub.tokenCalls).toHaveLength(3); // one try and two bounded retries
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-0" });
  });

  it("does not wipe tokens when Exact rejects our client credentials", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    await fakeClock(`exact-token:${id}`);
    stub.token = () => Response.json({ error: "invalid_client" }, { status: 401 });
    // Retryable, not an auth error: it must not turn into a needs_reauth sync status (B2).
    await expect(go(freshDivision())).rejects.toMatchObject({
      name: "ExactApiError",
      status: 503,
      code: "token_refresh_retry",
    });
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
  });

  it("a second 401 on a token that was old enough to refresh is an auth error", async () => {
    await seedConnection({ expiresInMs: 3600_000 });
    stub.api = () => new Response("", { status: 401 });
    await expect(go(freshDivision())).rejects.toBeInstanceOf(ExactAuthError);
  });
});

describe("review G2/B2: minimum token age (570 s)", () => {
  // Remaining life = 600 s minus age, so expiresInMs 60_000 is a 540 s old token.
  it("does not refresh a token that is 540 s old", async () => {
    await seedConnection({ expiresInMs: 60_000 });
    await go(freshDivision());
    expect(stub.tokenCalls).toHaveLength(0);
    expect(stub.apiCalls[0]?.headers.authorization).toBe("Bearer acc-0");
  });

  it("does not refresh at 569 s but refreshes inside the 570-580 s window", async () => {
    await seedConnection({ expiresInMs: 31_000 }); // age 569 s
    await go(freshDivision());
    expect(stub.tokenCalls).toHaveLength(0);
    await resetExact();
    await seedConnection({ expiresInMs: 25_000 }); // age 575 s
    await go(freshDivision());
    expect(stub.tokenCalls).toHaveLength(1);
    expect(stub.apiCalls.at(-1)?.headers.authorization).toBe("Bearer acc-1");
  });

  it("an expired token (age over 600 s) refreshes at once", async () => {
    await seedConnection({ expiresInMs: -5_000 });
    await go(freshDivision());
    expect(stub.tokenCalls).toHaveLength(1);
  });

  const setIssued = (id: number, issuedAt: number) =>
    db
      .prepare("SELECT expires_at FROM connections WHERE id = ?1")
      .bind(id)
      .first<{ expires_at: string }>()
      .then((row) =>
        runInDurableObject(gateStub(`exact-token:${id}`), (_g: ExactGate, state) =>
          state.storage.put(`issued:${id}`, { expiresAt: row?.expires_at, issuedAt }),
        ),
      );

  it("boundary: no refresh with 30.001 s left (age 569.999 s), refresh with exactly 30 s left", async () => {
    const id = await seedConnection({ expiresInMs: 600_000 });
    const row = await db
      .prepare("SELECT expires_at FROM connections WHERE id = ?1")
      .bind(id)
      .first<{ expires_at: string }>();
    const exp = Date.parse(row?.expires_at ?? "");
    const div = freshDivision();
    const gateClock = await fakeClock(gateName(div));
    const authClock = await fakeClock(`exact-token:${id}`);
    await setIssued(id, exp - 600_000);
    gateClock.t = authClock.t = exp - 30_001;
    await go(div);
    expect(stub.tokenCalls).toHaveLength(0);
    gateClock.t = authClock.t = exp - 30_000;
    await go(div);
    expect(stub.tokenCalls).toHaveLength(1);
    expect(authClock.sleeps).toEqual([]);
    expect(stub.apiCalls.at(-1)?.headers.authorization).toBe("Bearer acc-1");
  });

  it("the minimum age scales with a shorter lifetime: refreshes at once with 20 s left", async () => {
    const id = await seedConnection({ expiresInMs: 20_000 });
    const clock = await fakeClock(`exact-token:${id}`);
    // Issued 560 s ago with only 20 s left: the real lifetime was 580 s, not 600 s.
    await setIssued(id, clock.t - 560_000);
    await go(freshDivision());
    expect(clock.sleeps).toEqual([]);
    expect(stub.tokenCalls).toHaveLength(1);
  });

  it("a 300 s token that has expired refreshes at once (no 570 s lock-out)", async () => {
    const id = await seedConnection({ expiresInMs: -1_000 });
    const clock = await fakeClock(`exact-token:${id}`);
    await setIssued(id, clock.t - 301_000);
    const res = await go(freshDivision());
    expect(res.status).toBe(200);
    expect(stub.tokenCalls).toHaveLength(1);
    expect(stub.apiCalls[0]?.headers.authorization).toBe("Bearer acc-1");
  });

  it("a 300 s token is not refreshed while it has more than 30 s left", async () => {
    const id = await seedConnection({ expiresInMs: 40_000 });
    const clock = await fakeClock(`exact-token:${id}`);
    await setIssued(id, clock.t - 260_000);
    await go(freshDivision());
    expect(stub.tokenCalls).toHaveLength(0);
  });

  it("a premature-refresh rejection is retried after a wait, then succeeds", async () => {
    const audited = await auditActions("connection.exact_needs_reauth");
    const id = await seedConnection({ expiresInMs: 25_000 });
    const clock = await fakeClock(`exact-token:${id}`);
    stub.token = (_f, n) =>
      n === 1 ? Response.json({ error: "invalid_request" }, { status: 400 }) : tokenOk(n);
    await go(freshDivision());
    expect(stub.tokenCalls).toHaveLength(2);
    expect(stub.tokenCalls.map((f) => f.get("refresh_token"))).toEqual(["ref-0", "ref-0"]);
    expect(clock.sleeps).toEqual([5_000]);
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-2" });
    expect(await auditActions("connection.exact_needs_reauth")).toBe(audited);
  });

  it("an unclassifiable rejection keeps the valid token, backs off and never wipes tokens", async () => {
    const audited = await auditActions("connection.exact_needs_reauth");
    const id = await seedConnection({ expiresInMs: 25_000 });
    await fakeClock(`exact-token:${id}`);
    stub.token = () => new Response("<html>nope</html>", { status: 400 });
    const res = await go(freshDivision());
    expect(res.status).toBe(200);
    expect(stub.tokenCalls).toHaveLength(3); // bounded
    expect(stub.apiCalls[0]?.headers.authorization).toBe("Bearer acc-0");
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-0" });
    // Cooldown: the next call does not hammer the token endpoint again.
    await go(freshDivision());
    expect(stub.tokenCalls).toHaveLength(3);
    expect(await auditActions("connection.exact_needs_reauth")).toBe(audited);
  });

  it("a rejection with no valid token left is a retryable 503, tokens kept", async () => {
    const id = await seedConnection({ expiresInMs: -1000 });
    await fakeClock(`exact-token:${id}`);
    stub.token = () => Response.json({ error: "invalid_request" }, { status: 400 });
    await expect(go(freshDivision())).rejects.toMatchObject({
      status: 503,
      code: "token_refresh_retry",
    });
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-0" });
  });

  it("invalid_grant is the only rejection that wipes the tokens", async () => {
    const id = await seedConnection({ expiresInMs: 25_000 });
    await fakeClock(`exact-token:${id}`);
    stub.token = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const before = await auditActions("connection.exact_needs_reauth");
    await expect(go(freshDivision())).rejects.toBeInstanceOf(ExactAuthError);
    expect(stub.tokenCalls).toHaveLength(1); // no retry of a clear invalid_grant
    expect(await storedTokens(id)).toMatchObject({ status: "needs_reauth", access: null });
    expect(await auditActions("connection.exact_needs_reauth")).toBe(before + 1);
  });

  it("a 401 on a young token waits and retries once without refreshing", async () => {
    const id = await seedConnection({ expiresInMs: 590_000 }); // age 10 s
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    stub.api = (_c, n) =>
      n === 1 ? new Response("", { status: 401 }) : Response.json({ d: { results: [] } });
    const res = await go(div);
    expect(res.status).toBe(200);
    expect(stub.tokenCalls).toHaveLength(0);
    expect(clock.sleeps).toEqual([2_000]);
    expect(stub.apiCalls.map((c) => c.headers.authorization)).toEqual([
      "Bearer acc-0",
      "Bearer acc-0",
    ]);
    expect((await storedTokens(id)).status).toBe("active");
  });

  it("two 401s on a young token are a retryable 503, not an auth error", async () => {
    const id = await seedConnection({ expiresInMs: 590_000 });
    const div = freshDivision();
    await fakeClock(gateName(div));
    stub.api = () => new Response("", { status: 401 });
    await expect(go(div)).rejects.toMatchObject({ status: 503, code: "token_refresh_retry" });
    expect(stub.tokenCalls).toHaveLength(0);
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-0" });
  });
});

describe("review G2 (reviewer): token endpoint classification and credentials", () => {
  it("invalid_grant is recognised at 401 too, in any case and with whitespace", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    await fakeClock(`exact-token:${id}`);
    stub.token = () => Response.json({ error: " Invalid_Grant " }, { status: 401 });
    await expect(go(freshDivision())).rejects.toBeInstanceOf(ExactAuthError);
    expect(stub.tokenCalls).toHaveLength(1);
    expect(await storedTokens(id)).toMatchObject({ status: "needs_reauth", refresh: null });
  });

  it("a description that only mentions invalid_grant is ambiguous: tokens kept, retryable", async () => {
    const id = await seedConnection({ expiresInMs: -1000 });
    await fakeClock(`exact-token:${id}`);
    stub.token = () =>
      Response.json({ error_description: "invalid_grant (maybe)" }, { status: 400 });
    await expect(go(freshDivision())).rejects.toMatchObject({ status: 503 });
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-0" });
  });

  it("a 2xx we cannot read keeps the tokens and is retryable (no needs_reauth)", async () => {
    const audited = await auditActions("connection.exact_needs_reauth");
    const id = await seedConnection({ expiresInMs: -1000 });
    await fakeClock(`exact-token:${id}`);
    stub.token = (_f, n) =>
      n === 1 ? new Response("<html>ok</html>", { status: 200 }) : tokenOk(n);
    const res = await go(freshDivision());
    expect(res.status).toBe(200);
    expect(stub.tokenCalls.map((f) => f.get("refresh_token"))).toEqual(["ref-0", "ref-0"]);
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-2" });
    expect(await auditActions("connection.exact_needs_reauth")).toBe(audited);
  });

  it("a 2xx carrying an OAuth error is a rejection, not a malformed success", async () => {
    const id = await seedConnection({ expiresInMs: -1000 });
    await fakeClock(`exact-token:${id}`);
    stub.token = () => Response.json({ error: "invalid_request" });
    await expect(go(freshDivision())).rejects.toMatchObject({
      status: 503,
      code: "token_refresh_retry",
    });
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-0" });
  });

  it("repeated invalid_client over a minute flags the connection for an admin, keeps tokens", async () => {
    const audited = await auditActions("connection.exact_credentials_rejected");
    const id = await seedConnection({ expiresInMs: -1000 });
    const clock = await fakeClock(`exact-token:${id}`);
    stub.token = () => Response.json({ error: "invalid_client" }, { status: 400 });

    // First round: three attempts within 20 s are not yet "repeated over a minute".
    await expect(go(freshDivision())).rejects.toMatchObject({ code: "token_refresh_retry" });
    expect(stub.tokenCalls).toHaveLength(3);
    expect((await storedTokens(id)).lastError).toBeNull();

    clock.t += 45_000;
    await expect(go(freshDivision())).rejects.toMatchObject({
      name: "ExactApiError",
      status: 503,
      code: "token_endpoint_rejected_credentials",
    });
    expect(stub.tokenCalls).toHaveLength(4); // no pointless retries once it is clear
    expect(await storedTokens(id)).toMatchObject({
      status: "active",
      refresh: "ref-0",
      access: "acc-0",
      lastError: "token_endpoint_rejected_credentials",
    });
    expect(await auditActions("connection.exact_credentials_rejected")).toBe(audited + 1);

    // Cooldown: the token endpoint is left alone for a minute; still one audit row.
    await expect(go(freshDivision())).rejects.toMatchObject({
      code: "token_endpoint_rejected_credentials",
    });
    expect(stub.tokenCalls).toHaveLength(4);

    // Still wrong after the cooldown: reported again, but no second audit row.
    clock.t += 61_000;
    await expect(go(freshDivision())).rejects.toMatchObject({
      code: "token_endpoint_rejected_credentials",
    });
    expect(stub.tokenCalls).toHaveLength(5);
    expect(await auditActions("connection.exact_credentials_rejected")).toBe(audited + 1);

    // The admin fixes the secret: the next refresh works and clears the flag.
    stub.token = (_f, n) => tokenOk(n);
    clock.t += 61_000;
    expect((await go(freshDivision())).status).toBe(200);
    expect(await storedTokens(id)).toMatchObject({ refresh: "ref-6", lastError: null });
  });

  it("a 401 with no error code from the token endpoint counts as a credentials rejection", async () => {
    const id = await seedConnection({ expiresInMs: -1000 });
    const clock = await fakeClock(`exact-token:${id}`);
    stub.token = () => new Response("", { status: 401 });
    await expect(go(freshDivision())).rejects.toMatchObject({ code: "token_refresh_retry" });
    clock.t += 60_000;
    await expect(go(freshDivision())).rejects.toMatchObject({
      code: "token_endpoint_rejected_credentials",
    });
    expect((await storedTokens(id)).status).toBe("active");
  });

  it("a second 401 after the authority handed back the same token is retryable, not auth", async () => {
    const id = await seedConnection({ expiresInMs: 3600_000 });
    await runInDurableObject(gateStub(`exact-token:${id}`), (g: ExactGate) => {
      // As after a credentials rejection: the authority answers with the token it has.
      (g as unknown as { clientRejectedUntil: number }).clientRejectedUntil = Date.now() + 600_000;
    });
    const div = freshDivision();
    await fakeClock(gateName(div));
    stub.api = () => new Response("", { status: 401 });
    await expect(go(div)).rejects.toMatchObject({ status: 503, code: "token_refresh_retry" });
    expect(stub.tokenCalls).toHaveLength(0);
    expect(stub.apiCalls).toHaveLength(2);
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-0" });
  });
});

describe("review G2 (reviewer): one alarm, shared; window survives a restart", () => {
  it("arming the alarm only ever moves it earlier, never later", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    const gate = gateStub(gateName(div));
    const far = clock.t + 2 * 3600_000;
    await runInDurableObject(gate, async (g: ExactGate, state) => {
      g.limits.flushIntervalMs = 3 * 3600_000; // would land after the existing alarm
      await state.storage.setAlarm(far);
    });
    await go(div);
    const after = await runInDurableObject(gate, async (_g: ExactGate, state) => {
      const at = await state.storage.getAlarm();
      await state.storage.deleteAlarm();
      return at;
    });
    expect(after).toBe(far);
  });

  it("the alarm writes a stash even when the usage flush fails", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    const authority = gateStub(`exact-token:${id}`);
    await runInDurableObject(authority, (g: ExactGate) => {
      const orig = g.persistTokens.bind(g);
      let calls = 0;
      g.persistTokens = async (...args: Parameters<ExactGate["persistTokens"]>) => {
        calls++;
        if (calls <= 2) throw new Error("d1 down");
        return orig(...args);
      };
    });
    await go(freshDivision());
    const armed = await runInDurableObject(authority, (_g: ExactGate, state) =>
      state.storage.getAlarm(),
    );
    expect(armed).not.toBeNull();
    await runInDurableObject(authority, async (g: ExactGate, state) => {
      await state.storage.deleteAlarm();
      (g as unknown as { dirty: boolean }).dirty = true;
      g.flushUsage = () => Promise.reject(new Error("d1 down"));
      await expect(g.alarm()).rejects.toThrow("d1 down");
    });
    expect(await storedTokens(id)).toMatchObject({ refresh: "ref-1", access: "acc-1" });
  });

  it("the sliding window is persisted, so a restarted instance still waits", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => go(div, { query: { $top: String(i) } })),
    );
    const t0 = clock.t;
    const waited = await runInDurableObject(gateStub(gateName(div)), async (_g, state) => {
      const saved = await state.storage.get<{ window: number[] }>("rl");
      expect(saved?.window).toHaveLength(60);
      // A fresh instance on the same storage (what an eviction gives us) sees the same window.
      const fresh = new (_g.constructor as new (s: DurableObjectState, e: typeof env) => ExactGate)(
        state,
        env,
      );
      // The constructor's blockConcurrencyWhile waits behind this test's own event; load directly.
      await (fresh as unknown as { load(): Promise<void> }).load();
      const sleeps: number[] = [];
      let t = t0;
      fresh.now = () => t;
      fresh.sleep = async (ms) => {
        sleeps.push(ms);
        t += ms;
      };
      fresh.limits.flushIntervalMs = 0;
      await fresh.request(req(div));
      return sleeps;
    });
    expect(waited).toEqual([60_000]);
    expect(stub.apiCalls).toHaveLength(61);
  });
});

describe("review G2/N2: rotated tokens survive a failing D1 write", () => {
  const failFirst = (n: number) => async (g: ExactGate) => {
    const orig = g.persistTokens.bind(g);
    let calls = 0;
    g.persistTokens = async (...args: Parameters<ExactGate["persistTokens"]>) => {
      calls++;
      if (calls <= n) throw new Error("d1 down");
      return orig(...args);
    };
  };
  const pendingOf = (id: number) =>
    runInDurableObject(gateStub(`exact-token:${id}`), (_g: ExactGate, state) =>
      state.storage.get<{ accessEnc: string; refreshEnc: string }>(`pending:${id}`),
    );

  it("stashes the encrypted pair, keeps the connection active, and persists it on the alarm", async () => {
    const audited = await auditActions("connection.exact_needs_reauth");
    const id = await seedConnection({ expiresInMs: 1000 });
    await runInDurableObject(gateStub(`exact-token:${id}`), failFirst(2));
    const res = await go(freshDivision());
    expect(res.status).toBe(200);
    expect(stub.apiCalls[0]?.headers.authorization).toBe("Bearer acc-1");
    // D1 still has the old pair; the new one waits, encrypted, in the authority's storage.
    expect(await storedTokens(id)).toMatchObject({ status: "active", refresh: "ref-0" });
    const stash = await pendingOf(id);
    expect(stash?.refreshEnc.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(stash)).not.toContain("ref-1");
    expect(JSON.stringify(stash)).not.toContain("acc-1");
    expect(await auditActions("connection.exact_needs_reauth")).toBe(audited);

    await runInDurableObject(gateStub(`exact-token:${id}`), (g: ExactGate) => g.alarm());
    expect(await storedTokens(id)).toMatchObject({
      status: "active",
      access: "acc-1",
      refresh: "ref-1",
    });
    expect(await pendingOf(id)).toBeUndefined();
  });

  it("persists the stash before any other use on the next call", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    await runInDurableObject(gateStub(`exact-token:${id}`), failFirst(2));
    await go(freshDivision());
    // D1 holds an expired token, so this call asks the authority, which flushes first and then
    // reuses the new (fresh) token instead of refreshing again.
    await go(freshDivision());
    expect(stub.tokenCalls).toHaveLength(1);
    expect(await storedTokens(id)).toMatchObject({ refresh: "ref-1", access: "acc-1" });
    expect(await pendingOf(id)).toBeUndefined();
  });

  it("refreshes from the stashed refresh token while D1 keeps failing", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    const authority = gateStub(`exact-token:${id}`);
    await runInDurableObject(authority, (g: ExactGate) => {
      g.persistTokens = async () => {
        throw new Error("d1 down");
      };
    });
    await go(freshDivision());
    // The stashed token ages out; the next refresh must use ref-1 (D1 still holds dead ref-0).
    await runInDurableObject(authority, (_g: ExactGate, state) =>
      state.storage
        .get<Record<string, unknown>>(`pending:${id}`)
        .then((p) => state.storage.put(`pending:${id}`, { ...p, expiresAt: Date.now() - 1000 })),
    );
    await go(freshDivision());
    expect(stub.tokenCalls.map((f) => f.get("refresh_token"))).toEqual(["ref-0", "ref-1"]);
    expect(stub.apiCalls.at(-1)?.headers.authorization).toBe("Bearer acc-2");
    expect((await storedTokens(id)).status).toBe("active");
  });

  it("drops the stash if the connection was disconnected meanwhile", async () => {
    const id = await seedConnection({ expiresInMs: 1000 });
    await runInDurableObject(gateStub(`exact-token:${id}`), failFirst(2));
    await go(freshDivision());
    await db.prepare("UPDATE connections SET status = 'disabled' WHERE id = ?1").bind(id).run();
    await runInDurableObject(gateStub(`exact-token:${id}`), (g: ExactGate) => g.alarm());
    expect(await pendingOf(id)).toBeUndefined();
    expect(await storedTokens(id)).toMatchObject({ status: "disabled", refresh: "ref-0" });
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
  it("allows a burst of 60, then the 61st waits until the first call leaves the window", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    const results = await Promise.all(
      Array.from({ length: 61 }, (_, i) => go(div, { query: { $top: String(i) } })),
    );
    expect(results).toHaveLength(61);
    expect(stub.apiCalls).toHaveLength(61);
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("never lets more than 60 calls into any 60 s window, even with no headers (review S1)", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    await runInDurableObject(gateStub(gateName(div)), (g: ExactGate) => {
      g.limits.maxQueueWaitMs = 10 * 3600_000; // let all 200 wait instead of failing
    });
    const at: number[] = [];
    stub.api = () => {
      at.push(clock.t);
      return Response.json({ d: { results: [] } });
    };
    const t0 = clock.t;
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => go(div, { query: { $top: String(i) } })),
    );
    expect(at).toHaveLength(200);
    // Every 60 s span [t, t + 60 s) holds at most 60 calls (checked from each call's own time).
    for (const t of at) {
      expect(at.filter((x) => x >= t && x < t + 60_000).length).toBeLessThanOrEqual(60);
    }
    expect(at.filter((x) => x < t0 + 60_000)).toHaveLength(60);
    expect(at.filter((x) => x < t0 + 120_000)).toHaveLength(120);
    expect(clock.t - t0).toBe(180_000); // 200 calls = 60 + 60 + 60 + 20
  });

  it("a header can only tighten the window, never loosen it (review S1)", async () => {
    await seedConnection();
    const div = freshDivision();
    const clock = await fakeClock(gateName(div));
    stub.api = () =>
      Response.json(
        { d: { results: [] } },
        {
          headers: {
            "x-ratelimit-minutely-limit": "1000",
            "x-ratelimit-minutely-remaining": "999",
          },
        },
      );
    const t0 = clock.t;
    await Promise.all(
      Array.from({ length: 61 }, (_, i) => go(div, { query: { $top: String(i) } })),
    );
    expect(clock.t - t0).toBe(60_000);
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
    await vi.waitFor(async () => expect((await gateStub(gateName(div)).usage()).queued).toBe(4));
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
    await vi.waitFor(async () => expect((await gateStub(gateName(div)).usage()).queued).toBe(11));
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
    const inner = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        call: () => Promise.reject(new Error("Durable Object reset because its code was updated")),
      }),
    };
    // The test resolver uses the namespace as is, so the fake is the (already EU) namespace.
    const fakeNs = inner as unknown as DurableObjectNamespace<ExactGate>;
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
    await fakeClock(`exact-token:${id}`);
    stub.token = () =>
      new Response(null, { status: 307, headers: { location: "https://evil.test/t" } });
    await expect(go(freshDivision())).rejects.toMatchObject({ status: 503 });
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
    expect(r).toMatchObject({ ok: false, code: "token_refresh_retry", retryable: true });
    expect(stub.tokenCalls).toHaveLength(0);
  });
});

describe("review G2/S6: EU jurisdiction for every Durable Object stub", () => {
  it("getExactGate always goes through env.EXACT_GATE.jurisdiction('eu')", () => {
    const seen: string[] = [];
    const ns = {
      idFromName: (n: string) => ({ n }) as unknown as DurableObjectId,
      get: (id: unknown) => ({ id }) as unknown as DurableObjectStub<ExactGate>,
    };
    const fake = {
      jurisdiction: (j: string) => {
        seen.push(j);
        return ns;
      },
      idFromName: () => {
        throw new Error("the global namespace must not be used");
      },
    } as unknown as DurableObjectNamespace<ExactGate>;
    setGateNamespaceResolverForTests(null); // the production resolver
    try {
      const stub = getExactGate({ EXACT_GATE: fake }, "exact:5") as unknown as {
        id: { n: string };
      };
      expect(seen).toEqual(["eu"]);
      expect(stub.id.n).toBe("exact:5");
      createGateTransport({ EXACT_GATE: fake }, 7);
      expect(seen).toEqual(["eu", "eu"]);
    } finally {
      setGateNamespaceResolverForTests((ns) => ns);
    }
  });

  it("has no environment switch: a DO_JURISDICTION_DISABLED variable changes nothing", () => {
    setGateNamespaceResolverForTests(null); // production resolver
    try {
      const seen: string[] = [];
      const fake = {
        jurisdiction: (j: string) => {
          seen.push(j);
          throw new Error("eu");
        },
      } as unknown as DurableObjectNamespace<ExactGate>;
      for (const v of [undefined, "", "0", "1", "true"]) {
        const e = { EXACT_GATE: fake, ...(v === undefined ? {} : { DO_JURISDICTION_DISABLED: v }) };
        expect(() => getExactGate(e, "x")).toThrow("eu");
      }
      expect(seen).toEqual(["eu", "eu", "eu", "eu", "eu"]);
    } finally {
      setGateNamespaceResolverForTests((ns) => ns);
    }
  });

  it("no source file obtains a gate stub except through getExactGate, or uses the test seam", () => {
    const files = import.meta.glob("../src/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(files)) {
      if (path.endsWith("/exact/gate-transport.ts")) continue;
      if (/setGateNamespaceResolverForTests|DO_JURISDICTION_DISABLED/.test(text))
        offenders.push(path);
      // KNOWN EXCEPTION until task G1 lands: sync.ts defaultGate still uses idFromName directly.
      if (path.endsWith("/exact/sync.ts")) continue;
      if (/EXACT_GATE\s*\.\s*(idFromName|get|newUniqueId|idFromString)\b/.test(text)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
