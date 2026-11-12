import { describe, expect, it } from "vitest";
import { formatMinor } from "../money";
import {
  applyPaymentSettingsPatch,
  BATCH_BLOCK_CODES,
  checkBatch,
  DEFAULT_PAYMENT_SETTINGS,
  ibanFingerprint,
  loosenedFields,
  parsePaymentSettings,
  PAYMENT_BLOCK_CODES,
  PAYMENT_MAX_MINOR,
  PAYMENTS_VERIFY_CHECKS,
  precheckPayment,
  sameVerifyChecks,
  type BatchItemInput,
  type PaymentSettings,
  type PrecheckInput,
  type PrecheckResult,
} from "./index";
import { batchConfirmPhrase, paymentConfirmPhrase, phraseMatches } from "../confirm-phrases";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const IBAN = "NL91ABNA0417164300";
const settings = (o: Partial<PaymentSettings> = {}): PaymentSettings => ({
  ...DEFAULT_PAYMENT_SETTINGS,
  allowedCurrencies: [...DEFAULT_PAYMENT_SETTINGS.allowedCurrencies],
  ...o,
});

function good(o: Partial<PrecheckInput> = {}): PrecheckInput {
  return {
    nowMs: NOW,
    paymentsEnabled: true,
    settings: settings(),
    requesterEmail: "req@x.nl",
    item: {
      kind: "bill",
      closed: false,
      openMinor: 100_000,
      currency: "EUR",
      invoiceNumber: "2026-42",
      invoiceIban: null,
    },
    approval: "approved",
    supplier: { found: true, isSupplier: true },
    iban: {
      recordIban: IBAN,
      verification: {
        fingerprint: ibanFingerprint(IBAN) as string,
        verifiedBy: "app@x.nl",
        revoked: false,
      },
      paidBefore: true,
    },
    ibanReadAtMs: NOW - 3600_000,
    conflicts: { openRequest: false, openBatch: false, paidSinceSync: false },
    source: {
      found: true,
      active: true,
      currency: "EUR",
      balanceMinor: 5_000_000,
      balanceAtMs: NOW - 60_000,
      reservedMinor: 0,
    },
    dailyTotalEurMinor: 0,
    rates: null,
    ...o,
  };
}
const blocks = (o: Partial<PrecheckInput>) => precheckPayment(good(o)).blocks;

describe("precheckPayment", () => {
  it("passes a clean request and returns what would be paid", () => {
    const r = precheckPayment(good());
    expect(r.ok).toBe(true);
    expect(r.blocks).toEqual([]);
    expect(r.amountMinor).toBe(100_000);
    expect(r.currency).toBe("EUR");
    expect(r.reference).toBe("Invoice 2026-42");
    expect(r.eur).toEqual({ minor: 100_000, rate: "1", currency: "EUR" });
    expect(r.ibanState).toBe("verified_established");
    expect(r.ibanFingerprint).toBe(ibanFingerprint(IBAN));
  });

  it("blocks when the switch is off", () => {
    expect(blocks({ paymentsEnabled: false })).toEqual(["payments_disabled"]);
  });

  it("blocks a missing payable, an invoice that is not a bill, a closed or credit item", () => {
    expect(blocks({ item: null })).toContain("payable_not_found");
    const item = good().item;
    if (item === null) throw new Error("x");
    expect(blocks({ item: { ...item, kind: "invoice" } })).toContain("not_a_payable");
    expect(blocks({ item: { ...item, closed: true } })).toContain("nothing_open");
    expect(blocks({ item: { ...item, openMinor: 0 } })).toContain("nothing_open");
    expect(blocks({ item: { ...item, openMinor: -500 } })).toContain("nothing_open");
    expect(blocks({ item: { ...item, openMinor: 1.5 } })).toContain("nothing_open");
    expect(blocks({ item: { ...item, openMinor: Number.NaN } })).toContain("nothing_open");
  });

  it("checks the amount: open balance by default, partial only by setting", () => {
    expect(blocks({ requestedAmountMinor: 50_000 })).toEqual(["amount_not_open_balance"]);
    expect(
      blocks({ requestedAmountMinor: 50_000, settings: settings({ allowPartial: true }) }),
    ).toEqual([]);
    expect(
      blocks({ requestedAmountMinor: 100_001, settings: settings({ allowPartial: true }) }),
    ).toEqual(["amount_exceeds_open"]);
    expect(blocks({ requestedAmountMinor: 100_001 })).toEqual(["amount_exceeds_open"]);
    for (const bad of [0, -1, 1.2, Number.NaN, Infinity, PAYMENT_MAX_MINOR + 1, 2 ** 60]) {
      expect(blocks({ requestedAmountMinor: bad }), String(bad)).toEqual(["amount_invalid"]);
    }
    expect(precheckPayment(good({ requestedAmountMinor: -1 })).amountMinor).toBeNull();
  });

  it("handles the largest amounts without wrapping", () => {
    const item = {
      kind: "bill" as const,
      closed: false,
      openMinor: PAYMENT_MAX_MINOR,
      currency: "EUR",
      invoiceNumber: "9",
      invoiceIban: null,
    };
    const r = precheckPayment(good({ item }));
    expect(r.blocks).toEqual(["over_request_limit", "over_daily_limit"]);
    expect(r.amountMinor).toBe(PAYMENT_MAX_MINOR);
  });

  it("blocks currencies that are not allowed or do not match the source account", () => {
    const item = {
      kind: "bill" as const,
      closed: false,
      openMinor: 1000,
      currency: "USD",
      invoiceNumber: "1",
      invoiceIban: null,
    };
    expect(blocks({ item })).toContain("currency_not_supported");
    expect(blocks({ item })).toContain("currency_mismatch_source");
    const rates = { asOf: "2026-11-12", base: "EUR" as const, rates: { USD: "1.25" } };
    const ok = blocks({
      item,
      rates,
      settings: settings({ allowedCurrencies: ["EUR", "USD"] }),
      source: {
        found: true,
        active: true,
        currency: "USD",
        balanceMinor: 99_999,
        balanceAtMs: NOW,
        reservedMinor: 0,
      },
    });
    expect(ok).toEqual([]);
  });

  it("never assumes the Exact approval", () => {
    expect(blocks({ approval: "mapping_unverified" })).toEqual(["approval_mapping_unverified"]);
    expect(blocks({ approval: "not_approved" })).toEqual(["invoice_not_approved"]);
    expect(blocks({ approval: "unknown" })).toEqual(["approval_unknown"]);
  });

  it("blocks a second request, a batch and a payment not yet visible in Exact", () => {
    expect(
      blocks({ conflicts: { openRequest: true, openBatch: true, paidSinceSync: true } }),
    ).toEqual(["already_in_request", "already_in_batch", "paid_since_last_sync"]);
  });

  it("blocks an unknown supplier and every IBAN problem", () => {
    expect(blocks({ supplier: null })).toEqual(["supplier_not_found"]);
    expect(blocks({ supplier: { found: false, isSupplier: true } })).toEqual([
      "supplier_not_found",
    ]);
    expect(blocks({ supplier: { found: true, isSupplier: false } })).toEqual([
      "supplier_not_found",
    ]);
    const iban = good().iban;
    expect(blocks({ iban: { ...iban, recordIban: null } })).toEqual(["iban_missing"]);
    expect(blocks({ iban: { ...iban, recordIban: "NL00ABNA0417164300" } })).toEqual([
      "iban_invalid",
    ]);
    expect(blocks({ iban: { ...iban, verification: null } })).toEqual(["iban_unverified"]);
    expect(blocks({ iban: { ...iban, recordIban: "DE89370400440532013000" } })).toEqual([
      "iban_changed",
    ]);
  });

  it("blocks when the invoice's own IBAN differs from the supplier record", () => {
    const item = {
      kind: "bill" as const,
      closed: false,
      openMinor: 1000,
      currency: "EUR",
      invoiceNumber: "1",
      invoiceIban: "DE89370400440532013000",
    };
    expect(blocks({ item })).toEqual(["iban_mismatch_invoice"]);
    expect(blocks({ item: { ...item, invoiceIban: "garbage" } })).toEqual([
      "iban_mismatch_invoice",
    ]);
    expect(blocks({ item: { ...item, invoiceIban: "nl91 abna 0417 1643 00" } })).toEqual([]);
  });

  it("does not trust an IBAN read that is old, missing or from the future", () => {
    expect(blocks({ ibanReadAtMs: NOW - 3 * 24 * 3600_000 - 1 })).toEqual(["iban_cache_stale"]);
    expect(blocks({ ibanReadAtMs: NOW - 3 * 24 * 3600_000 })).toEqual([]);
    expect(blocks({ ibanReadAtMs: null })).toEqual(["iban_cache_stale"]);
    expect(blocks({ ibanReadAtMs: NOW + 3600_000 })).toEqual(["iban_cache_stale"]);
    expect(blocks({ ibanReadAtMs: Number.NaN })).toEqual(["iban_cache_stale"]);
  });

  it("enforces the per-request and the daily ceilings, inclusive at the boundary", () => {
    const item = (openMinor: number) => ({
      kind: "bill" as const,
      closed: false,
      openMinor,
      currency: "EUR",
      invoiceNumber: "1",
      invoiceIban: null,
    });
    expect(blocks({ item: item(2_500_000) })).toEqual([]);
    expect(blocks({ item: item(2_500_001) })).toEqual(["over_request_limit"]);
    expect(blocks({ item: item(100_000), dailyTotalEurMinor: 4_900_000 })).toEqual([]);
    expect(blocks({ item: item(100_000), dailyTotalEurMinor: 4_900_001 })).toEqual([
      "over_daily_limit",
    ]);
    expect(blocks({ dailyTotalEurMinor: -1 })).toEqual(["over_daily_limit"]);
    expect(blocks({ dailyTotalEurMinor: 0.5 })).toEqual(["over_daily_limit"]);
  });

  it("refuses an amount it cannot value in EUR", () => {
    const item = {
      kind: "bill" as const,
      closed: false,
      openMinor: 1000,
      currency: "USD",
      invoiceNumber: "1",
      invoiceIban: null,
    };
    const s = settings({ allowedCurrencies: ["USD"] });
    const src = {
      found: true,
      active: true,
      currency: "USD",
      balanceMinor: 1_000_000,
      balanceAtMs: NOW,
      reservedMinor: 0,
    };
    expect(blocks({ item, settings: s, source: src, rates: null })).toEqual(["no_eur_rate"]);
  });

  it("checks the source account", () => {
    expect(blocks({ source: null })).toEqual(["source_account_unknown"]);
    const s = good().source;
    if (s === null) throw new Error("x");
    expect(blocks({ source: { ...s, found: false } })).toEqual(["source_account_unknown"]);
    expect(blocks({ source: { ...s, active: false } })).toEqual(["source_account_inactive"]);
  });

  it("warns about balance by default and blocks by setting; unknown balance fails closed when blocking", () => {
    const s = good().source;
    if (s === null) throw new Error("x");
    const low = { ...s, balanceMinor: 50_000, reservedMinor: 0 };
    expect(precheckPayment(good({ source: low })).ok).toBe(true);
    expect(precheckPayment(good({ source: low })).warnings).toEqual(["balance_below_amount"]);
    expect(
      blocks({ source: low, settings: settings({ blockOnInsufficientBalance: true }) }),
    ).toEqual(["insufficient_balance"]);
    // reserved by other open requests
    const reserved = { ...s, balanceMinor: 150_000, reservedMinor: 60_000 };
    expect(precheckPayment(good({ source: reserved })).warnings).toEqual(["balance_below_amount"]);
    const unknown = { ...s, balanceMinor: null, balanceAtMs: null };
    expect(precheckPayment(good({ source: unknown })).warnings).toEqual(["balance_unknown"]);
    expect(precheckPayment(good({ source: unknown })).ok).toBe(true);
    expect(
      blocks({ source: unknown, settings: settings({ blockOnInsufficientBalance: true }) }),
    ).toEqual(["insufficient_balance"]);
    const stale = { ...s, balanceAtMs: NOW - 3600_000 - 1 };
    expect(precheckPayment(good({ source: stale })).warnings).toEqual(["balance_stale"]);
  });

  it("blocks when no reference can be built and warns when it was shortened", () => {
    const item = (invoiceNumber: string | null) => ({
      kind: "bill" as const,
      closed: false,
      openMinor: 1000,
      currency: "EUR",
      invoiceNumber,
      invoiceIban: null,
    });
    expect(blocks({ item: item(null) })).toEqual(["reference_empty"]);
    expect(blocks({ item: item("🙂") })).toEqual(["reference_empty"]);
    const r = precheckPayment(good({ item: item("Z".repeat(300)) }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(["reference_shortened"]);
    expect(r.reference).toHaveLength(140);
  });

  it("returns every block in the order of the code list", () => {
    const r = precheckPayment(
      good({
        paymentsEnabled: false,
        approval: "unknown",
        supplier: null,
        source: null,
        item: null,
        conflicts: { openRequest: true, openBatch: false, paidSinceSync: false },
      }),
    );
    const idx = r.blocks.map((b) => PAYMENT_BLOCK_CODES.indexOf(b));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(new Set(r.blocks).size).toBe(r.blocks.length);
    expect(r.ok).toBe(false);
  });
});

describe("checkBatch", () => {
  const ctx = { settings: settings(), dailyTotalEurMinor: 0 };
  const item = (
    id: number,
    amount: number,
    o: { account?: number; cur?: string; pre?: Partial<PrecheckResult> } = {},
  ): BatchItemInput => ({
    openItemId: id,
    sourceAccountId: o.account ?? 1,
    precheck: {
      ok: true,
      blocks: [],
      warnings: [],
      amountMinor: amount,
      currency: o.cur ?? "EUR",
      reference: `Invoice ${id}`,
      eur: { minor: amount, rate: "1", currency: o.cur ?? "EUR" },
      ibanState: "verified_established",
      ibanFingerprint: "f".repeat(64),
      ...o.pre,
    },
  });
  it("accepts a clean batch and sums it", () => {
    const r = checkBatch([item(1, 100), item(2, 250)], ctx);
    expect(r.ok).toBe(true);
    expect(r.totalMinor).toBe(350);
    expect(r.currency).toBe("EUR");
    expect(r.totalEur?.minor).toBe(350);
  });
  it("refuses empty, too large, duplicate, mixed currency, mixed source", () => {
    expect(checkBatch([], ctx).blocks).toContain("batch_empty");
    expect(
      checkBatch(
        Array.from({ length: 51 }, (_, i) => item(i + 1, 1)),
        ctx,
      ).blocks,
    ).toContain("batch_too_large");
    expect(
      checkBatch(
        Array.from({ length: 50 }, (_, i) => item(i + 1, 1)),
        ctx,
      ).ok,
    ).toBe(true);
    expect(checkBatch([item(1, 1), item(1, 1)], ctx).blocks).toContain("batch_duplicate_invoice");
    expect(checkBatch([item(1, 1), item(2, 1, { cur: "USD" })], ctx).blocks).toContain(
      "batch_mixed_currency",
    );
    expect(checkBatch([item(1, 1), item(2, 1, { account: 2 })], ctx).blocks).toContain(
      "batch_mixed_source_account",
    );
  });
  it("refuses a batch with a blocked item and reports which", () => {
    const r = checkBatch(
      [item(1, 1), item(2, 1, { pre: { blocks: ["iban_unverified"], ok: false } })],
      ctx,
    );
    expect(r.blocks).toContain("batch_item_blocked");
    expect(r.itemBlocks).toEqual([{ openItemId: 2, blocks: ["iban_unverified"] }]);
    const noAmount = checkBatch([item(3, 1, { pre: { amountMinor: null } })], ctx);
    expect(noAmount.blocks).toContain("batch_item_blocked");
  });
  it("checks the total against the request limit and the daily limit, inclusive", () => {
    expect(checkBatch([item(1, 1_250_000), item(2, 1_250_000)], ctx).ok).toBe(true);
    expect(checkBatch([item(1, 1_250_000), item(2, 1_250_001)], ctx).blocks).toEqual([
      "batch_over_request_limit",
    ]);
    expect(checkBatch([item(1, 100)], { ...ctx, dailyTotalEurMinor: 4_999_900 }).ok).toBe(true);
    expect(checkBatch([item(1, 101)], { ...ctx, dailyTotalEurMinor: 4_999_900 }).blocks).toEqual([
      "batch_over_daily_limit",
    ]);
    expect(checkBatch([item(1, 1)], { ...ctx, dailyTotalEurMinor: -5 }).blocks).toEqual([
      "batch_over_daily_limit",
    ]);
  });
  it("cannot be overflowed by many near-maximum amounts", () => {
    const r = checkBatch([item(1, PAYMENT_MAX_MINOR), item(2, PAYMENT_MAX_MINOR)], ctx);
    expect(r.blocks).toContain("batch_total_unsafe");
    expect(r.totalMinor).toBeNull();
    expect(r.totalEur).toBeNull();
  });
  it("fails closed without an EUR figure", () => {
    const r = checkBatch([item(1, 100, { pre: { eur: null } })], ctx);
    expect(r.blocks).toEqual(["batch_no_eur_rate"]);
    expect(r.totalMinor).toBe(100);
  });
  it("keeps the foreign currency on the EUR total so the conservative limit rule applies", () => {
    const r = checkBatch([item(1, 100, { cur: "USD" })], ctx);
    expect(r.totalEur?.currency).toBe("USD");
  });
  it("lists block codes in a fixed order", () => {
    const r = checkBatch([item(1, 1, { cur: "USD" }), item(1, 1, { account: 2 })], ctx);
    const idx = r.blocks.map((b) => BATCH_BLOCK_CODES.indexOf(b));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });
});

describe("payment settings", () => {
  it("falls back to the strict defaults for anything unusable", () => {
    for (const raw of [null, undefined, "", "{", "[]", "null", "3", '"x"']) {
      expect(parsePaymentSettings(raw as string | null)).toEqual(DEFAULT_PAYMENT_SETTINGS);
    }
    const bad = parsePaymentSettings(
      JSON.stringify({
        fourEyesEnabled: "no",
        fourEyesLimitMinor: -1,
        maxRequestMinor: 1.5,
        maxDailyMinor: "9",
        allowedCurrencies: ["eur"],
        mode: "turbo",
        allowPartial: 1,
        blockOnInsufficientBalance: null,
        requireApprovalForNewIban: 0,
      }),
    );
    expect(bad).toEqual(DEFAULT_PAYMENT_SETTINGS);
  });
  it("reads good values, de-duplicates currencies and tightens inconsistent limits", () => {
    const s = parsePaymentSettings(
      JSON.stringify({
        fourEyesEnabled: false,
        fourEyesLimitMinor: 9_000_000,
        maxRequestMinor: 8_000_000,
        maxDailyMinor: 3_000_000,
        allowedCurrencies: ["USD", "USD", "EUR"],
        mode: "pay",
        allowPartial: true,
        blockOnInsufficientBalance: true,
        requireApprovalForNewIban: false,
      }),
    );
    expect(s).toEqual({
      fourEyesEnabled: false,
      fourEyesLimitMinor: 3_000_000,
      requireApprovalForNewIban: false,
      maxRequestMinor: 3_000_000,
      maxDailyMinor: 3_000_000,
      allowPartial: true,
      blockOnInsufficientBalance: true,
      allowedCurrencies: ["USD", "EUR"],
      mode: "pay",
    });
  });
  it("applies a patch, reports changes and what loosened", () => {
    const cur = settings();
    const r = applyPaymentSettingsPatch(cur, { fourEyesLimitMinor: 100_000, allowPartial: true });
    expect(r).toMatchObject({
      ok: true,
      changed: ["fourEyesLimitMinor", "allowPartial"],
      loosened: ["allowPartial"],
    });
    const none = applyPaymentSettingsPatch(cur, {});
    expect(none).toMatchObject({ ok: true, changed: [], loosened: [] });
  });
  it("rejects bad shapes with stable codes", () => {
    const cur = settings();
    const err = (p: Record<string, unknown>) => {
      const r = applyPaymentSettingsPatch(cur, p);
      return r.ok ? "ok" : r.error;
    };
    expect(err({ nope: 1 })).toBe("bad_field");
    expect(err({ fourEyesEnabled: "yes" })).toBe("bad_field");
    expect(err({ allowPartial: 1 })).toBe("bad_field");
    expect(err({ fourEyesLimitMinor: -1 })).toBe("bad_limit");
    expect(err({ maxRequestMinor: 1.5 })).toBe("bad_limit");
    expect(err({ maxDailyMinor: 2 ** 60 })).toBe("bad_limit");
    expect(err({ allowedCurrencies: [] })).toBe("bad_currencies");
    expect(err({ allowedCurrencies: ["eur"] })).toBe("bad_currencies");
    expect(err({ allowedCurrencies: "EUR" })).toBe("bad_currencies");
    expect(err({ allowedCurrencies: Array.from({ length: 11 }, () => "EUR") })).toBe(
      "bad_currencies",
    );
    expect(err({ mode: "fast" })).toBe("bad_mode");
    expect(err({ fourEyesLimitMinor: 2_500_001 })).toBe("limits_inconsistent");
    expect(err({ maxRequestMinor: 5_000_001 })).toBe("limits_inconsistent");
    expect(err({ maxDailyMinor: 100 })).toBe("limits_inconsistent");
  });
  it("detects every loosening direction", () => {
    const a = settings();
    const l = (o: Partial<PaymentSettings>) => loosenedFields(a, { ...a, ...o });
    expect(l({ fourEyesEnabled: false })).toEqual(["fourEyesEnabled"]);
    expect(l({ fourEyesLimitMinor: a.fourEyesLimitMinor + 1 })).toEqual(["fourEyesLimitMinor"]);
    expect(l({ requireApprovalForNewIban: false })).toEqual(["requireApprovalForNewIban"]);
    expect(l({ maxRequestMinor: a.maxRequestMinor + 1 })).toEqual(["maxRequestMinor"]);
    expect(l({ maxDailyMinor: a.maxDailyMinor + 1 })).toEqual(["maxDailyMinor"]);
    expect(l({ allowPartial: true })).toEqual(["allowPartial"]);
    expect(l({ allowedCurrencies: ["EUR", "GBP"] })).toEqual(["allowedCurrencies"]);
    expect(l({ mode: "pay" })).toEqual(["mode"]);
    const strict = settings({ blockOnInsufficientBalance: true });
    expect(loosenedFields(strict, a)).toEqual(["blockOnInsufficientBalance"]);
    // tightening is never loosening
    expect(
      l({
        fourEyesLimitMinor: 1,
        maxRequestMinor: 100,
        maxDailyMinor: 100,
        allowedCurrencies: ["EUR"],
      }),
    ).toEqual([]);
    expect(loosenedFields(settings({ mode: "pay" }), settings({ mode: "drafts" }))).toEqual([]);
  });
});

describe("verification checks and phrases", () => {
  it("needs every check exactly once", () => {
    expect(sameVerifyChecks([...PAYMENTS_VERIFY_CHECKS])).toBe(true);
    expect(sameVerifyChecks([...PAYMENTS_VERIFY_CHECKS].reverse())).toBe(true);
    expect(sameVerifyChecks(PAYMENTS_VERIFY_CHECKS.slice(1))).toBe(false);
    expect(sameVerifyChecks([...PAYMENTS_VERIFY_CHECKS, "extra"])).toBe(false);
    expect(sameVerifyChecks([...PAYMENTS_VERIFY_CHECKS.slice(1), PAYMENTS_VERIFY_CHECKS[1]])).toBe(
      false,
    );
  });
  it("puts the amount in the confirmation phrase", () => {
    expect(paymentConfirmPhrase(123_456, "EUR")).toBe("PAY 1234.56 EUR");
    expect(paymentConfirmPhrase(5, "EUR")).toBe("PAY 0.05 EUR");
    expect(paymentConfirmPhrase(1500, "JPY")).toBe("PAY 1500 JPY");
    expect(batchConfirmPhrase(3, 123_456, "EUR")).toBe("PAY BATCH 3 INVOICES 1234.56 EUR");
    expect(phraseMatches("PAY 1234.56 EUR", paymentConfirmPhrase(123_456, "EUR"))).toBe(true);
    expect(phraseMatches("pay 1234.56 eur", paymentConfirmPhrase(123_456, "EUR"))).toBe(false);
    expect(phraseMatches("PAY 1234.56 EUR ", paymentConfirmPhrase(123_456, "EUR"))).toBe(false);
    expect(formatMinor(123_456)).toBe("1234.56");
  });
});
