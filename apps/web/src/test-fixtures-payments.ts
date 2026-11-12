import {
  DEFAULT_PAYMENT_SETTINGS,
  PAYMENTS_VERIFY_CHECKS,
  batchConfirmPhrase,
  paymentConfirmPhrase,
  type BatchDto,
  type PaymentDto,
  type PaymentEventDto,
  type PaymentsSettingsResponse,
  type SupplierIbanStatusDto,
} from "@camelthorn/core";
import type { Me } from "./api";

export const FINANCE: Me = {
  email: "fin@camelthorncapital.com",
  roles: ["finance"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};
export const APPROVER: Me = {
  email: "appr@camelthorncapital.com",
  roles: ["approver"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};
export const FINANCE_STALE: Me = { ...FINANCE, stepUpFresh: false };

const HASH = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";

export function payment(over: Partial<PaymentDto> = {}): PaymentDto {
  const base: PaymentDto = {
    kind: "payment",
    id: 11,
    requestId: "5d0f2c0a-0000-4000-8000-000000000011",
    batchId: null,
    status: "draft",
    statusReason: null,
    mode: "drafts",
    openItemId: 1,
    invoiceNumber: "BILL-77",
    dueDate: "2026-11-30",
    supplierName: "Acme Supplies BV",
    ibanMasked: "NL91****4300",
    ibanFingerprintShort: "0123456789abcdef",
    amountMinor: 123456,
    currency: "EUR",
    eurMinor: 123456,
    eurRate: null,
    reference: "Invoice BILL-77",
    sourceAccountId: 1,
    sourceAccountName: "Main EUR",
    approvalsRequired: [],
    payloadHash: HASH,
    requestedBy: FINANCE.email,
    confirmedAt: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: null,
    providerId: null,
    confirmPhrase: null,
    decision: null,
    settlement: "not_paid",
    ...over,
  };
  return {
    ...base,
    confirmPhrase:
      over.confirmPhrase !== undefined
        ? over.confirmPhrase
        : base.status === "draft" && base.batchId === null
          ? paymentConfirmPhrase(base.amountMinor, base.currency, base.ibanMasked.slice(-4))
          : null,
  };
}

export function batch(over: Partial<BatchDto> = {}): BatchDto {
  const items = over.items ?? [
    payment({ id: 21, batchId: 5, openItemId: 1, invoiceNumber: "BILL-1", amountMinor: 10000 }),
    payment({
      id: 22,
      batchId: 5,
      openItemId: 2,
      invoiceNumber: "BILL-2",
      supplierName: "Beta GmbH",
      amountMinor: 20050,
    }),
  ];
  const total = items.reduce((n, i) => n + i.amountMinor, 0);
  const base: BatchDto = {
    kind: "batch",
    id: 5,
    requestId: "5d0f2c0a-0000-4000-8000-000000000005",
    status: "draft",
    statusReason: null,
    mode: "drafts",
    currency: "EUR",
    totalMinor: total,
    itemCount: items.length,
    eurMinor: total,
    sourceAccountId: 1,
    sourceAccountName: "Main EUR",
    approvalsRequired: [],
    payloadHash: HASH,
    requestedBy: FINANCE.email,
    confirmedAt: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: null,
    providerId: null,
    confirmPhrase: null,
    decision: null,
    ...over,
    items,
  };
  return {
    ...base,
    confirmPhrase:
      over.confirmPhrase !== undefined
        ? over.confirmPhrase
        : base.status === "draft"
          ? batchConfirmPhrase(base.itemCount, base.totalMinor, base.currency)
          : null,
  };
}

export function event(over: Partial<PaymentEventDto> = {}): PaymentEventDto {
  return {
    fromStatus: null,
    toStatus: "draft",
    code: "created",
    actor: FINANCE.email,
    at: "2026-11-11T10:00:00.000Z",
    ...over,
  };
}

export function paymentsSettings(
  over: Partial<PaymentsSettingsResponse> = {},
): PaymentsSettingsResponse {
  return {
    settings: { ...DEFAULT_PAYMENT_SETTINGS, allowedCurrencies: ["EUR"] },
    defaults: { ...DEFAULT_PAYMENT_SETTINGS, allowedCurrencies: ["EUR"] },
    enabled: false,
    verified: null,
    protocolVersion: "f".repeat(64),
    protocolChanged: false,
    connectionMode: "drafts",
    approverCount: 1,
    submitterAvailable: false,
    blockers: ["not_verified", "submitter_unavailable", "payments_disabled"],
    verifyChecks: [...PAYMENTS_VERIFY_CHECKS],
    blockCodes: [],
    ...over,
  };
}

export function ibanStatus(over: Partial<SupplierIbanStatusDto> = {}): SupplierIbanStatusDto {
  return {
    relationId: 7,
    name: "Acme Supplies BV",
    isSupplier: true,
    ibanMasked: "NL91****4300",
    ibanFingerprint: "c".repeat(64),
    state: "unverified",
    verifiedBy: null,
    verifiedAt: null,
    readAt: "2026-11-11T02:00:00.000Z",
    ...over,
  };
}
