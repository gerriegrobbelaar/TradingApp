/**
 * Task G9 (ADR 0048): invariants of the shared gate core and the two divergences between the
 * gates that the refactor fixed. The behaviour both gates share is pinned in
 * gate-characterization.test.ts.
 */
import { runInDurableObject } from "cloudflare:test";
import { JOB_ID_RE as EXACT_JOB_ID_RE } from "@camelthorn/exact";
import { JOB_ID_RE as REVOLUT_JOB_ID_RE } from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExactGate } from "../src/exact/gate";
import { JOB_ID_RE, USER_BURST } from "../src/gate/core";
import { markNeedsReauth as markExactNeedsReauth } from "../src/exact/store";
import { RevolutGate } from "../src/revolut/gate";
import { db, gateStub } from "./exact-helpers";
import { unwrap } from "../src/revolut/wire";
import {
  resetRevolut,
  revolutGate,
  rotatedOk,
  rreq,
  seedRevolut,
  stubRevolut,
  type RevolutStub,
} from "./revolut-helpers";

const files = (
  import.meta as unknown as {
    glob: (p: string, o: object) => Record<string, string>;
  }
).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

describe("shared core structure", () => {
  it("uses the same job id pattern as both client packages", () => {
    expect(JOB_ID_RE.source).toBe(EXACT_JOB_ID_RE.source);
    expect(JOB_ID_RE.source).toBe(REVOLUT_JOB_ID_RE.source);
  });

  it("keeps the user burst at five", () => {
    expect(USER_BURST).toBe(5);
  });

  it("no gate file calls fetch except the shared core, which never follows redirects", () => {
    const callers = Object.entries(files)
      .filter(([f]) => /(^|\/)(exact|revolut|gate)\/gate\.ts$|\/gate\/core\.ts$/.test(f))
      .filter(([, raw]) => /\bfetch\(/.test(raw))
      .map(([f]) => f);
    expect(callers).toEqual(["../src/gate/core.ts"]);
    expect(files["../src/gate/core.ts"]).toContain('redirect: "manual"');
  });

  it("neither gate re-implements a core rule", () => {
    for (const f of ["../src/exact/gate.ts", "../src/revolut/gate.ts"]) {
      const src = files[f] ?? "";
      for (const needle of [
        "pickNext",
        "expireWaiting",
        "userStreak++",
        "window.push",
        "ensureJob",
        "purgeOldJobs",
        "noteClientRejected",
        "encryptToken(",
        "setAlarm(",
      ]) {
        expect(src.includes(needle), `${f} contains ${needle}`).toBe(false);
      }
    }
  });

  it("the token-bearing flow is not an RPC-callable method of either class", () => {
    for (const proto of [ExactGate.prototype, RevolutGate.prototype]) {
      const names = new Set<string>();
      for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        for (const n of Object.getOwnPropertyNames(p)) names.add(n);
      }
      for (const forbidden of ["refreshOnce", "doRefresh", "refreshShared"]) {
        expect(names.has(forbidden), forbidden).toBe(false);
      }
    }
    expect(Object.getOwnPropertyNames(RevolutGate.prototype)).not.toContain("refreshAccessToken");
  });
});

describe("divergence fixes (ADR 0048)", () => {
  let stub: RevolutStub;
  beforeEach(async () => {
    await resetRevolut();
    stub = stubRevolut();
  });
  afterEach(() => stub.restore());

  it("Revolut: a write that gets a 401 is never re-sent (as in ExactGate), the token is healed", async () => {
    const id = await seedRevolut();
    stub.api = (c) =>
      c.headers.authorization === "Bearer racc-0"
        ? new Response("", { status: 401 })
        : Response.json({ id: "w1" });
    const create = () =>
      revolutGate(id).call(
        rreq(id, {
          method: "POST",
          path: "/webhooks",
          apiVersion: "2.0",
          body: JSON.stringify({
            url: "https://app.test/api/webhooks/revolut",
            events: ["TransactionCreated"],
          }),
        }),
      );
    const first = await create();
    expect(first).toMatchObject({
      ok: false,
      error: { kind: "api", status: 503, code: "write_auth_retry_refused" },
    });
    expect(stub.apiCalls).toHaveLength(1); // not sent a second time
    expect(stub.tokenCalls).toHaveLength(1); // healed for the next call
    // The caller's own retry now goes out on the new token.
    expect((await create()).ok).toBe(true);
    expect(stub.apiCalls).toHaveLength(2);
    expect(stub.apiCalls[1]?.headers.authorization).toBe("Bearer racc-1");
  });

  it("Exact: token writes and reauth marks only ever touch an Exact row (as for Revolut)", async () => {
    const rid = await seedRevolut();
    const before = await db
      .prepare("SELECT status, refresh_token_enc FROM connections WHERE id = ?1")
      .bind(rid)
      .first<{ status: string; refresh_token_enc: string }>();
    const wrote = await runInDurableObject(gateStub(`exact-token:${rid}`), (g: ExactGate) =>
      g.persistTokens(rid, before?.refresh_token_enc ?? "", "a", "b", Date.now() + 1000),
    );
    expect(wrote).toBe(false);
    expect(await markExactNeedsReauth(db, rid, "x")).toBe(false);
    const after = await db
      .prepare("SELECT status, refresh_token_enc FROM connections WHERE id = ?1")
      .bind(rid)
      .first<{ status: string; refresh_token_enc: string }>();
    expect(after).toEqual(before);
  });

  it("Revolut: a read that gets a 401 is still retried once after a forced refresh", async () => {
    const id = await seedRevolut();
    stub.api = (c) =>
      c.headers.authorization === "Bearer racc-0"
        ? new Response("", { status: 401 })
        : Response.json([]);
    expect((await unwrap(await revolutGate(id).call(rreq(id)))).status).toBe(200);
    expect(stub.apiCalls).toHaveLength(2);
  });

  it("Revolut: the stash alarm only ever moves earlier, never later (one shared alarm)", async () => {
    const id = await seedRevolut({ expiresInMs: 1000 });
    stub.token = (_f, n) => rotatedOk(n);
    await runInDurableObject(revolutGate(id), async (g: RevolutGate, state) => {
      const soon = Date.now() + 5_000;
      await state.storage.setAlarm(soon);
      const orig = g.persistTokens.bind(g);
      let calls = 0;
      g.persistTokens = async (...a: Parameters<RevolutGate["persistTokens"]>) => {
        calls++;
        if (calls <= 2) throw new Error("d1 down");
        return orig(...a);
      };
    });
    await revolutGate(id).call(rreq(id));
    const at = await runInDurableObject(revolutGate(id), (_g, state) => state.storage.getAlarm());
    expect(at).not.toBeNull();
    expect(at as number).toBeLessThan(Date.now() + 10_000); // the earlier alarm (+5 s) was kept
  });
});
