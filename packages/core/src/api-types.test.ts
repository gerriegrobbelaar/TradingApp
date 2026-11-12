import { describe, expect, it } from "vitest";
import { drilldownForRelation, type DrilldownHint, type MatchCreateRequest } from "./api-types";

describe("drilldownForRelation", () => {
  it("adds the relation id without changing the hint it came from", () => {
    const hint: DrilldownHint = { path: "/api/bills", query: { status: "open", currency: "EUR" } };
    expect(drilldownForRelation(hint, 12)).toEqual({
      path: "/api/bills",
      query: { status: "open", currency: "EUR", relationId: "12" },
    });
    expect(hint.query).toEqual({ status: "open", currency: "EUR" });
  });
});

describe("matching api types", () => {
  it("a manual match request names either allocations or a ledger account", () => {
    const byItems: MatchCreateRequest = {
      transactionId: 1,
      allocations: [{ openItemId: 2, allocatedMinor: 100 }],
    };
    const byLedger: MatchCreateRequest = { transactionId: 1, ledgerAccountCode: "4500" };
    expect(Object.keys(byItems).sort()).toEqual(["allocations", "transactionId"]);
    expect(Object.keys(byLedger).sort()).toEqual(["ledgerAccountCode", "transactionId"]);
  });
});

// ---- payments DTOs: the shapes moved from the worker's read.ts must stay byte-identical (P9c) ----------
import type { ApprovalReason, PaymentMode, PaymentStatus } from "./payments/types";
import {
  PAYMENT_SETTLEMENTS,
  type BatchDto,
  type DecisionDto,
  type PaymentDto,
  type PaymentSettlement,
} from "./api-types";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertTrue = <T extends true>(): T | undefined => undefined;

/** A copy of the declarations as P9a wrote them in apps/worker/src/payments/read.ts. */
interface P9aDecisionDto {
  decision: "approved" | "rejected";
  by: string;
  at: string;
  note: string | null;
}
interface P9aPaymentDto {
  kind: "payment";
  id: number;
  requestId: string;
  batchId: number | null;
  status: PaymentStatus;
  statusReason: string | null;
  mode: PaymentMode;
  openItemId: number;
  invoiceNumber: string | null;
  dueDate: string | null;
  supplierName: string;
  ibanMasked: string;
  ibanFingerprintShort: string;
  amountMinor: number;
  currency: string;
  eurMinor: number | null;
  eurRate: string | null;
  reference: string;
  sourceAccountId: number;
  sourceAccountName: string;
  approvalsRequired: ApprovalReason[];
  payloadHash: string;
  requestedBy: string;
  confirmedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string | null;
  providerId: string | null;
  confirmPhrase: string | null;
  decision: P9aDecisionDto | null;
}
/** F9c adds exactly one field to a payment, and so to a batch's items: how far the booking is. */
interface F9cPaymentDto extends P9aPaymentDto {
  settlement: PaymentSettlement;
}
interface P9aBatchDto {
  kind: "batch";
  id: number;
  requestId: string;
  status: PaymentStatus;
  statusReason: string | null;
  mode: PaymentMode;
  currency: string;
  totalMinor: number;
  itemCount: number;
  eurMinor: number | null;
  sourceAccountId: number;
  sourceAccountName: string;
  approvalsRequired: ApprovalReason[];
  payloadHash: string;
  requestedBy: string;
  confirmedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string | null;
  providerId: string | null;
  confirmPhrase: string | null;
  decision: P9aDecisionDto | null;
  items: F9cPaymentDto[];
}

describe("payments DTO shapes", () => {
  it("are identical to what P9a returned (compile-time check)", () => {
    assertTrue<Equal<DecisionDto, P9aDecisionDto>>();
    assertTrue<Equal<PaymentDto, F9cPaymentDto>>();
    assertTrue<Equal<Omit<PaymentDto, "settlement">, P9aPaymentDto>>();
    assertTrue<Equal<BatchDto, P9aBatchDto>>();
    expect(true).toBe(true);
  });
});

describe("payment settlement codes", () => {
  it("are the six the worker's paymentSettlement can return, in order of progress", () => {
    expect([...PAYMENT_SETTLEMENTS]).toEqual([
      "not_paid",
      "awaiting_bank_line",
      "awaiting_match",
      "match_other_invoice",
      "awaiting_booking",
      "booked",
    ]);
  });
});
