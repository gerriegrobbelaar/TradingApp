/**
 * Payment execution end to end (P9b, ADR 0050): a `ready` request goes through `submitPayment`, the
 * REAL RevolutGate (allow-list, lease, ledger), the REAL client and submitter, to a SCRIPTED fake
 * Revolut. Includes the fault-injection tests of the failure matrix (ADR 0050): crash between claim
 * and send, a lost answer, after send before persist, duplicate delivery, lease expiry, and the
 * concurrency tests (two submissions, the daily ceiling).
 */
import { env, runInDurableObject } from "cloudflare:test";
import { paymentConfirmPhrase } from "@camelthorn/core";
import { createRevolutClient, type RevolutClient } from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markStaleSubmissions, runSubmission, setSubmitterForTests } from "../src/payments/submit";
import { resolveNotSent, reconcilePayments } from "../src/payments/reconcile";
import type { RevolutGate } from "../src/revolut/gate";
import { createRevolutGateTransport } from "../src/revolut/gate-transport";
import {
  anotherBill,
  db,
  execWorld,
  onEnv,
  readyBatch,
  readyPayment,
  rowOf,
  send,
  TEST_IBAN_KEY,
  type ExecWorld,
} from "./payments-exec-helpers";
import { SOURCE_ACCOUNT_UUID } from "./payments-fake-revolut";
import { putPaymentSettings, setSwitch, withoutPaymentTriggers } from "./payments-helpers";
import { fakeRevolutClock, revolutGate } from "./revolut-helpers";

let w: ExecWorld;
afterEach(() => {
  setSubmitterForTests(null);
  w.fake.restore();
});

const payCalls = () => w.fake.calls("POST", "/pay");
const events = async (id: number): Promise<string[]> =>
  (
    await db
      .prepare(
        "SELECT to_status || ':' || COALESCE(code, '') AS e FROM payment_events WHERE payment_id = ?1 ORDER BY id",
      )
      .bind(id)
      .all<{ e: string }>()
  ).results.map((r) => r.e);
const payees = async (): Promise<number> =>
  (await db.prepare("SELECT COUNT(*) AS n FROM payment_payees").first<{ n: number }>())?.n ?? -1;

describe("pay mode: the happy path", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
  });

  it("creates the payee once, sends one /pay with the STORED request id and exact amount, ends submitted", async () => {
    const id = await readyPayment(w);
    const before = await rowOf(id);
    const r = await send(w, id);
    expect(r).toMatchObject({ status: "done", to: "submitted", code: "accepted" });
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "submitted", submit_attempts: 1 });
    expect(row.provider_id).toMatch(/^[0-9a-f-]{36}$/);
    // one payee with the verified name and IBAN
    const cps = w.fake.calls("POST", "/counterparty");
    expect(cps).toHaveLength(1);
    expect(JSON.parse(cps[0]?.body ?? "{}")).toEqual({
      company_name: "Acme Supplies B.V.",
      bank_country: "NL",
      currency: "EUR",
      iban: "NL91ABNA0417164300",
    });
    // one payment: the stored request_id, the raw decimal amount, our account, our reference
    expect(payCalls()).toHaveLength(1);
    const body = payCalls()[0]?.body ?? "";
    expect(JSON.parse(body)).toMatchObject({
      request_id: before.request_id,
      account_id: SOURCE_ACCOUNT_UUID,
      currency: "EUR",
      reference: expect.stringMatching(/^Invoice INV-/),
    });
    expect(body).toContain('"amount":1000.00,');
    expect(await payees()).toBe(1);
    expect(await events(id)).toEqual(
      expect.arrayContaining(["submitting:claimed", "submitted:accepted"]),
    );
    // idempotency key stored, completed, and no IBAN in it
    const key = await db
      .prepare(
        "SELECT status, result_json FROM idempotency_keys WHERE scope = 'revolut.pay' AND key = ?1",
      )
      .bind(before.request_id)
      .first<{ status: string; result_json: string }>();
    expect(key?.status).toBe("completed");
    expect(key?.result_json).not.toContain("NL91");
  });

  it("a second payment to the same supplier reuses the payee", async () => {
    const a = await readyPayment(w);
    await send(w, a);
    const b = await readyPayment(w, { itemId: await anotherBill(w) });
    expect(await send(w, b)).toMatchObject({ status: "done", to: "submitted" });
    expect(w.fake.calls("POST", "/counterparty")).toHaveLength(1);
    expect(payCalls()).toHaveLength(2);
    expect(new Set(payCalls().map((c) => JSON.parse(c.body ?? "{}").request_id)).size).toBe(2);
  });

  it("a payment Revolut declines in its answer is rejected, not submitted", async () => {
    const id = await readyPayment(w);
    w.fake.fail("POST /pay", () =>
      Response.json({
        id: "64f1e2a0-1111-4222-8333-444455556666",
        state: "declined",
        reason_code: "invalid_account",
      }),
    );
    expect(await send(w, id)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(id)).status_reason).toBe(
      "provider_rejected:provider_declined_invalid_account",
    );
  });

  it("the pay mode on a connection that is not on the Company plan is rejected before any call", async () => {
    const id = await readyPayment(w);
    await db
      .prepare("UPDATE connections SET payments_mode = 'drafts' WHERE id = ?1")
      .bind(w.revolutConnectionId)
      .run();
    expect(await send(w, id)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(id)).status_reason).toBe("provider_rejected:mode_not_allowed");
    expect(w.fake.stub.apiCalls).toHaveLength(0);
  });
});

describe("drafts mode", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "drafts" });
  });

  it("creates one draft titled from the request id; no /pay; ends submitted with the draft id", async () => {
    const id = await readyPayment(w);
    const rid = (await rowOf(id)).request_id;
    expect(await send(w, id)).toMatchObject({ status: "done", to: "submitted" });
    expect(payCalls()).toHaveLength(0);
    const drafts = w.fake.calls("POST", "/payment-drafts");
    expect(drafts).toHaveLength(1);
    const d = JSON.parse(drafts[0]?.body ?? "{}") as { title: string; payments: unknown[] };
    expect(d.title).toBe(`CF-${rid.replace(/-/g, "").slice(0, 12)}`);
    expect(d.payments).toHaveLength(1);
    expect((await rowOf(id)).provider_id).toBe(w.fake.drafts[0]?.id);
  });

  it("a batch becomes ONE bulk draft with one payment per invoice; items follow the batch", async () => {
    const ids = [w.itemId, await anotherBill(w), await anotherBill(w, 55_000)];
    const batch = await readyBatch(w, ids);
    expect(await send(w, batch, "batch")).toMatchObject({ status: "done", to: "submitted" });
    const drafts = w.fake.calls("POST", "/payment-drafts");
    expect(drafts).toHaveLength(1);
    const d = JSON.parse(drafts[0]?.body ?? "{}") as { payments: { amount: number }[] };
    expect(d.payments).toHaveLength(3);
    expect(drafts[0]?.body).toContain('"amount":550.00');
    expect(w.fake.calls("POST", "/counterparty")).toHaveLength(1); // one supplier, one payee
    const items = await db
      .prepare("SELECT status FROM payments WHERE batch_id = ?1")
      .bind(batch)
      .all<{ status: string }>();
    expect(items.results.map((r) => r.status)).toEqual(["submitted", "submitted", "submitted"]);
  });
});

describe("failure matrix: before and around the counterparty", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
  });

  it("[before counterparty] a stored IBAN that no longer matches the approved fingerprint: refused, nothing claimed, nothing sent", async () => {
    const id = await readyPayment(w);
    await withoutPaymentTriggers(["payments_guard_payload"], async () => {
      await db
        .prepare("UPDATE payments SET beneficiary_iban = 'DE89370400440532013000' WHERE id = ?1")
        .bind(id)
        .run();
    });
    expect(await send(w, id)).toEqual({ status: "refused", code: "iban_binding_broken" });
    expect((await rowOf(id)).status).toBe("ready");
    expect(w.fake.stub.apiCalls).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM payment_claims").first()).toMatchObject({
      n: 0,
    });
  });

  it("[counterparty fails] Revolut refuses the payee: the request is rejected and NO payment is attempted", async () => {
    const id = await readyPayment(w);
    w.fake.failStatus("POST /counterparty", 422, { message: "bad iban", code: 1000 });
    expect(await send(w, id)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(id)).status_reason).toMatch(/^provider_rejected:counterparty_/);
    expect(payCalls()).toHaveLength(0);
    expect(await payees()).toBe(0);
  });

  it("[counterparty fails, answer lost] a payee that Revolut DID create is found and used (no second payee)", async () => {
    const id = await readyPayment(w);
    w.fake.fail("POST /counterparty", (c) => {
      w.fake.process(c); // Revolut created it ...
      throw new TypeError("answer lost"); // ... but the answer never came
    });
    expect(await send(w, id)).toMatchObject({ status: "done", to: "submitted" });
    expect(w.fake.counterparties).toHaveLength(1);
    expect(await payees()).toBe(1);
    expect(payCalls()).toHaveLength(1);
  });

  it("[counterparty answer] without the IBAN we sent: fail closed, rejected, no payment", async () => {
    const id = await readyPayment(w);
    w.fake.fail("POST /counterparty", () =>
      Response.json({
        id: "5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11",
        accounts: [{ id: "a1", iban: "DE89370400440532013000" }],
      }),
    );
    expect(await send(w, id)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(id)).status_reason).toBe("provider_rejected:counterparty_iban_unconfirmed");
    expect(payCalls()).toHaveLength(0);
  });

  it("[after counterparty, before send] the switch goes OFF in between: the gate refuses the payment, it was never sent", async () => {
    const id = await readyPayment(w);
    w.fake.fail("POST /counterparty", async (c) => {
      const res = w.fake.process(c);
      await setSwitch(false);
      return res;
    });
    expect(await send(w, id)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(id)).status_reason).toMatch(/^provider_rejected:payments_/);
    expect(payCalls()).toHaveLength(0);
    expect(await payees()).toBe(1); // the payee stays; a new request reuses it
  });

  it("[lease expires in between] the gate refuses the payment: never attempted, rejected", async () => {
    const id = await readyPayment(w);
    w.fake.fail("POST /counterparty", async (c) => {
      const res = w.fake.process(c);
      await runInDurableObject(revolutGate(w.revolutConnectionId), (g: RevolutGate) => {
        const later = Date.now() + 10 * 60_000;
        g.now = () => later;
      });
      return res;
    });
    expect(await send(w, id)).toMatchObject({ status: "done", to: "rejected" });
    expect((await rowOf(id)).status_reason).toBe("provider_rejected:payment_lease");
    expect(payCalls()).toHaveLength(0);
  });
});

describe("failure matrix: before, during and after the send", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
    // a cached payee: the first Revolut call is the payment itself
    await db
      .prepare(
        `INSERT INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for)
         SELECT ?1, iban_fingerprint, '5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11', 'Acme', 'seed-seed' FROM payments LIMIT 1`,
      )
      .bind(w.revolutConnectionId)
      .run();
  });

  const seedPayee = async (id: number): Promise<void> => {
    await db
      .prepare(
        `INSERT OR IGNORE INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for)
         SELECT ?1, iban_fingerprint, '5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11', 'Acme', 'seed-seed' FROM payments WHERE id = ?2`,
      )
      .bind(w.revolutConnectionId, id)
      .run();
  };

  it("[before send] the token cannot be refreshed: the gate never attempted it, so the request is rejected (safe to recreate)", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    await db
      .prepare("UPDATE connections SET expires_at = ?2 WHERE id = ?1")
      .bind(w.revolutConnectionId, new Date(Date.now() - 1000).toISOString())
      .run();
    w.fake.stub.token = () => new Response("down", { status: 500 });
    await fakeRevolutClock(w.revolutConnectionId);
    expect(await send(w, id)).toMatchObject({ status: "done", to: "rejected" });
    expect(payCalls()).toHaveLength(0);
  });

  it("[during send] a network failure: outcome_unknown, ONE call, never resent; the lookup finds nothing", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    w.fake.fail("POST /pay", new TypeError("connection reset"));
    expect(await send(w, id)).toMatchObject({ status: "done", to: "outcome_unknown" });
    expect(payCalls()).toHaveLength(1);
    expect(w.fake.calls("GET", "/transaction")).toHaveLength(1); // the immediate lookup by request_id
    // a redelivery of the same job cannot send: the request is no longer ready
    expect(await send(w, id)).toEqual({ status: "refused", code: "not_ready" });
    expect(payCalls()).toHaveLength(1);
    expect((await rowOf(id)).submit_attempts).toBe(1);
  });

  it("[during send, but Revolut got it] the lost answer is found by request_id and ADOPTED, never resent", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    w.fake.fail("POST /pay", (c) => {
      w.fake.process(c);
      throw new TypeError("answer lost");
    });
    expect(await send(w, id)).toMatchObject({ status: "done", to: "submitted" });
    expect(payCalls()).toHaveLength(1);
    expect((await rowOf(id)).provider_id).toBe([...w.fake.transactions.keys()][0]);
  });

  it("[during send] a 5xx is unknown, not rejected; a 401 is unknown too (task rule) and is not re-sent", async () => {
    const a = await readyPayment(w);
    await seedPayee(a);
    w.fake.failStatus("POST /pay", 500);
    expect(await send(w, a)).toMatchObject({ status: "done", to: "outcome_unknown" });
    const b = await readyPayment(w, { itemId: await anotherBill(w) });
    w.fake.failStatus("POST /pay", 401);
    expect(await send(w, b)).toMatchObject({ status: "done", to: "outcome_unknown" });
    expect(payCalls()).toHaveLength(2); // one each, never a second try
  });

  it("[refused by Revolut] a 400 is rejected, but only after the lookup found no payment under that id", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    w.fake.failStatus("POST /pay", 400, { message: "bad reference", code: 1001 });
    expect(await send(w, id)).toMatchObject({ status: "done", to: "rejected" });
    expect(w.fake.calls("GET", "/transaction")).toHaveLength(1);
    expect((await rowOf(id)).status_reason).toMatch(/^provider_rejected:/);
  });

  it("[refused by Revolut, yet a payment exists] a 'rejection' with a transaction under our id is NOT rejected", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    w.fake.fail("POST /pay", (c) => {
      w.fake.process(c);
      return Response.json({ message: "weird" }, { status: 400 });
    });
    expect(await send(w, id)).toMatchObject({ status: "done", to: "submitted" });
  });

  it("[request id already used] 409: look it up and adopt; if not found it stays unknown (never a new id)", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    const rid = (await rowOf(id)).request_id;
    // Revolut already has a transaction with this id (an earlier answer was lost)
    w.fake.transactions.set("t1", {
      id: "11111111-2222-4333-8444-555566667777",
      requestId: rid,
      state: "completed",
      amount: "1000.00",
      currency: "EUR",
      accountId: SOURCE_ACCOUNT_UUID,
    });
    expect(await send(w, id)).toMatchObject({ status: "done", to: "submitted" });
    expect((await rowOf(id)).provider_id).toBe("11111111-2222-4333-8444-555566667777");
    // 409 and nothing found: unknown
    const b = await readyPayment(w, { itemId: await anotherBill(w) });
    w.fake.failStatus("POST /pay", 409, { message: "Request ID already used" });
    expect(await send(w, b)).toMatchObject({ status: "done", to: "outcome_unknown" });
    expect(payCalls().length).toBe(2);
  });

  it("[adopt only what is ours] a transaction under our id with ANOTHER amount is not adopted", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    const rid = (await rowOf(id)).request_id;
    w.fake.fail("POST /pay", (c) => {
      w.fake.process(c);
      throw new TypeError("lost");
    });
    // make the transaction at Revolut differ from the request
    const orig = w.fake.process.bind(w.fake);
    w.fake.process = (c) => {
      const res = orig(c);
      for (const t of w.fake.transactions.values()) if (t.requestId === rid) t.amount = "1.00";
      return res;
    };
    expect(await send(w, id)).toMatchObject({ status: "done", to: "outcome_unknown" });
  });

  it("[after send, before persist] Revolut accepted but the Worker's write failed: unknown, then the reconciliation adopts it; one /pay in total", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    // The write of "submitted" fails (fault injection by a temporary trigger).
    await db
      .prepare(
        "CREATE TRIGGER fault_submitted BEFORE UPDATE OF status ON payments WHEN NEW.status = 'submitted' BEGIN SELECT RAISE(ABORT, 'boom'); END",
      )
      .run();
    let r;
    try {
      r = await send(w, id);
    } finally {
      await db.prepare("DROP TRIGGER fault_submitted").run();
    }
    expect(r).toMatchObject({ status: "done", to: "outcome_unknown", code: "finish_failed" });
    expect(payCalls()).toHaveLength(1);
    // The row is still `submitting` with a live claim; its lease runs out, it becomes unknown ...
    const later = Date.now() + 11 * 60_000;
    expect(await markStaleSubmissions(db, later)).toBe(1);
    expect((await rowOf(id)).status).toBe("outcome_unknown");
    // ... and the reconciliation finds the transaction by request_id.
    const sum = await reconcilePayments({
      db,
      nowMs: later,
      client: () => clientFor(),
    });
    expect(sum.checked).toBe(1);
    expect((await rowOf(id)).status).toBe("submitted");
    expect(payCalls()).toHaveLength(1);
  });

  it("[crash between claim and send] a claim whose Worker died: unknown after the lease; the lookup says not found; only a person, later, can call it unsent", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    // A submitter that dies right after the claim (it throws before it sends anything).
    const r = await runSubmission(
      db,
      { available: true, submit: () => Promise.reject(new Error("worker died")) },
      { kind: "payment", id, nowMs: Date.now(), owner: "job", ibanKey: TEST_IBAN_KEY },
    );
    expect(r).toMatchObject({ status: "done", to: "outcome_unknown" });
    expect(payCalls()).toHaveLength(0);
    const now = Date.now() + 60_000;
    // A person cannot call it unsent before the reconciliation looked
    expect(
      await resolveNotSent(db, {
        kind: "payment",
        id,
        actor: w.emails.admin,
        nowMs: now,
        confirm: "MARK PAYMENT AS NOT SENT",
      }),
    ).toMatchObject({ ok: false, code: "lookup_not_fresh" });
    await reconcilePayments({ db, nowMs: now, client: () => clientFor() });
    expect((await rowOf(id)).status).toBe("outcome_unknown");
    const tooSoon = await resolveNotSent(db, {
      kind: "payment",
      id,
      actor: w.emails.admin,
      nowMs: now,
      confirm: "MARK PAYMENT AS NOT SENT",
    });
    expect(tooSoon).toMatchObject({ ok: false, code: "too_soon" });
    const later = Date.now() + 20 * 60_000;
    await reconcilePayments({ db, nowMs: later, client: () => clientFor() });
    expect(
      await resolveNotSent(db, {
        kind: "payment",
        id,
        actor: w.emails.admin,
        nowMs: later,
        confirm: "wrong",
      }),
    ).toMatchObject({ ok: false, code: "confirmation_required" });
    expect(
      await resolveNotSent(db, {
        kind: "payment",
        id,
        actor: w.emails.admin,
        nowMs: later,
        confirm: "MARK PAYMENT AS NOT SENT",
      }),
    ).toEqual({ ok: true });
    expect(await rowOf(id)).toMatchObject({
      status: "rejected",
      status_reason: "resolved_not_sent",
    });
    expect(payCalls()).toHaveLength(0);
  });

  it("the database refuses 'rejected' from unknown without a lookup that found nothing", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    await runSubmission(
      db,
      { available: true, submit: () => Promise.reject(new Error("died")) },
      {
        kind: "payment",
        id,
        nowMs: Date.now(),
        owner: "job",
        ibanKey: TEST_IBAN_KEY,
      },
    );
    await expect(
      db.prepare("UPDATE payments SET status = 'rejected' WHERE id = ?1").bind(id).run(),
    ).rejects.toThrow(/not_looked_up/);
  });
});

describe("duplicate delivery and concurrency", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
  });

  it("the same job delivered twice at once: ONE payment is sent, the other call is refused", async () => {
    const id = await readyPayment(w);
    const [a, b] = await Promise.all([send(w, id), send(w, id)]);
    expect(payCalls()).toHaveLength(1);
    const done = [a, b].filter((r) => r.status === "done");
    expect(done).toHaveLength(1);
    const other = [a, b].find((r) => r.status !== "done");
    expect(["refused", "already_claimed"]).toContain(other?.status);
    expect((await rowOf(id)).submit_attempts).toBe(1);
  });

  it("two different payments at once are serialised through the gate: one waits (busy), none overlaps", async () => {
    const a = await readyPayment(w);
    const b = await readyPayment(w, { itemId: await anotherBill(w) });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let inFlight = 0;
    let maxInFlight = 0;
    // F9a (N3): the test waits for this event, not for a number of milliseconds
    let atRevolut: () => void = () => undefined;
    const aIsAtRevolut = new Promise<void>((r) => (atRevolut = r));
    w.fake.fail("POST /pay", async (c) => {
      atRevolut();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await held;
      inFlight--;
      return w.fake.process(c);
    });
    const first = send(w, a);
    // wait until A's payment is at Revolut, then B tries
    await aIsAtRevolut;
    const second = await send(w, b);
    expect(second).toEqual({ status: "refused", code: "busy" });
    expect((await rowOf(b)).status).toBe("ready"); // untouched, not claimed
    release();
    expect(await first).toMatchObject({ status: "done", to: "submitted" });
    // now B may go
    expect(await send(w, b)).toMatchObject({ status: "done", to: "submitted" });
    expect(maxInFlight).toBe(1);
    expect(payCalls()).toHaveLength(2);
  });

  it("daily ceiling tightened after two requests were made: NEITHER is sent", async () => {
    const a = await readyPayment(w);
    const b = await readyPayment(w, { itemId: await anotherBill(w) });
    await putPaymentSettings({ maxRequestMinor: 150_000, maxDailyMinor: 150_000 });
    const [ra, rb] = await Promise.all([send(w, a), send(w, b)]);
    expect(payCalls()).toHaveLength(0);
    for (const r of [ra, rb]) {
      expect(r.status === "refused").toBe(true);
    }
    expect((await rowOf(a)).status).toBe("ready");
    expect((await rowOf(b)).status).toBe("ready");
  });

  it("daily ceiling exactly the sum: both go, one after the other, the second sees the first as open", async () => {
    const a = await readyPayment(w);
    const b = await readyPayment(w, { itemId: await anotherBill(w) });
    await putPaymentSettings({ maxRequestMinor: 200_000, maxDailyMinor: 200_000 });
    expect(await send(w, a)).toMatchObject({ status: "done", to: "submitted" });
    expect(await send(w, b)).toMatchObject({ status: "done", to: "submitted" });
    // a third request would exceed the day
    const c = await readyPayment(w, { itemId: await anotherBill(w) }).catch(
      (e: Error) => e.message,
    );
    expect(String(c)).toMatch(/over_daily_limit|blocked/);
  });
});

describe("switches: nothing is enabled by default", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
  });

  it("with the deploy switch off submitPayment refuses and calls nothing", async () => {
    const id = await readyPayment(w);
    const off = { ...onEnv(), REVOLUT_PAYMENTS_EXECUTION: "off" };
    expect(await send(w, id, "payment", off)).toEqual({
      status: "refused",
      code: "payments_disabled",
    });
    const missing = { ...onEnv() } as Record<string, unknown>;
    delete missing["REVOLUT_PAYMENTS_EXECUTION"];
    expect(await send(w, id, "payment", missing as never)).toEqual({
      status: "refused",
      code: "payments_disabled",
    });
    expect(w.fake.stub.apiCalls).toHaveLength(0);
    expect((await rowOf(id)).status).toBe("ready");
  });

  it("with the D1 switch off or the mark gone the request is refused before the claim", async () => {
    const id = await readyPayment(w);
    await setSwitch(false);
    expect(await send(w, id)).toMatchObject({ status: "refused" });
    expect(w.fake.stub.apiCalls).toHaveLength(0);
    expect((await rowOf(id)).status).toBe("ready");
  });

  it("the payee is never created from request input: the confirm phrase cannot change who is paid", async () => {
    const id = await readyPayment(w);
    const row = await db
      .prepare("SELECT beneficiary_name, amount_minor FROM payments WHERE id = ?1")
      .bind(id)
      .first<{ beneficiary_name: string; amount_minor: number }>();
    expect(paymentConfirmPhrase(row?.amount_minor ?? 0, "EUR", "4300")).toBe(
      "PAY 1000.00 EUR TO 4300",
    );
    await send(w, id);
    expect(JSON.parse(w.fake.calls("POST", "/counterparty")[0]?.body ?? "{}").company_name).toBe(
      row?.beneficiary_name,
    );
  });
});

// A client for the reconciliation tests: through the real gate, as the job does.
async function clientFor(): Promise<RevolutClient> {
  return createRevolutClient(createRevolutGateTransport(env, w.revolutConnectionId), {
    connectionId: w.revolutConnectionId,
    jobId: "revolut-payment:reconcile",
    priority: "job",
    sleep: () => Promise.resolve(),
  });
}
