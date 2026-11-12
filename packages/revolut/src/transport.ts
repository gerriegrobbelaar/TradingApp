// The interface between the Revolut client (this package) and the RevolutGate Durable Object
// (apps/worker). One copy, here; the worker imports it from `@camelthorn/revolut`.

import { JOB_ID_RE } from "@camelthorn/core";

/** One definition, in @camelthorn/core (job-id.ts); re-exported for existing importers. */
export { JOB_ID_RE };

export type RevolutPriority = "user" | "job";

export interface RevolutRequest {
  method: "GET" | "POST" | "DELETE" | "PATCH";
  /** No host, no /api/1.0 prefix, e.g. '/accounts' or '/transactions'. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  connectionId: number;
  priority: RevolutPriority;
  jobId: string;
  /** Default '1.0'; webhooks use '2.0'. */
  apiVersion?: "1.0" | "2.0";
}

export interface RevolutResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type RevolutTransport = (req: RevolutRequest) => Promise<RevolutResponse>;

/** Revolut answered 429, or the local limiter would have to wait too long. Retryable. */
export class RevolutRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = "revolut rate limited") {
    super(message);
    this.name = "RevolutRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Not connected, or the connection needs re-authorisation. Not retryable without a person. */
export class RevolutAuthError extends Error {
  constructor(message = "revolut authorisation failed") {
    super(message);
    this.name = "RevolutAuthError";
  }
}

/** Invalid request or an unexpected failure talking to Revolut. */
export class RevolutApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "RevolutApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

/** A job asked for more Revolut calls than its per-run budget. */
export class RevolutBudgetExhaustedError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`revolut call budget exhausted for job ${jobId}`);
    this.name = "RevolutBudgetExhaustedError";
    this.jobId = jobId;
  }
}

/**
 * A WRITE got a 401. The gate healed the token and did NOT re-send the write (ADR 0048, invariant
 * 2). It is a RevolutApiError (503, code `write_auth_retry_refused`) so every existing caller keeps
 * working, but it has its own wire kind: unlike `gate_unavailable` (the gate was reset, nothing is
 * known), here Revolut ANSWERED, and refused the credentials. Callers that may repeat the write
 * (webhook create, idempotent DELETEs) repeat it once; a payment never does (it first reads the
 * outcome by its `request_id`).
 */
export const WRITE_AUTH_RETRY_REFUSED_CODE = "write_auth_retry_refused";
export class RevolutWriteAuthRetryRefused extends RevolutApiError {
  constructor(message = "write not re-sent after 401") {
    super(503, message, WRITE_AUTH_RETRY_REFUSED_CODE);
    this.name = "RevolutWriteAuthRetryRefused";
  }
}
