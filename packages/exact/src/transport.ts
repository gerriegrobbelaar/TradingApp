// Fixed interface shared by the Exact client (packages/exact, owned by task E1) and the
// ExactGate Durable Object (apps/worker, task E2). Keep this file identical in both branches.
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
