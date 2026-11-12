/**
 * One place that decides, for every failure on the Revolut path (gate, client, ingest), whether a
 * retry can help and which short machine code is stored. Codes only: never a message, URL or body.
 */
import {
  RevolutApiError,
  RevolutAuthError,
  RevolutBudgetExhaustedError,
  RevolutRateLimitedError,
  WRITE_AUTH_RETRY_REFUSED_CODE,
} from "@camelthorn/revolut";
import { IngestError } from "./ingest";

export interface Classified {
  /** A retry later can succeed (rate limit, gate or network trouble, token refresh outage). */
  retryable: boolean;
  /** Short snake_case code for storage. */
  code: string;
  /** How long to wait before the retry, in seconds. */
  delaySeconds: number;
}

const CODE_RE = /^[a-z][a-z0-9_]{0,40}$/;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function classifyRevolutError(e: unknown): Classified {
  if (e instanceof RevolutRateLimitedError) {
    return {
      retryable: true,
      code: "rate_limited",
      delaySeconds: clamp(Math.ceil(e.retryAfterMs / 1000), 30, 900),
    };
  }
  if (e instanceof RevolutBudgetExhaustedError) {
    return { retryable: true, code: "budget_exhausted", delaySeconds: 120 };
  }
  if (e instanceof RevolutAuthError) {
    const code = CODE_RE.test(e.message) ? e.message : "auth_failed";
    return { retryable: false, code, delaySeconds: 0 };
  }
  if (e instanceof RevolutApiError) {
    if (e.status >= 500) {
      const code = e.code !== undefined && CODE_RE.test(e.code) ? e.code : `api_${e.status}`;
      return { retryable: true, code, delaySeconds: 60 };
    }
    if (e.status === 404) return { retryable: false, code: "not_found", delaySeconds: 0 };
    if (e.status === 200) {
      // Parsed fine at HTTP level but not usable: bad JSON/shape or paging that cannot advance.
      const paging = e.code?.startsWith("PAGING_") === true;
      return { retryable: false, code: paging ? "paging_error" : "bad_shape", delaySeconds: 0 };
    }
    return { retryable: false, code: `api_${e.status}`, delaySeconds: 0 };
  }
  if (e instanceof IngestError) return { retryable: false, code: e.code, delaySeconds: 0 };
  if (e instanceof RangeError) return { retryable: false, code: "bad_request", delaySeconds: 0 };
  // Anything else (a D1 hiccup, a bug): retry a bounded number of times, then give up.
  return { retryable: true, code: "internal", delaySeconds: 60 };
}

/** The gate's answer to a write that got a 401: not re-sent, token healed (ADR 0048). */
export const WRITE_AUTH_RETRY_REFUSED = WRITE_AUTH_RETRY_REFUSED_CODE;

/**
 * Runs a Revolut write and, if the gate refused to re-send it after a 401, runs it ONCE more.
 * The gate never decides that a write may go twice; the caller does, per write: only for a write
 * that is safe to repeat with the same request (a 401 means Revolut refused the bearer token and
 * did nothing; DELETE is idempotent; a payment repeats only with its own unchanged `request_id`).
 * A second refusal is returned to the caller as is (no loop).
 */
export async function retryWriteOnceAfterAuthRefusal<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof RevolutApiError && e.code === WRITE_AUTH_RETRY_REFUSED) return write();
    throw e;
  }
}
