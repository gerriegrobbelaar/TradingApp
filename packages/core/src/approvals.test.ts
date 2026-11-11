import { describe, expect, it } from "vitest";
import {
  APPROVAL_MAX_AGE_MS,
  approvalAgeDays,
  type ApprovalForPayment,
  approvalStatusFromCode,
  isInvoiceApprovedForPayment,
  parseApprovalMappingVerified,
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
  const NOW = Date.parse("2026-11-11T12:00:00.000Z");
  const HOUR = 3_600_000;
  const fresh = (over: Partial<ApprovalForPayment> = {}): ApprovalForPayment => ({
    status: "approved",
    statusCode: 50,
    lastSeenAt: new Date(NOW - HOUR).toISOString(),
    missedCycles: 0,
    ...over,
  });
  const ok = (e: ApprovalForPayment, maxAgeMs?: number): boolean =>
    isInvoiceApprovedForPayment(
      e,
      maxAgeMs === undefined
        ? { nowMs: NOW, mappingVerified: true }
        : { nowMs: NOW, maxAgeMs, mappingVerified: true },
    );

  it("is false unless the mapping is verified, and true only with every condition", () => {
    const e = fresh();
    expect(isInvoiceApprovedForPayment(e, { nowMs: NOW })).toBe(false);
    expect(isInvoiceApprovedForPayment(e, { nowMs: NOW, mappingVerified: false })).toBe(false);
    expect(
      isInvoiceApprovedForPayment(e, { nowMs: NOW, mappingVerified: "true" as unknown as boolean }),
    ).toBe(false);
    expect(isInvoiceApprovedForPayment(e, { nowMs: NOW, mappingVerified: true })).toBe(true);
    // verified, but each of the other conditions still applies
    const v = { nowMs: NOW, mappingVerified: true };
    expect(isInvoiceApprovedForPayment(fresh({ missedCycles: 1 }), v)).toBe(false);
    expect(isInvoiceApprovedForPayment(fresh({ statusCode: 999 }), v)).toBe(false);
    expect(
      isInvoiceApprovedForPayment(fresh({ lastSeenAt: new Date(NOW - 40 * HOUR).toISOString() }), v),
    ).toBe(false);
  });

  it("parses the stored marker strictly", () => {
    const good = { verifiedAt: "2026-11-11T10:00:00.000Z", verifiedBy: "a@b.c", adrRef: "0025" };
    expect(parseApprovalMappingVerified(JSON.stringify(good))).toEqual(good);
    for (const bad of [null, "", "x", "[]", "null", JSON.stringify({ ...good, adrRef: "" }),
      JSON.stringify({ ...good, verifiedAt: "soon" }), JSON.stringify({ verifiedAt: good.verifiedAt })]) {
      expect(parseApprovalMappingVerified(bad)).toBeNull();
    }
  });

  it("is true only for approved", () => {
    const all: ApprovalStatus[] = ["pending_approval", "approved", "rejected", "unknown"];
    expect(all.filter((status) => ok(fresh({ status })))).toEqual(["approved"]);
  });

  it("re-derives from the raw code: a stale or inconsistent derivation is not approved", () => {
    for (const statusCode of [null, 5, 0, 20, 49, 51, 999, 50.5]) {
      expect(ok(fresh({ statusCode }))).toBe(false);
    }
    // the code alone is not enough either: the stored status must agree
    expect(ok(fresh({ status: "unknown", statusCode: 50 }))).toBe(false);
  });

  it("is false for a row the reads have not confirmed recently", () => {
    expect(ok(fresh({ lastSeenAt: new Date(NOW - 35 * HOUR).toISOString() }))).toBe(true);
    expect(ok(fresh({ lastSeenAt: new Date(NOW - APPROVAL_MAX_AGE_MS).toISOString() }))).toBe(true);
    expect(ok(fresh({ lastSeenAt: new Date(NOW - APPROVAL_MAX_AGE_MS - 1).toISOString() }))).toBe(
      false,
    );
    expect(ok(fresh({ lastSeenAt: new Date(NOW - 30 * 24 * HOUR).toISOString() }))).toBe(false);
    expect(ok(fresh({ lastSeenAt: null }))).toBe(false);
    expect(ok(fresh({ lastSeenAt: "yesterday" }))).toBe(false);
    // a stamp from the future is a fault, not a fresh row
    expect(ok(fresh({ lastSeenAt: new Date(NOW + 2 * HOUR).toISOString() }))).toBe(false);
    expect(ok(fresh({ lastSeenAt: new Date(NOW + 60_000).toISOString() }))).toBe(true);
  });

  it("is false for a row the last complete read did not see", () => {
    expect(ok(fresh({ missedCycles: 1 }))).toBe(false);
    expect(ok(fresh({ missedCycles: -1 }))).toBe(false);
  });

  it("a caller may ask for a shorter age, never a longer one", () => {
    const e = fresh({ lastSeenAt: new Date(NOW - 2 * HOUR).toISOString() });
    expect(ok(e, HOUR)).toBe(false);
    expect(ok(e, 3 * HOUR)).toBe(true);
    const old = fresh({ lastSeenAt: new Date(NOW - 40 * HOUR).toISOString() });
    expect(ok(old, 100 * HOUR)).toBe(false);
    expect(ok(e, 0)).toBe(false);
    expect(ok(e, -1)).toBe(false);
    expect(ok(e, Number.NaN)).toBe(false);
    expect(isInvoiceApprovedForPayment(e, { nowMs: Number.NaN })).toBe(false);
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
