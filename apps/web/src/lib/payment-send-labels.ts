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
  if (own(ERROR_TEXT, code)) return ERROR_TEXT[code] as string;
  return SEND_REFUSED_FALLBACK;
}

/** True when the failure is a refusal the server made BEFORE claiming the request. */
export function isRefusal(e: unknown): e is ApiError {
  return e instanceof ApiError && (e.status === 409 || e.status === 404);
}

/** Words for a failed submit call. A refusal says nothing was sent; anything else does not. */
export function describeSendError(e: unknown): string {
  if (e instanceof ApiError && e.status === 403 && !own(SEND_TEXT, e.code)) {
    return ERROR_TEXT["forbidden"] as string;
  }
  if (isRefusal(e)) return sendRefusalText(e.code);
  return SEND_UNSURE_TEXT;
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
