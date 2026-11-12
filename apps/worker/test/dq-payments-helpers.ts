/**
 * Raw payment rows for the F9b tests (payment DQ rules and the Today payment items, ADR 0053).
 * The state machine's insert trigger is lifted for the insert only, so a row can be put straight
 * into any status with any timestamps; nothing else of the schema is bypassed.
 */
import { SUPPLIER_IBAN, db, withoutPaymentTriggers, type PayWorld } from "./payments-helpers";

let seq = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const iso = (ms: number): string => new Date(ms).toISOString();

export interface RawPayment {
  status?: string;
  mode?: "drafts" | "pay";
  amountMinor?: number;
  createdAt?: string;
  updatedAt?: string | null;
  expiresAt?: string;
  requestedBy?: string;
  itemId?: number;
  batchId?: number | null;
  divisionId?: number;
  currency?: string;
}

/** Inserts one payment row; every in-flight status needs its own open item (unique index). */
export async function rawPayment(w: PayWorld, o: RawPayment = {}): Promise<number> {
  const created = o.createdAt ?? iso(w.nowMs);
  const r = await withoutPaymentTriggers(
    ["payments_guard_insert", ...(o.batchId ? ["payments_guard_batch_item"] : [])],
    () =>
      db
        .prepare(
          `INSERT INTO payments (request_id, division_id, open_item_id, batch_id, bank_account_id, status, mode,
             amount_minor, currency, beneficiary_name, beneficiary_iban, iban_fingerprint, reference, payload_hash,
             requested_by, expires_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'Acme Supplies B.V.', ?10, ?11, 'Invoice 1', ?12, ?13, ?14, ?15, ?16)`,
        )
        .bind(
          uuid(),
          o.divisionId ?? w.divisionId,
          o.itemId ?? w.itemId,
          o.batchId ?? null,
          w.accountId,
          o.status ?? "pending_approval",
          o.mode ?? "drafts",
          o.amountMinor ?? 125_000,
          o.currency ?? "EUR",
          SUPPLIER_IBAN,
          "c".repeat(64),
          "d".repeat(64),
          o.requestedBy ?? w.emails.finance,
          o.expiresAt ?? iso(Date.parse(created) + 24 * 3_600_000),
          created,
          o.updatedAt === undefined ? created : o.updatedAt,
        )
        .run(),
  );
  return r.meta.last_row_id;
}

export async function rawBatch(
  w: PayWorld,
  o: RawPayment & { itemCount?: number } = {},
): Promise<number> {
  const created = o.createdAt ?? iso(w.nowMs);
  const r = await withoutPaymentTriggers(["payment_batches_guard_insert"], () =>
    db
      .prepare(
        `INSERT INTO payment_batches (request_id, division_id, bank_account_id, status, mode, currency, total_minor,
           item_count, payload_hash, requested_by, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(
        uuid(),
        o.divisionId ?? w.divisionId,
        w.accountId,
        o.status ?? "pending_approval",
        o.mode ?? "drafts",
        o.currency ?? "EUR",
        o.amountMinor ?? 250_000,
        o.itemCount ?? 2,
        "e".repeat(64),
        o.requestedBy ?? w.emails.finance,
        o.expiresAt ?? iso(Date.parse(created) + 24 * 3_600_000),
        created,
        o.updatedAt === undefined ? created : o.updatedAt,
      )
      .run(),
  );
  return r.meta.last_row_id;
}

/** A state-change event (append-only table): when a request entered `toStatus`. */
export async function addEvent(
  subject: { payment?: number; batch?: number },
  toStatus: string,
  at: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO payment_events (payment_id, batch_id, to_status, actor, at) VALUES (?1, ?2, ?3, 'test', ?4)",
    )
    .bind(subject.payment ?? null, subject.batch ?? null, toStatus, at)
    .run();
}

export async function addReconcile(
  kind: "payment" | "batch",
  id: number,
  lastResult: string,
  alertAt: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payment_reconcile (subject_kind, subject_id, first_checked_at, last_checked_at, last_result, alert_at)
       VALUES (?1, ?2, '2026-07-15T09:00:00.000Z', '2026-07-15T09:30:00.000Z', ?3, ?4)`,
    )
    .bind(kind, id, lastResult, alertAt)
    .run();
}
