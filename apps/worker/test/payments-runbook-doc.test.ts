/**
 * The sandbox runbook has ONE source (PAYMENTS_VERIFY_RUNBOOK in packages/core); docs/DEPLOY.md prints
 * it verbatim. This fails when either changes alone (P9b, ADR 0050).
 */
import { paymentsRunbookText, PAYMENTS_VERIFY_CHECKS } from "@camelthorn/core";
import { describe, expect, it } from "vitest";
import deploy from "../../../docs/DEPLOY.md?raw";
import adr from "../../../docs/decisions/0050-revolut-payment-execution.md?raw";

describe("payments runbook documentation", () => {
  it("DEPLOY.md contains the runbook text from the constant, verbatim", () => {
    expect(deploy).toContain(paymentsRunbookText());
  });

  it("every check code is in DEPLOY.md and the lost-answer drill is called mandatory", () => {
    for (const c of PAYMENTS_VERIFY_CHECKS) expect(deploy).toContain(c);
    expect(deploy).toMatch(/lost-answer drill is mandatory/);
  });

  it("the ADR lists every A-item and a failure matrix with the six points of the task", () => {
    for (let i = 1; i <= 17; i++) expect(adr).toContain(`**A${i}**`);
    for (const point of [
      "Before the counterparty",
      "After the counterparty, before the send",
      "Before the send",
      "During the send",
      "After the send, before the persist",
      "Reconcile:",
    ]) {
      expect(adr).toContain(point);
    }
  });
});
