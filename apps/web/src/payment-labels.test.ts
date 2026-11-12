/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import {
  APPROVAL_REASONS,
  BATCH_BLOCK_CODES,
  PAYMENT_BLOCK_CODES,
  PAYMENT_STATUSES,
  PAYMENT_WARNING_CODES,
  PAYMENTS_VERIFY_CHECKS,
  DEFAULT_PAYMENT_SETTINGS,
} from "@camelthorn/core";
import { ApiError } from "./api";
import {
  APPROVAL_REASON_FALLBACK,
  BATCH_BLOCK_TEXT,
  BLOCKER_TEXT,
  BLOCK_FALLBACK,
  BLOCK_TEXT,
  ERROR_FALLBACK,
  ERROR_TEXT,
  SETTING_FIELD_TEXT,
  STATUS_TEXT,
  VERIFY_CHECK_TEXT,
  WARNING_TEXT,
  APPROVAL_REASON_TEXT,
  approvalReasonText,
  blockText,
  blocksOf,
  describePaymentError,
  eventText,
  itemBlocksOf,
  reasonText,
  statusText,
  warningText,
} from "./lib/payment-labels";
import { maskPaymentsAnswer } from "./api-payments";

const workerSrc = import.meta.glob("../../worker/src/payments/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const sentences = (): string[] => [
  ...Object.values(BLOCK_TEXT).flatMap((t) => [t.what, t.todo]),
  ...Object.values(BATCH_BLOCK_TEXT).flatMap((t) => [t.what, t.todo]),
  BLOCK_FALLBACK.what,
  BLOCK_FALLBACK.todo,
  ...Object.values(WARNING_TEXT),
  ...Object.values(APPROVAL_REASON_TEXT),
  ...Object.values(STATUS_TEXT).map((s) => s.meaning),
  ...Object.values(ERROR_TEXT),
  ERROR_FALLBACK,
  ...Object.values(BLOCKER_TEXT),
  ...Object.values(VERIFY_CHECK_TEXT),
];

describe("every stable code has words", () => {
  it("block codes of core", () => {
    for (const c of PAYMENT_BLOCK_CODES) {
      expect(Object.keys(BLOCK_TEXT), c).toContain(c);
      expect(blockText(c).what.length).toBeGreaterThan(15);
      expect(blockText(c).todo.length).toBeGreaterThan(10);
    }
    expect(Object.keys(BLOCK_TEXT).sort()).toEqual([...PAYMENT_BLOCK_CODES].sort());
  });
  it("batch block codes", () => {
    expect(Object.keys(BATCH_BLOCK_TEXT).sort()).toEqual([...BATCH_BLOCK_CODES].sort());
  });
  it("warnings, approval reasons, statuses and verification checks", () => {
    expect(Object.keys(WARNING_TEXT).sort()).toEqual([...PAYMENT_WARNING_CODES].sort());
    expect(Object.keys(APPROVAL_REASON_TEXT).sort()).toEqual([...APPROVAL_REASONS].sort());
    expect(Object.keys(STATUS_TEXT).sort()).toEqual([...PAYMENT_STATUSES].sort());
    expect(Object.keys(VERIFY_CHECK_TEXT).sort()).toEqual([...PAYMENTS_VERIFY_CHECKS].sort());
    expect(Object.keys(SETTING_FIELD_TEXT).sort()).toEqual(
      Object.keys(DEFAULT_PAYMENT_SETTINGS).sort(),
    );
  });
  it("the worker's blockers", () => {
    const src = workerSrc["../../worker/src/payments/settings.ts"] ?? "";
    const m = /export type PaymentsBlocker =([^;]+);/.exec(src);
    expect(m).not.toBeNull();
    const codes = [...(m?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1] as string);
    expect(codes.length).toBeGreaterThan(5);
    expect(Object.keys(BLOCKER_TEXT).sort()).toEqual([...codes].sort());
  });
  it("every refusal code the worker's payment routes can send", () => {
    const files = Object.entries(workerSrc).filter(([n]) => !n.endsWith("submit.ts"));
    expect(files.length).toBeGreaterThan(5);
    const found = new Set<string>();
    for (const [, src] of files) {
      for (const m of src.matchAll(/PaymentError\(\s*"([a-z_]+)"/g)) found.add(m[1] as string);
    }
    const store = workerSrc["../../worker/src/payments/store.ts"] ?? "";
    const denial = /DENIAL_STATUS[^{]*\{([^}]+)\}/.exec(store)?.[1] ?? "";
    for (const m of denial.matchAll(/^\s*([a-z_]+):/gm)) found.add(m[1] as string);
    expect(found.size).toBeGreaterThan(20);
    const missing = [...found].filter(
      (c) =>
        !c.startsWith("bad_") &&
        c !== "step_up_required" &&
        c !== "step_up_stale" &&
        !(c in ERROR_TEXT),
    );
    expect(missing).toEqual([]);
  });
});

describe("unknown codes are never blank", () => {
  it("gets one fixed generic sentence", () => {
    expect(blockText("brand_new_code")).toBe(BLOCK_FALLBACK);
    expect(warningText("brand_new_code").length).toBeGreaterThan(10);
    expect(approvalReasonText("brand_new_code")).toBe(APPROVAL_REASON_FALLBACK);
    expect(statusText("brand_new").label).toBe("Unknown");
    expect(eventText("brand_new", "paid")).toBe("Status changed to paid");
    expect(reasonText("brand_new")).toBe("No further reason was recorded.");
    expect(blockText("__proto__")).toBe(BLOCK_FALLBACK);
    expect(describePaymentError(new ApiError(500, "brand_new"))).toBe(ERROR_FALLBACK);
    expect(describePaymentError(new ApiError(403, "brand_new"))).toBe(ERROR_TEXT["forbidden"]);
    expect(describePaymentError(new TypeError("x"))).toContain("Could not reach the server");
  });
});

describe("wording rules", () => {
  it("no exclamation marks, no raw snake_case codes, sentences end with a full stop", () => {
    for (const s of sentences()) {
      expect(s, s).not.toContain("!");
      expect(s, s).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(s, s).toMatch(/[.:]$/);
      expect(s[0], s).toMatch(/[A-Z]/);
    }
  });
  it("the unknown-outcome sentence is the agreed one", () => {
    expect(statusText("outcome_unknown").label).toBe("Not confirmed");
  });
  it("§4.3 status words", () => {
    expect(statusText("draft").label).toBe("Open");
    expect(statusText("pending_approval").label).toBe("Waiting for approval");
    for (const s of ["ready", "submitting", "submitted"])
      expect(statusText(s).label).toBe("Paying");
    expect(statusText("paid").label).toBe("Paid");
    expect(statusText("failed").label).toBe("Failed");
  });
});

describe("refusal bodies", () => {
  it("blocksOf reads the codes of a 422 blocked answer and nothing else", () => {
    const e = new ApiError(422, "blocked", undefined, undefined, { blocks: ["a_b", "c_d"] });
    expect(blocksOf(e)).toEqual(["a_b", "c_d"]);
    expect(blocksOf(new ApiError(409, "blocked"))).toBeNull();
    expect(blocksOf(new Error("x"))).toBeNull();
    expect(itemBlocksOf(new Error("x"))).toEqual([]);
  });
});

describe("maskPaymentsAnswer", () => {
  const FULL = "NL91ABNA0417164300";
  it("masks full IBANs in text but leaves hex identifiers (which can look like IBANs) alone", () => {
    const hash = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
    const out = maskPaymentsAnswer({
      payment: {
        payloadHash: hash,
        ibanFingerprint: hash,
        ibanFingerprintShort: "ab12cd34ef56ab12",
        requestId: "ab12cd34-ef56-4000-8000-000000000000",
        reference: `Invoice 1 ${FULL}`,
        note: [FULL],
      },
    });
    expect(out.payment.payloadHash).toBe(hash);
    expect(out.payment.ibanFingerprint).toBe(hash);
    expect(out.payment.ibanFingerprintShort).toBe("ab12cd34ef56ab12");
    expect(JSON.stringify(out)).not.toContain(FULL);
  });
});
