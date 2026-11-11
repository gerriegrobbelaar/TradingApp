// The interface between the Revolut client (this package) and the RevolutGate Durable Object
// (apps/worker). One copy, here; the worker imports it from `@camelthorn/revolut`.

/** Job ids are short and plain: they key budgets in the gate and appear in logs. */
export const JOB_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

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
