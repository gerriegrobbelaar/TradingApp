import { describe, expect, it } from "vitest";
import {
  approvalAgeDays,
  approvalStatusFromCode,
  isInvoiceApprovedForPayment,
  pendingStatusCodes,
  purchaseWindowStart,
  PURCHASE_ENTRY_STATUS_TABLE,
} from "./approvals";
import type { ApprovalStatus } from "./api-types";

describe("approvalStatusFromCode", () => {
  it("maps the codes of the table and nothing else", () => {
    expect(approvalStatusFromCode(5)).toBe("pending_approval");
    expect(approvalStatusFromCode(50)).toBe("approved");
  });

  it("maps null, unlisted, negative and non-integer codes to unknown, never approved", () => {
    for (const c of [null, 0, 1, 10, 20, 49, 51, 999, -5, 5.5, Number.NaN]) {
      expect(approvalStatusFromCode(c)).toBe("unknown");
    }
  });

  it("does not trust inherited object keys", () => {
    expect(approvalStatusFromCode(Number("constructor"))).toBe("unknown");
    expect(approvalStatusFromCode(null, {})).toBe("unknown");
  });

  it("only the table decides: a table with a rejected code maps it", () => {
    expect(approvalStatusFromCode(40, { 40: "rejected" })).toBe("rejected");
  });

  it("lists only pending codes for the read filter", () => {
    expect(pendingStatusCodes()).toEqual([5]);
    expect(
      pendingStatusCodes({ 1: "approved", 7: "pending_approval", 3: "pending_approval" }),
    ).toEqual([3, 7]);
    expect(Object.values(PURCHASE_ENTRY_STATUS_TABLE)).not.toContain("unknown");
  });
});

describe("isInvoiceApprovedForPayment", () => {
  it("is true only for approved", () => {
    const all: ApprovalStatus[] = ["pending_approval", "approved", "rejected", "unknown"];
    expect(all.filter((status) => isInvoiceApprovedForPayment({ status }))).toEqual(["approved"]);
  });
});

describe("approvalAgeDays", () => {
  const today = "2026-11-11";
  it("counts Amsterdam calendar days from the submission", () => {
    // 23:30 UTC on 8 Nov is already 9 Nov in Amsterdam (UTC+1).
    expect(
      approvalAgeDays(
        { status: "pending_approval", submittedAt: "2026-11-08T23:30:00.000Z", entryDate: null },
        today,
      ),
    ).toBe(2);
  });

  it("falls back to the entry date, never goes negative, and is null otherwise", () => {
    const pending = { status: "pending_approval" as const, submittedAt: null };
    expect(approvalAgeDays({ ...pending, entryDate: "2026-11-01" }, today)).toBe(10);
    expect(approvalAgeDays({ ...pending, entryDate: "2026-12-01" }, today)).toBe(0);
    expect(approvalAgeDays({ ...pending, entryDate: null }, today)).toBeNull();
    expect(
      approvalAgeDays(
        { status: "approved", submittedAt: "2026-11-01T00:00:00Z", entryDate: null },
        today,
      ),
    ).toBeNull();
    expect(
      approvalAgeDays(
        { status: "pending_approval", submittedAt: "garbage", entryDate: "2026-11-01" },
        today,
      ),
    ).toBeNull();
  });
});

describe("purchaseWindowStart", () => {
  it("is 120 days back", () => {
    expect(purchaseWindowStart("2026-11-11")).toBe("2026-07-14");
  });
});
