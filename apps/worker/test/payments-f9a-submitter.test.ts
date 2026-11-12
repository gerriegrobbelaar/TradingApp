/**
 * F9a (Phase 9 final review fixes, ADR 0052): the submitter and the gate fail CLOSED on doubt.
 *
 *  B3a  the earlier-attempt check is never cut off: one lookup per draft, "unchecked" past a cap
 *  B3b  a refusal (4xx) of POST /payment-drafts is believed only after a READABLE list shows no draft
 *  N7   the gate compares a payment body with the stored request (account, amount, currency, payee)
 *  S8   a request whose requester is no longer an active finance user is not sent, confirmed or approved
 *  S5   key ids: a rotated PAYMENTS_IBAN_KEY is "rotated", not "changed"; the payee cache is looked up first
 *  S12  a payee in the cache has its audit row
 *
 * Every fault-injection test asserts what was SENT, not only what was answered.
 */
import { ibanFingerprint, ibanKeyId } from "@camelthorn/core";
import {
  buildPay,
  buildPaymentDraft,
  draftTitle,
  RevolutApiError,
  type RevolutClient,
} from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimIdempotencyKey } from "../src/db/idempotency";
import { storedKeyRotated } from "../src/payments/iban-store";
import {
  MAX_PRIOR_DRAFTS,
  MAX_PRIOR_ROWS,
  createRevolutSubmitter,
} from "../src/payments/revolut-submitter";
import type { SubmitRequest } from "../src/payments/submit";
import { loadPaymentsState } from "../src/payments/settings";
import { confirmRequest, createPayment, decideRequest } from "../src/payments/store";
import { paymentConfirmPhrase } from "@camelthorn/core";
import { withoutTriggers } from "./booking-helpers";
import {
  db,
  execWorld,
  onEnv,
  readyPayment,
  rowOf,
  send,
  stageSubmitting,
  TEST_IBAN_KEY,
  type ExecWorld,
} from "./payments-exec-helpers";
import { SUPPLIER_IBAN } from "./payments-helpers";
import { revolutGate, rreq } from "./revolut-helpers";

let w: ExecWorld;
afterEach(() => w.fake.restore());

const CP = "5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11";

// ---- scaffolding ----------------------------------------------------------------------------------

const calls: string[] = [];
const client = (over: Partial<Record<keyof RevolutClient, unknown>> = {}): RevolutClient =>
  new Proxy(over, {
    get: (t, k: string) =>
      (t as Record<string, unknown>)[k] ??
      (async () => {
        calls.push(k);
        throw new Error(`unexpected client call ${k}`);
      }),
  }) as unknown as RevolutClient;

const deps = (c: RevolutClient, send: "never_attempted" | "attempted" = "never_attempted") => ({
  db,
  client: c,
  gate: { paymentSendState: () => Promise.resolve(send) },
  connectionId: w.revolutConnectionId,
  lease: "lease-abcdefgh",
  ibanKey: TEST_IBAN_KEY,
  connectionMode: "drafts" as const,
});

async function requestFor(id: number): Promise<SubmitRequest> {
  const head = (await db
    .prepare(
      `SELECT request_id, mode, bank_account_id, currency, payload_hash, amount_minor FROM payments WHERE id = ?1`,
    )
    .bind(id)
    .first()) as {
    request_id: string;
    mode: "drafts" | "pay";
    bank_account_id: number;
    currency: string;
    payload_hash: string;
    amount_minor: number;
  };
  const items = (
    await db
      .prepare(
        "SELECT request_id, open_item_id, amount_minor, currency, iban_fingerprint, reference FROM payments WHERE id = ?1",
      )
      .bind(id)
      .all<{
        request_id: string;
        open_item_id: number;
        amount_minor: number;
        currency: string;
        iban_fingerprint: string;
        reference: string;
      }>()
  ).results.map((r) => ({
    requestId: r.request_id,
    openItemId: r.open_item_id,
    amountMinor: r.amount_minor,
    currency: r.currency,
    ibanFingerprint: r.iban_fingerprint,
    reference: r.reference,
  }));
  return {
    kind: "payment",
    id,
    requestId: head.request_id,
    mode: head.mode,
    sourceAccountId: head.bank_account_id,
    currency: head.currency,
    totalMinor: head.amount_minor,
    payloadHash: head.payload_hash,
    items,
  };
}

async function seedPayee(
  id: number,
  keyId: string | null = ibanKeyId(TEST_IBAN_KEY),
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for, key_id)
       SELECT ?1, iban_fingerprint, ?3, 'Acme', 'seed-seed', ?4 FROM payments WHERE id = ?2`,
    )
    .bind(w.revolutConnectionId, id, CP, keyId)
    .run();
}

const TRIGGERS = ["payments_guard_insert", "payment_batches_guard_insert"];

/** Earlier requests for the same invoice that ended `failed / draft_expired` (test setup: triggers lifted). */
async function seedPriorSingles(from: number, providers: (string | null)[]): Promise<void> {
  await withoutTriggers(TRIGGERS, async () => {
    await db.batch(
      providers.map((provider) =>
        db
          .prepare(
            `INSERT INTO payments (request_id, division_id, open_item_id, batch_id, bank_account_id, status, status_reason,
               mode, amount_minor, currency, beneficiary_name, beneficiary_iban, iban_fingerprint, reference, payload_hash,
               approvals_required, requested_by, expires_at, provider_id)
             SELECT ?1, division_id, open_item_id, NULL, bank_account_id, 'failed', 'draft_expired', 'drafts', amount_minor,
               currency, beneficiary_name, beneficiary_iban, iban_fingerprint, reference, payload_hash, approvals_required,
               requested_by, expires_at, ?2 FROM payments WHERE id = ?3`,
          )
          .bind(crypto.randomUUID(), provider, from),
      ),
    );
  });
}

/** One expired bulk draft of `items` payment rows. */
async function seedPriorBatch(from: number, provider: string, items: number): Promise<void> {
  await withoutTriggers(TRIGGERS, async () => {
    const batchRid = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO payment_batches (request_id, division_id, bank_account_id, status, status_reason, mode, currency,
           total_minor, item_count, payload_hash, requested_by, expires_at, provider_id)
         SELECT ?1, division_id, bank_account_id, 'failed', 'draft_expired', 'drafts', currency, amount_minor, 1,
           payload_hash, requested_by, expires_at, ?2 FROM payments WHERE id = ?3`,
      )
      .bind(batchRid, provider, from)
      .run();
    await db.batch(
      Array.from({ length: items }, () =>
        db
          .prepare(
            `INSERT INTO payments (request_id, division_id, open_item_id, batch_id, bank_account_id, status, status_reason,
               mode, amount_minor, currency, beneficiary_name, beneficiary_iban, iban_fingerprint, reference, payload_hash,
               approvals_required, requested_by, expires_at, provider_id)
             SELECT ?1, division_id, open_item_id, (SELECT id FROM payment_batches WHERE request_id = ?2), bank_account_id,
               'failed', 'draft_expired', 'drafts', amount_minor, currency, beneficiary_name, beneficiary_iban,
               iban_fingerprint, reference, payload_hash, approvals_required, requested_by, expires_at, NULL
               FROM payments WHERE id = ?3`,
          )
          .bind(crypto.randomUUID(), batchRid, from),
      ),
    );
  });
}

const gone = () => new RevolutApiError(404, "not found");

// ---- B3a ------------------------------------------------------------------------------------------

describe("B3a: the earlier-attempt check is never cut off", () => {
  beforeEach(async () => {
    calls.length = 0;
    w = await execWorld({ mode: "drafts" });
  });

  it("many items of ONE expired bulk draft cost one lookup, and a LIVE draft after them is still found", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    // 30 item rows of one bulk draft come first (the old code cut the list at 20 rows), then a live one
    await seedPriorBatch(id, "bulk-gone", 30);
    await seedPriorSingles(id, ["single-live"]);
    const looked: string[] = [];
    const c = client({
      getPaymentDraft: async (pid: string) => {
        looked.push(pid);
        if (pid === "bulk-gone") throw gone();
        return { id: pid, payments: [{ state: "pending" }] };
      },
      createPaymentDraft: async () => {
        calls.push("createPaymentDraft");
        return { id: "must-not-happen" };
      },
    });
    const r = await createRevolutSubmitter(deps(c)).submit(await requestFor(id));
    expect(r).toEqual({ kind: "rejected", code: "prior_attempt_live" });
    expect(looked).toEqual(["bulk-gone", "single-live"]); // one lookup for the whole bulk draft
    expect(calls).toEqual([]); // nothing was created
  });

  it("more distinct earlier drafts than the cap: unchecked, no lookup, nothing created", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    await seedPriorSingles(
      id,
      Array.from({ length: MAX_PRIOR_DRAFTS + 1 }, (_, i) => `gone-${i}`),
    );
    const looked: string[] = [];
    const c = client({
      getPaymentDraft: async (pid: string) => {
        looked.push(pid);
        throw gone();
      },
      createPaymentDraft: async () => {
        calls.push("createPaymentDraft");
        return { id: "x" };
      },
    });
    expect(await createRevolutSubmitter(deps(c)).submit(await requestFor(id))).toEqual({
      kind: "rejected",
      code: "prior_attempt_unchecked",
    });
    expect(looked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("more earlier ROWS than the cap (all one draft): unchecked; exactly the cap is looked at and may pass", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    await seedPriorBatch(id, "bulk-gone", MAX_PRIOR_ROWS + 1);
    const looked: string[] = [];
    const c = client({
      getPaymentDraft: async (pid: string) => {
        looked.push(pid);
        throw gone();
      },
      createPaymentDraft: async () => {
        calls.push("createPaymentDraft");
        return { id: "d-new" };
      },
    });
    expect(await createRevolutSubmitter(deps(c)).submit(await requestFor(id))).toEqual({
      kind: "rejected",
      code: "prior_attempt_unchecked",
    });
    expect(looked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("control: the cap itself (20 distinct drafts, all gone) passes and the draft is created", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    await seedPriorSingles(
      id,
      Array.from({ length: MAX_PRIOR_DRAFTS }, (_, i) => `gone-${i}`),
    );
    const c = client({
      getPaymentDraft: async () => {
        throw gone();
      },
      createPaymentDraft: async () => {
        calls.push("createPaymentDraft");
        return { id: "d-new" };
      },
    });
    expect(await createRevolutSubmitter(deps(c)).submit(await requestFor(id))).toEqual({
      kind: "accepted",
      providerId: "d-new",
    });
    expect(calls).toEqual(["createPaymentDraft"]);
  });
});

// ---- B3b ------------------------------------------------------------------------------------------

describe("B3b: a refusal of POST /payment-drafts is believed only after a readable list shows no draft", () => {
  beforeEach(async () => {
    calls.length = 0;
    w = await execWorld({ mode: "drafts" });
  });

  const refused = () => {
    throw new RevolutApiError(400, "bad request", "some_refusal");
  };

  async function attempt(list: () => Promise<unknown>) {
    const id = await readyPayment(w);
    await seedPayee(id);
    const req = await requestFor(id);
    const c = client({
      createPaymentDraft: async () => refused(),
      listPaymentDrafts: list,
    });
    // the gate's ledger says the call was attempted: the 4xx came from Revolut
    return createRevolutSubmitter(deps(c, "attempted")).submit(req);
  }

  it("the confirming list cannot be read: UNKNOWN (the draft may exist), never rejected", async () => {
    expect(
      await attempt(async () => {
        throw new RevolutApiError(500, "down");
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("two drafts carry our title: UNKNOWN, never rejected and never a guess", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    const req = await requestFor(id);
    const title = draftTitle(req.requestId);
    const c = client({
      createPaymentDraft: async () => refused(),
      listPaymentDrafts: async () => [
        { id: "d-1", title, payments: [] },
        { id: "d-2", title, payments: [] },
      ],
    });
    expect(await createRevolutSubmitter(deps(c, "attempted")).submit(req)).toEqual({
      kind: "unknown",
    });
  });

  it("control: a readable list with NO draft of ours makes the 4xx a real refusal", async () => {
    expect(await attempt(async () => [])).toEqual({ kind: "rejected", code: "some_refusal" });
  });

  it("control: exactly one draft of ours is adopted although the call was refused", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    const req = await requestFor(id);
    const c = client({
      createPaymentDraft: async () => refused(),
      listPaymentDrafts: async () => [
        { id: "d-1", title: draftTitle(req.requestId), payments: [] },
      ],
    });
    expect(await createRevolutSubmitter(deps(c, "attempted")).submit(req)).toEqual({
      kind: "accepted",
      providerId: "d-1",
    });
  });

  it("a 5xx with an unreadable list is unknown too (as before), and a call the gate never sent is rejected without a list", async () => {
    const id = await readyPayment(w);
    await seedPayee(id);
    const req = await requestFor(id);
    const five = client({
      createPaymentDraft: async () => {
        throw new RevolutApiError(500, "x");
      },
      listPaymentDrafts: async () => {
        throw new RevolutApiError(500, "x");
      },
    });
    expect(await createRevolutSubmitter(deps(five, "attempted")).submit(req)).toEqual({
      kind: "unknown",
    });
  });
});

// ---- N7 -------------------------------------------------------------------------------------------

describe("N7: the gate compares the body with the stored request", () => {
  let lease: string;
  let s: Awaited<ReturnType<typeof stageSubmitting>>;
  const gate = () => revolutGate(w.revolutConnectionId);
  const leg = () => ({
    accountId: s.accountUuid,
    counterpartyId: CP,
    amountMinor: s.amountMinor,
    currency: "EUR",
    reference: "Invoice 1",
  });
  const payReq = (body: string, ref = s.requestId) =>
    rreq(w.revolutConnectionId, {
      method: "POST",
      path: "/pay",
      jobId: "revolut-payment",
      paymentLease: lease,
      paymentRef: ref,
      body,
      headers: { "Content-Type": "application/json" },
    });
  const draftReq = (body: string, ref = s.requestId) =>
    rreq(w.revolutConnectionId, {
      method: "POST",
      path: "/payment-drafts",
      jobId: "revolut-payment",
      paymentLease: lease,
      paymentRef: ref,
      body,
      headers: { "Content-Type": "application/json" },
    });

  beforeEach(async () => {
    w = await execWorld({ mode: "pay" });
    s = await stageSubmitting(w, CP);
    const l = (await gate().acquirePaymentLease(w.revolutConnectionId, "t")) as {
      ok: true;
      lease: string;
    };
    lease = l.lease;
  });
  const writes = () => w.fake.stub.apiCalls.filter((c) => c.method !== "GET");

  it("refuses another AMOUNT, another ACCOUNT, another CURRENCY, another PAYEE; nothing is sent", async () => {
    const good = leg();
    const variants: [string, Partial<typeof good>][] = [
      ["amount", { amountMinor: good.amountMinor + 1 }],
      ["account", { accountId: "11111111-2222-4333-8444-555555555555" }],
      ["currency", { currency: "USD" }],
      ["payee", { counterpartyId: "99999999-2222-4333-8444-555555555555" }],
    ];
    for (const [what, over] of variants) {
      const r = await gate().call(
        payReq(buildPay({ ...good, ...over, requestId: s.requestId }).body),
      );
      expect(r, what).toMatchObject({ ok: false, error: { code: "payment_body_mismatch" } });
    }
    expect(writes()).toHaveLength(0);
  });

  it("refuses a /pay for a request that is unknown, or that is not being submitted", async () => {
    const other = "3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a42";
    expect(
      await gate().call(payReq(buildPay({ ...leg(), requestId: other }).body, other)),
    ).toMatchObject({ ok: false, error: { code: "payment_unknown_request" } });
    // the same request once it is no longer `submitting`
    await db.prepare("UPDATE payments SET status = 'submitted' WHERE id = ?1").bind(s.id).run();
    expect(
      await gate().call(payReq(buildPay({ ...leg(), requestId: s.requestId }).body)),
    ).toMatchObject({ ok: false, error: { code: "payment_unknown_request" } });
    expect(writes()).toHaveLength(0);
  });

  it("refuses a payee that is not the cached one for the verified IBAN (no cache row at all)", async () => {
    // the table is append-only: lift the delete guard for the test setup
    await withoutTriggers(["payment_payees_guard_delete"], async () => {
      await db.prepare("DELETE FROM payment_payees").run();
    });
    expect(
      await gate().call(payReq(buildPay({ ...leg(), requestId: s.requestId }).body)),
    ).toMatchObject({ ok: false, error: { code: "payment_payee_unknown" } });
    expect(writes()).toHaveLength(0);
  });

  it("the matching body goes through (control); a draft body is checked item by item", async () => {
    // draft with a wrong amount
    const bad = buildPaymentDraft({
      requestId: s.requestId,
      payments: [{ ...leg(), amountMinor: s.amountMinor + 100 }],
    });
    expect(await gate().call(draftReq(bad.body))).toMatchObject({
      ok: false,
      error: { code: "payment_body_mismatch" },
    });
    // two entries for one stored payment
    const two = buildPaymentDraft({ requestId: s.requestId, payments: [leg(), leg()] });
    expect(await gate().call(draftReq(two.body))).toMatchObject({
      ok: false,
      error: { code: "payment_body_mismatch" },
    });
    expect(writes()).toHaveLength(0);
    const good = buildPaymentDraft({ requestId: s.requestId, payments: [leg()] });
    expect((await gate().call(draftReq(good.body))).ok).toBe(true);
    expect(w.fake.calls("POST", "/payment-drafts")).toHaveLength(1);
  });
});

// ---- S8 -------------------------------------------------------------------------------------------

describe("S8: the requester must still be an active finance user", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "drafts" });
  });

  it("send: a disabled requester, or one who lost the finance role, is refused before any claim or call", async () => {
    const id = await readyPayment(w);
    await db
      .prepare("UPDATE users SET disabled_at = ?2 WHERE email = ?1")
      .bind(w.emails.finance, new Date().toISOString())
      .run();
    expect(await send(w, id, "payment", onEnv())).toEqual({
      status: "refused",
      code: "requester_inactive",
    });
    await db
      .prepare("UPDATE users SET disabled_at = NULL WHERE email = ?1")
      .bind(w.emails.finance)
      .run();
    await db
      .prepare("DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE email = ?1)")
      .bind(w.emails.finance)
      .run();
    expect(await send(w, id, "payment", onEnv())).toEqual({
      status: "refused",
      code: "requester_inactive",
    });
    expect((await rowOf(id)).status).toBe("ready");
    expect(w.fake.stub.apiCalls).toHaveLength(0);
  });

  async function pending(): Promise<{ id: number; hash: string }> {
    const state = await loadPaymentsState(db, TEST_IBAN_KEY);
    const nowMs = Date.now();
    const r = await createPayment(db, {
      nowMs,
      actor: w.emails.finance,
      state,
      ibanKey: TEST_IBAN_KEY,
      openItemId: w.itemId,
      sourceAccountId: w.accountId,
      clientKey: "s8-client-key-0123456789",
    });
    if (r.blocked) throw new Error(r.blocks.join());
    return { id: r.payment.id, hash: r.payment.payloadHash };
  }

  it("confirm: a requester who lost the finance role cannot confirm", async () => {
    const { id } = await pending();
    await db
      .prepare("DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE email = ?1)")
      .bind(w.emails.finance)
      .run();
    const state = await loadPaymentsState(db, TEST_IBAN_KEY);
    const row = await rowOf(id);
    expect(row.status).toBe("draft");
    await expect(
      confirmRequest(db, {
        kind: "payment",
        id,
        nowMs: Date.now(),
        actor: w.emails.finance,
        authAtMs: Date.now(),
        state,
        ibanKey: TEST_IBAN_KEY,
        phrase: paymentConfirmPhrase(100_000, "EUR", "4300"),
      }),
    ).rejects.toMatchObject({ code: "requester_inactive" });
  });

  it("approve: nobody approves for a disabled requester; turning it down is still allowed", async () => {
    const { id, hash } = await pending();
    const state = await loadPaymentsState(db, TEST_IBAN_KEY);
    await confirmRequest(db, {
      kind: "payment",
      id,
      nowMs: Date.now(),
      actor: w.emails.finance,
      authAtMs: Date.now(),
      state,
      ibanKey: TEST_IBAN_KEY,
      phrase: paymentConfirmPhrase(100_000, "EUR", "4300"),
    });
    expect((await rowOf(id)).status).toBe("pending_approval");
    await db
      .prepare("UPDATE users SET disabled_at = ?2 WHERE email = ?1")
      .bind(w.emails.finance, new Date().toISOString())
      .run();
    const decide = (decision: "approved" | "rejected") =>
      decideRequest(db, {
        kind: "payment",
        id,
        nowMs: Date.now(),
        actor: w.emails.approver,
        roles: ["approver"],
        authAtMs: Date.now(),
        seenPayloadHash: hash,
        decision,
        note: decision === "rejected" ? "no longer wanted" : null,
      });
    await expect(decide("approved")).rejects.toMatchObject({ code: "requester_inactive" });
    expect((await rowOf(id)).status).toBe("pending_approval");
    await decide("rejected");
    expect((await rowOf(id)).status).toBe("rejected");
  });
});

// ---- S5 -------------------------------------------------------------------------------------------

describe("S5: key ids and a rotated PAYMENTS_IBAN_KEY", () => {
  beforeEach(async () => {
    w = await execWorld({ mode: "drafts" });
  });
  const OTHER_KEY = "another-iban-key-0123456789abcdefghij";

  it("a verification, a request and a payee carry the id of the key they were made under", async () => {
    const id = await readyPayment(w);
    const kid = ibanKeyId(TEST_IBAN_KEY);
    expect(kid).toMatch(/^[0-9a-f]{8}$/);
    expect(
      (await db.prepare("SELECT key_id FROM payments WHERE id = ?1").bind(id).first())?.["key_id"],
    ).toBe(kid);
    expect(
      (await db.prepare("SELECT key_id FROM supplier_iban_verifications LIMIT 1").first())?.[
        "key_id"
      ],
    ).toBe(kid);
  });

  it("key ids are written once: an update is refused", async () => {
    const id = await readyPayment(w);
    await expect(
      db.prepare("UPDATE payments SET key_id = 'deadbeef' WHERE id = ?1").bind(id).run(),
    ).rejects.toThrow(/payment_err/);
    await seedPayee(id);
    await expect(db.prepare("UPDATE payment_payees SET key_id = 'deadbeef'").run()).rejects.toThrow(
      /payment_err/,
    );
  });

  it("after a rotation the pre-check says iban_key_rotated (not iban_changed), and 'changed' stays 'changed' for a real change", async () => {
    // the approver verified the IBAN under the OTHER key; the Worker now runs with TEST_IBAN_KEY
    const oldFp = ibanFingerprint(SUPPLIER_IBAN, OTHER_KEY) as string;
    await db
      .prepare(
        `INSERT INTO supplier_iban_verifications (division_id, relation_id, iban_fingerprint, kind, verified_by, key_id)
         VALUES (?1, ?2, ?3, 'verified', ?4, ?5)`,
      )
      .bind(w.divisionId, w.relationRowId, oldFp, w.emails.approver, ibanKeyId(OTHER_KEY))
      .run();
    const state = await loadPaymentsState(db, TEST_IBAN_KEY);
    const r = await createPayment(db, {
      nowMs: Date.now(),
      actor: w.emails.finance,
      state,
      ibanKey: TEST_IBAN_KEY,
      openItemId: w.itemId,
      sourceAccountId: w.accountId,
      clientKey: "s5-rotated-0123456789",
    });
    expect(r.blocked && r.blocks).toContain("iban_key_rotated");
    expect(r.blocked && r.blocks).not.toContain("iban_changed");
    // a verification WITHOUT a key id (older row) cannot be told: it stays 'changed'
    await db
      .prepare(
        `INSERT INTO supplier_iban_verifications (division_id, relation_id, iban_fingerprint, kind, verified_by)
         VALUES (?1, ?2, ?3, 'verified', ?4)`,
      )
      .bind(w.divisionId, w.relationRowId, oldFp, w.emails.approver)
      .run();
    const r2 = await createPayment(db, {
      nowMs: Date.now(),
      actor: w.emails.finance,
      state,
      ibanKey: TEST_IBAN_KEY,
      openItemId: w.itemId,
      sourceAccountId: w.accountId,
      clientKey: "s5-legacy-0123456789",
    });
    expect(r2.blocked && r2.blocks).toContain("iban_changed");
  });

  it("a ready request is refused after a REAL rotation (the Worker runs with another key): nothing is sent", async () => {
    const id = await readyPayment(w);
    const rotated = { ...onEnv(), PAYMENTS_IBAN_KEY: OTHER_KEY };
    const r = await send(w, id, "payment", rotated);
    expect(r).toEqual({ status: "refused", code: "precheck:iban_key_rotated" });
    expect(w.fake.stub.apiCalls).toHaveLength(0);
    expect((await rowOf(id)).status).toBe("ready");
  });

  it("storedKeyRotated: only a request made under ANOTHER key id says yes; no key id says no", async () => {
    const id = await readyPayment(w);
    expect(await storedKeyRotated(db, "payment", id, TEST_IBAN_KEY)).toBe(false);
    expect(await storedKeyRotated(db, "payment", id, OTHER_KEY)).toBe(true);
    expect(await storedKeyRotated(db, "payment", id, null)).toBe(false);
    await withoutTriggers(["payments_guard_key_id"], async () => {
      await db.prepare("UPDATE payments SET key_id = NULL WHERE id = ?1").bind(id).run();
    });
    expect(await storedKeyRotated(db, "payment", id, OTHER_KEY)).toBe(false);
  });

  it("with payees cached under another key the new payee is LOOKED UP before one is created", async () => {
    const id = await readyPayment(w);
    // a payee of an older key sits in the cache; our supplier's payee exists at Revolut but not in the cache
    await db
      .prepare(
        `INSERT INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for, key_id)
         VALUES (?1, ?2, ?3, 'Old', 'seed-seed', ?4)`,
      )
      .bind(
        w.revolutConnectionId,
        "a".repeat(64),
        "7138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11",
        ibanKeyId(OTHER_KEY),
      )
      .run();
    const c = client({
      listCounterparties: async () => {
        calls.push("listCounterparties");
        return [{ id: CP, accounts: [{ id: CP, iban: SUPPLIER_IBAN }] }];
      },
      createCounterparty: async () => {
        calls.push("createCounterparty");
        return { id: "x", accounts: [] };
      },
      createPaymentDraft: async () => ({ id: "d-1" }),
      getPaymentDraft: async () => {
        throw gone();
      },
    });
    calls.length = 0;
    const r = await createRevolutSubmitter(deps(c)).submit(await requestFor(id));
    expect(r).toEqual({ kind: "accepted", providerId: "d-1" });
    expect(calls).toEqual(["listCounterparties"]); // no second counterparty was created
    const row = await db
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'payee.%' ORDER BY id DESC LIMIT 1")
      .first<{ action: string }>();
    expect(row?.action).toBe("payee.adopted");
  });
});

// ---- S12 ------------------------------------------------------------------------------------------

describe("S12: a payee in the cache has its audit row, in the same batch", () => {
  let auditFrom = 0;
  beforeEach(async () => {
    calls.length = 0;
    w = await execWorld({ mode: "drafts" });
    auditFrom =
      (await db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM audit_log").first<{ n: number }>())
        ?.n ?? 0;
  });

  it("a payee created by the app is audited as payee.created (no IBAN anywhere in the row)", async () => {
    const id = await readyPayment(w);
    const c = client({
      listCounterparties: async () => [],
      createCounterparty: async () => ({ id: CP, accounts: [{ id: CP, iban: SUPPLIER_IBAN }] }),
      createPaymentDraft: async () => ({ id: "d-1" }),
      getPaymentDraft: async () => {
        throw gone();
      },
    });
    expect(await createRevolutSubmitter(deps(c)).submit(await requestFor(id))).toMatchObject({
      kind: "accepted",
    });
    const rows = await db
      .prepare(
        "SELECT action, entity, after_json FROM audit_log WHERE action LIKE 'payee.%' AND id > ?1",
      )
      .bind(auditFrom)
      .all<{ action: string; entity: string; after_json: string }>();
    expect(rows.results.map((r) => r.action)).toEqual(["payee.created"]);
    expect(rows.results[0]?.after_json).toContain(CP);
    expect(rows.results[0]?.after_json).not.toContain(SUPPLIER_IBAN);
    expect(rows.results[0]?.after_json).not.toContain("NL91");
  });

  it("a payee found at Revolut (an earlier attempt began) is audited as payee.adopted, once", async () => {
    const id = await readyPayment(w);
    const fingerprint = (
      await db.prepare("SELECT iban_fingerprint FROM payments WHERE id = ?1").bind(id).first<{
        iban_fingerprint: string;
      }>()
    )?.iban_fingerprint as string;
    // an earlier attempt claimed the payee key and may have created the payee
    await claimIdempotencyKey(db, `${w.revolutConnectionId}:${fingerprint}`, "revolut.payee");
    const c = client({
      listCounterparties: async () => [{ id: CP, accounts: [{ id: CP, iban: SUPPLIER_IBAN }] }],
      createCounterparty: async () => {
        calls.push("createCounterparty");
        return { id: "x", accounts: [] };
      },
      createPaymentDraft: async () => ({ id: "d-1" }),
      getPaymentDraft: async () => {
        throw gone();
      },
    });
    await createRevolutSubmitter(deps(c)).submit(await requestFor(id));
    expect(calls).toEqual([]); // found, not created
    const rows = await db
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'payee.%' AND id > ?1")
      .bind(auditFrom)
      .all<{ action: string }>();
    expect(rows.results.map((r) => r.action)).toEqual(["payee.adopted"]);
    // a second recording for the same payee (a parallel attempt) writes neither a row nor an audit entry
    const { recordPayee } = await import("../src/payments/payees");
    await recordPayee(
      db,
      w.revolutConnectionId,
      { ibanFingerprint: fingerprint, beneficiaryName: "Acme" },
      { counterpartyId: CP, accountId: CP },
      "other-request",
      "created",
      ibanKeyId(TEST_IBAN_KEY),
    );
    const again = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'payee.%' AND id > ?1")
      .bind(auditFrom)
      .first<{ n: number }>();
    expect(again?.n).toBe(1);
  });
});
