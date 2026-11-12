/**
 * Does a Revolut transaction found by request_id really BE this payment? (P9b, ADR 0050.) A lookup
 * by request_id is only trusted when the transaction also has our amount, currency and source
 * account: a mismatch is never adopted, it is reported to a person. Pure.
 */
import type { RevolutTransaction } from "@camelthorn/revolut";

export interface ExpectedPayment {
  requestId: string;
  amountMinor: number;
  currency: string;
  /** The Revolut account id (uuid) the money leaves. */
  sourceExternalId: string;
}

export function transactionMatchesPayment(tx: RevolutTransaction, p: ExpectedPayment): boolean {
  if (tx.requestId !== undefined && tx.requestId !== p.requestId) return false;
  const source = p.sourceExternalId.toLowerCase();
  return tx.legs.some(
    (l) =>
      l.accountId !== undefined &&
      l.accountId.toLowerCase() === source &&
      l.currency === p.currency &&
      l.amountMinor === -p.amountMinor,
  );
}
