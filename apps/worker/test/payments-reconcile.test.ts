/**
 * Reconciliation (P9b, ADR 0050): what the job `payments.reconcile` does with payments that were
 * sent. A scripted client stands in for Revolut so every answer is under the test's control; the
 * D1 side (P9a transitions, migration 0029 guards) is real.
 */
import {
  RevolutApiError,
  type PaymentDraftView,
  type RevolutClient,
  type RevolutTransaction,
} from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DRAFT_EXPIRY_DAYS,
  interpretDraft,
  linkPaidPayments,
  loadDraftExpiryDays,
  paymentSettlement,
  paymentSettlements,
  reconcilePayments,
  DRAFT_EXPIRY_KEY,
} from "../src/payments/reconcile";
import { runSubmission, setSubmitterForTests, type SubmitOutcome } from "../src/payments/submit";
import { runPaymentsReconcile } from "../src/payments/reconcile-job";
import { readPayment } from "../src/payments/read";
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
import { SOURCE_ACCOUNT_UUID } from "./payments-fake-revolut";
import { setSetting, addTx, jobContext } from "./matching-helpers";
import { withoutTriggers } from "./booking-helpers";

let w: ExecWorld;
const DAY = 86_400_000;

class FakeClient {
  tx = new Map<string, RevolutTransaction | Error | null>();
  drafts = new Map<string, PaymentDraftView | Error>();
  list: PaymentDraftView[] | Error = [];
  calls: string[] = [];
  asClient(): RevolutClient {
    return this as unknown as RevolutClient;
  }
  async getTransactionByRequestId(rid: string): Promise<RevolutTransaction | null> {
    this.calls.push(`tx:${rid}`);
    const v = this.tx.get(rid);
    if (v instanceof Error) throw v;
    return v ?? null;
  }
  byId = new Map<string, RevolutTransaction | Error>();
  async getTransaction(id: string): Promise<RevolutTransaction> {
    this.calls.push(`txid:${id}`);
    const v = this.byId.get(id);
    if (v === undefined) throw new RevolutApiError(404, "not found");
    if (v instanceof Error) throw v;
    return v;
  }
  async getPaymentDraft(id: string): Promise<PaymentDraftView> {
    this.calls.push(`draft:${id}`);
    const v = this.drafts.get(id);
    if (v === undefined) throw new RevolutApiError(404, "not found");
    if (v instanceof Error) throw v;
    return v;
  }
  async listPaymentDrafts(): Promise<PaymentDraftView[]> {
    this.calls.push("list");
    if (this.list instanceof Error) throw this.list;
    return this.list;
  }
}
let client: FakeClient;

const txFor = (
  rid: string,
  state: RevolutTransaction["state"],
  over: { amountMinor?: number; account?: string; id?: string } = {},
): RevolutTransaction => ({
  id: over.id ?? "64f1e2a0-1111-4222-8333-444455556666",
  type: "transfer",
  requestId: rid,
  state,
  createdAt: "2026-11-12T10:00:00Z",
  legs: [
    {
      legId: "l1",
      accountId: over.account ?? SOURCE_ACCOUNT_UUID,
      amountMinor: -(over.amountMinor ?? 100_000),
      currency: "EUR",
    },
  ],
});

async function toState(
  id: number,
  outcome: SubmitOutcome,
  kind: "payment" | "batch" = "payment",
  nowMs = Date.now(),
): Promise<void> {
  setSubmitterForTests({ available: true, submit: () => Promise.resolve(outcome) });
  await runSubmission(
    db,
    { available: true, submit: () => Promise.resolve(outcome) },
    { kind, id, nowMs, owner: "job", ibanKey: TEST_IBAN_KEY },
  );
  setSubmitterForTests(null);
}
const run = (nowMs = Date.now()) =>
  reconcilePayments({ db, nowMs, client: () => Promise.resolve(client.asClient()) });
const reconcileRow = async (kind: string, id: number) =>
  db
    .prepare("SELECT * FROM payment_reconcile WHERE subject_kind = ?1 AND subject_id = ?2")
    .bind(kind, id)
    .first<Record<string, unknown>>();

beforeEach(async () => {
  w = await execWorld({ mode: "pay" });
  client = new FakeClient();
});
afterEach(() => w.fake.restore());

describe("pay mode: resolved by request_id, only on final states", () => {
  it("pending leaves a submitted payment alone", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "p-1" });
    const rid = (await rowOf(id)).request_id;
    client.tx.set(rid, txFor(rid, "pending"));
    const s = await run();
    expect(s).toMatchObject({ checked: 1, pending: 1, paid: 0, failed: 0 });
    expect((await rowOf(id)).status).toBe("submitted");
    expect(await reconcileRow("payment", id)).toMatchObject({
      last_result: "pending",
      provider_state: "pending",
    });
  });

  it("completed -> paid with the transaction id; a second run changes nothing", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "p-1" });
    const rid = (await rowOf(id)).request_id;
    client.tx.set(rid, txFor(rid, "completed"));
    expect(await run()).toMatchObject({ paid: 1 });
    expect(await rowOf(id)).toMatchObject({
      status: "paid",
      provider_id: "64f1e2a0-1111-4222-8333-444455556666",
    });
    const calls = client.calls.length;
    expect(await run()).toMatchObject({ checked: 0, paid: 0 });
    expect(client.calls.length).toBe(calls); // nothing in flight: no call
    const events = await db
      .prepare("SELECT to_status FROM payment_events WHERE payment_id = ?1 ORDER BY id")
      .bind(id)
      .all<{ to_status: string }>();
    expect(events.results.filter((e) => e.to_status === "paid")).toHaveLength(1);
  });

  it("declined, failed and reverted -> failed", async () => {
    for (const state of ["declined", "failed", "reverted"] as const) {
      const id = await readyPayment(w, { itemId: await anotherBill(w) });
      await toState(id, { kind: "accepted", providerId: "p" });
      const rid = (await rowOf(id)).request_id;
      client.tx.set(rid, txFor(rid, state));
      await run();
      expect(await rowOf(id), state).toMatchObject({
        status: "failed",
        status_reason: `bank_${state}`,
      });
    }
  });

  it("an unknown state is not final: nothing moves", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "p" });
    const rid = (await rowOf(id)).request_id;
    client.tx.set(rid, txFor(rid, "unknown"));
    await run();
    expect((await rowOf(id)).status).toBe("submitted");
  });

  it("outcome_unknown: a pending transaction lifts it to submitted; completed goes straight to paid", async () => {
    const a = await readyPayment(w);
    await toState(a, { kind: "unknown" });
    expect((await rowOf(a)).status).toBe("outcome_unknown");
    const rid = (await rowOf(a)).request_id;
    client.tx.set(rid, txFor(rid, "pending", { id: "aaaaaaaa-1111-4222-8333-444455556666" }));
    await run();
    expect(await rowOf(a)).toMatchObject({
      status: "submitted",
      provider_id: "aaaaaaaa-1111-4222-8333-444455556666",
    });
    const b = await readyPayment(w, { itemId: await anotherBill(w) });
    await toState(b, { kind: "unknown" });
    const rb = (await rowOf(b)).request_id;
    client.tx.set(rb, txFor(rb, "completed", { id: "bbbbbbbb-1111-4222-8333-444455556666" }));
    await run();
    expect((await rowOf(b)).status).toBe("paid");
  });

  it("not found never moves a payment; it is recorded and counted", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "unknown" });
    await run();
    await run();
    expect((await rowOf(id)).status).toBe("outcome_unknown");
    expect(await reconcileRow("payment", id)).toMatchObject({
      last_result: "not_found",
      not_found_checks: 2,
    });
  });

  it("a transaction under our id with another amount, account or request id is a mismatch: reported, never adopted", async () => {
    for (const over of [
      { amountMinor: 100 },
      { account: "ffffffff-8d8c-430d-b967-87ac01af060c" },
    ]) {
      const id = await readyPayment(w, { itemId: await anotherBill(w) });
      await toState(id, { kind: "unknown" });
      const rid = (await rowOf(id)).request_id;
      client.tx.set(rid, txFor(rid, "completed", over));
      const s = await run();
      expect(s.alerts).toBeGreaterThanOrEqual(1);
      expect((await rowOf(id)).status).toBe("outcome_unknown");
      expect(await reconcileRow("payment", id)).toMatchObject({ last_result: "mismatch" });
      expect((await reconcileRow("payment", id))?.["alert_at"]).not.toBeNull();
    }
    const id = await readyPayment(w, { itemId: await anotherBill(w) });
    await toState(id, { kind: "accepted", providerId: "p" });
    client.tx.set(
      (await rowOf(id)).request_id,
      txFor("11111111-1111-4111-8111-111111111111", "completed"),
    );
    await run();
    expect((await rowOf(id)).status).toBe("submitted");
  });

  it("a lookup error is recorded and moves nothing; the next run tries again", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "p" });
    const rid = (await rowOf(id)).request_id;
    client.tx.set(rid, new RevolutApiError(503, "down", "gate_unavailable"));
    expect(await run()).toMatchObject({ errors: 1 });
    expect((await rowOf(id)).status).toBe("submitted");
    client.tx.set(rid, txFor(rid, "completed"));
    await run();
    expect((await rowOf(id)).status).toBe("paid");
  });

  it("a stale claim becomes unknown first (lease expiry), then is looked up", async () => {
    const id = await readyPayment(w);
    // claimed and submitting, the worker died: use a submitter that never answers in time
    setSubmitterForTests(null);
    await db.batch([
      db
        .prepare(
          "INSERT INTO payment_claims (payment_id, owner, claimed_at, lease_until) VALUES (?1, 'dead', ?2, ?3)",
        )
        .bind(
          id,
          new Date(Date.now() - 20 * 60_000).toISOString(),
          new Date(Date.now() - 10 * 60_000).toISOString(),
        ),
      db.prepare("UPDATE payments SET status = 'submitting' WHERE id = ?1").bind(id),
    ]);
    const rid = (await rowOf(id)).request_id;
    client.tx.set(rid, txFor(rid, "completed"));
    await run();
    expect((await rowOf(id)).status).toBe("paid");
  });
});

describe("drafts: approval in the Revolut app, lost answers, expiry", () => {
  beforeEach(async () => {
    w.fake.restore();
    w = await execWorld({ mode: "drafts" });
    client = new FakeClient();
  });
  const view = (id: string, state: string, title?: string, txId?: string): PaymentDraftView => ({
    id,
    ...(title ? { title } : {}),
    payments: [{ state, ...(txId ? { transactionId: txId } : {}) }],
  });

  it("pending stays; approved in the app (completed) -> paid", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", view("draft-1", "pending"));
    await run();
    expect((await rowOf(id)).status).toBe("submitted");
    client.drafts.set("draft-1", view("draft-1", "completed", undefined, "tx-9"));
    // review P9b: the draft's "completed" is checked against the transaction it names
    client.byId.set("tx-9", txFor("x", "pending", { id: "tx-9" }));
    await run();
    expect((await rowOf(id)).status).toBe("submitted");
    client.byId.set("tx-9", new RevolutApiError(503, "down"));
    expect(await run()).toMatchObject({ errors: 1 });
    expect((await rowOf(id)).status).toBe("submitted");
    client.byId.set("tx-9", txFor("x", "completed", { id: "tx-9", amountMinor: 1 }));
    expect(await run()).toMatchObject({ alerts: 1 }); // not our amount: never paid
    expect((await rowOf(id)).status).toBe("submitted");
    client.byId.set("tx-9", txFor("x", "completed", { id: "tx-9" }));
    await run();
    expect((await rowOf(id)).status).toBe("paid");
    expect(await reconcileRow("payment", id)).toMatchObject({ transaction_id: "tx-9" });
  });

  it("review P9b: a 'completed' draft whose transaction was declined is failed, not paid", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", view("draft-1", "completed", undefined, "tx-9"));
    client.byId.set("tx-9", txFor("x", "declined", { id: "tx-9" }));
    await run();
    expect(await rowOf(id)).toMatchObject({ status: "failed", status_reason: "bank_declined" });
  });

  it("a revoked or failed draft -> failed", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", view("draft-1", "revoked"));
    await run();
    expect(await rowOf(id)).toMatchObject({ status: "failed", status_reason: "bank_revoked" });
  });

  it("not approved after N days -> failed (draft_expired); N is a setting, default 5, 1..30", async () => {
    expect(await loadDraftExpiryDays(db)).toBe(DEFAULT_DRAFT_EXPIRY_DAYS);
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", view("draft-1", "pending"));
    await run(Date.now() + 4 * DAY);
    expect((await rowOf(id)).status).toBe("submitted");
    await setSetting(DRAFT_EXPIRY_KEY, 2);
    expect(await loadDraftExpiryDays(db)).toBe(2);
    await run(Date.now() + 3 * DAY);
    expect(await rowOf(id)).toMatchObject({ status: "failed", status_reason: "draft_expired" });
    for (const bad of [0, 31, "x", 1.5]) {
      await setSetting(DRAFT_EXPIRY_KEY, bad);
      expect(await loadDraftExpiryDays(db), String(bad)).toBe(DEFAULT_DRAFT_EXPIRY_DAYS);
    }
  });

  it("an approval AFTER the expiry is raised as an alert (the draft stays on the watch list)", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "draft-1" });
    client.drafts.set("draft-1", view("draft-1", "pending"));
    await run(Date.now() + 6 * DAY);
    expect((await rowOf(id)).status).toBe("failed");
    client.drafts.set("draft-1", view("draft-1", "completed", undefined, "tx-late"));
    const s = await run(Date.now() + 7 * DAY);
    expect(s.alerts).toBeGreaterThanOrEqual(1);
    expect(await reconcileRow("payment", id)).toMatchObject({
      last_result: "approved_after_expiry",
    });
    expect((await rowOf(id)).status).toBe("failed"); // final stays final; a person acts
    const audit = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.approved_after_expiry'")
      .first<{ n: number }>();
    expect(audit?.n).toBeGreaterThanOrEqual(1);
    // raised once
    const before = audit?.n ?? 0;
    await run(Date.now() + 8 * DAY);
    const after = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.approved_after_expiry'")
      .first<{ n: number }>();
    expect(after?.n).toBe(before);
  });

  it("a lost draft answer (unknown, no draft id): found by its title; two drafts with it are a duplicate alert", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "unknown" });
    const rid = (await rowOf(id)).request_id;
    const title = `CF-${rid.replace(/-/g, "").slice(0, 12)}`;
    client.list = [view("other", "pending", "CF-other")];
    await run();
    expect((await rowOf(id)).status).toBe("outcome_unknown");
    expect(await reconcileRow("payment", id)).toMatchObject({ last_result: "not_found" });
    client.list = [view("d-1", "pending", title)];
    await run();
    expect(await rowOf(id)).toMatchObject({ status: "submitted", provider_id: "d-1" });
    const b = await readyPayment(w, { itemId: await anotherBill(w) });
    await toState(b, { kind: "unknown" });
    const tb = `CF-${(await rowOf(b)).request_id.replace(/-/g, "").slice(0, 12)}`;
    client.list = [view("d-2", "pending", tb), view("d-3", "pending", tb)];
    const s = await run();
    expect(s.alerts).toBeGreaterThanOrEqual(1);
    expect((await rowOf(b)).status).toBe("outcome_unknown");
    expect(await reconcileRow("payment", b)).toMatchObject({ last_result: "duplicate" });
  });

  it("a bulk draft: all approved -> the batch and every item are paid; mixed results alert and wait", async () => {
    const batch = await readyBatch(w, [w.itemId, await anotherBill(w)]);
    await toState(batch, { kind: "accepted", providerId: "bd-1" }, "batch");
    const two = (a: string, b: string): PaymentDraftView => ({
      id: "bd-1",
      payments: [{ state: a }, { state: b }],
    });
    client.drafts.set("bd-1", two("completed", "failed"));
    const s = await run();
    expect(s.alerts).toBeGreaterThanOrEqual(1);
    expect((await rowOf(batch, "payment_batches")).status).toBe("submitted");
    client.drafts.set("bd-1", two("completed", "completed"));
    await run();
    expect((await rowOf(batch, "payment_batches")).status).toBe("paid");
    const items = await db
      .prepare("SELECT status FROM payments WHERE batch_id = ?1")
      .bind(batch)
      .all<{ status: string }>();
    expect(items.results.map((r) => r.status)).toEqual(["paid", "paid"]);
  });

  it("interpretDraft: only 'completed' is done; unknown words are pending", () => {
    expect(interpretDraft({ id: "x", payments: [{ state: "completed" }] }).kind).toBe("paid");
    expect(interpretDraft({ id: "x", payments: [{ state: "pending" }] }).kind).toBe("pending");
    expect(interpretDraft({ id: "x", payments: [{ state: "weird" }] }).kind).toBe("pending");
    expect(interpretDraft({ id: "x", payments: [] }).kind).toBe("pending");
    expect(interpretDraft({ id: "x", state: "completed", payments: [] }).kind).toBe("paid");
    expect(interpretDraft({ id: "x", payments: [{ state: "declined" }] }).kind).toBe("failed");
  });
});

describe("bank line link and settlement (CLAUDE.md 4.3: bank confirmed AND booked in Exact)", () => {
  /** F9c review: the bulk read (lists, batch items) and the DTO agree with the single lookup. */
  async function settled(id: number): Promise<string> {
    const one = await paymentSettlement(db, id);
    expect((await paymentSettlements(db, [id])).get(id)).toBe(one);
    expect((await readPayment(db, id))?.settlement).toBe(one);
    return one;
  }
  async function paidPayment(): Promise<{ id: number; rid: string }> {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "p" });
    const rid = (await rowOf(id)).request_id;
    client.tx.set(rid, txFor(rid, "completed", { id: "64f1e2a0-1111-4222-8333-444455556666" }));
    await run();
    return { id, rid };
  }
  const bankLine = async (rid: string | null, amount = -100_000): Promise<number> => {
    const txId = await addTx({
      connectionId: w.revolutConnectionId,
      accountId: w.accountId,
      amountMinor: amount,
    });
    if (rid !== null) {
      await db
        .prepare("UPDATE bank_transactions SET request_id = ?2 WHERE id = ?1")
        .bind(txId, rid)
        .run();
    }
    return txId;
  };

  it("until the bank line exists the settlement says so; the reconciliation then links it by request_id", async () => {
    const { id, rid } = await paidPayment();
    expect(await settled(id)).toBe("awaiting_bank_line");
    const txId = await bankLine(rid);
    expect(await linkPaidPayments(db, new Date().toISOString())).toBe(1);
    expect(
      await db
        .prepare("SELECT bank_transaction_id, via FROM payment_bank_links WHERE payment_id = ?1")
        .bind(id)
        .first(),
    ).toMatchObject({ bank_transaction_id: txId, via: "request_id" });
    expect(await settled(id)).toBe("awaiting_match");
    // idempotent
    expect(await linkPaidPayments(db, new Date().toISOString())).toBe(0);
  });

  it("links by the transaction id when the request id is not on the line (drafts)", async () => {
    const { id } = await paidPayment();
    const txId = await bankLine(null);
    await db
      .prepare(
        "UPDATE bank_transactions SET external_id = '64f1e2a0-1111-4222-8333-444455556666' WHERE id = ?1",
      )
      .bind(txId)
      .run();
    await run();
    expect(
      await db.prepare("SELECT via FROM payment_bank_links WHERE payment_id = ?1").bind(id).first(),
    ).toMatchObject({ via: "transaction_id" });
  });

  it("never links a line with another amount, account or direction, and never one line to two payments", async () => {
    const { id, rid } = await paidPayment();
    const wrong = await bankLine(rid, -100);
    expect(wrong).toBeGreaterThan(0);
    expect(await linkPaidPayments(db, new Date().toISOString())).toBe(0);
    await expect(
      db
        .prepare(
          "INSERT INTO payment_bank_links (payment_id, bank_transaction_id, via) VALUES (?1, ?2, 'request_id')",
        )
        .bind(id, wrong)
        .run(),
    ).rejects.toThrow(/link_subject/);
    const good = await bankLine(rid);
    expect(await linkPaidPayments(db, new Date().toISOString())).toBe(1);
    const other = await readyPayment(w, { itemId: await anotherBill(w) });
    await toState(other, { kind: "accepted", providerId: "p2" });
    await db
      .prepare("UPDATE payments SET status = 'paid' WHERE id = ?1")
      .bind(other)
      .run()
      .catch(() => undefined);
    await expect(
      db
        .prepare(
          "INSERT INTO payment_bank_links (payment_id, bank_transaction_id, via) VALUES (?1, ?2, 'request_id')",
        )
        .bind(other, good)
        .run(),
    ).rejects.toThrow();
  });

  it("booked only when a live match for the line allocates THIS invoice and Exact has it (matched_in_exact)", async () => {
    const { id, rid } = await paidPayment();
    const txId = await bankLine(rid);
    await linkPaidPayments(db, new Date().toISOString());
    const item = (
      await db
        .prepare("SELECT open_item_id FROM payments WHERE id = ?1")
        .bind(id)
        .first<{ open_item_id: number }>()
    )?.open_item_id as number;
    const div = (
      await db
        .prepare("SELECT division_id FROM open_items WHERE id = ?1")
        .bind(item)
        .first<{ division_id: number }>()
    )?.division_id as number;
    const m = await db
      .prepare(
        "INSERT INTO matches (bank_transaction_id, division_id, source, amount_minor, currency, created_by) VALUES (?1, ?2, 'manual', 100000, 'EUR', 'x@camelthorncapital.com')",
      )
      .bind(txId, div)
      .run();
    const matchId = m.meta.last_row_id;
    expect(await settled(id)).toBe("match_other_invoice"); // a live match without our allocation is not ours
    await db
      .prepare(
        "INSERT INTO match_allocations (match_id, open_item_id, allocated_minor, currency) VALUES (?1, ?2, 100000, 'EUR')",
      )
      .bind(matchId, item)
      .run();
    expect(await settled(id)).toBe("awaiting_booking");
    await withoutTriggers(
      [
        "matches_guard_exact_state",
        "matches_guard_update",
        "matches_guard_booked_at",
        "matches_guard_manually_booked",
      ],
      async () => {
        await db
          .prepare("UPDATE matches SET exact_state = 'matched_in_exact' WHERE id = ?1")
          .bind(matchId)
          .run();
      },
    );
    expect(await settled(id)).toBe("booked");
    // a match for the line that allocates ANOTHER invoice is not ours
    const other = await anotherBill(w);
    await withoutTriggers(["match_allocations_guard_update"], async () => {
      await db
        .prepare("UPDATE match_allocations SET open_item_id = ?2 WHERE match_id = ?1")
        .bind(matchId, other)
        .run();
    });
    expect(await settled(id)).toBe("match_other_invoice");
  });

  it("a payment that is not paid has no settlement; a reversed bank line is raised once", async () => {
    const paid = await paidPayment();
    const id = await readyPayment(w, { itemId: await anotherBill(w) });
    expect(await settled(id)).toBe("not_paid");
    const txId = await bankLine(paid.rid);
    await linkPaidPayments(db, new Date().toISOString());
    await withoutTriggers(["bank_transactions_guard_status"], async () => {
      await db
        .prepare("UPDATE bank_transactions SET state = 'reverted' WHERE id = ?1")
        .bind(txId)
        .run();
    });
    const s = await run();
    expect(s.alerts).toBeGreaterThanOrEqual(1);
    expect(await reconcileRow("payment", paid.id)).toMatchObject({
      last_result: "reverted_after_paid",
    });
    const again = await run();
    expect(again.alerts).toBe(0);
  });
});

describe("the job", () => {
  it("makes no Revolut call at all when nothing is in flight", async () => {
    const r = await runPaymentsReconcile(jobContext());
    expect(r).toMatchObject({ status: "ok", summary: { checked: 0, errors: 0 } });
    expect(w.fake.stub.apiCalls).toHaveLength(0);
    expect(w.fake.stub.tokenCalls).toHaveLength(0);
  });

  it("goes through the real gate with the reconcile job class when a payment is in flight (read-only)", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "unknown" });
    const rid = (await rowOf(id)).request_id;
    w.fake.transactions.set("t", {
      id: "64f1e2a0-1111-4222-8333-444455556666",
      requestId: rid,
      state: "completed",
      amount: "1000.00",
      currency: "EUR",
      accountId: SOURCE_ACCOUNT_UUID,
    });
    const r = await runPaymentsReconcile(jobContext());
    expect(r).toMatchObject({ status: "ok", summary: { checked: 1, paid: 1 } });
    expect((await rowOf(id)).status).toBe("paid");
    expect(w.fake.stub.apiCalls.every((c) => c.method === "GET")).toBe(true);
  });

  it("runs while payments are switched OFF (it must not go blind), and says error without a connection", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "unknown" });
    await db
      .prepare("UPDATE settings SET value_json = 'false' WHERE key = 'payments.enabled'")
      .run();
    const rid = (await rowOf(id)).request_id;
    w.fake.transactions.set("t", {
      id: "64f1e2a0-1111-4222-8333-444455556666",
      requestId: rid,
      state: "pending",
      amount: "1000.00",
      currency: "EUR",
      accountId: SOURCE_ACCOUNT_UUID,
    });
    expect(await runPaymentsReconcile(jobContext())).toMatchObject({ status: "ok" });
    expect((await rowOf(id)).status).toBe("submitted");
    await db
      .prepare("UPDATE connections SET status = 'disabled' WHERE id = ?1")
      .bind(w.revolutConnectionId)
      .run();
    expect(await runPaymentsReconcile(jobContext())).toMatchObject({
      status: "error",
      code: "no_revolut_connection",
    });
  });
});
