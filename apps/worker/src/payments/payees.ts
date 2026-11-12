/**
 * The payee cache (Phase 9, P9b, ADR 0050): one Revolut counterparty per (connection, supplier IBAN
 * fingerprint), created once and reused. Holds Revolut ids and the name only; the IBAN is never
 * stored here (it stays in `payments`, read through iban-store.ts). Rows are append-only apart from
 * `revoked_at` (migration 0029).
 */
import type { SendTarget } from "./iban-store";

export interface Payee {
  counterpartyId: string;
  /** The payee's own account id, when Revolut gave one. */
  accountId: string | null;
}

export async function findPayee(
  db: D1Database,
  connectionId: number,
  ibanFingerprint: string,
): Promise<Payee | null> {
  const r = await db
    .prepare(
      `SELECT revolut_counterparty_id, revolut_account_id FROM payment_payees
        WHERE connection_id = ?1 AND iban_fingerprint = ?2 AND revoked_at IS NULL`,
    )
    .bind(connectionId, ibanFingerprint)
    .first<{ revolut_counterparty_id: string; revolut_account_id: string | null }>();
  return r === null
    ? null
    : { counterpartyId: r.revolut_counterparty_id, accountId: r.revolut_account_id };
}

/** Stores the payee; a parallel insert for the same IBAN is ignored (the first one wins). */
export async function recordPayee(
  db: D1Database,
  connectionId: number,
  t: Pick<SendTarget, "ibanFingerprint" | "beneficiaryName">,
  payee: Payee,
  createdFor: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id,
                                   revolut_account_id, name, created_for)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (connection_id, iban_fingerprint) DO NOTHING`,
    )
    .bind(
      connectionId,
      t.ibanFingerprint,
      payee.counterpartyId,
      payee.accountId,
      t.beneficiaryName.slice(0, 140) || "payee",
      createdFor,
    )
    .run();
}
