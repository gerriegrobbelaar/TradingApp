/**
 * The RevolutGate and payments (P9b, ADR 0050): the D1 switch is read at call time, the lease is a
 * mutex, a payment write is attempted at most once per ledger key, a 401 on a write is never re-sent,
 * and reads keep working with the switch off. Real Durable Object, stubbed network.
 */
import { runInDurableObject } from "cloudflare:test";
import {
  buildCreateCounterparty,
  buildPay,
  buildPaymentDraft,
  type RevolutRequest,
} from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RevolutGate } from "../src/revolut/gate";
import { unwrap } from "../src/revolut/wire";
import { FakeRevolut, gateExecution, SOURCE_ACCOUNT_UUID } from "./payments-fake-revolut";
import { db, execWorld, stageSubmitting, type ExecWorld } from "./payments-exec-helpers";
import { fakeRevolutClock, revolutGate, rreq } from "./revolut-helpers";
import { setSwitch, setVerified } from "./payments-helpers";

// The gate compares a payment body with the STORED request (F9a, N7), so every test works on a real
// `submitting` request staged in beforeEach; RID and leg point at it.
let RID = "3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a42";
const CP = "5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11";
let leg = {
  accountId: SOURCE_ACCOUNT_UUID,
  counterpartyId: CP,
  amountMinor: 100,
  currency: "EUR",
  reference: "Invoice 1",
};

let w: ExecWorld;
let fake: FakeRevolut;
beforeEach(async () => {
  w = await execWorld();
  fake = w.fake;
  const s = await stageSubmitting(w, CP);
  RID = s.requestId;
  leg = { ...leg, accountId: s.accountUuid, amountMinor: s.amountMinor, reference: s.reference };
});
afterEach(() => fake.restore());

const gate = () => revolutGate(w.revolutConnectionId);
const lease = async (owner = "tester") => gate().acquirePaymentLease(w.revolutConnectionId, owner);
const payReq = (token: string, over: Partial<RevolutRequest> = {}): RevolutRequest =>
  rreq(w.revolutConnectionId, {
    method: "POST",
    path: "/pay",
    jobId: "revolut-payment",
    paymentLease: token,
    paymentRef: RID,
    body: buildPay({ ...leg, requestId: RID }).body,
    headers: { "Content-Type": "application/json" },
    ...over,
  });
const call = async (r: RevolutRequest) => gate().call(r);

describe("the gate-side payment switch (read from D1 at call time)", () => {
  it("opens only with: deploy switch on, payments.enabled true, a current verification mark", async () => {
    expect((await lease()).ok).toBe(true);
    await gate().releasePaymentLease(((await lease()) as { lease?: string }).lease ?? "x");
  });

  it("refuses the lease for each missing condition, with its own code", async () => {
    await gateExecution(w.revolutConnectionId, false);
    expect(await lease()).toEqual({ ok: false, code: "payments_execution_off" });
    await gateExecution(w.revolutConnectionId, true);
    await setSwitch(false);
    expect(await lease()).toEqual({ ok: false, code: "payments_payments_disabled" });
    await setSwitch(true);
    await setVerified(false);
    expect(await lease()).toEqual({ ok: false, code: "payments_not_verified" });
    await setVerified(true, "0".repeat(64));
    expect(await lease()).toEqual({ ok: false, code: "payments_protocol_changed" });
    await setVerified(true);
    expect((await lease()).ok).toBe(true);
  });

  it("only the exact JSON value true counts for payments.enabled", async () => {
    for (const v of ['"true"', "1", '"1"', "TRUE", "{}", "null"]) {
      await db
        .prepare("UPDATE settings SET value_json = ?1 WHERE key = 'payments.enabled'")
        .bind(v)
        .run();
      expect(await lease(), v).toEqual({ ok: false, code: "payments_payments_disabled" });
    }
  });

  it("re-reads the switch right before the call: a lease taken while ON does not send once it is OFF", async () => {
    const l = (await lease()) as { ok: true; lease: string };
    await setSwitch(false);
    const r = await call(payReq(l.lease));
    expect(r).toMatchObject({
      ok: false,
      error: { kind: "api", status: 403, code: "payments_payments_disabled" },
    });
    expect(fake.calls("POST", "/pay")).toHaveLength(0);
    expect(await gate().paymentSendState(RID)).toBe("never_attempted");
  });

  it("reads keep working with the switch off (the reconciliation must not go blind)", async () => {
    await setSwitch(false);
    fake.drafts.push({
      id: "9c1d5a62-7777-4888-9999-aaaabbbbcccc",
      title: "CF-x",
      state: "pending",
    });
    const r = await call(
      rreq(w.revolutConnectionId, {
        path: "/payment-drafts",
        jobId: "revolut-payment:reconcile",
        priority: "job",
      }),
    );
    expect(r.ok).toBe(true);
    const t = await call(
      rreq(w.revolutConnectionId, {
        path: `/transaction/${RID}`,
        query: { id_type: "request_id" },
        jobId: "revolut-payment:reconcile",
        priority: "job",
      }),
    );
    expect(t).toMatchObject({ ok: true, response: { status: 404 } });
  });
});

describe("the payment lease is a mutex per connection", () => {
  it("one holder at a time; release frees it; only the holder's token releases", async () => {
    const a = (await lease("a")) as { ok: true; lease: string };
    expect(a.ok).toBe(true);
    expect(await lease("b")).toEqual({ ok: false, code: "busy" });
    expect(await gate().releasePaymentLease("not-the-token")).toBe(false);
    expect(await lease("b")).toEqual({ ok: false, code: "busy" });
    expect(await gate().releasePaymentLease(a.lease)).toBe(true);
    expect(await gate().releasePaymentLease(a.lease)).toBe(false);
    expect((await lease("b")).ok).toBe(true);
  });

  it("expires by itself, and an expired lease cannot send", async () => {
    let t = Date.now();
    await runInDurableObject(gate(), (g: RevolutGate) => {
      g.now = () => t;
    });
    const a = (await lease("a")) as { ok: true; lease: string; expiresAt: number };
    t = a.expiresAt + 1;
    const r = await call(payReq(a.lease));
    expect(r).toMatchObject({ ok: false, error: { status: 409, code: "payment_lease" } });
    expect(fake.calls("POST", "/pay")).toHaveLength(0);
    const b = await lease("b");
    expect(b.ok).toBe(true);
    // the old holder's token is not the new lease
    const again = await call(payReq(a.lease));
    expect(again).toMatchObject({ ok: false, error: { code: "payment_lease" } });
  });

  it("many parallel acquires: exactly one wins", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => lease(`p${i}`)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => (r as { code: string }).code === "busy")).toBe(
      true,
    );
  });

  it("survives a Durable Object restart (the lease is stored)", async () => {
    const a = (await lease("a")) as { ok: true; lease: string };
    // a fresh instance reads the stored lease
    await runInDurableObject(gate(), async (g: RevolutGate, state) => {
      void g;
      expect(await state.storage.get("paylease")).toMatchObject({ token: a.lease });
    });
  });

  it("rejects a bad owner, a bad connection and another connection's gate", async () => {
    const first = (await lease("first")) as { ok: true; lease: string };
    await gate().releasePaymentLease(first.lease);
    expect(await gate().acquirePaymentLease(w.revolutConnectionId, "bad owner!")).toEqual({
      ok: false,
      code: "owner",
    });
    expect(await gate().acquirePaymentLease(0, "x")).toEqual({ ok: false, code: "connection" });
    expect(await gate().acquirePaymentLease(w.revolutConnectionId + 99, "x")).toEqual({
      ok: false,
      code: "connection_mismatch",
    });
  });
});

describe("payment writes through the gate", () => {
  it("sends the exact bytes once, with the bearer token, and records the ledger first", async () => {
    const l = (await lease()) as { ok: true; lease: string };
    const body = buildPay({ ...leg, requestId: RID }).body;
    const r = await call(payReq(l.lease));
    expect(r.ok).toBe(true);
    const sent = fake.calls("POST", "/pay");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe(body);
    expect(sent[0]?.headers.authorization).toMatch(/^Bearer /);
    expect(await gate().paymentSendState(RID)).toBe("attempted");
  });

  it("refuses to send the same ledger key twice, even with the right lease and body", async () => {
    const l = (await lease()) as { ok: true; lease: string };
    expect((await call(payReq(l.lease))).ok).toBe(true);
    const second = await call(payReq(l.lease));
    expect(second).toMatchObject({
      ok: false,
      error: { status: 409, code: "payment_already_attempted" },
    });
    expect(fake.calls("POST", "/pay")).toHaveLength(1);
  });

  it("refuses a body that is not ours, or whose request_id is not the ledger key", async () => {
    const l = (await lease()) as { ok: true; lease: string };
    expect(await call(payReq(l.lease, { body: "{}" }))).toMatchObject({
      ok: false,
      error: { status: 400, code: "payment_body" },
    });
    expect(
      await call(payReq(l.lease, { paymentRef: "11111111-1111-4111-8111-111111111111" })),
    ).toMatchObject({ ok: false, error: { code: "payment_body" } });
    expect(fake.calls("POST", "/pay")).toHaveLength(0);
  });

  it("a draft and a counterparty go through with their own ledger keys", async () => {
    const l = (await lease()) as { ok: true; lease: string };
    const d = buildPaymentDraft({ requestId: RID, payments: [leg] });
    expect(
      (
        await call(
          rreq(w.revolutConnectionId, {
            method: "POST",
            path: d.path,
            body: d.body,
            jobId: "revolut-payment",
            paymentLease: l.lease,
            paymentRef: RID,
          }),
        )
      ).ok,
    ).toBe(true);
    const cp = buildCreateCounterparty({
      name: "Acme",
      iban: "NL91ABNA0417164300",
      currency: "EUR",
    });
    expect(
      (
        await call(
          rreq(w.revolutConnectionId, {
            method: "POST",
            path: cp.path,
            body: cp.body,
            jobId: "revolut-payment",
            paymentLease: l.lease,
            paymentRef: `cp-${RID}-0`,
          }),
        )
      ).ok,
    ).toBe(true);
    expect(fake.calls("POST", "/payment-drafts")).toHaveLength(1);
    expect(fake.calls("POST", "/counterparty")).toHaveLength(1);
  });

  it("a 401 on a payment is NOT re-sent: typed refusal, one call, ledger says attempted", async () => {
    const l = (await lease()) as { ok: true; lease: string };
    fake.failStatus("POST /pay", 401);
    const r = await call(payReq(l.lease));
    expect(r).toEqual({ ok: false, error: { kind: "write_auth_retry_refused" } });
    expect(fake.calls("POST", "/pay")).toHaveLength(1);
    expect(await gate().paymentSendState(RID)).toBe("attempted");
    // the token was healed for the next call, but the ledger blocks the same payment
    expect(await call(payReq(l.lease))).toMatchObject({
      ok: false,
      error: { code: "payment_already_attempted" },
    });
    expect(fake.calls("POST", "/pay")).toHaveLength(1);
  });

  it("a failure before the fetch (token endpoint down) leaves the ledger 'never attempted'", async () => {
    await db
      .prepare("UPDATE connections SET expires_at = ?2 WHERE id = ?1")
      .bind(w.revolutConnectionId, new Date(Date.now() - 1000).toISOString())
      .run();
    fake.stub.token = () => new Response("down", { status: 500 });
    await fakeRevolutClock(w.revolutConnectionId);
    const l = (await lease()) as { ok: true; lease: string };
    const r = await call(payReq(l.lease));
    expect(r.ok).toBe(false);
    expect(fake.calls("POST", "/pay")).toHaveLength(0);
    expect(await gate().paymentSendState(RID)).toBe("never_attempted");
  });

  it("a network failure during the fetch is 'attempted' (the answer is lost, not the send)", async () => {
    const l = (await lease()) as { ok: true; lease: string };
    fake.fail("POST /pay", new TypeError("network down"));
    const r = await call(payReq(l.lease));
    expect(r).toMatchObject({ ok: false, error: { kind: "api", status: 502, code: "network" } });
    expect(await gate().paymentSendState(RID)).toBe("attempted");
  });

  it("every other path stays refused for the payment job class, and a lease rides on nothing else", async () => {
    const l = (await lease()) as { ok: true; lease: string };
    for (const [method, path] of [
      ["POST", "/transfer"],
      ["POST", "/exchange"],
      ["DELETE", "/payment-drafts/abc"],
      ["PUT", "/pay"],
      ["POST", "/accounts"],
    ] as const) {
      const r = await call(
        rreq(w.revolutConnectionId, {
          method: method as never,
          path,
          body: "{}",
          jobId: "revolut-payment",
          paymentLease: l.lease,
          paymentRef: RID,
        }),
      );
      expect(r.ok, `${method} ${path}`).toBe(false);
    }
    expect(fake.stub.apiCalls).toHaveLength(0);
  });

  it("unwraps a refused write into the typed error on the Worker side", async () => {
    const l = (await lease()) as { ok: true; lease: string };
    fake.failStatus("POST /pay", 401);
    const r = await call(payReq(l.lease));
    expect(() => unwrap(r as never)).toThrow("write not re-sent after 401");
  });
});
