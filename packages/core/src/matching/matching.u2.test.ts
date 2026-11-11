/** Phase 7 final-review fixes (U2): config floors, isLoosening, incoming-unknown-IBAN policy. */
import { describe, expect, it } from "vitest";
import {
  BLOCK_CODES,
  DEFAULT_MATCH_CONFIG,
  explainBlock,
  isLoosening,
  matchBatch,
  matchTransaction,
  validateMatchConfig,
  type AutoSafetyFields,
  type MatchConfig,
  type MatchItem,
  type MatchTx,
} from "./index";

const IBAN = "NL91ABNA0417164300";
const OTHER = "DE89370400440532013000";

const tx = (over: Partial<MatchTx> = {}): MatchTx => ({
  id: 1,
  connectionId: 1,
  accountId: 1,
  direction: "in",
  amountMinor: 123400n,
  currency: "EUR",
  bookedAt: "2026-05-10",
  reference: "INV-2024-001",
  description: null,
  counterpartyName: null,
  counterpartyIban: IBAN,
  counterpartyRef: null,
  type: "transfer",
  isFinal: true,
  state: "completed",
  requestId: null,
  frozen: false,
  stateConflict: false,
  ...over,
});

const item = (over: Partial<MatchItem> = {}): MatchItem => ({
  id: 10,
  kind: "receivable",
  invoiceNumber: "INV-2024-001",
  entryNumber: null,
  yourRef: null,
  relationId: 7,
  relationName: "Acme B.V.",
  relationIbans: [IBAN],
  relationIbanAddedAt: null,
  relationIbanChangedAt: null,
  currency: "EUR",
  openMinor: 123400n,
  dueDate: null,
  hasLiveMatch: false,
  closed: false,
  ...over,
});

const cfg = DEFAULT_MATCH_CONFIG;

describe("config floors (S3)", () => {
  it("defaults sit on or above the floors", () => {
    expect(validateMatchConfig(cfg)).toEqual([]);
    expect(cfg.autoIncomingUnknownIban).toBe(false);
  });
  it("gap 9 and recent-IBAN days 29 are invalid, 10 and 30 are valid", () => {
    expect(validateMatchConfig({ ...cfg, autoMatchMinGap: 9 })).toHaveLength(1);
    expect(validateMatchConfig({ ...cfg, autoMatchMinGap: 10 })).toEqual([]);
    expect(validateMatchConfig({ ...cfg, blockAutoOnRecentIbanChangeDays: 29 })).toHaveLength(1);
    expect(validateMatchConfig({ ...cfg, blockAutoOnRecentIbanChangeDays: 30 })).toEqual([]);
    expect(validateMatchConfig({ ...cfg, blockAutoOnRecentIbanChangeDays: 3651 })).toHaveLength(1);
  });
  it("the policy switch must be a boolean", () => {
    const bad = { ...cfg, autoIncomingUnknownIban: "yes" } as unknown as MatchConfig;
    expect(validateMatchConfig(bad)).toHaveLength(1);
  });
});

describe("isLoosening", () => {
  const base: AutoSafetyFields = {
    autoMatchMinScore: 97,
    autoMatchMinGap: 20,
    blockAutoOnRecentIbanChangeDays: 90,
    autoLedgerPatterns: false,
    autoIncomingUnknownIban: false,
    amountToleranceMinor: 0,
    autoTxTypes: ["transfer", "topup"],
    internalAccountTypes: ["self"],
  };
  const loosen: [string, Partial<AutoSafetyFields>][] = [
    ["lower min score", { autoMatchMinScore: 96 }],
    ["lower gap", { autoMatchMinGap: 19 }],
    ["fewer recent-IBAN days", { blockAutoOnRecentIbanChangeDays: 89 }],
    ["ledger patterns on", { autoLedgerPatterns: true }],
    ["incoming unknown IBAN on", { autoIncomingUnknownIban: true }],
    ["higher tolerance", { amountToleranceMinor: 1 }],
    ["new auto type", { autoTxTypes: ["transfer", "topup", "card_payment"] }],
    ["own-account type removed", { internalAccountTypes: [] }],
  ];
  const tighten: [string, Partial<AutoSafetyFields>][] = [
    ["higher min score", { autoMatchMinScore: 99 }],
    ["higher gap", { autoMatchMinGap: 40 }],
    ["more days", { blockAutoOnRecentIbanChangeDays: 120 }],
    ["fewer auto types", { autoTxTypes: ["transfer"] }],
    ["more internal types", { internalAccountTypes: ["self", "revolut"] }],
    ["reordered types", { autoTxTypes: ["topup", "transfer"] }],
  ];
  it("no change is not loosening", () => expect(isLoosening(base, { ...base })).toBe(false));
  for (const [name, patch] of loosen) {
    it(`loosening: ${name}`, () => expect(isLoosening(base, { ...base, ...patch })).toBe(true));
  }
  for (const [name, patch] of tighten) {
    it(`not loosening: ${name}`, () =>
      expect(isLoosening(base, { ...base, ...patch })).toBe(false));
  }
  it("turning a switch off or lowering the tolerance tightens", () => {
    const on = {
      ...base,
      autoLedgerPatterns: true,
      autoIncomingUnknownIban: true,
      amountToleranceMinor: 5,
    };
    expect(isLoosening(on, base)).toBe(false);
    expect(isLoosening(on, { ...on })).toBe(false);
  });
  it("accepts bigint tolerance and missing lists", () => {
    const bare: AutoSafetyFields = { ...base };
    delete bare.autoTxTypes;
    delete bare.internalAccountTypes;
    expect(
      isLoosening({ ...bare, amountToleranceMinor: 0n }, { ...bare, amountToleranceMinor: 1n }),
    ).toBe(true);
    expect(
      isLoosening({ ...bare, amountToleranceMinor: 5n }, { ...bare, amountToleranceMinor: 5 }),
    ).toBe(false);
  });
});

describe("incoming payment from an unknown IBAN (default: review)", () => {
  it("known IBAN: auto", () => {
    expect(matchTransaction(tx(), [item()], cfg).decision).toBe("auto");
  });
  it("IBAN not among the customer's IBANs: review, still the top candidate, never auto", () => {
    const r = matchTransaction(tx({ counterpartyIban: OTHER }), [item()], cfg);
    expect(r.decision).toBe("review");
    expect(r.candidates[0]?.score).toBeGreaterThanOrEqual(95);
    expect(r.candidates[0]?.blockedReasons).toContain("iban_unknown_for_customer");
    expect(r.candidates[0]?.autoEligible).toBe(false);
  });
  it("missing IBAN: review", () => {
    const r = matchTransaction(tx({ counterpartyIban: null }), [item()], cfg);
    expect(r.decision).toBe("review");
    expect(r.candidates[0]?.blockedReasons).toContain("iban_unknown_for_customer");
  });
  it("customer without any IBAN on file: review", () => {
    const r = matchTransaction(tx(), [item({ relationIbans: [] })], cfg);
    expect(r.decision).toBe("review");
  });
  it("opt-in true restores the old behaviour", () => {
    const on = { ...cfg, autoIncomingUnknownIban: true };
    expect(matchTransaction(tx({ counterpartyIban: OTHER }), [item()], on).decision).toBe("auto");
    expect(matchTransaction(tx({ counterpartyIban: null }), [item()], on).decision).toBe("auto");
  });
  it("does not touch payables, whose own rule is iban_not_known_for_supplier", () => {
    const r = matchTransaction(
      tx({ direction: "out", counterpartyIban: OTHER }),
      [item({ kind: "payable" })],
      cfg,
    );
    const b = r.candidates[0]?.blockedReasons ?? [];
    expect(b).toContain("iban_not_known_for_supplier");
    expect(b).not.toContain("iban_unknown_for_customer");
  });
  it("applies to a group payment: one unknown member blocks", () => {
    const a = item({ id: 10, invoiceNumber: "INV-2024-001", openMinor: 60000n });
    const b = item({ id: 11, invoiceNumber: "INV-2024-002", openMinor: 63400n });
    const t = tx({ reference: "INV-2024-001 INV-2024-002", counterpartyIban: OTHER });
    const r = matchTransaction(t, [a, b], cfg);
    expect(r.decision).toBe("review");
    expect(r.candidates.some((c) => c.blockedReasons.includes("iban_unknown_for_customer"))).toBe(
      true,
    );
    expect(matchTransaction({ ...t, counterpartyIban: IBAN }, [a, b], cfg).decision).toBe("auto");
  });
  it("a batch does not auto-claim through a blocked line", () => {
    const rs = matchBatch([tx({ id: 1, counterpartyIban: OTHER }), tx({ id: 2 })], [item()], cfg);
    expect(rs.map((r) => r.decision)).toEqual(["review", "auto"]);
  });
  it("the block code is exported and explained", () => {
    expect(BLOCK_CODES).toContain("iban_unknown_for_customer");
    expect(explainBlock("iban_unknown_for_customer")).toContain("customer");
  });
});
