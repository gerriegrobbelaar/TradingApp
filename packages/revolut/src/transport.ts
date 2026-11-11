// STUB created by task R2 against the fixed interface agreed with task R1. R1 owns this file;
// take R1's version on merge (names and shapes are identical).

export type RevolutPriority = "user" | "job";

export interface RevolutRequest {
  method: "GET" | "POST" | "DELETE" | "PATCH";
  /** No host and no /api/<version> prefix. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  connectionId: number;
  priority: RevolutPriority;
  jobId: string;
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
  constructor(
    public retryAfterMs: number,
    message = "revolut rate limited",
  ) {
    super(message);
    this.name = "RevolutRateLimitedError";
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
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "RevolutApiError";
  }
}

/** A job asked for more Revolut calls than its per-run budget. */
export class RevolutBudgetExhaustedError extends Error {
  constructor(public jobId: string) {
    super(`revolut call budget exhausted for job ${jobId}`);
    this.name = "RevolutBudgetExhaustedError";
  }
}
