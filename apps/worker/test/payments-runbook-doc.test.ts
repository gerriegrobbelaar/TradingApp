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

  it("F9a (S5): every secrets list names PAYMENTS_IBAN_KEY and EMAIL_API_KEY, and rotation says what it costs", () => {
    expect(deploy).toContain("**seven secrets**");
    expect(deploy).not.toContain("**five secrets**");
    const between = (from: string, to: string): string => {
      const a = deploy.indexOf(from);
      const b = deploy.indexOf(to, a + 1);
      expect(a, from).toBeGreaterThan(-1);
      expect(b, to).toBeGreaterThan(a);
      return deploy.slice(a, b);
    };
    const step5 = between("## Step 5. Set the secrets", "## Step 6. Apply the migrations");
    const staging = between("## Staging first", "## First sync procedure");
    const rotating = between("### Rotating secrets", "### Backup and restore");
    for (const [name, text] of [
      ["step 5", step5],
      ["staging first", staging],
      ["rotating", rotating],
    ] as const) {
      expect(text, name).toContain("PAYMENTS_IBAN_KEY");
      expect(text, name).toContain("EMAIL_API_KEY");
    }
    for (const word of ["iban_key_rotated", "paid before", "payee", "`ready`", "key_id"]) {
      expect(rotating, word).toContain(word);
    }
  });

  it("F9a (S3/S6): the runbook can be followed: two passes, a provisional mark, the deploy flag; no fault switch", () => {
    for (const w of [
      "Two passes",
      "provisional: true",
      "CF_ALLOW_PAYMENTS_ON=yes",
      "wrangler dev --env staging --remote",
      "migration 0030",
    ]) {
      expect(deploy, w).toContain(w);
    }
    expect(deploy).not.toMatch(/use the staging fault switch/);
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
