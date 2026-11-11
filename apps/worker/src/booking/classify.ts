/**
 * What a thrown error from a WRITE means (task M7c, ADR 0044). Pure, no I/O. The rule: only an error
 * that provably happened BEFORE anything reached Exact is `not_sent`; a definite 4xx answer from
 * Exact is `rejected`; a 429 is `rate_limited`; everything else (timeouts, 5xx, a lost or
 * unreadable answer, a 401 after the POST, an RPC failure while the request was in the gate, an
 * error we do not know) is `unknown`, which never leads to an automatic second POST.
 *
 * Part of BOOKING_PROTOCOL_VERSION (booking/protocol.ts): a change here invalidates the verification.
 */
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  ExactWriteAuthRetryRefused,
  ExactWriteDisabledError,
  ExactWritePayloadError,
} from "@camelthorn/exact";

/** Ends the whole run (budget, deadline, switch off, gate or connection trouble). */
export class RunStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RunStop";
  }
}

export type WriteFailure =
  /** Provably nothing was sent (the gate or the writer refused before the call). */
  | { kind: "not_sent"; code: string }
  /** Exact (or the gate's queue) answered 429. Not applied; probe before sending again. */
  | { kind: "rate_limited" }
  /** Exact answered with a definite 4xx: our payload was refused. Repeating it is pointless. */
  | { kind: "rejected"; code: string }
  /** Anything else after the call was made: timeout, 5xx, lost or unreadable answer, 401. */
  | { kind: "unknown"; code: string };

/** ExactApiError codes the gate (or its validation) raises BEFORE the network call. */
export const NOT_SENT_GATE_CODES: ReadonlySet<string> = new Set([
  "writes_disabled",
  "write_not_allowed",
  "method",
  "division",
  "api",
  "priority",
  "job_id",
  "budget",
  "path",
  "query",
  "header",
  "body",
  "division_mismatch",
  "host",
  // the token step runs before the fetch (a 401 on a POST is ExactWriteAuthRetryRefused instead)
  "token_refresh_retry",
  "token_endpoint_rejected_credentials",
  "refresh_failed",
  "connection_changed",
  "wrong_token_authority",
  "not_connected",
  "needs_reauth",
]);

/**
 * ExactAuthError messages the gate raises before the fetch. The writer's own ExactAuthError (a
 * 401 ANSWER that reached it) has a different message and is therefore `unknown`.
 */
export const NOT_SENT_AUTH_CODES: ReadonlySet<string> = new Set([
  "not_connected",
  "needs_reauth",
  "token_unreadable",
  "wrong_token_authority",
  "server_misconfigured",
]);

export function classifyWriteError(e: unknown): WriteFailure {
  if (e instanceof RunStop) return { kind: "not_sent", code: e.code };
  if (e instanceof ExactBudgetExhaustedError) return { kind: "not_sent", code: "gate_budget" };
  if (e instanceof ExactWriteDisabledError) return { kind: "not_sent", code: "writes_disabled" };
  // The writer refuses an unbranded or foreign payload before it calls the transport.
  if (e instanceof ExactWritePayloadError) return { kind: "rejected", code: "payload_refused" };
  if (e instanceof ExactWriteAuthRetryRefused)
    return { kind: "unknown", code: "auth_retry_refused" };
  if (e instanceof ExactAuthError) {
    return NOT_SENT_AUTH_CODES.has(e.message)
      ? { kind: "not_sent", code: "exact_auth" }
      : { kind: "unknown", code: "auth_after_send" };
  }
  if (e instanceof ExactRateLimitedError) return { kind: "rate_limited" };
  if (e instanceof ExactApiError) {
    if (e.code !== undefined) {
      return NOT_SENT_GATE_CODES.has(e.code)
        ? { kind: "not_sent", code: e.code }
        : { kind: "unknown", code: e.code === "network" ? "network" : "gate_error" };
    }
    // A real HTTP answer from Exact (the writer throws these for non-2xx).
    if (e.status >= 400 && e.status < 500 && e.status !== 408) {
      return { kind: "rejected", code: `exact_rejected_${e.status}` };
    }
    return { kind: "unknown", code: `exact_http_${e.status}` };
  }
  return { kind: "unknown", code: "write_error" };
}
