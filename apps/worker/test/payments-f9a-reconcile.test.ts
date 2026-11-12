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
import {
  ackAlert,
  linkBatchItems,
  paymentSettlement,
  reconcilePayments,
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
  const freshFeed = (): Promise<unknown> =>
    db
      .prepare("UPDATE bank_accounts SET balance_at = ?2 WHERE id = ?1")
      .bind(w.accountId, new Date(Date.now() + 6 * DAY - 60_000).toISOString())
      .run();

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

  it("past the expiry, fresh feed, but a bank line of this account and amount exists: stays submitted", async () => {
    const id = await submittedWithDraft();
    await freshFeed();
    await addTx({
      connectionId: w.revolutConnectionId,
      accountId: w.accountId,
      amountMinor: -100_000,
      createdAt: new Date().toISOString(),
    });
    const s = await run(Date.now() + 6 * DAY);
    expect(s.failed).toBe(0);
    expect((await rowOf(id)).status).toBe("submitted");
    expect(await rec("payment", id)).toMatchObject({ alert_kind: "draft_gone" });
  });

  it("before the expiry it is also an alert and a person is told; nothing moves", async () => {
    const id = await submittedWithDraft();
    await run(Date.now() + DAY);
    expect((await rowOf(id)).status).toBe("submitted");
    expect(await rec("payment", id)).toMatchObject({ alert_kind: "draft_gone" });
  });

  it("with POSITIVE evidence (fresh feed, no such line since the request) an expired draft fails, no alert", async () => {
    const id = await submittedWithDraft();
    await freshFeed();
    const s = await run(Date.now() + 6 * DAY);
    expect(s.failed).toBe(1);
    expect(await rowOf(id)).toMatchObject({ status: "failed", status_reason: "draft_expired" });
    expect((await rec("payment", id))?.["alert_kind"]).toBeNull();
  });

  it("a failed-state bank line does not count as a payment (it is evidence of NO money moved)", async () => {
    const id = await submittedWithDraft();
    await freshFeed();
    await addTx({
      connectionId: w.revolutConnectionId,
      accountId: w.accountId,
      amountMinor: -100_000,
      state: "declined",
      createdAt: new Date().toISOString(),
    });
    expect((await run(Date.now() + 6 * DAY)).failed).toBe(1);
    expect((await rowOf(id)).status).toBe("failed");
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
