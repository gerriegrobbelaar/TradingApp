/**
 * F9a (ADR 0052), the reconciliation side:
 *
 *  B3c  a KNOWN draft that Revolut calls "not found" never fails a payment without positive evidence
 *  N8   a "completed" draft that does not name a transaction per payment never becomes `paid`
 *  B2   the items of a paid batch are linked to their bank lines through the draft's transactions
 *  S1   alerts are columns, are audited once when raised, can be acknowledged; the settlement answer
 *       is honest for a late approval and for a reversal
 *
 * A scripted client stands in for Revolut; D1, the triggers and the gate-free reconciliation are real.
 */
import {
  RevolutApiError,
  type PaymentDraftView,
  type RevolutClient,
  type RevolutTransaction,
} from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAYMENTS_RESOLVE_PHRASE } from "@camelthorn/core";
import {
  ackAlert,
  linkBatchItems,
  paymentSettlement,
  reconcilePayments,
  resolveNotSent,
} from "../src/payments/reconcile";
import { runSubmission, setSubmitterForTests, type SubmitOutcome } from "../src/payments/submit";
import {
  anotherBill,
  db,
  execWorld,
  readyBatch,
  readyPayment,
  rowOf,
  TEST_IBAN_KEY,
  type ExecWorld,
} from "./payments-exec-helpers";
import { SOURCE_ACCOUNT_UUID } from "./payments-fake-revolut";
import { addTx } from "./matching-helpers";

const DAY = 86_400_000;
let w: ExecWorld;
let client: Fake;
let auditFrom = 0;

class Fake {
  txById = new Map<string, RevolutTransaction | Error>();
  txByRid = new Map<string, RevolutTransaction | Error | null>();
  drafts = new Map<string, PaymentDraftView | Error>();
  list: PaymentDraftView[] | Error = [];
  async getTransactionByRequestId(rid: string): Promise<RevolutTransaction | null> {
    const v = this.txByRid.get(rid);
    if (v instanceof Error) throw v;
    return v ?? null;
  }
  async getTransaction(id: string): Promise<RevolutTransaction> {
    const v = this.txById.get(id);
    if (v === undefined) throw new RevolutApiError(404, "not found");
    if (v instanceof Error) throw v;
    return v;
  }
  async getPaymentDraft(id: string): Promise<PaymentDraftView> {
    const v = this.drafts.get(id);
    if (v === undefined) throw new RevolutApiError(404, "not found");
    if (v instanceof Error) throw v;
    return v;
  }
  async listPaymentDrafts(): Promise<PaymentDraftView[]> {
    if (this.list instanceof Error) throw this.list;
    return this.list;
  }
  asClient(): RevolutClient {
    return this as unknown as RevolutClient;
  }
}

const tx = (
  id: string,
  state: RevolutTransaction["state"],
  amountMinor = 100_000,
  account = SOURCE_ACCOUNT_UUID,
): RevolutTransaction => ({
  id,
  type: "transfer",
  state,
  createdAt: "2026-11-12T10:00:00Z",
  legs: [{ legId: `l-${id}`, accountId: account, amountMinor: -amountMinor, currency: "EUR" }],
});

const draft = (
  id: string,
  parts: { state: string; tx?: string }[],
  title?: string,
): PaymentDraftView => ({
  id,
  ...(title ? { title } : {}),
  payments: parts.map((p) => ({
    state: p.state,
    ...(p.tx !== undefined ? { transactionId: p.tx } : {}),
  })),
});

async function toState(
  id: number,
  outcome: SubmitOutcome,
  kind: "payment" | "batch" = "payment",
): Promise<void> {
  setSubmitterForTests({ available: true, submit: () => Promise.resolve(outcome) });
  await runSubmission(
    db,
    { available: true, submit: () => Promise.resolve(outcome) },
    { kind, id, nowMs: Date.now(), owner: "job", ibanKey: TEST_IBAN_KEY },
  );
  setSubmitterForTests(null);
}
const run = (nowMs = Date.now()) =>
  reconcilePayments({ db, nowMs, client: () => Promise.resolve(client.asClient()) });
const rec = (kind: string, id: number) =>
  db
    .prepare("SELECT * FROM payment_reconcile WHERE subject_kind = ?1 AND subject_id = ?2")
    .bind(kind, id)
    .first<Record<string, unknown>>();
const audits = async (like: string): Promise<{ action: string; entity_id: string }[]> =>
  (
    await db
      .prepare(
        "SELECT action, entity_id FROM audit_log WHERE action LIKE ?1 AND id > ?2 ORDER BY id",
      )
      .bind(like, auditFrom)
      .all<{ action: string; entity_id: string }>()
  ).results;

beforeEach(async () => {
  w = await execWorld({ mode: "drafts" });
  client = new Fake();
  auditFrom =
    (await db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM audit_log").first<{ n: number }>())
      ?.n ?? 0;
});
afterEach(() => w.fake.restore());

// ---- B3c ------------------------------------------------------------------------------------------

describe("B3c: 'not found' on a known draft never fails a payment by itself", () => {
  async function submittedWithDraft(): Promise<number> {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    return id;
  }
  /** The balance AND a complete transactions walk, both at `atMs` (review F9a: both are needed). */
  const freshFeed = async (atMs: number, walk = true): Promise<void> => {
    await db
      .prepare("UPDATE bank_accounts SET balance_at = ?2 WHERE id = ?1")
      .bind(w.accountId, new Date(atMs).toISOString())
      .run();
    if (walk) {
      await db
        .prepare(
          `INSERT INTO revolut_sync_state (connection_id, entity, watermark, last_completed_at, last_status)
           VALUES (?1, 'transactions', ?2, ?2, 'ok')
           ON CONFLICT (connection_id, entity) DO UPDATE SET watermark = excluded.watermark`,
        )
        .bind(w.revolutConnectionId, new Date(atMs).toISOString())
        .run();
    }
  };
  const resolve = (kind: "payment" | "batch", id: number, nowMs: number) =>
    resolveNotSent(db, {
      kind,
      id,
      actor: w.emails.admin,
      nowMs,
      confirm: PAYMENTS_RESOLVE_PHRASE,
    });

  it("past the expiry with a STALE bank feed: stays submitted, alert draft_gone, audited, nothing failed", async () => {
    const id = await submittedWithDraft();
    await db
      .prepare("UPDATE bank_accounts SET balance_at = NULL WHERE id = ?1")
      .bind(w.accountId)
      .run();
    const s = await run(Date.now() + 6 * DAY);
    expect(s).toMatchObject({ failed: 0, alerts: 1 });
    expect((await rowOf(id)).status).toBe("submitted");
    expect(await rec("payment", id)).toMatchObject({
      alert_kind: "draft_gone",
      last_result: "not_found",
      alert_ack_at: null,
    });
    expect((await audits("payment.draft_gone")).map((a) => a.entity_id)).toEqual([
      (await rowOf(id)).request_id,
    ]);
    // the same alert on the next run is neither counted twice in the audit log nor reset
    await run(Date.now() + 7 * DAY);
    expect((await audits("payment.draft_gone")).length).toBe(1);
  });

  it("review F9a: even with a fresh, complete feed and no such line the RECONCILIATION never fails it", async () => {
    const id = await submittedWithDraft();
    const t = Date.now() + 6 * DAY;
    await freshFeed(t);
    const s = await run(t);
    expect(s.failed).toBe(0);
    expect((await rowOf(id)).status).toBe("submitted");
    expect(await rec("payment", id)).toMatchObject({ alert_kind: "draft_gone" });
    // ... and runs after it neither
    await freshFeed(t + DAY);
    await run(t + DAY);
    expect((await rowOf(id)).status).toBe("submitted");
  });

  it("before the expiry it is also an alert and a person is told; nothing moves, the admin cannot end it yet", async () => {
    const id = await submittedWithDraft();
    const t = Date.now() + DAY;
    await freshFeed(t);
    await run(t);
    expect((await rowOf(id)).status).toBe("submitted");
    expect(await rec("payment", id)).toMatchObject({ alert_kind: "draft_gone" });
    expect(await resolve("payment", id, t + 60_000)).toEqual({
      ok: false,
      code: "draft_not_expired",
    });
    expect((await rowOf(id)).status).toBe("submitted");
  });

  it("an admin ends it past the expiry with positive evidence: failed/draft_expired, audited under the admin", async () => {
    const id = await submittedWithDraft();
    const t = Date.now() + 6 * DAY;
    await run(t); // first seen gone at t
    await freshFeed(t + 10 * 60_000); // a complete walk that began after it was seen gone
    await run(t + 15 * 60_000);
    expect(await resolve("payment", id, t + 20 * 60_000)).toEqual({ ok: true });
    expect(await rowOf(id)).toMatchObject({ status: "failed", status_reason: "draft_expired" });
    const a = await db
      .prepare(
        "SELECT actor_email FROM audit_log WHERE action = 'payment.draft_gone_resolved' AND id > ?1",
      )
      .bind(auditFrom)
      .all<{ actor_email: string }>();
    expect(a.results.map((r) => r.actor_email)).toEqual([w.emails.admin]);
    // a second press changes nothing
    expect((await resolve("payment", id, t + 21 * 60_000)).ok).toBe(false);
  });

  it("refused without evidence: fresh balance but no complete walk since it was gone (the walk can fail after the balance)", async () => {
    const id = await submittedWithDraft();
    const t = Date.now() + 6 * DAY;
    await freshFeed(t - 60 * 60_000); // a walk BEFORE the draft was seen gone
    await run(t);
    await freshFeed(t + 5 * 60_000, false); // only the balance is read again
    expect(await resolve("payment", id, t + 10 * 60_000)).toEqual({
      ok: false,
      code: "no_bank_evidence",
    });
    expect((await rowOf(id)).status).toBe("submitted");
  });

  it("refused when a line of this account and amount exists (whoever it went to), or the amount plus its fee", async () => {
    const id = await submittedWithDraft();
    const t = Date.now() + 6 * DAY;
    await run(t);
    await freshFeed(t + 5 * 60_000);
    const lineId = await addTx({
      connectionId: w.revolutConnectionId,
      accountId: w.accountId,
      amountMinor: -100_000,
      createdAt: new Date().toISOString(),
    });
    expect((await resolve("payment", id, t + 10 * 60_000)).ok).toBe(false);
    // the leg carries the fee in its amount
    await db
      .prepare("UPDATE bank_transactions SET amount_minor = -100_050, fee_minor = 50 WHERE id = ?1")
      .bind(lineId)
      .run();
    await run(t + 6 * 60_000);
    expect(await resolve("payment", id, t + 10 * 60_000)).toEqual({
      ok: false,
      code: "no_bank_evidence",
    });
    // a pending line is money on its way: also refused
    await db
      .prepare(
        "UPDATE bank_transactions SET amount_minor = -100_000, fee_minor = NULL, state = 'pending' WHERE id = ?1",
      )
      .bind(lineId)
      .run();
    expect((await resolve("payment", id, t + 10 * 60_000)).ok).toBe(false);
    expect((await rowOf(id)).status).toBe("submitted");
  });

  it("a failed-state bank line does not count as a payment (it is evidence of NO money moved)", async () => {
    const id = await submittedWithDraft();
    const t = Date.now() + 6 * DAY;
    await run(t);
    await freshFeed(t + 5 * 60_000);
    await addTx({
      connectionId: w.revolutConnectionId,
      accountId: w.accountId,
      amountMinor: -100_000,
      state: "declined",
      createdAt: new Date().toISOString(),
    });
    await run(t + 6 * 60_000);
    expect(await resolve("payment", id, t + 10 * 60_000)).toEqual({ ok: true });
    expect((await rowOf(id)).status).toBe("failed");
  });

  it("refused when the last lookup is stale or was not 'not found'", async () => {
    const id = await submittedWithDraft();
    const t = Date.now() + 6 * DAY;
    await run(t);
    await freshFeed(t + 5 * 60_000);
    expect(await resolve("payment", id, t + 60 * 60_000)).toEqual({
      ok: false,
      code: "lookup_not_fresh",
    });
    // the draft is back (pending): no longer "gone" in the last lookup
    client.drafts.set("draft-1", draft("draft-1", [{ state: "pending" }]));
    await run(t + 2 * 60 * 60_000 - 60_000);
    expect((await resolve("payment", id, t + 2 * 60 * 60_000)).ok).toBe(false);
  });

  it("a draft that is still pending is not 'gone': the admin cannot end it this way", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", draft("draft-1", [{ state: "pending" }]));
    await run();
    expect(await resolve("payment", id, Date.now() + 6 * DAY)).toEqual({
      ok: false,
      code: "not_unknown",
    });
  });

  it("the earlier-attempt check of a NEW request still looks at a draft ended this way", async () => {
    const id = await submittedWithDraft();
    const t = Date.now() + 6 * DAY;
    await run(t);
    await freshFeed(t + 5 * 60_000);
    await run(t + 6 * 60_000);
    expect(await resolve("payment", id, t + 10 * 60_000)).toEqual({ ok: true });
    const row = await db
      .prepare(
        "SELECT 1 AS n FROM payments WHERE id = ?1 AND status = 'failed' AND status_reason = 'draft_expired' AND provider_id = 'draft-1'",
      )
      .bind(id)
      .first();
    expect(row).not.toBeNull();
  });
});

// ---- N8 -------------------------------------------------------------------------------------------

describe("N8: a completed draft must name a transaction for every payment", () => {
  it("no transaction id: stays submitted, alert draft_completed_unlinked, audited; never paid", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", draft("draft-1", [{ state: "completed" }]));
    const s = await run();
    expect(s).toMatchObject({ paid: 0, alerts: 1 });
    expect((await rowOf(id)).status).toBe("submitted");
    expect(await rec("payment", id)).toMatchObject({
      alert_kind: "draft_completed_unlinked",
      provider_state: "completed",
    });
    expect((await audits("payment.draft_completed_unlinked")).length).toBe(1);
    // a draft that lists no payments at all but says completed is the same
    client.drafts.set("draft-1", { id: "draft-1", state: "completed", payments: [] });
    await run();
    expect((await rowOf(id)).status).toBe("submitted");
  });

  it("a batch whose draft names fewer transactions than items is not paid either", async () => {
    const batch = await readyBatch(w, [w.itemId, await anotherBill(w)]);
    await toState(batch, { kind: "accepted", providerId: "bd-1" }, "batch");
    client.txById.set("t-1", tx("t-1", "completed"));
    client.drafts.set(
      "bd-1",
      draft("bd-1", [{ state: "completed", tx: "t-1" }, { state: "completed" }]),
    );
    await run();
    expect((await rowOf(batch, "payment_batches")).status).toBe("submitted");
    expect(await rec("batch", batch)).toMatchObject({ alert_kind: "draft_completed_unlinked" });
    expect((await audits("payment_batch.draft_completed_unlinked")).length).toBe(1);
  });

  it("transactions in other amounts than ours are a mismatch alert, never paid (single and batch)", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", draft("draft-1", [{ state: "completed", tx: "t-1" }]));
    client.txById.set("t-1", tx("t-1", "completed", 99_999));
    await run();
    expect((await rowOf(id)).status).toBe("submitted");
    expect(await rec("payment", id)).toMatchObject({ alert_kind: "mismatch" });
    expect((await audits("payment.mismatch")).length).toBe(1);
  });

  it("a batch: the amounts of the transactions must be exactly the amounts of the items", async () => {
    const batch = await readyBatch(w, [w.itemId, await anotherBill(w, 40_000)]);
    await toState(batch, { kind: "accepted", providerId: "bd-1" }, "batch");
    client.drafts.set(
      "bd-1",
      draft("bd-1", [
        { state: "completed", tx: "t-1" },
        { state: "completed", tx: "t-2" },
      ]),
    );
    client.txById.set("t-1", tx("t-1", "completed", 100_000));
    client.txById.set("t-2", tx("t-2", "completed", 100_000)); // should be 40,000
    await run();
    expect((await rowOf(batch, "payment_batches")).status).toBe("submitted");
    expect(await rec("batch", batch)).toMatchObject({ alert_kind: "mismatch" });
    client.txById.set("t-2", tx("t-2", "completed", 40_000));
    await run();
    expect((await rowOf(batch, "payment_batches")).status).toBe("paid");
  });

  it("review F9a: a transaction another request already recorded as paid is a mismatch, never paid twice", async () => {
    const first = await readyPayment(w);
    await toState(first, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", draft("draft-1", [{ state: "completed", tx: "t-1" }]));
    client.txById.set("t-1", tx("t-1", "completed"));
    await run();
    expect((await rowOf(first)).status).toBe("paid");
    const second = await readyPayment(w, { itemId: await anotherBill(w) });
    await toState(second, { kind: "accepted", providerId: "draft-2" });
    // Revolut (or a mix-up) names the SAME transaction for the second draft
    client.drafts.set("draft-2", draft("draft-2", [{ state: "completed", tx: "t-1" }]));
    await run();
    expect((await rowOf(second)).status).toBe("submitted");
    expect(await rec("payment", second)).toMatchObject({ alert_kind: "mismatch" });
    // the database has its own fence: one transaction id, one row
    expect(
      await db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'payment_draft_transactions_tx'",
        )
        .first<{ sql: string }>(),
    ).toMatchObject({ sql: expect.stringMatching(/UNIQUE INDEX[\s\S]*\(transaction_id\)/) });
  });

  it("control: one transaction per payment, in our amounts, completed: paid, and the transactions are recorded", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", draft("draft-1", [{ state: "completed", tx: "t-1" }]));
    client.txById.set("t-1", tx("t-1", "completed"));
    expect(await run()).toMatchObject({ paid: 1 });
    expect((await rowOf(id)).status).toBe("paid");
    expect(
      await db
        .prepare(
          "SELECT transaction_id, amount_minor, currency FROM payment_draft_transactions WHERE subject_kind = 'payment' AND subject_id = ?1",
        )
        .bind(id)
        .all(),
    ).toMatchObject({
      results: [{ transaction_id: "t-1", amount_minor: 100_000, currency: "EUR" }],
    });
  });
});

// ---- B2: batch items linked to bank lines ----------------------------------------------------------

describe("B2: the items of a paid batch are linked to their bank lines", () => {
  async function paidBatch(
    amounts: number[],
    refs?: string[],
  ): Promise<{ batch: number; items: number[] }> {
    const ids = [w.itemId, ...(await Promise.all(amounts.slice(1).map((a) => anotherBill(w, a))))];
    if (amounts[0] !== 100_000) {
      throw new Error("the first bill of the world is 100,000");
    }
    const batch = await readyBatch(w, ids);
    await toState(batch, { kind: "accepted", providerId: "bd-1" }, "batch");
    const parts = amounts.map((_, i) => ({ state: "completed", tx: `bt-${i}` }));
    amounts.forEach((a, i) => client.txById.set(`bt-${i}`, tx(`bt-${i}`, "completed", a)));
    client.drafts.set("bd-1", draft("bd-1", parts));
    await run();
    void refs;
    const items = (
      await db
        .prepare("SELECT id FROM payments WHERE batch_id = ?1 ORDER BY id")
        .bind(batch)
        .all<{ id: number }>()
    ).results.map((r) => r.id);
    return { batch, items };
  }
  const line = async (
    txId: string,
    amount: number,
    reference: string | null = null,
  ): Promise<number> => {
    const id = await addTx({
      connectionId: w.revolutConnectionId,
      accountId: w.accountId,
      amountMinor: -amount,
      ...(reference !== null ? { reference } : {}),
    });
    await db
      .prepare("UPDATE bank_transactions SET external_id = ?2 WHERE id = ?1")
      .bind(id, txId)
      .run();
    return id;
  };
  const links = async (): Promise<
    { payment_id: number; bank_transaction_id: number; via: string }[]
  > =>
    (
      await db
        .prepare(
          "SELECT payment_id, bank_transaction_id, via FROM payment_bank_links ORDER BY payment_id",
        )
        .all<{ payment_id: number; bank_transaction_id: number; via: string }>()
    ).results;

  it("two items of different amounts are linked to the lines of their transactions; idempotent; audited", async () => {
    const { batch, items } = await paidBatch([100_000, 40_000]);
    expect((await rowOf(batch, "payment_batches")).status).toBe("paid");
    expect(await links()).toEqual([]); // no bank line yet
    expect(await paymentSettlement(db, items[0] as number)).toBe("awaiting_bank_line");
    const l1 = await line("bt-0", 100_000);
    const l2 = await line("bt-1", 40_000);
    expect(await linkBatchItems(db, new Date().toISOString())).toBe(2);
    expect(await links()).toEqual([
      { payment_id: items[0], bank_transaction_id: l1, via: "transaction_id" },
      { payment_id: items[1], bank_transaction_id: l2, via: "transaction_id" },
    ]);
    expect(await linkBatchItems(db, new Date().toISOString())).toBe(0);
    expect(await paymentSettlement(db, items[0] as number)).toBe("awaiting_match");
    expect((await audits("payment.bank_line_linked")).length).toBe(2);
  });

  it("the same amount twice: linked only when the reference tells them apart; otherwise left alone", async () => {
    const { items } = await paidBatch([100_000, 100_000]);
    const refs = (
      await db
        .prepare("SELECT reference FROM payments WHERE batch_id IS NOT NULL ORDER BY id")
        .all<{
          reference: string;
        }>()
    ).results.map((r) => r.reference);
    await line("bt-0", 100_000, null);
    await line("bt-1", 100_000, null);
    expect(await linkBatchItems(db, new Date().toISOString())).toBe(0); // cannot tell which is which
    expect(await links()).toEqual([]);
    // the lines now carry the items' references
    await db
      .prepare("UPDATE bank_transactions SET reference = ?1 WHERE external_id = 'bt-0'")
      .bind(refs[1])
      .run();
    await db
      .prepare("UPDATE bank_transactions SET reference = ?1 WHERE external_id = 'bt-1'")
      .bind(refs[0])
      .run();
    if (refs[0] === refs[1]) {
      expect(await linkBatchItems(db, new Date().toISOString())).toBe(0);
    } else {
      expect(await linkBatchItems(db, new Date().toISOString())).toBe(2);
      const l = await links();
      // item 0 got the line that carries ITS reference (bt-1), item 1 the other
      expect(l.map((x) => x.payment_id)).toEqual(items);
    }
  });

  it("a line of another amount, account or one that is not the draft's transaction is never linked", async () => {
    const { items } = await paidBatch([100_000, 40_000]);
    await line("not-ours", 100_000);
    await line("bt-0", 99_999);
    expect(await linkBatchItems(db, new Date().toISOString())).toBe(0);
    expect(await paymentSettlement(db, items[0] as number)).toBe("awaiting_bank_line");
  });

  it("the link table insists on the same rule (trigger), whatever the application says", async () => {
    const { items } = await paidBatch([100_000, 40_000]);
    const wrong = await line("bt-1", 40_000);
    await expect(
      db
        .prepare(
          "INSERT INTO payment_bank_links (payment_id, bank_transaction_id, via) VALUES (?1, ?2, 'transaction_id')",
        )
        .bind(items[0], wrong)
        .run(),
    ).rejects.toThrow(/link_subject/);
  });

  it("draft transaction rows can only be written for a paid subject and are append-only", async () => {
    const id = await readyPayment(w, { itemId: await anotherBill(w) });
    await expect(
      db
        .prepare(
          "INSERT INTO payment_draft_transactions (subject_kind, subject_id, transaction_id, amount_minor, currency, recorded_at) VALUES ('payment', ?1, 'tx-123456', 5, 'EUR', 'now')",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(/link_subject/);
    const { batch } = await paidBatch([100_000, 40_000]);
    await expect(
      db.prepare("UPDATE payment_draft_transactions SET amount_minor = 1").run(),
    ).rejects.toThrow(/append_only/);
    await expect(db.prepare("DELETE FROM payment_draft_transactions").run()).rejects.toThrow(
      /append_only/,
    );
    expect(batch).toBeGreaterThan(0);
  });
});

// ---- S1: alerts, audit, acknowledge, settlement ----------------------------------------------------

describe("S1: alerts are visible state, audited once, acknowledged by a person", () => {
  it("a transaction that is not ours (mismatch) is an alert with an audit row, raised once", async () => {
    // pay mode world for the transaction path
    w.fake.restore();
    w = await execWorld({ mode: "pay" });
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "p-1" });
    const rid = (await rowOf(id)).request_id;
    client.txByRid.set(rid, { ...tx("t-x", "completed", 1), requestId: rid });
    expect(await run()).toMatchObject({ alerts: 1 });
    expect(await rec("payment", id)).toMatchObject({
      last_result: "mismatch",
      alert_kind: "mismatch",
    });
    await run();
    await run();
    expect((await audits("payment.mismatch")).length).toBe(1);
    expect((await rowOf(id)).status).toBe("submitted");
  });

  it("two drafts with our title (a lost answer) are a duplicate alert with an audit row", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "unknown" });
    const title = `CF-${(await rowOf(id)).request_id.replace(/-/g, "").slice(0, 12)}`;
    client.list = [
      draft("d-2", [{ state: "pending" }], title),
      draft("d-3", [{ state: "pending" }], title),
    ];
    await run();
    expect(await rec("payment", id)).toMatchObject({ alert_kind: "duplicate" });
    expect((await audits("payment.duplicate")).length).toBe(1);
  });

  it("acknowledge: finance/admin say they looked; once; audited; the alert is then closed", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", draft("draft-1", [{ state: "completed" }]));
    await run();
    const now = Date.now();
    expect(
      await ackAlert(db, {
        kind: "payment",
        id: 999_999,
        actor: w.emails.finance,
        nowMs: now,
        note: null,
      }),
    ).toEqual({ ok: false, code: "not_found" });
    const ok = await ackAlert(db, {
      kind: "payment",
      id,
      actor: w.emails.finance,
      nowMs: now,
      note: "checked in the Revolut app",
    });
    expect(ok).toEqual({ ok: true, kind: "draft_completed_unlinked" });
    expect(await rec("payment", id)).toMatchObject({
      alert_ack_by: w.emails.finance,
      alert_kind: "draft_completed_unlinked",
    });
    expect((await rec("payment", id))?.["alert_ack_at"]).toBe(new Date(now).toISOString());
    expect(
      await ackAlert(db, { kind: "payment", id, actor: w.emails.admin, nowMs: now, note: null }),
    ).toEqual({ ok: false, code: "already_acknowledged" });
    const a = await audits("payment.alert_acknowledged");
    expect(a).toHaveLength(1);
    // the same alert on the next run does NOT re-open it (no nagging) ...
    await run();
    expect((await rec("payment", id))?.["alert_ack_by"]).toBe(w.emails.finance);
    // ... and a request without any alert has nothing to acknowledge
    const other = await readyPayment(w, { itemId: await anotherBill(w) });
    expect(
      await ackAlert(db, {
        kind: "payment",
        id: other,
        actor: w.emails.finance,
        nowMs: now,
        note: null,
      }),
    ).toEqual({ ok: false, code: "no_alert" });
  });

  it("a DIFFERENT alert after an acknowledgement is open again and audited", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "unknown" });
    const title = `CF-${(await rowOf(id)).request_id.replace(/-/g, "").slice(0, 12)}`;
    client.list = [
      draft("d-2", [{ state: "pending" }], title),
      draft("d-3", [{ state: "pending" }], title),
    ];
    await run();
    await ackAlert(db, {
      kind: "payment",
      id,
      actor: w.emails.finance,
      nowMs: Date.now(),
      note: null,
    });
    expect((await rec("payment", id))?.["alert_ack_at"]).not.toBeNull();
    // now one draft, completed, without transactions: another kind of alert
    client.list = [draft("d-2", [{ state: "completed" }], title)];
    await run();
    const r = await rec("payment", id);
    expect(r).toMatchObject({
      alert_kind: "draft_completed_unlinked",
      alert_ack_at: null,
      alert_ack_by: null,
    });
    expect((await audits("payment.draft_completed_unlinked")).length).toBe(1);
  });

  it("review F9a: an acknowledged alert is raised (and audited) again when the condition comes BACK", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    await run(); // 404: draft_gone
    expect((await audits("payment.draft_gone")).length).toBe(1);
    expect(
      (
        await ackAlert(db, {
          kind: "payment",
          id,
          actor: w.emails.finance,
          nowMs: Date.now(),
          note: null,
        })
      ).ok,
    ).toBe(true);
    // still gone: stays acknowledged, no new audit row
    await run();
    expect((await rec("payment", id))?.["alert_ack_by"]).toBe(w.emails.finance);
    // an unreadable answer is no sign of health: the acknowledged alert stays as it is
    client.drafts.set("draft-1", new RevolutApiError(500, "boom"));
    await run();
    expect(await rec("payment", id)).toMatchObject({
      alert_kind: "draft_gone",
      alert_ack_by: w.emails.finance,
    });
    // healthy again (pending): the acknowledged alert is forgotten
    client.drafts.set("draft-1", draft("draft-1", [{ state: "pending" }]));
    await run();
    expect(await rec("payment", id)).toMatchObject({
      alert_at: null,
      alert_kind: null,
      alert_ack_at: null,
    });
    // gone again: raised again, open, audited a second time
    client.drafts.delete("draft-1");
    await run();
    expect(await rec("payment", id)).toMatchObject({
      alert_kind: "draft_gone",
      alert_ack_at: null,
    });
    expect((await audits("payment.draft_gone")).length).toBe(2);
  });

  it("an alert nobody acknowledged stays open even when the subject looks healthy again", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    await run();
    client.drafts.set("draft-1", draft("draft-1", [{ state: "pending" }]));
    await run();
    expect(await rec("payment", id)).toMatchObject({
      alert_kind: "draft_gone",
      alert_ack_at: null,
    });
    expect((await rec("payment", id))?.["alert_at"]).not.toBeNull();
  });

  it("settlement: a draft approved after its request expired is NOT 'not_paid'", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", draft("draft-1", [{ state: "pending" }]));
    await run(Date.now() + 6 * DAY);
    expect((await rowOf(id)).status).toBe("failed");
    expect(await paymentSettlement(db, id)).toBe("not_paid");
    client.drafts.set("draft-1", draft("draft-1", [{ state: "completed", tx: "t-late" }]));
    await run(Date.now() + 7 * DAY);
    expect(await rec("payment", id)).toMatchObject({ alert_kind: "approved_after_expiry" });
    expect(await paymentSettlement(db, id)).toBe("approved_after_expiry");
    expect((await audits("payment.approved_after_expiry")).length).toBe(1);
  });

  it("settlement: a paid payment whose bank line was reversed says so, with an audit row", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", draft("draft-1", [{ state: "completed", tx: "t-1" }]));
    client.txById.set("t-1", tx("t-1", "completed"));
    await run();
    const l = await addTx({
      connectionId: w.revolutConnectionId,
      accountId: w.accountId,
      amountMinor: -100_000,
    });
    await db
      .prepare("UPDATE bank_transactions SET external_id = 't-1' WHERE id = ?1")
      .bind(l)
      .run();
    await run();
    expect(await paymentSettlement(db, id)).toBe("awaiting_match");
    await db.prepare("UPDATE bank_transactions SET state = 'reverted' WHERE id = ?1").bind(l).run();
    const s = await run();
    expect(s.alerts).toBeGreaterThanOrEqual(1);
    expect(await paymentSettlement(db, id)).toBe("reverted_after_paid");
    expect((await audits("payment.reverted_after_paid")).length).toBe(1);
    expect(await rec("payment", id)).toMatchObject({ alert_kind: "reverted_after_paid" });
  });
});
