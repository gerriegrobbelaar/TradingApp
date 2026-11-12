/**
 * Shared setup for the P9b payment execution tests: a payment world whose Revolut connection is
 * fully usable behind the REAL RevolutGate (tokens, a uuid source account), the deploy switch on for
 * that gate, a scripted fake Revolut, and helpers that bring a request to `ready`.
 */
import { env } from "cloudflare:test";
import { batchConfirmPhrase, paymentConfirmPhrase } from "@camelthorn/core";
import { loadPaymentsState } from "../src/payments/settings";
import { confirmRequest, createBatch, createPayment, decideRequest } from "../src/payments/store";
import { submitPayment, type SubmissionResult } from "../src/payments/submit";
import type { Env } from "../src/env";
import { FakeRevolut, gateExecution, useUuidAccount } from "./payments-fake-revolut";
import {
  addBill,
  db,
  payWorld,
  TEST_IBAN_KEY,
  verifyIbanRow,
  SUPPLIER_IBAN,
  type PayWorld,
} from "./payments-helpers";
import { setRevolutClientSleepForTests } from "../src/revolut/client-timing";

export { db, TEST_IBAN_KEY };

/** An Env whose deploy switch is on (the gate gets the same through `gateExecution`). */
export const onEnv = (): Env => ({ ...(env as Env), REVOLUT_PAYMENTS_EXECUTION: "on" });

export interface ExecWorld extends PayWorld {
  fake: FakeRevolut;
}

let seq = 0;

export async function execWorld(
  o: { mode?: "drafts" | "pay"; nowMs?: number } = {},
): Promise<ExecWorld> {
  // No real waiting between retries of a read in the client.
  setRevolutClientSleepForTests(() => Promise.resolve());
  const w = await payWorld(o.nowMs === undefined ? {} : { nowMs: o.nowMs });
  await useUuidAccount(w.accountId);
  await db
    .prepare("UPDATE connections SET payments_mode = ?2 WHERE id = ?1")
    .bind(w.revolutConnectionId, o.mode ?? "drafts")
    .run();
  await gateExecution(w.revolutConnectionId, true);
  if ((o.mode ?? "drafts") === "pay") {
    // The direct-payment mode: the setting, as an admin would have saved it after verifying.
    await db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_by) VALUES ('payments.settings', ?1, 'test')
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .bind(JSON.stringify({ mode: "pay" }))
      .run();
  }
  return { ...w, fake: new FakeRevolut() };
}

/** Creates, confirms and (when needed) approves one payment; returns its id. */
export async function readyPayment(
  w: PayWorld,
  o: { itemId?: number; nowMs?: number } = {},
): Promise<number> {
  const nowMs = o.nowMs ?? Date.now();
  const state = await loadPaymentsState(db, TEST_IBAN_KEY);
  const r = await createPayment(db, {
    nowMs,
    actor: w.emails.finance,
    state,
    ibanKey: TEST_IBAN_KEY,
    openItemId: o.itemId ?? w.itemId,
    sourceAccountId: w.accountId,
    clientKey: `exec-key-${++seq}-0123456789`,
  });
  if (r.blocked) throw new Error(`blocked: ${r.blocks.join(",")}`);
  const p = r.payment;
  await confirmRequest(db, {
    kind: "payment",
    id: p.id,
    nowMs,
    actor: w.emails.finance,
    authAtMs: nowMs,
    state,
    ibanKey: TEST_IBAN_KEY,
    phrase: paymentConfirmPhrase(p.amountMinor, p.currency, "4300"),
  });
  const s = await db
    .prepare("SELECT status FROM payments WHERE id = ?1")
    .bind(p.id)
    .first<{ status: string }>();
  if (s?.status === "pending_approval") {
    await decideRequest(db, {
      kind: "payment",
      id: p.id,
      nowMs,
      actor: w.emails.approver,
      roles: ["approver"],
      authAtMs: nowMs,
      seenPayloadHash: p.payloadHash,
      decision: "approved",
      note: null,
    });
  }
  return p.id;
}

/** A second approved bill of the same supplier (a second payment, a batch item). */
export async function anotherBill(w: PayWorld, openMinor = 100_000): Promise<number> {
  return (await addBill(w, { openMinor })).itemId;
}

export async function readyBatch(w: PayWorld, itemIds: number[]): Promise<number> {
  const nowMs = Date.now();
  const state = await loadPaymentsState(db, TEST_IBAN_KEY);
  const r = await createBatch(db, {
    nowMs,
    actor: w.emails.finance,
    state,
    ibanKey: TEST_IBAN_KEY,
    sourceAccountId: w.accountId,
    items: itemIds.map((openItemId) => ({ openItemId, amountMinor: undefined })),
    clientKey: `exec-batch-${++seq}-0123456789`,
  });
  if (r.blocked) throw new Error(`blocked: ${r.blocks.join(",")} ${JSON.stringify(r.itemBlocks)}`);
  const b = r.batch;
  await confirmRequest(db, {
    kind: "batch",
    id: b.id,
    nowMs,
    actor: w.emails.finance,
    authAtMs: nowMs,
    state,
    ibanKey: TEST_IBAN_KEY,
    phrase: batchConfirmPhrase(b.itemCount, b.totalMinor, b.currency),
  });
  const s = await db
    .prepare("SELECT status FROM payment_batches WHERE id = ?1")
    .bind(b.id)
    .first<{ status: string }>();
  if (s?.status === "pending_approval") {
    await decideRequest(db, {
      kind: "batch",
      id: b.id,
      nowMs,
      actor: w.emails.approver,
      roles: ["approver"],
      authAtMs: nowMs,
      seenPayloadHash: b.payloadHash,
      decision: "approved",
      note: null,
    });
  }
  return b.id;
}

/**
 * A request that is `submitting` right now with its payee cached (what the gate's body check reads for
 * a /pay or /payment-drafts write): for tests that call the gate directly. Returns what the body must say.
 */
export async function stageSubmitting(
  w: PayWorld,
  counterpartyId: string,
): Promise<{ id: number; requestId: string; amountMinor: number; accountUuid: string }> {
  const id = await readyPayment(w);
  await db
    .prepare(
      `INSERT OR IGNORE INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for)
       SELECT ?1, iban_fingerprint, ?3, 'Acme', 'seed-seed' FROM payments WHERE id = ?2`,
    )
    .bind(w.revolutConnectionId, id, counterpartyId)
    .run();
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO payment_claims (payment_id, owner, claimed_at, lease_until) VALUES (?1, 'stage', ?2, ?3)",
    )
    .bind(id, now, new Date(Date.now() + 600_000).toISOString())
    .run();
  await db
    .prepare(
      "UPDATE payments SET status = 'submitting', status_reason = 'claimed', updated_at = ?2 WHERE id = ?1",
    )
    .bind(id, now)
    .run();
  const r = (await db
    .prepare(
      `SELECT p.request_id, p.amount_minor, a.external_id FROM payments p
         JOIN bank_accounts a ON a.id = p.bank_account_id WHERE p.id = ?1`,
    )
    .bind(id)
    .first()) as { request_id: string; amount_minor: number; external_id: string };
  return {
    id,
    requestId: r.request_id,
    amountMinor: r.amount_minor,
    accountUuid: r.external_id,
  };
}

export interface Row {
  status: string;
  status_reason: string | null;
  provider_id: string | null;
  request_id: string;
  submit_attempts: number;
}

export async function rowOf(
  id: number,
  table: "payments" | "payment_batches" = "payments",
): Promise<Row> {
  return (await db
    .prepare(
      `SELECT status, status_reason, provider_id, request_id, submit_attempts FROM ${table} WHERE id = ?1`,
    )
    .bind(id)
    .first<Row>()) as Row;
}

export const send = (
  w: PayWorld,
  id: number,
  kind: "payment" | "batch" = "payment",
  e: Env = onEnv(),
): Promise<SubmissionResult> =>
  submitPayment(e, { kind, id, nowMs: Date.now(), actor: w.emails.finance });

export { verifyIbanRow, SUPPLIER_IBAN };
