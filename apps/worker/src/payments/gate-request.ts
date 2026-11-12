/**
 * The gate's own check that a payment WRITE says what the stored request says (F9a, N7). Like
 * `gate-flag.ts` it imports nothing but core and the revolut package, and reads D1 itself: the gate
 * trusts no caller, so a body that disagrees with the stored request (another account, another
 * amount, another currency, another payee, another reference, a request that is not being submitted,
 * a request of another Revolut connection) is refused here, before any network call, whoever built it.
 *
 *   POST /pay             the single payment `ref` (request_id), not a batch item
 *   POST /payment-drafts  the single payment or the batch `ref`; one body entry per stored item
 *
 * How (review F9a): the gate REBUILDS the exact bytes with the same request builders the client uses
 * (`buildPay` / `buildPaymentDraft` of packages/revolut), from the stored rows (ordered by id, as
 * `readSendTargets` orders them) and the payee cached for the verified IBAN fingerprint, and demands
 * byte equality with the body it was handed. So no number is ever parsed as a float or compared as
 * one (the amount token is compared as text), a duplicated JSON key, a reordered or extra field, a
 * different number spelling ("12.3" vs "12.30", "1.23e1") and a changed reference are all refused.
 * The counterparty create is not checked here: it moves no money.
 *
 * Any failure to read (D1 error) throws: the caller (the gate) then refuses the write (fail closed).
 * The refusal codes name no data of the request.
 */
import {
  buildPay,
  buildPaymentDraft,
  type PaymentLeg,
  type RevolutRequest,
} from "@camelthorn/revolut";
import { isDirectPayment, isDraftWrite } from "../revolut/request";

interface StoredLeg {
  request_id: string;
  amount_minor: number;
  currency: string;
  reference: string;
  external_id: string;
  cp: string | null;
  racc: string | null;
}

/** Null when the body matches the stored request byte for byte; otherwise a stable refusal code. Sends nothing. */
export async function paymentBodyMismatch(
  db: D1Database,
  req: RevolutRequest,
): Promise<string | null> {
  const direct = isDirectPayment(req);
  if (!direct && !isDraftWrite(req)) return null;
  const ref = req.paymentRef ?? "";
  if (typeof req.body !== "string") return "payment_body_unreadable";
  try {
    const parsed: unknown = JSON.parse(req.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "payment_body_unreadable";
    }
  } catch {
    return "payment_body_unreadable";
  }
  if (ref === "") return "payment_unknown_request";

  // ?1 the ref, ?2 the gate's connection: a request whose source account belongs to another Revolut
  // connection is never sent through this gate.
  const select = `SELECT p.request_id, p.amount_minor, p.currency, p.reference, a.external_id,
                         pe.revolut_counterparty_id AS cp, pe.revolut_account_id AS racc
                    FROM payments p JOIN bank_accounts a ON a.id = p.bank_account_id AND a.connection_id = ?2
                    LEFT JOIN payment_payees pe ON pe.connection_id = a.connection_id
                         AND pe.iban_fingerprint = p.iban_fingerprint AND pe.revoked_at IS NULL`;
  const legs = direct
    ? await db
        .prepare(
          `${select} WHERE p.request_id = ?1 AND p.batch_id IS NULL AND p.status = 'submitting'
            ORDER BY p.id`,
        )
        .bind(ref, req.connectionId)
        .all<StoredLeg>()
    : await db
        .prepare(
          `${select} WHERE p.status = 'submitting' AND (
               (p.request_id = ?1 AND p.batch_id IS NULL)
               OR p.batch_id = (SELECT id FROM payment_batches WHERE request_id = ?1 AND status = 'submitting'))
            ORDER BY p.id`,
        )
        .bind(ref, req.connectionId)
        .all<StoredLeg>();
  const rows = legs.results;
  if (rows.length === 0) return "payment_unknown_request";
  if (direct && rows.length !== 1) return "payment_unknown_request";
  if (rows.some((r) => r.cp === null)) return "payment_payee_unknown";

  const leg = (r: StoredLeg): PaymentLeg => ({
    accountId: r.external_id,
    counterpartyId: r.cp as string,
    ...(r.racc !== null ? { receiverAccountId: r.racc } : {}),
    amountMinor: r.amount_minor,
    currency: r.currency,
    reference: r.reference,
  });
  let expected: string;
  try {
    expected = direct
      ? buildPay({ ...leg(rows[0] as StoredLeg), requestId: ref }).body
      : buildPaymentDraft({ requestId: ref, payments: rows.map(leg) }).body;
  } catch {
    // The stored request cannot be built (a currency the builders refuse, a malformed id): nothing
    // the caller sends can be the stored request.
    return "payment_body_mismatch";
  }
  return req.body === expected ? null : "payment_body_mismatch";
}
