import { describe, expect, it } from "vitest";
import {
  APPROVAL_MAX_AGE_MS,
  approvalAgeDays,
  type ApprovalForPayment,
  type ApprovalMappingCheck,
  approvalMappingCanonical,
  approvalMappingHash,
  approvalStatusFromCode,
  checkApprovalMapping,
  findPurchaseEntryForPayable,
  isInvoiceApprovedForPayment,
  PAYABLE_PURCHASE_JOIN_RULE_VERSION,
  purchaseEntryJoinKey,
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
  const marker = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      verifiedAt: "2026-11-11T10:00:00.000Z",
      verifiedBy: "a@b.c",
      adrRef: "0025",
      mappingHash: approvalMappingHash(),
      ...over,
    });
  const VERIFIED = checkApprovalMapping(marker());
  const ok = (e: ApprovalForPayment, maxAgeMs?: number): boolean =>
    isInvoiceApprovedForPayment(
      e,
      maxAgeMs === undefined
        ? { nowMs: NOW, mapping: VERIFIED }
        : { nowMs: NOW, maxAgeMs, mapping: VERIFIED },
    );

  it("is false unless the mapping is verified, and true only with every condition", () => {
    const e = fresh();
    expect(VERIFIED.verified).toBe(true);
    for (const valueJson of [null, "", "{}", marker({ mappingHash: "0".repeat(64) })]) {
      const mapping = checkApprovalMapping(valueJson);
      expect(mapping.verified).toBe(false);
      expect(isInvoiceApprovedForPayment(e, { nowMs: NOW, mapping })).toBe(false);
    }
    expect(isInvoiceApprovedForPayment(e, { nowMs: NOW, mapping: VERIFIED })).toBe(true);
    // verified, but each of the other conditions still applies
    const v = { nowMs: NOW, mapping: VERIFIED };
    expect(isInvoiceApprovedForPayment(fresh({ missedCycles: 1 }), v)).toBe(false);
    expect(isInvoiceApprovedForPayment(fresh({ statusCode: 999 }), v)).toBe(false);
    expect(
      isInvoiceApprovedForPayment(
        fresh({ lastSeenAt: new Date(NOW - 40 * HOUR).toISOString() }),
        v,
      ),
    ).toBe(false);
  });

  it("cannot be satisfied by a check that checkApprovalMapping did not issue", () => {
    const e = fresh();
    const forged = [
      { ...VERIFIED },
      JSON.parse(JSON.stringify(VERIFIED)) as unknown,
      { verified: true, reason: null, marker: VERIFIED.marker, currentHash: VERIFIED.currentHash },
      undefined,
      null,
      true,
      "verified",
    ];
    for (const mapping of forged) {
      expect(
        isInvoiceApprovedForPayment(e, {
          nowMs: NOW,
          mapping: mapping as unknown as ApprovalMappingCheck,
        }),
      ).toBe(false);
    }
    expect(
      isInvoiceApprovedForPayment(
        e,
        {} as unknown as { nowMs: number; mapping: ApprovalMappingCheck },
      ),
    ).toBe(false);
    expect(Object.isFrozen(VERIFIED)).toBe(true);
  });

  it("parses the stored marker strictly", () => {
    const good = {
      verifiedAt: "2026-11-11T10:00:00.000Z",
      verifiedBy: "a@b.c",
      adrRef: "0025",
      mappingHash: approvalMappingHash(),
    };
    expect(parseApprovalMappingVerified(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      null,
      "",
      "x",
      "[]",
      "null",
      "true",
      JSON.stringify({ ...good, adrRef: "" }),
      JSON.stringify({ ...good, verifiedBy: "" }),
      JSON.stringify({ ...good, verifiedAt: "soon" }),
      JSON.stringify({ ...good, mappingHash: undefined }),
      JSON.stringify({ ...good, mappingHash: "ABC" }),
      JSON.stringify({ ...good, mappingHash: good.mappingHash.toUpperCase() }),
      JSON.stringify({ verifiedAt: good.verifiedAt }),
    ]) {
      expect(parseApprovalMappingVerified(bad)).toBeNull();
      expect(checkApprovalMapping(bad).reason).toBe("not_verified");
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
    expect(isInvoiceApprovedForPayment(e, { nowMs: Number.NaN, mapping: VERIFIED })).toBe(false);
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

describe("mapping fingerprint (review S2: a table change voids the verified mark)", () => {
  const table = PURCHASE_ENTRY_STATUS_TABLE as Record<number, ApprovalStatus>;
  const markFor = (hash: string): string =>
    JSON.stringify({
      verifiedAt: "2026-11-11T10:00:00.000Z",
      verifiedBy: "admin@camelthorncapital.com",
      adrRef: "ADR 0025",
      mappingHash: hash,
    });

  it("is a stable canonical serialisation: key order does not matter, content does", () => {
    expect(approvalMappingCanonical({ 50: "approved", 5: "pending_approval" })).toBe(
      approvalMappingCanonical({ 5: "pending_approval", 50: "approved" }),
    );
    expect(approvalMappingCanonical()).toBe(
      JSON.stringify({
        format: 1,
        joinRuleVersion: PAYABLE_PURCHASE_JOIN_RULE_VERSION,
        table: [
          ["5", "pending_approval"],
          ["50", "approved"],
        ],
      }),
    );
    expect(approvalMappingHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(approvalMappingHash({ 5: "pending_approval", 50: "approved" })).toBe(
      approvalMappingHash(),
    );
    // numeric sort, not text sort: 5 < 20 < 100
    expect(
      approvalMappingCanonical({ 100: "approved", 20: "rejected", 5: "pending_approval" }),
    ).toContain('[["5","pending_approval"],["20","rejected"],["100","approved"]]');
  });

  it("every kind of change gives another hash", () => {
    const base = approvalMappingHash();
    const variants = [
      approvalMappingHash({ 5: "pending_approval", 50: "rejected" }),
      approvalMappingHash({ 5: "pending_approval", 51: "approved" }),
      approvalMappingHash({ 5: "pending_approval" }),
      approvalMappingHash({ 5: "pending_approval", 50: "approved", 20: "pending_approval" }),
      approvalMappingHash({ 5: "rejected", 50: "approved" }),
      approvalMappingHash(PURCHASE_ENTRY_STATUS_TABLE, PAYABLE_PURCHASE_JOIN_RULE_VERSION + 1),
      approvalMappingHash({}),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it("a mark made for the current table counts; mutating the table voids it at once", () => {
    const stored = markFor(approvalMappingHash());
    const before = checkApprovalMapping(stored);
    expect(before.verified).toBe(true);
    const e: ApprovalForPayment = {
      status: "approved",
      statusCode: 50,
      lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
      missedCycles: 0,
    };
    expect(isInvoiceApprovedForPayment(e, { nowMs: Date.now(), mapping: before })).toBe(true);
    table[20] = "approved";
    try {
      // the check made before the change no longer lets anything through ...
      expect(isInvoiceApprovedForPayment(e, { nowMs: Date.now(), mapping: before })).toBe(false);
      // ... and a fresh check of the same stored mark says why
      const after = checkApprovalMapping(stored);
      expect(after.verified).toBe(false);
      expect(after.reason).toBe("mapping_changed");
      expect(after.marker?.verifiedBy).toBe("admin@camelthorncapital.com");
      expect(isInvoiceApprovedForPayment(e, { nowMs: Date.now(), mapping: after })).toBe(false);
    } finally {
      delete table[20];
    }
    expect(checkApprovalMapping(stored).verified).toBe(true);
    // changing the dangerous row itself, too
    table[50] = "pending_approval";
    try {
      expect(checkApprovalMapping(stored).reason).toBe("mapping_changed");
    } finally {
      table[50] = "approved";
    }
  });

  it("a mark for another join rule version is a changed mapping", () => {
    const stored = markFor(approvalMappingHash(PURCHASE_ENTRY_STATUS_TABLE, 0));
    expect(checkApprovalMapping(stored).reason).toBe("mapping_changed");
    const s2 = markFor(approvalMappingHash(PURCHASE_ENTRY_STATUS_TABLE, 2));
    expect(checkApprovalMapping(s2, PURCHASE_ENTRY_STATUS_TABLE, 2).verified).toBe(true);
  });
});

describe("payable to purchase entry join (ADR 0025, join rule 1)", () => {
  it("normalises numeric entry numbers only", () => {
    expect(purchaseEntryJoinKey("000123")).toBe("123");
    expect(purchaseEntryJoinKey(" 123 ")).toBe("123");
    expect(purchaseEntryJoinKey(123)).toBe("123");
    expect(purchaseEntryJoinKey("0")).toBe("0");
    expect(purchaseEntryJoinKey("000")).toBe("0");
    expect(purchaseEntryJoinKey(0)).toBe("0");
    // not numeric: kept as is, so A001 and A1 never collide
    expect(purchaseEntryJoinKey("A001")).toBe("A001");
    expect(purchaseEntryJoinKey("A1")).toBe("A1");
    expect(purchaseEntryJoinKey("A001")).not.toBe(purchaseEntryJoinKey("A1"));
    expect(purchaseEntryJoinKey("001A")).toBe("001A");
    expect(purchaseEntryJoinKey("-01")).toBe("-01");
    expect(purchaseEntryJoinKey("1.0")).toBe("1.0");
    expect(purchaseEntryJoinKey("１２")).toBe("１２"); // full-width digits are not ASCII digits
    for (const bad of [null, undefined, "", "   ", -1, 1.5, Number.NaN, 2 ** 60]) {
      expect(purchaseEntryJoinKey(bad)).toBeNull();
    }
  });

  const entry = (
    id: number,
    divisionId: number,
    entryNumber: string | null,
    journalCode?: string | null,
  ) => ({
    id,
    divisionId,
    entryNumber,
    ...(journalCode === undefined ? {} : { journalCode }),
  });

  it("matches exactly one entry in the same division", () => {
    const entries = [entry(1, 1, "000123"), entry(2, 2, "123"), entry(3, 1, "124")];
    expect(findPurchaseEntryForPayable({ divisionId: 1, entryNumber: 123 }, entries)?.id).toBe(1);
    expect(findPurchaseEntryForPayable({ divisionId: 2, entryNumber: "0123" }, entries)?.id).toBe(
      2,
    );
  });

  it("no match is null", () => {
    const entries = [entry(1, 1, "123")];
    expect(findPurchaseEntryForPayable({ divisionId: 1, entryNumber: 999 }, entries)).toBeNull();
    expect(findPurchaseEntryForPayable({ divisionId: 3, entryNumber: 123 }, entries)).toBeNull();
    expect(findPurchaseEntryForPayable({ divisionId: 1, entryNumber: null }, entries)).toBeNull();
    expect(findPurchaseEntryForPayable({ divisionId: 1, entryNumber: 123 }, [])).toBeNull();
    expect(
      findPurchaseEntryForPayable({ divisionId: 1, entryNumber: null }, [entry(9, 1, null)]),
    ).toBeNull();
    expect(
      findPurchaseEntryForPayable({ divisionId: Number.NaN, entryNumber: 123 }, entries),
    ).toBeNull();
  });

  it("several matches are null, never a pick", () => {
    expect(
      findPurchaseEntryForPayable({ divisionId: 1, entryNumber: 123 }, [
        entry(1, 1, "123"),
        entry(2, 1, "0123"),
      ]),
    ).toBeNull();
    // different journals, payable without a journal: ambiguous
    expect(
      findPurchaseEntryForPayable({ divisionId: 1, entryNumber: 123 }, [
        entry(1, 1, "123", "60"),
        entry(2, 1, "123", "61"),
      ]),
    ).toBeNull();
  });

  it("uses the journal when both sides carry it", () => {
    const entries = [entry(1, 1, "123", "60"), entry(2, 1, "123", "61")];
    expect(
      findPurchaseEntryForPayable({ divisionId: 1, entryNumber: 123, journalCode: "61" }, entries)
        ?.id,
    ).toBe(2);
    expect(
      findPurchaseEntryForPayable({ divisionId: 1, entryNumber: 123, journalCode: "62" }, entries),
    ).toBeNull();
    expect(
      findPurchaseEntryForPayable({ divisionId: 1, entryNumber: 123, journalCode: " 60 " }, [
        entry(1, 1, "123", null),
      ])?.id,
    ).toBe(1);
    expect(
      findPurchaseEntryForPayable({ divisionId: 1, entryNumber: 123, journalCode: "" }, [
        entry(1, 1, "123", "60"),
      ])?.id,
    ).toBe(1);
  });

  it("A001 and A1 stay two keys in a real join", () => {
    const entries = [entry(1, 1, "A001"), entry(2, 1, "A1")];
    expect(findPurchaseEntryForPayable({ divisionId: 1, entryNumber: "A1" }, entries)?.id).toBe(2);
    expect(findPurchaseEntryForPayable({ divisionId: 1, entryNumber: "A001" }, entries)?.id).toBe(
      1,
    );
  });
});
