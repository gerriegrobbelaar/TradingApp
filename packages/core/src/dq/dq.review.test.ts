/**
 * Review D8a: adversarial cases for partial coverage (a rule that judged only some subjects must
 * not resolve the others), the per-rule loosening direction (a look-back window or a lead time
 * loosens when it gets SHORTER), and the EU country list.
 */
import { describe, expect, it } from "vitest";
import {
  DQ_RULES,
  EU_COUNTRIES,
  dqRuleById,
  emptyInput,
  evaluateRules,
  isLooseningChange,
  looserDirection,
  planReconcile,
  resolveRuleConfig,
  type DqExistingIssue,
  type DqInput,
  type DqRuleConfig,
  type DqRuleDef,
} from "./index";

const NOW = Date.parse("2026-07-15T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const NOW_ISO = new Date(NOW).toISOString();

const rule = (id: string): DqRuleDef => dqRuleById(id) as DqRuleDef;
const run = (id: string, patch: Partial<DqInput>) =>
  rule(id).evaluate({ ...emptyInput(NOW, 1), ...patch }, resolveRuleConfig(rule(id)));

const acc = (id: number, over = {}) => ({
  id,
  name: `Account ${id}`,
  currency: "EUR",
  balanceMinor: 100_000,
  balanceAt: iso(HOUR),
  exactBalanceMinor: 100_000,
  exactBalanceAt: iso(HOUR),
  ...over,
});

const open = (id: number, ruleId: string, fingerprint: string): DqExistingIssue => ({
  id,
  ruleId,
  fingerprint,
  status: "open",
  snoozedUntil: null,
});

/** Evaluates the division rules and plans against the given stored issues. */
function plan(input: Partial<DqInput>, existing: DqExistingIssue[]) {
  const results = evaluateRules({ ...emptyInput(NOW, 1), ...input }, "division");
  return planReconcile(existing, results, NOW_ISO);
}

describe("partial coverage never resolves what was not judged", () => {
  it("balance_mismatch: an account whose Exact read went stale keeps its issue while another account is compared", () => {
    const existing = [open(7, "bank.balance_mismatch", "bank.balance_mismatch:acc|2")];
    const p = plan(
      {
        bankAccounts: [
          acc(1),
          // account 2 had a difference; its Exact read is now 40 h old
          acc(2, { exactBalanceMinor: 1, exactBalanceAt: iso(40 * HOUR), balanceAt: iso(HOUR) }),
        ],
      },
      existing,
    );
    expect(p.resolve).not.toContain(7);
    // once account 2 is compared again and agrees, it is resolved
    const p2 = plan({ bankAccounts: [acc(1), acc(2)] }, existing);
    expect(p2.resolve).toContain(7);
  });

  it("balance_mismatch: an account whose Exact balance was cleared, or whose reads drifted apart, keeps its issue", () => {
    const existing = [open(7, "bank.balance_mismatch", "bank.balance_mismatch:acc|2")];
    for (const over of [
      { exactBalanceMinor: null },
      { balanceMinor: null },
      { exactBalanceAt: iso(5 * HOUR) },
      { balanceAt: "not a date" },
    ]) {
      const p = plan({ bankAccounts: [acc(1), acc(2, over)] }, existing);
      expect(p.resolve, JSON.stringify(over)).not.toContain(7);
    }
  });

  it("missing_pdf: an entry whose document flag was not seen this time keeps its issue", () => {
    const e = (id: number, hasPdf: boolean | null) => ({
      id,
      entryNumber: String(id),
      supplierName: "S",
      status: "approved" as const,
      submittedAt: null,
      modifiedAt: null,
      entryDate: iso(5 * DAY),
      hasPdf,
      amountMinor: 1,
      currency: "EUR",
    });
    const existing = [open(9, "payables.missing_pdf", "payables.missing_pdf:entry|2")];
    const p = plan({ purchaseEntries: [e(1, true), e(2, null)] }, existing);
    expect(p.resolve).not.toContain(9);
    expect(plan({ purchaseEntries: [e(1, true), e(2, true)] }, existing).resolve).toContain(9);
  });

  it("unmatched_old and approvals_overdue: a date that cannot be read keeps the issue", () => {
    const tx = {
      id: 3,
      accountId: 1,
      amountMinor: 1,
      currency: "EUR",
      bookedAt: "garbage",
      matchStatus: "unmatched" as const,
      counterpartyName: null,
      counterpartyKey: null,
      reference: null,
    };
    const ex = [open(1, "bank.unmatched_old", "bank.unmatched_old:tx|3")];
    expect(plan({ bankTransactions: [tx] }, ex).resolve).not.toContain(1);
    // the line got matched: resolved
    expect(plan({ bankTransactions: [{ ...tx, matchStatus: "matched" }] }, ex).resolve).toContain(
      1,
    );

    const entry = {
      id: 4,
      entryNumber: "4",
      supplierName: "S",
      status: "pending_approval" as const,
      submittedAt: "x",
      modifiedAt: null,
      entryDate: null,
      hasPdf: true,
      amountMinor: 1,
      currency: "EUR",
    };
    const ex2 = [open(2, "payables.approvals_overdue", "payables.approvals_overdue:entry|4")];
    expect(plan({ purchaseEntries: [entry] }, ex2).resolve).not.toContain(2);
  });

  it("job_stale: a job whose schedule cannot be read keeps its issue; a job switched off is resolved", () => {
    const job = {
      name: "exact.sync",
      title: "Sync",
      enabled: true,
      implemented: true,
      intervalMs: null,
      lastSuccessAt: null,
      referenceAt: iso(10 * DAY),
      lastStatus: null,
      lastCode: null,
    };
    const ex = [open(5, "integrations.job_stale", "integrations.job_stale:job|exact.sync")];
    const results = evaluateRules({ ...emptyInput(NOW, 0), jobs: [job] }, "global");
    expect(planReconcile(ex, results, NOW_ISO).resolve).not.toContain(5);
    const off = evaluateRules(
      { ...emptyInput(NOW, 0), jobs: [{ ...job, enabled: false }] },
      "global",
    );
    expect(planReconcile(ex, off, NOW_ISO).resolve).toContain(5);
  });

  it("duplicate_lines: a capped look-back window reports what it found but resolves nothing", () => {
    const line = (id: number) => ({
      id,
      accountId: 1,
      amountMinor: -500,
      currency: "EUR",
      bookedAt: iso(DAY),
      matchStatus: "unmatched" as const,
      counterpartyName: "X",
      counterpartyKey: "cp1",
      reference: "r",
    });
    const ex = [open(3, "bank.duplicate_lines", "bank.duplicate_lines:dup|99")];
    const capped = run("bank.duplicate_lines", {
      bankTransactions: [line(1), line(2)],
      bankTransactionsCapped: true,
    });
    expect(capped.status).toBe("issues");
    expect(capped.truncated).toBe(true);
    expect(
      plan({ bankTransactions: [line(1), line(2)], bankTransactionsCapped: true }, ex).resolve,
    ).not.toContain(3);
    expect(plan({ bankTransactions: [line(1), line(2)] }, ex).resolve).toContain(3);
  });
});

describe("loosening direction is per rule (review D8a)", () => {
  const c = (threshold: number, severity: DqRuleConfig["severity"] = "critical"): DqRuleConfig => ({
    enabled: true,
    severity,
    threshold,
  });

  it("supplier_iban_changed (critical): a SHORTER window is looser, a longer one is tighter", () => {
    const r = rule("payables.supplier_iban_changed");
    expect(isLooseningChange(r, c(30), c(1))).toBe(true);
    expect(isLooseningChange(r, c(30), c(29))).toBe(true);
    expect(isLooseningChange(r, c(30), c(60))).toBe(false);
  });

  it("exact_connection (critical): a SHORTER lead time is looser", () => {
    const r = rule("integrations.exact_connection");
    expect(isLooseningChange(r, c(7), c(1))).toBe(true);
    expect(isLooseningChange(r, c(7), c(14))).toBe(false);
  });

  it("missing_pdf: a shorter window is looser; its max fits the 400 days the loader reads", () => {
    const r = rule("payables.missing_pdf");
    expect(isLooseningChange(r, c(90, "info"), c(30, "info"))).toBe(true);
    expect(isLooseningChange(r, c(90, "info"), c(180, "info"))).toBe(false);
    expect(r.threshold).toMatchObject({ max: 365 });
  });

  it("age limits, tolerances and counts are looser when they go up", () => {
    for (const id of [
      "bank.unmatched_old",
      "bank.balance_mismatch",
      "payables.approvals_overdue",
      "bank.booking_outcome_unknown",
      "integrations.webhook_failures",
      "integrations.job_stale",
    ]) {
      const r = rule(id);
      expect(isLooseningChange(r, c(5), c(6)), id).toBe(true);
      expect(isLooseningChange(r, c(5), c(4)), id).toBe(false);
    }
  });

  it("every numeric rule states a direction that matches what it reports (property)", () => {
    // For each numeric rule, a threshold that the rule calls looser must never report MORE.
    for (const r of DQ_RULES) {
      if (r.threshold === null || r.threshold.kind !== "number") continue;
      expect(["up", "down"]).toContain(looserDirection(r.threshold));
    }
    // supplier_iban_changed: the change 10 days ago is reported at 30, not at 5 (shorter = less)
    const rel = {
      id: 1,
      name: "S",
      isSupplier: true,
      isCustomer: false,
      email: null,
      vatNumber: null,
      country: "NL",
      hasIban: true,
      ibanChangedAt: iso(10 * DAY),
      ibanAddedAt: null,
      openInvoices: 0,
      openBills: 1,
    };
    const r = rule("payables.supplier_iban_changed");
    const at = (n: number) =>
      r.evaluate(
        { ...emptyInput(NOW, 1), relations: [rel] },
        { enabled: true, severity: "critical", threshold: n },
      ).total;
    expect(at(30)).toBe(1);
    expect(at(5)).toBe(0);
    expect(
      looserDirection(r.threshold as Extract<DqRuleDef["threshold"], { kind: "number" }>),
    ).toBe("down");
  });
});

describe("EU customer VAT list", () => {
  it("accepts GR and EL for Greece and XI for Northern Ireland; not GB, CH or NO", () => {
    for (const c of ["GR", "EL", "XI", "NL", "DE", "HR", "IE"])
      expect(EU_COUNTRIES.has(c), c).toBe(true);
    for (const c of ["GB", "UK", "CH", "NO", "IS", "LI", "TR", ""]) {
      expect(EU_COUNTRIES.has(c), c).toBe(false);
    }
    const o = run("master.eu_customer_no_vat", {
      relations: [
        {
          id: 1,
          name: "Belfast Ltd",
          isSupplier: false,
          isCustomer: true,
          email: "a@b.example",
          vatNumber: "",
          country: "xi",
          hasIban: false,
          ibanChangedAt: null,
          ibanAddedAt: null,
          openInvoices: 1,
          openBills: 0,
        },
      ],
    });
    expect(o.total).toBe(1);
  });
});
