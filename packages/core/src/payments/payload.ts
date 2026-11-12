/**
 * The payload an approval is bound to (CLAUDE.md 4.4, ADR 0049). The hash covers everything that
 * decides where how much money goes: per item the request id, the invoice, amount, currency, IBAN
 * fingerprint and reference; and the source account, the payment mode and the total. Any change
 * yields another hash, so an approval for the old payload cannot be used for the new one.
 */
import { sha256Hex } from "../sha256";
import { isUuidV4 } from "./text";
import { PAYMENT_MAX_MINOR, type PaymentMode } from "./types";

export interface PayloadItem {
  requestId: string;
  openItemId: number;
  amountMinor: number;
  currency: string;
  ibanFingerprint: string;
  reference: string;
}

export interface PaymentPayload {
  kind: "payment" | "batch";
  mode: PaymentMode;
  sourceAccountId: number;
  currency: string;
  totalMinor: number;
  items: readonly PayloadItem[];
}

const HEX64 = /^[0-9a-f]{64}$/;

export class PayloadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function assertPayload(p: PaymentPayload): void {
  if (p.kind !== "payment" && p.kind !== "batch") throw new PayloadError("bad_kind");
  if (p.mode !== "drafts" && p.mode !== "pay") throw new PayloadError("bad_mode");
  if (!Number.isSafeInteger(p.sourceAccountId) || p.sourceAccountId < 1) {
    throw new PayloadError("bad_source_account");
  }
  if (!/^[A-Z]{3}$/.test(p.currency)) throw new PayloadError("bad_currency");
  if (p.items.length < 1) throw new PayloadError("no_items");
  if (p.kind === "payment" && p.items.length !== 1) throw new PayloadError("payment_has_one_item");
  let sum = 0n;
  const ids = new Set<string>();
  for (const i of p.items) {
    if (!isUuidV4(i.requestId)) throw new PayloadError("bad_request_id");
    if (ids.has(i.requestId)) throw new PayloadError("duplicate_request_id");
    ids.add(i.requestId);
    if (!Number.isSafeInteger(i.openItemId) || i.openItemId < 1) throw new PayloadError("bad_item");
    if (
      !Number.isSafeInteger(i.amountMinor) ||
      i.amountMinor < 1 ||
      i.amountMinor > PAYMENT_MAX_MINOR
    ) {
      throw new PayloadError("bad_amount");
    }
    if (i.currency !== p.currency) throw new PayloadError("mixed_currency");
    if (!HEX64.test(i.ibanFingerprint)) throw new PayloadError("bad_fingerprint");
    if (typeof i.reference !== "string" || i.reference.length === 0) {
      throw new PayloadError("bad_reference");
    }
    sum += BigInt(i.amountMinor);
  }
  if (sum > BigInt(PAYMENT_MAX_MINOR) || sum !== BigInt(p.totalMinor)) {
    throw new PayloadError("bad_total");
  }
}

/**
 * Hex SHA-256 over a JSON array in a fixed order (JSON string escaping makes the encoding
 * unambiguous; amounts are decimal strings). Items are sorted by request id, so the order in
 * which a batch was built does not matter. Throws `PayloadError` for anything malformed.
 */
export function paymentPayloadHash(p: PaymentPayload): string {
  assertPayload(p);
  const items = [...p.items]
    .sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0))
    .map((i) => [
      i.requestId,
      i.openItemId,
      String(i.amountMinor),
      i.currency,
      i.ibanFingerprint,
      i.reference,
    ]);
  return sha256Hex(
    JSON.stringify([
      "payment-payload-v1",
      p.kind,
      p.mode,
      p.sourceAccountId,
      p.currency,
      String(p.totalMinor),
      items,
    ]),
  );
}
