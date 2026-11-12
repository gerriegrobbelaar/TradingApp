import { describe, expect, it } from "vitest";
import {
  PAYMENTS_PAY_ONLY_CHECK,
  PAYMENTS_VERIFY_CHECKS,
  PAYMENTS_VERIFY_RUNBOOK,
  paymentsRunbookText,
  sameVerifyChecks,
  verifyCoversMode,
} from "./index";

describe("payments verification checklist (P9b)", () => {
  it("lists the Revolut checks of ADR 0050 in runbook order", () => {
    expect([...PAYMENTS_VERIFY_CHECKS]).toEqual([
      "revolut_plan_known",
      "sandbox_counterparty_roundtrip",
      "counterparty_lookup_probe",
      "sandbox_draft_roundtrip",
      "draft_lifecycle_probe",
      "sandbox_pay_roundtrip",
      "request_id_idempotency_replay",
      "lost_answer_lookup_drill",
      "reference_charset_probe",
      "amount_format_probe",
      "webhook_state_sequence",
      "four_eyes_approver_accounts_checked",
      "first_iban_verified_out_of_band",
      "approval_mapping_verified_in_exact",
      "limits_reviewed_by_finance_lead",
    ]);
  });

  it("has one runbook entry per check, with steps and a pass condition, and no extra entries", () => {
    expect(Object.keys(PAYMENTS_VERIFY_RUNBOOK).sort()).toEqual([...PAYMENTS_VERIFY_CHECKS].sort());
    for (const c of PAYMENTS_VERIFY_CHECKS) {
      const e = PAYMENTS_VERIFY_RUNBOOK[c];
      expect(e.title.length, c).toBeGreaterThan(5);
      expect(e.steps.length, c).toBeGreaterThan(0);
      expect(e.pass.length, c).toBeGreaterThan(5);
    }
    const text = paymentsRunbookText();
    for (const c of PAYMENTS_VERIFY_CHECKS) expect(text).toContain(c);
  });

  it("covers every A-item the review found untested (A8, A10, A11, A14, A16, payee name, fees)", () => {
    const text = paymentsRunbookText();
    for (const w of ["A8", "A10", "A11", "A14", "A16", "Payee-name verification", "S13"]) {
      expect(text, w).toContain(w);
    }
    // the staging fault switch never existed: the drill must not point at it
    expect(text).not.toMatch(/fault switch/i);
  });

  it("the pay roundtrip is optional in a mark but required to cover the pay mode", () => {
    const all = [...PAYMENTS_VERIFY_CHECKS];
    const noPay = all.filter((c) => c !== PAYMENTS_PAY_ONLY_CHECK);
    expect(sameVerifyChecks(all)).toBe(true);
    expect(sameVerifyChecks(noPay)).toBe(true);
    expect(verifyCoversMode(all, "pay")).toBe(true);
    expect(verifyCoversMode(all, "drafts")).toBe(true);
    expect(verifyCoversMode(noPay, "drafts")).toBe(true);
    expect(verifyCoversMode(noPay, "pay")).toBe(false);
  });

  it("refuses a missing required check, a duplicate, an unknown code and a non-string", () => {
    const all = [...PAYMENTS_VERIFY_CHECKS];
    expect(sameVerifyChecks(all.slice(1))).toBe(false);
    expect(sameVerifyChecks([...all, all[0]])).toBe(false);
    expect(sameVerifyChecks([...all, "extra"])).toBe(false);
    expect(sameVerifyChecks([...all.slice(1), 5])).toBe(false);
    expect(sameVerifyChecks([])).toBe(false);
    expect(sameVerifyChecks(all.filter((c) => c !== "lost_answer_lookup_drill"))).toBe(false);
  });
});
