import { type Money, money } from "@camelthorn/core";
import {
  type Row,
  asRow,
  badData,
  bigField,
  boolField,
  dateField,
  intField,
  isGuid,
  minorField,
  parseJsonRawNumbers,
  reqGuid,
  strField,
  trimField,
} from "./json";
import { lowerCaseHeaders, retryAfterFromHeaders } from "./rate-limit";
import { sanitizeForMessage } from "./redact";
import {
  ExactApiError,
  ExactAuthError,
  ExactRateLimitedError,
  type ExactPriority,
  type ExactRequest,
  type ExactResponse,
  type ExactTransport,
} from "./transport";
import { buildXmlEnvelope, parseXmlResponse, type XmlUploadResult } from "./xml";

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export interface ExactClientOptions {
  /** Exact division number. All calls except `currentMe()` carry it. */
  division: number;
  /** Budget accounting key passed to the gate. */
  jobId: string;
  priority: ExactPriority;
  /** Host that `__next` links must point to. Default: the Dutch instance. */
  host?: string;
  /** Max pages followed per read (positive integer). Default 200. */
  maxPages?: number;
  /** Injected so tests (and the worker) control backoff. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock (epoch ms), used to turn X-RateLimit-*-Reset into a wait. */
  now?: () => number;
  /**
   * The division's own (default) currency, ISO 4217. Sets the minor-unit scale of `...DC`
   * amounts (`OpenItem.amountDc`). Default EUR (a Dutch division).
   */
  divisionCurrency?: string;
}

export const DEFAULT_EXACT_HOST = "start.exactonline.nl";
const DEFAULT_MAX_PAGES = 200;
const RETRY_BACKOFF_MS = [500, 1500] as const;

// ---------------------------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------------------------

export interface CurrentMe {
  userId: string;
  userName: string | null;
  fullName: string | null;
  email: string | null;
  /** The division the user last used; the default for `createExactClient`. */
  currentDivision: number;
}

export interface Division {
  code: number;
  description: string | null;
  country: string | null;
  status: number | null;
  main: boolean;
}

export interface ExactAccount {
  id: string;
  code: string | null;
  name: string;
  email: string | null;
  vatNumber: string | null;
  /** ISO 3166 alpha-2 */
  country: string | null;
  isSupplier: boolean;
  isSales: boolean;
  status: string | null;
  /** Present on sync reads only (digit string, 64-bit). */
  timestamp: string | null;
}

export interface ExactBankAccount {
  id: string;
  accountId: string;
  /** Upper case, no spaces. Never log or put in error messages in full. */
  iban: string | null;
  bic: string | null;
  bankName: string | null;
  main: boolean;
}

export type OpenItemKind = "receivable" | "payable";

export interface OpenItem {
  kind: OpenItemKind;
  id: string;
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  invoiceNumber: number | null;
  entryNumber: number | null;
  description: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  /**
   * OPEN amount in the item's own currency (integer minor units). Credit notes are negative.
   * Zero when Exact says the item is fully paid.
   */
  amount: Money;
  /**
   * Original (invoice total) amount in the item's own currency, when the resource exposes it
   * (sync reads: `TransactionAmountFC`). Null on the bulk list reads. VERIFY with credentials
   * (ADR 0014 item 4, ADR 0017).
   */
  originalAmount: Money | null;
  /**
   * Open amount in the division currency (sync reads: `AmountDC`; zero when fully paid). Null on
   * the bulk list reads. VERIFY with credentials.
   */
  amountDc: Money | null;
  /**
   * Booked exchange rate as a plain decimal string (sync reads: `RateFC`), never a float. Null
   * when absent, not positive or not a plain decimal. Direction (FC -> DC) to VERIFY.
   */
  rate: string | null;
  /** Present on sync reads only. */
  timestamp: string | null;
}

export interface GlBalance {
  glAccountId: string;
  glAccountCode: string | null;
  glAccountDescription: string | null;
  reportingYear: number;
  reportingPeriod: number;
  /** 'B' balance sheet, 'W' profit and loss (Exact's BalanceType). */
  balanceType: string | null;
  /** Division currency, integer minor units. */
  amount: Money;
}

export interface SyncPage<T> {
  items: T[];
  /** Resume point: pass as `cursor` next time. Equals the input cursor when nothing changed. */
  nextCursor: string;
  /** False when the page cap (or an error after the first page) stopped the read early. */
  complete: boolean;
  /**
   * Set when a page after the first one failed: `items` and `nextCursor` still cover every page
   * that was read, so the caller can save them and then rethrow this error. Without it a failure
   * on page 4 would throw away pages 1-3 and a slow gate could keep a run from ever advancing.
   */
  error?: unknown;
}

/** One resumable chunk of a bulk list read (open receivables / payables). */
export interface ListChunk<T> {
  items: T[];
  /** `$skiptoken` to continue from, or null when the list is complete. */
  nextToken: string | null;
  complete: boolean;
  /** As for `SyncPage.error`: pages read before a failure are returned, not thrown away. */
  error?: unknown;
}

// ---------------------------------------------------------------------------------------------
// Typed field lists ($select is sent on every REST call)
// ---------------------------------------------------------------------------------------------

export const ME_FIELDS = ["UserID", "UserName", "FullName", "Email", "CurrentDivision"] as const;
export const DIVISION_FIELDS = ["Code", "Description", "Country", "Status", "Main"] as const;
export const ACCOUNT_FIELDS = [
  "ID",
  "Code",
  "Name",
  "Email",
  "VATNumber",
  "Country",
  "IsSupplier",
  "IsSales",
  "Status",
] as const;
export const BANK_ACCOUNT_FIELDS = [
  "ID",
  "Account",
  "BankAccount",
  "BICCode",
  "BankName",
  "Main",
] as const;
export const OPEN_ITEM_LIST_FIELDS = [
  "ID",
  "AccountId",
  "AccountCode",
  "AccountName",
  "Amount",
  "CurrencyCode",
  "Description",
  "DueDate",
  "EntryNumber",
  "InvoiceDate",
  "InvoiceNumber",
] as const;
/**
 * Cashflow sync resources. Field names follow the Exact cashflow model (`AmountFC`/`AmountDC`,
 * `TransactionAmountFC`, `RateFC`, `IsFullyPaid`): VERIFY with credentials (ADR 0014 item 4).
 */
export const OPEN_ITEM_SYNC_FIELDS = [
  "ID",
  "Account",
  "AccountCode",
  "AccountName",
  "AmountDC",
  "AmountFC",
  "Currency",
  "IsFullyPaid",
  "RateFC",
  "TransactionAmountFC",
  "Description",
  "DueDate",
  "EntryNumber",
  "InvoiceDate",
  "InvoiceNumber",
  "Timestamp",
] as const;
export const GL_BALANCE_FIELDS = [
  "ID",
  "GLAccount",
  "GLAccountCode",
  "GLAccountDescription",
  "ReportingYear",
  "ReportingPeriod",
  "BalanceType",
  "Amount",
] as const;
export const SYNC_ACCOUNT_FIELDS = [...ACCOUNT_FIELDS, "Timestamp"] as const;

// ---------------------------------------------------------------------------------------------
// Paging: __next handling
// ---------------------------------------------------------------------------------------------

function divisionSegment(division: number): string {
  return division === 0 ? "current" : String(division);
}

/**
 * Turn an OData `__next` full URL back into a transport path + query, refusing anything that
 * leaves the expected host, scheme, port, division or endpoint. A hostile or buggy link must never
 * make us send the bearer token elsewhere or read another division.
 *
 * Only `$skiptoken` is taken from the link. Everything else (our `$select`, `$filter`,
 * `$orderby`) is re-sent from `baseQuery`, so a link can neither widen `$select`, drop the sync
 * cursor filter, nor add `$expand` or other parameters. The path sent is always `expected.path`.
 */
export function resolveNextLink(
  next: string,
  expected: { host: string; division: number; path: string; baseQuery: Record<string, string> },
): { path: string; query: Record<string, string> } {
  const bad = (why: string): never => {
    throw badData(`Refusing Exact paging link: ${why}`, "BAD_NEXT_LINK");
  };
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return bad("not a URL");
  }
  if (url.protocol !== "https:") bad("not https");
  if (url.username !== "" || url.password !== "") bad("credentials in URL");
  if (url.port !== "") bad("unexpected port");
  if (url.hostname.toLowerCase() !== expected.host.toLowerCase()) bad("different host");
  const prefix = `/api/v1/${divisionSegment(expected.division)}`;
  if (url.pathname.toLowerCase() !== `${prefix}${expected.path}`.toLowerCase()) {
    bad("different division or endpoint");
  }
  const tokens = url.searchParams.getAll("$skiptoken");
  if (tokens.length !== 1) bad(tokens.length === 0 ? "no $skiptoken" : "duplicate $skiptoken");
  const skiptoken = tokens[0] ?? "";
  if (skiptoken === "" || skiptoken.length > 500) bad("bad $skiptoken");
  return { path: expected.path, query: { ...expected.baseQuery, $skiptoken: skiptoken } };
}

function envelopeRows(parsed: unknown): { rows: Row[]; next: string | null } {
  const root = asRow(parsed);
  const d = root["d"];
  if (Array.isArray(d)) return { rows: d.map(asRow), next: null };
  const body = asRow(d);
  const results = body["results"];
  if (!Array.isArray(results)) {
    throw badData("Unexpected response envelope from Exact", "BAD_SHAPE");
  }
  const next = body["__next"];
  return {
    rows: results.map(asRow),
    next: typeof next === "string" && next !== "" ? next : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Errors from responses
// ---------------------------------------------------------------------------------------------

function errorDetail(body: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const err = (parsed as Row)["error"];
      if (typeof err === "object" && err !== null) {
        const e = err as Row;
        const m = e["message"];
        const value =
          typeof m === "string"
            ? m
            : typeof m === "object" && m !== null && typeof (m as Row)["value"] === "string"
              ? ((m as Row)["value"] as string)
              : "";
        const code = typeof e["code"] === "string" && e["code"] !== "" ? e["code"] : undefined;
        return code === undefined
          ? { message: sanitizeForMessage(value) }
          : { message: sanitizeForMessage(value), code };
      }
    }
  } catch {
    // not JSON; fall through
  }
  return { message: sanitizeForMessage(body, 200) };
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

const CURSOR_RE = /^\d{1,20}$/;

/** OData v2 GUID literal for a $filter. Throws RangeError unless `v` is a GUID. */
export function odataGuid(v: string): string {
  if (!isGuid(v)) throw new RangeError("expected a GUID");
  return `guid'${v.toLowerCase()}'`;
}

/**
 * OData v2 string literal for a $filter: wrapped in single quotes, embedded quotes doubled
 * (`O'Brien` -> `'O''Brien'`). Percent-encoding of the whole query value is the transport's job
 * (URLSearchParams); never pre-encode here or the value is encoded twice.
 */
export function odataString(v: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F]/.test(v)) throw new RangeError("control characters in OData string");
  return `'${v.replace(/'/g, "''")}'`;
}

function maxTimestamp(a: string, b: string | null): string {
  if (b === null) return a;
  return BigInt(b) > BigInt(a) ? b : a;
}

function assertMaxPages(v: number): number {
  if (!Number.isSafeInteger(v) || v < 1)
    throw new RangeError("maxPages must be a positive integer");
  return v;
}

export function createExactClient(transport: ExactTransport, options: ExactClientOptions) {
  if (!Number.isSafeInteger(options.division) || options.division < 1) {
    throw new RangeError("division must be a positive integer");
  }
  if (options.jobId === "") throw new RangeError("jobId is required");
  const host = options.host ?? DEFAULT_EXACT_HOST;
  const maxPages = assertMaxPages(options.maxPages ?? DEFAULT_MAX_PAGES);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const divisionCurrency = (options.divisionCurrency ?? "EUR").toUpperCase();
  if (!/^[A-Z]{3}$/.test(divisionCurrency))
    throw new RangeError("divisionCurrency must be ISO 4217");

  /**
   * One transport call with the client's retry and error rules:
   *  - ExactRateLimitedError from the transport (gate): surfaced, never retried.
   *  - 5xx: GET only, up to 2 retries with backoff via `sleep`. Never for POST/PUT/DELETE.
   *  - 401: fatal ExactAuthError (the gate already refreshed once). 429: ExactRateLimitedError.
   */
  async function send(req: ExactRequest): Promise<ExactResponse> {
    for (let attempt = 0; ; attempt++) {
      const res = await transport(req);
      if (res.status >= 200 && res.status < 300) return res;
      if (res.status >= 500 && req.method === "GET" && attempt < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[attempt] ?? 1000);
        continue;
      }
      if (res.status === 401) {
        throw new ExactAuthError(
          "Exact rejected the access token; the connection must be re-authorised",
        );
      }
      if (res.status === 429) {
        throw new ExactRateLimitedError(
          retryAfterFromHeaders(lowerCaseHeaders(res.headers), now()),
          "Exact rate limit reached",
        );
      }
      const detail = errorDetail(res.body);
      throw new ExactApiError(
        res.status,
        `Exact API error ${res.status} on ${req.path}: ${detail.message}`,
        detail.code,
      );
    }
  }

  function restGet(
    path: string,
    query: Record<string, string>,
    division: number = options.division,
  ): Promise<ExactResponse> {
    return send({
      method: "GET",
      path,
      query,
      headers: { Accept: "application/json" },
      division,
      priority: options.priority,
      jobId: options.jobId,
      api: "rest",
    });
  }

  /**
   * Read every page of a collection. PREFER BULK: use the list/sync endpoints with a $select and
   * a filter instead of fetching rows one by one; every page costs one of the 60/min, 5,000/day
   * calls for the division.
   */
  async function readAll(
    path: string,
    select: readonly string[],
    extra: Record<string, string>,
    onCap: "throw" | "stop",
    cap: number = maxPages,
  ): Promise<{ rows: Row[]; complete: boolean }> {
    const division = options.division;
    // $select comes last so `extra` can never replace it.
    const baseQuery: Record<string, string> = { ...extra, $select: select.join(",") };
    let query = baseQuery;
    const rows: Row[] = [];
    for (let page = 1; ; page++) {
      const res = await restGet(path, query, division);
      const { rows: pageRows, next } = envelopeRows(parseJsonRawNumbers(res.body));
      rows.push(...pageRows);
      if (next === null) return { rows, complete: true };
      if (page >= cap) {
        if (onCap === "stop") return { rows, complete: false };
        throw badData(`Exact paging cap of ${cap} pages reached for ${path}`, "PAGE_CAP");
      }
      query = resolveNextLink(next, { host, division, path, baseQuery }).query;
    }
  }

  /**
   * Read up to `cap` pages of a collection starting at `token` (a `$skiptoken` saved from an
   * earlier chunk, or null for the start). Returns the `$skiptoken` to continue from. If a page
   * after the first fails, the pages already read are returned together with the error (the
   * caller saves them and rethrows); a failure on the first page throws.
   */
  async function readChunk(
    path: string,
    select: readonly string[],
    extra: Record<string, string>,
    token: string | null,
    cap: number,
    needToken: boolean,
  ): Promise<{ rows: Row[]; nextToken: string | null; complete: boolean; error?: unknown }> {
    const division = options.division;
    const baseQuery: Record<string, string> = { ...extra, $select: select.join(",") };
    if (token !== null && (token === "" || token.length > 500)) {
      throw new RangeError("bad $skiptoken");
    }
    let query: Record<string, string> =
      token === null ? baseQuery : { ...baseQuery, $skiptoken: token };
    const rows: Row[] = [];
    let nextToken = token;
    for (let page = 1; ; page++) {
      let pageRows: Row[];
      let next: string | null;
      try {
        const res = await restGet(path, query, division);
        ({ rows: pageRows, next } = envelopeRows(parseJsonRawNumbers(res.body)));
      } catch (e) {
        if (page === 1) throw e;
        return { rows, nextToken, complete: false, error: e };
      }
      rows.push(...pageRows);
      if (next === null) return { rows, nextToken: null, complete: true };
      // Sync reads resume from a Timestamp cursor and never need the link at the page cap.
      if (page >= cap && !needToken) return { rows, nextToken, complete: false };
      let resolved: { path: string; query: Record<string, string> };
      try {
        resolved = resolveNextLink(next, { host, division, path, baseQuery });
      } catch (e) {
        // Rows of this page are good, but there is no safe place to continue from.
        if (page === 1) throw e;
        return { rows, nextToken, complete: false, error: e };
      }
      nextToken = resolved.query["$skiptoken"] ?? null;
      query = resolved.query;
      if (page >= cap) return { rows, nextToken, complete: false };
    }
  }

  // --- mappers ---------------------------------------------------------------------------

  /** Sync rows must carry a Timestamp, or the cursor could not advance past them. */
  function reqTimestamp(r: Row): string {
    const t = bigField(r, "Timestamp");
    if (t === null) throw badData("Sync row without Timestamp", "BAD_SHAPE");
    return t;
  }

  function mapAccount(r: Row, withTimestamp: boolean): ExactAccount {
    return {
      id: reqGuid(r, "ID"),
      code: trimField(r, "Code"),
      name: strField(r, "Name") ?? "",
      email: trimField(r, "Email"),
      vatNumber: trimField(r, "VATNumber"),
      country: trimField(r, "Country"),
      isSupplier: boolField(r, "IsSupplier"),
      isSales: boolField(r, "IsSales"),
      status: trimField(r, "Status"),
      timestamp: withTimestamp ? reqTimestamp(r) : null,
    };
  }

  function moneyField(r: Row, key: string, rawCurrency: string | null): Money {
    const currency = rawCurrency?.toUpperCase() ?? null;
    if (currency === null || !/^[A-Z]{3}$/.test(currency)) {
      throw badData("Row without a valid currency", "BAD_SHAPE");
    }
    // Scale follows the currency (JPY 0, EUR 2, KWD 3): minor units are the currency's own.
    const minor = minorField(r, key, currency);
    if (minor === null) throw badData(`Missing ${key}`, "BAD_SHAPE");
    return money(minor, currency);
  }

  function optionalMoney(r: Row, key: string, currency: string): Money | null {
    const minor = minorField(r, key, currency);
    return minor === null ? null : money(minor, currency);
  }

  /** Positive plain decimal rate kept as text (no float). Anything else is treated as unknown. */
  function rateField(r: Row, key: string): string | null {
    const v = strField(r, key);
    if (v === null || !/^\d{1,12}(\.\d{1,20})?$/.test(v) || !/[1-9]/.test(v)) return null;
    return v;
  }

  function mapOpenItem(kind: OpenItemKind, r: Row, sync: boolean): OpenItem {
    let amount: Money;
    let originalAmount: Money | null = null;
    let amountDc: Money | null = null;
    let rate: string | null = null;
    if (sync) {
      const open = moneyField(r, "AmountFC", trimField(r, "Currency"));
      const paid = boolField(r, "IsFullyPaid");
      amount = paid ? money(0, open.currency) : open;
      originalAmount = optionalMoney(r, "TransactionAmountFC", open.currency);
      const dc = optionalMoney(r, "AmountDC", divisionCurrency);
      amountDc = dc === null ? null : paid ? money(0, divisionCurrency) : dc;
      rate = rateField(r, "RateFC");
    } else {
      amount = moneyField(r, "Amount", trimField(r, "CurrencyCode"));
    }
    return {
      kind,
      id: reqGuid(r, "ID"),
      accountId: reqGuid(r, sync ? "Account" : "AccountId"),
      accountCode: trimField(r, "AccountCode"),
      accountName: trimField(r, "AccountName"),
      invoiceNumber: intField(r, "InvoiceNumber"),
      entryNumber: intField(r, "EntryNumber"),
      description: trimField(r, "Description"),
      invoiceDate: dateField(r, "InvoiceDate"),
      dueDate: dateField(r, "DueDate"),
      amount,
      originalAmount,
      amountDc,
      rate,
      timestamp: sync ? reqTimestamp(r) : null,
    };
  }

  async function syncRead<T extends { timestamp: string | null }>(
    path: string,
    select: readonly string[],
    cursor: string,
    map: (r: Row) => T,
    pagesOverride?: number,
  ): Promise<SyncPage<T>> {
    if (!CURSOR_RE.test(cursor) || BigInt(cursor) > 18446744073709551615n) {
      throw new RangeError("cursor must be a non-negative 64-bit integer string");
    }
    const cap = pagesOverride === undefined ? maxPages : assertMaxPages(pagesOverride);
    // Timestamp cursor pattern: ascending by Timestamp, strictly greater than the last one seen,
    // so a resumed read never skips or repeats rows. At the page cap the read stops and returns
    // complete: false with a resumable cursor (a sync never throws work away at the cap).
    const { rows, complete, error } = await readChunk(
      path,
      select,
      { $filter: `Timestamp gt ${BigInt(cursor).toString()}L`, $orderby: "Timestamp" },
      null,
      cap,
      false,
    );
    const items = rows.map(map);
    let nextCursor = BigInt(cursor).toString();
    let ordered = true;
    let prev: bigint | null = null;
    for (const it of items) {
      nextCursor = maxTimestamp(nextCursor, it.timestamp);
      const t = it.timestamp === null ? null : BigInt(it.timestamp);
      if (t !== null && prev !== null && t < prev) ordered = false;
      if (t !== null) prev = t;
    }
    // Resuming a partial read from the max Timestamp is only safe if rows came in ascending
    // order; otherwise rows below the max that were not read yet would be skipped forever.
    if (!complete && !ordered) {
      throw badData(`Exact sync rows for ${path} not in Timestamp order`, "SYNC_ORDER");
    }
    return error === undefined
      ? { items, nextCursor, complete }
      : { items, nextCursor, complete, error };
  }

  async function listChunk(
    kind: OpenItemKind,
    token: string | null,
    opts: { maxPages?: number },
  ): Promise<ListChunk<OpenItem>> {
    const cap = opts.maxPages === undefined ? maxPages : assertMaxPages(opts.maxPages);
    const path =
      kind === "receivable" ? "/read/financial/ReceivablesList" : "/read/financial/PayablesList";
    const r = await readChunk(path, OPEN_ITEM_LIST_FIELDS, {}, token, cap, true);
    const items = r.rows.map((row) => mapOpenItem(kind, row, false));
    return r.error === undefined
      ? { items, nextToken: r.nextToken, complete: r.complete }
      : { items, nextToken: r.nextToken, complete: false, error: r.error };
  }

  // --- public API --------------------------------------------------------------------------

  return {
    /**
     * `/api/v1/current/Me`: sent as path `/Me` with division 0, which the transport turns into
     * the `current` segment (transport.ts). Use `currentDivision` to start a client for the
     * user's default division.
     */
    async currentMe(): Promise<CurrentMe> {
      const res = await restGet("/Me", { $select: ME_FIELDS.join(",") }, 0);
      const { rows } = envelopeRows(parseJsonRawNumbers(res.body));
      const r = rows[0];
      if (r === undefined) throw badData("Empty /current/Me response", "BAD_SHAPE");
      const currentDivision = intField(r, "CurrentDivision");
      if (currentDivision === null || currentDivision < 1) {
        throw badData("Missing CurrentDivision", "BAD_SHAPE");
      }
      return {
        userId: reqGuid(r, "UserID"),
        userName: trimField(r, "UserName"),
        fullName: trimField(r, "FullName"),
        email: trimField(r, "Email"),
        currentDivision,
      };
    },

    async listDivisions(): Promise<Division[]> {
      const { rows } = await readAll("/system/Divisions", DIVISION_FIELDS, {}, "throw");
      return rows.map((r) => {
        const code = intField(r, "Code");
        if (code === null || code < 1) throw badData("Division without Code", "BAD_SHAPE");
        return {
          code,
          description: trimField(r, "Description"),
          country: trimField(r, "Country"),
          status: intField(r, "Status"),
          main: boolField(r, "Main"),
        };
      });
    },

    async listAccounts(): Promise<ExactAccount[]> {
      const { rows } = await readAll("/crm/Accounts", ACCOUNT_FIELDS, {}, "throw");
      return rows.map((r) => mapAccount(r, false));
    },

    /** Incremental accounts via the sync endpoint. Start with cursor "0". */
    syncAccounts(
      cursor: string,
      opts: { maxPages?: number } = {},
    ): Promise<SyncPage<ExactAccount>> {
      return syncRead(
        "/sync/CRM/Accounts",
        SYNC_ACCOUNT_FIELDS,
        cursor,
        (r) => mapAccount(r, true),
        opts.maxPages,
      );
    },

    /** IBANs per relation; pass accountId to restrict to one relation. */
    async listBankAccounts(opts: { accountId?: string } = {}): Promise<ExactBankAccount[]> {
      const extra: Record<string, string> =
        opts.accountId === undefined ? {} : { $filter: `Account eq ${odataGuid(opts.accountId)}` };
      const { rows } = await readAll("/crm/BankAccounts", BANK_ACCOUNT_FIELDS, extra, "throw");
      return rows.map((r) => {
        const iban = trimField(r, "BankAccount");
        return {
          id: reqGuid(r, "ID"),
          accountId: reqGuid(r, "Account"),
          iban: iban === null ? null : iban.replace(/\s+/g, "").toUpperCase(),
          bic: trimField(r, "BICCode"),
          bankName: trimField(r, "BankName"),
          main: boolField(r, "Main"),
        };
      });
    },

    /** Open receivables (full list, bulk). */
    async listReceivables(): Promise<OpenItem[]> {
      const { rows } = await readAll(
        "/read/financial/ReceivablesList",
        OPEN_ITEM_LIST_FIELDS,
        {},
        "throw",
      );
      return rows.map((r) => mapOpenItem("receivable", r, false));
    },

    /** Open payables (full list, bulk). */
    async listPayables(): Promise<OpenItem[]> {
      const { rows } = await readAll(
        "/read/financial/PayablesList",
        OPEN_ITEM_LIST_FIELDS,
        {},
        "throw",
      );
      return rows.map((r) => mapOpenItem("payable", r, false));
    },

    /**
     * Resumable read of the open receivables list: up to `maxPages` pages from `token` (null =
     * start). Save `nextToken` (a `$skiptoken`) to continue in a later run. ASSUMPTION to verify
     * (ADR 0017): the token is stateless and the list order is stable between runs.
     */
    listReceivablesChunk(
      token: string | null,
      opts: { maxPages?: number } = {},
    ): Promise<ListChunk<OpenItem>> {
      return listChunk("receivable", token, opts);
    },

    /** Resumable read of the open payables list; see `listReceivablesChunk`. */
    listPayablesChunk(
      token: string | null,
      opts: { maxPages?: number } = {},
    ): Promise<ListChunk<OpenItem>> {
      return listChunk("payable", token, opts);
    },

    /** Incremental receivables. Start with cursor "0". Endpoint to be verified (ADR 0014). */
    syncReceivables(cursor: string, opts: { maxPages?: number } = {}): Promise<SyncPage<OpenItem>> {
      return syncRead(
        "/sync/Cashflow/Receivables",
        OPEN_ITEM_SYNC_FIELDS,
        cursor,
        (r) => mapOpenItem("receivable", r, true),
        opts.maxPages,
      );
    },

    /** Incremental payables. Start with cursor "0". Endpoint to be verified (ADR 0014). */
    syncPayables(cursor: string, opts: { maxPages?: number } = {}): Promise<SyncPage<OpenItem>> {
      return syncRead(
        "/sync/Cashflow/Payables",
        OPEN_ITEM_SYNC_FIELDS,
        cursor,
        (r) => mapOpenItem("payable", r, true),
        opts.maxPages,
      );
    },

    /**
     * GL account balance rows for one reporting year, limited to periods <= `upToPeriod` when
     * given. Rows are returned as Exact sends them (one per account/period, assumed per-period
     * movements, not cumulative; ADR 0014 item 8): the caller sums. `currency` is the division
     * currency and sets the minor-unit scale.
     */
    async listGlBalances(opts: {
      year: number;
      upToPeriod?: number;
      currency: string;
    }): Promise<GlBalance[]> {
      if (!/^[A-Z]{3}$/.test(opts.currency)) throw new RangeError("invalid currency");
      if (!Number.isInteger(opts.year) || opts.year < 1900 || opts.year > 2200) {
        throw new RangeError("invalid reporting year");
      }
      let filter = `ReportingYear eq ${opts.year}`;
      if (opts.upToPeriod !== undefined) {
        if (!Number.isInteger(opts.upToPeriod) || opts.upToPeriod < 0 || opts.upToPeriod > 99) {
          throw new RangeError("invalid reporting period");
        }
        filter += ` and ReportingPeriod le ${opts.upToPeriod}`;
      }
      const { rows } = await readAll(
        "/financial/ReportingBalance",
        GL_BALANCE_FIELDS,
        { $filter: filter },
        "throw",
      );
      return rows.map((r) => {
        const year = intField(r, "ReportingYear");
        const period = intField(r, "ReportingPeriod");
        if (year === null || period === null) {
          throw badData("Incomplete GL balance row", "BAD_SHAPE");
        }
        return {
          glAccountId: reqGuid(r, "GLAccount"),
          glAccountCode: trimField(r, "GLAccountCode"),
          glAccountDescription: trimField(r, "GLAccountDescription"),
          reportingYear: year,
          reportingPeriod: period,
          balanceType: trimField(r, "BalanceType"),
          amount: moneyField(r, "Amount", opts.currency),
        };
      });
    },

    /**
     * XML API skeleton: POST a topic body to XMLUpload.aspx. `topicXml` is already-built XML for
     * one topic (builders such as MatchSets come later). Never retried (non-GET).
     */
    async xmlUpload(topic: string, topicXml: string): Promise<XmlUploadResult> {
      if (!/^[A-Za-z]+$/.test(topic)) throw new RangeError("invalid XML topic");
      const res = await send({
        method: "POST",
        path: "/docs/XMLUpload.aspx",
        query: { Topic: topic },
        headers: { "Content-Type": "text/xml; charset=utf-8" },
        body: buildXmlEnvelope(topicXml),
        division: options.division,
        priority: options.priority,
        jobId: options.jobId,
        api: "xml",
      });
      return parseXmlResponse(res.body);
    },
  };
}

export type ExactClient = ReturnType<typeof createExactClient>;
