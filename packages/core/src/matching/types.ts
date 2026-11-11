/**
 * Matching engine types (Phase 7, ADR 0040). Pure: no I/O, no clock.
 *
 * Contract notes:
 *  - One call sees the items of ONE Exact division. Items of several divisions must be matched in
 *    separate calls (the same invoice number may exist in two divisions).
 *  - `MatchItem.openMinor` already reflects every earlier live match, so several transactions can
 *    pay one item one after the other. The engine never subtracts earlier matches itself; inside
 *    one `matchBatch` call an item auto-claimed by an earlier transaction is blocked for later ones.
 */

export interface MatchTx {
  id: number;
  connectionId: number;
  accountId: number | null;
  direction: "in" | "out";
  /** Absolute value in minor units. */
  amountMinor: bigint;
  currency: string;
  /** YYYY-MM-DD, Europe/Amsterdam. */
  bookedAt: string;
  reference: string | null;
  description: string | null;
  counterpartyName: string | null;
  /** Full, normalised. Never logged. */
  counterpartyIban: string | null;
  counterpartyRef: string | null;
  type: string | null;
  isFinal: boolean;
  state: string;
  requestId: string | null;
  frozen: boolean;
  stateConflict: boolean;
}

export interface MatchItem {
  id: number;
  kind: "receivable" | "payable";
  invoiceNumber: string | null;
  entryNumber: string | null;
  yourRef: string | null;
  relationId: number | null;
  relationName: string | null;
  /** Active IBANs of the relation. */
  relationIbans: string[];
  relationIbanAddedAt: string | null;
  relationIbanChangedAt: string | null;
  currency: string;
  /** Signed: credit notes are negative. */
  openMinor: bigint;
  dueDate: string | null;
  hasLiveMatch: boolean;
  closed: boolean;
}

export interface LedgerPattern {
  id: string;
  ledgerAccountCode: string;
  description: string;
  test: {
    counterpartyNameRegex?: string;
    referenceRegex?: string;
    type?: string;
    direction?: "in" | "out";
    maxAmountMinor?: bigint;
  };
}

export interface MatchConfig {
  autoMatchMinScore: number;
  /** The next candidate must be at least this far behind the top one. */
  autoMatchMinGap: number;
  suggestMinScore: number;
  maxCandidates: number;
  amountToleranceMinor: bigint;
  /** Payables whose supplier IBAN was added or changed within N days are never auto-matched. */
  blockAutoOnRecentIbanChangeDays: number;
  /** Opt in to auto-matching ledger patterns (their score becomes 95). Default false. */
  autoLedgerPatterns: boolean;
  patterns: LedgerPattern[];
}

export type ReasonCode =
  | "invoice_number_in_reference"
  | "group_sum_equals_amount"
  | "amount_equals_open"
  | "amount_partial"
  | "amount_over"
  | "iban_matches_relation"
  | "unique_for_relation"
  | "single_amount_candidate"
  | "multiple_amount_candidates"
  | "name_similar"
  | "pattern"
  | "due_date_near"
  | "currency_mismatch";

export interface Reason {
  code: ReasonCode;
  weight: number;
  detail?: string;
}

export interface Allocation {
  itemId: number;
  allocatedMinor: bigint;
}

export interface Candidate {
  /** First allocation's item (lowest id for a group); null for a ledger match. */
  itemId: number | null;
  ledgerAccountCode: string | null;
  /** Integer 0-100. */
  score: number;
  rule: 1 | 2 | 3 | 4;
  kind: "full" | "partial" | "overpayment" | "ledger";
  /** Total allocated to items (for a ledger match: the transaction amount). */
  allocatedMinor: bigint;
  /** Open balance left after this match; 0 for full, overpayment and ledger. */
  remainingMinor: bigint;
  reasons: Reason[];
  autoEligible: boolean;
  blockedReasons: string[];
  /** Set when one transaction pays several invoices. */
  groupId?: string;
  allocations: Allocation[];
}

export interface MatchResult {
  txId: number;
  /** Best first, at most maxCandidates, stable order. */
  candidates: Candidate[];
  decision: "auto" | "review" | "none";
  /** Set only when decision is 'auto'. */
  chosen: Candidate | null;
  explanation: string[];
}
