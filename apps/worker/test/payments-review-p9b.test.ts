/**
 * Review P9b (adversarial): the gaps the review found, each pinned against the REAL gate, client and
 * submitter with a scripted Revolut (payments-fake-revolut.ts). Every test asserts what was SENT.
 *
 *  1. Default safety: with the deploy var as wrangler.toml ships it, nothing payment-capable leaves.
 *  2. Each single missing layer of the gate blocks a payment write with zero network calls.
 *  3. A drafts-only verification never lets a direct /pay through (gate and runSubmission).
 *  4. A 429 after the send is unknown (looked up), not a rejection.
 *  5. Drafts: a refusal is checked against the draft list before it is believed.
 *  6. A new request for an invoice whose earlier attempt was called "not sent" or whose draft
 *     expired is refused while that earlier attempt still exists at Revolut (double payment).
 *  7. resolve-not-sent: the "not found" must come from a lookup made late enough; batches work.
 *  8. After the submitter's deadline no further write starts.
 *  9. A payee with several accounts and no account id is refused.
 * 10. No full IBAN in status codes, events, audit, idempotency keys or reconcile rows.
 * 11. Preview payment's hash is the hash of the bytes actually sent.
 */
import { env } from "cloudflare:test";
import { sha256Hex, PAYMENTS_VERIFY_CHECKS } from "@camelthorn/core";
import {
  buildCreateCounterparty,
  buildPay,
  buildPaymentDraft,
  createRevolutClient,
  type RevolutClient,
  type RevolutRequest,
} from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { previewPayment } from "../src/payments/preview";
import { reconcilePayments, resolveNotSent } from "../src/payments/reconcile";
import { createRevolutSubmitter } from "../src/payments/revolut-submitter";
import { runSubmission, submitPayment } from "../src/payments/submit";
import { createRevolutGateTransport } from "../src/revolut/gate-transport";
import {
  anotherBill,
  db,
  execWorld,
  readyBatch,
  readyPayment,
  rowOf,
  send,
  stageSubmitting,
  TEST_IBAN_KEY,
  type ExecWorld,
} from "./payments-exec-helpers";
import { gateExecution, SOURCE_ACCOUNT_UUID } from "./payments-fake-revolut";
import { setSwitch, setVerified, SUPPLIER_IBAN } from "./payments-helpers";
import { fakeRevolutClock, refreshOk, revolutGate, rreq } from "./revolut-helpers";
import { setSetting } from "./matching-helpers";

let w: ExecWorld;
afterEach(() => w.fake.restore());

const RID0 = "3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a42";
// Section 2 stages a real `submitting` request (the gate compares a payment body with the stored
// request, F9a N7) and points RID and leg at it; every other section keeps the synthetic ones.
let RID = RID0;
const CP = "5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11";
const LEG0 = {
  accountId: SOURCE_ACCOUNT_UUID,
  counterpartyId: CP,
  amountMinor: 100,
  currency: "EUR",
  reference: "Invoice 1",
};
let leg = LEG0;
const RESOLVE = "MARK PAYMENT AS NOT SENT";
const MIN = 60_000;

const gate = () => revolutGate(w.revolutConnectionId);
const payReq = (token: string | undefined, over: Partial<RevolutRequest> = {}): RevolutRequest =>
  rreq(w.revolutConnectionId, {
    method: "POST",
    path: "/pay",
    jobId: "revolut-payment",
    ...(token !== undefined ? { paymentLease: token } : {}),
    paymentRef: RID,
    body: buildPay({ ...leg, requestId: RID }).body,
    headers: { "Content-Type": "application/json" },
    ...over,
  });
const writes = () => w.fake.stub.apiCalls.filter((c) => c.method !== "GET");

async function seedPayee(id: number): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for)
       SELECT ?1, iban_fingerprint, ?3, 'Acme', 'seed-seed' FROM payments WHERE id = ?2`,
    )
    .bind(w.revolutConnectionId, id, CP)
    .run();
}

async function clientFor(): Promise<RevolutClient> {
  return createRevolutClient(createRevolutGateTransport(env, w.revolutConnectionId), {
    connectionId: w.revolutConnectionId,
    jobId: "revolut-payment:reconcile",
    priority: "job",
    sleep: () => Promise.resolve(),
  });
}
const reconcileAt = (nowMs: number) => reconcilePayments({ db, nowMs, client: clientFor });

describe("1. default safety: the deploy var as shipped (wrangler.toml 'off')", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
    // everything else is ON: switch, complete mark, approvals; only the gate's own env is default
    await gateExecution(w.revolutConnectionId, false);
  });

  it("the shipped env is 'off' and every path refuses with zero Revolut calls", async () => {
    expect((env as Env).REVOLUT_PAYMENTS_EXECUTION).toBe("off");
    const id = await readyPayment(w);
    // the route-level entry with the shipped env
    expect(
      await submitPayment(env as Env, { kind: "payment", id, nowMs: Date.now(), actor: "x" }),
    ).toEqual({ status: "refused", code: "payments_disabled" });
    // the gate itself: no lease, and a forged lease token cannot send
    expect(await gate().acquirePaymentLease(w.revolutConnectionId, "x")).toEqual({
      ok: false,
      code: "payments_execution_off",
    });
    for (const token of ["forged-lease-token", undefined]) {
      const r = await gate().call(payReq(token));
      expect(r.ok).toBe(false);
    }
    // even with the Worker-side var on, the gate's own env decides
    expect(await send(w, id)).toEqual({ status: "refused", code: "payments_execution_off" });
    expect(w.fake.stub.apiCalls).toHaveLength(0);
    expect((await rowOf(id)).status).toBe("ready");
    expect(await gate().paymentSendState(RID)).toBe("never_attempted");
  });
});

describe("2. every gate layer on its own blocks a payment write (zero network calls)", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
    const s = await stageSubmitting(w, CP);
    RID = s.requestId;
    leg = { ...LEG0, accountId: s.accountUuid, amountMinor: s.amountMinor };
  });
  afterEach(() => {
    RID = RID0;
    leg = LEG0;
  });

  const cases: [string, (lease: string) => Promise<RevolutRequest>][] = [
    [
      "deploy var off",
      async (l) => {
        await gateExecution(w.revolutConnectionId, false);
        return payReq(l);
      },
    ],
    [
      "payments.enabled is the string '1'",
      async (l) => {
        await db
          .prepare("UPDATE settings SET value_json = '1' WHERE key = 'payments.enabled'")
          .run();
        return payReq(l);
      },
    ],
    [
      "mark missing",
      async (l) => {
        await setVerified(false);
        return payReq(l);
      },
    ],
    [
      "mark of another protocol version",
      async (l) => {
        await setVerified(true, "a".repeat(64));
        return payReq(l);
      },
    ],
    [
      "mark without the pay round trip (drafts-only verification)",
      async (l) => {
        await setSetting("payments.verified", {
          at: "2026-07-01T00:00:00.000Z",
          by: "a@camelthorncapital.com",
          note: "drafts only",
          protocolVersion: (
            await import("../src/payments/protocol-version")
          ).paymentsProtocolVersion(),
          checks: PAYMENTS_VERIFY_CHECKS.filter((c) => c !== "sandbox_pay_roundtrip"),
        });
        return payReq(l);
      },
    ],
    ["job class not a payment job", async (l) => payReq(l, { jobId: "revolut-sync" })],
    ["job priority", async (l) => payReq(l, { priority: "job" })],
    ["no lease", async () => payReq(undefined)],
    ["a wrong lease", async () => payReq("someone-elses-lease")],
    ["no ledger key", async (l) => ({ ...payReq(l), paymentRef: undefined }) as RevolutRequest],
    [
      "ledger key not the request_id",
      async (l) => payReq(l, { paymentRef: "11111111-1111-4111-8111-111111111111" }),
    ],
    [
      "body with one extra key",
      async (l) =>
        payReq(l, {
          body: buildPay({ ...leg, requestId: RID }).body.replace(/}$/, ',"schedule_for":"x"}'),
        }),
    ],
    [
      "body missing a key",
      async (l) =>
        payReq(l, {
          body: buildPay({ ...leg, requestId: RID }).body.replace(/,"reference":"[^"]*"/, ""),
        }),
    ],
    ["API version 2.0", async (l) => payReq(l, { apiVersion: "2.0" })],
    ["a query string", async (l) => payReq(l, { query: { x: "1" } })],
  ];

  for (const [name, mutate] of cases) {
    it(`blocked: ${name}`, async () => {
      const l = (await gate().acquirePaymentLease(w.revolutConnectionId, "t")) as {
        ok: true;
        lease: string;
      };
      expect(l.ok).toBe(true);
      const r = await gate().call(await mutate(l.lease));
      expect(r.ok, name).toBe(false);
      expect(w.fake.stub.apiCalls, name).toHaveLength(0);
    });
  }

  it("the switch read AFTER the door: turned off while the call waits for its token, nothing is sent", async () => {
    const l = (await gate().acquirePaymentLease(w.revolutConnectionId, "t")) as {
      ok: true;
      lease: string;
    };
    // the stored token is stale, so the gate refreshes it between the door check and the fetch
    await db
      .prepare("UPDATE connections SET expires_at = ?2 WHERE id = ?1")
      .bind(w.revolutConnectionId, new Date(Date.now() - 1000).toISOString())
      .run();
    w.fake.stub.token = async (_f, n) => {
      await setSwitch(false);
      return refreshOk(n);
    };
    const r = await gate().call(payReq(l.lease));
    expect(r).toMatchObject({ ok: false, error: { code: "payments_payments_disabled" } });
    expect(w.fake.stub.tokenCalls.length).toBeGreaterThan(0);
    expect(w.fake.stub.apiCalls).toHaveLength(0);
    expect(await gate().paymentSendState(RID)).toBe("never_attempted");
  });

  it("the ledger key used once: a second write with everything valid is refused", async () => {
    const l = (await gate().acquirePaymentLease(w.revolutConnectionId, "t")) as {
      ok: true;
      lease: string;
    };
    expect((await gate().call(payReq(l.lease))).ok).toBe(true);
    expect(await gate().call(payReq(l.lease))).toMatchObject({
      ok: false,
      error: { code: "payment_already_attempted" },
    });
    // and the same key cannot be reused for a draft either (one key, one attempt, any endpoint)
    const d = buildPaymentDraft({ requestId: RID, payments: [leg] });
    expect(
      await gate().call(
        rreq(w.revolutConnectionId, {
          method: "POST",
          path: d.path,
          body: d.body,
          jobId: "revolut-payment",
          paymentLease: l.lease,
          paymentRef: RID,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "payment_already_attempted" } });
    expect(writes()).toHaveLength(1);
  });

  it("a counterparty write needs a cp- ledger key; drafts and payees still pass with a drafts-only mark", async () => {
    await setSetting("payments.verified", {
      at: "2026-07-01T00:00:00.000Z",
      by: "a@camelthorncapital.com",
      note: "drafts only",
      protocolVersion: (await import("../src/payments/protocol-version")).paymentsProtocolVersion(),
      checks: PAYMENTS_VERIFY_CHECKS.filter((c) => c !== "sandbox_pay_roundtrip"),
    });
    const l = (await gate().acquirePaymentLease(w.revolutConnectionId, "t")) as {
      ok: true;
      lease: string;
    };
    const cp = buildCreateCounterparty({ name: "Acme", iban: SUPPLIER_IBAN, currency: "EUR" });
    const cpReq = (ref: string) =>
      rreq(w.revolutConnectionId, {
        method: "POST",
        path: cp.path,
        body: cp.body,
        jobId: "revolut-payment",
        paymentLease: l.lease,
        paymentRef: ref,
      });
    expect((await gate().call(cpReq(RID))).ok).toBe(false);
    expect((await gate().call(cpReq(`cp-${RID}-0`))).ok).toBe(true);
    const d = buildPaymentDraft({ requestId: RID, payments: [leg] });
    expect(
      (
        await gate().call(
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
    expect(w.fake.calls("POST", "/pay")).toHaveLength(0);
  });
});

describe("3. a drafts-only verification never sends a direct /pay", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
  });

  it("a `pay` request made earlier is refused before the claim once the mark no longer covers pay", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    await setSetting("payments.verified", {
      at: "2026-07-01T00:00:00.000Z",
      by: "a@camelthorncapital.com",
      note: "drafts only",
      protocolVersion: (await import("../src/payments/protocol-version")).paymentsProtocolVersion(),
      checks: PAYMENTS_VERIFY_CHECKS.filter((c) => c !== "sandbox_pay_roundtrip"),
    });
    // the setting is back on drafts, so no `pay_mode_not_verified` blocker is raised by the settings
    await setSetting("payments.settings", { mode: "drafts" });
    expect(await send(w, id)).toEqual({ status: "refused", code: "pay_mode_not_verified" });
    expect((await rowOf(id)).status).toBe("ready");
    expect(writes()).toHaveLength(0);
  });
});

describe("4/8/9. pay mode: 429 after the send, the deadline, ambiguous payees", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
  });

  it("a 429 from Revolut on /pay is unknown (looked up), never a rejection that invites a new id", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    await fakeRevolutClock(w.revolutConnectionId); // the gate's 429 pause passes instantly
    w.fake.failStatus("POST /pay", 429);
    expect(await send(w, id)).toMatchObject({ status: "done", to: "outcome_unknown" });
    expect(w.fake.calls("POST", "/pay")).toHaveLength(1);
    expect(w.fake.calls("GET", "/transaction")).toHaveLength(1);
  });

  it("a 429 that Revolut DID process is adopted by the lookup", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    await fakeRevolutClock(w.revolutConnectionId);
    w.fake.fail("POST /pay", (c) => {
      w.fake.process(c);
      return Response.json({ message: "slow down" }, { status: 429 });
    });
    expect(await send(w, id)).toMatchObject({ status: "done", to: "submitted" });
  });

  it("after the deadline the still-running submission starts no further write", async () => {
    const id = await readyPayment(w);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    let reached: () => void = () => undefined;
    const reachedPay = new Promise<void>((r) => (reached = r));
    const client = {
      listCounterparties: () => Promise.resolve([]),
      async createCounterparty() {
        calls.push("cp");
        await held;
        return { id: CP, accounts: [{ id: CP, iban: SUPPLIER_IBAN }] };
      },
      async pay() {
        calls.push("pay");
        return { transactionId: "t", state: "pending" };
      },
      getTransactionByRequestId: () => Promise.resolve(null),
    } as unknown as RevolutClient;
    const submitter = createRevolutSubmitter({
      db,
      client,
      // asked only by a run that went on after the deadline, tried the payment and was stopped by the
      // deadline guard (F9a, N3: this is the event the test waits for; no real time passes)
      gate: {
        paymentSendState: () => {
          reached();
          return Promise.resolve("never_attempted" as const);
        },
      },
      connectionId: w.revolutConnectionId,
      lease: "lease-token-x",
      ibanKey: TEST_IBAN_KEY,
      connectionMode: "pay",
      timeoutMs: 20,
    });
    const r = await runSubmission(db, submitter, {
      kind: "payment",
      id,
      nowMs: Date.now(),
      owner: "t",
      ibanKey: TEST_IBAN_KEY,
    });
    expect(r).toMatchObject({ status: "done", to: "outcome_unknown" });
    release();
    await reachedPay;
    expect(calls).toEqual(["cp"]); // the payee call was in flight; the payment never started
  });

  it("a payee answer with several accounts and no account id is refused (Revolut could pick another)", async () => {
    const id = await readyPayment(w);
    w.fake.fail("POST /counterparty", () =>
      Response.json({
        id: CP,
        accounts: [{ iban: SUPPLIER_IBAN }, { iban: "DE89370400440532013000" }],
      }),
    );
    expect(await send(w, id)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(id)).status_reason).toBe(
      "provider_rejected:counterparty_account_ambiguous",
    );
    expect(w.fake.calls("POST", "/pay")).toHaveLength(0);
  });
});

describe("5/6. drafts: refusals are looked up; no second draft while an earlier one lives", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "drafts" });
  });

  it("a 4xx on /payment-drafts while Revolut DID create the draft: adopted, not rejected", async () => {
    const id = await readyPayment(w);
    w.fake.fail("POST /payment-drafts", (c) => {
      w.fake.process(c);
      return Response.json({ message: "weird" }, { status: 400 });
    });
    expect(await send(w, id)).toMatchObject({ status: "done", to: "submitted" });
    expect((await rowOf(id)).provider_id).toBe(w.fake.drafts[0]?.id);
  });

  it("an unknown draft is looked up BEFORE anything; it is never re-sent; redelivery is refused", async () => {
    const id = await readyPayment(w);
    w.fake.fail("POST /payment-drafts", new TypeError("reset"));
    expect(await send(w, id)).toMatchObject({ status: "done", to: "outcome_unknown" });
    expect(w.fake.calls("GET", "/payment-drafts")).toHaveLength(1); // the title lookup
    expect(await send(w, id)).toEqual({ status: "refused", code: "not_ready" });
    expect(w.fake.calls("POST", "/payment-drafts")).toHaveLength(1);
  });

  it("resolve-not-sent after a lookup that MISSED the draft, then a new request for the same invoice: refused (prior_attempt_live), no second draft", async () => {
    const id = await readyPayment(w);
    // Revolut creates the draft but the answer is lost; the list misses it twice (paging, A8)
    w.fake.fail("POST /payment-drafts", (c) => {
      w.fake.process(c);
      throw new TypeError("lost");
    });
    w.fake.fail(
      "GET /payment-drafts",
      () => Response.json([]),
      () => Response.json([]),
    );
    expect(await send(w, id)).toMatchObject({ status: "done", to: "outcome_unknown" });
    const t0 = Date.now();
    await reconcileAt(t0 + 20 * MIN);
    expect(
      await resolveNotSent(db, {
        kind: "payment",
        id,
        actor: w.emails.admin,
        nowMs: t0 + 21 * MIN,
        confirm: RESOLVE,
      }),
    ).toEqual({ ok: true });
    // the person makes a new request for the same invoice
    const again = await readyPayment(w);
    expect(await send(w, again)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(again)).status_reason).toBe("provider_rejected:prior_attempt_live");
    expect(w.fake.calls("POST", "/payment-drafts")).toHaveLength(1);
    expect(w.fake.drafts).toHaveLength(1);
  });

  it("an expired draft that is still approvable blocks a new request; once deleted in the app it does not", async () => {
    const id = await readyPayment(w);
    expect(await send(w, id)).toMatchObject({ status: "done", to: "submitted" });
    await reconcileAt(Date.now() + 6 * 86_400_000);
    expect(await rowOf(id)).toMatchObject({ status: "failed", status_reason: "draft_expired" });
    const b = await readyPayment(w);
    expect(await send(w, b)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(b)).status_reason).toBe("provider_rejected:prior_attempt_live");
    expect(w.fake.calls("POST", "/payment-drafts")).toHaveLength(1);
    // the old draft is deleted in the Revolut app: a new request may now go
    w.fake.drafts.splice(0);
    const c = await readyPayment(w);
    expect(await send(w, c)).toMatchObject({ status: "done", to: "submitted" });
    expect(w.fake.calls("POST", "/payment-drafts")).toHaveLength(2);
  });

  it("the prior-attempt lookup failing refuses the new request (fail closed)", async () => {
    const id = await readyPayment(w);
    expect(await send(w, id)).toMatchObject({ status: "done", to: "submitted" });
    await reconcileAt(Date.now() + 6 * 86_400_000);
    const b = await readyPayment(w);
    w.fake.fail("GET /payment-drafts/:id", () => Response.json({ m: "x" }, { status: 500 }));
    w.fake.fail("GET /payment-drafts/:id", () => Response.json({ m: "x" }, { status: 500 }));
    w.fake.fail("GET /payment-drafts/:id", () => Response.json({ m: "x" }, { status: 500 }));
    expect(await send(w, b)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(b)).status_reason).toBe("provider_rejected:prior_attempt_unchecked");
    expect(w.fake.calls("POST", "/payment-drafts")).toHaveLength(1);
  });

  it("an expired BULK draft approved later in the app is raised once", async () => {
    const batch = await readyBatch(w, [w.itemId, await anotherBill(w)]);
    expect(await send(w, batch, "batch")).toMatchObject({ status: "done", to: "submitted" });
    await reconcileAt(Date.now() + 6 * 86_400_000);
    expect((await rowOf(batch, "payment_batches")).status_reason).toBe("draft_expired");
    (w.fake.drafts[0] as { state: string }).state = "completed";
    const s = await reconcileAt(Date.now() + 7 * 86_400_000);
    expect(s.alerts).toBe(1);
    const row = await db
      .prepare(
        "SELECT last_result, alert_at FROM payment_reconcile WHERE subject_kind = 'batch' AND subject_id = ?1",
      )
      .bind(batch)
      .first<{ last_result: string; alert_at: string | null }>();
    expect(row?.last_result).toBe("approved_after_expiry");
    expect(row?.alert_at).not.toBeNull();
    expect((await reconcileAt(Date.now() + 8 * 86_400_000)).alerts).toBe(0);
  });
});

describe("6. pay mode: an earlier 'not sent' that turns out to exist blocks the next payment", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
  });

  it("refuses a new request for the same invoice when the old request_id now has a transaction", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    w.fake.fail("POST /pay", new TypeError("reset"));
    expect(await send(w, id)).toMatchObject({ status: "done", to: "outcome_unknown" });
    const t0 = Date.now();
    await reconcileAt(t0 + 20 * MIN);
    expect(
      await resolveNotSent(db, {
        kind: "payment",
        id,
        actor: w.emails.admin,
        nowMs: t0 + 21 * MIN,
        confirm: RESOLVE,
      }),
    ).toEqual({ ok: true });
    // ... and then the transaction shows up at Revolut after all
    const rid = (await rowOf(id)).request_id;
    w.fake.transactions.set("late", {
      id: "11111111-2222-4333-8444-555566667777",
      requestId: rid,
      state: "pending",
      amount: "1000.00",
      currency: "EUR",
      accountId: SOURCE_ACCOUNT_UUID,
    });
    const b = await readyPayment(w);
    expect(await send(w, b)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(b)).status_reason).toBe("provider_rejected:prior_attempt_live");
    expect(w.fake.calls("POST", "/pay")).toHaveLength(1);
  });
});

describe("7. resolve-not-sent guards", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
  });

  it("an early 'not found' is not enough, even when it is fresh and the call is old", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    w.fake.fail("POST /pay", new TypeError("reset"));
    await send(w, id);
    const t0 = Date.now();
    await reconcileAt(t0 + 2 * MIN); // too early after the call
    const r = await resolveNotSent(db, {
      kind: "payment",
      id,
      actor: w.emails.admin,
      nowMs: t0 + 16 * MIN,
      confirm: RESOLVE,
    });
    expect(r).toEqual({ ok: false, code: "lookup_too_early" });
    expect((await rowOf(id)).status).toBe("outcome_unknown");
  });

  it("refused while the lookup finds the payment (it exists)", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    w.fake.fail("POST /pay", (c) => {
      w.fake.process(c);
      throw new TypeError("lost");
    });
    // the immediate lookup is made to miss, so the request is unknown
    w.fake.fail("GET /transaction/:id", () => Response.json({ m: "no" }, { status: 404 }));
    expect(await send(w, id)).toMatchObject({ to: "outcome_unknown" });
    await reconcileAt(Date.now() + 20 * MIN); // finds it: submitted
    expect((await rowOf(id)).status).toBe("submitted");
    expect(
      await resolveNotSent(db, {
        kind: "payment",
        id,
        actor: w.emails.admin,
        nowMs: Date.now() + 21 * MIN,
        confirm: RESOLVE,
      }),
    ).toEqual({ ok: false, code: "not_unknown" });
  });

  it("a batch (bulk draft) can be resolved: the batch's lookup covers its items", async () => {
    w.fake.restore();
    w = await execWorld({ mode: "drafts" });
    const batch = await readyBatch(w, [w.itemId, await anotherBill(w)]);
    w.fake.fail("POST /payment-drafts", new TypeError("reset"));
    expect(await send(w, batch, "batch")).toMatchObject({ status: "done", to: "outcome_unknown" });
    const t0 = Date.now();
    await reconcileAt(t0 + 20 * MIN);
    expect(
      await resolveNotSent(db, {
        kind: "batch",
        id: batch,
        actor: w.emails.admin,
        nowMs: t0 + 21 * MIN,
        confirm: RESOLVE,
      }),
    ).toEqual({ ok: true });
    const items = await db
      .prepare("SELECT status, status_reason FROM payments WHERE batch_id = ?1")
      .bind(batch)
      .all<{ status: string; status_reason: string }>();
    expect(items.results.map((r) => `${r.status}:${r.status_reason}`)).toEqual([
      "rejected:resolved_not_sent",
      "rejected:resolved_not_sent",
    ]);
  });

  it("a batch item alone still cannot be moved out of unknown without its batch", async () => {
    w.fake.restore();
    w = await execWorld({ mode: "drafts" });
    const batch = await readyBatch(w, [w.itemId, await anotherBill(w)]);
    w.fake.fail("POST /payment-drafts", new TypeError("reset"));
    await send(w, batch, "batch");
    await reconcileAt(Date.now() + 20 * MIN);
    await expect(
      db.prepare("UPDATE payments SET status = 'rejected' WHERE batch_id = ?1").bind(batch).run(),
    ).rejects.toThrow(/not_looked_up|payment_err/);
  });
});

describe("10/11. no full IBAN anywhere; preview hash = sent bytes", () => {
  it("after a full pay run and a refusal whose code is an IBAN, no table holds the full IBAN", async () => {
    w = await execWorld({ mode: "pay" });
    const a = await readyPayment(w);
    expect(await send(w, a)).toMatchObject({ to: "submitted" });
    const b = await readyPayment(w, { itemId: await anotherBill(w) });
    w.fake.failStatus("POST /pay", 422, { message: "bad", code: SUPPLIER_IBAN });
    expect(await send(w, b)).toMatchObject({ to: "rejected" });
    expect((await rowOf(b)).status_reason).toBe("provider_rejected:http_422");
    for (const [t, cols] of [
      ["payment_events", "code"],
      ["audit_log", "COALESCE(before_json,'') || COALESCE(after_json,'')"],
      ["idempotency_keys", "COALESCE(result_json,'') || key"],
      ["payment_reconcile", "COALESCE(provider_state,'') || COALESCE(transaction_id,'')"],
      ["payment_payees", "name || created_for"],
      ["payments", "COALESCE(status_reason,'') || COALESCE(provider_id,'')"],
    ] as const) {
      const n = await db
        .prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE upper(${cols}) LIKE '%' || ?1 || '%'`)
        .bind(SUPPLIER_IBAN)
        .first<{ n: number }>();
      expect(n?.n, t).toBe(0);
    }
  });

  it("pay mode: the preview's sha256 equals the sha256 of the body that reached Revolut", async () => {
    w = await execWorld({ mode: "pay" });
    const id = await readyPayment(w);
    await seedPayee(id);
    const p = await previewPayment(db, {
      kind: "payment",
      id,
      actor: w.emails.admin,
      ibanKey: TEST_IBAN_KEY,
    });
    expect(p.ok).toBe(true);
    const shown = p.ok ? p.calls.find((c) => c.step === "pay") : undefined;
    expect(shown?.usesPlaceholderPayee).toBe(false);
    expect(await send(w, id)).toMatchObject({ to: "submitted" });
    const sent = w.fake.calls("POST", "/pay")[0]?.body ?? "";
    expect(sha256Hex(sent)).toBe(shown?.sha256);
    expect(sent).toContain('"amount":1000.00,');
  });

  it("drafts mode: the preview's sha256 equals the sha256 of the draft that reached Revolut", async () => {
    w = await execWorld({ mode: "drafts" });
    const id = await readyPayment(w);
    await seedPayee(id);
    const p = await previewPayment(db, {
      kind: "payment",
      id,
      actor: w.emails.admin,
      ibanKey: TEST_IBAN_KEY,
    });
    const shown = p.ok ? p.calls.find((c) => c.step === "draft") : undefined;
    expect(await send(w, id)).toMatchObject({ to: "submitted" });
    const sent = w.fake.calls("POST", "/payment-drafts")[0]?.body ?? "";
    expect(sha256Hex(sent)).toBe(shown?.sha256);
  });
});

describe("the switch OFF mid-flight does not blind the reconciliation", () => {
  it("an unknown payment is still looked up and adopted with every switch off", async () => {
    w = await execWorld({ mode: "pay" });
    const id = await readyPayment(w);
    await seedPayee(id);
    w.fake.fail("POST /pay", (c) => {
      w.fake.process(c);
      throw new TypeError("lost");
    });
    w.fake.fail("GET /transaction/:id", () => Response.json({ m: "no" }, { status: 404 }));
    expect(await send(w, id)).toMatchObject({ to: "outcome_unknown" });
    await setSwitch(false);
    await gateExecution(w.revolutConnectionId, false);
    await reconcileAt(Date.now() + 6 * MIN);
    expect((await rowOf(id)).status).toBe("submitted");
    expect(w.fake.calls("POST", "/pay")).toHaveLength(1);
  });
});
