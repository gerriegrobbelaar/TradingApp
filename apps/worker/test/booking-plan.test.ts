/**
 * planMatch (pure, ADR 0044): what a match becomes in Exact, or why a person must do it by hand.
 */
import { describe, expect, it } from "vitest";
import {
  buildMatchsetFromPlan,
  parseDoc,
  planFailureKey,
  planMatch,
  serializeDoc,
  type Candidate,
  type CandidateItem,
} from "../src/booking/plan";

const G1 = "a0000000-0000-4000-8000-000000000001";
const G2 = "a0000000-0000-4000-8000-000000000002";

const item = (over: Partial<CandidateItem> = {}): CandidateItem => ({
  id: 1,
  exactId: "item-1",
  kind: "invoice",
  relationId: G1,
  relationCode: "R100",
  entryNumber: 21,
  openMinor: 10_000,
  allocatedMinor: 10_000,
  currency: "EUR",
  status: "open",
  invoiceNumber: "2026001",
  ...over,
});

const cand = (over: Partial<Candidate> = {}, items: CandidateItem[] = [item()]): Candidate => ({
  matchId: 1,
  divisionId: 1,
  exactDivision: 123,
  baseCurrency: "EUR",
  source: "manual",
  ledgerAccountCode: null,
  ledgerGlId: null,
  currency: "EUR",
  tx: {
    id: 1,
    externalId: "tx-abc-1",
    connectionId: 2,
    amountMinor: 10_000,
    currency: "EUR",
    bookedAt: "2026-07-15T10:00:00.000Z",
    counterpartyName: "Acme B.V.",
    reference: "INV 2026001",
    description: null,
  },
  map: { journalCode: "90", receivableGl: "1300", payableGl: "1600" },
  items,
  ...over,
});

const code = (p: ReturnType<typeof planMatch>): string | null => (p.ok ? null : p.code);

describe("planMatch", () => {
  it("a full receivable match: bank entry line to the relation, MatchSet of the item and the bank line", () => {
    const p = planMatch(cand());
    expect(p.ok && p.mode).toBe("matched");
    if (!p.ok || p.mode !== "matched") return;
    expect(p.bankEntry.lines[0]).toMatchObject({
      amountMinor: 10_000,
      accountId: G1,
      ourRef: 2026001,
    });
    expect(p.matchset).toMatchObject({
      kind: "receivable",
      glAccountCode: "1300",
      relationCode: "R100",
      items: [{ entryNumber: 21, amountMinor: 10_000, openBeforeMinor: 10_000 }],
      bankAmountMinor: -10_000,
    });
    expect(p.bankEntryKey).toMatch(/^[0-9a-f]{64}$/);
    expect(p.matchsetKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a bill paid out: money out, bill negative in the relation ledger, bank line positive", () => {
    const p = planMatch(
      cand({ tx: { ...cand().tx, amountMinor: -4_000 } }, [
        item({ kind: "bill", openMinor: 4_000, allocatedMinor: 4_000 }),
      ]),
    );
    expect(p.ok && p.mode === "matched" && p.matchset).toMatchObject({
      kind: "payable",
      glAccountCode: "1600",
      items: [{ amountMinor: -4_000 }],
      bankAmountMinor: 4_000,
    });
  });

  it("two invoices paid by one payment: one MatchSet with both, the bank line balances them", () => {
    const p = planMatch(
      cand({ tx: { ...cand().tx, amountMinor: 13_000 } }, [
        item({ id: 1, exactId: "a", entryNumber: 21, openMinor: 10_000, allocatedMinor: 10_000 }),
        item({ id: 2, exactId: "b", entryNumber: 22, openMinor: 3_000, allocatedMinor: 3_000 }),
      ]),
    );
    expect(p.ok && p.mode === "matched" && p.matchset.items.map((i) => i.amountMinor)).toEqual([
      10_000, 3_000,
    ]);
    expect(p.ok && p.mode === "matched" && p.matchset.bankAmountMinor).toBe(-13_000);
  });

  it("an invoice netted with a credit note is manual in v1 (the signed lines no longer add up to the payment)", () => {
    const p = planMatch(
      cand({ tx: { ...cand().tx, amountMinor: 13_000 } }, [
        item({ id: 1, exactId: "a", entryNumber: 21, openMinor: 10_000, allocatedMinor: 10_000 }),
        item({ id: 2, exactId: "b", entryNumber: 22, openMinor: -3_000, allocatedMinor: 3_000 }),
      ]),
    );
    expect(code(p)).toBe("partial_match_not_supported_v1");
  });

  it.each([
    ["a part payment", cand({}, [item({ openMinor: 12_000 })]), "part_payment_not_supported_v1"],
    [
      "a surplus",
      cand({ tx: { ...cand().tx, amountMinor: 11_000 } }),
      "partial_match_not_supported_v1",
    ],
    [
      "a foreign currency",
      cand({ currency: "USD", baseCurrency: "EUR" }, [item({ currency: "USD" })]),
      "fx_not_supported_v1",
    ],
    [
      "mixed kinds",
      cand({}, [item(), item({ id: 2, exactId: "b", kind: "bill", entryNumber: 22 })]),
      "partial_match_not_supported_v1",
    ],
    [
      "two relations",
      cand({ tx: { ...cand().tx, amountMinor: 20_000 } }, [
        item(),
        item({ id: 2, exactId: "b", relationId: G2, entryNumber: 22 }),
      ]),
      "multiple_relations",
    ],
    ["a closed item", cand({}, [item({ status: "closed", openMinor: 0 })]), "item_not_open"],
    ["no entry number", cand({}, [item({ entryNumber: null })]), "item_entry_number_unknown"],
    ["no relation guid", cand({}, [item({ relationId: null })]), "relation_unknown"],
    ["no relation code", cand({}, [item({ relationCode: null })]), "relation_code_unknown"],
    [
      "no control account",
      cand({ map: { journalCode: "90", receivableGl: null, payableGl: "1600" } }),
      "control_account_unknown",
    ],
    [
      "no items",
      cand({ tx: { ...cand().tx, amountMinor: 10_000 } }, []),
      "partial_match_not_supported_v1",
    ],
    ["a zero amount", cand({ tx: { ...cand().tx, amountMinor: 0 } }), "bad_amount"],
  ])("%s is manual: %s", (_name, c, expected) => {
    expect(code(planMatch(c))).toBe(expected);
  });

  it("a ledger match needs the GL account GUID and has no MatchSet", () => {
    const base = cand(
      {
        source: "ledger",
        ledgerAccountCode: "4500",
        tx: { ...cand().tx, amountMinor: -250 },
        currency: "EUR",
      },
      [],
    );
    expect(code(planMatch(base))).toBe("ledger_account_unknown");
    const p = planMatch({ ...base, ledgerGlId: G2 });
    expect(p.ok && p.mode).toBe("ledger");
    expect(p.ok && p.bankEntry.lines[0]).toMatchObject({ amountMinor: -250, glAccountId: G2 });
  });

  it("masks an IBAN in the bank text before it can be stored", () => {
    const p = planMatch(
      cand({
        tx: { ...cand().tx, reference: "pay NL91 ABNA 0417 1643 00 now", counterpartyName: "Acme" },
      }),
    );
    expect(p.ok && JSON.stringify(p.bankEntry)).not.toMatch(/NL91\s?ABNA/);
  });
});

describe("stored payload documents", () => {
  it("round-trip and refuse a changed hash or an unknown shape", () => {
    const d = serializeDoc({ v: 1, stage: "none", reason: "part_payment_not_supported_v1" });
    expect(parseDoc(d.json, d.hash)).toEqual({
      v: 1,
      stage: "none",
      reason: "part_payment_not_supported_v1",
    });
    expect(parseDoc(d.json, "0".repeat(64))).toBeNull();
    expect(parseDoc(d.json.replace("part", "PART"), d.hash)).toBeNull();
    const odd = serializeDoc({ v: 2 } as never);
    expect(parseDoc(odd.json, odd.hash)).toBeNull();
  });

  it("a MatchSet plan builds only once the bank line is known, and is zero-sum", () => {
    const p = planMatch(cand());
    if (!p.ok || p.mode !== "matched") throw new Error("plan");
    expect(buildMatchsetFromPlan(p.matchset)).toEqual({ ok: false, code: "bank_line_unknown" });
    const built = buildMatchsetFromPlan({ ...p.matchset, bankEntryNumber: 99 });
    expect(built.ok && built.built.xml).toContain(
      "<EntryNumber>99</EntryNumber><Amount>-100.00</Amount>",
    );
  });

  it("failure rows get a stable key per match", () => {
    expect(planFailureKey(7)).toBe(planFailureKey(7));
    expect(planFailureKey(7)).not.toBe(planFailureKey(8));
  });
});

/**
 * Hand-built sign examples (A14), independent of the code's own formula: what each MatchSet must
 * look like in Exact's terms (debtor invoice +, receipt -, creditor bill -, payment +), zero-sum.
 */
describe("MatchSet signs, hand-built (review M7c)", () => {
  const xmlOf = (c: Candidate): string => {
    const p = planMatch(c);
    if (!p.ok || p.mode !== "matched") throw new Error(`not planned: ${code(p)}`);
    const b = buildMatchsetFromPlan({ ...p.matchset, bankEntryNumber: 900 });
    if (!b.ok) throw new Error(b.code);
    return b.built.xml;
  };
  const line = (entry: number, amount: string): string =>
    `<MatchLine><EntryNumber>${entry}</EntryNumber><Amount>${amount}</Amount></MatchLine>`;
  const tx = (amountMinor: number, currency = "EUR") => ({ ...cand().tx, amountMinor, currency });

  it.each([
    [
      "customer invoice 1,000 received",
      cand({ tx: tx(100_000) }, [item({ openMinor: 100_000, allocatedMinor: 100_000 })]),
      "1300",
      [line(21, "1000.00"), line(900, "-1000.00")],
    ],
    [
      "supplier bill 500 paid",
      cand({ tx: tx(-50_000) }, [
        item({ kind: "bill", openMinor: 50_000, allocatedMinor: 50_000 }),
      ]),
      "1600",
      [line(21, "-500.00"), line(900, "500.00")],
    ],
    [
      "customer credit note 200 refunded",
      cand({ tx: tx(-20_000) }, [item({ openMinor: -20_000, allocatedMinor: 20_000 })]),
      "1300",
      [line(21, "-200.00"), line(900, "200.00")],
    ],
    [
      "supplier credit note 70 refunded to us",
      cand({ tx: tx(7_000) }, [item({ kind: "bill", openMinor: -7_000, allocatedMinor: 7_000 })]),
      "1600",
      [line(21, "70.00"), line(900, "-70.00")],
    ],
    [
      "JPY (scale 0)",
      cand({ currency: "JPY", baseCurrency: "JPY", tx: tx(1_234, "JPY") }, [
        item({ currency: "JPY", openMinor: 1_234, allocatedMinor: 1_234 }),
      ]),
      "1300",
      [line(21, "1234"), line(900, "-1234")],
    ],
    [
      "KWD (scale 3)",
      cand({ currency: "KWD", baseCurrency: "KWD", tx: tx(1_234, "KWD") }, [
        item({ currency: "KWD", openMinor: 1_234, allocatedMinor: 1_234 }),
      ]),
      "1300",
      [line(21, "1.234"), line(900, "-1.234")],
    ],
  ])("%s", (_name, c, gl, lines) => {
    const xml = xmlOf(c);
    expect(xml).toContain(`<GLAccount code="${gl}"/>`);
    expect(xml.match(/<MatchLine>/g)).toHaveLength(2);
    for (const l of lines) expect(xml).toContain(l);
  });

  it.each([
    [
      "a receipt against a bill",
      cand({ tx: tx(500) }, [item({ kind: "bill", openMinor: 500, allocatedMinor: 500 })]),
    ],
    [
      "a payment against an invoice",
      cand({ tx: tx(-500) }, [item({ openMinor: 500, allocatedMinor: 500 })]),
    ],
    [
      "an amount above 2^53",
      cand({ tx: tx(2 ** 53 + 2) }, [
        item({ openMinor: 2 ** 53 + 2, allocatedMinor: 2 ** 53 + 2 }),
      ]),
    ],
    [
      "an item amount above 2^53",
      cand({ tx: tx(100) }, [item({ openMinor: 2 ** 60, allocatedMinor: 100 })]),
    ],
    ["a bank line in another currency than the match", cand({ tx: tx(10_000, "USD") })],
    [
      "invoice and credit note netted",
      cand({ tx: tx(800) }, [
        item({ id: 1, exactId: "i1", entryNumber: 21, openMinor: 1_000, allocatedMinor: 1_000 }),
        item({ id: 2, exactId: "i2", entryNumber: 22, openMinor: -200, allocatedMinor: 200 }),
      ]),
    ],
  ])("never booked: %s", (_name, c) => {
    expect(planMatch(c).ok).toBe(false);
  });
});
