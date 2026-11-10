/**
 * The seam between the typed Exact client (this package) and the worker's `ExactGate`
 * Durable Object (apps/worker). The client only ever talks to an `ExactTransport`; the gate
 * owns tokens, rate limiting, queueing, and budget accounting.
 *
 * URL convention (the transport builds the real URL):
 *  - api 'rest': `https://<host>/api/v1/<division>` + path. Example path:
 *    '/read/financial/ReceivablesList'.
 *  - division 0 means "current": no division segment is added. This is used for the single
 *    call that has none, `/current/Me`, which becomes `https://<host>/api/v1/current/Me`.
 *  - api 'xml': host root + path, e.g. '/docs/XMLUpload.aspx' with query { Topic: 'MatchSets' }.
 *    The transport adds `_Division_=<division>` to the query.
 *  - The transport adds the Authorization header; the client never sees tokens.
 */

export type ExactPriority = "user" | "job";

export interface ExactRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** e.g. '/read/financial/ReceivablesList'. No division, no host, no /api/v1 prefix. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  /** Exact division number; 0 means "current" (only for '/current/Me'). */
  division: number;
  priority: ExactPriority;
  /** For budget accounting in the gate. */
  jobId: string;
  api: "rest" | "xml";
}

export interface ExactResponse {
  status: number;
  /** Header names may arrive in any case; the client lower-cases before lookup. */
  headers: Record<string, string>;
  body: string;
}

export type ExactTransport = (req: ExactRequest) => Promise<ExactResponse>;

/** Thrown when Exact (or the gate) says wait. The gate owns timing, so the client never retries. */
export class ExactRateLimitedError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "ExactRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** The job's Exact call budget is spent. */
export class ExactBudgetExhaustedError extends Error {
  jobId: string;
  constructor(message: string, jobId: string) {
    super(message);
    this.name = "ExactBudgetExhaustedError";
    this.jobId = jobId;
  }
}

/** The connection must be re-authorised by a person. */
export class ExactAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExactAuthError";
  }
}

export class ExactApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ExactApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}
