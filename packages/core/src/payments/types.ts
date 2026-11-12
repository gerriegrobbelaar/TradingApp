/**
 * Payments: states, stable codes and settings (Phase 9, P9a, ADR 0049). Pure: no I/O.
 *
 * Nothing in this package sends money. It decides whether a payment REQUEST may exist, who must
 * approve it, and which state moves are legal. The worker stores the result and a later task (P9b)
 * calls the bank behind the interface in apps/worker/src/payments/submit.ts.
 */

/**
 * Request states, in the order a request can only move forward (the database repeats the table
 * with triggers):
 *
 *  draft              created and pre-checked; the person has seen the confirmation sheet
 *  pending_approval   confirmed; waiting for a second person (four-eyes)
 *  ready              confirmed (and approved when needed); nothing has been sent
 *  submitting         a single writer holds the claim and may be calling the bank right now
 *  submitted          the bank accepted the instruction; its final state is not known yet
 *  outcome_unknown    the call may or may not have reached the bank: NEVER retried automatically
 *  paid / failed      final: the bank says so (and, for paid, the match is booked later in Exact)
 *  rejected           final, nothing was paid: an approver said no, or the bank refused it
 *  cancelled          final: the requester (or an admin) withdrew it before it was sent
 *  expired            final: not confirmed, approved or sent within 24 hours
 */
export const PAYMENT_STATUSES = [
  "draft",
  "pending_approval",
  "ready",
  "submitting",
  "submitted",
  "outcome_unknown",
  "paid",
  "failed",
  "rejected",
  "cancelled",
  "expired",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const isPaymentStatus = (v: unknown): v is PaymentStatus =>
  typeof v === "string" && (PAYMENT_STATUSES as readonly string[]).includes(v);

/** Legal moves. Only forward. A final state has no way out. */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  draft: ["pending_approval", "ready", "cancelled", "expired"],
  pending_approval: ["ready", "rejected", "cancelled", "expired"],
  ready: ["submitting", "cancelled", "expired"],
  submitting: ["submitted", "rejected", "outcome_unknown"],
  submitted: ["paid", "failed"],
  outcome_unknown: ["submitted", "paid", "failed", "rejected"],
  paid: [],
  failed: [],
  rejected: [],
  cancelled: [],
  expired: [],
};

export const PAYMENT_FINAL_STATUSES: readonly PaymentStatus[] = [
  "paid",
  "failed",
  "rejected",
  "cancelled",
  "expired",
];

/** States in which the request still blocks a second request for the same invoice. */
export const PAYMENT_OPEN_STATUSES: readonly PaymentStatus[] = [
  "draft",
  "pending_approval",
  "ready",
  "submitting",
  "submitted",
  "outcome_unknown",
];

/** States before anything was sent: a person may still cancel. */
export const PAYMENT_CANCELLABLE_STATUSES: readonly PaymentStatus[] = [
  "draft",
  "pending_approval",
  "ready",
];

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** A request is approved/confirmed for at most this long (CLAUDE.md 4.4 and the brief). */
export const PAYMENT_VALIDITY_MS = 24 * 3600_000;
/** Step-up window of CLAUDE.md 4.0: a Google sign-in within the last 15 minutes. */
export const PAYMENT_STEP_UP_MS = 15 * 60_000;
/** A stored supplier IBAN older than this is not trusted (ADR 0019: the IBAN read runs every 3 days). */
export const PAYMENT_IBAN_MAX_AGE_MS = 3 * 24 * 3600_000;
/** A source-account balance older than this is "last known", shown with a warning. */
export const PAYMENT_BALANCE_MAX_AGE_MS = 3600_000;
/** Largest amount accepted at all: 2^53 - 1 minor units. Anything beyond is not a safe integer. */
export const PAYMENT_MAX_MINOR = Number.MAX_SAFE_INTEGER;
/** Most invoices in one batch (Revolut bulk limits are lower than this in practice). */
export const PAYMENT_BATCH_MAX_ITEMS = 50;
/** SEPA unstructured remittance information is at most 140 characters. */
export const PAYMENT_REFERENCE_MAX = 140;

/**
 * Block codes: stable strings (used by the API, the web and tests; never reword). A pre-check
 * returns EVERY code that applies, in this order.
 */
export const PAYMENT_BLOCK_CODES = [
  // the payable
  "payable_not_found",
  "not_a_payable",
  "nothing_open",
  "open_item_stale",
  "amount_invalid",
  "amount_not_open_balance",
  "amount_exceeds_open",
  "currency_not_supported",
  "currency_mismatch_source",
  // Exact approval
  "approval_mapping_unverified",
  "invoice_not_approved",
  "approval_unknown",
  // double payment
  "already_in_request",
  "already_in_batch",
  "already_paid",
  "paid_since_last_sync",
  // the supplier and the IBAN
  "supplier_not_found",
  "iban_missing",
  "iban_invalid",
  "iban_mismatch_invoice",
  "iban_cache_stale",
  "iban_unverified",
  "iban_changed",
  // limits
  "over_request_limit",
  "over_daily_limit",
  "no_eur_rate",
  // the source account
  "source_account_unknown",
  "source_account_inactive",
  "insufficient_balance",
  // the text
  "reference_empty",
  // the switch
  "payments_disabled",
] as const;
export type PaymentBlockCode = (typeof PAYMENT_BLOCK_CODES)[number];

export const PAYMENT_WARNING_CODES = [
  "balance_below_amount",
  "balance_unknown",
  "balance_stale",
  "reference_shortened",
] as const;
export type PaymentWarningCode = (typeof PAYMENT_WARNING_CODES)[number];

export type PaymentMode = "drafts" | "pay";
export const isPaymentMode = (v: unknown): v is PaymentMode => v === "drafts" || v === "pay";

/** Why a second person is needed (stable codes). */
export const APPROVAL_REASONS = [
  "above_limit",
  "batch_total_above_limit",
  "batch_item_above_limit",
  "no_eur_rate",
  "new_or_changed_iban",
] as const;
export type ApprovalReason = (typeof APPROVAL_REASONS)[number];

export interface PaymentSettings {
  /** Master four-eyes switch for the amount limit. */
  fourEyesEnabled: boolean;
  /** Requests ABOVE this EUR amount need a second approver. Minor units of EUR. */
  fourEyesLimitMinor: number;
  /** Separate toggle: the first payment to a verified IBAN, or one the requester verified, needs a second approver whatever the amount. */
  requireApprovalForNewIban: boolean;
  /** Hard ceiling per request (EUR equivalent). Above it the pre-check blocks, approval or not. */
  maxRequestMinor: number;
  /** Hard ceiling over all open and paid requests created in the last 24 hours (EUR equivalent). */
  maxDailyMinor: number;
  /** A request must equal the open balance unless this is on. */
  allowPartial: boolean;
  /** Insufficient last-known balance blocks (default: only a warning). */
  blockOnInsufficientBalance: boolean;
  /** Currencies a payment may be in (it must also equal the source account's currency). */
  allowedCurrencies: string[];
  /** Revolut payment mode: drafts approved in the Revolut app, or one-click /pay (Company plan). */
  mode: PaymentMode;
}

/**
 * Defaults for the unanswered decisions 1 and 6 (ADR 0049). Every one is a setting.
 * The two hard ceilings (`maxRequestMinor` 25,000.00 EUR, `maxDailyMinor` 50,000.00 EUR) are NOT
 * from the brief: they are invented, conservative PLACEHOLDERS so a mistyped limit cannot authorise
 * a large payment, awaiting the user's answer (ADR 0049 question 3). Raising them is a loosening.
 */
export const DEFAULT_PAYMENT_SETTINGS: Readonly<PaymentSettings> = {
  fourEyesEnabled: true,
  fourEyesLimitMinor: 250_000,
  requireApprovalForNewIban: true,
  maxRequestMinor: 2_500_000,
  maxDailyMinor: 5_000_000,
  allowPartial: false,
  blockOnInsufficientBalance: false,
  allowedCurrencies: ["EUR"],
  mode: "drafts",
};
