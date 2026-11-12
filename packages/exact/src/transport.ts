// The interface between the Exact client (this package) and the ExactGate Durable Object
// (apps/worker). There is a single copy, here; the worker imports it from `@camelthorn/exact`.
// (E1 and E2 were built on separate branches against an identical copy; that is no longer true.)

import { JOB_ID_RE } from "@camelthorn/core";

/** One definition, in @camelthorn/core (job-id.ts); re-exported for existing importers. */
export { JOB_ID_RE };

export type ExactPriority = "user" | "job";

export interface ExactRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** No host, no /api/v1, no division. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  /** 0 means "current division" (only for the /current/Me call). */
  division: number;
  priority: ExactPriority;
  jobId: string;
  api: "rest" | "xml";
}

export interface ExactResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type ExactTransport = (req: ExactRequest) => Promise<ExactResponse>;

/** Exact answered 429, or the local limiter would have to wait too long. Retryable. */
export class ExactRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = "exact rate limited") {
    super(message);
    this.name = "ExactRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** A job asked for more Exact calls than its per-run budget. */
export class ExactBudgetExhaustedError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`exact call budget exhausted for job ${jobId}`);
    this.name = "ExactBudgetExhaustedError";
    this.jobId = jobId;
  }
}

/** Not connected, or the connection needs re-authorisation. Not retryable without a person. */
export class ExactAuthError extends Error {
  constructor(message = "exact authorisation failed") {
    super(message);
    this.name = "ExactAuthError";
  }
}

/**
 * A WRITE (POST) got a 401. The gate refreshed the token but never re-sends a POST on its own: the
 * outcome is unknown, so the booker must re-probe (read) before it may post again (M7c, ADR 0044).
 */
export class ExactWriteAuthRetryRefused extends Error {
  constructor(message = "exact write got 401; not re-sent automatically") {
    super(message);
    this.name = "ExactWriteAuthRetryRefused";
  }
}

/** Invalid request or an unexpected failure talking to Exact. */
export class ExactApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ExactApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}
