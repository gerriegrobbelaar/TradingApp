import { describe, expect, it } from "vitest";
import {
  DQ_AREAS,
  DQ_FIX_PATHS,
  DQ_RULES,
  dqRuleById,
  emptyInput,
  evaluateRules,
  isLooseningChange,
  resolveAllConfigs,
  resolveRuleConfig,
  thresholdValid,
  type DqInput,
  type DqRuleConfig,
  type DqRuleDef,
  type DqRuleResult,
} from "./index";

const NOW = Date.parse("2026-07-15T10:00:00Z");
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const DAY = 86_400_000;
const HOUR = 3_600_000;

function run(
  id: string,
  patch: Partial<DqInput>,
  override?: Parameters<typeof resolveRuleConfig>[1],
) {
  const rule = dqRuleById(id) as DqRuleDef;
  const config = resolveRuleConfig(rule, override);
  return rule.evaluate({ ...emptyInput(NOW, 1), ...patch }, config);
}

const tx = (over: Partial<NonNullable<DqInput["bankTransactions"]>[number]> = {}) => ({
  id: 1,
  accountId: 1,
  amountMinor: 12_345,
  currency: "EUR",
  bookedAt: iso(10 * DAY),
  matchStatus: "unmatched" as const,
  counterpartyName: "Acme BV",
  counterpartyKey: "NL91ABNA0417164300",
  reference: "INV-1",
  ...over,
});

const rel = (over: Partial<NonNullable<DqInput["relations"]>[number]> = {}) => ({
  id: 1,
  name: "Acme BV",
  isSupplier: true,
  isCustomer: true,
  email: "billing@acme.example",
  vatNumber: "NL123456789B01",
  country: "NL",
  hasIban: true,
  ibanChangedAt: null,
  ibanAddedAt: null,
  openInvoices: 1,
  openBills: 1,
  ...over,
});

const item = (over: Partial<NonNullable<DqInput["openItems"]>[number]> = {}) => ({
  id: 1,
  kind: "bill" as const,
  relationId: "r1",
  relationName: "Acme BV",
  invoiceNumber: "F-2026-001",
  currency: "EUR",
  originalMinor: 10_000,
  openMinor: 10_000,
  rate: null,
  openDcMinor: null,
  invoiceDate: "2026-07-01",
  ...over,
});

const entry = (over: Partial<NonNullable<DqInput["purchaseEntries"]>[number]> = {}) => ({
  id: 1,
  entryNumber: "70001",
  supplierName: "Acme BV",
  status: "pending_approval" as const,
  submittedAt: iso(5 * DAY),
  modifiedAt: null,
  entryDate: iso(6 * DAY),
  hasPdf: true,
  amountMinor: 5_000,
  currency: "EUR",
  ...over,
});

describe("registry", () => {
  it("has unique ids, an area and fix path for each rule, and covers every area", () => {
    const ids = DQ_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of DQ_RULES) {
      expect(r.id.startsWith(`${r.area === "master_data" ? "master" : r.area}.`)).toBe(true);
      expect(DQ_FIX_PATHS[r.fix]).toMatch(/^\//);
      expect(r.title.length).toBeGreaterThan(5);
      expect(r.title).not.toMatch(/!/);
    }
    for (const a of DQ_AREAS) expect(DQ_RULES.some((r) => r.area === a)).toBe(true);
  });

  it("an input with nothing loaded never yields ok or issues", () => {
    for (const scope of ["division", "global"] as const) {
      for (const r of evaluateRules(emptyInput(NOW), scope)) {
        expect(["not_available", "not_configured"], r.ruleId).toContain(r.status);
        expect(r.reason, r.ruleId).toMatch(/^[a-z0-9_]+$/);
        expect(r.issues).toEqual([]);
      }
    }
  });

  it("every rule is evaluated in exactly one scope", () => {
    const d = evaluateRules(emptyInput(NOW), "division").map((r) => r.ruleId);
    const g = evaluateRules(emptyInput(NOW), "global").map((r) => r.ruleId);
    expect([...d, ...g].sort()).toEqual(DQ_RULES.map((r) => r.id).sort());
  });

  it("a disabled rule is not evaluated, an evaluator that throws is an error (not ok)", () => {
    const overrides = { "bank.unmatched_old": { enabled: false } };
    const res = evaluateRules(emptyInput(NOW), "division", resolveAllConfigs(overrides));
    expect(res.find((r) => r.ruleId === "bank.unmatched_old")?.status).toBe("disabled");
    const rule = dqRuleById("bank.unmatched_old") as DqRuleDef;
    const original = rule.evaluate;
    (rule as { evaluate: unknown }).evaluate = () => {
      throw new Error("boom");
    };
    try {
      const r = evaluateRules(emptyInput(NOW), "division").find(
        (x) => x.ruleId === "bank.unmatched_old",
      ) as DqRuleResult;
      expect(r).toMatchObject({ status: "error", reason: "evaluator_failed", issues: [] });
    } finally {
      (rule as { evaluate: unknown }).evaluate = original;
    }
  });

  it("accepts overrides as a Map or a record and ignores invalid ones", () => {
    const rule = dqRuleById("bank.unmatched_old") as DqRuleDef;
    expect(resolveRuleConfig(rule, { severity: "nonsense", threshold: -3 })).toEqual({
      enabled: true,
      severity: "warning",
      threshold: 5,
    });
    expect(resolveRuleConfig(rule, { severity: "critical", threshold: 9 })).toMatchObject({
      severity: "critical",
      threshold: 9,
    });
    const m = resolveAllConfigs(new Map([["bank.unmatched_old", { threshold: 7 }]]));
    expect(m.get("bank.unmatched_old")?.threshold).toBe(7);
    const o = resolveAllConfigs({ "bank.unmatched_old": { threshold: 8 } });
    expect(o.get("bank.unmatched_old")?.threshold).toBe(8);
  });

  it("threshold validation by spec", () => {
    const num = { kind: "number", unit: "days", default: 5, min: 1, max: 10 } as const;
    expect(thresholdValid(num, 5)).toBe(true);
    expect(thresholdValid(num, 0)).toBe(false);
    expect(thresholdValid(num, 11)).toBe(false);
    expect(thresholdValid(num, 5.5)).toBe(false);
    expect(thresholdValid(num, "5")).toBe(false);
    expect(thresholdValid(null, null)).toBe(true);
    expect(thresholdValid(null, 3)).toBe(false);
    const codes = { kind: "codes", default: [], maxItems: 2 } as const;
    expect(thresholdValid(codes, ["1999", "2.5"])).toBe(true);
    expect(thresholdValid(codes, ["1999", "1999"])).toBe(false);
    expect(thresholdValid(codes, ["a b"])).toBe(false);
    expect(thresholdValid(codes, ["1", "2", "3"])).toBe(false);
    expect(thresholdValid(codes, "1999")).toBe(false);
  });

  it("isLooseningChange: off, lower severity, threshold direction by unit, removed code", () => {
    const days = dqRuleById("bank.unmatched_old") as DqRuleDef;
    const calls = dqRuleById("integrations.exact_budget") as DqRuleDef;
    const codes = dqRuleById("ledger.suspense_not_zero") as DqRuleDef;
    const none = dqRuleById("bank.duplicate_lines") as DqRuleDef;
    const c = (p: Partial<DqRuleConfig>): DqRuleConfig => ({
      enabled: true,
      severity: "warning",
      threshold: 5,
      ...p,
    });
    expect(isLooseningChange(days, c({}), c({ enabled: false }))).toBe(true);
    expect(isLooseningChange(days, c({ enabled: false }), c({}))).toBe(false);
    expect(isLooseningChange(days, c({}), c({ severity: "info" }))).toBe(true);
    expect(isLooseningChange(days, c({}), c({ severity: "critical" }))).toBe(false);
    expect(isLooseningChange(days, c({}), c({ threshold: 10 }))).toBe(true);
    expect(isLooseningChange(days, c({}), c({ threshold: 2 }))).toBe(false);
    expect(isLooseningChange(calls, c({ threshold: 500 }), c({ threshold: 100 }))).toBe(true);
    expect(isLooseningChange(calls, c({ threshold: 500 }), c({ threshold: 900 }))).toBe(false);
    expect(isLooseningChange(none, c({ threshold: null }), c({ threshold: null }))).toBe(false);
    expect(isLooseningChange(codes, c({ threshold: ["1", "2"] }), c({ threshold: ["1"] }))).toBe(
      true,
    );
    expect(isLooseningChange(codes, c({ threshold: ["1"] }), c({ threshold: ["1", "2"] }))).toBe(
      false,
    );
    expect(isLooseningChange(codes, c({ threshold: null }), c({ threshold: ["1"] }))).toBe(false);
  });
});

describe("bank rules", () => {
  const acc = (over = {}) => ({
    id: 1,
    name: "Revolut EUR",
    currency: "EUR",
    balanceMinor: 100_000,
    balanceAt: iso(HOUR),
    exactBalanceMinor: 100_000,
    exactBalanceAt: iso(HOUR),
    ...over,
  });

  it("balance_mismatch: equal is ok, a difference over the tolerance is an issue with a signed amount", () => {
    expect(run("bank.balance_mismatch", { bankAccounts: [acc()] })).toMatchObject({
      status: "ok",
      checked: 1,
    });
    const within = run("bank.balance_mismatch", {
      bankAccounts: [acc({ exactBalanceMinor: 99_950 })],
    });
    expect(within.status).toBe("ok");
    const o = run("bank.balance_mismatch", { bankAccounts: [acc({ exactBalanceMinor: 90_000 })] });
    expect(o.status).toBe("issues");
    expect(o.issues[0]).toMatchObject({
      amountMinor: 10_000,
      currency: "EUR",
      fingerprint: "bank.balance_mismatch:acc|1",
    });
    expect(o.issues[0]?.message).toMatch(/^EUR 100\.00 difference/);
    const tight = run(
      "bank.balance_mismatch",
      { bankAccounts: [acc({ exactBalanceMinor: 99_950 })] },
      { threshold: 0 },
    );
    expect(tight.status).toBe("issues");
  });

  it("balance_mismatch: no Exact balance, a stale one or reads far apart are not compared (never ok)", () => {
    expect(run("bank.balance_mismatch", { bankAccounts: null })).toMatchObject({
      status: "not_available",
    });
    for (const over of [
      { exactBalanceMinor: null },
      { balanceMinor: null },
      { exactBalanceAt: null },
      { exactBalanceAt: iso(40 * HOUR), balanceAt: iso(40 * HOUR) },
      { exactBalanceAt: iso(6 * HOUR) },
      { balanceAt: "garbage" },
    ]) {
      const o = run("bank.balance_mismatch", { bankAccounts: [acc(over)] });
      expect(o, JSON.stringify(over)).toMatchObject({
        status: "not_available",
        reason: "no_comparable_exact_balance",
      });
    }
    expect(run("bank.balance_mismatch", { bankAccounts: [] }).status).toBe("not_available");
  });

  it("unmatched_old: older than N days only, oldest first, matched and ignored lines never", () => {
    const o = run("bank.unmatched_old", {
      bankTransactions: [
        tx({ id: 1, bookedAt: iso(4 * DAY) }),
        tx({ id: 2, bookedAt: iso(6 * DAY) }),
        tx({ id: 3, bookedAt: iso(9 * DAY), matchStatus: "suggested" }),
        tx({ id: 4, bookedAt: iso(20 * DAY), matchStatus: "matched" }),
        tx({ id: 5, bookedAt: iso(20 * DAY), matchStatus: "ignored" }),
        tx({ id: 6, bookedAt: "not a date" }),
        tx({ id: 7, bookedAt: iso(5 * DAY) }),
      ],
    });
    expect(o.issues.map((i) => i.fingerprint)).toEqual([
      "bank.unmatched_old:tx|3",
      "bank.unmatched_old:tx|2",
    ]);
    expect(o.issues[0]?.message).toMatch(/^EUR 123\.45 unmatched for 9 days\.$/);
    const wider = run(
      "bank.unmatched_old",
      { bankTransactions: [tx({ bookedAt: iso(6 * DAY) })] },
      { threshold: 7 },
    );
    expect(wider.status).toBe("ok");
    expect(run("bank.unmatched_old", { bankTransactions: null }).status).toBe("not_available");
  });

  it("unmatched_old handles negative amounts and the singular day", () => {
    const o = run(
      "bank.unmatched_old",
      { bankTransactions: [tx({ amountMinor: -250, bookedAt: iso(1 * DAY + HOUR) })] },
      { threshold: 1 },
    );
    expect(o.issues[0]?.message).toBe("EUR -2.50 unmatched for 1 day.");
  });

  it("duplicate_lines: same account, amount, day, counterparty and reference; the first id is the key", () => {
    const base = { bookedAt: "2026-07-01T09:00:00.000Z" };
    const o = run("bank.duplicate_lines", {
      bankTransactions: [
        tx({ id: 11, ...base }),
        tx({ id: 10, ...base, bookedAt: "2026-07-01T18:00:00.000Z" }),
        tx({ id: 12, ...base, amountMinor: 1 }),
        tx({ id: 13, ...base, accountId: 2 }),
        tx({ id: 14, ...base, reference: "  inv-1 ", counterpartyKey: "nl91abna0417164300" }),
        tx({ id: 15, ...base, reference: null }),
        tx({ id: 16, ...base, reference: "", counterpartyKey: null }),
        tx({ id: 17, ...base, reference: "other" }),
      ],
    });
    expect(o.issues).toHaveLength(1);
    expect(o.issues[0]?.fingerprint).toBe("bank.duplicate_lines:dup|10");
    expect(o.issues[0]?.details).toMatchObject({ lines: 3, firstTxId: 10 });
    expect(JSON.stringify(o)).not.toContain("NL91ABNA0417164300");
    expect(run("bank.duplicate_lines", { bankTransactions: [] }).status).toBe("ok");
    expect(run("bank.duplicate_lines", { bankTransactions: null }).status).toBe("not_available");
  });

  it("booked_line_reverted: reverted or conflicted lines of booked matches are critical", () => {
    const m = (matchId: number, lineState: string, stateConflict: boolean) => ({
      matchId,
      txId: matchId,
      amountMinor: 5_000,
      currency: "EUR",
      lineState,
      stateConflict,
      bookedAt: iso(DAY),
    });
    const o = run("bank.booked_line_reverted", {
      bookedMatches: [m(2, "reverted", false), m(1, "completed", true), m(3, "completed", false)],
    });
    expect(o.issues.map((i) => i.fingerprint)).toEqual([
      "bank.booked_line_reverted:match|1",
      "bank.booked_line_reverted:match|2",
    ]);
    expect(o.issues[0]?.severity).toBe("critical");
    expect(o.issues[0]?.message).toContain("state conflict");
    expect(o.issues[1]?.message).toContain("was reverted");
    expect(run("bank.booked_line_reverted", { bookedMatches: null }).status).toBe("not_available");
  });

  it("booking health counts: one issue per rule over the threshold, ok at zero", () => {
    const zero = {
      outcomeUnknown: 0,
      manualRequired: 0,
      alreadyMatchedInExact: 0,
      staleSettlements: 0,
    };
    for (const id of [
      "bank.booking_outcome_unknown",
      "bank.booking_manual_required",
      "bank.already_matched_in_exact",
      "bank.stale_settlements",
    ]) {
      expect(run(id, { booking: zero }).status, id).toBe("ok");
      expect(run(id, { booking: null }).status, id).toBe("not_available");
    }
    const o = run("bank.booking_outcome_unknown", { booking: { ...zero, outcomeUnknown: 1 } });
    expect(o.issues[0]).toMatchObject({
      fingerprint: "bank.booking_outcome_unknown:division",
      severity: "critical",
      message: "1 booking with an unknown outcome in Exact.",
    });
    const m = run("bank.booking_manual_required", { booking: { ...zero, manualRequired: 3 } });
    expect(m.issues[0]?.message).toBe("3 bookings need a person.");
    const s = run("bank.stale_settlements", { booking: { ...zero, staleSettlements: 2 } });
    expect(s.issues[0]?.message).toContain("2 booked payments are not yet visible");
    const a = run("bank.already_matched_in_exact", {
      booking: { ...zero, alreadyMatchedInExact: 4 },
    });
    expect(a.issues[0]?.details).toEqual({ count: 4 });
    // the threshold: report only above it
    expect(
      run("bank.stale_settlements", { booking: { ...zero, staleSettlements: 2 } }, { threshold: 2 })
        .status,
    ).toBe("ok");
    expect(
      run("bank.stale_settlements", { booking: { ...zero, staleSettlements: Number.NaN } }).status,
    ).toBe("ok");
  });
});

describe("payables rules", () => {
  it("duplicate_invoices: same supplier and normalised number; other suppliers and invoices excluded", () => {
    const o = run("payables.duplicate_invoices", {
      openItems: [
        item({ id: 1, invoiceNumber: "F-2026/001" }),
        item({ id: 2, invoiceNumber: "f 2026 001" }),
        item({ id: 3, invoiceNumber: "F-2026-001", relationId: "r2" }),
        item({ id: 4, invoiceNumber: "F-2026-002" }),
        item({ id: 5, kind: "invoice", invoiceNumber: "F-2026-001" }),
        item({ id: 6, relationId: null }),
      ],
    });
    expect(o.issues).toHaveLength(1);
    expect(o.issues[0]?.details).toEqual({ bills: 2, by: "number" });
    expect(o.issues[0]?.fingerprint).toMatch(/^payables\.duplicate_invoices:/);
  });

  it("duplicate_invoices: without a number the amount and date decide; a zero amount never does", () => {
    const o = run("payables.duplicate_invoices", {
      openItems: [
        item({ id: 1, invoiceNumber: null }),
        item({ id: 2, invoiceNumber: " " }),
        item({ id: 3, invoiceNumber: null, invoiceDate: null }),
        item({ id: 4, invoiceNumber: null, originalMinor: 0 }),
        item({ id: 5, invoiceNumber: null, originalMinor: 0 }),
        item({ id: 6, invoiceNumber: null, originalMinor: null, relationId: "r9" }),
        item({ id: 7, invoiceNumber: null, originalMinor: null, relationId: "r9" }),
      ],
    });
    expect(o.issues).toHaveLength(1);
    expect(o.issues[0]?.details).toMatchObject({ by: "amount_date" });
    expect(run("payables.duplicate_invoices", { openItems: null }).status).toBe("not_available");
  });

  it("the fingerprint does not change when the item ids change", () => {
    const a = run("payables.duplicate_invoices", { openItems: [item({ id: 1 }), item({ id: 2 })] });
    const b = run("payables.duplicate_invoices", {
      openItems: [item({ id: 90 }), item({ id: 91 })],
    });
    expect(a.issues[0]?.fingerprint).toBe(b.issues[0]?.fingerprint);
  });

  it("missing_pdf is not_available where the document flag was never seen", () => {
    expect(run("payables.missing_pdf", { purchaseEntries: null }).status).toBe("not_available");
    expect(run("payables.missing_pdf", { purchaseEntries: [] })).toMatchObject({
      status: "not_available",
      reason: "no_purchase_entries",
    });
    expect(
      run("payables.missing_pdf", { purchaseEntries: [entry({ hasPdf: null })] }),
    ).toMatchObject({ status: "not_available", reason: "document_flag_not_synced" });
  });

  it("missing_pdf: only recent, non-rejected entries with hasPdf false", () => {
    const o = run("payables.missing_pdf", {
      purchaseEntries: [
        entry({ id: 1, hasPdf: false }),
        entry({ id: 2, hasPdf: true }),
        entry({ id: 3, hasPdf: false, status: "rejected" }),
        entry({ id: 4, hasPdf: false, entryDate: iso(200 * DAY) }),
        entry({ id: 5, hasPdf: null }),
        entry({ id: 6, hasPdf: false, entryDate: null }),
      ],
    });
    expect(o.issues.map((i) => i.fingerprint)).toEqual(["payables.missing_pdf:entry|1"]);
    expect(o.checked).toBe(2);
  });

  it("supplier_iban_changed: changed or added inside the window, suppliers only", () => {
    const o = run("payables.supplier_iban_changed", {
      relations: [
        rel({ id: 1, ibanChangedAt: iso(3 * DAY) }),
        rel({ id: 2, ibanAddedAt: iso(10 * DAY) }),
        rel({ id: 3, ibanChangedAt: iso(40 * DAY) }),
        rel({ id: 4, isSupplier: false, isCustomer: true, ibanChangedAt: iso(DAY) }),
        rel({ id: 5, ibanChangedAt: iso(2 * DAY), ibanAddedAt: iso(20 * DAY) }),
      ],
    });
    expect(o.issues.map((i) => i.fingerprint)).toEqual([
      "payables.supplier_iban_changed:rel|1",
      "payables.supplier_iban_changed:rel|2",
      "payables.supplier_iban_changed:rel|5",
    ]);
    expect(o.issues[0]?.severity).toBe("critical");
    expect(o.issues[0]?.message).toContain("changed bank details 3 days ago");
    expect(o.issues[1]?.message).toContain("added bank details 10 days ago");
    expect(run("payables.supplier_iban_changed", { relations: null }).status).toBe("not_available");
  });

  it("approvals_overdue: pending entries older than N days by the best available date", () => {
    const o = run("payables.approvals_overdue", {
      purchaseEntries: [
        entry({ id: 1, submittedAt: iso(5 * DAY) }),
        entry({ id: 2, submittedAt: iso(2 * DAY) }),
        entry({ id: 3, submittedAt: null, modifiedAt: iso(8 * DAY) }),
        entry({ id: 4, submittedAt: null, modifiedAt: null, entryDate: iso(4 * DAY) }),
        entry({ id: 5, submittedAt: null, modifiedAt: null, entryDate: null }),
        entry({ id: 6, status: "approved", submittedAt: iso(30 * DAY) }),
      ],
    });
    expect(o.issues.map((i) => i.fingerprint)).toEqual([
      "payables.approvals_overdue:entry|3",
      "payables.approvals_overdue:entry|1",
      "payables.approvals_overdue:entry|4",
    ]);
    expect(o.issues[0]?.message).toBe("EUR 50.00 waiting for approval for 8 days.");
    expect(run("payables.approvals_overdue", { purchaseEntries: null }).status).toBe(
      "not_available",
    );
  });
});

describe("receivables and master data rules", () => {
  it("customer_no_email: customers with open invoices and a blank address", () => {
    const o = run("receivables.customer_no_email", {
      relations: [
        rel({ id: 1, email: null }),
        rel({ id: 2, email: "  " }),
        rel({ id: 3, email: "x@y.example" }),
        rel({ id: 4, email: null, openInvoices: 0 }),
        rel({ id: 5, email: null, isCustomer: false }),
      ],
    });
    expect(o.issues).toHaveLength(2);
    expect(o.issues[0]?.message).toBe("Acme BV has 1 open invoice and no e-mail address.");
    expect(run("receivables.customer_no_email", { relations: null }).status).toBe("not_available");
  });

  it("bounced_emails, disputed_chased and vat_code_country are never ok", () => {
    for (const id of [
      "receivables.bounced_emails",
      "receivables.disputed_chased",
      "master.vat_code_country",
    ]) {
      const o = run(id, { relations: [rel()], openItems: [item()] });
      expect(o.status, id).toBe("not_available");
      expect(o.issues).toEqual([]);
    }
    expect(run("receivables.bounced_emails", {}).reason).toBe("email_log_empty_until_phase_10");
    expect(run("master.vat_code_country", {}).reason).toBe("vat_code_not_synced");
  });

  it("supplier_no_iban: suppliers with open bills and no IBAN", () => {
    const o = run("master.supplier_no_iban", {
      relations: [
        rel({ id: 1, hasIban: false }),
        rel({ id: 2, hasIban: true }),
        rel({ id: 3, hasIban: false, openBills: 0 }),
        rel({ id: 4, hasIban: false, isSupplier: false }),
        rel({ id: 5, hasIban: false, openBills: 3 }),
      ],
    });
    expect(o.issues.map((i) => i.fingerprint)).toEqual([
      "master.supplier_no_iban:rel|1",
      "master.supplier_no_iban:rel|5",
    ]);
    expect(o.issues[1]?.message).toContain("3 open bills");
    expect(run("master.supplier_no_iban", { relations: null }).status).toBe("not_available");
  });

  it("eu_customer_no_vat: EU countries only, case and spaces tolerated", () => {
    const o = run("master.eu_customer_no_vat", {
      relations: [
        rel({ id: 1, country: "de", vatNumber: null }),
        rel({ id: 2, country: " FR ", vatNumber: "" }),
        rel({ id: 3, country: "US", vatNumber: null }),
        rel({ id: 4, country: null, vatNumber: null }),
        rel({ id: 5, country: "BE", vatNumber: "BE0123456789" }),
      ],
    });
    expect(o.issues.map((i) => i.details["country"])).toEqual(["DE", "FR"]);
    expect(o.checked).toBe(3);
    expect(run("master.eu_customer_no_vat", { relations: null }).status).toBe("not_available");
  });
});

describe("fx, ledger and integration rules", () => {
  const fx = (over = {}) => ({
    newestRateDate: "2026-07-14",
    stale: false,
    staleReason: null,
    workingDaysOld: 1,
    currenciesWithoutRate: [],
    unresolvedConflicts: [],
    ...over,
  });

  it("fx.rate_stale", () => {
    expect(run("fx.rate_stale", { fx: null }).status).toBe("not_available");
    expect(run("fx.rate_stale", { fx: fx() }).status).toBe("ok");
    const s = run("fx.rate_stale", {
      fx: fx({ stale: true, staleReason: "older_than_one_working_day", workingDaysOld: 3 }),
    });
    expect(s.issues[0]?.message).toBe(
      "The newest ECB rate is from 2026-07-14, 3 working days old.",
    );
    const never = run("fx.rate_stale", {
      fx: fx({ stale: true, newestRateDate: null, workingDaysOld: null }),
    });
    expect(never.issues[0]?.message).toBe("No ECB rate has been imported yet.");
    const one = run("fx.rate_stale", { fx: fx({ stale: true, workingDaysOld: 1 }) });
    expect(one.issues[0]?.message).toContain("1 working day old");
  });

  it("fx.currency_without_rate and fx.rate_conflicts", () => {
    expect(run("fx.currency_without_rate", { fx: null }).status).toBe("not_available");
    const o = run("fx.currency_without_rate", {
      fx: fx({
        currenciesWithoutRate: [
          { currency: "XYZ", items: 2 },
          { currency: "ABC", items: 1 },
        ],
      }),
    });
    expect(o.issues.map((i) => i.subject)).toEqual(["ABC", "XYZ"]);
    expect(o.issues[0]?.severity).toBe("critical");
    expect(run("fx.currency_without_rate", { fx: fx() }).status).toBe("ok");
    expect(run("fx.rate_conflicts", { fx: null }).status).toBe("not_available");
    const c = run("fx.rate_conflicts", {
      fx: fx({
        unresolvedConflicts: [
          { id: 9, currency: "USD", rateDate: "2026-07-01" },
          { id: 3, currency: "GBP", rateDate: "2026-07-02" },
        ],
      }),
    });
    expect(c.issues.map((i) => i.fingerprint)).toEqual([
      "fx.rate_conflicts:conflict|3",
      "fx.rate_conflicts:conflict|9",
    ]);
  });

  it("fx.item_without_booked_rate groups by currency and ignores the base currency", () => {
    const o = run("fx.item_without_booked_rate", {
      baseCurrency: "EUR",
      openItems: [
        item({ id: 1, currency: "USD" }),
        item({ id: 2, currency: "USD" }),
        item({ id: 3, currency: "GBP", rate: "0.85" }),
        item({ id: 4, currency: "JPY", openDcMinor: 100 }),
        item({ id: 5, currency: "EUR" }),
        item({ id: 6, currency: "CHF" }),
      ],
    });
    expect(o.issues.map((i) => i.subject)).toEqual(["CHF", "USD"]);
    expect(o.issues[1]?.details).toEqual({ currency: "USD", items: 2 });
    expect(
      run("fx.item_without_booked_rate", { openItems: [item({ currency: "EUR" })] }),
    ).toMatchObject({ status: "ok", checked: 0 });
    expect(run("fx.item_without_booked_rate", { openItems: null }).status).toBe("not_available");
  });

  it("ledger.suspense_not_zero: not_configured without codes, never ok", () => {
    expect(run("ledger.suspense_not_zero", { ledger: null })).toMatchObject({
      status: "not_configured",
      reason: "no_suspense_accounts_configured",
    });
    expect(
      run("ledger.suspense_not_zero", { ledger: { suspense: [], closedPeriodBookings: null } })
        .status,
    ).toBe("not_configured");
    expect(run("ledger.suspense_not_zero", { ledger: null }, { threshold: ["1999"] }).status).toBe(
      "not_available",
    );
  });

  it("ledger.suspense_not_zero: non-zero balances and codes missing from the chart", () => {
    const ledger = {
      suspense: [
        { code: "1999", name: "Suspense", balanceMinor: -2_500, currency: "EUR" },
        { code: "1998", name: "Other suspense", balanceMinor: 0, currency: "EUR" },
      ],
      closedPeriodBookings: null,
    };
    const o = run("ledger.suspense_not_zero", { ledger }, { threshold: ["1998", "1999", "1997"] });
    expect(o.issues.map((i) => i.fingerprint)).toEqual([
      "ledger.suspense_not_zero:gl|1999",
      "ledger.suspense_not_zero:missing|1997",
    ]);
    expect(o.issues[0]).toMatchObject({ amountMinor: -2_500, currency: "EUR" });
    expect(o.issues[0]?.message).toBe("EUR -25.00 on suspense account 1999.");
    expect(o.issues[1]?.details).toMatchObject({ reason: "account_not_found" });
  });

  it("ledger.closed_period_bookings is not_available without a marker, and reports when given rows", () => {
    expect(run("ledger.closed_period_bookings", { ledger: null })).toMatchObject({
      status: "not_available",
      reason: "no_closed_period_marker",
    });
    expect(
      run("ledger.closed_period_bookings", {
        ledger: { suspense: [], closedPeriodBookings: null },
      }).status,
    ).toBe("not_available");
    const o = run("ledger.closed_period_bookings", {
      ledger: {
        suspense: [],
        closedPeriodBookings: [{ id: 4, period: "2026-05", amountMinor: 1 }],
      },
    });
    expect(o.issues[0]?.fingerprint).toBe("ledger.closed_period_bookings:entry|4");
    expect(
      run("ledger.closed_period_bookings", {
        ledger: { suspense: [], closedPeriodBookings: [] },
      }).status,
    ).toBe("ok");
  });

  const job = (over = {}) => ({
    name: "bank.match",
    title: "Bank matching",
    enabled: true,
    implemented: true,
    intervalMs: 10 * 60_000,
    lastSuccessAt: iso(5 * 60_000),
    referenceAt: null,
    lastStatus: "ok",
    lastCode: null,
    ...over,
  });

  it("integrations.job_stale: 2x the schedule interval, enabled and implemented jobs only", () => {
    expect(run("integrations.job_stale", { jobs: null }).status).toBe("not_available");
    const o = run("integrations.job_stale", {
      jobs: [
        job({ name: "a", lastSuccessAt: iso(19 * 60_000) }),
        job({ name: "b", lastSuccessAt: iso(21 * 60_000), lastStatus: "error", lastCode: "boom" }),
        job({ name: "c", enabled: false, lastSuccessAt: iso(DAY) }),
        job({ name: "d", implemented: false, lastSuccessAt: null, referenceAt: iso(DAY) }),
        job({ name: "e", intervalMs: null, lastSuccessAt: iso(DAY) }),
        job({ name: "f", lastSuccessAt: null, referenceAt: iso(3 * DAY) }),
        job({ name: "g", lastSuccessAt: null, referenceAt: null }),
        job({ name: "h", intervalMs: 0, lastSuccessAt: iso(DAY) }),
      ],
    });
    expect(o.issues.map((i) => i.details["job"])).toEqual(["b", "f"]);
    expect(o.issues[0]?.details).toMatchObject({ lastStatus: "error", lastCode: "boom" });
    expect(o.issues[1]?.details).toMatchObject({ neverSucceeded: true });
    expect(o.issues[1]?.message).toContain("3 days");
    expect(o.checked).toBe(3);
    const wide = run(
      "integrations.job_stale",
      { jobs: [job({ lastSuccessAt: iso(21 * 60_000) })] },
      { threshold: 3 },
    );
    expect(wide.status).toBe("ok");
  });

  it("integrations.webhook_failures: not_configured without Revolut, issue above the limit", () => {
    expect(run("integrations.webhook_failures", { webhook: null })).toMatchObject({
      status: "not_configured",
      reason: "no_revolut_connection",
    });
    expect(
      run("integrations.webhook_failures", { webhook: { rejected24h: 3, errored24h: 2 } }).status,
    ).toBe("ok");
    const o = run("integrations.webhook_failures", { webhook: { rejected24h: 4, errored24h: 2 } });
    expect(o.issues[0]).toMatchObject({
      message: "6 webhook deliveries failed in the last 24 hours.",
      details: { rejected: 4, errored: 2 },
    });
    expect(
      run(
        "integrations.webhook_failures",
        { webhook: { rejected24h: 1, errored24h: 0 } },
        { threshold: 0 },
      ).issues[0]?.message,
    ).toBe("1 webhook delivery failed in the last 24 hours.");
  });

  it("integrations.exact_connection", () => {
    expect(run("integrations.exact_connection", { exactConnection: null })).toMatchObject({
      status: "not_configured",
    });
    const c = (over = {}) => ({
      status: "active",
      lastError: null,
      refreshExpiresAt: new Date(NOW + 20 * DAY).toISOString(),
      ...over,
    });
    expect(run("integrations.exact_connection", { exactConnection: c() }).status).toBe("ok");
    expect(
      run("integrations.exact_connection", { exactConnection: c({ refreshExpiresAt: null }) })
        .status,
    ).toBe("ok");
    const exp = run("integrations.exact_connection", {
      exactConnection: c({ refreshExpiresAt: new Date(NOW + 3 * DAY).toISOString() }),
    });
    expect(exp.issues[0]?.message).toBe("The Exact connection expires within 7 days.");
    expect(exp.issues[0]?.severity).toBe("critical");
    const gone = run("integrations.exact_connection", {
      exactConnection: c({ refreshExpiresAt: new Date(NOW - DAY).toISOString() }),
    });
    expect(gone.issues[0]?.details).toEqual({ reason: "expired" });
    for (const [over, reason] of [
      [{ status: "needs_reauth" }, "needs_reauth"],
      [{ lastError: "credentials_rejected" }, "credentials_rejected"],
    ] as const) {
      const o = run("integrations.exact_connection", { exactConnection: c(over) });
      expect(o.issues[0]?.details).toEqual({ reason });
    }
  });

  it("integrations.exact_budget: the lower of our count and Exact's last report", () => {
    expect(run("integrations.exact_budget", { exactBudget: null }).status).toBe("not_available");
    const b = (calls: number, remaining: number | null) => ({ dailyLimit: 5000, calls, remaining });
    expect(run("integrations.exact_budget", { exactBudget: b(100, null) }).status).toBe("ok");
    expect(
      run("integrations.exact_budget", { exactBudget: b(4_600, null) }).issues[0]?.message,
    ).toBe("400 Exact calls left today.");
    expect(run("integrations.exact_budget", { exactBudget: b(100, 300) }).status).toBe("issues");
    expect(
      run("integrations.exact_budget", { exactBudget: b(5_200, null) }).issues[0]?.message,
    ).toBe("0 Exact calls left today.");
    expect(
      run("integrations.exact_budget", { exactBudget: b(4_900, null) }, { threshold: 50 }).status,
    ).toBe("ok");
  });
});
