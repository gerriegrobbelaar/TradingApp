/**
 * Every matching word a person reads, in ONE place (M7d, ADR 0043): why a line is not matched
 * automatically, what a server refusal means, ignore reasons, booking states. Sentence case, calm,
 * no raw codes. A test asserts that every block and reason code of core has a label here.
 */
import type {
  BookingStatus,
  BookingVerifyCheck,
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
  iban_unknown_for_customer:
    "The payment came from an account we do not know for this customer, so a person checks it",
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
  confirmation_required:
    "Type the confirmation text exactly. A change that lets automatic matching do more needs it again: switch automatic matching off, save, then switch it on.",
  conflict: "Somebody else changed these settings just now. Reload the page to see their change.",
  bad_config: "These settings are not valid. Check the highlighted values.",
  unknown_division: "That administration is not available for matching.",
  unknown_account: "That bank account does not exist.",
  // 400: a value the server refused
  bad_request: "That request was not valid. Check the values and try again.",
  bad_note:
    "The note is missing, too short or too long. A verification note needs 10 to 500 characters, other notes up to 200.",
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
  bad_rev: "The settings version was not valid. Reload the page and try again.",
  bad_account: "That bank account is not valid.",
  bad_division: "That administration is not valid.",
  bad_journal_code: "That journal code is not valid.",
  bad_gl_account: "That bank ledger account code is not valid.",
  bad_ids: "The invoices could not be checked. Remove one and try again.",
  bad_status: "That filter is not valid.",
  bad_q: "That search is too long or not valid.",
  bad_limit: "That page size is not valid.",
  bad_cursor: "The list moved. It is shown from the start again.",
  // booking routes (M7c): codes not known here fall back to a calm general sentence
  not_verified: "The Exact write path is not verified yet.",
  blocked: "Booking cannot be switched on until the listed blockers are fixed.",
  blockers_changed:
    "Something changed since this dialog opened (a blocker, the verification or the switch). Nothing was switched on. The card is refreshed; check it, then open Enable again.",
  bank_entries_undecided:
    "It is not decided yet who creates the bank entries in Exact (Settings, Connections). Decide that first.",
  checks_incomplete:
    "Tick every check first. Each one must be done on the test administration before the write path counts as verified.",
  bad_checks: "Tick every check first. Each one must be done on the test administration.",
  bad_receivable_gl_account: "That debtors control account code is not valid.",
  bad_payable_gl_account: "That creditors control account code is not valid.",
  bad_opening_balance:
    "That opening balance is not valid. Type digits with at most the currency's decimals and, for an overdrawn journal, one minus sign in front.",
  bad_resolution: "That choice is not valid. Close the sheet and try again.",
  booking_from_in_future:
    "That date and time is too far in the future. Pick a time no later than tomorrow.",
  changed_meanwhile:
    "This row changed in the meantime. The booking queue is refreshed; check it again before choosing.",
  in_flight:
    "This is being sent to Exact right now. Wait until the run has finished, then check it again.",
  not_resolvable:
    "This row can no longer be changed here. The booking queue shows its latest state.",
  not_retryable:
    "This row cannot be retried. Check it in Exact and mark it as booked manually or give it up.",
  step_up_required:
    "This needs a Google sign-in from the last 15 minutes. Sign in again, then retry.",
  bad_booking_from: "That date and time is not valid.",
  bad_divisions: "Pick at least one administration that exists.",
  bad_max_per_run: "That number of matches per run is not valid.",
  bad_match_ids: "Pick between one and three matches.",
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
  // Only RUN blockers stop booking once it is on; the enable-only ones defer single matches.
  return s.blockers.some(isRunBlocker) || s.protocolChanged === true ? "blocked" : "ready";
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

/**
 * The blocker codes GET /api/booking/settings can return (worker booking/settings.ts
 * `BookingBlocker`; a test reads the worker source and keeps this list complete).
 */
export const BOOKING_BLOCKERS = [
  "not_verified",
  "protocol_changed",
  "mode_changed",
  "bank_entries_undecided",
  "no_exact_connection",
  "no_division_allowed",
  "control_accounts_missing",
  "journal_unmapped",
  "writes_disabled",
] as const;
export type BookingBlocker = (typeof BOOKING_BLOCKERS)[number];

/**
 * Blockers that stop a RUN (worker `RUN_BLOCKERS`). The others (control accounts, journal map) only
 * stop ENABLING: once booking is on, a match that misses them waits on its own with a "cannot be
 * booked yet" chip and every other match is still booked.
 */
export const RUN_BLOCKERS: readonly BookingBlocker[] = [
  "not_verified",
  "protocol_changed",
  "mode_changed",
  "bank_entries_undecided",
  "no_exact_connection",
  "no_division_allowed",
  "writes_disabled",
];

/** A blocker that stops every run (unknown codes count as stopping: the cautious reading). */
export function isRunBlocker(b: string): boolean {
  return (
    !Object.prototype.hasOwnProperty.call(BLOCKER_TEXT, b) ||
    RUN_BLOCKERS.includes(b as BookingBlocker)
  );
}

const BLOCKER_TEXT: Record<BookingBlocker, string> = {
  not_verified: "The Exact write path has not been verified on a test administration.",
  protocol_changed: "The Exact write format changed since it was verified. Verify it again.",
  mode_changed:
    "Who creates the bank entries changed since you verified. Verify the write path again.",
  bank_entries_undecided:
    "It is not decided who creates the bank entries in Exact (Settings, Connections).",
  no_exact_connection: "Exact is not connected, or the connection needs to be renewed.",
  no_division_allowed: "No administration is allowed for booking yet. Pick at least one.",
  control_accounts_missing:
    "A bank account has no debtors or creditors control account. Fill them in under Account map below.",
  journal_unmapped:
    "A bank account has no Exact journal or bank ledger account. Map it under Account map below.",
  writes_disabled: "Booking in Exact is switched off.",
};

/** Never echoes the server's text: an unknown code gets one fixed sentence. */
export const BLOCKER_FALLBACK = "Something else blocks booking. An administrator can check it.";

export function blockerText(b: string): string {
  return Object.prototype.hasOwnProperty.call(BLOCKER_TEXT, b)
    ? BLOCKER_TEXT[b as BookingBlocker]
    : BLOCKER_FALLBACK;
}

/**
 * Why a match cannot be booked yet (`bookingDeferredCode` on a match): the executor leaves it not
 * booked and tries again later (worker plan.ts DEFER_PLAN_CODES, the fee and mode checks, and
 * `build_<error>` when a body could not be built). A fixed list here, NOT derived from the worker at
 * run time: a test scans the worker source so a new code fails until it is added; at run time an
 * unknown code gets the fallback sentence.
 */
export const BOOKING_DEFERRAL_CODES = [
  "control_account_unknown",
  "ledger_account_unknown",
  "relation_code_unknown",
  "relation_unknown",
  "item_entry_number_unknown",
  "bank_balance_unknown",
  "fee_not_supported_v1",
  "mode_mismatch",
] as const;
export type BookingDeferralCode = (typeof BOOKING_DEFERRAL_CODES)[number];

export const DEFERRAL_TEXT: Record<BookingDeferralCode, string> = {
  control_account_unknown: "the debtors or creditors control account is not filled in",
  ledger_account_unknown: "the ledger account is not known in Exact yet",
  relation_code_unknown: "the customer or supplier code is not known yet",
  relation_unknown: "the customer or supplier is not known in Exact yet",
  item_entry_number_unknown: "the invoice entry number from Exact is not known yet",
  bank_balance_unknown: "the opening balance of the journal in Exact is not known",
  fee_not_supported_v1: "the bank line has a fee, which is not booked automatically yet",
  mode_mismatch:
    "the bank line's Revolut connection uses another setting for who creates bank entries",
};

export const DEFERRAL_FALLBACK = "something else is missing";

export function deferralReason(code: string): string {
  if (Object.prototype.hasOwnProperty.call(DEFERRAL_TEXT, code)) {
    return DEFERRAL_TEXT[code as BookingDeferralCode];
  }
  if (/^build_[a-z0-9_]{1,60}$/.test(code)) return "the request to Exact could not be built";
  return DEFERRAL_FALLBACK;
}

/** The calm chip text for a deferred match. */
export function deferredChipText(code: string): string {
  return `Cannot be booked yet: ${deferralReason(code)}`;
}

/**
 * Why the PREVIEW says a match would not be booked now (`wouldDefer.code`): the deferrals above,
 * plus v1 rules that end as "Needs a person" (part payments, foreign currency...), states of the
 * match itself, and what Exact answered on the read-back (`preflight_<verdict>`).
 */
export const PREVIEW_OUTCOME_TEXT: Record<string, string> = {
  match_not_found: "the match no longer exists",
  match_undone: "the match was undone",
  match_already_claimed: "the booking job has already picked this match up",
  match_flagged: "the match needs a check first",
  tx_not_final: "the bank line is not final at Revolut",
  match_not_bookable: "the match cannot be booked in its current state",
  bank_entries_undecided: "it is not decided who creates the bank entries in Exact",
  ledger_booking_with_feed_manual:
    "a ledger booking is not made by this app while another integration creates the bank entries; book it in Exact by hand",
  bad_amount: "the amount is not valid",
  no_items: "the match has no invoice",
  item_not_open: "an invoice is no longer open",
  mixed_currency: "the bank line and the invoices use different currencies",
  mixed_item_kinds: "the match mixes invoices and bills",
  multiple_relations: "the invoices belong to more than one customer or supplier",
  fx_not_supported_v1: "foreign currency is not booked automatically yet",
  part_payment_not_supported_v1: "a part payment is not booked automatically yet",
  partial_match_not_supported_v1:
    "a match that leaves an amount open is not booked automatically yet",
  preflight_already_settled: "Exact already shows the invoice as settled",
  preflight_changed: "the invoice changed in Exact since the match",
  preflight_inconclusive: "Exact could not be checked just now",
};

export function previewOutcomeReason(code: string): string {
  if (Object.prototype.hasOwnProperty.call(PREVIEW_OUTCOME_TEXT, code)) {
    return PREVIEW_OUTCOME_TEXT[code] as string;
  }
  return deferralReason(code);
}

/** What a read of the preview may report as its error (worker preview.ts `readErrorCode`). */
export const PREVIEW_READ_ERROR_TEXT: Record<string, string> = {
  rate_limited: "Exact asked us to slow down; try again in a minute",
  exact_auth: "the Exact connection needs to be renewed",
  gate_budget: "today's Exact call budget is used up",
  read_failed: "a read from Exact failed",
  body_too_large: "a body is too large to show here",
};

export function previewReadErrorText(code: string): string {
  return Object.prototype.hasOwnProperty.call(PREVIEW_READ_ERROR_TEXT, code)
    ? (PREVIEW_READ_ERROR_TEXT[code] as string)
    : "a read from Exact failed";
}

// ---- verifying the write path (one tick per check, DEPLOY.md step 0 item 18) -----------------

/**
 * One instruction per check of core BOOKING_VERIFY_CHECKS (the type forces completeness). ONE
 * source for the dialog and the runbook: `doc` is the assumption reference used in docs/DEPLOY.md
 * step 0 item 18, and a test asserts that DEPLOY.md names every check code, its label and its `doc`
 * reference, so the dialog and the runbook cannot drift apart.
 */
export const VERIFY_CHECK_TEXT: Record<
  BookingVerifyCheck,
  { label: string; how: string; doc: string }
> = {
  probe_zero_for_random_ref: {
    label: "The duplicate probe finds nothing for a random reference",
    how: "On the test journal, the bank-line search for a reference that does not exist returned zero lines, and exactly one line for the real test reference (also in upper case). If a random reference returns lines, stop: booking must not be enabled.",
    doc: "A6/A13",
  },
  bank_entry_sign: {
    label: "The bank entry has the right sign",
    how: "You posted the bank entry body from Preview booking by hand on the test journal, and Exact shows one line with the right sign, date and reference.",
    doc: "A1, A3, A7, A9, A10",
  },
  matchset_signs_and_control_account: {
    label: "The match uses the right signs and control account",
    how: "You uploaded the match body from Preview booking by hand (the placeholder number 999999999 replaced by the real entry number) and Exact shows the match with the right signs and the debtors or creditors control account.",
    doc: "A2, A4, A5, A8, A14, A15, A16",
  },
  balance_chain: {
    label: "The balance chain continues",
    how: "The newest entry of the test journal shows the closing balance that the next entry must open with.",
    doc: "A12",
  },
  matchset_readback: {
    label: "The read-back shows the invoice as paid",
    how: "After the match, the receivables read shows the test invoice as paid, and the bank entry alone did not already settle it.",
    doc: "A16",
  },
  lost_answer_drill: {
    label: "The lost-answer drill passed",
    how: "You blocked the network right after sending: the row ended as outcome unknown, the next run did not send again, and Retry found the entry instead of making a second one.",
    doc: "Lost answer",
  },
  preview_matches_manual_payload: {
    label: "Preview booking matches what you sent by hand",
    how: "The bodies you posted by hand on the test administration are byte for byte the bodies Preview booking shows, with the same hashes.",
    doc: "byte for byte",
  },
};

/** The plain label of a recorded check; an unknown code keeps one calm sentence. */
export function verifyCheckLabel(code: string): string {
  return Object.prototype.hasOwnProperty.call(VERIFY_CHECK_TEXT, code)
    ? VERIFY_CHECK_TEXT[code as BookingVerifyCheck].label
    : "A check this version does not know";
}
