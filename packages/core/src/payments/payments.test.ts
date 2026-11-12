import { describe, expect, it } from "vitest";
import { hmacSha256Hex, sha256Hex } from "../sha256";
import {
  APPROVAL_REASONS,
  approvalStillValid,
  assessIban,
  buildPaymentReference,
  canApprove,
  canTransition,
  eurEquivalent,
  ibanFingerprint,
  isAboveLimit,
  isStepUpRecent,
  isUuidV4,
  PAYMENT_FINAL_STATUSES,
  PAYMENT_OPEN_STATUSES,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  paymentPayloadHash,
  PayloadError,
  requiredApprovals,
  sanitizeSepaText,
  isPaymentStatus,
  type ApproveInput,
  type IbanState,
  type PaymentPayload,
  type PaymentStatus,
} from "./index";

const GOOD_IBAN = "NL91ABNA0417164300";
const FP_KEY = "core-test-iban-key-0123456789abcdef";
const OTHER_IBAN = "DE89370400440532013000";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-9222-222222222222";

describe("state machine", () => {
  it("has a move table that only goes forward and ends in final states", () => {
    const rank: Record<PaymentStatus, number> = {
      draft: 0,
      pending_approval: 1,
      ready: 2,
      submitting: 3,
      submitted: 4,
      outcome_unknown: 4,
      paid: 5,
      failed: 5,
      rejected: 5,
      cancelled: 5,
      expired: 5,
    };
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        const legal = canTransition(from, to);
        expect(legal, `${from}->${to}`).toBe(PAYMENT_TRANSITIONS[from].includes(to));
        if (legal)
          expect(rank[to], `${from}->${to} goes forward`).toBeGreaterThanOrEqual(rank[from]);
        if (legal && from === "outcome_unknown")
          expect(["submitted", "paid", "failed", "rejected"]).toContain(to);
      }
    }
    for (const f of PAYMENT_FINAL_STATUSES) expect(PAYMENT_TRANSITIONS[f]).toEqual([]);
    expect(PAYMENT_OPEN_STATUSES.filter((s) => PAYMENT_FINAL_STATUSES.includes(s))).toEqual([]);
  });

  it("never lets a request go from ready back, or skip approval, or leave a final state", () => {
    expect(canTransition("ready", "draft")).toBe(false);
    expect(canTransition("ready", "pending_approval")).toBe(false);
    expect(canTransition("draft", "submitting")).toBe(false);
    expect(canTransition("pending_approval", "submitting")).toBe(false);
    expect(canTransition("submitting", "ready")).toBe(false);
    expect(canTransition("outcome_unknown", "ready")).toBe(false);
    expect(canTransition("outcome_unknown", "submitting")).toBe(false);
    expect(canTransition("paid", "failed")).toBe(false);
    expect(canTransition("failed", "paid")).toBe(false);
    expect(canTransition("draft", "draft")).toBe(false);
    expect(isPaymentStatus("paid")).toBe(true);
    expect(isPaymentStatus("PAID")).toBe(false);
    expect(isPaymentStatus(3)).toBe(false);
  });
});

describe("reference text", () => {
  it("builds 'Invoice <number>' from the invoice number only", () => {
    expect(buildPaymentReference("2026-0042")).toEqual({
      reference: "Invoice 2026-0042",
      shortened: false,
    });
    expect(buildPaymentReference(1234).reference).toBe("Invoice 1234");
  });
  it("returns null for nothing usable", () => {
    expect(buildPaymentReference(null).reference).toBeNull();
    expect(buildPaymentReference(undefined).reference).toBeNull();
    expect(buildPaymentReference("").reference).toBeNull();
    expect(buildPaymentReference("   ").reference).toBeNull();
    expect(buildPaymentReference("###***").reference).toBeNull();
    expect(buildPaymentReference("🙂🙂").reference).toBeNull();
    expect(buildPaymentReference("//").reference).toBeNull();
  });
  it("folds accents, drops invisible characters and replaces what SEPA does not allow", () => {
    expect(sanitizeSepaText("Café Müller & Zoë")).toBe("Cafe Muller Zoe");
    expect(sanitizeSepaText("a​b‮c")).toBe("abc");
    expect(sanitizeSepaText("INV\u0000\n\t42")).toBe("INV 42");
    expect(sanitizeSepaText("ＮＬ９１")).toBe("NL91");
    expect(sanitizeSepaText("a//b///c")).toBe("a/b/c");
    expect(sanitizeSepaText("/x/")).toBe("x");
    expect(sanitizeSepaText("x_y|z<script>")).toBe("x y z script");
    expect(sanitizeSepaText(5 as unknown as string)).toBe("");
    for (const ch of sanitizeSepaText("Ünïcödé ≠ ascii 日本 ☃ \u{1F600} RTL‏ ok")) {
      expect(ch).toMatch(/[A-Za-z0-9/\-?:().,'+ ]/);
    }
  });
  it("caps at 140 characters and flags it", () => {
    const r = buildPaymentReference("A".repeat(500));
    expect(r.reference).toHaveLength(140);
    expect(r.shortened).toBe(true);
    const edge = buildPaymentReference("B".repeat(140 - "Invoice ".length));
    expect(edge.reference).toHaveLength(140);
    expect(edge.shortened).toBe(false);
    const cut = buildPaymentReference("AAA " + "/".repeat(2) + "B".repeat(200), 12);
    expect(cut.reference?.endsWith(" ")).toBe(false);
    expect(cut.shortened).toBe(true);
    const spaceCut = buildPaymentReference("x y", 9);
    expect(spaceCut.reference).toBe("Invoice x");
  });
  it("only accepts lower-case UUID v4 as a request id", () => {
    expect(isUuidV4(crypto.randomUUID())).toBe(true);
    expect(isUuidV4(ID1)).toBe(true);
    expect(isUuidV4("AAAAAAAA-1111-4111-8111-111111111111")).toBe(false);
    expect(isUuidV4("11111111-1111-1111-8111-111111111111")).toBe(false);
    expect(isUuidV4("")).toBe(false);
    expect(isUuidV4(7)).toBe(false);
  });
});

describe("IBAN trust", () => {
  const verified = (by: string, iban = GOOD_IBAN) => ({
    fingerprint: ibanFingerprint(iban, FP_KEY) as string,
    verifiedBy: by,
    revoked: false,
  });
  it("fingerprints are stable across spacing and case, and differ per IBAN", () => {
    expect(ibanFingerprint("nl91 abna 0417 1643 00", FP_KEY)).toBe(
      ibanFingerprint(GOOD_IBAN, FP_KEY),
    );
    expect(ibanFingerprint(GOOD_IBAN, FP_KEY)).not.toBe(ibanFingerprint(OTHER_IBAN, FP_KEY));
    expect(ibanFingerprint(GOOD_IBAN, FP_KEY)).toBe(
      hmacSha256Hex(FP_KEY, `iban-fp-v2:${GOOD_IBAN}`),
    );
    expect(ibanFingerprint(GOOD_IBAN, FP_KEY)).not.toContain("NL91");
    expect(ibanFingerprint("garbage", FP_KEY)).toBeNull();
    expect(ibanFingerprint(null, FP_KEY)).toBeNull();
    expect(ibanFingerprint(undefined, FP_KEY)).toBeNull();
  });
  it("is KEYED: an unkeyed hash of the IBAN does not reproduce it, another key gives another one", () => {
    // review P9a: an unkeyed SHA-256 next to a masked IBAN is brute-forceable (few unknown digits)
    const fp = ibanFingerprint(GOOD_IBAN, FP_KEY);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toBe(sha256Hex(`iban-fp-v1:${GOOD_IBAN}`));
    expect(fp).not.toBe(sha256Hex(`iban-fp-v2:${GOOD_IBAN}`));
    expect(fp).not.toBe(ibanFingerprint(GOOD_IBAN, `${FP_KEY}x`));
    // no key, a short key or a padded key: no fingerprint at all (callers fail closed)
    expect(ibanFingerprint(GOOD_IBAN, "")).toBeNull();
    expect(ibanFingerprint(GOOD_IBAN, "short-key")).toBeNull();
    expect(ibanFingerprint(GOOD_IBAN, ` ${FP_KEY}`)).toBeNull();
    expect(
      assessIban(
        { recordIban: GOOD_IBAN, verification: null, paidBefore: false, fingerprintKey: "" },
        "r@x.nl",
      ),
    ).toEqual({ state: "invalid", fingerprint: null });
  });
  it("classifies every state", () => {
    const a = (f: Partial<Parameters<typeof assessIban>[0]>, who = "req@x.nl") =>
      assessIban(
        {
          recordIban: GOOD_IBAN,
          verification: null,
          paidBefore: false,
          fingerprintKey: FP_KEY,
          ...f,
        },
        who,
      ).state;
    expect(a({ recordIban: null })).toBe("missing");
    expect(a({ recordIban: "  " })).toBe("missing");
    expect(a({ recordIban: "NL00ABNA0417164300" })).toBe("invalid"); // checksum
    expect(a({ recordIban: "XX" })).toBe("invalid");
    expect(a({})).toBe("unverified");
    expect(a({ verification: { ...verified("app@x.nl"), revoked: true } })).toBe("unverified");
    expect(a({ verification: verified("app@x.nl", OTHER_IBAN) })).toBe("changed");
    expect(a({ verification: verified("app@x.nl") })).toBe("verified_new");
    expect(a({ verification: verified("REQ@x.nl ") })).toBe("verified_by_requester");
    expect(a({ verification: verified("app@x.nl"), paidBefore: true })).toBe(
      "verified_established",
    );
    expect(a({ verification: verified("req@x.nl"), paidBefore: true })).toBe(
      "verified_established",
    );
  });
  it("a changed IBAN in Exact is unverified again", () => {
    const v = verified("app@x.nl");
    const before = assessIban(
      { recordIban: GOOD_IBAN, verification: v, paidBefore: true, fingerprintKey: FP_KEY },
      "r@x.nl",
    );
    const after = assessIban(
      { recordIban: OTHER_IBAN, verification: v, paidBefore: true, fingerprintKey: FP_KEY },
      "r@x.nl",
    );
    expect(before.state).toBe("verified_established");
    expect(after.state).toBe("changed");
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

describe("EUR equivalent and the limit boundary", () => {
  const rates = { asOf: "2026-11-12", base: "EUR" as const, rates: { USD: "1.25", JPY: "160" } };
  it("EUR is identity, others use the rate table, no rate is null", () => {
    expect(eurEquivalent(1000, "EUR", null)).toEqual({ minor: 1000, rate: "1", currency: "EUR" });
    expect(eurEquivalent(1250, "USD", rates)?.minor).toBe(1000);
    expect(eurEquivalent(1250, "USD", null)).toBeNull();
    expect(eurEquivalent(1250, "GBP", rates)).toBeNull();
    expect(eurEquivalent(-1, "EUR", null)).toBeNull();
    expect(eurEquivalent(1.5, "EUR", null)).toBeNull();
    expect(eurEquivalent(Number.MAX_SAFE_INTEGER + 2, "EUR", null)).toBeNull();
    // JPY has no minor units: 16000 yen = 100 EUR = 10000 cents
    expect(eurEquivalent(16000, "JPY", rates)?.minor).toBe(10000);
  });
  it("rounds half away from zero once, at the end", () => {
    // 1 USD cent = 0.8 EUR cent -> 1; 3 USD cents = 2.4 -> 2; 2 USD cents = 1.6 -> 2
    expect(eurEquivalent(1, "USD", rates)?.minor).toBe(1);
    expect(eurEquivalent(3, "USD", rates)?.minor).toBe(2);
    expect(eurEquivalent(2, "USD", rates)?.minor).toBe(2);
  });
  it("refuses an EUR figure that is not a safe integer", () => {
    const tiny = { asOf: "2026-11-12", base: "EUR" as const, rates: { XXX: "0.000001" } };
    expect(eurEquivalent(Number.MAX_SAFE_INTEGER, "XXX", tiny)).toBeNull();
  });
  it("exactly at the limit needs no approval in EUR; one cent over does", () => {
    expect(isAboveLimit({ minor: 250_000, rate: "1", currency: "EUR" }, 250_000)).toBe(false);
    expect(isAboveLimit({ minor: 250_001, rate: "1", currency: "EUR" }, 250_000)).toBe(true);
    expect(isAboveLimit({ minor: 249_999, rate: "1", currency: "EUR" }, 250_000)).toBe(false);
  });
  it("is conservative for other currencies at the limit, and for no rate", () => {
    expect(isAboveLimit({ minor: 250_000, rate: "0.8", currency: "USD" }, 250_000)).toBe(true);
    expect(isAboveLimit({ minor: 249_999, rate: "0.8", currency: "USD" }, 250_000)).toBe(false);
    expect(isAboveLimit(null, 250_000)).toBe(true);
  });
});

describe("four-eyes: who must approve", () => {
  const settings = {
    fourEyesEnabled: true,
    fourEyesLimitMinor: 250_000,
    requireApprovalForNewIban: true,
  };
  const eur = (minor: number) => ({ minor, rate: "1", currency: "EUR" });
  const one = (minor: number | null, iban: IbanState, s = settings) =>
    requiredApprovals({
      settings: s,
      items: [{ eur: minor === null ? null : eur(minor), iban }],
      totalEur: minor === null ? null : eur(minor),
      isBatch: false,
    });
  it("needs nobody for a small payment to an established IBAN", () => {
    expect(one(250_000, "verified_established")).toEqual([]);
    expect(one(1, "verified_established")).toEqual([]);
  });
  it("needs a second person above the limit, never at it", () => {
    expect(one(250_001, "verified_established")).toEqual(["above_limit"]);
  });
  it("needs a second person for no rate, whatever the master switch says about amounts", () => {
    expect(one(null, "verified_established")).toEqual(["no_eur_rate"]);
    expect(one(null, "verified_established", { ...settings, fourEyesEnabled: false })).toEqual([]);
  });
  it("a new or changed IBAN always needs one, even tiny, even with the master switch off", () => {
    for (const st of [
      "verified_new",
      "verified_by_requester",
      "unverified",
      "changed",
      "missing",
      "invalid",
    ] as const) {
      expect(one(1, st), st).toEqual(["new_or_changed_iban"]);
      expect(one(1, st, { ...settings, fourEyesEnabled: false }), st).toEqual([
        "new_or_changed_iban",
      ]);
    }
  });
  it("the separate toggle switches the IBAN rule off, and both off means nobody", () => {
    expect(one(1, "verified_new", { ...settings, requireApprovalForNewIban: false })).toEqual([]);
    expect(
      one(300_000, "verified_new", {
        fourEyesEnabled: false,
        fourEyesLimitMinor: 1,
        requireApprovalForNewIban: false,
      }),
    ).toEqual([]);
  });
  it("lists reasons in a fixed order", () => {
    const r = one(900_000, "changed");
    expect(r).toEqual(["above_limit", "new_or_changed_iban"]);
    expect(r).toEqual(APPROVAL_REASONS.filter((x) => r.includes(x)));
  });
  it("judges a batch by its total AND by every item", () => {
    const batch = (amounts: number[], iban: IbanState = "verified_established") =>
      requiredApprovals({
        settings,
        items: amounts.map((a) => ({ eur: eur(a), iban })),
        totalEur: eur(amounts.reduce((x, y) => x + y, 0)),
        isBatch: true,
      });
    expect(batch([100_000, 100_000])).toEqual([]);
    expect(batch([125_000, 125_000])).toEqual([]); // total exactly at the limit
    expect(batch([125_000, 125_001])).toEqual(["batch_total_above_limit"]);
    expect(batch([300_000])).toEqual(["batch_total_above_limit", "batch_item_above_limit"]);
    expect(batch([100_000, 100_000], "verified_new")).toEqual(["new_or_changed_iban"]);
    expect(
      requiredApprovals({
        settings,
        items: [{ eur: null, iban: "verified_established" }],
        totalEur: null,
        isBatch: true,
      }),
    ).toEqual(["no_eur_rate"]);
  });
  it("never treats an empty item list as safe", () => {
    expect(requiredApprovals({ settings, items: [], totalEur: eur(0), isBatch: true })).toContain(
      "above_limit",
    );
  });
});

describe("four-eyes: may this user approve", () => {
  const NOW = Date.parse("2026-11-12T10:00:00Z");
  const base = (): ApproveInput => ({
    nowMs: NOW,
    request: {
      status: "pending_approval",
      requestedBy: "req@x.nl",
      payloadHash: "h".repeat(64),
      expiresAtMs: NOW + 3600_000,
    },
    seenPayloadHash: "h".repeat(64),
    approver: { email: "app@x.nl", roles: ["approver"], active: true, lastAuthAtMs: NOW - 60_000 },
  });
  const deny = (f: (i: ApproveInput) => void) => {
    const i = base();
    f(i);
    return canApprove(i);
  };
  it("allows a different approver with a fresh sign-in and the same payload", () => {
    expect(canApprove(base())).toBeNull();
  });
  it("refuses self approval, in any case or spacing", () => {
    expect(deny((i) => (i.approver.email = "req@x.nl"))).toBe("self_approval");
    expect(deny((i) => (i.approver.email = "  REQ@X.NL "))).toBe("self_approval");
    // even an admin+approver requester
    expect(
      deny((i) => {
        i.approver.email = "req@x.nl";
        i.approver.roles = ["approver", "admin"];
      }),
    ).toBe("self_approval");
  });
  it("refuses without the approver role (admin and finance do not count)", () => {
    expect(deny((i) => (i.approver.roles = ["admin", "finance", "viewer"]))).toBe(
      "approver_lacks_role",
    );
    expect(deny((i) => (i.approver.roles = []))).toBe("approver_lacks_role");
  });
  it("refuses a disabled user", () => {
    expect(deny((i) => (i.approver.active = false))).toBe("approver_inactive");
  });
  it("refuses a stale or future sign-in; the window is 15 minutes", () => {
    expect(deny((i) => (i.approver.lastAuthAtMs = NOW - 15 * 60_000))).toBeNull();
    expect(deny((i) => (i.approver.lastAuthAtMs = NOW - 15 * 60_000 - 1))).toBe("step_up_stale");
    expect(deny((i) => (i.approver.lastAuthAtMs = NOW + 3600_000))).toBe("step_up_stale");
    expect(deny((i) => (i.approver.lastAuthAtMs = Number.NaN))).toBe("step_up_stale");
    expect(isStepUpRecent(NOW - 1, NOW)).toBe(true);
    expect(isStepUpRecent(NOW - 15 * 60_000 - 1, NOW)).toBe(false);
    expect(isStepUpRecent(Number.NaN, NOW)).toBe(false);
  });
  it("refuses a changed payload, a request that is not pending, and an expired one", () => {
    expect(deny((i) => (i.seenPayloadHash = "x".repeat(64)))).toBe("payload_changed");
    expect(deny((i) => (i.request.status = "ready"))).toBe("not_pending");
    expect(deny((i) => (i.request.status = "draft"))).toBe("not_pending");
    expect(deny((i) => (i.request.expiresAtMs = NOW))).toBe("request_expired");
    expect(deny((i) => (i.request.expiresAtMs = NOW + 1))).toBeNull();
  });
});

describe("a stored approval is re-checked before sending", () => {
  const NOW = Date.parse("2026-11-12T10:00:00Z");
  const c = (over: Partial<Parameters<typeof approvalStillValid>[0]> = {}) => ({
    nowMs: NOW,
    approval: {
      approverEmail: "app@x.nl",
      approvedAtMs: NOW - 3600_000,
      payloadHash: "a".repeat(64),
    },
    request: { requestedBy: "req@x.nl", payloadHash: "a".repeat(64) },
    approverNow: { roles: ["approver"], active: true },
    ...over,
  });
  it("is good inside 24 hours with the same payload and a still-authorised approver", () => {
    expect(approvalStillValid(c())).toBeNull();
  });
  it("expires at 24 hours exactly", () => {
    const at = (age: number) =>
      c({
        approval: {
          approverEmail: "app@x.nl",
          approvedAtMs: NOW - age,
          payloadHash: "a".repeat(64),
        },
      });
    expect(approvalStillValid(at(24 * 3600_000 - 1))).toBeNull();
    expect(approvalStillValid(at(24 * 3600_000))).toBe("approval_expired");
    expect(approvalStillValid(at(-3600_000))).toBe("approval_expired"); // from the future
  });
  it("fails when the payload changed (tamper)", () => {
    expect(
      approvalStillValid(c({ request: { requestedBy: "req@x.nl", payloadHash: "b".repeat(64) } })),
    ).toBe("payload_changed");
  });
  it("fails when the approver lost the role or was disabled after approving", () => {
    expect(approvalStillValid(c({ approverNow: { roles: ["finance"], active: true } }))).toBe(
      "approver_lacks_role",
    );
    expect(approvalStillValid(c({ approverNow: { roles: ["approver"], active: false } }))).toBe(
      "approver_inactive",
    );
  });
  it("fails when the approver is the requester (data written around the rules)", () => {
    expect(
      approvalStillValid(c({ request: { requestedBy: "APP@x.nl", payloadHash: "a".repeat(64) } })),
    ).toBe("self_approval");
  });
});

describe("payload hash", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    requestId: ID1,
    openItemId: 7,
    amountMinor: 12_345,
    currency: "EUR",
    ibanFingerprint: ibanFingerprint(GOOD_IBAN, FP_KEY) as string,
    reference: "Invoice 42",
    ...over,
  });
  const payload = (over: Partial<PaymentPayload> = {}): PaymentPayload => ({
    kind: "payment",
    mode: "drafts",
    sourceAccountId: 3,
    currency: "EUR",
    totalMinor: 12_345,
    items: [item()],
    ...over,
  });
  const h = (p: PaymentPayload) => paymentPayloadHash(p);
  it("is deterministic hex sha-256", () => {
    expect(h(payload())).toMatch(/^[0-9a-f]{64}$/);
    expect(h(payload())).toBe(h(payload()));
  });
  it("changes with every bound field", () => {
    const base = h(payload());
    const variants: PaymentPayload[] = [
      payload({ items: [item({ amountMinor: 12_346 })], totalMinor: 12_346 }),
      payload({
        items: [item({ ibanFingerprint: ibanFingerprint(OTHER_IBAN, FP_KEY) as string })],
      }),
      payload({ items: [item({ reference: "Invoice 43" })] }),
      payload({ items: [item({ openItemId: 8 })] }),
      payload({ items: [item({ requestId: ID2 })] }),
      payload({ sourceAccountId: 4 }),
      payload({ mode: "pay" }),
      payload({ kind: "batch" }),
    ];
    for (const v of variants) expect(h(v)).not.toBe(base);
    expect(new Set(variants.map(h)).size).toBe(variants.length);
  });
  it("does not depend on item order in a batch, but on membership", () => {
    const a = item();
    const b = item({ requestId: ID2, openItemId: 8, amountMinor: 100 });
    const batch = (items: ReturnType<typeof item>[]) =>
      h(
        payload({ kind: "batch", totalMinor: items.reduce((s, i) => s + i.amountMinor, 0), items }),
      );
    expect(batch([a, b])).toBe(batch([b, a]));
    expect(batch([a, b])).not.toBe(batch([a]));
  });
  it("is unambiguous: moving a character between fields changes the hash", () => {
    expect(h(payload({ items: [item({ reference: "Invoice 4|2" })] }))).not.toBe(
      h(payload({ items: [item({ reference: "Invoice 4", currency: "EUR" })] })),
    );
    expect(h(payload({ items: [item({ reference: 'a","b' })] }))).not.toBe(
      h(payload({ items: [item({ reference: "a" })] })),
    );
  });
  it("throws a coded error for anything malformed", () => {
    const code = (p: PaymentPayload) => {
      try {
        h(p);
      } catch (e) {
        return e instanceof PayloadError ? e.code : "other";
      }
      return "none";
    };
    expect(code(payload({ items: [item({ amountMinor: 0 })], totalMinor: 0 }))).toBe("bad_amount");
    expect(code(payload({ items: [item({ amountMinor: -5 })], totalMinor: -5 }))).toBe(
      "bad_amount",
    );
    expect(code(payload({ items: [item({ amountMinor: 1.5 })], totalMinor: 1.5 }))).toBe(
      "bad_amount",
    );
    expect(code(payload({ items: [item({ amountMinor: 2 ** 53 })], totalMinor: 2 ** 53 }))).toBe(
      "bad_amount",
    );
    expect(code(payload({ totalMinor: 12_346 }))).toBe("bad_total");
    expect(code(payload({ items: [] }))).toBe("no_items");
    expect(code(payload({ items: [item(), item({ requestId: ID2 })], totalMinor: 24_690 }))).toBe(
      "payment_has_one_item",
    );
    expect(code(payload({ kind: "batch", items: [item(), item()], totalMinor: 24_690 }))).toBe(
      "duplicate_request_id",
    );
    expect(code(payload({ items: [item({ requestId: "nope" })] }))).toBe("bad_request_id");
    expect(code(payload({ items: [item({ ibanFingerprint: "NL91" })] }))).toBe("bad_fingerprint");
    expect(code(payload({ items: [item({ reference: "" })] }))).toBe("bad_reference");
    expect(code(payload({ items: [item({ currency: "USD" })] }))).toBe("mixed_currency");
    expect(code(payload({ currency: "eur" }))).toBe("bad_currency");
    expect(code(payload({ sourceAccountId: 0 }))).toBe("bad_source_account");
    expect(code(payload({ items: [item({ openItemId: 0 })] }))).toBe("bad_item");
    expect(code(payload({ mode: "x" as "pay" }))).toBe("bad_mode");
    expect(code(payload({ kind: "x" as "batch" }))).toBe("bad_kind");
    expect(
      code(
        payload({
          kind: "batch",
          totalMinor: Number.MAX_SAFE_INTEGER,
          items: [
            item({ amountMinor: Number.MAX_SAFE_INTEGER }),
            item({ requestId: ID2, amountMinor: Number.MAX_SAFE_INTEGER }),
          ],
        }),
      ),
    ).toBe("bad_total");
  });
  it("accepts the largest safe amount", () => {
    expect(
      h(
        payload({
          items: [item({ amountMinor: Number.MAX_SAFE_INTEGER })],
          totalMinor: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
