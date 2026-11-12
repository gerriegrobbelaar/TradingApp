/**
 * Review P9a (adversarial): the money-out foundation is attacked from every side the review brief
 * names. Nothing here may reach a bank: the gate refuses payment paths with a live stub, the submit
 * boundary refuses in production configuration even with a fake "available" submitter, and every
 * four-eyes, idempotency, state-machine and pre-check rule is tried at the API and at the database.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENT_SETTINGS,
  ibanFingerprint,
  paymentConfirmPhrase,
  sha256Hex,
} from "@camelthorn/core";
import { RevolutApiError } from "@camelthorn/revolut";
import { unwrap } from "../src/revolut/wire";
import { freshRates } from "../src/payments/facts";
import { ibanKeyOf, loadPaymentsState, paymentsBlockers } from "../src/payments/settings";
import {
  cancelRequest,
  confirmRequest,
  createBatch,
  createPayment,
  decideRequest,
  expireStale,
} from "../src/payments/store";
import {
  getSubmitter,
  markStaleSubmissions,
  runSubmission,
  SUBMIT_LEASE_MS,
  type PaymentSubmitter,
  type SubmitOutcome,
  type SubmitRequest,
} from "../src/payments/submit";
import { addSession, addUser, authed } from "./helpers";
import { markOpenItemsSynced } from "./matching-helpers";
import {
  addBill,
  db,
  payWorld,
  putPaymentSettings,
  setSwitch,
  setVerified,
  SUPPLIER_IBAN,
  TEST_IBAN_KEY,
  withoutPaymentTriggers,
  type PayWorld,
} from "./payments-helpers";
import { resetRevolut, revolutGate, rreq, seedRevolut, stubRevolut } from "./revolut-helpers";

const NOW = Date.parse("2026-07-15T10:00:00Z");
let w: PayWorld;
let seq = 0;
const key = () => `review-key-${++seq}-0123456789`;

const fake = (
  respond: (r: SubmitRequest) => SubmitOutcome | Promise<SubmitOutcome>,
): PaymentSubmitter & { calls: SubmitRequest[] } => {
  const calls: SubmitRequest[] = [];
  return {
    available: true,
    calls,
    submit: (r) => {
      calls.push(r);
      return Promise.resolve().then(() => respond(r));
    },
  };
};

const state = () => loadPaymentsState(db, TEST_IBAN_KEY);
const statusOf = async (id: number, table = "payments"): Promise<string> =>
  (
    await db
      .prepare(`SELECT status FROM ${table} WHERE id = ?1`)
      .bind(id)
      .first<{ status: string }>()
  )?.status ?? "";
const count = async (sql: string, ...binds: unknown[]): Promise<number> =>
  (
    await db
      .prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? -1;

async function draft(o: { itemId?: number; amount?: number; actor?: string } = {}) {
  const r = await createPayment(db, {
    nowMs: NOW,
    actor: o.actor ?? w.emails.finance,
    state: await state(),
    openItemId: o.itemId ?? w.itemId,
    sourceAccountId: w.accountId,
    ...(o.amount !== undefined ? { amountMinor: o.amount } : {}),
    clientKey: key(),
    ibanKey: TEST_IBAN_KEY,
  });
  if (r.blocked) throw new Error(r.blocks.join(","));
  return r.payment;
}

async function confirmed(o: Parameters<typeof draft>[0] = {}) {
  const p = await draft(o);
  await confirmRequest(db, {
    kind: "payment",
    id: p.id,
    nowMs: NOW,
    actor: o.actor ?? w.emails.finance,
    authAtMs: NOW,
    state: await state(),
    phrase: paymentConfirmPhrase(p.amountMinor, p.currency, "4300"),
    ibanKey: TEST_IBAN_KEY,
  });
  return p;
}

const decide = (
  p: { id: number; payloadHash: string },
  actor: string,
  o: { roles?: string[]; decision?: "approved" | "rejected"; nowMs?: number; hash?: string } = {},
) =>
  decideRequest(db, {
    kind: "payment",
    id: p.id,
    nowMs: o.nowMs ?? NOW,
    actor,
    roles: o.roles ?? ["approver"],
    authAtMs: o.nowMs ?? NOW,
    seenPayloadHash: o.hash ?? p.payloadHash,
    decision: o.decision ?? "approved",
    note: o.decision === "rejected" ? "not this one" : null,
  });

async function readyPayment(o: Parameters<typeof draft>[0] = {}) {
  const p = await confirmed(o);
  if ((await statusOf(p.id)) === "pending_approval") await decide(p, w.emails.approver);
  expect(await statusOf(p.id)).toBe("ready");
  return p;
}

const submit = (
  id: number,
  s: PaymentSubmitter,
  nowMs = NOW,
  ibanKey: string | null = TEST_IBAN_KEY,
) => runSubmission(db, s, { kind: "payment", id, nowMs, owner: "review-job", ibanKey });

beforeEach(async () => {
  w = await payWorld({ nowMs: NOW });
});

// ---- 1. nothing can reach a Revolut payment endpoint ------------------------------------------

describe("the real Revolut gate refuses every payment path (live stub, no call leaves)", () => {
  let stub: ReturnType<typeof stubRevolut>;
  beforeEach(async () => {
    await resetRevolut();
    stub = stubRevolut();
  });
  afterEach(() => stub.restore());

  it("POST/PUT/PATCH/DELETE/GET on /pay, drafts, transfer, counterparty, bulk: refused before the network", async () => {
    const id = await seedRevolut();
    const paths = [
      "/pay",
      "/payment-drafts",
      "/payment-drafts/00000000-0000-4000-8000-000000000000",
      "/transfer",
      "/counterparty",
      "/counterparties",
      "/bulk-payments",
      "/transaction/abc/cancel",
      "/accounts/00000000-0000-4000-8000-000000000000/transfer",
      "/pay?x=1",
      "/pay/../accounts",
      "/accounts/../pay",
      "/%70ay",
    ];
    for (const path of paths) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        for (const apiVersion of ["1.0", "2.0"] as const) {
          let err: unknown = null;
          try {
            unwrap(
              await revolutGate(id).call(
                rreq(id, { method: method as never, path, apiVersion, body: "{}" }),
              ),
            );
          } catch (e) {
            err = e;
          }
          expect(err instanceof RevolutApiError, `${method} ${path} v${apiVersion}`).toBe(true);
        }
      }
    }
    // not one request reached Revolut (no token refresh, no API call)
    expect(stub.apiCalls).toEqual([]);
    expect(stub.tokenCalls).toEqual([]);
  });
});

describe("the submit boundary in production configuration", () => {
  it("refuses with a fake AVAILABLE submitter while the switch is off, unverified, keyless or default", async () => {
    const p = await readyPayment();
    const s = fake(() => ({ kind: "accepted", providerId: "never" }));
    // production defaults: no switch row at all
    await db.prepare("DELETE FROM settings WHERE key = 'payments.enabled'").run();
    expect(await submit(p.id, s)).toEqual({ status: "refused", code: "payments_disabled" });
    await setSwitch(true);
    await setVerified(false);
    expect(await submit(p.id, s)).toEqual({ status: "refused", code: "payments_disabled" });
    await setVerified(true);
    // without the fingerprint key nothing goes either
    expect(await submit(p.id, s, NOW, null)).toEqual({
      status: "refused",
      code: "payments_disabled",
    });
    // the switch row holding a truthy but non-strict value
    for (const v of ["1", '"true"', "True", "{}"]) {
      await db
        .prepare("UPDATE settings SET value_json = ?1 WHERE key = 'payments.enabled'")
        .bind(v)
        .run();
      expect(await submit(p.id, s), v).toEqual({ status: "refused", code: "payments_disabled" });
    }
    expect(s.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM payment_claims")).toBe(0);
    expect(await statusOf(p.id)).toBe("ready");
    // and the default submitter is the disabled one
    expect(getSubmitter().available).toBe(false);
  });

  it("the switch cannot be turned on by any route while the submitter is the disabled one", async () => {
    // A world in which every OTHER blocker is gone (verified, mapping, connection, approver, key).
    await setSwitch(false);
    const adminId = await addUser("admin2@camelthorncapital.com", ["admin", "finance", "approver"]);
    const t = await addSession(adminId);
    const put = await authed("/api/settings/payments/switch", t, {
      method: "PUT",
      json: { enabled: true, confirm: "ENABLE PAYMENTS" },
    });
    expect(put.status).toBe(409);
    expect(await put.json()).toMatchObject({ blockers: ["submitter_unavailable"] });
    // PATCH settings cannot carry the switch, the verification or any unknown key
    for (const body of [
      { enabled: true },
      { "payments.enabled": true },
      { verified: true },
      { fourEyesEnabled: false, enabled: true, confirm: "LOOSEN PAYMENT CONTROLS" },
    ]) {
      const r = await authed("/api/settings/payments", t, { method: "PATCH", json: body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    // the jobs settings route takes no settings key either
    const jobs = await authed("/api/jobs/payments.enabled", t, {
      method: "PATCH",
      json: { enabled: true },
    });
    expect([400, 404, 405]).toContain(jobs.status);
    expect(
      (
        await db
          .prepare("SELECT value_json FROM settings WHERE key = 'payments.enabled'")
          .first<{ value_json: string }>()
      )?.value_json,
    ).toBe("false");
    expect(paymentsBlockers(await state(), getSubmitter().available)).toEqual([
      "submitter_unavailable",
      "payments_disabled",
    ]);
  });

  it("names the missing fingerprint key as a blocker", async () => {
    const s = await loadPaymentsState(db, ibanKeyOf({}));
    expect(paymentsBlockers(s, true)).toContain("iban_key_missing");
    expect(ibanKeyOf({ PAYMENTS_IBAN_KEY: "short" })).toBeNull();
    expect(ibanKeyOf({ PAYMENTS_IBAN_KEY: TEST_IBAN_KEY })).toBe(TEST_IBAN_KEY);
    // and a create without it is refused (payments not permitted)
    const r = await createPayment(db, {
      nowMs: NOW,
      actor: w.emails.finance,
      state: s,
      openItemId: w.itemId,
      sourceAccountId: w.accountId,
      clientKey: key(),
      ibanKey: null,
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.blocks).toContain("payments_disabled");
  });
});

// ---- 2. four-eyes ---------------------------------------------------------------------------------

describe("four-eyes, adversarially", () => {
  it("a user holding finance AND approver can never approve their own request (API, store, DB)", async () => {
    const both = "both@camelthorncapital.com";
    const t = await addSession(await addUser(both, ["finance", "approver"]));
    const p = await confirmed({ actor: both });
    expect(await statusOf(p.id)).toBe("pending_approval");
    await expect(decide(p, both, { roles: ["finance", "approver"] })).rejects.toMatchObject({
      code: "self_approval",
    });
    // in another case or with blanks: still the requester
    await expect(decide(p, " BOTH@camelthorncapital.com ")).rejects.toMatchObject({
      code: "self_approval",
    });
    // the database refuses the row whatever the application does
    const direct = await db
      .prepare(
        `INSERT INTO payment_approvals (payment_id, decision, payload_hash, requested_by, decided_by, approver_auth_at)
         VALUES (?1, 'approved', ?2, ?3, ?3, ?4)`,
      )
      .bind(p.id, p.payloadHash, both, new Date(NOW).toISOString())
      .run()
      .then(
        () => "inserted",
        (e: Error) => `${e.message} ${String(e.cause)}`,
      );
    expect(direct).toMatch(/CHECK constraint failed|payment_err/);
    // a forged requested_by on the approval row does not help either
    const forged = await db
      .prepare(
        `INSERT INTO payment_approvals (payment_id, decision, payload_hash, requested_by, decided_by, approver_auth_at)
         VALUES (?1, 'approved', ?2, 'someone@else.nl', ?3, ?4)`,
      )
      .bind(p.id, p.payloadHash, both, new Date(NOW).toISOString())
      .run()
      .then(
        () => "inserted",
        (e: Error) => `${e.message} ${String(e.cause)}`,
      );
    expect(forged).toContain("payment_err:approval_subject");
    expect(await statusOf(p.id)).toBe("pending_approval");
    expect(t).toBeTruthy();
  });

  it("through the API (real clock, fresh sign-in): the requester's approver session gets self_approval", async () => {
    w = await payWorld();
    const both = "both2@camelthorncapital.com";
    const t = await addSession(await addUser(both, ["finance", "approver"]));
    const now = Date.now();
    const r = await createPayment(db, {
      nowMs: now,
      actor: both,
      state: await state(),
      openItemId: w.itemId,
      sourceAccountId: w.accountId,
      clientKey: key(),
      ibanKey: TEST_IBAN_KEY,
    });
    if (r.blocked) throw new Error(r.blocks.join(","));
    const c = await authed(`/api/payments/${r.payment.id}/confirm`, t, {
      method: "POST",
      json: { confirm: paymentConfirmPhrase(100_000, "EUR", "4300") },
    });
    expect(c.status).toBe(200);
    const api = await authed(`/api/payments/${r.payment.id}/approve`, t, {
      method: "POST",
      json: { payloadHash: r.payment.payloadHash },
    });
    expect(api.status).toBe(403);
    expect(await api.json()).toMatchObject({ error: "self_approval" });
    // a stale sign-in of a real approver is refused too (step-up at the route)
    const stale = await addSession(await addUser("late@camelthorncapital.com", ["approver"]), {
      lastAuthAgoMs: 16 * 60_000,
    });
    const s2 = await authed(`/api/payments/${r.payment.id}/approve`, stale, {
      method: "POST",
      json: { payloadHash: r.payment.payloadHash },
    });
    expect(s2.status).toBe(401);
    expect(await statusOf(r.payment.id)).toBe("pending_approval");
  });

  it("finance or admin without the approver role cannot approve; a disabled approver cannot either", async () => {
    const p = await confirmed();
    await expect(decide(p, w.emails.finance2, { roles: ["finance"] })).rejects.toMatchObject({
      code: "approver_lacks_role",
    });
    await expect(decide(p, w.emails.admin, { roles: ["admin"] })).rejects.toMatchObject({
      code: "approver_lacks_role",
    });
    // a session that still claims the role, but the database says the user is disabled now
    await db
      .prepare("UPDATE users SET disabled_at = '2026-07-15T09:00:00Z' WHERE email = ?1")
      .bind(w.emails.approver)
      .run();
    await expect(decide(p, w.emails.approver)).rejects.toMatchObject({
      code: "approver_lacks_role",
    });
    // role removed but the session not reloaded: the insert trigger checks the role now
    await db
      .prepare(
        "DELETE FROM user_roles WHERE role = 'approver' AND user_id = (SELECT id FROM users WHERE email = ?1)",
      )
      .bind(w.emails.approver2)
      .run();
    await expect(decide(p, w.emails.approver2)).rejects.toMatchObject({
      code: "approver_lacks_role",
    });
    expect(await statusOf(p.id)).toBe("pending_approval");
  });

  it("a replayed approve, two approvals racing, approve after cancel and after expiry: one decision only", async () => {
    const p = await confirmed();
    const both = await Promise.allSettled([
      decide(p, w.emails.approver),
      decide(p, w.emails.approver2),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = both.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect(
      await count("SELECT COUNT(*) AS n FROM payment_approvals WHERE payment_id = ?1", p.id),
    ).toBe(1);
    // replay of the winning request
    await expect(decide(p, w.emails.approver)).rejects.toMatchObject({ code: "not_pending" });

    // cancel vs approve
    const q = await confirmed({ itemId: (await addBill(w)).itemId });
    const race = await Promise.allSettled([
      cancelRequest(db, {
        kind: "payment",
        id: q.id,
        nowMs: NOW,
        actor: w.emails.finance,
        isAdmin: false,
        reason: null,
      }),
      decide(q, w.emails.approver),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const final = await statusOf(q.id);
    expect(["cancelled", "ready"]).toContain(final);
    if (final === "cancelled") {
      await expect(decide(q, w.emails.approver2)).rejects.toMatchObject({ code: "not_pending" });
    }

    // expired request: no approval
    const r = await confirmed({ itemId: (await addBill(w)).itemId });
    const later = NOW + 24 * 3600_000;
    await expect(decide(r, w.emails.approver, { nowMs: later })).rejects.toMatchObject({
      status: 409,
    });
    expect(await statusOf(r.id)).toBe("expired");
    expect(
      await count("SELECT COUNT(*) AS n FROM payment_approvals WHERE payment_id = ?1", r.id),
    ).toBe(0);
  });

  it("the approval is bound to the payload: a different hash is payload_changed", async () => {
    const p = await confirmed();
    await expect(decide(p, w.emails.approver, { hash: "0".repeat(64) })).rejects.toMatchObject({
      code: "payload_changed",
    });
    // every bound column is immutable in the database, in every state
    for (const [col, v] of [
      ["amount_minor", 1],
      ["currency", "USD"],
      ["reference", "Invoice X"],
      ["bank_account_id", 999],
      ["iban_fingerprint", "a".repeat(64)],
      ["beneficiary_iban", "DE89370400440532013000"],
      ["batch_id", null],
      ["confirmed_at", "2026-07-15T09:59:00.000Z"],
      ["requester_auth_at", "2026-07-15T09:59:00.000Z"],
    ] as const) {
      const out = await db
        .prepare(`UPDATE payments SET ${col} = ?2 WHERE id = ?1`)
        .bind(p.id, v)
        .run()
        .then(
          () => "updated",
          (e: Error) => `${e.message} ${String(e.cause)}`,
        );
      if (col === "batch_id") continue; // already NULL: not a change
      expect(out, col).toContain("payment_err:payload_immutable");
    }
  });

  it("an approver's 'no' needs a recorded decision: a bare UPDATE to rejected is refused", async () => {
    const p = await confirmed();
    const out = await db
      .prepare("UPDATE payments SET status = 'rejected' WHERE id = ?1")
      .bind(p.id)
      .run()
      .then(
        () => "updated",
        (e: Error) => `${e.message} ${String(e.cause)}`,
      );
    expect(out).toContain("payment_err:not_decided");
    await decide(p, w.emails.approver, { decision: "rejected" });
    expect(await statusOf(p.id)).toBe("rejected");
  });

  it("the database refuses 'ready' without a second person when the stored settings need one", async () => {
    // A request created while four-eyes was off goes to ready on its own...
    await putPaymentSettings({ fourEyesEnabled: false, requireApprovalForNewIban: false });
    const p = await draft({ itemId: (await addBill(w, { openMinor: 300_000 })).itemId });
    expect(p.approvalsRequired).toEqual([]);
    // ...but if the controls were switched back on before the confirmation, the DB backstop
    // refuses the bare move even with the application's checks lifted.
    await putPaymentSettings({ requireApprovalForNewIban: false });
    const out = await db
      .prepare(
        "UPDATE payments SET status = 'ready', confirmed_at = ?2, requester_auth_at = ?2 WHERE id = ?1",
      )
      .bind(p.id, new Date(NOW).toISOString())
      .run()
      .then(
        () => "updated",
        (e: Error) => `${e.message} ${String(e.cause)}`,
      );
    expect(out).toContain("payment_err:approval_required");
    // and the application says controls_changed (it never relaxes, never silently tightens)
    await expect(
      confirmRequest(db, {
        kind: "payment",
        id: p.id,
        nowMs: NOW,
        actor: w.emails.finance,
        authAtMs: NOW,
        state: await state(),
        phrase: paymentConfirmPhrase(300_000, "EUR", "4300"),
        ibanKey: TEST_IBAN_KEY,
      }),
    ).rejects.toMatchObject({ code: "controls_changed" });
  });

  it("an IBAN never paid before needs a second person at the database too", async () => {
    await putPaymentSettings({ fourEyesEnabled: false, requireApprovalForNewIban: false });
    const p = await draft();
    await putPaymentSettings({ fourEyesEnabled: false });
    const out = await db
      .prepare(
        "UPDATE payments SET status = 'ready', confirmed_at = ?2, requester_auth_at = ?2 WHERE id = ?1",
      )
      .bind(p.id, new Date(NOW).toISOString())
      .run()
      .then(
        () => "updated",
        (e: Error) => `${e.message} ${String(e.cause)}`,
      );
    expect(out).toContain("payment_err:approval_required");
  });

  it("splitting a large invoice into part payments does not dodge the second approver", async () => {
    await putPaymentSettings({ allowPartial: true, requireApprovalForNewIban: false });
    const big = await addBill(w, { openMinor: 1_000_000 });
    const part = await draft({ itemId: big.itemId, amount: 200_000 });
    expect(part.amountMinor).toBe(200_000);
    expect(part.approvalsRequired).toEqual(["above_limit"]);
    // a part payment of a small invoice stays below the limit
    const small = await addBill(w, { openMinor: 200_000 });
    expect((await draft({ itemId: small.itemId, amount: 100_000 })).approvalsRequired).toEqual([]);
  });
});

// ---- 3. request_id and idempotency ----------------------------------------------------------------

describe("request_id and client keys", () => {
  it("an outcome_unknown request keeps its request_id; no path makes a new one for the same invoice", async () => {
    const p = await readyPayment();
    const s = fake(() => ({ kind: "unknown" }));
    expect(await submit(p.id, s)).toMatchObject({ to: "outcome_unknown" });
    const rid = (
      await db
        .prepare("SELECT request_id FROM payments WHERE id = ?1")
        .bind(p.id)
        .first<{ request_id: string }>()
    )?.request_id;
    expect(rid).toBe(p.requestId);
    // no second request for the invoice while the first may have been paid
    const again = await createPayment(db, {
      nowMs: NOW,
      actor: w.emails.finance,
      state: await state(),
      openItemId: w.itemId,
      sourceAccountId: w.accountId,
      clientKey: key(),
      ibanKey: TEST_IBAN_KEY,
    });
    expect(again.blocked).toBe(true);
    if (again.blocked) expect(again.blocks).toContain("already_in_request");
    // and the same request is never submitted again
    expect(
      await submit(
        p.id,
        fake(() => ({ kind: "accepted", providerId: "x" })),
      ),
    ).toEqual({
      status: "refused",
      code: "not_ready",
    });
    const moved = await db
      .prepare("UPDATE payments SET status = 'ready' WHERE id = ?1")
      .bind(p.id)
      .run()
      .then(
        () => "updated",
        (e: Error) => `${e.message} ${String(e.cause)}`,
      );
    expect(moved).toContain("payment_err:bad_transition");
  });

  it("the same client key for another account or amount is client_key_reused; a concurrent replay gets the same request", async () => {
    await putPaymentSettings({ allowPartial: true });
    const k = key();
    const base = {
      nowMs: NOW,
      actor: w.emails.finance,
      openItemId: w.itemId,
      sourceAccountId: w.accountId,
      clientKey: k,
      ibanKey: TEST_IBAN_KEY,
    };
    const [a, b] = await Promise.all([
      createPayment(db, { ...base, state: await state() }),
      createPayment(db, { ...base, state: await state() }),
    ]);
    if (a.blocked || b.blocked) throw new Error("blocked");
    expect(a.payment.id).toBe(b.payment.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    await expect(
      createPayment(db, { ...base, state: await state(), amountMinor: 50_000 }),
    ).rejects.toMatchObject({ code: "client_key_reused" });
    await expect(
      createPayment(db, { ...base, state: await state(), sourceAccountId: w.accountId + 1000 }),
    ).rejects.toMatchObject({ code: "client_key_reused" });
    // another user may use the same key: a separate request space (here: the invoice is taken)
    const other = await createPayment(db, {
      ...base,
      actor: w.emails.finance2,
      state: await state(),
    });
    expect(other.blocked).toBe(true);
  });
});

// ---- 4. state machine: claims and leases ----------------------------------------------------------

describe("claims and leases", () => {
  it("a claim's lease cannot be extended or the claim unreleased", async () => {
    const p = await readyPayment();
    const s = fake(() => ({ kind: "unknown" }));
    await submit(p.id, s);
    for (const sql of [
      "UPDATE payment_claims SET lease_until = '2099-01-01T00:00:00.000Z'",
      "UPDATE payment_claims SET owner = 'other'",
      "DELETE FROM payment_claims",
    ]) {
      const out = await db
        .prepare(sql)
        .run()
        .then(
          () => "ok",
          (e: Error) => `${e.message} ${String(e.cause)}`,
        );
      expect(out, sql).toContain("payment_err:append_only");
    }
  });

  it("a lease that runs out mid-call: outcome_unknown, never re-submitted; a late clear answer is still recorded", async () => {
    const p = await readyPayment();
    let staleMarked = 0;
    const slow = fake(async () => {
      // the worker took longer than the lease: another pass marked it while we waited
      staleMarked = await markStaleSubmissions(db, NOW + SUBMIT_LEASE_MS + 1);
      return { kind: "accepted", providerId: "rev-late" };
    });
    const r = await submit(p.id, slow);
    expect(staleMarked).toBe(1);
    expect(slow.calls).toHaveLength(1);
    expect(r).toEqual({ status: "done", to: "submitted", code: "accepted:late" });
    const row = await db
      .prepare("SELECT status, provider_id, submit_attempts FROM payments WHERE id = ?1")
      .bind(p.id)
      .first<{ status: string; provider_id: string; submit_attempts: number }>();
    expect(row).toEqual({ status: "submitted", provider_id: "rev-late", submit_attempts: 1 });

    const q = await readyPayment({ itemId: (await addBill(w)).itemId });
    const lost = fake(async () => {
      await markStaleSubmissions(db, NOW + SUBMIT_LEASE_MS + 1);
      return { kind: "unknown" };
    });
    expect(await submit(q.id, lost)).toEqual({
      status: "done",
      to: "outcome_unknown",
      code: "lease_lost",
    });
    expect(await statusOf(q.id)).toBe("outcome_unknown");
    // and nothing re-sends it
    expect(await submit(q.id, lost)).toEqual({ status: "refused", code: "not_ready" });
    expect(lost.calls).toHaveLength(1);
  });
});

// ---- 5. pre-checks at creation AND again right before the call ----------------------------------

describe("pre-checks", () => {
  it("blocks an open item whose division was not read completely within 26 hours", async () => {
    await markOpenItemsSynced(w.divisionId, new Date(NOW - 27 * 3600_000).toISOString());
    const r = await createPayment(db, {
      nowMs: NOW,
      actor: w.emails.finance,
      state: await state(),
      openItemId: w.itemId,
      sourceAccountId: w.accountId,
      clientKey: key(),
      ibanKey: TEST_IBAN_KEY,
    });
    expect(r.blocked && r.blocks).toEqual(["open_item_stale"]);
  });

  it("an invoice paid once through us is never paid again, whatever Exact's open balance says", async () => {
    const p = await readyPayment();
    await withoutPaymentTriggers(["payments_guard_status", "payments_guard_final"], async () => {
      await db.prepare("UPDATE payments SET status = 'paid' WHERE id = ?1").bind(p.id).run();
    });
    // Exact re-read the invoice after the payment and still shows it open (booking not done)
    await db
      .prepare("UPDATE open_items SET synced_at = ?2 WHERE id = ?1")
      .bind(w.itemId, new Date(NOW).toISOString())
      .run();
    const r = await createPayment(db, {
      nowMs: NOW + 1000,
      actor: w.emails.finance,
      state: await state(),
      openItemId: w.itemId,
      sourceAccountId: w.accountId,
      clientKey: key(),
      ibanKey: TEST_IBAN_KEY,
    });
    expect(r.blocked && r.blocks).toEqual(["already_paid"]);
  });

  it("single + batch + concurrent requests for one invoice: exactly one wins", async () => {
    const bill = await addBill(w);
    const s = await state();
    const single = () =>
      createPayment(db, {
        nowMs: NOW,
        actor: w.emails.finance,
        state: s,
        openItemId: bill.itemId,
        sourceAccountId: w.accountId,
        clientKey: key(),
        ibanKey: TEST_IBAN_KEY,
      });
    const batch = () =>
      createBatch(db, {
        nowMs: NOW,
        actor: w.emails.finance2,
        state: s,
        sourceAccountId: w.accountId,
        items: [{ openItemId: bill.itemId }, { openItemId: w.itemId }],
        clientKey: key(),
        ibanKey: TEST_IBAN_KEY,
      });
    const out = await Promise.all([single(), batch(), single(), batch()]);
    expect(out.filter((r) => !r.blocked)).toHaveLength(1);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM payments WHERE open_item_id = ?1
          AND status IN ('draft','pending_approval','ready','submitting','submitted','outcome_unknown')`,
        bill.itemId,
      ),
    ).toBe(1);
  });

  it("right before the call: an invoice closed in Exact, a changed IBAN or a tightened control refuses, no call", async () => {
    const s = fake(() => ({ kind: "accepted", providerId: "never" }));
    // closed in Exact since it was approved
    const a = await readyPayment();
    await db.prepare("UPDATE open_items SET status = 'closed' WHERE id = ?1").bind(w.itemId).run();
    expect(await submit(a.id, s)).toEqual({ status: "refused", code: "precheck:nothing_open" });

    // a tightened ceiling applies to a request that is already ready
    const b = await readyPayment({ itemId: (await addBill(w)).itemId });
    await putPaymentSettings({
      ...DEFAULT_PAYMENT_SETTINGS,
      maxRequestMinor: 50_000,
      fourEyesLimitMinor: 50_000,
    });
    expect(await submit(b.id, s)).toEqual({
      status: "refused",
      code: "precheck:over_request_limit",
    });
    await putPaymentSettings({});

    // four-eyes switched on after a request went ready without a second person
    await putPaymentSettings({ fourEyesEnabled: false, requireApprovalForNewIban: false });
    const c = await readyPayment({ itemId: (await addBill(w, { openMinor: 300_000 })).itemId });
    expect(c.approvalsRequired).toEqual([]);
    await putPaymentSettings({ requireApprovalForNewIban: false });
    expect(await submit(c.id, s)).toEqual({ status: "refused", code: "controls_changed" });

    // the supplier's IBAN changed in Exact after the approval
    await putPaymentSettings({});
    const d = await readyPayment({ itemId: (await addBill(w)).itemId });
    await db
      .prepare("UPDATE relations SET iban = 'DE89370400440532013000' WHERE id = ?1")
      .bind(w.relationRowId)
      .run();
    const why = await submit(d.id, s);
    expect(why.status).toBe("refused");
    expect(s.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM payment_claims")).toBe(0);
  });

  it("a stored IBAN that no longer matches the approved fingerprint is never handed over", async () => {
    const p = await readyPayment();
    await withoutPaymentTriggers(["payments_guard_payload"], async () => {
      await db
        .prepare("UPDATE payments SET beneficiary_iban = 'DE89370400440532013000' WHERE id = ?1")
        .bind(p.id)
        .run();
    });
    const s = fake(() => ({ kind: "accepted", providerId: "never" }));
    expect(await submit(p.id, s)).toEqual({ status: "refused", code: "iban_binding_broken" });
    expect(s.calls).toHaveLength(0);
  });

  it("a batch holds exactly the items it was hashed over (an item slipped in is refused)", async () => {
    const a = await addBill(w);
    const b = await addBill(w);
    const r = await createBatch(db, {
      nowMs: NOW,
      actor: w.emails.finance,
      state: await state(),
      sourceAccountId: w.accountId,
      items: [{ openItemId: a.itemId }, { openItemId: b.itemId }],
      clientKey: key(),
      ibanKey: TEST_IBAN_KEY,
    });
    if (r.blocked) throw new Error(JSON.stringify(r));
    // the database accepts a row joining a DRAFT batch of the same requester...
    const extra = await addBill(w);
    await db
      .prepare(
        `INSERT INTO payments (request_id, division_id, open_item_id, batch_id, bank_account_id, mode, amount_minor,
           currency, beneficiary_name, beneficiary_iban, iban_fingerprint, reference, payload_hash, requested_by,
           expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'drafts', 100000, 'EUR', 'X', ?6, ?7, 'Invoice X', ?8, ?9, ?10)`,
      )
      .bind(
        crypto.randomUUID(),
        w.divisionId,
        extra.itemId,
        r.batch.id,
        w.accountId,
        SUPPLIER_IBAN,
        ibanFingerprint(SUPPLIER_IBAN, TEST_IBAN_KEY),
        "b".repeat(64),
        w.emails.finance,
        new Date(NOW + 3600_000).toISOString(),
      )
      .run();
    // ...but the batch can no longer be confirmed: neither by the app nor by a bare UPDATE
    await expect(
      confirmRequest(db, {
        kind: "batch",
        id: r.batch.id,
        nowMs: NOW,
        actor: w.emails.finance,
        authAtMs: NOW,
        state: await state(),
        phrase: "PAY BATCH 2 INVOICES 2000.00 EUR",
        ibanKey: TEST_IBAN_KEY,
      }),
    ).rejects.toBeTruthy();
    const out = await db
      .prepare(
        "UPDATE payment_batches SET status = 'pending_approval', confirmed_at = ?2, requester_auth_at = ?2 WHERE id = ?1",
      )
      .bind(r.batch.id, new Date(NOW).toISOString())
      .run()
      .then(
        () => "updated",
        (e: Error) => `${e.message} ${String(e.cause)}`,
      );
    expect(out).toContain("payment_err:batch_items");
  });

  it("a stale ECB feed is no rate: a foreign amount is never judged at an old rate", async () => {
    await db.prepare("DELETE FROM fx_rates").run();
    await db
      .prepare(
        "INSERT INTO fx_rates (currency, rate_date, rate) VALUES ('USD', '2026-07-14', '1.1')",
      )
      .run();
    expect(await freshRates(db, NOW)).not.toBeNull(); // yesterday's rate before 16:00: fine
    await db.prepare("DELETE FROM fx_rates").run();
    await db
      .prepare(
        "INSERT INTO fx_rates (currency, rate_date, rate) VALUES ('USD', '2026-07-10', '1.1')",
      )
      .run();
    expect(await freshRates(db, NOW)).toBeNull(); // three working days old: no rate
    await db.prepare("DELETE FROM fx_rates").run();
    expect(await freshRates(db, NOW)).toBeNull();
  });
});

// ---- 6. privacy: the keyed fingerprint ------------------------------------------------------------

describe("the IBAN fingerprint is keyed", () => {
  it("no response, audit row or event carries the IBAN or its unkeyed hash", async () => {
    const p = await readyPayment();
    const unkeyedV1 = sha256Hex(`iban-fp-v1:${SUPPLIER_IBAN}`);
    const unkeyedV2 = sha256Hex(`iban-fp-v2:${SUPPLIER_IBAN}`);
    const keyed = ibanFingerprint(SUPPLIER_IBAN, TEST_IBAN_KEY) as string;
    expect(p.ibanFingerprintShort).toBe(keyed.slice(0, 16));
    const audit = (
      await db
        .prepare("SELECT before_json, after_json FROM audit_log")
        .all<Record<string, string>>()
    ).results
      .map((r) => `${r["before_json"]} ${r["after_json"]}`)
      .join("\n");
    const events = JSON.stringify((await db.prepare("SELECT * FROM payment_events").all()).results);
    for (const text of [JSON.stringify(p), audit, events]) {
      expect(text).not.toContain(SUPPLIER_IBAN);
      expect(text).not.toContain(unkeyedV1.slice(0, 16));
      expect(text).not.toContain(unkeyedV2.slice(0, 16));
    }
  });
});

// ---- 8. reads that expire ---------------------------------------------------------------------

describe("lazy expiry on reads", () => {
  it("a viewer's GET expires due requests as 'system', audited, and the read still answers", async () => {
    const p = await draft();
    // the API runs on the real clock: make the request due now
    await withoutPaymentTriggers(["payments_guard_payload"], async () => {
      await db
        .prepare("UPDATE payments SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1")
        .bind(p.id)
        .run();
    });
    const r = await authed(`/api/payments/${p.id}`, w.tokens.viewer);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { payment: { status: string } }).payment.status).toBe("expired");
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.expired' AND actor_email = 'system' AND entity_id = ?1",
        p.requestId,
      ),
    ).toBe(1);
    // idempotent: a second pass writes nothing
    await expireStale(db, Date.now());
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.expired' AND entity_id = ?1",
        p.requestId,
      ),
    ).toBe(1);
  });
});

// ---- the test key itself ---------------------------------------------------------------------------

it("the test binding provides a usable fingerprint key", () => {
  expect(ibanKeyOf(env)).toBe(TEST_IBAN_KEY);
});
