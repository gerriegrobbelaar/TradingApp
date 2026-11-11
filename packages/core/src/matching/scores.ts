/**
 * Scoring weights of the matching engine: the single source of truth. ADR 0041 embeds the table
 * rendered by `renderScoreTable()`; a test fails when the two drift apart.
 */

export const MATCH_WEIGHTS = {
  /** Rule 1: the whole invoice number in plain ASCII. */
  refExact: 60,
  /** Rule 1: only after Unicode folding, or only the digit run of a prefixed number. */
  refInexact: 50,
  /** Rule 1: invoice number of an item in another currency. */
  refOtherCurrency: 55,
  amountEquals: 39,
  amountPartial: 28,
  amountOver: 10,
  groupSum: 37,
  /** Bonus for rule 1 when the IBAN also belongs to the relation. */
  ibanWithReference: 1,
  /** Rule 2. */
  iban: 50,
  ibanAmountEquals: 30,
  uniqueForRelation: 16,
  ibanPartial: 10,
  ibanOver: 5,
  /** Rule 3. */
  singleAmount: 70,
  multipleAmount: 50,
  /** Penalty when the transaction IBAN is a known IBAN of another relation. */
  otherRelationIban: -20,
  /** Rule 4. */
  ledger: 90,
  ledgerAuto: 95,
  dueNear: 2,
  nameMax: 5,
} as const;

export const MATCH_CAPS = {
  /** Rule 3 (amount only) can never come near the automatic threshold. */
  amountOnly: 70,
  /** A reference that is not exact can never reach the automatic threshold. */
  inexactReference: 90,
} as const;

const W = MATCH_WEIGHTS;

export interface ScoreRow {
  rule: 1 | 2 | 3 | 4;
  evidence: string;
  kind: string;
  score: string;
}

/** Base scores before bonuses (name, due date, IBAN with a reference) and penalties. */
export function scoreTable(): ScoreRow[] {
  const sum = (...n: number[]): number => n.reduce((a, b) => a + b, 0);
  return [
    {
      rule: 1,
      evidence: "invoice number (exact) in reference + amount = open",
      kind: "full",
      score: `${sum(W.refExact, W.amountEquals)} (${W.refExact} + ${W.amountEquals})`,
    },
    {
      rule: 1,
      evidence: "invoice number (exact), amount < open",
      kind: "partial (remainder stays open)",
      score: `${sum(W.refExact, W.amountPartial)}`,
    },
    {
      rule: 1,
      evidence: "invoice number (exact), amount > open",
      kind: "overpayment (allocate open, surplus flagged)",
      score: `${sum(W.refExact, W.amountOver)}`,
    },
    {
      rule: 1,
      evidence:
        "reference lists 2-5 invoices of one relation whose open balances sum to the amount",
      kind: "full, one candidate with `groupId`",
      score: `${sum(W.refExact, W.groupSum)}`,
    },
    {
      rule: 1,
      evidence: "invoice number not exact (Unicode folding or digit run only)",
      kind: "as above",
      score: `${W.refInexact} + amount weight, capped at ${MATCH_CAPS.inexactReference}, never auto`,
    },
    {
      rule: 1,
      evidence: "invoice number, other currency",
      kind: "partial, allocates 0",
      score: `${W.refOtherCurrency}, never auto`,
    },
    {
      rule: 2,
      evidence: "IBAN of the relation + amount = open of exactly one of its items",
      kind: "full",
      score: `${sum(W.iban, W.ibanAmountEquals, W.uniqueForRelation)}`,
    },
    {
      rule: 2,
      evidence: "same, amount fits several items",
      kind: "full, all listed",
      score: `${sum(W.iban, W.ibanAmountEquals)}`,
    },
    {
      rule: 2,
      evidence: "IBAN matches, amount fits none",
      kind: "partial / overpayment",
      score: `${sum(W.iban, W.ibanPartial)} / ${sum(W.iban, W.ibanOver)}`,
    },
    {
      rule: 3,
      evidence: "amount = open of exactly one item (no other signal)",
      kind: "suggestion",
      score: `${W.singleAmount} (cap ${MATCH_CAPS.amountOnly}), never auto`,
    },
    {
      rule: 3,
      evidence: "amount fits several items",
      kind: "suggestion",
      score: `${W.multipleAmount} each`,
    },
    {
      rule: 4,
      evidence: "ledger pattern",
      kind: "ledger",
      score: `${W.ledger} (${W.ledgerAuto} if \`autoLedgerPatterns\`)`,
    },
  ];
}

export function renderScoreTable(): string {
  const lines = ["| Rule | Evidence | Kind | Score |", "|---|---|---|---|"];
  for (const r of scoreTable())
    lines.push(`| ${r.rule} | ${r.evidence} | ${r.kind} | ${r.score} |`);
  return lines.join("\n");
}
