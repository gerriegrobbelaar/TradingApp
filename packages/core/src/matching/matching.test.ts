import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_CONFIG,
  explainBlock,
  explainCandidate,
  formatAmount,
  matchBatch,
  matchTransaction,
  findInvoiceNumber,
  normaliseReference,
  referenceContainsInvoiceNumber,
  type MatchConfig,
  type MatchItem,
  type MatchTx,
} from "./index";

const IBAN = "NL91ABNA0417164300";
const OTHER_IBAN = "DE89370400440532013000";

function tx(over: Partial<MatchTx> = {}): MatchTx {
  return {
    id: 1,
    connectionId: 1,
    accountId: 1,
    direction: "in",
    amountMinor: 123400n,
    currency: "EUR",
    bookedAt: "2026-05-10",
    reference: null,
    description: null,
    counterpartyName: null,
    counterpartyIban: null,
    counterpartyRef: null,
    type: "transfer",
    isFinal: true,
    state: "completed",
    requestId: null,
    frozen: false,
    stateConflict: false,
    ...over,
  };
}

function item(over: Partial<MatchItem> = {}): MatchItem {
  return {
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
  };
}

// Legacy behaviour for the older tests; the default policy has its own tests below.
const cfg: MatchConfig = { ...DEFAULT_MATCH_CONFIG, autoIncomingUnknownIban: true };

describe("normaliseReference", () => {
  it("uppercases and strips punctuation", () => {
    expect(normaliseReference("inv 2024 001")).toBe("INV2024001");
    expect(normaliseReference("INV-2024-001")).toBe("INV2024001");
    expect(normaliseReference(null)).toBe("");
    expect(normaliseReference("ＩＮＶ１")).toBe("INV1");
  });
});

describe("referenceContainsInvoiceNumber", () => {
  const yes = (r: string, n: string) => expect(referenceContainsInvoiceNumber(r, n)).toBe(true);
  const no = (r: string, n: string) => expect(referenceContainsInvoiceNumber(r, n)).toBe(false);
  it("matches common shapes", () => {
    yes("Payment INV-2024-001 thanks", "INV-2024-001");
    yes("inv 2024 001", "INV-2024-001");
    yes("Invoice no. 2024/001", "2024-001");
    yes("Invoice no. 2024/001", "INV-2024-001");
    yes("INV2024001", "INV-2024-001");
    yes("pay INV-1 now", "INV-1");
  });
  it("respects token boundaries", () => {
    no("INV-10", "INV-1");
    no("x INV-1234", "INV-123");
    no("2024-1", "INV-1");
    no("12024-001", "2024-001");
    no("2024-0012", "2024-001");
    no("XINV-1", "INV-1");
  });
  it("rejects short numbers and empties", () => {
    no("pay 123 now", "123");
    no("pay 12 now", "12");
    no("anything", "");
    no("anything", "---");
    no("", "INV-1");
    expect(referenceContainsInvoiceNumber(null, "INV-1")).toBe(false);
    expect(referenceContainsInvoiceNumber("x", null)).toBe(false);
    no("2024 001", "INV-001");
  });
  it("handles several numbers and repeated near-misses", () => {
    yes("INV-10 and INV-1", "INV-1");
    yes("INV-2024-001, INV-2024-002", "INV-2024-002");
    yes("INV-1X INV-1", "INV-1");
  });
  it("does not match Cyrillic look-alikes", () => {
    no("\u0410BC-1", "ABC-1"); // Cyrillic A
    // Only the digit run of a Cyrillic-prefixed number matches: never exact, never automatic.
    expect(findInvoiceNumber("INV-2024-001", "ІNV-2024-001")).toBe("digits");
    expect(findInvoiceNumber("ІNV-2024-001", "INV-2024-001")).toBe("digits");
  });
});

describe("formatAmount", () => {
  it("formats exactly", () => {
    expect(formatAmount(123400n, "EUR")).toBe("€ 1.234,00");
    expect(formatAmount(-5n, "USD")).toBe("-USD 0,05");
    expect(formatAmount(1234567n, "JPY")).toBe("JPY 1.234.567");
    expect(formatAmount(2n ** 70n, "EUR")).toBe("€ 11.805.916.207.174.113.034,24");
  });
});

describe("rule 1: invoice number in reference", () => {
  it("full payment of a receivable is auto at 99", () => {
    const r = matchTransaction(tx({ reference: "Payment INV-2024-001" }), [item()], cfg);
    expect(r.decision).toBe("auto");
    expect(r.chosen?.score).toBe(99);
    expect(r.chosen?.kind).toBe("full");
    expect(r.chosen?.remainingMinor).toBe(0n);
    expect(r.chosen?.allocations).toEqual([{ itemId: 10, allocatedMinor: 123400n }]);
    expect(r.explanation[0]).toBe("€ 1.234,00 equals the open balance of INV-2024-001");
  });
  it("partial payment keeps the remainder open and goes to review", () => {
    const r = matchTransaction(
      tx({ reference: "INV-2024-001", amountMinor: 100000n }),
      [item()],
      cfg,
    );
    expect(r.decision).toBe("review");
    expect(r.candidates[0]).toMatchObject({
      kind: "partial",
      score: 88,
      remainingMinor: 23400n,
      allocatedMinor: 100000n,
    });
    expect(r.explanation[0]).toContain("part payment");
    expect(r.explanation[0]).toContain("€ 234,00 stays open");
  });
  it("overpayment allocates the open balance", () => {
    const r = matchTransaction(
      tx({ reference: "INV-2024-001", amountMinor: 130000n }),
      [item()],
      cfg,
    );
    expect(r.decision).toBe("review");
    expect(r.candidates[0]).toMatchObject({
      kind: "overpayment",
      score: 70,
      allocatedMinor: 123400n,
      remainingMinor: 0n,
    });
    expect(r.explanation[0]).toBe(
      "€ 1.300,00 is € 66,00 more than the open balance of INV-2024-001",
    );
  });
  it("uses description and yourRef, and entry number for payables", () => {
    expect(
      matchTransaction(tx({ description: "INV-2024-001" }), [item()], cfg).candidates[0]?.rule,
    ).toBe(1);
    const viaRef = item({ invoiceNumber: null, yourRef: "PO 55555" });
    expect(matchTransaction(tx({ reference: "PO 55555" }), [viaRef], cfg).candidates[0]?.rule).toBe(
      1,
    );
    const pay = item({ kind: "payable", invoiceNumber: null, entryNumber: "25000123" });
    const r = matchTransaction(tx({ direction: "out", reference: "25000123" }), [pay], cfg);
    expect(r.candidates[0]?.rule).toBe(1);
    const rec = item({ invoiceNumber: null, entryNumber: "25000123" });
    expect(
      matchTransaction(tx({ reference: "25000123" }), [rec], cfg).candidates.find(
        (c) => c.rule === 1,
      ),
    ).toBeUndefined();
  });
  it("currency mismatch is review only", () => {
    const r = matchTransaction(tx({ reference: "INV-2024-001", currency: "USD" }), [item()], cfg);
    expect(r.decision).toBe("review");
    expect(r.candidates[0]?.blockedReasons).toContain("currency_mismatch");
    expect(r.candidates[0]?.allocations).toEqual([]);
    expect(r.candidates[0]?.allocatedMinor).toBe(0n);
    expect(r.explanation[0]).toBe("USD 1.234,00 is in USD, but INV-2024-001 is open in EUR");
  });
  it("wrong direction yields no candidate", () => {
    const r = matchTransaction(tx({ direction: "out", reference: "INV-2024-001" }), [item()], cfg);
    expect(r.decision).toBe("none");
  });
  it("credit notes settle in the opposite direction", () => {
    const cn = item({ openMinor: -123400n });
    expect(
      matchTransaction(tx({ direction: "out", reference: "INV-2024-001" }), [cn], cfg).decision,
    ).toBe("auto");
    expect(
      matchTransaction(tx({ direction: "in", reference: "INV-2024-001" }), [cn], cfg).decision,
    ).toBe("none");
    const pcn = item({ kind: "payable", openMinor: -123400n });
    expect(
      matchTransaction(
        tx({ direction: "in", reference: "INV-2024-001", counterpartyIban: IBAN }),
        [pcn],
        cfg,
      ).decision,
    ).toBe("auto");
    expect(
      matchTransaction(tx({ direction: "out", reference: "INV-2024-001" }), [pcn], cfg).decision,
    ).toBe("none");
  });
  it("zero open balance is ignored", () => {
    expect(
      matchTransaction(tx({ reference: "INV-2024-001" }), [item({ openMinor: 0n })], cfg).decision,
    ).toBe("none");
  });
  it("amount tolerance", () => {
    const c: MatchConfig = { ...cfg, amountToleranceMinor: 5n };
    const r = matchTransaction(
      tx({ reference: "INV-2024-001", amountMinor: 123398n }),
      [item()],
      c,
    );
    // Tolerance widens what is offered as full, but a difference is never booked silently.
    expect(r.decision).toBe("review");
    expect(r.candidates[0]?.kind).toBe("full");
    expect(r.candidates[0]?.blockedReasons).toEqual(["amount_difference"]);
    expect(r.candidates[0]?.allocatedMinor).toBe(123398n);
    expect(r.candidates[0]?.remainingMinor).toBe(2n);
    expect(r.explanation.join(" ")).toContain("€ 0,02 difference");
    const over = matchTransaction(
      tx({ reference: "INV-2024-001", amountMinor: 123403n }),
      [item()],
      c,
    );
    expect(over.candidates[0]?.allocatedMinor).toBe(123400n);
    expect(over.candidates[0]?.surplusMinor).toBe(3n);
    expect(over.decision).toBe("review");
    expect(
      matchTransaction(tx({ reference: "INV-2024-001", amountMinor: 123390n }), [item()], c)
        .decision,
    ).toBe("review");
  });
  it("amounts beyond 2^53", () => {
    const big = 2n ** 60n + 1n;
    const r = matchTransaction(
      tx({ reference: "INV-2024-001", amountMinor: big }),
      [item({ openMinor: big })],
      cfg,
    );
    expect(r.decision).toBe("auto");
    expect(r.chosen?.allocatedMinor).toBe(big);
    const off = matchTransaction(
      tx({ reference: "INV-2024-001", amountMinor: big }),
      [item({ openMinor: big - 1n })],
      cfg,
    );
    expect(off.candidates[0]?.kind).toBe("overpayment");
  });
});

describe("rule 1: group payment", () => {
  const a = item({ id: 1, invoiceNumber: "INV-2024-001", openMinor: 10000n });
  const b = item({ id: 2, invoiceNumber: "INV-2024-002", openMinor: 25000n });
  const c = item({ id: 3, invoiceNumber: "INV-2024-003", openMinor: 5000n });
  it("pays two invoices exactly: one group candidate, auto at 97", () => {
    const r = matchTransaction(
      tx({ amountMinor: 35000n, reference: "INV-2024-001 INV-2024-002" }),
      [c, b, a],
      cfg,
    );
    expect(r.decision).toBe("auto");
    expect(r.chosen).toMatchObject({ score: 97, groupId: "g:1-2", itemId: 1, kind: "full" });
    expect(r.chosen?.allocations).toEqual([
      { itemId: 1, allocatedMinor: 10000n },
      { itemId: 2, allocatedMinor: 25000n },
    ]);
    expect(r.candidates).toHaveLength(1);
    expect(r.explanation[0]).toBe(
      "€ 350,00 equals the combined open balance of INV-2024-001, INV-2024-002",
    );
  });
  it("picks the subset that sums to the amount", () => {
    const r = matchTransaction(
      tx({ amountMinor: 30000n, reference: "INV-2024-001 INV-2024-002 INV-2024-003" }),
      [a, b, c],
      cfg,
    );
    // The reference also names INV-2024-001, which the group leaves out: a person decides.
    expect(r.decision).toBe("review");
    expect(r.candidates[0]?.groupId).toBe("g:2-3");
    expect(r.candidates[0]?.blockedReasons).toEqual(["reference_names_other_item"]);
  });
  it("sum that does not match is not a group", () => {
    const r = matchTransaction(
      tx({ amountMinor: 36000n, reference: "INV-2024-001 INV-2024-002" }),
      [a, b],
      cfg,
    );
    expect(r.candidates.every((x) => x.groupId === undefined)).toBe(true);
    expect(r.decision).toBe("review");
  });
  it("ambiguous equal groups go to review", () => {
    const d = item({ id: 4, invoiceNumber: "INV-2024-004", openMinor: 10000n });
    const r = matchTransaction(
      tx({ amountMinor: 20000n, reference: "INV-2024-001 INV-2024-004 INV-2024-003" }),
      [a, d, item({ id: 5, invoiceNumber: "INV-2024-003", openMinor: 10000n })],
      cfg,
    );
    expect(r.decision).toBe("review");
    expect(r.candidates.filter((x) => x.groupId).length).toBe(3);
  });
  it("blocked when a member has a live match", () => {
    const r = matchTransaction(
      tx({ amountMinor: 35000n, reference: "INV-2024-001 INV-2024-002" }),
      [a, { ...b, hasLiveMatch: true }],
      cfg,
    );
    expect(r.decision).toBe("review");
    expect(r.candidates[0]?.blockedReasons).toContain("item_has_live_match");
  });
  it("more than eight hits or more than five invoices are not grouped", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      item({ id: i + 1, invoiceNumber: `INV-2024-10${i}`, openMinor: 100n }),
    );
    const ref = many.map((m) => m.invoiceNumber).join(" ");
    const r = matchTransaction(tx({ amountMinor: 900n, reference: ref }), many, cfg);
    expect(r.candidates.some((x) => x.groupId)).toBe(false);
    const six = many.slice(0, 6);
    const r6 = matchTransaction(
      tx({ amountMinor: 600n, reference: six.map((m) => m.invoiceNumber).join(" ") }),
      six,
      cfg,
    );
    expect(r6.candidates.some((x) => x.groupId)).toBe(false);
  });
});

describe("rule 2: IBAN matches relation", () => {
  it("unique amount among the relation's items scores 96 and is auto", () => {
    const other = item({ id: 11, invoiceNumber: "INV-2024-002", openMinor: 999n });
    const r = matchTransaction(
      tx({ counterpartyIban: "nl91 abna 0417 1643 00" }),
      [item(), other],
      cfg,
    );
    expect(r.decision).toBe("auto");
    expect(r.chosen).toMatchObject({ rule: 2, score: 96, itemId: 10 });
    expect(r.explanation).toContain("It is the only open item of the relation with this amount");
  });
  it("same amount on several items is review at 80 and lists all", () => {
    const r = matchTransaction(
      tx({ counterpartyIban: IBAN }),
      [item(), item({ id: 11, invoiceNumber: "INV-2024-002" })],
      cfg,
    );
    expect(r.decision).toBe("review");
    expect(r.candidates.map((c) => [c.itemId, c.score])).toEqual([
      [10, 80],
      [11, 80],
    ]);
  });
  it("amount matching none gives a 60 suggestion", () => {
    const less = matchTransaction(
      tx({ counterpartyIban: IBAN, amountMinor: 1000n }),
      [item()],
      cfg,
    );
    expect(less.candidates[0]).toMatchObject({ kind: "partial", score: 60 });
    const more = matchTransaction(
      tx({ counterpartyIban: IBAN, amountMinor: 999999n }),
      [item()],
      cfg,
    );
    expect(more.candidates[0]).toMatchObject({ kind: "overpayment", score: 55 });
    expect(more.decision).toBe("review");
  });
  it("other relation's IBAN gives nothing for rule 2", () => {
    const r = matchTransaction(
      tx({ counterpartyIban: OTHER_IBAN, amountMinor: 1000n }),
      [item()],
      cfg,
    );
    expect(r.decision).toBe("none");
  });
  it("IBAN with a different currency does not create a rule 2 candidate", () => {
    const r = matchTransaction(tx({ counterpartyIban: IBAN, currency: "USD" }), [item()], cfg);
    expect(r.decision).toBe("none");
  });
  it("name similarity adds a small bonus, never a candidate alone", () => {
    const named = matchTransaction(
      tx({ counterpartyIban: IBAN, counterpartyName: "ACME BV" }),
      [item(), item({ id: 11 })],
      cfg,
    );
    expect(named.candidates[0]?.score).toBe(85);
    const alone = matchTransaction(
      tx({ amountMinor: 1n, counterpartyName: "Acme B.V." }),
      [item()],
      cfg,
    );
    expect(alone.decision).toBe("none");
  });
  it("reference hit plus iban adds a point and due date adds two (clamped to 100)", () => {
    const r = matchTransaction(
      tx({
        reference: "INV-2024-001",
        counterpartyIban: IBAN,
        counterpartyName: "Acme",
        bookedAt: "2026-05-10",
      }),
      [item({ dueDate: "2026-05-12" })],
      cfg,
    );
    expect(r.candidates[0]?.score).toBe(100);
  });
});

describe("rule 3: amount only", () => {
  it("single candidate is a 70 suggestion and never auto", () => {
    const r = matchTransaction(tx(), [item()], cfg);
    expect(r.decision).toBe("review");
    expect(r.candidates[0]).toMatchObject({ rule: 3, score: 70 });
    expect(r.candidates[0]?.blockedReasons).toContain("suggestion_only");
    expect(r.explanation[0]).toContain("equals the open balance");
    expect(r.explanation).toContain("It is the only open item with this amount");
  });
  it("several candidates score 50 each", () => {
    const r = matchTransaction(tx(), [item(), item({ id: 11 })], cfg);
    expect(r.candidates.map((c) => c.score)).toEqual([50, 50]);
    expect(r.explanation).toContain("Several open items have this amount");
  });
  it("capped at 70 even with a name bonus", () => {
    const r = matchTransaction(tx({ counterpartyName: "Acme" }), [item()], cfg);
    expect(r.candidates[0]?.score).toBe(70);
  });
  it("closed items are not in the pool", () => {
    const r = matchTransaction(tx(), [item(), item({ id: 11, closed: true })], cfg);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.score).toBe(70);
  });
  it("different currency does not match by amount", () => {
    expect(matchTransaction(tx({ currency: "USD" }), [item()], cfg).decision).toBe("none");
  });
});

describe("rule 4: ledger patterns", () => {
  const patterns = [
    {
      id: "fee",
      ledgerAccountCode: "4990",
      description: "Bank fees",
      test: {
        counterpartyNameRegex: "^revolut",
        type: "fee",
        direction: "out" as const,
        maxAmountMinor: 5000n,
      },
    },
    {
      id: "card",
      ledgerAccountCode: "4100",
      description: "Card payment",
      test: { referenceRegex: "CARD\\s+PAYMENT" },
    },
  ];
  const c: MatchConfig = { ...cfg, patterns };
  it("matches a pattern, review only by default", () => {
    const r = matchTransaction(
      tx({ direction: "out", amountMinor: 250n, counterpartyName: "Revolut Bank", type: "fee" }),
      [],
      c,
    );
    expect(r.decision).toBe("review");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      rule: 4,
      kind: "ledger",
      score: 90,
      ledgerAccountCode: "4990",
      itemId: null,
    });
    expect(r.candidates[0]?.blockedReasons).toContain("ledger_auto_disabled");
    expect(r.explanation[0]).toBe('€ 2,50 fits the pattern "Bank fees" for ledger account 4990');
  });
  it("opt-in auto", () => {
    const r = matchTransaction(
      tx({ direction: "out", amountMinor: 250n, counterpartyName: "Revolut", type: "fee" }),
      [],
      { ...c, autoLedgerPatterns: true },
    );
    expect(r.decision).toBe("auto");
    expect(r.chosen?.score).toBe(95);
    const frozen = matchTransaction(
      tx({
        direction: "out",
        amountMinor: 250n,
        counterpartyName: "Revolut",
        type: "fee",
        frozen: true,
      }),
      [],
      { ...c, autoLedgerPatterns: true },
    );
    expect(frozen.decision).toBe("review");
  });
  it("each test field is enforced", () => {
    const base = {
      direction: "out" as const,
      amountMinor: 250n,
      counterpartyName: "Revolut",
      type: "fee",
    };
    expect(matchTransaction(tx({ ...base, amountMinor: 9000n }), [], c).decision).toBe("none");
    expect(matchTransaction(tx({ ...base, direction: "in" }), [], c).decision).toBe("none");
    expect(matchTransaction(tx({ ...base, type: "card" }), [], c).decision).toBe("none");
    expect(matchTransaction(tx({ ...base, counterpartyName: null }), [], c).decision).toBe("none");
    expect(matchTransaction(tx({ ...base, counterpartyName: "Other" }), [], c).decision).toBe(
      "none",
    );
  });
  it("reference regex looks at reference and description", () => {
    expect(
      matchTransaction(tx({ description: "card  payment shop" }), [], c).candidates[0]
        ?.ledgerAccountCode,
    ).toBe("4100");
    expect(matchTransaction(tx(), [], c).decision).toBe("none");
  });
  it("a better invoice match outranks a pattern but the gap keeps it in review", () => {
    const r = matchTransaction(tx({ reference: "INV-2024-001 card payment" }), [item()], c);
    expect(r.candidates.map((x) => x.rule)).toEqual([1, 4]);
    expect(r.decision).toBe("review");
    expect(r.candidates[0]?.blockedReasons).toContain("close_second_candidate");
    expect(r.explanation.at(-1)).toContain("Another candidate scores almost as high");
  });
});

describe("auto-match block conditions", () => {
  const good = () => tx({ reference: "INV-2024-001" });
  it("baseline is auto", () => {
    expect(matchTransaction(good(), [item()], cfg).decision).toBe("auto");
  });
  it("not final or not completed is none", () => {
    for (const over of [
      { isFinal: false },
      { state: "pending" },
      { state: "declined" },
      { state: "failed" },
      { state: "reverted" },
      { state: "unknown", isFinal: false },
    ]) {
      const r = matchTransaction({ ...good(), ...over }, [item()], cfg);
      expect(r.decision).toBe("none");
      expect(r.explanation[0]).toContain("not completed");
    }
    expect(matchTransaction(tx({ amountMinor: 0n }), [item()], cfg).decision).toBe("none");
  });
  it("frozen and state conflict are review", () => {
    expect(
      matchTransaction({ ...good(), frozen: true }, [item()], cfg).candidates[0]?.blockedReasons,
    ).toContain("tx_frozen");
    expect(matchTransaction({ ...good(), stateConflict: true }, [item()], cfg).decision).toBe(
      "review",
    );
  });
  it("item live match or closed", () => {
    expect(matchTransaction(good(), [item({ hasLiveMatch: true })], cfg).decision).toBe("review");
    const r = matchTransaction(good(), [item({ closed: true })], cfg);
    expect(r.decision).toBe("review");
    expect(r.candidates[0]?.blockedReasons).toContain("item_closed");
  });
  it("close second candidate", () => {
    const r = matchTransaction(
      good(),
      [
        item(),
        item({ id: 11, invoiceNumber: "INV-2024-002", openMinor: 5n, relationIbans: [IBAN] }),
      ],
      { ...cfg, autoMatchMinGap: 20 },
    );
    expect(r.decision).toBe("auto");
    const tight = matchTransaction(good(), [item()], {
      ...cfg,
      autoMatchMinGap: 20,
      patterns: [
        { id: "p", ledgerAccountCode: "1", description: "d", test: { referenceRegex: "INV" } },
      ],
    });
    expect(tight.decision).toBe("review");
  });
  it("payables: recent IBAN change is blocked, old is fine", () => {
    const base = { kind: "payable" as const };
    const t = tx({
      direction: "out",
      reference: "INV-2024-001",
      counterpartyIban: IBAN,
      bookedAt: "2026-05-10",
    });
    expect(
      matchTransaction(t, [item({ ...base, relationIbanAddedAt: "2026-04-01" })], cfg).candidates[0]
        ?.blockedReasons,
    ).toContain("iban_recently_changed");
    expect(
      matchTransaction(t, [item({ ...base, relationIbanChangedAt: "2026-05-09" })], cfg).decision,
    ).toBe("review");
    expect(
      matchTransaction(t, [item({ ...base, relationIbanChangedAt: "2026-06-01" })], cfg).decision,
    ).toBe("review");
    expect(
      matchTransaction(t, [item({ ...base, relationIbanChangedAt: "garbage" })], cfg).decision,
    ).toBe("review");
    expect(
      matchTransaction(
        t,
        [item({ ...base, relationIbanAddedAt: "2025-01-01", relationIbanChangedAt: "2025-06-01" })],
        cfg,
      ).decision,
    ).toBe("auto");
    expect(
      matchTransaction(
        { ...t, bookedAt: "bad" },
        [item({ ...base, relationIbanAddedAt: "2025-01-01" })],
        cfg,
      ).decision,
    ).toBe("review");
    // receivables are not subject to it
    expect(
      matchTransaction(good(), [item({ relationIbanAddedAt: "2026-05-01" })], cfg).decision,
    ).toBe("auto");
    const tight = { ...cfg, blockAutoOnRecentIbanChangeDays: 30 };
    expect(
      matchTransaction(t, [item({ ...base, relationIbanAddedAt: "2026-04-01" })], tight).decision,
    ).toBe("auto");
  });
  it("payables: unknown IBAN is never auto (fraud signal)", () => {
    const t = tx({ direction: "out", reference: "INV-2024-001", counterpartyIban: OTHER_IBAN });
    const r = matchTransaction(t, [item({ kind: "payable" })], cfg);
    expect(r.decision).toBe("review");
    expect(r.candidates[0]?.blockedReasons).toContain("iban_not_known_for_supplier");
    expect(r.explanation.join(" ")).toContain("check for fraud");
    // No account number on an outgoing payment: nothing to verify, so never automatic.
    expect(
      matchTransaction({ ...t, counterpartyIban: null }, [item({ kind: "payable" })], cfg).decision,
    ).toBe("review");
    expect(
      matchTransaction({ ...t, counterpartyIban: "  " }, [item({ kind: "payable" })], cfg).decision,
    ).toBe("review");
    expect(
      matchTransaction(
        { ...t, counterpartyIban: IBAN.toLowerCase() },
        [item({ kind: "payable" })],
        cfg,
      ).decision,
    ).toBe("auto");
    expect(
      matchTransaction(
        { ...t, counterpartyIban: OTHER_IBAN },
        [item({ kind: "payable", relationIbans: [] })],
        cfg,
      ).decision,
    ).toBe("review");
  });
  it("score below threshold", () => {
    const r = matchTransaction(good(), [item()], { ...cfg, autoMatchMinScore: 100 });
    expect(r.decision).toBe("review");
    expect(r.candidates[0]?.blockedReasons).toContain("score_below_threshold");
  });
  it("candidates are capped and below suggestMinScore dropped", () => {
    const items = Array.from({ length: 9 }, (_, i) => item({ id: i + 1, invoiceNumber: null }));
    expect(matchTransaction(tx(), items, cfg).candidates).toHaveLength(5);
    expect(matchTransaction(tx(), items, { ...cfg, maxCandidates: 2 }).candidates).toHaveLength(2);
    expect(() => matchTransaction(tx(), items, { ...cfg, maxCandidates: 0 })).toThrow(RangeError);
    expect(matchTransaction(tx(), items, { ...cfg, suggestMinScore: 60 }).decision).toBe("none");
  });
  it("null and empty fields", () => {
    const empty = item({
      invoiceNumber: null,
      relationId: null,
      relationName: null,
      relationIbans: [],
      dueDate: null,
    });
    expect(matchTransaction(tx({ reference: "", description: "" }), [empty], cfg).decision).toBe(
      "review",
    );
    expect(() => matchTransaction(tx(), [], cfg)).not.toThrow();
  });
});

describe("matchBatch", () => {
  it("two transactions competing for one invoice: only one auto", () => {
    const a = tx({ id: 2, reference: "INV-2024-001" });
    const b = tx({ id: 1, reference: "INV-2024-001" });
    const res = matchBatch([a, b], [item()], cfg);
    expect(res[0]?.txId).toBe(2);
    expect(res[1]?.txId).toBe(1);
    expect(res[1]?.decision).toBe("auto");
    expect(res[0]?.decision).toBe("review");
    expect(res[0]?.candidates[0]?.blockedReasons).toContain("claimed_by_earlier_transaction");
    expect(res[0]?.explanation.join(" ")).toContain("earlier transaction");
  });
  it("orders by date first", () => {
    const early = tx({ id: 9, bookedAt: "2026-05-01", reference: "INV-2024-001" });
    const late = tx({ id: 3, bookedAt: "2026-05-02", reference: "INV-2024-001" });
    const res = matchBatch([late, early], [item()], cfg);
    expect(res.map((r) => r.decision)).toEqual(["review", "auto"]);
  });
  it("claims are released by non-auto results and group members are claimed", () => {
    const a = item({ id: 1, invoiceNumber: "INV-2024-001", openMinor: 10000n });
    const b = item({ id: 2, invoiceNumber: "INV-2024-002", openMinor: 25000n });
    const g = tx({ id: 1, amountMinor: 35000n, reference: "INV-2024-001 INV-2024-002" });
    const s = tx({ id: 2, amountMinor: 10000n, reference: "INV-2024-001" });
    const res = matchBatch([g, s], [a, b], cfg);
    expect(res[0]?.decision).toBe("auto");
    expect(res[1]?.decision).toBe("review");
    const pending = tx({ id: 0, isFinal: false, state: "pending", reference: "INV-2024-001" });
    expect(matchBatch([pending, s], [a], cfg).map((r) => r.decision)).toEqual(["none", "auto"]);
    expect(matchBatch([], [a], cfg)).toEqual([]);
  });
});

describe("explainCandidate", () => {
  it("falls back for unknown items and blocks", () => {
    const r = matchTransaction(tx({ reference: "INV-2024-001" }), [item()], cfg);
    const c = r.chosen!;
    expect(explainCandidate(c, { tx: tx(), items: [] })[0]).toBe(
      "€ 1.234,00 equals the open balance of item 10",
    );
    expect(explainBlock("zzz")).toBe("zzz, so it goes to review");
    const noLabel = explainCandidate(
      { ...c, allocations: [], itemId: null },
      { tx: tx(), items: [] },
    );
    expect(noLabel[0]).toContain("the item");
    const noPattern = explainCandidate(
      { ...c, kind: "ledger", ledgerAccountCode: null, reasons: [] },
      { tx: tx(), items: [] },
    );
    expect(noPattern[0]).toContain("a known pattern");
    const mism = explainCandidate(
      { ...c, reasons: [{ code: "currency_mismatch", weight: 0 }], itemId: null },
      { tx: tx(), items: [] },
    );
    expect(mism[0]).toContain("another currency");
    const reasonsOnly = explainCandidate(
      {
        ...c,
        reasons: [
          { code: "invoice_number_in_reference", weight: 1 },
          { code: "pattern", weight: 0 },
        ],
      },
      { tx: tx(), items: [item()] },
    );
    expect(reasonsOnly).toContain("The reference contains INV-2024-001");
  });
  it("labels items by entry number, yourRef or id", () => {
    const t = tx({ reference: "PO 55555" });
    const r = matchTransaction(t, [item({ invoiceNumber: null, yourRef: "PO 55555" })], cfg);
    expect(r.explanation[0]).toContain("PO 55555");
    const e = matchTransaction(
      tx({ direction: "out", counterpartyIban: IBAN }),
      [item({ kind: "payable", invoiceNumber: null, entryNumber: "E1" })],
      cfg,
    );
    expect(e.explanation[0]).toContain("E1");
    const n = matchTransaction(tx(), [item({ invoiceNumber: null })], cfg);
    expect(n.explanation[0]).toContain("item 10");
  });
});

// ---- property tests (seeded, deterministic) ---------------------------------------------------

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;

function randomWorld(r: () => number) {
  const ibans = [IBAN, OTHER_IBAN, "BE68539007547034"];
  const items: MatchItem[] = Array.from({ length: 2 + Math.floor(r() * 8) }, (_, i) =>
    item({
      id: i + 1,
      kind: r() < 0.5 ? "receivable" : "payable",
      invoiceNumber: r() < 0.8 ? `INV-2024-${String(100 + Math.floor(r() * 12))}` : null,
      relationId: 1 + Math.floor(r() * 3),
      relationName: pick(r, ["Acme B.V.", "Beta GmbH", "Gamma Ltd"]),
      relationIbans: [pick(r, ibans)],
      relationIbanChangedAt: r() < 0.3 ? "2026-05-01" : null,
      currency: r() < 0.85 ? "EUR" : "USD",
      openMinor: BigInt((r() < 0.15 ? -1 : 1) * (100 * (1 + Math.floor(r() * 6)))),
      hasLiveMatch: r() < 0.1,
      closed: r() < 0.1,
    }),
  );
  const t = tx({
    direction: r() < 0.5 ? "in" : "out",
    amountMinor: BigInt(100 * (1 + Math.floor(r() * 6))),
    currency: r() < 0.85 ? "EUR" : "USD",
    reference: r() < 0.6 ? `pay INV-2024-${100 + Math.floor(r() * 12)}` : null,
    counterpartyIban: r() < 0.7 ? pick(r, ibans) : null,
    frozen: r() < 0.1,
    stateConflict: r() < 0.1,
  });
  return { t, items };
}

function shuffle<T>(r: () => number, xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

describe("properties", () => {
  const r = prng(20260511);
  const worlds = Array.from({ length: 400 }, () => randomWorld(r));

  it("ranking is stable under item permutations", () => {
    const sh = prng(7);
    for (const { t, items } of worlds) {
      const a = matchTransaction(t, items, cfg);
      const b = matchTransaction(t, shuffle(sh, items), cfg);
      expect(b).toEqual(a);
    }
  });

  it("invariants: direction, caps, scores, auto conditions", () => {
    for (const { t, items } of worlds) {
      const res = matchTransaction(t, items, cfg);
      expect(res.candidates.length).toBeLessThanOrEqual(cfg.maxCandidates);
      for (let i = 1; i < res.candidates.length; i++) {
        expect(res.candidates[i - 1]!.score).toBeGreaterThanOrEqual(res.candidates[i]!.score);
      }
      for (const c of res.candidates) {
        expect(Number.isInteger(c.score)).toBe(true);
        expect(c.score).toBeGreaterThanOrEqual(0);
        expect(c.score).toBeLessThanOrEqual(100);
        for (const a of c.allocations) {
          const it = items.find((x) => x.id === a.itemId)!;
          const dir = (it.kind === "receivable") === it.openMinor > 0n ? "in" : "out";
          expect(dir).toBe(t.direction);
          expect(a.allocatedMinor).toBeGreaterThan(0n);
        }
        if (c.autoEligible) expect(c.blockedReasons).toEqual([]);
      }
      if (res.decision === "auto") {
        const c = res.chosen!;
        expect(c.score).toBeGreaterThanOrEqual(95);
        expect(c.kind).toBe("full");
        expect(t.frozen || t.stateConflict).toBe(false);
        for (const a of c.allocations) {
          const it = items.find((x) => x.id === a.itemId)!;
          expect(it.hasLiveMatch || it.closed).toBe(false);
          expect(it.currency).toBe(t.currency);
          if (it.kind === "payable") {
            expect(it.relationIbanChangedAt).toBeNull();
            if (t.counterpartyIban) expect(it.relationIbans).toContain(t.counterpartyIban);
          }
        }
        expect(res.candidates[1] ? res.candidates[1].score <= c.score - 20 : true).toBe(true);
      }
    }
  });

  it("never auto when any block condition holds", () => {
    for (const { t, items } of worlds) {
      for (const mutate of [
        (x: MatchTx) => ({ ...x, frozen: true }),
        (x: MatchTx) => ({ ...x, stateConflict: true }),
        (x: MatchTx) => ({ ...x, isFinal: false }),
        (x: MatchTx) => ({ ...x, state: "reverted" }),
      ]) {
        expect(matchTransaction(mutate(t), items, cfg).decision).not.toBe("auto");
      }
      expect(
        matchTransaction(
          t,
          items.map((i) => ({ ...i, hasLiveMatch: true })),
          cfg,
        ).decision,
      ).not.toBe("auto");
      expect(
        matchTransaction(
          t,
          items.map((i) => ({ ...i, closed: true })),
          cfg,
        ).decision,
      ).not.toBe("auto");
    }
  });

  it("scores are monotone in evidence", () => {
    for (const { t, items } of worlds) {
      const base = matchTransaction({ ...t, reference: null, counterpartyIban: null }, items, cfg);
      const withIban = matchTransaction({ ...t, reference: null }, items, cfg);
      for (const c of base.candidates) {
        const same = withIban.candidates.find(
          (x) => x.itemId === c.itemId && x.rule === c.rule && x.groupId === c.groupId,
        );
        // A known IBAN of ANOTHER relation is negative evidence by design.
        if (same && !same.reasons.some((r) => r.code === "iban_belongs_to_other_relation")) {
          expect(same.score).toBeGreaterThanOrEqual(c.score);
        }
      }
      const top = (x: typeof base) => x.candidates[0]?.score ?? 0;
      const target = items.find((i) => i.invoiceNumber);
      if (target) {
        const plain = matchTransaction({ ...t, reference: null }, items, cfg);
        const ref = matchTransaction({ ...t, reference: target.invoiceNumber }, items, cfg);
        const forItem = (x: typeof base) =>
          Math.max(
            0,
            ...x.candidates
              .filter((c) => c.allocations.some((a) => a.itemId === target.id))
              .map((c) => c.score),
          );
        expect(forItem(ref)).toBeGreaterThanOrEqual(forItem(plain));
      }
      expect(top(withIban)).toBeGreaterThanOrEqual(0);
    }
  });

  it("batch results do not depend on input order, and an item is auto-claimed at most once", () => {
    const sh = prng(11);
    for (let k = 0; k < 60; k++) {
      const { items } = worlds[k]!;
      const txs = Array.from({ length: 4 }, (_, i) => ({
        ...worlds[k + i]!.t,
        id: i + 1,
        bookedAt: "2026-05-10",
      }));
      const a = matchBatch(txs, items, cfg);
      const b = matchBatch(shuffle(sh, txs), items, cfg);
      const byId = (rs: typeof a) => new Map(rs.map((x) => [x.txId, x]));
      for (const x of a) expect(byId(b).get(x.txId)).toEqual(x);
      const claimed = a
        .filter((x) => x.decision === "auto")
        .flatMap((x) => x.chosen!.allocations.map((al) => al.itemId));
      expect(new Set(claimed).size).toBe(claimed.length);
    }
  });
});
