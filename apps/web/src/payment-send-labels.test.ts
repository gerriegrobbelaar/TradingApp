/// <reference types="vite/client" />
/**
 * F9c: every refusal and outcome code the worker's send path can answer has a sentence; every
 * settlement code has words; "Paid" is said for `booked` and nothing else; every status reason
 * has a sentence. Codes are READ FROM THE WORKER'S SOURCE, so a new code without words fails here.
 */
import { describe, expect, it } from "vitest";
import { PAYMENT_SETTLEMENTS } from "@camelthorn/core";
import { ApiError } from "./api";
import {
  PROVIDER_REJECT_FALLBACK,
  PROVIDER_REJECT_TEXT,
  REASON_TEXT,
  SETTLEMENT_FALLBACK,
  SETTLEMENT_TEXT,
  STATUS_TEXT,
  batchSettlement,
  displayStatus,
  eventText,
  isBooked,
  providerRejectText,
  reasonText,
  settlementText,
  subjectOf,
} from "./lib/payment-labels";
import {
  SEND_NEXT_TEXT,
  SEND_REFUSED_FALLBACK,
  SEND_RESULT_TEXT,
  SEND_TEXT,
  SEND_UNSURE_TEXT,
  describeSendError,
  rejectedReasonText,
  sendRefusalText,
  sendResultKey,
} from "./lib/payment-send-labels";
import { payment, batch } from "./test-fixtures-payments";

const raw = (g: Record<string, string>) => g;
const worker = raw(
  import.meta.glob(
    [
      "../../worker/src/payments/*.ts",
      "../../worker/src/revolut/gate.ts",
      "../../worker/src/revolut/request.ts",
    ],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>,
);
const src = (name: string): string => {
  const hit = Object.entries(worker).find(([k]) => k.endsWith(name));
  if (!hit) throw new Error(`worker file missing: ${name}`);
  return hit[1];
};
const all = (re: RegExp, text: string): string[] =>
  [...text.matchAll(re)].map((m) => m[1] as string);

/** Codes the submit routes answer as a refusal (409/404), read from the worker. */
function refusalCodes(): Set<string> {
  const out = new Set<string>();
  const submit = src("payments/submit.ts");
  for (const c of all(/\{ status: "refused", code: "([a-z_]+)" \}/g, submit)) out.add(c);
  // whyNot(): `return "x";` between its declaration and runSubmission
  const why = submit.slice(
    submit.indexOf("async function whyNot"),
    submit.indexOf("const SAFE_CODE"),
  );
  for (const c of all(/return "([a-z_]+)";/g, why)) out.add(c);
  for (const c of all(/return `approval_\$\{denial\}`/g, why)) out.add(c);
  // the gate's lease and the request validation
  const gate = src("revolut/gate.ts");
  const lease = gate.slice(
    gate.indexOf("acquirePaymentLease"),
    gate.indexOf("releasePaymentLease"),
  );
  for (const c of all(/code: "([a-z_]+)"/g, lease)) out.add(c);
  for (const c of all(/bad\("([a-z_]+)"\)/g, src("revolut/request.ts"))) {
    if (c === "payment_lease") out.add(c);
  }
  // the pre-checks right before sending
  for (const c of all(/throw new PaymentError\("([a-z_]+)"/g, src("payments/store.ts"))) {
    if (["controls_changed", "payload_changed"].includes(c)) out.add(c);
  }
  return out;
}

/** The ways the gate can be closed, as `payments_<reason>` (gate.ts). */
function gateClosedCodes(): string[] {
  const flag = src("payments/gate-flag.ts");
  const m = /export type GateClosedReason =([^;]+);/.exec(flag);
  return all(/"([a-z_]+)"/g, m?.[1] ?? "").map((r) => `payments_${r}`);
}

/** Codes of a request the submitter refused (`result.to === "rejected"`). */
function rejectedCodes(): Set<string> {
  const out = new Set<string>();
  const sub = src("payments/revolut-submitter.ts");
  for (const c of all(/rejected\("([a-z_]+)"\)/g, sub)) out.add(c);
  for (const c of all(/return "(prior_attempt_[a-z_]+)"/g, sub)) out.add(c);
  for (const c of all(/code: "(counterparty_[a-z_]+)"/g, sub)) out.add(c);
  return out;
}

describe("every refusal code of the send path has its own sentence", () => {
  it("finds a believable number of codes in the worker (the scan itself works)", () => {
    expect(refusalCodes().size).toBeGreaterThan(18);
    expect(gateClosedCodes().length).toBeGreaterThan(3);
    expect(rejectedCodes().size).toBeGreaterThan(5);
  });

  it("refusals", () => {
    const missing = [...refusalCodes()].filter((c) => sendRefusalText(c) === SEND_REFUSED_FALLBACK);
    // `approval_` + a denial is built from a template: those are listed below
    expect(missing).toEqual([]);
  });

  it("the gate closed codes", () => {
    for (const c of gateClosedCodes()) {
      expect(sendRefusalText(c), c).not.toBe(SEND_REFUSED_FALLBACK);
    }
  });

  it("approval denials (submit.ts builds approval_<denial>)", () => {
    for (const d of [
      "self_approval",
      "payload_changed",
      "approval_expired",
      "approver_inactive",
      "approver_lacks_role",
    ]) {
      expect(sendRefusalText(`approval_${d}`), d).not.toBe(SEND_REFUSED_FALLBACK);
    }
  });

  it("the codes named by the task, including the ones added by the safety work", () => {
    for (const c of [
      "busy",
      "prior_attempt_live",
      "prior_attempt_unchecked",
      "payment_lease",
      "pay_mode_not_verified",
      "submitter_unavailable",
      "requester_inactive",
      "controls_changed",
      "iban_binding_broken",
      "counterparty_account_ambiguous",
      "payments_disabled",
      "already_claimed",
      "no_revolut_connection",
      "gate_unavailable",
    ]) {
      expect(sendRefusalText(c), c).not.toBe(SEND_REFUSED_FALLBACK);
    }
  });

  it("a pre-check block after a colon is worded through the block map", () => {
    const t = sendRefusalText("precheck:invoice_not_approved");
    expect(t).toContain("This bill is not approved in Exact.");
    expect(t).toContain("Nothing was sent.");
    expect(sendRefusalText("precheck:brand_new_block")).toContain("Nothing was sent.");
  });

  it("an unknown code gets the one fixed sentence, an unreadable failure never promises 'nothing was sent'", () => {
    expect(sendRefusalText("brand_new")).toBe(SEND_REFUSED_FALLBACK);
    expect(sendRefusalText("__proto__")).toBe(SEND_REFUSED_FALLBACK);
    expect(describeSendError(new ApiError(409, "brand_new"))).toBe(SEND_REFUSED_FALLBACK);
    for (const e of [new ApiError(500, "internal"), new ApiError(502, "x"), new TypeError("x")]) {
      expect(describeSendError(e)).toBe(SEND_UNSURE_TEXT);
    }
    expect(SEND_UNSURE_TEXT.toLowerCase()).not.toContain("nothing was sent");
    expect(SEND_UNSURE_TEXT).toContain("Do not send it again");
    expect(SEND_UNSURE_TEXT).toContain("An administrator can check");
  });
});

describe("the bank-side outcomes", () => {
  it("every code the submitter rejects with has a sentence (the counterparty family shares one)", () => {
    for (const c of rejectedCodes()) {
      const t = providerRejectText(c);
      if (c.startsWith("counterparty_") && !(c in PROVIDER_REJECT_TEXT)) continue;
      expect(t, c).not.toBe(PROVIDER_REJECT_FALLBACK);
    }
    expect(providerRejectText("counterparty_duplicate")).toContain("could not be set up");
    expect(providerRejectText("provider_declined")).toBe(PROVIDER_REJECT_FALLBACK);
  });

  it("result.to maps to words, or to nothing", () => {
    expect(sendResultKey("submitted", "drafts")).toBe("submitted_drafts");
    expect(sendResultKey("submitted", "pay")).toBe("submitted_pay");
    expect(sendResultKey("rejected", "pay")).toBe("rejected");
    expect(sendResultKey("outcome_unknown", "drafts")).toBe("outcome_unknown");
    expect(sendResultKey("paid", "pay")).toBeNull();
    expect(sendResultKey("", "pay")).toBeNull();
    expect(SEND_NEXT_TEXT.drafts).toBe(
      "A draft is created in Revolut. You must approve it in the Revolut app. Nothing is paid until you do.",
    );
    expect(SEND_NEXT_TEXT.pay).toBe("The bank pays immediately.");
  });

  it("a rejected send is worded with the code after provider_rejected, :late or not", () => {
    expect(rejectedReasonText("provider_rejected:prior_attempt_live")).toContain(
      "do not pay again",
    );
    expect(rejectedReasonText("provider_rejected:prior_attempt_live:late")).toContain(
      "do not pay again",
    );
    expect(rejectedReasonText("provider_rejected:whatever")).toBe(PROVIDER_REJECT_FALLBACK);
  });
});

describe("status reasons", () => {
  it("the codes the worker writes as a reason have words", () => {
    const recon = src("payments/reconcile.ts");
    const codes = new Set<string>(["resolved_not_sent", "draft_expired", "bank_failed"]);
    for (const c of all(/"(bank_[a-z]+|draft_expired|resolved_not_sent)"/g, recon)) {
      if (c !== "bank_completed") codes.add(c); // bank_completed is the paid case, not a reason to end
    }
    for (const c of ["bank_declined", "bank_reverted", "approver_rejected", "expired", "cancelled"])
      codes.add(c);
    for (const c of codes) expect(Object.keys(REASON_TEXT), c).toContain(c);
  });

  it("draft_expired says what to do in the Revolut app", () => {
    expect(reasonText("draft_expired")).toBe(
      "The draft was not approved in time. If it is still in the Revolut app, delete it there before asking for a new payment.",
    );
  });

  it("the other P9b reasons", () => {
    expect(reasonText("bank_declined")).toContain("declined");
    expect(reasonText("bank_reverted")).toContain("reversed");
    expect(reasonText("resolved_not_sent")).toContain("never sent");
    expect(reasonText("provider_rejected:prior_attempt_unchecked")).toContain("could not check");
    expect(reasonText("brand_new")).toBe("No further reason was recorded.");
    expect(reasonText(null)).toBeNull();
    expect(reasonText("")).toBeNull();
  });

  it("timeline words for the reconciliation codes", () => {
    for (const c of [
      "reconciled_pending",
      "bank_completed",
      "bank_failed",
      "bank_declined",
      "bank_reverted",
      "draft_expired",
      "resolved_not_sent",
    ]) {
      expect(eventText(c, "failed"), c).not.toMatch(/^Status changed/);
    }
  });
});

describe("Paid means bank confirmed AND booked in Exact", () => {
  it("one label map from the settlement codes, the same six as core", () => {
    expect(Object.keys(SETTLEMENT_TEXT)).toEqual([...PAYMENT_SETTLEMENTS]);
  });

  it("only `booked` is Paid", () => {
    for (const code of PAYMENT_SETTLEMENTS) {
      const t = displayStatus({ status: "paid", settlement: code });
      if (code === "booked") expect(t.label).toBe("Paid");
      else expect(t.label, code).not.toBe("Paid");
      expect(isBooked("paid", code)).toBe(code === "booked");
    }
  });

  it("the steps are named: waiting for the bank line, matched elsewhere, booking pending", () => {
    expect(displayStatus({ status: "paid", settlement: "awaiting_bank_line" })).toMatchObject({
      label: "Paid at the bank, booking pending",
      step: expect.stringContaining("bank line"),
    });
    expect(displayStatus({ status: "paid", settlement: "match_other_invoice" })).toMatchObject({
      label: "Paid at the bank, matched elsewhere",
      tone: "warn",
    });
    expect(displayStatus({ status: "paid", settlement: "awaiting_booking" }).step).toContain(
      "booking in Exact is switched off",
    );
  });

  it("an unknown, missing or misplaced settlement is never Paid", () => {
    for (const s of ["brand_new", "", null, undefined, "not_paid", "__proto__"]) {
      const t = displayStatus({ status: "paid", settlement: s as string | null | undefined });
      expect(t.label, String(s)).toBe("Paid at the bank, booking pending");
    }
    expect(settlementText("brand_new")).toBe(SETTLEMENT_FALLBACK);
    expect(SETTLEMENT_FALLBACK.step).toContain("We cannot tell");
  });

  it("booked on any other status is not Paid either", () => {
    for (const status of Object.keys(STATUS_TEXT)) {
      if (status === "paid") continue;
      expect(displayStatus({ status, settlement: "booked" }).label, status).not.toBe("Paid");
    }
  });

  it("submitted in drafts mode tells you to approve it in Revolut; in pay mode it is Paying", () => {
    const d = displayStatus({ status: "submitted", mode: "drafts" });
    expect(d.label).toBe("Waiting for approval in Revolut");
    expect(d.meaning).toContain("Open the Revolut app and approve it there");
    expect(displayStatus({ status: "submitted", mode: "pay" }).label).toBe("Paying");
    expect(displayStatus({ status: "outcome_unknown", mode: "drafts" }).label).toBe(
      "Not confirmed",
    );
    expect(displayStatus({ status: "ready" }).label).toBe("Approved, not sent yet");
  });

  it("a batch is as far as its least advanced item", () => {
    const item = (settlement: (typeof PAYMENT_SETTLEMENTS)[number]) =>
      payment({ status: "paid", settlement });
    expect(batchSettlement([item("booked"), item("booked")])).toBe("booked");
    expect(batchSettlement([item("booked"), item("awaiting_match")])).toBe("awaiting_match");
    expect(batchSettlement([item("awaiting_booking"), item("awaiting_bank_line")])).toBe(
      "awaiting_bank_line",
    );
    expect(batchSettlement([])).toBe("unreadable");
    expect(batchSettlement([{ settlement: "weird" }, item("booked")])).toBe("unreadable");
    const paidBatch = batch({
      status: "paid",
      items: [item("booked"), item("awaiting_match")],
    });
    expect(displayStatus(subjectOf(paidBatch)).label).toBe("Paid at the bank, booking pending");
    const doneBatch = batch({ status: "paid", items: [item("booked"), item("booked")] });
    expect(displayStatus(subjectOf(doneBatch)).label).toBe("Paid");
  });
});

describe("the new wording rules", () => {
  it("no exclamation marks, no raw codes, sentences end with a full stop", () => {
    const sentences = [
      ...Object.values(SEND_TEXT),
      ...Object.values(SEND_RESULT_TEXT),
      ...Object.values(SEND_NEXT_TEXT),
      SEND_REFUSED_FALLBACK,
      SEND_UNSURE_TEXT,
      ...Object.values(REASON_TEXT),
      ...Object.values(PROVIDER_REJECT_TEXT),
      PROVIDER_REJECT_FALLBACK,
      ...Object.values(SETTLEMENT_TEXT).flatMap((s) => [s.label, s.step]),
      SETTLEMENT_FALLBACK.step,
    ];
    for (const s of sentences) {
      expect(s, s).not.toContain("!");
      expect(s, s).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(s[0], s).toMatch(/[A-Z]/);
    }
    for (const s of [
      ...Object.values(SEND_TEXT),
      ...Object.values(SEND_RESULT_TEXT),
      ...Object.values(REASON_TEXT),
      ...Object.values(PROVIDER_REJECT_TEXT),
    ]) {
      expect(s, s).toMatch(/\.$/);
    }
  });
});

describe("review F9c: the codes the scan above cannot see", () => {
  it("the database's own guards on the claim batch (payment_err:<code> in the migrations) are worded", () => {
    // dbErrorCode() turns a trigger refusal of the claim into a `refused` code; the reachable ones:
    for (const c of [
      "bad_transition",
      "final",
      "claim_subject",
      "approval_required",
      "not_approved",
    ]) {
      expect(sendRefusalText(c), c).not.toBe(SEND_REFUSED_FALLBACK);
    }
  });

  it("recheckBeforeSubmit answers with a PaymentError code: each says nothing was sent", () => {
    for (const c of ["blocked", "conflict", "not_found", "iban_missing", "iban_cache_stale"]) {
      const t = sendRefusalText(c);
      expect(t, c).not.toBe(SEND_REFUSED_FALLBACK);
      expect(t.toLowerCase(), c).toMatch(/not sent|nothing was sent|no longer exists/);
    }
  });

  it("F9a's pending codes (requester_inactive, iban_key_rotated) are worded already", () => {
    expect(sendRefusalText("requester_inactive")).toContain("not sent");
    expect(sendRefusalText("iban_key_rotated")).toContain("nothing was sent");
  });

  it("a 403 is a refusal; a 409/404 without a readable code is NOT", () => {
    expect(describeSendError(new ApiError(403, "forbidden"))).toContain("nothing was sent");
    expect(describeSendError(new ApiError(409, "request_failed"))).toBe(SEND_UNSURE_TEXT);
    expect(describeSendError(new ApiError(404, "request_failed"))).toBe(SEND_UNSURE_TEXT);
    expect(describeSendError(new ApiError(429, "rate_limited"))).toBe(SEND_UNSURE_TEXT);
  });

  it("a batch whose items do not all arrive is never Paid", () => {
    const booked = payment({ status: "paid", settlement: "booked" });
    const partial = batch({ status: "paid", itemCount: 3, items: [booked, booked] });
    expect(displayStatus(subjectOf(partial)).label).toBe("Paid at the bank, booking pending");
    const whole = batch({ status: "paid", itemCount: 2, items: [booked, booked] });
    expect(displayStatus(subjectOf(whole)).label).toBe("Paid");
    // a paid batch with an item the bank did not pay is not booked
    const mixed = batch({
      status: "paid",
      itemCount: 2,
      items: [booked, payment({ status: "failed", settlement: "not_paid" })],
    });
    expect(displayStatus(subjectOf(mixed)).label).not.toBe("Paid");
  });
});
