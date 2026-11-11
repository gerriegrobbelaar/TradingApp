import { JOB_ID_RE } from "./transport";
import {
  RevolutApiError,
  RevolutAuthError,
  RevolutRateLimitedError,
  type RevolutPriority,
  type RevolutRequest,
  type RevolutResponse,
  type RevolutTransport,
} from "./transport";
import { arrField, asRow, badData, parseJsonRawNumbers, reqStr, strField } from "./json";
import {
  mapAccount,
  mapBankDetails,
  mapCounterpartyRecord,
  mapTransaction,
  mapWebhook,
  type RevolutAccount,
  type RevolutBankDetails,
  type RevolutCounterpartyRecord,
  type RevolutCreatedWebhook,
  type RevolutTransaction,
  type RevolutWebhook,
} from "./models";
import { sanitizeForMessage } from "./redact";

export interface RevolutClientOptions {
  connectionId: number;
  jobId: string;
  priority: RevolutPriority;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Revolut allows at most 1000 rows per /transactions call. */
export const MAX_TRANSACTIONS_PER_CALL = 1000;
const RETRY_BACKOFF_MS = [500, 2000] as const;
const DEFAULT_RETRY_AFTER_MS = 60_000;
export const DEFAULT_WEBHOOK_EVENTS = ["TransactionCreated", "TransactionStateChanged"] as const;

// ---- timestamps and paging helpers ----------------------------------------------------------

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

interface Stamp {
  /** Epoch milliseconds, truncated (never rounded) to the millisecond. */
  ms: number;
  /** Microseconds within that millisecond, 0..999. */
  micro: number;
}

/**
 * Revolut timestamps may carry more than millisecond precision. Truncate to ms and keep the
 * remaining micros so ordering stays exact.
 */
function parseStamp(raw: string): Stamp {
  const m = TS_RE.exec(raw);
  if (!m) throw badData("Unexpected timestamp from Revolut", "BAD_SHAPE");
  const frac = (m[2] ?? "").padEnd(6, "0");
  const ms = Date.parse(`${m[1] ?? ""}.${frac.slice(0, 3)}${m[3] ?? ""}`);
  if (Number.isNaN(ms)) throw badData("Unexpected timestamp from Revolut", "BAD_SHAPE");
  return { ms, micro: Number(frac.slice(3, 6)) };
}

/** Newest first; ties broken by id so the order is total and stable. */
function compareNewestFirst(a: { stamp: Stamp; id: string }, b: { stamp: Stamp; id: string }) {
  if (a.stamp.ms !== b.stamp.ms) return b.stamp.ms - a.stamp.ms;
  if (a.stamp.micro !== b.stamp.micro) return b.stamp.micro - a.stamp.micro;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Opaque position in a newest-first walk over /transactions. `toIso` is the inclusive upper
 * bound for the next request; `seen` are the ids (with their ms) already returned whose
 * timestamp is not older than the boundary millisecond and can therefore come back.
 */
export interface TransactionCursor {
  toIso: string;
  seen: { id: string; ms: number }[];
}

export interface ListTransactionsOptions {
  /** ISO date-time, inclusive lower bound on created_at. */
  from?: string;
  /** ISO date-time, inclusive upper bound on created_at (ignored when a cursor is given). */
  to?: string;
  accountId?: string;
  type?: string;
  /** Rows wanted per chunk, 1..1000. */
  count: number;
  cursor?: TransactionCursor | null;
}

export interface TransactionChunk {
  /** Newest first, no id repeated within or across chunks of one walk. */
  transactions: RevolutTransaction[];
  /** null when the walk is complete. */
  nextCursor: TransactionCursor | null;
}

export interface RevolutClient {
  listAccounts(): Promise<RevolutAccount[]>;
  getAccountBankDetails(accountId: string): Promise<RevolutBankDetails[]>;
  listTransactionsChunk(opts: ListTransactionsOptions): Promise<TransactionChunk>;
  /** Walk every chunk until the cursor is null (bounded by `maxChunks`). */
  transactionChunks(
    opts: Omit<ListTransactionsOptions, "cursor">,
    maxChunks?: number,
  ): AsyncGenerator<RevolutTransaction[], void, undefined>;
  getTransaction(id: string, idType?: "id" | "request_id"): Promise<RevolutTransaction>;
  listCounterparties(): Promise<RevolutCounterpartyRecord[]>;
  listWebhooks(): Promise<RevolutWebhook[]>;
  createWebhook(url: string, events?: readonly string[]): Promise<RevolutCreatedWebhook>;
  deleteWebhook(id: string): Promise<void>;
}

function retryAfterMs(headers: Record<string, string>, nowMs: number): number {
  let v: string | undefined;
  for (const [k, val] of Object.entries(headers)) if (k.toLowerCase() === "retry-after") v = val;
  if (v === undefined) return DEFAULT_RETRY_AFTER_MS;
  const t = v.trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const date = Date.parse(t);
  return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - nowMs);
}

function errorDetail(body: string): { message: string; code?: string } {
  try {
    const row = asRow(parseJsonRawNumbers(body));
    const message = strField(row, "message");
    const code = strField(row, "code");
    const out: { message: string; code?: string } = {
      message: sanitizeForMessage(message ?? "no message"),
    };
    if (code !== null && /^[\w.-]{1,40}$/.test(code)) out.code = code;
    return out;
  } catch {
    return { message: sanitizeForMessage(body.slice(0, 200)) };
  }
}

function assertIsoDateTime(v: string, name: string): void {
  if (Number.isNaN(Date.parse(v))) throw new RangeError(`${name} must be an ISO date-time`);
}

export function createRevolutClient(
  transport: RevolutTransport,
  options: RevolutClientOptions,
): RevolutClient {
  if (!Number.isSafeInteger(options.connectionId) || options.connectionId < 1) {
    throw new RangeError("connectionId must be a positive integer");
  }
  if (!JOB_ID_RE.test(options.jobId)) throw new RangeError("jobId is required and must be plain");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  /**
   * One transport call with the client's rules:
   *  - errors thrown by the transport (gate) pass through, never retried here;
   *  - 5xx: GET only, up to 2 retries with backoff; never for POST/DELETE/PATCH;
   *  - 401: RevolutAuthError; 429: RevolutRateLimitedError.
   */
  async function send(req: Omit<RevolutRequest, "connectionId" | "priority" | "jobId">) {
    const full: RevolutRequest = {
      ...req,
      connectionId: options.connectionId,
      priority: options.priority,
      jobId: options.jobId,
    };
    for (let attempt = 0; ; attempt++) {
      const res: RevolutResponse = await transport(full);
      if (res.status >= 200 && res.status < 300) return res;
      if (res.status >= 500 && req.method === "GET" && attempt < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[attempt] ?? 1000);
        continue;
      }
      if (res.status === 401) {
        throw new RevolutAuthError(
          "Revolut rejected the access token; the connection must be re-authorised",
        );
      }
      if (res.status === 429) {
        throw new RevolutRateLimitedError(
          retryAfterMs(res.headers, now()),
          "Revolut rate limit reached",
        );
      }
      const detail = errorDetail(res.body);
      throw new RevolutApiError(
        res.status,
        `Revolut API error ${res.status} on ${req.path}: ${detail.message}`,
        detail.code,
      );
    }
  }

  const get = (path: string, query?: Record<string, string>, apiVersion?: "1.0" | "2.0") =>
    send({
      method: "GET",
      path,
      ...(query ? { query } : {}),
      headers: { Accept: "application/json" },
      ...(apiVersion ? { apiVersion } : {}),
    });

  function rows(res: RevolutResponse, wrapperKey?: string): unknown[] {
    const parsed = parseJsonRawNumbers(res.body);
    if (Array.isArray(parsed)) return parsed;
    if (wrapperKey !== undefined) return arrField(asRow(parsed), wrapperKey);
    throw badData("Expected a list from Revolut", "BAD_SHAPE");
  }

  async function listTransactionsChunk(opts: ListTransactionsOptions): Promise<TransactionChunk> {
    if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > MAX_TRANSACTIONS_PER_CALL) {
      throw new RangeError("count must be an integer between 1 and 1000");
    }
    if (opts.from !== undefined) assertIsoDateTime(opts.from, "from");
    if (opts.to !== undefined) assertIsoDateTime(opts.to, "to");
    const cursor = opts.cursor ?? null;
    const seenIds = new Set((cursor?.seen ?? []).map((s) => s.id));
    // Ask for enough extra rows to cover the already-seen ones that can come back at the boundary.
    const requested = Math.min(MAX_TRANSACTIONS_PER_CALL, opts.count + seenIds.size);
    const toIso = cursor?.toIso ?? opts.to;
    const toMs = toIso === undefined ? Number.POSITIVE_INFINITY : parseStamp(toIso).ms;

    const query: Record<string, string> = { count: String(requested) };
    if (opts.from !== undefined) query["from"] = opts.from;
    if (toIso !== undefined) query["to"] = toIso;
    if (opts.accountId !== undefined) query["account"] = opts.accountId;
    if (opts.type !== undefined) query["type"] = opts.type;

    const raw = rows(await get("/transactions", query));
    const exhausted = raw.length < requested;

    interface Entry {
      tx: RevolutTransaction;
      stamp: Stamp;
      id: string;
    }
    const inWindow: Entry[] = [];
    for (const r of raw) {
      const tx = mapTransaction(r);
      const stamp = parseStamp(tx.createdAt);
      if (stamp.ms > toMs) continue; // outside the requested window: ignore
      inWindow.push({ tx, stamp, id: tx.id });
    }
    inWindow.sort(compareNewestFirst);

    const fresh: Entry[] = [];
    const inResponse = new Set<string>();
    for (const e of inWindow) {
      if (inResponse.has(e.id)) continue;
      inResponse.add(e.id);
      if (!seenIds.has(e.id)) fresh.push(e);
    }
    if (fresh.length === 0) {
      if (exhausted) return { transactions: [], nextCursor: null };
      // A full page made only of rows already returned: more rows share one millisecond than a
      // call can carry. Failing loudly beats skipping rows.
      throw new RevolutApiError(
        200,
        "Transaction paging cannot advance (too many rows in one millisecond)",
        "PAGING_STUCK",
      );
    }
    const result = fresh.map((e) => e.tx);
    if (exhausted) return { transactions: result, nextCursor: null };

    const oldest = inWindow[inWindow.length - 1];
    /* c8 ignore next */
    if (oldest === undefined) return { transactions: result, nextCursor: null };
    // Inclusive bound that still covers the oldest row's whole millisecond (micros included).
    const nextToMs = oldest.stamp.ms + (oldest.stamp.micro > 0 ? 1 : 0);
    const nextSeen = new Map<string, number>();
    for (const s of cursor?.seen ?? []) nextSeen.set(s.id, s.ms);
    for (const e of fresh) nextSeen.set(e.id, e.stamp.ms);
    const keep: { id: string; ms: number }[] = [];
    for (const [id, ms] of nextSeen) if (ms >= oldest.stamp.ms) keep.push({ id, ms });
    return {
      transactions: result,
      nextCursor: { toIso: new Date(nextToMs).toISOString(), seen: keep },
    };
  }

  async function* transactionChunks(
    opts: Omit<ListTransactionsOptions, "cursor">,
    maxChunks = 1000,
  ): AsyncGenerator<RevolutTransaction[], void, undefined> {
    let cursor: TransactionCursor | null = null;
    for (let i = 0; i < maxChunks; i++) {
      const chunk: TransactionChunk = await listTransactionsChunk({ ...opts, cursor });
      if (chunk.transactions.length > 0) yield chunk.transactions;
      if (chunk.nextCursor === null) return;
      cursor = chunk.nextCursor;
    }
    throw new RevolutApiError(200, "Transaction paging exceeded the chunk limit", "PAGING_LIMIT");
  }

  return {
    async listAccounts() {
      return rows(await get("/accounts")).map(mapAccount);
    },

    async getAccountBankDetails(accountId) {
      if (accountId === "") throw new RangeError("accountId is required");
      const res = await get(`/accounts/${encodeURIComponent(accountId)}/bank-details`);
      return rows(res).map(mapBankDetails);
    },

    listTransactionsChunk,
    transactionChunks,

    async getTransaction(id, idType = "id") {
      if (id === "") throw new RangeError("id is required");
      const query = idType === "request_id" ? { id_type: "request_id" } : undefined;
      const res = await get(`/transaction/${encodeURIComponent(id)}`, query);
      return mapTransaction(parseJsonRawNumbers(res.body));
    },

    async listCounterparties() {
      // Newest first with `created_before`; paged like transactions: the bound is moved to the
      // end of the oldest row's millisecond and ids are de-duplicated (see ADR).
      const out: RevolutCounterpartyRecord[] = [];
      const seen = new Set<string>();
      let before: string | undefined;
      for (let page = 0; page < 200; page++) {
        const query: Record<string, string> = { count: String(MAX_TRANSACTIONS_PER_CALL) };
        if (before !== undefined) query["created_before"] = before;
        const list = rows(await get("/counterparties", query)).map(mapCounterpartyRecord);
        let added = 0;
        for (const c of list) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            out.push(c);
            added++;
          }
        }
        if (list.length < MAX_TRANSACTIONS_PER_CALL) return out;
        if (added === 0) {
          throw new RevolutApiError(200, "Counterparty paging cannot advance", "PAGING_STUCK");
        }
        const stamps = list
          .map((c) => (c.createdAt === undefined ? null : parseStamp(c.createdAt)))
          .filter((s): s is Stamp => s !== null);
        const oldest = stamps.reduce<Stamp | null>(
          (a, s) => (a === null || s.ms < a.ms ? s : a),
          null,
        );
        if (oldest === null) {
          throw new RevolutApiError(200, "Counterparty paging needs created_at", "PAGING_STUCK");
        }
        before = new Date(oldest.ms + 1).toISOString();
      }
      throw new RevolutApiError(200, "Counterparty paging exceeded the page limit", "PAGING_LIMIT");
    },

    async listWebhooks() {
      return rows(await get("/webhooks", undefined, "2.0"), "webhooks").map(mapWebhook);
    },

    async createWebhook(url, events = DEFAULT_WEBHOOK_EVENTS) {
      if (!/^https:\/\/[^\s]+$/.test(url)) throw new RangeError("webhook url must be https");
      if (events.length === 0) throw new RangeError("at least one event is required");
      const res = await send({
        method: "POST",
        path: "/webhooks",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ url, events }),
        apiVersion: "2.0",
      });
      const row = asRow(parseJsonRawNumbers(res.body));
      return { ...mapWebhook(row), signingSecret: reqStr(row, "signing_secret") };
    },

    async deleteWebhook(id) {
      if (id === "") throw new RangeError("id is required");
      await send({
        method: "DELETE",
        path: `/webhooks/${encodeURIComponent(id)}`,
        headers: { Accept: "application/json" },
        apiVersion: "2.0",
      });
    },
  };
}
