/**
 * The gate's own check that a payment WRITE says what the stored request says (F9a, N7). Like
 * `gate-flag.ts` it imports nothing but core and the revolut package, and reads D1 itself: the gate
 * trusts no caller, so a body that disagrees with the stored request (another account, another
 * amount, another currency, another payee, a request that is not being submitted) is refused here,
 * before any network call, whoever built it.
 *
 *   POST /pay             the single payment `ref` (request_id), not a batch item
 *   POST /payment-drafts  the single payment or the batch `ref`; one body entry per stored item
 *
 * What is compared: the source account (Revolut uuid of OUR account), the currency, the amount (as the
 * number Revolut reads), and the receiving payee (counterparty id and account id) which must be the one
 * cached for the verified IBAN fingerprint. The reference text is not compared (it is sanitised on the
 * way out). The counterparty create is not checked here: it moves no money.
 */
import { revolutAmount, type RevolutRequest } from "@camelthorn/revolut";
import { isDirectPayment, isDraftWrite } from "../revolut/request";

interface StoredLeg {
  amount_minor: number;
  currency: string;
  external_id: string;
  cp: string | null;
  racc: string | null;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function signature(
  account: unknown,
  currency: unknown,
  amount: unknown,
  receiver: unknown,
): string | null {
  const r = asObject(receiver);
  if (typeof account !== "string" || typeof currency !== "string" || typeof amount !== "number") {
    return null;
  }
  if (r === null || typeof r["counterparty_id"] !== "string") return null;
  const racc = r["account_id"];
  if (racc !== undefined && typeof racc !== "string") return null;
  return [
    account.toLowerCase(),
    currency,
    amount,
    r["counterparty_id"].toLowerCase(),
    typeof racc === "string" ? racc.toLowerCase() : "-",
  ].join("|");
}

function storedSignature(l: StoredLeg): string | null {
  if (l.cp === null) return null;
  try {
    return [
      l.external_id.toLowerCase(),
      l.currency,
      Number(revolutAmount(l.amount_minor, l.currency)),
      l.cp.toLowerCase(),
      l.racc === null ? "-" : l.racc.toLowerCase(),
    ].join("|");
  } catch {
    return null;
  }
}

/** Null when the body matches the stored request; otherwise a stable refusal code. Sends nothing. */
export async function paymentBodyMismatch(
  db: D1Database,
  req: RevolutRequest,
): Promise<string | null> {
  const direct = isDirectPayment(req);
  if (!direct && !isDraftWrite(req)) return null;
  const ref = req.paymentRef ?? "";
  let body: Record<string, unknown> | null;
  try {
    body = asObject(JSON.parse(req.body ?? ""));
  } catch {
    return "payment_body_unreadable";
  }
  if (body === null) return "payment_body_unreadable";

  const select = `SELECT p.amount_minor, p.currency, a.external_id, pe.revolut_counterparty_id AS cp,
                         pe.revolut_account_id AS racc
                    FROM payments p JOIN bank_accounts a ON a.id = p.bank_account_id
                    LEFT JOIN payment_payees pe ON pe.connection_id = a.connection_id
                         AND pe.iban_fingerprint = p.iban_fingerprint AND pe.revoked_at IS NULL`;
  const legs = direct
    ? await db
        .prepare(
          `${select} WHERE p.request_id = ?1 AND p.batch_id IS NULL AND p.status = 'submitting'`,
        )
        .bind(ref)
        .all<StoredLeg>()
    : await db
        .prepare(
          `${select} WHERE p.status = 'submitting' AND (
               (p.request_id = ?1 AND p.batch_id IS NULL)
               OR p.batch_id = (SELECT id FROM payment_batches WHERE request_id = ?1 AND status = 'submitting'))`,
        )
        .bind(ref)
        .all<StoredLeg>();
  if (legs.results.length === 0) return "payment_unknown_request";

  const want = legs.results.map(storedSignature);
  if (want.some((w) => w === null)) return "payment_payee_unknown";

  let got: (string | null)[];
  if (direct) {
    got = [signature(body["account_id"], body["currency"], body["amount"], body["receiver"])];
  } else {
    const payments = body["payments"];
    if (!Array.isArray(payments)) return "payment_body_mismatch";
    got = payments.map((x) => {
      const o = asObject(x);
      return o === null
        ? null
        : signature(o["account_id"], o["currency"], o["amount"], o["receiver"]);
    });
  }
  if (got.some((g) => g === null) || got.length !== want.length) return "payment_body_mismatch";
  const a = (want as string[]).slice().sort();
  const b = (got as string[]).slice().sort();
  return a.every((x, i) => x === b[i]) ? null : "payment_body_mismatch";
}
