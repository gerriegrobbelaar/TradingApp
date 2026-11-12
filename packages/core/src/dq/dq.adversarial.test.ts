import { describe, expect, it } from "vitest";
import {
  DQ_RULES,
  MAX_ISSUES_PER_RULE,
  emptyInput,
  evaluateRules,
  planCounts,
  planReconcile,
  type DqExistingIssue,
  type DqInput,
  type DqIssue,
  type DqRuleResult,
} from "./index";

const NOW = Date.parse("2026-07-15T10:00:00Z");
const DAY = 86_400_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const FULL_IBAN = "NL91ABNA0417164300";
const SPACED_IBAN = "NL91 ABNA 0417 1643 00";

const ROW_TX = (i: number, over = {}) => ({
  id: i,
  accountId: 1,
  amountMinor: -(i + 1),
  currency: "EUR",
  bookedAt: iso(30 * DAY),
  matchStatus: "unmatched" as const,
  counterpartyName: `Cp ${i}`,
  counterpartyKey: FULL_IBAN,
  reference: `ref ${i}`,
  ...over,
});

function all(input: DqInput): DqRuleResult[] {
  return [...evaluateRules(input, "division"), ...evaluateRules(input, "global")];
}

describe("adversarial inputs", () => {
  it("empty arrays: every rule is ok, not_available or not_configured, never issues", () => {
    const input: DqInput = {
      ...emptyInput(NOW, 1),
      bankAccounts: [],
      bankTransactions: [],
      bookedMatches: [],
      booking: {
        outcomeUnknown: 0,
        manualRequired: 0,
        alreadyMatchedInExact: 0,
        staleSettlements: 0,
      },
      openItems: [],
      purchaseEntries: [],
      relations: [],
      fx: {
        newestRateDate: "2026-07-14",
        stale: false,
        staleReason: null,
        workingDaysOld: 1,
        currenciesWithoutRate: [],
        unresolvedConflicts: [],
      },
      ledger: { suspense: [], closedPeriodBookings: null },
      jobs: [],
      webhook: { rejected24h: 0, errored24h: 0 },
      exactConnection: { status: "active", lastError: null, refreshExpiresAt: null },
      exactBudget: { dailyLimit: 5000, calls: 0, remaining: null },
    };
    for (const r of all(input)) {
      expect(r.issues, r.ruleId).toEqual([]);
      expect(["ok", "not_available", "not_configured"], r.ruleId).toContain(r.status);
      // a status of ok must come from data that was actually loaded
      if (r.status === "ok") expect(r.checked, r.ruleId).toBeGreaterThanOrEqual(0);
    }
  });

  it("a huge input is capped, flagged truncated, and keeps the oldest first", () => {
    const n = MAX_ISSUES_PER_RULE + 400;
    const rows = Array.from({ length: n }, (_, i) =>
      ROW_TX(i + 1, { bookedAt: iso((10 + i) * 60_000 + 6 * DAY) }),
    );
    const t0 = Date.now();
    const out = evaluateRules({ ...emptyInput(NOW, 1), bankTransactions: rows }, "division");
    const r = out.find((x) => x.ruleId === "bank.unmatched_old") as DqRuleResult;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.issues).toHaveLength(MAX_ISSUES_PER_RULE);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(n);
    // the oldest line (largest i) leads
    expect(r.issues[0]?.fingerprint).toBe(`bank.unmatched_old:tx|${n}`);
  });

  it("duplicates in the data give one issue per fingerprint, and equal input gives equal output", () => {
    const rows = [ROW_TX(1), ROW_TX(1), ROW_TX(1)];
    const a = evaluateRules({ ...emptyInput(NOW, 1), bankTransactions: rows }, "division");
    const b = evaluateRules({ ...emptyInput(NOW, 1), bankTransactions: rows }, "division");
    const r = a.find((x) => x.ruleId === "bank.unmatched_old") as DqRuleResult;
    expect(r.issues).toHaveLength(1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const fps = a.flatMap((x) => x.issues.map((i) => i.fingerprint));
    expect(new Set(fps).size).toBe(fps.length);
  });

  it("unicode, emoji, control characters, RTL marks and very long names are cleaned and capped", () => {
    const nasty = `Zoë ✨ \u202eevil\u202c\u0000\u0007 ${"x".repeat(500)} 日本語 \u{1F600}`;
    const out = evaluateRules(
      {
        ...emptyInput(NOW, 1),
        bankTransactions: [ROW_TX(1, { counterpartyName: nasty })],
        relations: [
          {
            id: 1,
            name: nasty,
            isSupplier: true,
            isCustomer: true,
            email: null,
            vatNumber: null,
            country: "DE",
            hasIban: false,
            ibanChangedAt: iso(DAY),
            ibanAddedAt: null,
            openInvoices: 1,
            openBills: 1,
          },
        ],
      },
      "division",
    );
    const issues = out.flatMap((r) => r.issues);
    expect(issues.length).toBeGreaterThan(3);
    for (const i of issues) {
      for (const text of [i.subject, i.message]) {
        // eslint-disable-next-line no-control-regex
        expect(text, i.fingerprint).not.toMatch(/[\u0000-\u001f\u202a-\u202e]/);
      }
      expect(Array.from(i.subject).length).toBeLessThanOrEqual(80);
      expect(Array.from(i.message).length).toBeLessThanOrEqual(240);
      expect(i.fingerprint).toMatch(/^[a-z_.]+:[A-Za-z0-9._:|@-]+$/);
      expect(i.fingerprint.length).toBeLessThan(160);
    }
  });

  it("no full IBAN reaches an issue, in any field, however it is formatted", () => {
    const input: DqInput = {
      ...emptyInput(NOW, 1),
      bankTransactions: [
        ROW_TX(1, { counterpartyName: FULL_IBAN }),
        ROW_TX(2, { counterpartyName: `Pay to ${SPACED_IBAN} now`, reference: SPACED_IBAN }),
        ROW_TX(3, { counterpartyName: FULL_IBAN.toLowerCase() }),
        ROW_TX(4, { reference: "same", counterpartyKey: FULL_IBAN }),
        ROW_TX(5, { reference: "same", counterpartyKey: FULL_IBAN, id: 5, amountMinor: -5 }),
      ],
      relations: [
        {
          id: 1,
          name: `Acme ${FULL_IBAN}`,
          isSupplier: true,
          isCustomer: false,
          email: null,
          vatNumber: null,
          country: null,
          hasIban: false,
          ibanChangedAt: iso(DAY),
          ibanAddedAt: null,
          openInvoices: 0,
          openBills: 2,
        },
      ],
    };
    const text = JSON.stringify(all(input));
    expect(text).not.toContain(FULL_IBAN);
    expect(text).not.toContain(FULL_IBAN.toLowerCase());
    expect(text).not.toContain("ABNA 0417 1643");
    expect(text).not.toContain("0417164300");
    expect(text).toContain("NL91****4300");
  });

  it("negative, zero and unsafe amounts never crash and never invent a number", () => {
    const out = evaluateRules(
      {
        ...emptyInput(NOW, 1),
        bankAccounts: [
          {
            id: 1,
            name: "Huge",
            currency: "EUR",
            balanceMinor: Number.MAX_SAFE_INTEGER,
            balanceAt: iso(1000),
            exactBalanceMinor: -Number.MAX_SAFE_INTEGER,
            exactBalanceAt: iso(1000),
          },
          {
            id: 2,
            name: "Neg",
            currency: "JPY",
            balanceMinor: -5_000,
            balanceAt: iso(1000),
            exactBalanceMinor: 5_000,
            exactBalanceAt: iso(1000),
          },
        ],
        bankTransactions: [
          ROW_TX(1, { amountMinor: Number.MAX_SAFE_INTEGER }),
          ROW_TX(2, { amountMinor: 0 }),
          ROW_TX(3, { amountMinor: Number.NaN }),
          ROW_TX(4, { amountMinor: 1.5 }),
        ],
      },
      "division",
    );
    const bal = out.find((r) => r.ruleId === "bank.balance_mismatch") as DqRuleResult;
    // the difference of the first account is not a safe integer: skipped, not turned into a float
    expect(bal.issues.map((i) => i.fingerprint)).toEqual(["bank.balance_mismatch:acc|2"]);
    expect(bal.issues[0]?.amountMinor).toBe(-10_000);
    expect(bal.issues[0]?.message).toBe("JPY 10000 difference between the bank and Exact on Neg.");
    const un = out.find((r) => r.ruleId === "bank.unmatched_old") as DqRuleResult;
    expect(un.issues).toHaveLength(4);
    expect(un.issues[2]?.amountMinor).toBeNull();
    expect(un.issues.every((i) => Number.isSafeInteger(i.amountMinor ?? 0))).toBe(true);
    expect(un.issues.find((i) => i.fingerprint.endsWith("|3"))?.message).toContain("EUR ?");
  });

  it("dates that cannot be read are skipped, not guessed", () => {
    const out = evaluateRules(
      {
        ...emptyInput(NOW, 1),
        bankTransactions: [ROW_TX(1, { bookedAt: "" }), ROW_TX(2, { bookedAt: "31/02/2026" })],
        purchaseEntries: [
          {
            id: 1,
            entryNumber: null,
            supplierName: null,
            status: "pending_approval",
            submittedAt: "?",
            modifiedAt: "?",
            entryDate: "?",
            hasPdf: false,
            amountMinor: 1,
            currency: "EUR",
          },
        ],
      },
      "division",
    );
    for (const id of ["bank.unmatched_old", "payables.approvals_overdue", "payables.missing_pdf"]) {
      const r = out.find((x) => x.ruleId === id) as DqRuleResult;
      expect(r.issues, id).toEqual([]);
    }
  });

  it("the same data reordered gives the same fingerprints", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ROW_TX(i + 1));
    const fps = (rs: typeof rows) =>
      evaluateRules({ ...emptyInput(NOW, 1), bankTransactions: rs }, "division")
        .flatMap((r) => r.issues.map((i) => i.fingerprint))
        .sort();
    expect(fps([...rows].reverse())).toEqual(fps(rows));
  });

  it("every rule has a message in sentence case with no exclamation mark", () => {
    const input: DqInput = {
      ...emptyInput(NOW, 1),
      bankTransactions: [ROW_TX(1)],
      openItems: [],
    };
    for (const i of all(input).flatMap((r) => r.issues)) {
      expect(i.message).not.toMatch(/!/);
      expect(i.message[0]).toMatch(/[A-Z0-9]/);
    }
    expect(DQ_RULES.every((r) => !/!/.test(r.description))).toBe(true);
  });
});

describe("planReconcile", () => {
  const issue = (ruleId: string, key: string): DqIssue => ({
    ruleId,
    fingerprint: `${ruleId}:${key}`,
    severity: "warning",
    subject: "s",
    message: "m",
    fix: "bank",
    amountMinor: null,
    currency: null,
    details: {},
  });
  const result = (
    ruleId: string,
    status: DqRuleResult["status"],
    issues: DqIssue[] = [],
    truncated = false,
  ): DqRuleResult => ({
    ruleId,
    area: "bank",
    scope: "division",
    severity: "warning",
    status,
    reason: null,
    issues,
    checked: 1,
    truncated,
    total: issues.length,
  });
  const ex = (
    id: number,
    ruleId: string,
    key: string,
    status: DqExistingIssue["status"] = "open",
    snoozedUntil: string | null = null,
  ): DqExistingIssue => ({
    id,
    ruleId,
    fingerprint: `${ruleId}:${key}`,
    status,
    snoozedUntil,
  });
  const NOW_ISO = new Date(NOW).toISOString();

  it("inserts new, refreshes open, reopens resolved and resolves what is gone", () => {
    const plan = planReconcile(
      [ex(1, "r", "a"), ex(2, "r", "b"), ex(3, "r", "c", "resolved"), ex(4, "r", "d", "resolved")],
      [result("r", "issues", [issue("r", "a"), issue("r", "c"), issue("r", "new")])],
      NOW_ISO,
    );
    expect(plan.insert.map((i) => i.fingerprint)).toEqual(["r:new"]);
    expect(plan.refresh.map((x) => x.id)).toEqual([1]);
    expect(plan.reopen.map((x) => x.id)).toEqual([3]);
    expect(plan.resolve).toEqual([2]); // b is gone; d was already resolved and stays so
    expect(planCounts(plan)).toEqual({
      newIssues: 1,
      refreshed: 1,
      reopened: 1,
      unsnoozed: 0,
      resolved: 1,
    });
  });

  it("is idempotent: running the same results again after applying changes changes nothing new", () => {
    const results = [result("r", "issues", [issue("r", "a")])];
    const first = planReconcile([], results, NOW_ISO);
    expect(first.insert).toHaveLength(1);
    const second = planReconcile([ex(1, "r", "a")], results, NOW_ISO);
    expect(second.insert).toEqual([]);
    expect(second.resolve).toEqual([]);
    expect(second.reopen).toEqual([]);
    expect(second.refresh.map((x) => x.id)).toEqual([1]);
  });

  it("does not auto-resolve for a rule that could not vouch: not_available, not_configured, disabled, error, truncated", () => {
    for (const status of ["not_available", "not_configured", "disabled", "error"] as const) {
      const plan = planReconcile([ex(1, "r", "a")], [result("r", status)], NOW_ISO);
      expect(plan.resolve, status).toEqual([]);
      expect(plan.untouchedRules, status).toEqual(["r"]);
    }
    const cut = planReconcile(
      [ex(1, "r", "a"), ex(2, "r", "z")],
      [result("r", "issues", [issue("r", "a")], true)],
      NOW_ISO,
    );
    expect(cut.resolve).toEqual([]);
    expect(cut.untouchedRules).toEqual(["r"]);
  });

  it("an ok rule resolves its open issues; a rule that did not run in this pass is left alone", () => {
    const plan = planReconcile(
      [ex(1, "r", "a"), ex(2, "other", "x")],
      [result("r", "ok")],
      NOW_ISO,
    );
    expect(plan.resolve).toEqual([1]);
  });

  it("snooze: kept while it runs, back to open when it ends, resolved when the condition is gone", () => {
    const future = new Date(NOW + DAY).toISOString();
    const past = new Date(NOW - DAY).toISOString();
    const plan = planReconcile(
      [
        ex(1, "r", "a", "snoozed", future),
        ex(2, "r", "b", "snoozed", past),
        ex(3, "r", "c", "snoozed", null),
        ex(4, "r", "d", "snoozed", future),
        ex(5, "r", "e", "snoozed", "garbage"),
      ],
      [result("r", "issues", [issue("r", "a"), issue("r", "b"), issue("r", "c"), issue("r", "e")])],
      NOW_ISO,
    );
    expect(plan.keepSnoozed.map((x) => x.id)).toEqual([1]);
    expect(plan.unsnooze.map((x) => x.id)).toEqual([2, 3, 5]);
    expect(plan.resolve).toEqual([4]);
    expect(plan.refresh).toEqual([]);
  });

  it("a fingerprint reported twice is applied once", () => {
    const plan = planReconcile(
      [],
      [result("r", "issues", [issue("r", "a")]), result("r", "issues", [issue("r", "a")])],
      NOW_ISO,
    );
    expect(plan.insert).toHaveLength(1);
  });
});
