/**
 * The Revolut submitter on its own (P9b, ADR 0050), with a scripted client and gate control: the
 * refusals that must happen before any call, the idempotency key, and the timeout. Plus migration
 * 0029's table guards.
 */
import type { RevolutClient } from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimIdempotencyKey } from "../src/db/idempotency";
import { createRevolutSubmitter, type SubmitterDeps } from "../src/payments/revolut-submitter";
import type { SubmitRequest } from "../src/payments/submit";
import {
  db,
  execWorld,
  readyBatch,
  readyPayment,
  rowOf,
  TEST_IBAN_KEY,
  anotherBill,
  type ExecWorld,
} from "./payments-exec-helpers";

let w: ExecWorld;
beforeEach(async () => {
  w = await execWorld({ mode: "pay" });
});
afterEach(() => w.fake.restore());

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

const deps = (o: Partial<SubmitterDeps> = {}): SubmitterDeps => ({
  db,
  client: client(),
  gate: { paymentSendState: () => Promise.resolve("never_attempted") },
  connectionId: w.revolutConnectionId,
  lease: "lease-abcdefgh",
  ibanKey: TEST_IBAN_KEY,
  connectionMode: "pay",
  ...o,
});

async function requestFor(
  id: number,
  kind: "payment" | "batch" = "payment",
): Promise<SubmitRequest> {
  const table = kind === "payment" ? "payments" : "payment_batches";
  const head = (await db
    .prepare(
      `SELECT request_id, mode, bank_account_id, currency, payload_hash, ${kind === "payment" ? "amount_minor" : "total_minor AS amount_minor"} FROM ${table} WHERE id = ?1`,
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
        `SELECT request_id, open_item_id, amount_minor, currency, iban_fingerprint, reference FROM payments WHERE ${kind === "payment" ? "id" : "batch_id"} = ?1 ORDER BY id`,
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
    kind,
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

describe("refusals before any call", () => {
  it("is available (the deploy switch decided that elsewhere)", () => {
    expect(createRevolutSubmitter(deps()).available).toBe(true);
  });

  it("a batch in pay mode is not supported: rejected, no call", async () => {
    const batch = await readyBatch(w, [w.itemId, await anotherBill(w)]);
    const req = { ...(await requestFor(batch, "batch")), mode: "pay" as const };
    expect(await createRevolutSubmitter(deps()).submit(req)).toEqual({
      kind: "rejected",
      code: "batch_pay_unsupported",
    });
    expect(calls).toEqual([]);
  });

  it("the pay mode on a connection that is not on the Company plan: rejected, no call", async () => {
    const id = await readyPayment(w);
    const req = await requestFor(id);
    expect(await createRevolutSubmitter(deps({ connectionMode: "drafts" })).submit(req)).toEqual({
      kind: "rejected",
      code: "mode_not_allowed",
    });
    expect(await createRevolutSubmitter(deps({ connectionMode: null })).submit(req)).toEqual({
      kind: "rejected",
      code: "mode_not_allowed",
    });
    expect(calls).toEqual([]);
  });

  it("a payload that disagrees with the stored rows (amount, fingerprint, reference): rejected, no call", async () => {
    const id = await readyPayment(w);
    const req = await requestFor(id);
    const first = req.items[0];
    if (!first) throw new Error("no item");
    for (const bad of [
      { amountMinor: first.amountMinor + 1 },
      { ibanFingerprint: "0".repeat(64) },
      { reference: "Invoice other" },
      { requestId: "11111111-1111-4111-8111-111111111111" },
    ]) {
      expect(
        await createRevolutSubmitter(deps()).submit({ ...req, items: [{ ...first, ...bad }] }),
      ).toEqual({ kind: "rejected", code: "payload_mismatch" });
    }
    expect(await createRevolutSubmitter(deps()).submit({ ...req, items: [] })).toEqual({
      kind: "rejected",
      code: "payload_mismatch",
    });
    expect(calls).toEqual([]);
  });

  it("no IBAN key, or an IBAN that no longer matches its fingerprint: rejected before anything is created", async () => {
    const id = await readyPayment(w);
    const req = await requestFor(id);
    expect(await createRevolutSubmitter(deps({ ibanKey: null })).submit(req)).toEqual({
      kind: "rejected",
      code: "iban_binding_broken",
    });
    expect(
      await createRevolutSubmitter(
        deps({ ibanKey: "another-key-another-key-another-key-0123" }),
      ).submit(req),
    ).toEqual({ kind: "rejected", code: "iban_binding_broken" });
    expect(calls).toEqual([]);
  });

  it("a source account of ANOTHER connection is not paid from", async () => {
    const id = await readyPayment(w);
    const req = await requestFor(id);
    expect(
      await createRevolutSubmitter(deps({ connectionId: w.revolutConnectionId + 1 })).submit(req),
    ).toEqual({ kind: "rejected", code: "payload_mismatch" });
  });
});

describe("idempotency key and timeout", () => {
  it("a payment key that was claimed before means an earlier attempt began: nothing is sent, the answer is unknown", async () => {
    const id = await readyPayment(w);
    const req = await requestFor(id);
    await db
      .prepare(
        `INSERT INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for)
         SELECT ?1, iban_fingerprint, '5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11', 'Acme', 'seed-seed' FROM payments WHERE id = ?2`,
      )
      .bind(w.revolutConnectionId, id)
      .run();
    expect(await claimIdempotencyKey(db, req.requestId, "revolut.pay")).toEqual({
      status: "claimed",
    });
    expect(await createRevolutSubmitter(deps()).submit(req)).toEqual({ kind: "unknown" });
    expect(calls).toEqual([]);
  });

  it("the key is stored BEFORE the call (a call that never answers still leaves it pending)", async () => {
    const id = await readyPayment(w);
    const req = await requestFor(id);
    await db
      .prepare(
        `INSERT INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for)
         SELECT ?1, iban_fingerprint, '5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11', 'Acme', 'seed-seed' FROM payments WHERE id = ?2`,
      )
      .bind(w.revolutConnectionId, id)
      .run();
    let seenKeyBeforeCall = false;
    const c = client({
      pay: async () => {
        const k = await db
          .prepare("SELECT status FROM idempotency_keys WHERE scope = 'revolut.pay' AND key = ?1")
          .bind(req.requestId)
          .first<{ status: string }>();
        seenKeyBeforeCall = k?.status === "pending";
        throw new TypeError("lost");
      },
      getTransactionByRequestId: async () => null,
    });
    const gate = { paymentSendState: () => Promise.resolve("attempted" as const) };
    expect(await createRevolutSubmitter(deps({ client: c, gate })).submit(req)).toEqual({
      kind: "unknown",
    });
    expect(seenKeyBeforeCall).toBe(true);
  });

  it("a call that never answers ends as unknown after the timeout (well under the claim lease)", async () => {
    const id = await readyPayment(w);
    const req = await requestFor(id);
    await db
      .prepare(
        `INSERT INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for)
         SELECT ?1, iban_fingerprint, '5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11', 'Acme', 'seed-seed' FROM payments WHERE id = ?2`,
      )
      .bind(w.revolutConnectionId, id)
      .run();
    const c = client({ pay: () => new Promise(() => undefined) });
    const t0 = Date.now();
    expect(await createRevolutSubmitter(deps({ client: c, timeoutMs: 50 })).submit(req)).toEqual({
      kind: "unknown",
    });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("the request's own id is what the payment carries: never a fresh one", async () => {
    const id = await readyPayment(w);
    const req = await requestFor(id);
    await db
      .prepare(
        `INSERT INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for)
         SELECT ?1, iban_fingerprint, '5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11', 'Acme', 'seed-seed' FROM payments WHERE id = ?2`,
      )
      .bind(w.revolutConnectionId, id)
      .run();
    let seen = "";
    const c = client({
      pay: async (input: { requestId: string }, call: { ledgerKey: string }) => {
        seen = `${input.requestId}|${call.ledgerKey}`;
        return { transactionId: "t-1", state: "pending" };
      },
    });
    expect(await createRevolutSubmitter(deps({ client: c })).submit(req)).toEqual({
      kind: "accepted",
      providerId: "t-1",
    });
    const stored = (await rowOf(id)).request_id;
    expect(seen).toBe(`${stored}|${stored}`);
  });
});

describe("migration 0029 guards", () => {
  const payee = (fp = "a".repeat(64)) =>
    db
      .prepare(
        "INSERT INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for) VALUES (?1, ?2, '5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11', 'Acme', 'seed-seed')",
      )
      .bind(w.revolutConnectionId, fp)
      .run();

  it("a payee is unique per connection and IBAN, immutable, never deleted; it can be revoked once", async () => {
    await payee();
    await expect(payee()).rejects.toThrow(/UNIQUE/);
    for (const sql of [
      "UPDATE payment_payees SET name = 'Other'",
      "UPDATE payment_payees SET revolut_counterparty_id = '11111111-2222-4333-8444-555566667777'",
      "UPDATE payment_payees SET iban_fingerprint = '" + "b".repeat(64) + "'",
      "DELETE FROM payment_payees",
    ]) {
      await expect(db.prepare(sql).run(), sql).rejects.toThrow(/append_only/);
    }
    await db.prepare("UPDATE payment_payees SET revoked_at = '2026-11-12T10:00:00Z'").run();
    await expect(db.prepare("UPDATE payment_payees SET revoked_at = NULL").run()).rejects.toThrow(
      /append_only/,
    );
    await expect(
      db.prepare("UPDATE payment_payees SET revoked_at = '2027-01-01T00:00:00Z'").run(),
    ).rejects.toThrow(/append_only/);
  });

  it("the reconcile row accepts only the known results and positive counters", async () => {
    const ins = (result: string, checks = 1) =>
      db
        .prepare(
          "INSERT OR REPLACE INTO payment_reconcile (subject_kind, subject_id, first_checked_at, last_checked_at, checks, last_result) VALUES ('payment', 1, 'a', 'a', ?2, ?1)",
        )
        .bind(result, checks)
        .run();
    await ins("pending");
    await expect(ins("maybe")).rejects.toThrow();
    await expect(ins("pending", 0)).rejects.toThrow();
  });

  it("outcome_unknown -> rejected needs a lookup that found nothing (payments and batches; behaviour in payments-execution.test.ts)", async () => {
    const text = (
      await db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name IN ('payments_guard_unknown_reject','payment_batches_guard_unknown_reject') ORDER BY name",
        )
        .all<{ sql: string }>()
    ).results.map((r) => r.sql);
    expect(text).toHaveLength(2);
    for (const t of text) expect(t).toMatch(/not_found_checks >= 1/);
  });
});
