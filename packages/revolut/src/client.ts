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

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A caller-supplied bound: "YYYY-MM-DD" (midnight UTC) or a full ISO date-time with zone. */
function parseBound(v: string, name: string): Stamp {
  const text = DATE_ONLY_RE.test(v) ? `${v}T00:00:00Z` : v;
  const m = TS_RE.exec(text);
  const ms = m ? Date.parse(text.replace(/\.(\d{3})\d*/, ".$1")) : Number.NaN;
  if (m === null || Number.isNaN(ms)) {
    throw new RangeError(`${name} must be YYYY-MM-DD or an ISO date-time with a zone`);
  }
  return parseStamp(text);
}

function microsOf(s: Stamp): number {
  return s.ms * 1000 + s.micro;
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

/** A cursor carries at most this many seen ids (more means paging could not advance anyway). */
const MAX_CURSOR_SEEN = 2 * 1000;

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
  /**
   * Treat a page with fewer rows than requested as the end of the walk. Default false: the walk
   * then ends only on a short page with no new rows, which costs one extra call per walk but
   * stays complete if Revolut caps `count` lower than documented or returns short pages early.
   * Switch on only after the sandbox confirmed the behaviour (ADR 0030).
   */
  trustShortPage?: boolean;
}

/**
 * A row of a page that could not be mapped (review S2). Only the transaction id (when the row had a
 * usable one) and a fixed lower-case code: never the payload, an IBAN, a name or an amount.
 */
export interface RejectedRow {
  id: string | null;
  code: string;
}

export interface TransactionChunk {
  /** Newest first, no id repeated within or across chunks of one walk. */
  transactions: RevolutTransaction[];
  /**
   * Rows of this page that did not map (a bad amount, a missing leg id, a zone-less timestamp).
   * They do not stop the page: the cursor moves by the raw page, so a bad row cannot stall a walk.
   */
  rejected: RejectedRow[];
  /** null when the walk is complete. */
  nextCursor: TransactionCursor | null;
}

export interface RevolutClient {
  listAccounts(): Promise<RevolutAccount[]>;
  getAccountBankDetails(accountId: string): Promise<RevolutBankDetails[]>;
  listTransactionsChunk(opts: ListTransactionsOptions): Promise<TransactionChunk>;
  /**
   * Walk every chunk until the cursor is null (bounded by `maxChunks`). Rejected rows are handed to
   * `onRejected` (when given) and otherwise dropped.
   */
  transactionChunks(
    opts: Omit<ListTransactionsOptions, "cursor">,
    maxChunks?: number,
    onRejected?: (rejected: RejectedRow[]) => void,
  ): AsyncGenerator<RevolutTransaction[], void, undefined>;
  getTransaction(id: string, idType?: "id" | "request_id"): Promise<RevolutTransaction>;
  /**
   * One counterparty by id (`GET /counterparty/{id}`). Its response carries names and IBANs: the
   * caller keeps them out of logs and responses; error messages are redacted here.
   */
  getCounterparty(id: string): Promise<RevolutCounterpartyRecord>;
  listCounterparties(): Promise<RevolutCounterpartyRecord[]>;
  listWebhooks(): Promise<RevolutWebhook[]>;
  createWebhook(url: string, events?: readonly string[]): Promise<RevolutCreatedWebhook>;
  deleteWebhook(id: string): Promise<void>;
}

/** Longest wait we pass on from Retry-After; longer values are capped (the gate re-checks). */
export const MAX_RETRY_AFTER_MS = 15 * 60_000;
/** IMF-fixdate, the only HTTP-date form servers should send (RFC 9110 5.6.7). */
const HTTP_DATE_RE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Retry-After as milliseconds: delta-seconds or an HTTP-date. Missing or garbage values (negative,
 * fractional, other date forms) give the 60 s default; the result is clamped to
 * [0, MAX_RETRY_AFTER_MS]. A date in the past gives 0.
 */
export function retryAfterMs(headers: Record<string, string>, nowMs: number): number {
  let v: string | undefined;
  for (const [k, val] of Object.entries(headers)) if (k.toLowerCase() === "retry-after") v = val;
  if (v === undefined) return DEFAULT_RETRY_AFTER_MS;
  const t = v.trim();
  let ms: number;
  if (/^\d{1,10}$/.test(t)) ms = Number(t) * 1000;
  else if (/^\d+$/.test(t)) ms = MAX_RETRY_AFTER_MS;
  else if (HTTP_DATE_RE.test(t) && !Number.isNaN(Date.parse(t))) ms = Date.parse(t) - nowMs;
  else return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

/**
 * The message for an error response: only the `message` field of a JSON body, redacted. A body
 * that is not JSON is never quoted (HTML error pages, and bodies that may hold secrets).
 */
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
    return { message: "non-JSON response body" };
  }
}

/** The raw id and creation time of a page row, for paging; null where unusable. */
function probeRow(r: unknown): { id: string | null; stamp: Stamp | null } {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return { id: null, stamp: null };
  const row = r as Record<string, unknown>;
  const id = typeof row["id"] === "string" && row["id"] !== "" ? row["id"] : null;
  let stamp: Stamp | null = null;
  const created = row["created_at"];
  if (typeof created === "string") {
    try {
      stamp = parseStamp(created);
    } catch {
      stamp = null;
    }
  }
  return { id, stamp };
}

/** A fixed code for a row that did not map; the error text is never used. */
function rejectCode(e: unknown): string {
  if (e instanceof RevolutApiError && e.code !== undefined && /^[A-Z][A-Z_]{1,30}$/.test(e.code)) {
    return e.code.toLowerCase();
  }
  return "bad_shape";
}

function assertCursor(c: TransactionCursor): void {
  if (
    typeof c !== "object" ||
    c === null ||
    typeof c.toIso !== "string" ||
    !Array.isArray(c.seen) ||
    c.seen.length > MAX_CURSOR_SEEN ||
    !c.seen.every((e) => typeof e?.id === "string" && e.id !== "" && Number.isSafeInteger(e.ms))
  ) {
    throw new RangeError("cursor is not a transaction cursor");
  }
  parseBound(c.toIso, "cursor.toIso");
}

function laterUpdate(a: RevolutTransaction, b: RevolutTransaction): RevolutTransaction {
  const ta = a.updatedAt === undefined ? Number.NaN : Date.parse(a.updatedAt);
  const tb = b.updatedAt === undefined ? Number.NaN : Date.parse(b.updatedAt);
  return tb > ta ? b : a;
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

  /**
   * One chunk of a newest-first walk over /transactions. Completeness argument (ADR 0030):
   * Revolut returns the newest `requested` rows with created_at <= `to`, newest first. Every row
   * strictly newer than the page's oldest row is therefore in this page or an earlier one. The
   * next bound is one millisecond past the oldest row (capped at the current bound), so the rows
   * that share the oldest row's timestamp come back whether `to` is inclusive or exclusive and
   * whatever their sub-millisecond part; the ones already returned are recognised by id (`seen`)
   * and `requested` grows by their number. A full page with no new row means more rows share
   * those two milliseconds than one call can carry: PAGING_STUCK, never a silent skip. A page
   * that is not newest first is PAGING_ORDER.
   *
   * Not a snapshot: a row returned again later (at the boundary) with a newer state is dropped
   * as already seen; within one response the row with the later `updated_at` wins. Consumers
   * upsert by (transaction id, leg id) keeping the newest `updated_at`, and webhooks plus the next
   * run deliver state changes. Rows created after a walk started (above its first page) are
   * picked up by the next walk.
   */
  async function listTransactionsChunk(opts: ListTransactionsOptions): Promise<TransactionChunk> {
    if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > MAX_TRANSACTIONS_PER_CALL) {
      throw new RangeError("count must be an integer between 1 and 1000");
    }
    const fromStamp = opts.from === undefined ? undefined : parseBound(opts.from, "from");
    const userTo = opts.to === undefined ? undefined : parseBound(opts.to, "to");
    if (fromStamp !== undefined && userTo !== undefined && microsOf(fromStamp) > microsOf(userTo)) {
      throw new RangeError("from must not be after to");
    }
    const cursor = opts.cursor ?? null;
    if (cursor !== null) assertCursor(cursor);
    const seenIds = new Set((cursor?.seen ?? []).map((s) => s.id));
    // Ask for enough extra rows to cover the already-seen ones that can come back at the boundary.
    const requested = Math.min(MAX_TRANSACTIONS_PER_CALL, opts.count + seenIds.size);
    const toIso = cursor?.toIso ?? opts.to;
    const toStamp = toIso === undefined ? undefined : parseBound(toIso, "to");
    const toMicros = toStamp === undefined ? Number.POSITIVE_INFINITY : microsOf(toStamp);

    const query: Record<string, string> = { count: String(requested) };
    if (opts.from !== undefined) query["from"] = opts.from;
    if (toIso !== undefined) query["to"] = toIso;
    if (opts.accountId !== undefined) query["account"] = opts.accountId;
    if (opts.type !== undefined) query["type"] = opts.type;

    const raw = rows(await get("/transactions", query));
    const short = raw.length < requested;

    interface Entry {
      /** null: the row did not map (it still takes part in paging by its raw id and timestamp). */
      tx: RevolutTransaction | null;
      code: string;
      stamp: Stamp;
      id: string;
    }
    const byId = new Map<string, Entry>();
    const unplaced: RejectedRow[] = [];
    let previous = Number.POSITIVE_INFINITY;
    for (const r of raw) {
      // Each row is judged alone (review S2): paging uses the RAW id and created_at, so a row that
      // does not map can neither stall the walk nor hide its neighbours.
      const probe = probeRow(r);
      let tx: RevolutTransaction | null = null;
      let code = "";
      try {
        tx = mapTransaction(r);
      } catch (e) {
        code = rejectCode(e);
      }
      if (probe.id === null || probe.stamp === null) {
        // Not placeable in the order: reported, and left out of the paging arithmetic.
        unplaced.push({ id: probe.id, code: tx === null ? code : "bad_timestamp" });
        continue;
      }
      if (tx !== null && tx.id !== probe.id) tx = null;
      const stamp = probe.stamp;
      const at = microsOf(stamp);
      if (at > previous) {
        throw new RevolutApiError(
          200,
          "Revolut returned transactions out of order",
          "PAGING_ORDER",
        );
      }
      previous = at;
      if (at > toMicros) continue; // outside the requested window: ignore
      const known = byId.get(probe.id);
      const entry: Entry = {
        tx,
        code: tx === null ? code || "bad_shape" : "",
        stamp,
        id: probe.id,
      };
      if (known === undefined) byId.set(probe.id, entry);
      else if (known.tx === null) byId.set(probe.id, { ...entry, stamp: known.stamp });
      else if (tx !== null) byId.set(probe.id, { ...known, tx: laterUpdate(known.tx, tx) });
    }
    const inWindow = [...byId.values()].sort(compareNewestFirst);
    const fresh = inWindow.filter((e) => !seenIds.has(e.id));
    const rejected: RejectedRow[] = [
      ...fresh.filter((e) => e.tx === null).map((e) => ({ id: e.id, code: e.code })),
      ...unplaced,
    ];
    if (fresh.length === 0) {
      if (short) return { transactions: [], rejected, nextCursor: null };
      // A full page made only of rows already returned: more rows share the boundary than a
      // call can carry. Failing loudly beats skipping rows.
      throw new RevolutApiError(
        200,
        "Transaction paging cannot advance (too many rows in one millisecond)",
        "PAGING_STUCK",
      );
    }
    const result = fresh.flatMap((e) => (e.tx === null ? [] : [e.tx]));
    if (short && opts.trustShortPage === true) {
      return { transactions: result, rejected, nextCursor: null };
    }

    const oldest = inWindow[inWindow.length - 1];
    /* c8 ignore next */
    if (oldest === undefined) return { transactions: result, rejected, nextCursor: null };
    // One millisecond past the oldest row, never above the current bound.
    const candidateMs = oldest.stamp.ms + 1;
    const capped = toStamp !== undefined && candidateMs * 1000 > toMicros;
    const nextToIso = capped && toIso !== undefined ? toIso : new Date(candidateMs).toISOString();
    const nextToMs = capped && toStamp !== undefined ? toStamp.ms : candidateMs;
    const nextSeen = new Map<string, number>();
    for (const s of cursor?.seen ?? []) nextSeen.set(s.id, s.ms);
    for (const e of fresh) nextSeen.set(e.id, e.stamp.ms);
    // Only rows at or below the next bound can come back.
    const keep: { id: string; ms: number }[] = [];
    for (const [id, ms] of nextSeen) if (ms <= nextToMs) keep.push({ id, ms });
    return { transactions: result, rejected, nextCursor: { toIso: nextToIso, seen: keep } };
  }

  async function* transactionChunks(
    opts: Omit<ListTransactionsOptions, "cursor">,
    maxChunks = 1000,
    onRejected?: (rejected: RejectedRow[]) => void,
  ): AsyncGenerator<RevolutTransaction[], void, undefined> {
    if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 100_000) {
      throw new RangeError("maxChunks must be an integer between 1 and 100000");
    }
    let cursor: TransactionCursor | null = null;
    for (let i = 0; i < maxChunks; i++) {
      const chunk: TransactionChunk = await listTransactionsChunk({ ...opts, cursor });
      if (chunk.rejected.length > 0) onRejected?.(chunk.rejected);
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

    async getCounterparty(id) {
      if (id === "") throw new RangeError("id is required");
      const res = await get(`/counterparty/${encodeURIComponent(id)}`);
      return mapCounterpartyRecord(parseJsonRawNumbers(res.body));
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
      // The body holds the signing secret: any failure here gets a fixed message, never the body.
      try {
        const row = asRow(parseJsonRawNumbers(res.body));
        const signingSecret = reqStr(row, "signing_secret");
        return { ...mapWebhook(row), signingSecret };
      } catch {
        throw badData("Revolut returned an unusable webhook response", "BAD_WEBHOOK_RESPONSE");
      }
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
