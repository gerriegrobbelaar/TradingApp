/**
 * The ONLY payments module that reads or writes full IBANs (Phase 9, P9a, ADR 0049). Everything it
 * hands out is either in memory for one request (the supplier's IBAN, to fingerprint it) or masked.
 * The allow-list in test/iban-select-guard.test.ts names this file with that reason; the other files
 * of src/payments never name an IBAN column.
 *
 * P9b adds one reader here: the IBAN of a request that is about to be sent (claimed `submitting`).
 */
import { ibanFingerprint, ibanKeyId, maskIban } from "@camelthorn/core";

export interface SupplierRow {
  rowId: number;
  exactId: string;
  name: string;
  isSupplier: boolean;
  /** The IBAN Exact holds (in memory only, never returned). */
  iban: string | null;
  /** When a complete IBAN read last saw this IBAN on the supplier, epoch ms. */
  ibanReadAtMs: number | null;
}

export async function readSupplier(
  db: D1Database,
  divisionId: number,
  relationExactId: string,
): Promise<SupplierRow | null> {
  const r = await db
    .prepare(
      `SELECT r.id, r.exact_id, r.name, r.is_supplier, r.iban,
              (SELECT MAX(b.last_seen_at) FROM relation_bank_accounts b
                WHERE b.relation_id = r.id AND b.removed_at IS NULL AND b.iban = r.iban) AS seen
         FROM relations r WHERE r.division_id = ?1 AND r.exact_id = ?2`,
    )
    .bind(divisionId, relationExactId)
    .first<{
      id: number;
      exact_id: string;
      name: string;
      is_supplier: number;
      iban: string | null;
      seen: string | null;
    }>();
  if (r === null) return null;
  const seen = r.seen === null ? Number.NaN : Date.parse(r.seen);
  return {
    rowId: r.id,
    exactId: r.exact_id,
    name: r.name,
    isSupplier: r.is_supplier === 1,
    iban: r.iban,
    ibanReadAtMs: Number.isFinite(seen) ? seen : null,
  };
}

/** The supplier by row id (the IBAN verification endpoints). */
export async function readSupplierById(
  db: D1Database,
  relationRowId: number,
): Promise<(SupplierRow & { divisionId: number }) | null> {
  const r = await db
    .prepare("SELECT division_id, exact_id FROM relations WHERE id = ?1")
    .bind(relationRowId)
    .first<{ division_id: number; exact_id: string }>();
  if (r === null) return null;
  const s = await readSupplier(db, r.division_id, r.exact_id);
  return s === null ? null : { ...s, divisionId: r.division_id };
}

/** The IBAN stored with the invoice itself (a snapshot), in memory for the comparison only. */
export async function readInvoiceIban(db: D1Database, openItemId: number): Promise<string | null> {
  const r = await db
    .prepare("SELECT relation_iban FROM open_items WHERE id = ?1")
    .bind(openItemId)
    .first<{ relation_iban: string | null }>();
  return r?.relation_iban ?? null;
}

export interface SourceAccountRow {
  id: number;
  name: string;
  currency: string;
  active: boolean;
  balanceMinor: number | null;
  balanceAtMs: number | null;
  ibanMasked: string | null;
}

export async function readSourceAccount(
  db: D1Database,
  id: number,
): Promise<SourceAccountRow | null> {
  const r = await db
    .prepare(
      `SELECT a.id, a.name, a.iban, a.currency, a.is_active, a.state, a.balance_minor, a.balance_at
         FROM bank_accounts a JOIN connections c ON c.id = a.connection_id
        WHERE a.id = ?1 AND c.kind = 'revolut'`,
    )
    .bind(id)
    .first<{
      id: number;
      name: string;
      iban: string | null;
      currency: string;
      is_active: number;
      state: string | null;
      balance_minor: number | null;
      balance_at: string | null;
    }>();
  if (r === null) return null;
  const at = r.balance_at === null ? Number.NaN : Date.parse(r.balance_at);
  return {
    id: r.id,
    name: r.name,
    currency: r.currency,
    active: r.is_active === 1 && (r.state === null || r.state === "active"),
    balanceMinor: r.balance_minor,
    balanceAtMs: Number.isFinite(at) ? at : null,
    ibanMasked: r.iban === null ? null : maskIban(r.iban),
  };
}

export interface NewPaymentRow {
  requestId: string;
  divisionId: number;
  openItemId: number;
  batchRequestId: string | null;
  bankAccountId: number;
  mode: string;
  amountMinor: number;
  currency: string;
  eurMinor: number | null;
  eurRate: string | null;
  beneficiaryName: string;
  /** Full IBAN: stored for sending, never returned. */
  iban: string;
  ibanFingerprint: string;
  /** Non-secret id of the fingerprint key (S5); null when unknown. */
  keyId: string | null;
  reference: string;
  payloadHash: string;
  approvalsRequired: string;
  requestedBy: string;
  clientKey: string | null;
  expiresAt: string;
  createdAt: string;
}

/** The insert of one request. A batch item finds its batch by the batch's request id. */
export function insertPaymentStatement(db: D1Database, p: NewPaymentRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO payments (request_id, division_id, open_item_id, batch_id, bank_account_id, mode,
         amount_minor, currency, eur_minor, eur_rate, beneficiary_name, beneficiary_iban, iban_fingerprint,
         reference, payload_hash, approvals_required, requested_by, client_key, expires_at, created_at, key_id)
       VALUES (?1, ?2, ?3, (SELECT id FROM payment_batches WHERE request_id = ?4), ?5, ?6, ?7, ?8, ?9, ?10,
               ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
    )
    .bind(
      p.requestId,
      p.divisionId,
      p.openItemId,
      p.batchRequestId,
      p.bankAccountId,
      p.mode,
      p.amountMinor,
      p.currency,
      p.eurMinor,
      p.eurRate,
      p.beneficiaryName,
      p.iban,
      p.ibanFingerprint,
      p.reference,
      p.payloadHash,
      p.approvalsRequired,
      p.requestedBy,
      p.clientKey,
      p.expiresAt,
      p.createdAt,
      p.keyId,
    );
}

/** Masked IBANs (country, check digits and the last four) of the given requests. */
export async function maskedIbans(
  db: D1Database,
  ids: readonly number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const marks = ids.map((_, i) => `?${i + 1}`).join(", ");
  const rows = await db
    .prepare(`SELECT id, beneficiary_iban FROM payments WHERE id IN (${marks})`)
    .bind(...ids)
    .all<{ id: number; beneficiary_iban: string }>();
  for (const r of rows.results) out.set(r.id, maskIban(r.beneficiary_iban));
  return out;
}

/**
 * Before a request is handed to the submitter: does every stored IBAN (the one P9b will send to)
 * still have the fingerprint the payload, and so the approval, is bound to? A row whose IBAN and
 * fingerprint disagree (a bug, a hand edit before the triggers, a rotated key) is refused. Answers
 * true/false only; the IBAN never leaves this function.
 */
export async function storedIbansMatch(
  db: D1Database,
  kind: "payment" | "batch",
  id: number,
  key: string | null,
): Promise<boolean> {
  if (key === null) return false;
  const where = kind === "payment" ? "id = ?1" : "batch_id = ?1";
  const rows = await db
    .prepare(`SELECT beneficiary_iban, iban_fingerprint FROM payments WHERE ${where}`)
    .bind(id)
    .all<{ beneficiary_iban: string; iban_fingerprint: string }>();
  if (rows.results.length === 0) return false;
  return rows.results.every((r) => ibanFingerprint(r.beneficiary_iban, key) === r.iban_fingerprint);
}

/**
 * True when a stored request was made under ANOTHER fingerprint key than the one in force now (the
 * secret PAYMENTS_IBAN_KEY was rotated, F9a S5). Rows from before key ids carry none and never say yes.
 */
export async function storedKeyRotated(
  db: D1Database,
  kind: "payment" | "batch",
  id: number,
  key: string | null,
): Promise<boolean> {
  const now = ibanKeyId(key);
  if (now === null) return false;
  const where = kind === "payment" ? "id = ?1" : "batch_id = ?1";
  const r = await db
    .prepare(
      `SELECT 1 AS n FROM payments WHERE ${where} AND key_id IS NOT NULL AND key_id <> ?2 LIMIT 1`,
    )
    .bind(id, now)
    .first();
  return r !== null;
}

/** One payment as the submitter needs it: everything to name the payee and the account. */
export interface SendTarget {
  requestId: string;
  paymentId: number;
  amountMinor: number;
  currency: string;
  reference: string;
  /** The payee name stored with the request (from the verified supplier record). */
  beneficiaryName: string;
  /** Full IBAN: in memory for the one call that creates a payee, never returned or logged. */
  iban: string;
  ibanFingerprint: string;
  /** The Revolut account id (uuid) of the source account. */
  sourceExternalId: string;
  sourceConnectionId: number;
}

/**
 * The ONLY reader of the full IBAN for sending (P9b, ADR 0050). Reads the requests of a payment or
 * batch, re-computes each keyed fingerprint from the stored IBAN and returns null unless it equals
 * the fingerprint the payload and the approval are bound to (a request is never sent to an IBAN
 * other than the verified one). The IBAN comes from this table only, never from request input.
 */
export async function readSendTargets(
  db: D1Database,
  kind: "payment" | "batch",
  id: number,
  key: string | null,
): Promise<SendTarget[] | null> {
  if (key === null) return null;
  const where = kind === "payment" ? "p.id = ?1" : "p.batch_id = ?1";
  const rows = await db
    .prepare(
      `SELECT p.id, p.request_id, p.amount_minor, p.currency, p.reference, p.beneficiary_name,
              p.beneficiary_iban, p.iban_fingerprint, a.external_id, a.connection_id
         FROM payments p JOIN bank_accounts a ON a.id = p.bank_account_id
        WHERE ${where} ORDER BY p.id`,
    )
    .bind(id)
    .all<{
      id: number;
      request_id: string;
      amount_minor: number;
      currency: string;
      reference: string;
      beneficiary_name: string;
      beneficiary_iban: string;
      iban_fingerprint: string;
      external_id: string;
      connection_id: number;
    }>();
  if (rows.results.length === 0) return null;
  const out: SendTarget[] = [];
  for (const r of rows.results) {
    if (ibanFingerprint(r.beneficiary_iban, key) !== r.iban_fingerprint) return null;
    out.push({
      requestId: r.request_id,
      paymentId: r.id,
      amountMinor: r.amount_minor,
      currency: r.currency,
      reference: r.reference,
      beneficiaryName: r.beneficiary_name,
      iban: r.beneficiary_iban,
      ibanFingerprint: r.iban_fingerprint,
      sourceExternalId: r.external_id,
      sourceConnectionId: r.connection_id,
    });
  }
  return out;
}
