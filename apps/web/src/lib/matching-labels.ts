/**
 * Every matching word a person reads, in ONE place (M7d, ADR 0043): why a line is not matched
 * automatically, what a server refusal means, ignore reasons, booking states. Sentence case, calm,
 * no raw codes. A test asserts that every block and reason code of core has a label here.
 */
import type {
  BookingStatus,
  MatchBlockedReason,
  MatchIgnoreReason,
  MatchTxDto,
} from "@camelthorn/core";
import type { ChipTone } from "@camelthorn/ui";
import { ApiError } from "../api";

// ---- why a line is not matched automatically ---------------------------------------------------

/** Block codes: core (explain.ts BLOCK_CODES) plus the worker's own `incomplete_input`. */
export const BLOCK_LABELS: Record<string, string> = {
  tx_frozen: "This line is locked, so a person decides",
  tx_state_conflict: "Revolut changed this line after it was final",
  tx_type_not_auto: "This type of payment is never matched automatically",
  item_closed: "The invoice is already closed in Exact",
  item_has_live_match: "Another match already uses this invoice",
  claimed_by_earlier_transaction: "An earlier bank line already claims this invoice",
  currency_mismatch: "The currency differs, so it is never automatic",
  reference_not_exact: "The reference only resembles the invoice number",
  iban_belongs_to_other_relation: "The sender's account belongs to another customer or supplier",
  reference_names_other_item: "The reference also names another invoice",
  iban_not_known_for_supplier: "This is not a known supplier account, so check for fraud",
  iban_recently_changed: "The supplier's account was added or changed recently",
  amount_difference: "The amount differs from the open balance",
  not_full_payment: "This does not pay the open balance in full",
  suggestion_only: "Matched on the amount alone, so it is only a suggestion",
  ledger_auto_disabled: "Ledger patterns are never booked automatically",
  score_below_threshold: "The score is below the automatic threshold",
  close_second_candidate: "Another candidate scores almost as high",
  not_top_candidate: "Another candidate scores higher",
  incomplete_input: "Some bank details are missing, so a person checks it",
};

const BLOCK_FALLBACK = "A person needs to check this";

export function blockLabel(code: string): string {
  return Object.prototype.hasOwnProperty.call(BLOCK_LABELS, code)
    ? (BLOCK_LABELS[code] as string)
    : BLOCK_FALLBACK;
}

/** The labels of a candidate's blocked reasons, without repeats, in the engine's order. */
export function blockLabels(blocked: readonly MatchBlockedReason[]): string[] {
  return [...new Set(blocked.map((b) => blockLabel(b.code)))];
}

/** Reason codes of a candidate (why the engine ranked it). */
export const REASON_LABELS: Record<string, string> = {
  invoice_number_in_reference: "Invoice number in the reference",
  group_sum_equals_amount: "Several invoices add up to the amount",
  amount_equals_open: "Amount equals the open balance",
  amount_partial: "Part payment",
  amount_over: "More than the open balance",
  iban_matches_relation: "Sender's account matches the relation",
  unique_for_relation: "Only open item of the relation with this amount",
  single_amount_candidate: "Only open item with this amount",
  multiple_amount_candidates: "Several items have this amount",
  name_similar: "Name resembles the relation",
  pattern: "Known ledger pattern",
  due_date_near: "Paid close to the due date",
  currency_mismatch: "Different currency",
  reference_not_exact: "Reference resembles the invoice number",
  iban_belongs_to_other_relation: "Sender's account belongs to another relation",
  amount_within_tolerance: "Within the amount tolerance",
};

export function reasonLabel(code: string): string {
  return Object.prototype.hasOwnProperty.call(REASON_LABELS, code)
    ? (REASON_LABELS[code] as string)
    : "Other signal";
}

// ---- lines, matches, review flags --------------------------------------------------------------

export const IGNORE_REASONS: readonly { value: MatchIgnoreReason; label: string }[] = [
  { value: "internal_transfer", label: "Transfer between our own accounts" },
  { value: "not_ours", label: "Not ours" },
  { value: "other", label: "Other reason" },
];

export function ignoreReasonLabel(r: MatchIgnoreReason | null | undefined): string {
  return IGNORE_REASONS.find((x) => x.value === r)?.label ?? "Ignored";
}

/** `matches.review_reason`: data changed after matching; the match is never booked. */
export const REVIEW_REASON_LABELS: Record<string, string> = {
  over_allocated: "The invoice was paid elsewhere, so this match now exceeds what is open",
  item_closed: "The invoice was closed in Exact after this match",
  tx_state_conflict: "Revolut changed the bank line after this match",
  tx_changed: "The bank line changed after this match",
};

export function reviewReasonLabel(code: string | null): string | null {
  if (code === null) return null;
  return Object.prototype.hasOwnProperty.call(REVIEW_REASON_LABELS, code)
    ? (REVIEW_REASON_LABELS[code] as string)
    : "The data changed after this match";
}

export const STATE_CONFLICT_BADGE = "Needs a manager's check";
export const STATE_CONFLICT_TEXT =
  "Revolut reported a different final state for this line after it was final. It is not matched until an administrator has checked it and cleared the conflict.";

export const NOT_BOOKED = "not_booked";
export const ALREADY_BOOKED_TEXT = "Already booked in Exact. Reverse it there.";

/** What `matches.exact_state` means, in words (a free lower-case word; unknown ones stay calm). */
export function exactStateLabel(state: string): string {
  switch (state) {
    case NOT_BOOKED:
      return "Not booked in Exact";
    case "queued":
    case "booking":
    case "sending":
      return "Being booked in Exact";
    case "booked":
    case "verified":
      return "Booked in Exact";
    default:
      return "Handled in Exact";
  }
}

export function txIsActionable(tx: MatchTxDto): boolean {
  return (
    tx.mapped && !tx.stateConflict && tx.matchStatus !== "matched" && tx.matchStatus !== "ignored"
  );
}

// ---- server refusals ---------------------------------------------------------------------------

/** The refusal codes of the matching and booking routes, in plain words. */
export const ERROR_TEXT: Record<string, string> = {
  // 409: the data changed while the sheet was open
  already_matched: "This bank line was matched in the meantime. The sheet shows the latest state.",
  tx_ignored: "This bank line was ignored in the meantime. Unignore it first to match it.",
  tx_state_conflict:
    "Revolut changed this bank line after it was final. An administrator must check it first.",
  item_has_live_match: "Another match already uses this invoice.",
  item_changed:
    "An invoice changed while you were working: it was paid, closed or matched elsewhere. Check the list again.",
  different_relation:
    "This invoice belongs to a different customer or supplier than the sender's account. Tick the box to confirm.",
  already_undone: "This match was already undone.",
  already_booked_in_exact: "Already booked in Exact. Reverse it there.",
  already_ignored: "This bank line is already ignored.",
  not_ignorable: "This bank line cannot be ignored now. The sheet shows the latest state.",
  not_ignored: "This bank line is not ignored.",
  no_conflict: "This bank line has no conflict to clear.",
  has_live_matches: "Live matches use this account. Undo them before changing its administration.",
  // 422: the request does not fit the data
  account_not_mapped:
    "This bank account is not linked to an administration yet. An administrator maps it in Settings, Matching.",
  division_inactive:
    "The administration of this account is not being synced, so nothing can be matched in it.",
  tx_not_final: "This bank line is not final yet. Only final, completed lines can be matched.",
  tx_not_matchable: "This bank line cannot be matched (the amount is zero).",
  item_not_found: "One of the invoices no longer exists. Pick again.",
  item_wrong_division: "One of the invoices is in another administration than this bank account.",
  item_closed: "One of the invoices is already closed in Exact.",
  currency_mismatch: "The invoice currency differs from the bank line.",
  direction_mismatch:
    "An invoice here settles money in the other direction (for example a credit note on a payment).",
  allocation_exceeds_open: "An amount is more than what is still open on that invoice.",
  allocation_sum_mismatch: "The amounts must add up to the bank line exactly.",
  duplicate_item: "An invoice appears twice. Combine the amounts into one line.",
  allocations_or_ledger: "Choose invoices or a ledger account, not both.",
  pattern_not_allowed: "That pattern is outside the safe subset. Simplify it.",
  too_many_patterns: "There are too many patterns. Remove one first.",
  config_invalid: "The stored matching settings are not valid. Fix them before switching on.",
  confirmation_required: "Type the confirmation text exactly.",
  bad_config: "These settings are not valid. Check the highlighted values.",
  unknown_division: "That administration is not available for matching.",
  unknown_account: "That bank account does not exist.",
  // booking
  not_verified: "The Exact write path is not verified yet.",
  blocked: "Booking cannot be switched on until the listed blockers are fixed.",
  // general
  not_found: "That item no longer exists. The list is refreshed.",
  forbidden: "You do not have permission to do this.",
  bad_request: "That request was not valid. Check the values and try again.",
  unauthenticated: "Your session ended. Sign in again to continue.",
  bad_note: "The note is missing or too long (up to 200 characters).",
  bad_reason: "The reason is missing or too long (up to 200 characters).",
  bad_ledger_account: "That ledger account code is not valid.",
  bad_allocations: "The amounts are not valid.",
};

/** A refusal that means "the data moved": show it, then refresh the sheet and the queue. */
export function isStale(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 409 || e.status === 422 || e.status === 404);
}

/** A sentence for the person; never the raw server code or message. */
export function describeMatchError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return ERROR_TEXT["forbidden"] as string;
    if (Object.prototype.hasOwnProperty.call(ERROR_TEXT, e.code)) {
      return ERROR_TEXT[e.code] as string;
    }
    if (e.code.startsWith("bad_")) return ERROR_TEXT["bad_request"] as string;
    if (e.status === 409) return "This changed in the meantime. The sheet shows the latest state.";
    if (e.status >= 500) return "The server could not do this. Nothing was changed. Try again.";
    return "Could not do this. Nothing was changed. Try again.";
  }
  return "Could not reach the server. Nothing was changed. Try again.";
}

// ---- booking in Exact --------------------------------------------------------------------------

/**
 * The sentence in every confirmation that says what happens in Exact. `null` means the booking
 * setting could not be read (a person without access, or a failed request): the wording then
 * does not promise either way.
 */
export function bookingSentence(
  s: { enabled: boolean; blockers: readonly string[] } | null,
): string {
  if (s === null) {
    return "This is recorded in the app. Whether it is then booked in Exact depends on a setting an administrator controls.";
  }
  if (!s.enabled) return "This is recorded in the app only; nothing is booked in Exact yet.";
  if (s.blockers.length > 0) {
    return "This is recorded in the app. Booking in Exact is switched on but blocked right now; once it is unblocked, booking happens automatically and cannot be undone here.";
  }
  return "Booking in Exact happens automatically afterwards and cannot be undone here.";
}

export const BOOKING_STATUS: Record<
  BookingStatus,
  { label: string; tone: ChipTone; hint: string }
> = {
  pending: { label: "Waiting", tone: "neutral", hint: "Queued; it will be sent to Exact soon." },
  sending: { label: "Sending", tone: "neutral", hint: "Being sent to Exact now." },
  sent_unverified: {
    label: "Sent, not confirmed",
    tone: "gold",
    hint: "Sent to Exact; the check that it arrived is still pending.",
  },
  verified: { label: "Booked", tone: "ok", hint: "Exact confirmed the booking." },
  failed: { label: "Failed", tone: "warn", hint: "Exact refused it. Nothing was booked." },
  outcome_unknown: {
    label: "Outcome unknown",
    tone: "warn",
    hint: "We could not tell whether Exact booked it. Check Exact before choosing what to do.",
  },
  manual_required: {
    label: "Needs a person",
    tone: "warn",
    hint: "It cannot be booked automatically. Book it in Exact, then mark it as booked manually.",
  },
  waiting_for_bank_line: {
    label: "Waiting for the bank line",
    tone: "gold",
    hint: "Exact has no bank entry for this line yet.",
  },
  resolved_manually: { label: "Booked manually", tone: "ok", hint: "A person booked it in Exact." },
  given_up: { label: "Given up", tone: "neutral", hint: "It will not be booked by the app." },
};

export const BOOKING_STATUS_ORDER: readonly BookingStatus[] = [
  "pending",
  "sending",
  "sent_unverified",
  "waiting_for_bank_line",
  "failed",
  "outcome_unknown",
  "manual_required",
  "verified",
  "resolved_manually",
  "given_up",
];

/** Statuses an admin can still act on. */
export const OUTBOX_ACTIONABLE: readonly BookingStatus[] = [
  "failed",
  "outcome_unknown",
  "manual_required",
];

const BLOCKER_TEXT: Record<string, string> = {
  not_verified: "The Exact write path has not been verified on a test administration.",
  protocol_changed: "The Exact write format changed since it was verified.",
  creates_bank_entries_unknown:
    "It is not decided who creates the bank entries in Exact (Settings, Connections).",
  no_account_map: "No bank account is linked to an administration yet.",
  exact_not_connected: "Exact is not connected.",
  revolut_not_connected: "Revolut is not connected.",
};

/** A blocker from the server as a sentence (known codes mapped, unknown ones made readable). */
export function blockerText(b: string): string {
  if (Object.prototype.hasOwnProperty.call(BLOCKER_TEXT, b)) return BLOCKER_TEXT[b] as string;
  const words = b.replace(/[_-]+/g, " ").trim();
  if (words === "") return "Something blocks booking.";
  const s = words.charAt(0).toUpperCase() + words.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}
