/**
 * The payee cache (Phase 9, P9b, ADR 0050): one Revolut counterparty per (connection, supplier IBAN
 * fingerprint), created once and reused. Holds Revolut ids and the name only; the IBAN is never
 * stored here (it stays in `payments`, read through iban-store.ts). Rows are append-only apart from
 * `revoked_at` (migration 0029).
 */
import { auditStatement } from "../db/audit";
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

/**
 * Stores the payee; a parallel insert for the same IBAN is ignored (the first one wins). The cache row
 * and its audit row (`payee.created` for a counterparty this app made, `payee.adopted` for one it found
 * at Revolut) are ONE batch, so a payee cannot exist in the cache without the trace of how it got
 * there (F9a, S12). The audit row names the request, the Revolut ids and a short fingerprint prefix;
 * never the IBAN. `keyId` is the non-secret id of the fingerprint key (S5).
 */
export async function recordPayee(
  db: D1Database,
  connectionId: number,
  t: Pick<SendTarget, "ibanFingerprint" | "beneficiaryName">,
  payee: Payee,
  createdFor: string,
  via: "created" | "adopted",
  keyId: string | null,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id,
                                     revolut_account_id, name, created_for, key_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (connection_id, iban_fingerprint) DO NOTHING`,
      )
      .bind(
        connectionId,
        t.ibanFingerprint,
        payee.counterpartyId,
        payee.accountId,
        t.beneficiaryName.slice(0, 140) || "payee",
        createdFor,
        keyId,
      ),
    auditStatement(
      db,
      {
        actorEmail: "system",
        action: `payee.${via}`,
        entity: "payment_payee",
        entityId: `${connectionId}:${t.ibanFingerprint.slice(0, 16)}`,
        after: {
          requestId: createdFor,
          counterpartyId: payee.counterpartyId,
          accountId: payee.accountId,
          ibanFingerprint: t.ibanFingerprint.slice(0, 16),
          keyId,
        },
      },
      { sql: "changes() = 1", binds: [] },
    ),
  ]);
}

/**
 * Payees of this connection made under ANOTHER fingerprint key (or none recorded): after a rotation
 * of PAYMENTS_IBAN_KEY the cache cannot find them any more, so a new payee must be looked for at
 * Revolut before one is created (F9a, S5).
 */
export async function hasPayeesFromOtherKey(
  db: D1Database,
  connectionId: number,
  keyId: string | null,
): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT 1 AS n FROM payment_payees
        WHERE connection_id = ?1 AND revoked_at IS NULL AND (key_id IS NULL OR key_id IS NOT ?2) LIMIT 1`,
    )
    .bind(connectionId, keyId)
    .first();
  return r !== null;
}
