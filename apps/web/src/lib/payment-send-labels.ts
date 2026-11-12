/**
 * The words of "Send to bank" (F9c, ADR 0054): what the confirmation says will happen, what each
 * refusal of POST .../submit means, and what each outcome means. ONE map from the worker's stable
 * codes; an unknown code gets one fixed generic sentence, never the server's text and never blank.
 * A test lists every code the worker's submit path can answer and fails when one has no sentence.
 *
 * The honest rule behind every sentence: a REFUSAL (409/404 with a code) happened before anything
 * was claimed or sent, so "nothing was sent" is true. Any other failure (a timeout, a 5xx, no
 * answer) is NOT known to be a refusal, so those never promise it: they say "do not send again".
 */
import type { PaymentMode } from "@camelthorn/core";
import { ApiError } from "../api";
import {
  ERROR_TEXT,
  PROVIDER_REJECT_TEXT,
  blockText,
  providerRejectText,
  reasonText,
} from "./payment-labels";

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** What the confirmation sheet says happens next, by mode. */
export const SEND_NEXT_TEXT: Record<PaymentMode, string> = {
  drafts:
    "A draft is created in Revolut. You must approve it in the Revolut app. Nothing is paid until you do.",
  pay: "The bank pays immediately.",
};

/** Refusals of the submit routes (409/404). Each is raised before anything is claimed or sent. */
export const SEND_TEXT: Record<string, string> = {
  // Switches and verification
  payments_disabled:
    "Payments are switched off, so nothing was sent. An administrator switches them on in Settings, Payments.",
  payments_payments_disabled:
    "Payments are switched off, so nothing was sent. An administrator switches them on in Settings, Payments.",
  payments_execution_off:
    "Sending to the bank is not switched on in this deployment, so nothing was sent. Ask an administrator.",
  payments_not_verified:
    "The payment path has not been verified, so nothing was sent. An administrator does that in Settings, Payments.",
  payments_protocol_changed:
    "The payment rules changed since the last verification, so nothing was sent. An administrator verifies again in Settings, Payments.",
  payments_pay_not_verified:
    "One-click pay is not verified on the Revolut sandbox, so nothing was sent.",
  pay_mode_not_verified:
    "This request was made for one-click pay, but that has not been verified, so nothing was sent. Cancel it and ask for a new payment, or ask an administrator.",
  submitter_unavailable:
    "The part that talks to the bank is not available, so nothing was sent. Ask an administrator.",
  no_revolut_connection: "There is no active Revolut connection, so nothing was sent.",
  gate_unavailable:
    "The bank connection did not answer, so nothing was sent. Try again in a minute.",
  // Another send, or the connection is busy
  busy: "Another payment is being sent right now, so nothing was sent. Wait a minute and try again.",
  payment_lease:
    "The bank connection is held by another send, so nothing was sent. Wait a minute and try again.",
  already_claimed:
    "Someone else is already sending this request, so nothing was sent from here. Check its status in a minute.",
  owner: "Your sign-in could not be used to send, so nothing was sent. Sign in again.",
  connection:
    "The bank connection could not be identified, so nothing was sent. Ask an administrator.",
  connection_mismatch:
    "The bank connection does not match this request, so nothing was sent. Ask an administrator.",
  no_lease: "Sending is not available right now, so nothing was sent.",
  // The request itself
  not_found: "That request no longer exists. Reload the page.",
  batch_item: "This payment is part of a batch. Send the whole batch instead.",
  not_ready:
    "This request is not waiting to be sent any more, so nothing was sent now. Reload and look at its status.",
  expired: "This request expired before it was sent. Nothing was paid. Request the payment again.",
  payload_invalid:
    "The stored request failed a safety check, so it was not sent. Do not try again. Ask an administrator.",
  payload_tampered:
    "The stored request no longer matches what was approved, so it was not sent. Do not try again. Ask an administrator.",
  approvals_unreadable:
    "The approvals of this request could not be read, so it was not sent. Ask an administrator.",
  not_approved: "The approval for this request is missing, so it was not sent.",
  approval_self_approval:
    "The approver is the person who requested this, which is not allowed, so it was not sent.",
  approval_payload_changed:
    "The request changed after it was approved, so it was not sent. Request the payment again.",
  approval_approval_expired:
    "The approval is older than 24 hours and no longer counts, so it was not sent. Request the payment again.",
  approval_approver_inactive:
    "The approver's account is no longer active, so the approval does not count and nothing was sent.",
  approval_approver_lacks_role:
    "The approver no longer has the approver role, so the approval does not count and nothing was sent.",
  requester_inactive:
    "The person who requested this payment is no longer an active finance user, so it was not sent. Cancel it and request the payment again.",
  controls_changed:
    "The payment controls were tightened since this was approved, so it was not sent. Request the payment again.",
  payload_changed:
    "The payment changed since it was approved, so it was not sent. Request the payment again.",
  precheck_failed:
    "A final check against today's data failed, so it was not sent. Reload the page and look again.",
  iban_binding_broken:
    "The stored bank account no longer matches the one an approver confirmed, so nothing was sent. Do not try again. Ask an administrator.",
  // F9a (S5): the fingerprint key was rotated since the approval; not a tampered account.
  iban_key_rotated:
    "The security key for bank accounts was changed since this was approved, so nothing was sent. Cancel it and request the payment again.",
  // The pre-check refused without naming a block, or the request changed at the same moment.
  blocked:
    "A final check against today's data failed, so it was not sent. Reload the page and look again.",
  conflict:
    "Somebody else changed this request at the same moment, so nothing was sent. Reload the page and look at its status.",
  // The database's own guards on the claim (migration triggers): the claim did not happen.
  bad_transition:
    "This request is not in a state that can be sent, so nothing was sent. Reload the page and look at its status.",
  final:
    "This request is already finished, so nothing was sent. Reload the page and look at its status.",
  claim_subject:
    "This request could not be reserved for sending, so nothing was sent. Reload the page and look at its status.",
  approval_required: "The approval for this request is missing, so it was not sent.",
  // Earlier attempts and the bank's own lookups (answered as a refusal by the bank side)
  prior_attempt_live: PROVIDER_REJECT_TEXT["prior_attempt_live"] as string,
  prior_attempt_unchecked: PROVIDER_REJECT_TEXT["prior_attempt_unchecked"] as string,
  counterparty_account_ambiguous: PROVIDER_REJECT_TEXT["counterparty_account_ambiguous"] as string,
};

/** A refusal code this version does not know. It is still a refusal: nothing was sent. */
export const SEND_REFUSED_FALLBACK =
  "This request was not sent. Reload the page and look at its status before you try again.";

/**
 * Not a refusal and not an answer we can read (timeout, server error, no connection): the request
 * may or may not have reached the bank. Never promise "nothing was sent".
 */
export const SEND_UNSURE_TEXT =
  "We could not confirm what happened. Do not send it again. An administrator can check.";

/** The outcome codes of a request the server did handle (`result.to`). */
export const SEND_RESULT_TEXT = {
  submitted_drafts:
    "The draft was created in Revolut. Open the Revolut app and approve it there. Nothing is paid until you do.",
  submitted_pay:
    "The bank has the instruction. It shows as paid only after the bank confirms it and the payment is booked in Exact.",
  rejected: "The bank did not take this request. Nothing was paid.",
  outcome_unknown:
    "We could not confirm whether the bank received this. Do not send it again. An administrator can check.",
} as const;

export type SendResultKey = keyof typeof SEND_RESULT_TEXT;

/** A sentence for one refusal code (or the code with a pre-check block after a colon). */
export function sendRefusalText(code: string): string {
  if (own(SEND_TEXT, code)) return SEND_TEXT[code] as string;
  if (code.startsWith("precheck:")) {
    const b = blockText(code.slice("precheck:".length));
    return `${b.what} Nothing was sent. ${b.todo}`;
  }
  if (own(ERROR_TEXT, code)) {
    // A shared sentence (an IBAN or a limit found by the last pre-check): say what it means here.
    const t = ERROR_TEXT[code] as string;
    return /nothing (was|is) sent|not sent|nothing can be sent/i.test(t)
      ? t
      : `${t} Nothing was sent.`;
  }
  return SEND_REFUSED_FALLBACK;
}

/** A 403 on the submit route comes from the role check, before the handler runs. */
export const SEND_FORBIDDEN_TEXT =
  "Only someone with the finance role can send a payment, so nothing was sent.";

/**
 * True when the failure is a refusal the server made BEFORE claiming the request: a 409 or 404
 * with a readable code (the submit route only answers those before its claim), or a 403 of the role
 * check. An error page whose body we cannot read (`request_failed`) is NOT known to be ours, so it
 * is "unsure", never "nothing was sent".
 */
export function isRefusal(e: unknown): e is ApiError {
  return (
    e instanceof ApiError &&
    (e.status === 409 || e.status === 404 || e.status === 403) &&
    e.code !== "request_failed" &&
    e.code !== ""
  );
}

/** A refusal after which this request must not be offered again from this screen. */
export const FINAL_REFUSALS: ReadonlySet<string> = new Set(["already_claimed"]);

/** Words for a failed submit call. A refusal says nothing was sent; anything else does not. */
export function describeSendError(e: unknown): string {
  if (!isRefusal(e)) return SEND_UNSURE_TEXT;
  if (e.status === 403 && !own(SEND_TEXT, e.code)) return SEND_FORBIDDEN_TEXT;
  return sendRefusalText(e.code);
}

/** What a handled request (`result`) means, from `result.to` and the mode. Never invents success. */
export function sendResultKey(to: string, mode: PaymentMode): SendResultKey | null {
  if (to === "submitted") return mode === "drafts" ? "submitted_drafts" : "submitted_pay";
  if (to === "rejected") return "rejected";
  if (to === "outcome_unknown") return "outcome_unknown";
  return null;
}

/** The reason after a rejected send, in words (`provider_rejected:<code>`, maybe with `:late`). */
export function rejectedReasonText(code: string): string {
  const parts = code.split(":");
  return parts[0] === "provider_rejected"
    ? providerRejectText(parts[1] ?? "")
    : (reasonText(code) ?? "");
}
