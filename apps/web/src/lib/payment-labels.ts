/**
 * Every payment word a person reads, in ONE place (P9c, ADR 0051): why a payment is blocked and
 * what to do, why a second person is needed, what a status means, what a server refusal means.
 * Sentence case, calm, no raw codes, no exclamation marks. Tests fail when core adds a block,
 * warning or approval code without a sentence here. An unknown code gets one fixed generic
 * sentence, never the server's text and never a blank.
 */
import {
  PAYMENT_SETTLEMENTS,
  type PaymentMode,
  type PaymentSettlement,
  type PaymentStatus,
} from "@camelthorn/core";
import type { ChipTone } from "@camelthorn/ui";
import { ApiError } from "../api";

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// ---- block codes: what is wrong, and what to do ------------------------------------------------

export interface BlockText {
  /** What is wrong. */
  what: string;
  /** What a person can do about it. */
  todo: string;
}

export const BLOCK_TEXT: Record<string, BlockText> = {
  payable_not_found: {
    what: "This bill is no longer in the list we read from Exact.",
    todo: "Reload the page. If it is still missing, check it in Exact.",
  },
  not_a_payable: {
    what: "This item is not a supplier bill.",
    todo: "Only supplier bills can be paid from here.",
  },
  nothing_open: {
    what: "Nothing is open on this bill.",
    todo: "It may already be paid. Check the bill in Exact.",
  },
  open_item_stale: {
    what: "The open balance was last read from Exact too long ago to trust.",
    todo: "Wait for the next read of Exact, or ask an administrator to run it, then try again.",
  },
  amount_invalid: {
    what: "The amount is not a valid payment amount.",
    todo: "Close this sheet and open it again from the bill.",
  },
  amount_not_open_balance: {
    what: "The amount is not the full open balance, and part payments are switched off.",
    todo: "Pay the full open balance, or ask an administrator about part payments.",
  },
  amount_exceeds_open: {
    what: "The amount is more than what is open on the bill.",
    todo: "Close this sheet and open it again from the bill.",
  },
  currency_not_supported: {
    what: "Payments in this currency are not allowed.",
    todo: "An administrator can allow the currency in Settings, Payments.",
  },
  currency_mismatch_source: {
    what: "The bill and the source account are in different currencies.",
    todo: "Choose a source account in the currency of the bill.",
  },
  approval_mapping_unverified: {
    what: "The approval status from Exact has not been verified, so we cannot tell if this bill is approved.",
    todo: "An administrator verifies the mapping on the Approvals page.",
  },
  invoice_not_approved: {
    what: "This bill is not approved in Exact.",
    todo: "Get it approved in Exact first. It can be paid after the next read.",
  },
  approval_unknown: {
    what: "We cannot confirm from Exact that this bill is approved.",
    todo: "Wait for the next read of Exact. If it stays, check the bill in Exact.",
  },
  already_in_request: {
    what: "Another payment request for this bill is already open.",
    todo: "Open Treasury, Bank, Payments to follow it, or cancel it there first.",
  },
  already_in_batch: {
    what: "This bill is already part of an open payment batch.",
    todo: "Open Treasury, Bank, Payments to follow the batch, or cancel it there first.",
  },
  already_paid: {
    what: "A payment for this bill was already confirmed by the bank.",
    todo: "Do not pay again. Check that the payment is booked against the bill in Exact.",
  },
  paid_since_last_sync: {
    what: "A payment for this bill was made after we last read it from Exact.",
    todo: "Wait for the next read of Exact before deciding whether anything is left to pay.",
  },
  supplier_not_found: {
    what: "The supplier of this bill is not in the data we read from Exact.",
    todo: "Check the supplier in Exact, then wait for the next read.",
  },
  iban_missing: {
    what: "The supplier has no bank account in Exact.",
    todo: "Add the bank account to the supplier in Exact.",
  },
  iban_invalid: {
    what: "The supplier's bank account number in Exact is not valid.",
    todo: "Correct the bank account in Exact.",
  },
  iban_mismatch_invoice: {
    what: "The bank account on the bill is not the one on the supplier record.",
    todo: "Check with the supplier which account is right, and correct Exact.",
  },
  iban_cache_stale: {
    what: "The supplier's bank account was last read from Exact too long ago to trust.",
    todo: "Wait for the next read of Exact, then try again.",
  },
  iban_unverified: {
    what: "The supplier's bank account has not been confirmed by an approver.",
    todo: "Ask an approver to confirm the bank account on the Payables page, then try again.",
  },
  iban_changed: {
    what: "The supplier's bank account changed since an approver last confirmed it.",
    todo: "Check the change with the supplier by phone. Then ask an approver to confirm the new account.",
  },
  over_request_limit: {
    what: "The amount is above the largest single payment allowed.",
    todo: "An administrator can review the ceiling in Settings, Payments.",
  },
  over_daily_limit: {
    what: "Together with other payments of the last 24 hours this is above the daily ceiling.",
    todo: "Try again tomorrow, or ask an administrator to review the ceiling.",
  },
  no_eur_rate: {
    what: "There is no recent euro exchange rate for this currency, so the limits cannot be checked.",
    todo: "Wait for the next ECB rate import, then try again.",
  },
  source_account_unknown: {
    what: "The source account does not exist.",
    todo: "Choose another source account.",
  },
  source_account_inactive: {
    what: "The source account is not active.",
    todo: "Choose another source account.",
  },
  insufficient_balance: {
    what: "The source account holds less than this payment needs.",
    todo: "Choose another source account, or move money to this one first.",
  },
  reference_empty: {
    what: "The bill number leaves no usable text for the payment reference.",
    todo: "Check the bill number in Exact.",
  },
  payments_disabled: {
    what: "Payments are switched off, so nothing can be paid from this app yet.",
    todo: "An administrator switches payments on in Settings, Payments, once the checks are done.",
  },
};

/** Codes that refuse a whole batch (core BATCH_BLOCK_CODES). */
export const BATCH_BLOCK_TEXT: Record<string, BlockText> = {
  batch_empty: {
    what: "No bills were chosen.",
    todo: "Choose at least one bill.",
  },
  batch_too_large: {
    what: "There are more bills in this batch than one batch can hold.",
    todo: "Split the bills over more than one batch.",
  },
  batch_duplicate_invoice: {
    what: "The same bill is in the batch more than once.",
    todo: "Close this sheet and choose the bills again.",
  },
  batch_mixed_currency: {
    what: "The bills are in different currencies.",
    todo: "Pay each currency in its own batch.",
  },
  batch_mixed_source_account: {
    what: "The bills would be paid from different accounts.",
    todo: "Use one source account for one batch.",
  },
  batch_mixed_division: {
    what: "The bills belong to different administrations.",
    todo: "Pay each administration in its own batch.",
  },
  batch_item_blocked: {
    what: "At least one bill in the batch cannot be paid yet.",
    todo: "See the bills below, fix them or take them out of the batch.",
  },
  batch_total_unsafe: {
    what: "The total of the batch is too large to be handled safely.",
    todo: "Split the bills over more than one batch.",
  },
  batch_over_request_limit: {
    what: "The total is above the largest single payment allowed.",
    todo: "Split the bills over more than one batch, or ask an administrator to review the ceiling.",
  },
  batch_over_daily_limit: {
    what: "Together with other payments of the last 24 hours the total is above the daily ceiling.",
    todo: "Try again tomorrow, or ask an administrator to review the ceiling.",
  },
  batch_no_eur_rate: {
    what: "There is no recent euro exchange rate for this currency, so the limits cannot be checked.",
    todo: "Wait for the next ECB rate import, then try again.",
  },
};

export const BLOCK_FALLBACK: BlockText = {
  what: "This payment cannot be requested right now.",
  todo: "Reload the page and try again. If it stays, ask an administrator.",
};

export function blockText(code: string): BlockText {
  if (own(BLOCK_TEXT, code)) return BLOCK_TEXT[code] as BlockText;
  if (own(BATCH_BLOCK_TEXT, code)) return BATCH_BLOCK_TEXT[code] as BlockText;
  return BLOCK_FALLBACK;
}

export const WARNING_TEXT: Record<string, string> = {
  balance_below_amount: "The last known balance of the source account is below this amount.",
  balance_unknown: "The balance of the source account is not known.",
  balance_stale: "The balance of the source account was read some time ago.",
  reference_shortened: "The payment reference was shortened to fit the bank's limit.",
};
export const WARNING_FALLBACK = "Check this payment with extra care.";
export function warningText(code: string): string {
  return own(WARNING_TEXT, code) ? (WARNING_TEXT[code] as string) : WARNING_FALLBACK;
}

// ---- why a second person is needed -------------------------------------------------------------

export const APPROVAL_REASON_TEXT: Record<string, string> = {
  above_limit: "The amount is above the four-eyes limit.",
  batch_total_above_limit: "The total of the batch is above the four-eyes limit.",
  batch_item_above_limit: "One bill in the batch is above the four-eyes limit.",
  no_eur_rate: "There is no euro rate to compare the amount with the limit.",
  new_or_changed_iban:
    "These bank details are new, or changed, or have not been paid to before. This always needs a second person.",
};
export const APPROVAL_REASON_FALLBACK = "A second person must approve this.";
export function approvalReasonText(code: string): string {
  return own(APPROVAL_REASON_TEXT, code)
    ? (APPROVAL_REASON_TEXT[code] as string)
    : APPROVAL_REASON_FALLBACK;
}

// ---- statuses (CLAUDE.md 4.3: Open, Paying / Waiting for approval, Paid / Failed) --------------

export interface StatusText {
  label: string;
  tone: ChipTone;
  /** One sentence of what it means. */
  meaning: string;
}

export const STATUS_TEXT: Record<PaymentStatus, StatusText> = {
  draft: {
    label: "Open",
    tone: "neutral",
    meaning: "Prepared but not confirmed yet. Nothing has been sent.",
  },
  pending_approval: {
    label: "Waiting for approval",
    tone: "gold",
    meaning: "A second person must approve this before it can be sent. Nothing has been sent.",
  },
  ready: {
    label: "Approved, not sent yet",
    tone: "gold",
    meaning:
      "All approvals are in, but nothing has been sent to the bank. Someone in finance must use Send to bank.",
  },
  submitting: {
    label: "Paying",
    tone: "gold",
    meaning: "Being sent to the bank now.",
  },
  submitted: {
    label: "Paying",
    tone: "gold",
    meaning: "The bank has the instruction. We are waiting for the bank to confirm the payment.",
  },
  outcome_unknown: {
    label: "Not confirmed",
    tone: "warn",
    meaning: "We could not confirm whether the bank received this payment.",
  },
  // `paid` is the bank's word only. "Paid" in full also needs the booking in Exact (CLAUDE.md 4.3):
  // displayStatus() says "Paid" for a settlement of `booked` and for nothing else.
  paid: {
    label: "Paid at the bank, booking pending",
    tone: "gold",
    meaning: "The bank confirmed the payment. It is not booked in Exact yet.",
  },
  failed: {
    label: "Failed",
    tone: "warn",
    meaning: "The payment was not made.",
  },
  rejected: {
    label: "Rejected",
    tone: "warn",
    meaning: "It was turned down, so nothing was paid.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "neutral",
    meaning: "It was withdrawn before it was sent. Nothing was paid.",
  },
  expired: {
    label: "Expired",
    tone: "neutral",
    meaning: "It was not finished within 24 hours, so it lapsed. Nothing was paid.",
  },
};

export function statusText(s: string): StatusText {
  return own(STATUS_TEXT, s)
    ? STATUS_TEXT[s as PaymentStatus]
    : { label: "Unknown", tone: "neutral", meaning: "This status is not known to this version." };
}

// ---- how far a bank-paid payment is booked (the ONE place "Paid" is decided) -----------------------

/** The wire value of the bank-paid status: named here and nowhere else in the screens (scan-tested). */
export const PAID_STATUS: PaymentStatus = "paid";

/** What each settlement code means for a payment the bank has paid. */
export interface SettlementText {
  label: string;
  tone: ChipTone;
  /** The step it waits at, in words. */
  step: string;
}

export const SETTLEMENT_TEXT: Record<PaymentSettlement, SettlementText> = {
  not_paid: {
    label: "Paid at the bank, booking pending",
    tone: "gold",
    step: "The bank confirmed the payment, but we cannot yet say how far the booking in Exact is.",
  },
  awaiting_bank_line: {
    label: "Paid at the bank, booking pending",
    tone: "gold",
    step: "Waiting for the bank line of this payment to arrive from Revolut.",
  },
  awaiting_match: {
    label: "Paid at the bank, booking pending",
    tone: "gold",
    step: "The bank line has arrived. Waiting for it to be matched to this bill.",
  },
  match_other_invoice: {
    label: "Paid at the bank, matched elsewhere",
    tone: "warn",
    step: "The bank line was matched to another bill. Check the match in Treasury, Bank before anything else is paid.",
  },
  awaiting_booking: {
    label: "Paid at the bank, booking pending",
    tone: "gold",
    step: "The match is made but not yet booked in Exact. It stays here while booking in Exact is switched off.",
  },
  booked: {
    label: "Paid",
    tone: "ok",
    step: "The bank confirmed it and the match is booked in Exact.",
  },
};

/** One fixed sentence for a settlement code this version does not know. Never "Paid". */
export const SETTLEMENT_FALLBACK: SettlementText = {
  label: "Paid at the bank, booking pending",
  tone: "gold",
  step: "The bank confirmed the payment. We cannot tell yet whether it is booked in Exact.",
};

export function settlementText(code: string | null | undefined): SettlementText {
  return typeof code === "string" && own(SETTLEMENT_TEXT, code)
    ? SETTLEMENT_TEXT[code as PaymentSettlement]
    : SETTLEMENT_FALLBACK;
}

/** True only when the bank confirmed AND the match is booked in Exact. */
export const isBooked = (status: string, settlement: string | null | undefined): boolean =>
  status === PAID_STATUS && settlement === "booked";

/**
 * A batch is as far as its least advanced item. No items, or one this version cannot read: the
 * fixed "cannot tell" answer, never booked.
 */
export function batchSettlement(items: readonly { settlement?: string | undefined }[]): string {
  if (items.length === 0) return "unreadable";
  let least: number = PAYMENT_SETTLEMENTS.length;
  for (const i of items) {
    const at = (PAYMENT_SETTLEMENTS as readonly string[]).indexOf(i.settlement ?? "");
    if (at < 0) return "unreadable";
    least = at < least ? at : least;
  }
  return PAYMENT_SETTLEMENTS[least] ?? "unreadable";
}

/** What the chip, the detail sheet and the toasts say about a request. Takes the whole picture. */
export interface StatusSubject {
  status: string;
  mode?: PaymentMode | string | undefined;
  /** A payment's own settlement, or a batch's (batchSettlement of its items). */
  settlement?: string | null | undefined;
}

export function displayStatus(s: StatusSubject): StatusText & { step: string | null } {
  if (s.status === PAID_STATUS) {
    const t = settlementText(s.settlement);
    return {
      label: t.label,
      tone: t.tone,
      meaning: isBooked(s.status, s.settlement)
        ? "The bank confirmed the payment and it is booked in Exact."
        : "The bank confirmed the payment. It is not booked in Exact yet.",
      step: t.step,
    };
  }
  if (s.status === "submitted" && s.mode === "drafts") {
    return {
      label: "Waiting for approval in Revolut",
      tone: "gold",
      meaning:
        "A draft is waiting in the Revolut app. Open the Revolut app and approve it there. Nothing is paid until you do.",
      step: null,
    };
  }
  return { ...statusText(s.status), step: null };
}

/** The status subject of a payment or a batch DTO (a batch takes the least advanced item). */
export function subjectOf(
  dto:
    | { kind: "payment"; status: string; mode: string; settlement?: string | undefined }
    | {
        kind: "batch";
        status: string;
        mode: string;
        items: readonly { settlement?: string | undefined }[];
      },
): StatusSubject {
  return {
    status: dto.status,
    mode: dto.mode,
    settlement: dto.kind === "payment" ? dto.settlement : batchSettlement(dto.items),
  };
}

/** Said whenever a request is in `outcome_unknown` (ADR 0049: never retried automatically). */
export const OUTCOME_UNKNOWN_TEXT =
  "We could not confirm whether the bank received this payment. Do not pay again. An administrator can check it.";

/** Drafts mode: the bank side waits for a person in the Revolut app. */
export const DRAFTS_MODE_TEXT =
  "In drafts mode the payment waits as a draft in the Revolut app until someone approves it there.";

/** Cancelling is final (there is no undo): said next to every cancel button. */
export const CANCEL_FINAL_TEXT =
  "Cancelling is final and cannot be undone. To pay the bill later, request a new payment.";

/** Why a request ended, per stable code of `statusReason` (a bank code may follow a colon). */
export const REASON_TEXT: Record<string, string> = {
  approver_rejected: "An approver turned it down.",
  expired: "It was not finished within 24 hours.",
  cancelled: "It was cancelled.",
  outcome_unknown: "The answer from the bank did not arrive or could not be read.",
  lease_lost: "The answer from the bank did not arrive or could not be read.",
  lease_expired: "The answer from the bank did not arrive or could not be read.",
  finish_failed: "The answer from the bank did not arrive or could not be read.",
  bank_failed: "The bank reported that the payment failed.",
  failed: "The bank reported that the payment failed.",
  bank_declined: "The bank declined the payment. Nothing was paid.",
  bank_reverted:
    "The bank reversed the payment. Check Revolut before you pay this bill again, because the money may have come back.",
  draft_expired:
    "The draft was not approved in time. If it is still in the Revolut app, delete it there before asking for a new payment.",
  resolved_not_sent:
    "An administrator confirmed that this was never sent to the bank. Nothing was paid.",
};

/** The bank-side words after `provider_rejected:`. A prefix rule covers the rest. */
export const PROVIDER_REJECT_TEXT: Record<string, string> = {
  prior_attempt_live:
    "An earlier attempt for this bill is still alive at Revolut, so this one was not sent. Check Revolut, and do not pay again.",
  prior_attempt_unchecked:
    "We could not check Revolut for an earlier attempt for this bill, so this one was not sent. Try again later.",
  counterparty_account_ambiguous:
    "The supplier has more than one account at Revolut and we could not tell which one was confirmed, so nothing was sent.",
  counterparty_iban_unconfirmed:
    "Revolut did not show the bank account an approver confirmed for this supplier, so nothing was sent.",
  payload_mismatch: "The request no longer matched what was approved, so nothing was sent.",
  mode_not_allowed:
    "One-click pay is not available on this Revolut connection, so nothing was sent.",
  batch_pay_unsupported: "A batch can only be sent as drafts, so nothing was sent.",
  iban_binding_broken:
    "The stored bank account no longer matches the one an approver confirmed, so nothing was sent.",
  payments_disabled: "Sending is not available right now, so nothing was sent.",
  no_lease: "Sending is not available right now, so nothing was sent.",
};
export const PROVIDER_REJECT_FALLBACK = "The bank refused the payment.";
export const PROVIDER_COUNTERPARTY_TEXT =
  "The supplier could not be set up at Revolut, so nothing was sent.";

export function providerRejectText(sub: string): string {
  if (own(PROVIDER_REJECT_TEXT, sub)) return PROVIDER_REJECT_TEXT[sub] as string;
  if (sub.startsWith("counterparty_")) return PROVIDER_COUNTERPARTY_TEXT;
  return PROVIDER_REJECT_FALLBACK;
}

/** Why a request ended, from `statusReason`; an unknown code gets one fixed generic sentence. */
export function reasonText(reason: string | null): string | null {
  if (reason === null || reason === "") return null;
  const parts = reason.split(":");
  const head = parts[0] ?? "";
  if (head === "provider_rejected") return providerRejectText(parts[1] ?? "");
  return own(REASON_TEXT, head) ? (REASON_TEXT[head] as string) : "No further reason was recorded.";
}

/** Timeline words for payment_events.code. */
export function eventText(code: string | null, to: string): string {
  const head = (code ?? "").split(":")[0];
  switch (head) {
    case "created":
      return "Prepared";
    case "confirmed":
      return "Confirmed";
    case "confirmed_needs_approval":
      return "Confirmed, waiting for a second person";
    case "approved":
      return "Approved";
    case "approver_rejected":
      return "Turned down by an approver";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
    case "claimed":
      return "Sending to the bank";
    case "accepted":
      return "The bank accepted the instruction";
    case "provider_rejected":
      return "The bank refused the payment";
    case "outcome_unknown":
    case "lease_lost":
    case "lease_expired":
    case "finish_failed":
      return "Could not confirm whether the bank received it";
    case "reconciled_pending":
      return "Found at the bank, waiting for it to finish";
    case "bank_completed":
      return "The bank confirmed the payment";
    case "bank_failed":
    case "bank_declined":
      return "The bank did not make the payment";
    case "bank_reverted":
      return "The bank reversed the payment";
    case "draft_expired":
      return "The draft expired without approval";
    case "resolved_not_sent":
      return "An administrator confirmed it was not sent";
    default:
      return `Status changed to ${to === PAID_STATUS ? "paid at the bank" : statusText(to).label.toLowerCase()}`;
  }
}

// ---- server refusals --------------------------------------------------------------------------

export const ERROR_TEXT: Record<string, string> = {
  payments_disabled: "Payments are switched off, so nothing was changed.",
  blocked: "The server refused this. Reload the page and look again.",
  conflict: "Somebody else changed this at the same moment. Reload the page and look again.",
  not_found: "That payment no longer exists. Reload the page.",
  confirmation_required: "The confirmation text does not match. Type it exactly as shown.",
  payload_changed:
    "The payment changed after you opened it. Nothing was approved. Close it and look at it again.",
  payload_hash_required: "The payment could not be identified. Close it and open it again.",
  not_requester: "Only the person who requested this payment can confirm it.",
  self_approval: "You requested this payment, so someone else must approve it.",
  approver_lacks_role: "Only an approver can do this.",
  approver_inactive: "Your account cannot approve payments right now.",
  not_pending: "This payment is no longer waiting for approval. Reload the page.",
  request_expired: "This payment request expired. Nothing was paid. Request it again.",
  approval_expired:
    "The approval is older than 24 hours and no longer counts. Request the payment again.",
  not_draft: "This payment was already confirmed or closed. Reload the page.",
  not_cancellable: "It is too late to cancel: the payment is already with the bank.",
  controls_changed:
    "The payment controls were tightened while this was open. Request the payment again.",
  client_key_reused:
    "That request was already used for a different payment. Close the sheet and start again.",
  amount_invalid: "The amount is not a valid payment amount.",
  checks_incomplete: "Every verification check must be ticked.",
  bad_note: "The note is too short or too long.",
  note_required: "Write a reason for turning this down (at least 3 characters).",
  last_four_mismatch: "The last four characters do not match the bank account shown.",
  iban_changed: "The bank account changed while this was open. Reload and check it again.",
  iban_missing: "The supplier has no bank account.",
  iban_invalid: "The supplier's bank account is not valid.",
  iban_cache_stale:
    "The supplier's bank account was read too long ago. Wait for the next read of Exact.",
  iban_key_missing: "The payment security key is not set up, so nothing can be done here yet.",
  not_a_supplier: "That relation is not a supplier.",
  mode_pay_requires_verification: "One-click paying needs the sandbox checks to be done first.",
  plan_not_company: "One-click paying needs the Company plan at Revolut.",
  not_verified: "The payment path has not been verified yet.",
  limits_inconsistent:
    "The limits do not fit together: the four-eyes limit must be at most the single-payment ceiling, which must be at most the daily ceiling.",
  bad_limit: "That limit is not a valid amount.",
  bad_currencies: "That currency list is not valid.",
  bad_mode: "That payment mode is not valid.",
  bad_field: "One of the values is not valid.",
  // Admin tools: resolve-not-sent and preview payment.
  not_unknown: "This request is not waiting on an unknown outcome, so there is nothing to resolve.",
  lookup_not_fresh:
    "Revolut was not asked recently enough whether it has this payment. Wait for the next check, then try again.",
  too_soon:
    "This request became unknown less than 15 minutes ago. Revolut can be slow to show a payment, so wait.",
  lookup_too_early:
    "The last check was made too soon after the request became unknown. Wait for a later check, then try again.",
  refused: "The change was refused. Reload the page and look at the request again.",
  batch_pay_unsupported: "A batch can only be sent as drafts, so there is nothing to preview.",
  builder_refused:
    "The payment data could not be turned into a bank request. That is a finding: check the reference, name and amount.",
  iban_binding_broken:
    "The stored bank account no longer matches the one an approver confirmed. Nothing can be sent.",
  forbidden: "You do not have the role for this.",
  unauthenticated: "You are signed out. Sign in again.",
};

/**
 * An unknown refusal. It does not promise "nothing was paid" or "nothing was changed": for a write
 * the server may have done it before the answer failed. The person checks before trying again (a
 * retry of the same sheet sends the same client key, so it cannot make a second request).
 */
export const ERROR_FALLBACK =
  "That did not go through. Check the status in Treasury, Bank, Payments before you try again.";

/** No answer at all (network, timeout): the request may or may not have arrived. */
export const NO_ANSWER_TEXT =
  "Could not reach the server, so we cannot tell whether this arrived. Check the status in Treasury, Bank, Payments before you try again.";

/** A sentence for a refusal or a failure; never the server's text. */
export function describePaymentError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403 && !own(ERROR_TEXT, e.code)) return ERROR_TEXT["forbidden"] as string;
    return own(ERROR_TEXT, e.code) ? (ERROR_TEXT[e.code] as string) : ERROR_FALLBACK;
  }
  return NO_ANSWER_TEXT;
}

/** Per-bill block codes of a refused batch (422 `blocked`), by open item id. */
export function itemBlocksOf(e: unknown): { openItemId: number; blocks: readonly string[] }[] {
  return e instanceof ApiError ? [...(e.itemBlocks ?? [])] : [];
}

/** The block codes of a refused request (422 `blocked`), or null when the error is another one. */
export function blocksOf(e: unknown): string[] | null {
  if (e instanceof ApiError && e.code === "blocked" && e.status === 422) {
    return [...(e.lists?.["blocks"] ?? [])];
  }
  return null;
}

// ---- Settings, Payments -----------------------------------------------------------------------

export const BLOCKER_TEXT: Record<string, string> = {
  not_verified: "The payment path has not been verified on the Revolut sandbox yet.",
  protocol_changed:
    "The payment rules changed since the last verification, so it must be done again.",
  submitter_unavailable: "The part that talks to the bank is not built or not available yet.",
  approval_mapping_unverified: "The approval status mapping from Exact is not verified.",
  no_revolut_connection: "There is no active Revolut connection.",
  no_approver: "No active user has the approver role.",
  iban_key_missing: "The payment security key (a Workers secret) is not set.",
  pay_mode_not_verified:
    "One-click pay is chosen but its sandbox check is not done, so payments stay blocked.",
  payments_disabled: "The switch is off.",
};
export const BLOCKER_FALLBACK = "Something else stops payments.";
export function blockerText(code: string): string {
  return own(BLOCKER_TEXT, code) ? (BLOCKER_TEXT[code] as string) : BLOCKER_FALLBACK;
}

export const VERIFY_CHECK_TEXT: Record<string, string> = {
  revolut_plan_known: "The Revolut plan is known (Company or not).",
  sandbox_draft_roundtrip: "A payment draft was created and read back on the Revolut sandbox.",
  sandbox_counterparty_roundtrip: "A payee was created and read back on the Revolut sandbox.",
  sandbox_pay_roundtrip:
    "A direct payment was made and read back on the Revolut sandbox (needed only for one-click pay).",
  request_id_idempotency_replay: "The same request id sent twice made one payment on the sandbox.",
  lost_answer_lookup_drill: "A lost answer was found again by looking up its request id.",
  reference_charset_probe: "The allowed characters and length of a reference were checked.",
  amount_format_probe: "The amount format was checked with small and large amounts.",
  webhook_state_sequence: "The order of the bank's status updates was checked.",
  four_eyes_approver_accounts_checked: "The approver accounts were checked.",
  first_iban_verified_out_of_band: "The first supplier account was confirmed out of band.",
  approval_mapping_verified_in_exact: "The approval status mapping was verified in Exact.",
  limits_reviewed_by_finance_lead: "The limits were reviewed by the finance lead.",
};
export const VERIFY_CHECK_FALLBACK = "A check this screen does not know yet.";
export function verifyCheckText(code: string): string {
  return own(VERIFY_CHECK_TEXT, code) ? (VERIFY_CHECK_TEXT[code] as string) : VERIFY_CHECK_FALLBACK;
}

export const SETTING_FIELD_TEXT: Record<string, string> = {
  fourEyesEnabled: "four-eyes approval",
  fourEyesLimitMinor: "four-eyes limit",
  requireApprovalForNewIban: "second approver for new bank details",
  maxRequestMinor: "ceiling per payment",
  maxDailyMinor: "daily ceiling",
  allowPartial: "part payments",
  blockOnInsufficientBalance: "block on low balance",
  allowedCurrencies: "allowed currencies",
  mode: "payment mode",
};
export function settingFieldText(code: string): string {
  return own(SETTING_FIELD_TEXT, code) ? (SETTING_FIELD_TEXT[code] as string) : "a control";
}
