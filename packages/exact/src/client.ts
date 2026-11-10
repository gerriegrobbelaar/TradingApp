import { type Money, money } from "@camelthorn/core";
import {
  type Row,
  asRow,
  bigField,
  boolField,
  dateField,
  intField,
  minorField,
  parseJsonRawNumbers,
  reqStr,
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
  /** Max pages followed per read. Default 200. */
  maxPages?: number;
  /** Injected so tests (and the worker) control backoff. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock (epoch ms), used to turn X-RateLimit-*-Reset into a wait. */
  now?: () => number;
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
  /** Open amount in the item's own currency (integer minor units). Credit notes are negative. */
  amount: Money;
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
  /** False when the page cap stopped the read early; call again with `nextCursor`. */
  complete: boolean;
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
export const OPEN_ITEM_SYNC_FIELDS = [
  "ID",
  "Account",
  "AccountCode",
  "AccountName",
  "Amount",
  "Currency",
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
 * leaves the expected host, scheme, division or endpoint. A hostile or buggy link must never make
 * us send the bearer token elsewhere or read another division.
 */
export function resolveNextLink(
  next: string,
  expected: { host: string; division: number; path: string; select: string },
): { path: string; query: Record<string, string> } {
  const bad = (why: string): never => {
    throw new ExactApiError(`Refusing Exact paging link: ${why}`, 200, "BAD_NEXT_LINK");
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
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (Object.prototype.hasOwnProperty.call(query, k)) bad("duplicate query key");
    query[k] = v;
  }
  if (query["$select"] === undefined) query["$select"] = expected.select;
  return { path: expected.path, query };
}

function envelopeRows(parsed: unknown): { rows: Row[]; next: string | null } {
  const root = asRow(parsed);
  const d = root["d"];
  if (Array.isArray(d)) return { rows: d.map(asRow), next: null };
  const body = asRow(d);
  const results = body["results"];
  if (!Array.isArray(results)) {
    throw new ExactApiError("Unexpected response envelope from Exact", 200, "BAD_SHAPE");
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

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CURSOR_RE = /^\d{1,20}$/;

function assertGuid(v: string): string {
  if (!GUID_RE.test(v)) throw new RangeError("expected a GUID");
  return v;
}

function maxTimestamp(a: string, b: string | null): string {
  if (b === null) return a;
  return BigInt(b) > BigInt(a) ? b : a;
}

export function createExactClient(transport: ExactTransport, options: ExactClientOptions) {
  const host = options.host ?? DEFAULT_EXACT_HOST;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

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
          "Exact rate limit reached",
          retryAfterFromHeaders(lowerCaseHeaders(res.headers), now()),
        );
      }
      const detail = errorDetail(res.body);
      throw new ExactApiError(
        `Exact API error ${res.status} on ${req.path}: ${detail.message}`,
        res.status,
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
    division: number = options.division,
  ): Promise<{ rows: Row[]; complete: boolean }> {
    const selectValue = select.join(",");
    let query: Record<string, string> = { $select: selectValue, ...extra };
    const rows: Row[] = [];
    for (let page = 1; ; page++) {
      const res = await restGet(path, query, division);
      let parsed: unknown;
      try {
        parsed = parseJsonRawNumbers(res.body);
      } catch {
        throw new ExactApiError(`Exact returned invalid JSON for ${path}`, res.status, "BAD_JSON");
      }
      const { rows: pageRows, next } = envelopeRows(parsed);
      rows.push(...pageRows);
      if (next === null) return { rows, complete: true };
      if (page >= maxPages) {
        if (onCap === "stop") return { rows, complete: false };
        throw new ExactApiError(
          `Exact paging cap of ${maxPages} pages reached for ${path}`,
          200,
          "PAGE_CAP",
        );
      }
      query = resolveNextLink(next, {
        host,
        division,
        path,
        select: selectValue,
      }).query;
    }
  }

  // --- mappers ---------------------------------------------------------------------------

  function mapAccount(r: Row, withTimestamp: boolean): ExactAccount {
    return {
      id: reqStr(r, "ID"),
      code: trimField(r, "Code"),
      name: strField(r, "Name") ?? "",
      email: trimField(r, "Email"),
      vatNumber: trimField(r, "VATNumber"),
      country: trimField(r, "Country"),
      isSupplier: boolField(r, "IsSupplier"),
      isSales: boolField(r, "IsSales"),
      status: trimField(r, "Status"),
      timestamp: withTimestamp ? bigField(r, "Timestamp") : null,
    };
  }

  function mapOpenItem(kind: OpenItemKind, r: Row, sync: boolean): OpenItem {
    const minor = minorField(r, "Amount");
    const currency = trimField(r, sync ? "Currency" : "CurrencyCode");
    if (minor === null || currency === null) {
      throw new ExactApiError("Open item without amount or currency", 200, "BAD_SHAPE");
    }
    let amount: Money;
    try {
      amount = money(minor, currency.toUpperCase());
    } catch {
      throw new ExactApiError("Open item with invalid currency", 200, "BAD_SHAPE");
    }
    return {
      kind,
      id: reqStr(r, "ID"),
      accountId: reqStr(r, sync ? "Account" : "AccountId"),
      accountCode: trimField(r, "AccountCode"),
      accountName: trimField(r, "AccountName"),
      invoiceNumber: intField(r, "InvoiceNumber"),
      entryNumber: intField(r, "EntryNumber"),
      description: trimField(r, "Description"),
      invoiceDate: dateField(r, "InvoiceDate"),
      dueDate: dateField(r, "DueDate"),
      amount,
      timestamp: sync ? bigField(r, "Timestamp") : null,
    };
  }

  async function syncRead<T extends { timestamp: string | null }>(
    path: string,
    select: readonly string[],
    cursor: string,
    map: (r: Row) => T,
    maxPagesOverride?: number,
  ): Promise<SyncPage<T>> {
    if (!CURSOR_RE.test(cursor))
      throw new RangeError("cursor must be a non-negative integer string");
    // Timestamp cursor pattern: ascending by Timestamp, strictly greater than the last one seen,
    // so a resumed read never skips or repeats rows.
    const { rows, complete } = await readAll(
      path,
      select,
      { $filter: `Timestamp gt ${cursor}L`, $orderby: "Timestamp" },
      maxPagesOverride === undefined ? "throw" : "stop",
    );
    const items = rows.map(map);
    let nextCursor = cursor;
    for (const it of items) nextCursor = maxTimestamp(nextCursor, it.timestamp);
    return { items, nextCursor, complete };
  }

  // --- public API --------------------------------------------------------------------------

  return {
    /**
     * `/current/Me`: the one call without a division in the URL (sent with division 0, see
     * transport.ts). Use `currentDivision` to start a client for the user's default division.
     */
    async currentMe(): Promise<CurrentMe> {
      const res = await restGet("/current/Me", { $select: ME_FIELDS.join(",") }, 0);
      const { rows } = envelopeRows(parseJsonRawNumbers(res.body));
      const r = rows[0];
      if (r === undefined) throw new ExactApiError("Empty /current/Me response", 200, "BAD_SHAPE");
      const currentDivision = intField(r, "CurrentDivision");
      if (currentDivision === null) {
        throw new ExactApiError("Missing CurrentDivision", 200, "BAD_SHAPE");
      }
      return {
        userId: reqStr(r, "UserID"),
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
        if (code === null) throw new ExactApiError("Division without Code", 200, "BAD_SHAPE");
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
        opts.accountId === undefined
          ? {}
          : { $filter: `Account eq guid'${assertGuid(opts.accountId)}'` };
      const { rows } = await readAll("/crm/BankAccounts", BANK_ACCOUNT_FIELDS, extra, "throw");
      return rows.map((r) => {
        const iban = trimField(r, "BankAccount");
        return {
          id: reqStr(r, "ID"),
          accountId: reqStr(r, "Account"),
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
     * GL account balances per reporting period for one year (cumulative through `upToPeriod`
     * when given). Amounts are in the division currency.
     */
    async listGlBalances(opts: {
      year: number;
      upToPeriod?: number;
      currency: string;
    }): Promise<GlBalance[]> {
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
        const minor = minorField(r, "Amount");
        const year = intField(r, "ReportingYear");
        const period = intField(r, "ReportingPeriod");
        if (minor === null || year === null || period === null) {
          throw new ExactApiError("Incomplete GL balance row", 200, "BAD_SHAPE");
        }
        return {
          glAccountId: reqStr(r, "GLAccount"),
          glAccountCode: trimField(r, "GLAccountCode"),
          glAccountDescription: trimField(r, "GLAccountDescription"),
          reportingYear: year,
          reportingPeriod: period,
          balanceType: trimField(r, "BalanceType"),
          amount: money(minor, opts.currency),
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
