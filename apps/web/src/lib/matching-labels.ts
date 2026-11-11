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

/**
 * The refusal codes of the matching routes (apps/worker/src/matching/routes.ts), in plain words.
 * A test reads the worker source and fails when a code the routes can return has no entry here.
 */
export const ERROR_TEXT: Record<string, string> = {
  // 409: the data changed while the sheet was open
  already_matched: "This bank line was matched in the meantime. The sheet shows the latest state.",
  tx_ignored: "This bank line was ignored in the meantime. Unignore it first to match it.",
  tx_state_conflict:
    "Revolut changed this bank line after it was final. An administrator must check it first.",
  item_has_live_match: "Another match already uses this invoice.",
  item_changed:
    "An invoice changed while you were working: it was paid, closed or matched elsewhere. Check the amounts again.",
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
  allocation_exceeds_open:
    "An amount is more than what is still free on that invoice (open in Exact, minus matches already recorded here). The amounts were checked again.",
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
  // 400: a value the server refused
  bad_request: "That request was not valid. Check the values and try again.",
  bad_note: "The note is missing or too long (up to 200 characters).",
  bad_reason: "The reason is missing or too long (up to 200 characters).",
  bad_ledger_account: "That ledger account code is not valid.",
  bad_allocations: "The amounts are not valid.",
  bad_confirm: "The confirmation was not valid. Try again.",
  bad_transaction: "That bank line is not valid. Close the sheet and open it again.",
  bad_type: "The payment type is not valid. Use one lower-case word.",
  bad_direction: "The direction is not valid.",
  bad_max_amount: "The maximum amount is not valid.",
  bad_enabled: "The on/off value was not valid. Try again.",
  bad_auto_enabled: "The on/off value was not valid. Try again.",
  bad_account: "That bank account is not valid.",
  bad_division: "That administration is not valid.",
  bad_journal_code: "That journal code is not valid.",
  bad_gl_account: "That bank ledger account code is not valid.",
  bad_opening_balance: "The opening balance must be a whole number of cents.",
  bad_ids: "The invoices could not be checked. Remove one and try again.",
  bad_status: "That filter is not valid.",
  bad_q: "That search is too long or not valid.",
  bad_limit: "That page size is not valid.",
  bad_cursor: "The list moved. It is shown from the start again.",
  // booking routes (M7c): codes not known here fall back to a calm general sentence
  not_verified: "The Exact write path is not verified yet.",
  blocked: "Booking cannot be switched on until the listed blockers are fixed.",
  // general
  not_found: "That item no longer exists. The list is refreshed.",
  forbidden: "You do not have permission to do this.",
  unauthenticated: "Your session ended. Sign in again to continue.",
  csrf: "The request was refused. Reload the page and try again.",
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
 * What the booking setting means for a new match: `off` (nothing goes to Exact), `blocked` (on, but
 * something stops it right now), `ready` (on and nothing blocks it), `unknown` (the setting could
 * not be read). One function for the confirmation wording and the Settings chip.
 */
export type BookingState = "off" | "blocked" | "ready" | "unknown";

export function bookingState(
  s: { enabled: boolean; blockers: readonly string[]; protocolChanged?: boolean } | null,
): BookingState {
  if (s === null) return "unknown";
  if (!s.enabled) return "off";
  return s.blockers.length > 0 || s.protocolChanged === true ? "blocked" : "ready";
}

/** Recording a match never moves money; every confirmation says so. */
export const NO_PAYMENT = "No money is paid or moved.";

/**
 * The sentence in every match confirmation that says what happens in Exact, keyed off the real
 * `enabled` + `blockers` state. Readable by every role (the booking settings GET is open to all).
 */
export function bookingSentence(
  s: { enabled: boolean; blockers: readonly string[]; protocolChanged?: boolean } | null,
): string {
  switch (bookingState(s)) {
    case "unknown":
      return `This is recorded in the app. The booking setting could not be read, so it is not certain whether it is then booked in Exact. ${NO_PAYMENT}`;
    case "off":
      return `This is recorded in the app only. Nothing is booked in Exact, because booking in Exact is off. ${NO_PAYMENT}`;
    case "blocked":
      return `This is recorded in the app. Booking in Exact is on but blocked right now, so nothing is booked yet; once it is unblocked it is booked in Exact automatically afterwards and cannot be undone here. ${NO_PAYMENT}`;
    case "ready":
      return `This is recorded in the app, then booked in Exact automatically afterwards and cannot be undone here. ${NO_PAYMENT}`;
  }
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

/** The blocker codes GET /api/booking/settings can return (fixed with M7c). */
export const BOOKING_BLOCKERS = [
  "not_verified",
  "protocol_changed",
  "bank_entries_undecided",
  "no_exact_connection",
  "writes_disabled",
] as const;
export type BookingBlocker = (typeof BOOKING_BLOCKERS)[number];

const BLOCKER_TEXT: Record<BookingBlocker, string> = {
  not_verified: "The Exact write path has not been verified on a test administration.",
  protocol_changed: "The Exact write format changed since it was verified. Verify it again.",
  bank_entries_undecided:
    "It is not decided who creates the bank entries in Exact (Settings, Connections).",
  no_exact_connection: "Exact is not connected, or the connection needs to be renewed.",
  writes_disabled: "Writes to Exact are switched off for this installation.",
};

/** Never echoes the server's text: an unknown code gets one fixed sentence. */
export const BLOCKER_FALLBACK = "Something else blocks booking. An administrator can check it.";

export function blockerText(b: string): string {
  return Object.prototype.hasOwnProperty.call(BLOCKER_TEXT, b)
    ? BLOCKER_TEXT[b as BookingBlocker]
    : BLOCKER_FALLBACK;
}
