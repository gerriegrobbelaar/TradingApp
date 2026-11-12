/**
 * Version of the payment rules (ADR 0049), like BOOKING_PROTOCOL_VERSION for Exact booking: a
 * SHA-256 over the outputs of the rule code on fixed samples. A verification mark records the
 * version it was done under; any change in a rule, a code list, a default or the payload layout
 * changes the version and voids the mark, which switches payments OFF until it is verified again.
 * P9b adds the Revolut request builder's output to the samples.
 */
import { sha256Hex } from "../sha256";
import { requiredApprovals } from "./four-eyes";
import { assessIban, ibanFingerprint } from "./iban-state";
import { paymentPayloadHash } from "./payload";
import { precheckPayment } from "./precheck";
import { buildPaymentReference, sanitizeSepaText } from "./text";
import {
  APPROVAL_REASONS,
  DEFAULT_PAYMENT_SETTINGS,
  PAYMENT_BLOCK_CODES,
  PAYMENT_TRANSITIONS,
  PAYMENT_VALIDITY_MS,
  PAYMENT_STEP_UP_MS,
} from "./types";
import { PAYMENTS_VERIFY_CHECKS } from "./settings";

export function paymentsProtocolVersion(): string {
  const iban = "NL91ABNA0417164300";
  const fp = ibanFingerprint(iban) ?? "";
  const rid = "11111111-1111-4111-8111-111111111111";
  const sampleHash = paymentPayloadHash({
    kind: "payment",
    mode: "drafts",
    sourceAccountId: 1,
    currency: "EUR",
    totalMinor: 12_345,
    items: [
      {
        requestId: rid,
        openItemId: 1,
        amountMinor: 12_345,
        currency: "EUR",
        ibanFingerprint: fp,
        reference: "Invoice 1",
      },
    ],
  });
  const pre = precheckPayment({
    nowMs: 0,
    paymentsEnabled: true,
    settings: { ...DEFAULT_PAYMENT_SETTINGS, allowedCurrencies: ["EUR"] },
    requesterEmail: "a@x.nl",
    item: {
      kind: "bill",
      closed: false,
      openMinor: 300_000,
      currency: "EUR",
      invoiceNumber: "Ünï/1",
      invoiceIban: null,
    },
    approval: "approved",
    supplier: { found: true, isSupplier: true },
    iban: {
      recordIban: iban,
      verification: { fingerprint: fp, verifiedBy: "b@x.nl", revoked: false },
      paidBefore: false,
    },
    ibanReadAtMs: 0,
    conflicts: { openRequest: false, openBatch: false, paidSinceSync: false },
    source: {
      found: true,
      active: true,
      currency: "EUR",
      balanceMinor: 10,
      balanceAtMs: 0,
      reservedMinor: 0,
    },
    dailyTotalEurMinor: 0,
    rates: null,
  });
  const reasons = requiredApprovals({
    settings: DEFAULT_PAYMENT_SETTINGS,
    items: [{ eur: { minor: 250_001, rate: "1", currency: "EUR" }, iban: "verified_new" }],
    totalEur: { minor: 250_001, rate: "1", currency: "EUR" },
    isBatch: false,
  });
  return sha256Hex(
    JSON.stringify([
      "payments-protocol-v1",
      PAYMENT_TRANSITIONS,
      PAYMENT_BLOCK_CODES,
      APPROVAL_REASONS,
      DEFAULT_PAYMENT_SETTINGS,
      PAYMENT_VALIDITY_MS,
      PAYMENT_STEP_UP_MS,
      PAYMENTS_VERIFY_CHECKS,
      sampleHash,
      pre,
      reasons,
      assessIban({ recordIban: iban, verification: null, paidBefore: false }, "a@x.nl"),
      buildPaymentReference("A".repeat(200)),
      sanitizeSepaText("Zoë /​// 日本"),
    ]),
  );
}
