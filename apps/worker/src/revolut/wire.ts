/**
 * Errors do not survive a Durable Object RPC call with their class or fields, so the gate answers
 * with plain-data envelopes and the Worker side rebuilds the typed errors from
 * `@camelthorn/revolut`. Messages are fixed strings: nothing from Revolut, no URLs, no tokens.
 */
import {
  RevolutApiError,
  RevolutAuthError,
  RevolutBudgetExhaustedError,
  RevolutRateLimitedError,
  RevolutWriteAuthRetryRefused,
  type RevolutResponse,
} from "@camelthorn/revolut";

export type WireError =
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "budget"; jobId: string }
  | { kind: "auth"; code: string }
  | { kind: "write_auth_retry_refused" }
  | { kind: "api"; status: number; code?: string };

export type GateResult = { ok: true; response: RevolutResponse } | { ok: false; error: WireError };

export function toWire(e: unknown): WireError {
  if (e instanceof RevolutRateLimitedError)
    return { kind: "rate_limited", retryAfterMs: e.retryAfterMs };
  if (e instanceof RevolutBudgetExhaustedError) return { kind: "budget", jobId: e.jobId };
  if (e instanceof RevolutWriteAuthRetryRefused) return { kind: "write_auth_retry_refused" };
  if (e instanceof RevolutAuthError) return { kind: "auth", code: e.message };
  if (e instanceof RevolutApiError) {
    return { kind: "api", status: e.status, ...(e.code !== undefined ? { code: e.code } : {}) };
  }
  // Unknown failure (for example the DO was reset mid-queue): retryable, no details.
  return { kind: "api", status: 503, code: "gate_unavailable" };
}

export function fromWire(w: WireError): Error {
  switch (w.kind) {
    case "rate_limited":
      return new RevolutRateLimitedError(
        Number.isFinite(w.retryAfterMs) && w.retryAfterMs > 0 ? Math.ceil(w.retryAfterMs) : 1000,
      );
    case "budget":
      return new RevolutBudgetExhaustedError(w.jobId);
    case "write_auth_retry_refused":
      return new RevolutWriteAuthRetryRefused();
    case "auth":
      return new RevolutAuthError(w.code);
    case "api":
      return new RevolutApiError(w.status, "revolut api error", w.code);
  }
}

export function unwrap(r: GateResult): RevolutResponse {
  if (r.ok) return r.response;
  throw fromWire(r.error);
}
