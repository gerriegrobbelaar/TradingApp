/**
 * F9c: the payment DTO says how far a bank-paid payment is booked (`settlement`), so no screen has
 * to call a payment "Paid" on the bank's word alone (CLAUDE.md 4.3). The value comes from the
 * existing `paymentSettlement`; this only checks that the read paths carry it, for a payment, a list
 * and the items of a batch.
 */
import { PAYMENT_SETTLEMENTS, type PaymentSettlement } from "@camelthorn/core";
import type { RevolutClient, RevolutTransaction } from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkPaidPayments, paymentSettlement, reconcilePayments } from "../src/payments/reconcile";
import { listPayments, readBatch, readPayment } from "../src/payments/read";
import type { Settlement } from "../src/payments/reconcile";
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

// The worker's union and the codes of core are the same set (a change in either fails the build).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameSets: Same<Settlement, PaymentSettlement> = true;

let w: ExecWorld;
const tx = new Map<string, RevolutTransaction>();
const client = {
  getTransactionByRequestId: (rid: string) => Promise.resolve(tx.get(rid) ?? null),
} as unknown as RevolutClient;

async function toState(id: number, outcome: SubmitOutcome): Promise<void> {
  await runSubmission(
    db,
    { available: true, submit: () => Promise.resolve(outcome) },
    { kind: "payment", id, nowMs: Date.now(), owner: "job", ibanKey: TEST_IBAN_KEY },
  );
}
const completed = (rid: string): RevolutTransaction => ({
  id: "64f1e2a0-1111-4222-8333-444455556666",
  type: "transfer",
  requestId: rid,
  state: "completed",
  createdAt: "2026-11-12T10:00:00Z",
  legs: [{ legId: "l1", accountId: SOURCE_ACCOUNT_UUID, amountMinor: -100_000, currency: "EUR" }],
});

beforeEach(async () => {
  tx.clear();
  w = await execWorld({ mode: "pay" });
});
afterEach(() => {
  setSubmitterForTests(null);
  w.fake.restore();
});

describe("PaymentDto.settlement", () => {
  it("the two sets of codes are the same", () => {
    expect(sameSets).toBe(true);
    expect(PAYMENT_SETTLEMENTS).toContain("booked");
  });

  it("is not_paid for every status except paid, without looking anything up", async () => {
    const id = await readyPayment(w);
    expect((await readPayment(db, id))?.settlement).toBe("not_paid");
    await toState(id, { kind: "accepted", providerId: "p-1" });
    const dto = await readPayment(db, id);
    expect(dto?.status).toBe("submitted");
    expect(dto?.settlement).toBe("not_paid");
  });

  it("a bank-paid payment is awaiting_bank_line, then awaiting_match: never booked on the bank's word", async () => {
    const id = await readyPayment(w);
    await toState(id, { kind: "accepted", providerId: "p-1" });
    const rid = (await rowOf(id)).request_id;
    tx.set(rid, completed(rid));
    await reconcilePayments({ db, nowMs: Date.now(), client: () => Promise.resolve(client) });
    const paid = await readPayment(db, id);
    expect(paid?.status).toBe("paid");
    expect(paid?.settlement).toBe("awaiting_bank_line");
    expect(paid?.settlement).toBe(await paymentSettlement(db, id));

    const txId = await addTx({
      connectionId: w.revolutConnectionId,
      accountId: w.accountId,
      amountMinor: -100_000,
    });
    await db
      .prepare("UPDATE bank_transactions SET request_id = ?2 WHERE id = ?1")
      .bind(txId, rid)
      .run();
    await linkPaidPayments(db, new Date().toISOString());
    expect((await readPayment(db, id))?.settlement).toBe("awaiting_match");
    // The list carries it too.
    const listed = (
      await listPayments(db, { status: "paid", requestedBy: null, limit: 10, cursorId: null })
    ).items;
    expect(listed.map((p) => [p.id, p.settlement])).toEqual([[id, "awaiting_match"]]);
  });

  it("the items of a batch carry their own settlement", async () => {
    w.fake.restore();
    w = await execWorld({ mode: "drafts" });
    const b = await readyBatch(w, [await anotherBill(w), await anotherBill(w)]);
    const batch = await readBatch(db, b);
    expect(batch?.items.length).toBe(2);
    expect(batch?.items.every((i) => i.settlement === "not_paid")).toBe(true);
  });
});

/** A D1 stand-in that counts statements and can fail the settlement lookup (F9c review). */
function spyDb(failOn: RegExp | null): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (q: string) => {
          sql.push(q);
          if (failOn !== null && failOn.test(q)) throw new Error("D1_ERROR: simulated");
          return target.prepare(q);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: wrapped, sql };
}

describe("settlement on the list pages (review F9c)", () => {
  async function paid(itemId?: number): Promise<number> {
    const id = await readyPayment(w, itemId === undefined ? {} : { itemId });
    await toState(id, { kind: "accepted", providerId: `p-${id}` });
    const rid = (await rowOf(id)).request_id;
    tx.set(rid, completed(rid));
    await reconcilePayments({ db, nowMs: Date.now(), client: () => Promise.resolve(client) });
    expect((await rowOf(id)).status).toBe("paid");
    return id;
  }

  it("is ONE settlement query for a page of paid payments, not one per row", async () => {
    const ids = [await paid(), await paid(await anotherBill(w)), await paid(await anotherBill(w))];
    const spy = spyDb(null);
    const page = await listPayments(spy.db, {
      status: "paid",
      requestedBy: null,
      limit: 25,
      cursorId: null,
    });
    expect(page.items.map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(page.items.every((p) => p.settlement === "awaiting_bank_line")).toBe(true);
    expect(spy.sql.filter((q) => /payment_bank_links/.test(q)).length).toBe(1);
    // no write on a GET
    expect(spy.sql.some((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q))).toBe(false);
  });

  it("no lookup at all when nothing on the page is paid", async () => {
    await readyPayment(w);
    const spy = spyDb(null);
    await listPayments(spy.db, { status: "all", requestedBy: null, limit: 25, cursorId: null });
    expect(spy.sql.filter((q) => /payment_bank_links/.test(q))).toEqual([]);
  });

  it("a failed lookup is never booked: every paid row reads as awaiting_bank_line, the page still loads", async () => {
    const id = await paid();
    const spy = spyDb(/payment_bank_links/);
    const dto = await readPayment(spy.db, id);
    expect(dto?.status).toBe("paid");
    expect(dto?.settlement).toBe("awaiting_bank_line");
  });
});
