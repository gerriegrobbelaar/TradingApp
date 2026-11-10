/**
 * Errors do not survive a Durable Object RPC call with their class or fields, so the gate answers
 * with plain-data envelopes and the Worker side rebuilds the typed errors from `packages/exact`.
 * Messages are fixed strings: nothing from Exact, no URLs, no tokens.
 */
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  type ExactResponse,
} from "@camelthorn/exact";

export type WireError =
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "budget"; jobId: string }
  | { kind: "auth"; code: string }
  | { kind: "api"; status: number; code?: string };

export type GateResult = { ok: true; response: ExactResponse } | { ok: false; error: WireError };

export function toWire(e: unknown): WireError {
  if (e instanceof ExactRateLimitedError)
    return { kind: "rate_limited", retryAfterMs: e.retryAfterMs };
  if (e instanceof ExactBudgetExhaustedError) return { kind: "budget", jobId: e.jobId };
  if (e instanceof ExactAuthError) return { kind: "auth", code: e.message };
  if (e instanceof ExactApiError) {
    return { kind: "api", status: e.status, ...(e.code !== undefined ? { code: e.code } : {}) };
  }
  // Unknown failure (for example the DO was reset mid-queue): retryable, no details.
  return { kind: "api", status: 503, code: "gate_unavailable" };
}

export function fromWire(w: WireError): Error {
  switch (w.kind) {
    case "rate_limited":
      return new ExactRateLimitedError(
        Number.isFinite(w.retryAfterMs) && w.retryAfterMs > 0 ? Math.ceil(w.retryAfterMs) : 1000,
      );
    case "budget":
      return new ExactBudgetExhaustedError(w.jobId);
    case "auth":
      return new ExactAuthError(w.code);
    case "api":
      return new ExactApiError(w.status, "exact api error", w.code);
  }
}

export function unwrap(r: GateResult): ExactResponse {
  if (r.ok) return r.response;
  throw fromWire(r.error);
}
