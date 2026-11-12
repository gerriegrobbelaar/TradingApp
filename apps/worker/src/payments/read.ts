/**
 * Reading payment requests for the API (Phase 9, P9a). Every column is named; no star form is used.
 * IBANs leave only as `ibanMasked` and a short fingerprint (never the full IBAN, ADR 0049).
 */
import {
  batchConfirmPhrase,
  isPaymentStatus,
  paymentConfirmPhrase,
  type ApprovalReason,
  type BatchDto,
  type DecisionDto,
  type PaymentDto,
  type PaymentEventDto,
  type PaymentMode,
  type PaymentSettlement,
  type PaymentStatus,
} from "@camelthorn/core";
import { maskedIbans } from "./iban-store";
import { paymentSettlements } from "./reconcile";

// The DTO types live in core (api-types.ts) so the web shares them; re-exported for the worker's own imports.
export type { BatchDto, DecisionDto, PaymentDto } from "@camelthorn/core";

const PAYMENT_SELECT = `SELECT p.id, p.request_id, p.batch_id, p.status, p.status_reason, p.mode, p.open_item_id,
    p.amount_minor, p.currency, p.eur_minor, p.eur_rate, p.beneficiary_name, p.iban_fingerprint, p.reference,
    p.bank_account_id, p.payload_hash, p.approvals_required, p.requested_by, p.confirmed_at, p.expires_at,
    p.created_at, p.updated_at, p.provider_id, oi.invoice_number, oi.due_date, ba.name AS account_name,
    ap.decision, ap.decided_by, ap.decided_at, ap.note
  FROM payments p
    LEFT JOIN open_items oi ON oi.id = p.open_item_id
    LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
    LEFT JOIN payment_approvals ap ON ap.payment_id = p.id`;

interface PaymentRowRaw {
  id: number;
  request_id: string;
  batch_id: number | null;
  status: string;
  status_reason: string | null;
  mode: PaymentMode;
  open_item_id: number;
  amount_minor: number;
  currency: string;
  eur_minor: number | null;
  eur_rate: string | null;
  beneficiary_name: string;
  iban_fingerprint: string;
  reference: string;
  bank_account_id: number;
  payload_hash: string;
  approvals_required: string;
  requested_by: string;
  confirmed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string | null;
  provider_id: string | null;
  invoice_number: string | null;
  due_date: string | null;
  account_name: string | null;
  decision: "approved" | "rejected" | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
}

const reasons = (raw: string): ApprovalReason[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as ApprovalReason[]) : [];
  } catch {
    return [];
  }
};

const status = (s: string): PaymentStatus => {
  if (!isPaymentStatus(s)) throw new Error("unknown payment status in the database");
  return s;
};

function toDecision(r: {
  decision: "approved" | "rejected" | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
}): DecisionDto | null {
  return r.decision === null || r.decided_by === null || r.decided_at === null
    ? null
    : { decision: r.decision, by: r.decided_by, at: r.decided_at, note: r.note };
}

function toPaymentDto(
  r: PaymentRowRaw,
  masked: Map<number, string>,
  settlement: PaymentSettlement,
): PaymentDto {
  const st = status(r.status);
  return {
    kind: "payment",
    id: r.id,
    requestId: r.request_id,
    batchId: r.batch_id,
    status: st,
    statusReason: r.status_reason,
    mode: r.mode,
    openItemId: r.open_item_id,
    invoiceNumber: r.invoice_number,
    dueDate: r.due_date,
    supplierName: r.beneficiary_name,
    ibanMasked: masked.get(r.id) ?? "****",
    ibanFingerprintShort: r.iban_fingerprint.slice(0, 16),
    amountMinor: r.amount_minor,
    currency: r.currency,
    eurMinor: r.eur_minor,
    eurRate: r.eur_rate,
    reference: r.reference,
    sourceAccountId: r.bank_account_id,
    sourceAccountName: r.account_name ?? "",
    approvalsRequired: reasons(r.approvals_required),
    payloadHash: r.payload_hash,
    requestedBy: r.requested_by,
    confirmedAt: r.confirmed_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    providerId: r.provider_id,
    confirmPhrase:
      st === "draft" && r.batch_id === null
        ? paymentConfirmPhrase(r.amount_minor, r.currency, (masked.get(r.id) ?? "????").slice(-4))
        : null,
    decision: toDecision(r),
    settlement,
  };
}

/**
 * How far each payment is booked (F9c, CLAUDE.md 4.3). Only a bank-paid payment has anything to
 * look up; every other status is `not_paid`, and when no row is paid no query is made. The paid
 * rows are looked up together in ONE query (a list page is not N+1). An unreadable answer is NOT
 * "booked": every paid row falls back to `awaiting_bank_line` ("paid at the bank, booking pending").
 * Read-only: no write on a GET.
 */
async function settlements(
  db: D1Database,
  rows: readonly PaymentRowRaw[],
): Promise<Map<number, PaymentSettlement>> {
  const out = new Map<number, PaymentSettlement>();
  const paid: number[] = [];
  for (const r of rows) {
    out.set(r.id, "not_paid");
    if (r.status === "paid") paid.push(r.id);
  }
  if (paid.length === 0) return out;
  try {
    const found = await paymentSettlements(db, paid);
    for (const id of paid) out.set(id, found.get(id) ?? "awaiting_bank_line");
  } catch {
    for (const id of paid) out.set(id, "awaiting_bank_line");
  }
  // A row that was `paid` when read but is no longer paid in the lookup is NOT booked either.
  for (const id of paid) if (out.get(id) === "not_paid") out.set(id, "awaiting_bank_line");
  return out;
}

export async function readPayments(db: D1Database, ids: readonly number[]): Promise<PaymentDto[]> {
  if (ids.length === 0) return [];
  const marks = ids.map((_, i) => `?${i + 1}`).join(", ");
  const rows = await db
    .prepare(`${PAYMENT_SELECT} WHERE p.id IN (${marks}) ORDER BY p.id DESC`)
    .bind(...ids)
    .all<PaymentRowRaw>();
  const masked = await maskedIbans(db, ids);
  const settled = await settlements(db, rows.results);
  return rows.results.map((r) => toPaymentDto(r, masked, settled.get(r.id) ?? "not_paid"));
}

export async function readPayment(db: D1Database, id: number): Promise<PaymentDto | null> {
  return (await readPayments(db, [id]))[0] ?? null;
}

interface BatchRowRaw {
  id: number;
  request_id: string;
  status: string;
  status_reason: string | null;
  mode: PaymentMode;
  currency: string;
  total_minor: number;
  item_count: number;
  eur_minor: number | null;
  bank_account_id: number;
  payload_hash: string;
  approvals_required: string;
  requested_by: string;
  confirmed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string | null;
  provider_id: string | null;
  account_name: string | null;
  decision: "approved" | "rejected" | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
}

const BATCH_SELECT = `SELECT b.id, b.request_id, b.status, b.status_reason, b.mode, b.currency, b.total_minor,
    b.item_count, b.eur_minor, b.bank_account_id, b.payload_hash, b.approvals_required, b.requested_by,
    b.confirmed_at, b.expires_at, b.created_at, b.updated_at, b.provider_id, ba.name AS account_name,
    ap.decision, ap.decided_by, ap.decided_at, ap.note
  FROM payment_batches b
    LEFT JOIN bank_accounts ba ON ba.id = b.bank_account_id
    LEFT JOIN payment_approvals ap ON ap.batch_id = b.id`;

export async function readBatch(db: D1Database, id: number): Promise<BatchDto | null> {
  const r = await db.prepare(`${BATCH_SELECT} WHERE b.id = ?1`).bind(id).first<BatchRowRaw>();
  if (r === null) return null;
  const itemIds = (
    await db
      .prepare("SELECT id FROM payments WHERE batch_id = ?1 ORDER BY id")
      .bind(id)
      .all<{ id: number }>()
  ).results.map((x) => x.id);
  const st = status(r.status);
  return {
    kind: "batch",
    id: r.id,
    requestId: r.request_id,
    status: st,
    statusReason: r.status_reason,
    mode: r.mode,
    currency: r.currency,
    totalMinor: r.total_minor,
    itemCount: r.item_count,
    eurMinor: r.eur_minor,
    sourceAccountId: r.bank_account_id,
    sourceAccountName: r.account_name ?? "",
    approvalsRequired: reasons(r.approvals_required),
    payloadHash: r.payload_hash,
    requestedBy: r.requested_by,
    confirmedAt: r.confirmed_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    providerId: r.provider_id,
    confirmPhrase:
      st === "draft" ? batchConfirmPhrase(r.item_count, r.total_minor, r.currency) : null,
    decision: toDecision(r),
    items: (await readPayments(db, itemIds)).reverse(),
  };
}

export interface ListFilter {
  status: PaymentStatus | "open" | "all";
  requestedBy: string | null;
  limit: number;
  cursorId: number | null;
}

const OPEN = "('draft', 'pending_approval', 'ready', 'submitting', 'submitted', 'outcome_unknown')";

/** Standalone requests, newest first. Batch items are listed inside their batch. */
export async function listPayments(
  db: D1Database,
  f: ListFilter,
): Promise<{ items: PaymentDto[]; nextCursor: number | null }> {
  const where: string[] = ["p.batch_id IS NULL"];
  const binds: (string | number)[] = [];
  if (f.status === "open") where.push(`p.status IN ${OPEN}`);
  else if (f.status !== "all") {
    binds.push(f.status);
    where.push(`p.status = ?${binds.length}`);
  }
  if (f.requestedBy !== null) {
    binds.push(f.requestedBy);
    where.push(`p.requested_by = ?${binds.length}`);
  }
  if (f.cursorId !== null) {
    binds.push(f.cursorId);
    where.push(`p.id < ?${binds.length}`);
  }
  binds.push(f.limit + 1);
  const ids = (
    await db
      .prepare(
        `SELECT p.id FROM payments p WHERE ${where.join(" AND ")} ORDER BY p.id DESC LIMIT ?${binds.length}`,
      )
      .bind(...binds)
      .all<{ id: number }>()
  ).results.map((r) => r.id);
  const page = ids.slice(0, f.limit);
  return {
    items: await readPayments(db, page),
    nextCursor: ids.length > f.limit ? (page[page.length - 1] ?? null) : null,
  };
}

export async function listBatches(
  db: D1Database,
  f: ListFilter,
): Promise<{ items: BatchDto[]; nextCursor: number | null }> {
  const where: string[] = ["1 = 1"];
  const binds: (string | number)[] = [];
  if (f.status === "open") where.push(`b.status IN ${OPEN}`);
  else if (f.status !== "all") {
    binds.push(f.status);
    where.push(`b.status = ?${binds.length}`);
  }
  if (f.requestedBy !== null) {
    binds.push(f.requestedBy);
    where.push(`b.requested_by = ?${binds.length}`);
  }
  if (f.cursorId !== null) {
    binds.push(f.cursorId);
    where.push(`b.id < ?${binds.length}`);
  }
  binds.push(f.limit + 1);
  const ids = (
    await db
      .prepare(
        `SELECT b.id FROM payment_batches b WHERE ${where.join(" AND ")} ORDER BY b.id DESC LIMIT ?${binds.length}`,
      )
      .bind(...binds)
      .all<{ id: number }>()
  ).results.map((r) => r.id);
  const page = ids.slice(0, f.limit);
  const items: BatchDto[] = [];
  for (const id of page) {
    const b = await readBatch(db, id);
    if (b !== null) items.push(b);
  }
  return { items, nextCursor: ids.length > f.limit ? (page[page.length - 1] ?? null) : null };
}

/**
 * The status history of one request, oldest first (payment_events is append-only). Read-only
 * addition of P9c for the detail screen; carries no request data, only states, a stable code and
 * the actor's email (the same facts the audit log holds).
 */
export async function readEvents(
  db: D1Database,
  kind: "payment" | "batch",
  id: number,
): Promise<PaymentEventDto[]> {
  const col = kind === "payment" ? "payment_id" : "batch_id";
  const rows = await db
    .prepare(
      `SELECT from_status, to_status, code, actor, at FROM payment_events WHERE ${col} = ?1 ORDER BY id`,
    )
    .bind(id)
    .all<{
      from_status: string | null;
      to_status: string;
      code: string | null;
      actor: string;
      at: string;
    }>();
  return rows.results.map((r) => ({
    fromStatus: r.from_status === null ? null : status(r.from_status),
    toStatus: status(r.to_status),
    code: r.code,
    actor: r.actor,
    at: r.at,
  }));
}
