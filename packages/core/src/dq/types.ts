/**
 * Data quality (DQ) rules, pure and I/O free (CLAUDE.md 4.6, ADR 0045). A rule is a definition
 * plus an evaluator over a plain input object that the Worker loads from D1; the evaluator
 * returns issues, each with a STABLE fingerprint (rule id + subject key) so that a rerun
 * recognises the same issue.
 *
 * Honesty rule: a rule that cannot be evaluated (the data is not there, or the rule is not
 * configured) reports `not_available` or `not_configured` with a reason. It NEVER reports `ok`.
 * Money is integer minor units plus a currency code, never a float.
 */

import type { Schedule } from "../schedule";

export type DqSeverity = "info" | "warning" | "critical";
export const DQ_SEVERITIES: readonly DqSeverity[] = ["info", "warning", "critical"];
/** Rank for comparisons: a higher number is more severe. */
export const SEVERITY_RANK: Record<DqSeverity, number> = { info: 0, warning: 1, critical: 2 };

export type DqArea =
  "bank" | "payables" | "receivables" | "master_data" | "fx" | "ledger" | "integrations";
export const DQ_AREAS: readonly DqArea[] = [
  "bank",
  "payables",
  "receivables",
  "master_data",
  "fx",
  "ledger",
  "integrations",
];

/**
 * What a rule run says about the rule itself:
 *  ok             evaluated, nothing to report
 *  issues         evaluated, at least one issue
 *  not_available  the data the rule needs does not exist (yet): never counted as ok
 *  not_configured the rule needs a setting that is empty (for example suspense account codes)
 *  disabled       an admin switched the rule off
 *  error          the evaluator failed; nothing is known
 */
export type DqRuleStatus =
  "ok" | "issues" | "not_available" | "not_configured" | "disabled" | "error";

/** Where "Fix" leads. A key, not a URL: DQ_FIX_PATHS maps it to a route of the web app. */
export type DqFixTarget =
  | "bank"
  | "matching"
  | "booking"
  | "payables"
  | "approvals"
  | "invoices"
  | "fx"
  | "ledger"
  | "schedules"
  | "connections"
  | "payments"
  | "payment_approvals";

export const DQ_FIX_PATHS: Record<DqFixTarget, string> = {
  bank: "/treasury/bank",
  matching: "/treasury/bank",
  booking: "/settings/matching",
  payables: "/purchases/payables",
  approvals: "/purchases/approvals",
  invoices: "/invoices",
  fx: "/settings/fx",
  ledger: "/reporting/balance-sheet",
  schedules: "/settings/schedules",
  connections: "/settings/connections",
  // The Payments views of Phase 9 (P9c): Treasury > Bank, tab Payments; Approvals, tab Payments.
  payments: "/treasury/bank?tab=payments",
  payment_approvals: "/purchases/approvals?tab=payments",
};

/** How a rule's threshold is shaped (and edited). */
export type DqThresholdSpec =
  | {
      kind: "number";
      /** Shown next to the number. */
      unit: "days" | "minor" | "count" | "factor" | "calls";
      /**
       * Which way the number LOOSENS the rule (reports less). "up" for an age limit, a tolerance or
       * a count; "down" for a look-back window ("changed in the last N days"), a warning lead time
       * ("expires within N days") or a remaining-calls floor. Default: "down" for `calls`, else "up".
       */
      looser?: "up" | "down";
      default: number;
      min: number;
      max: number;
    }
  | { kind: "codes"; default: readonly string[]; maxItems: number };

export type DqThreshold = number | readonly string[] | null;

/** Small, non-secret facts about an issue. Never an IBAN, an e-mail body or free bank text. */
export type DqDetails = Record<string, string | number | boolean | null>;

export interface DqIssue {
  ruleId: string;
  /** `${ruleId}:${subjectKey}`; the identity of the issue across runs. */
  fingerprint: string;
  severity: DqSeverity;
  /** Short human label of what is affected. Masked: never a full IBAN. */
  subject: string;
  /** Sentence case, leads with the number, no exclamation mark. */
  message: string;
  fix: DqFixTarget;
  amountMinor: number | null;
  currency: string | null;
  details: DqDetails;
}

export interface DqRuleOutcome {
  status: Exclude<DqRuleStatus, "disabled" | "error">;
  /** Machine code for not_available / not_configured. */
  reason?: string;
  issues: DqIssue[];
  /** How many subjects were examined (0 with status ok means nothing to check). */
  checked: number;
  /** More issues existed than were returned (the cap). Auto-resolve must not trust the list. */
  truncated: boolean;
  /** How many issues were found before the cap. */
  total: number;
  /**
   * Fingerprints of subjects the rule could NOT judge in this run (a stale balance, a date it
   * could not read, a flag the sync did not see). Their stored issues are left alone: not seeing
   * a problem is not the same as seeing that it is gone.
   */
  unjudged?: string[];
}

export interface DqRuleConfig {
  enabled: boolean;
  severity: DqSeverity;
  threshold: DqThreshold;
}

export interface DqRuleDef {
  id: string;
  area: DqArea;
  /** `division` rules run once per synced division, `global` rules once per run. */
  scope: "division" | "global";
  defaultSeverity: DqSeverity;
  threshold: DqThresholdSpec | null;
  title: string;
  description: string;
  fix: DqFixTarget;
  evaluate(input: DqInput, config: DqRuleConfig): DqRuleOutcome;
}

export interface DqRuleResult {
  ruleId: string;
  area: DqArea;
  scope: "division" | "global";
  severity: DqSeverity;
  status: DqRuleStatus;
  reason: string | null;
  issues: DqIssue[];
  checked: number;
  truncated: boolean;
  total: number;
  /** See DqRuleOutcome.unjudged: never auto-resolved by this run. */
  unjudged?: string[];
}

// ---- inputs ------------------------------------------------------------------------------------------

export interface DqBankAccountIn {
  id: number;
  name: string;
  currency: string;
  /** The bank's own balance (Revolut), minor units. */
  balanceMinor: number | null;
  balanceAt: string | null;
  /** The balance of the mapped bank ledger account in Exact (job exact.bank_balances). */
  exactBalanceMinor: number | null;
  exactBalanceAt: string | null;
}

export interface DqBankTxIn {
  id: number;
  accountId: number;
  /** Signed minor units (negative = money out). */
  amountMinor: number;
  currency: string;
  bookedAt: string;
  matchStatus: "unmatched" | "suggested" | "matched" | "ignored";
  counterpartyName: string | null;
  /** Used only to group duplicates; never copied into an issue. */
  counterpartyKey: string | null;
  reference: string | null;
}

export interface DqBookedMatchIn {
  matchId: number;
  txId: number;
  amountMinor: number;
  currency: string;
  lineState: string;
  stateConflict: boolean;
  bookedAt: string | null;
}

export interface DqBookingIn {
  outcomeUnknown: number;
  manualRequired: number;
  alreadyMatchedInExact: number;
  staleSettlements: number;
}

export interface DqOpenItemIn {
  id: number;
  kind: "invoice" | "bill";
  relationId: string | null;
  relationName: string | null;
  invoiceNumber: string | null;
  currency: string;
  /** The invoice amount as booked (`open_items.original_minor`); null when the sync did not read it. */
  originalMinor: number | null;
  openMinor: number;
  /** Booked FX rate as a decimal string, or null. */
  rate: string | null;
  openDcMinor: number | null;
  invoiceDate: string | null;
}

export interface DqPurchaseEntryIn {
  id: number;
  entryNumber: string | null;
  supplierName: string | null;
  status: "pending_approval" | "approved" | "rejected" | "unknown";
  submittedAt: string | null;
  modifiedAt: string | null;
  entryDate: string | null;
  /** null = the sync did not see a document field for this entry. */
  hasPdf: boolean | null;
  amountMinor: number;
  currency: string;
}

export interface DqRelationIn {
  id: number;
  name: string;
  isSupplier: boolean;
  isCustomer: boolean;
  email: string | null;
  vatNumber: string | null;
  /** ISO 3166 alpha-2 as Exact sends it. */
  country: string | null;
  hasIban: boolean;
  ibanChangedAt: string | null;
  ibanAddedAt: string | null;
  openInvoices: number;
  openBills: number;
}

export interface DqFxIn {
  newestRateDate: string | null;
  stale: boolean;
  staleReason: string | null;
  workingDaysOld: number | null;
  currenciesWithoutRate: { currency: string; items: number }[];
  unresolvedConflicts: { id: number; currency: string; rateDate: string }[];
}

export interface DqLedgerIn {
  /** Balances (debit - credit, division currency) of the configured suspense accounts that exist. */
  suspense: { code: string; name: string; balanceMinor: number; currency: string }[];
  /**
   * Bookings dated in a locked period, or null when the app has no closed-period marker (it has
   * none today: Phase 11, the Close checklist, adds one).
   */
  closedPeriodBookings: { id: number; period: string; amountMinor: number }[] | null;
}

export interface DqJobIn {
  name: string;
  title: string;
  enabled: boolean;
  implemented: boolean;
  /**
   * The schedule (cron in Europe/Amsterdam, working days only, last working day). When present the
   * staleness rule counts the scheduled slots that passed since the last success (weekends, TARGET
   * holidays and monthly schedules are then judged correctly); `intervalMs` is the fallback.
   */
  schedule?: Schedule | null;
  /** Length of one schedule interval in ms (null when the schedule has no next run). */
  intervalMs: number | null;
  lastSuccessAt: string | null;
  /** Where waiting starts when there was no success: the first run, else the enable baseline. */
  referenceAt: string | null;
  lastStatus: string | null;
  lastCode: string | null;
}

/**
 * Why a section of the input is missing although its loader worked (review V1 S5): the source data
 * has never been synchronised, or its last complete synchronisation is too old to vouch for "ok".
 * The rules that need the section then say `not_available` with this reason, never `ok`.
 */
export const DQ_SOURCE_REASONS = ["source_never_synced", "source_stale"] as const;
export type DqSourceReason = (typeof DQ_SOURCE_REASONS)[number];
export type DqSection =
  "bankAccounts" | "bankTransactions" | "openItems" | "purchaseEntries" | "relations" | "ledger";

/** Job result codes of a deliberate skip: a job that ends this way is not judged by job_stale. */
export const DQ_DELIBERATE_SKIP_CODES: readonly string[] = [
  "email_not_configured",
  "notifications_disabled",
  "no_recipients",
];

// ---- payments (Phase 9 final review S1, ADR 0053) ----------------------------------------------------

/** A payment or a batch (a batch is one subject; its items are not listed on their own). */
export type DqPaymentSubjectKind = "payment" | "batch";

export interface DqPaymentSubjectIn {
  kind: DqPaymentSubjectKind;
  id: number;
  amountMinor: number;
  currency: string;
  /** When the request entered the state the rule is about (ISO); null = unreadable. */
  since: string | null;
  /** The request's own 24 h validity (ISO), or null. */
  expiresAt: string | null;
}

export interface DqPaymentAlertIn {
  kind: DqPaymentSubjectKind;
  id: number;
  /**
   * What the alert is: `alert_kind` (migration 0030) or, before it, the reconcile result that raised
   * it (approved_after_expiry, mismatch, ...). A kind without a label is still an alert.
   */
  result: string;
  alertAt: string | null;
  amountMinor: number | null;
  currency: string | null;
}

export interface DqPaymentUnbookedIn {
  id: number;
  amountMinor: number;
  currency: string;
  /** When the bank said paid (ISO); null = unreadable. */
  paidAt: string | null;
  /**
   * How far the Exact side is (the stages of `paymentSettlement`): no bank line yet, no match yet,
   * the line matched to another invoice, or our match not yet in Exact.
   */
  stage: "awaiting_bank_line" | "awaiting_match" | "match_other_invoice" | "awaiting_booking";
}

export type DqPaymentsList =
  "outcomeUnknown" | "alerts" | "paidNotBooked" | "ready" | "draftsWaiting";

export interface DqPaymentsIn {
  /** Top-level requests with status outcome_unknown (payments not in a batch, and batches). */
  outcomeUnknown: DqPaymentSubjectIn[];
  alerts: DqPaymentAlertIn[];
  /** Paid at the bank, the Exact side not booked (the rule applies its own number of days). */
  paidNotBooked: DqPaymentUnbookedIn[];
  /** Status ready; `since` = when it became ready. */
  ready: DqPaymentSubjectIn[];
  /** Submitted drafts waiting for the Revolut app approval; `since` = when submitted. */
  draftsWaiting: DqPaymentSubjectIn[];
  /** Days after which an unapproved draft becomes failed (setting payments.draft_expiry_days). */
  draftExpiryDays: number;
  switchOn: boolean;
  /** Requests in flight (pending_approval, ready, submitting, submitted, outcome_unknown). */
  inFlight: number;
  /** A list had more rows than the loader reads: its rule reports what it saw but resolves nothing. */
  capped: Partial<Record<DqPaymentsList, boolean>>;
}

export interface DqInput {
  nowMs: number;
  /** Per section: why it is null although it could be read (source never synced or stale). */
  sourceReasons?: Partial<Record<DqSection, DqSourceReason>>;
  /**
   * True when the loader had to cut the list of recent bank lines (the duplicate look-back
   * window): the duplicate rule then reports what it found but resolves nothing.
   */
  bankTransactionsCapped?: boolean;
  /** 0 for the global pass. */
  divisionId: number;
  baseCurrency: string;
  bankAccounts: DqBankAccountIn[] | null;
  bankTransactions: DqBankTxIn[] | null;
  bookedMatches: DqBookedMatchIn[] | null;
  booking: DqBookingIn | null;
  openItems: DqOpenItemIn[] | null;
  purchaseEntries: DqPurchaseEntryIn[] | null;
  relations: DqRelationIn[] | null;
  fx: DqFxIn | null;
  ledger: DqLedgerIn | null;
  jobs: DqJobIn[] | null;
  webhook: { rejected24h: number; errored24h: number } | null;
  exactConnection: {
    status: string;
    lastError: string | null;
    refreshExpiresAt: string | null;
  } | null;
  /** Exact calls today for this division; null when unknown. */
  exactBudget: { dailyLimit: number; calls: number; remaining: number | null } | null;
  /** Payment requests (D1 only; read in the global pass); null when the loader failed. */
  payments: DqPaymentsIn | null;
}

/** An input with nothing loaded: every rule reports not_available. Handy for tests. */
export function emptyInput(nowMs: number, divisionId = 0, baseCurrency = "EUR"): DqInput {
  return {
    nowMs,
    divisionId,
    baseCurrency,
    bankAccounts: null,
    bankTransactions: null,
    bookedMatches: null,
    booking: null,
    openItems: null,
    purchaseEntries: null,
    relations: null,
    fx: null,
    ledger: null,
    jobs: null,
    webhook: null,
    exactConnection: null,
    exactBudget: null,
    payments: null,
  };
}
