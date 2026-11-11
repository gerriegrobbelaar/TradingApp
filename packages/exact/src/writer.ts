/**
 * The Exact write path for bank matching (ADR 0040). Transport only, no fetch. Separate from the
 * read client on purpose: a reads-only code path cannot write because it never holds a writer, and
 * a writer made without `writeEnabled: true` refuses every write.
 *
 * Writes are NEVER retried here (a retried POST can book twice). If the transport throws or the
 * answer is lost, the outcome is unknown: the caller must run the duplicate probe
 * (`findBankEntryLineByRef`) or read back before deciding anything.
 */
import { odataGuid } from "./client";
import { type Row, asRow, badData, parseJsonRawNumbers } from "./json";
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
import {
  type BankEntryResponse,
  type BuiltBankEntry,
  EXACT_WRITE_NAMES,
  type MatchSetResponse,
  type OpenItemLineRow,
  findExistingBankEntryQuery,
  mapOpenItemLineRow,
  parseBankEntryResponse,
  parseMatchSetResponse,
} from "./write-payloads";

export class ExactWriteDisabledError extends Error {
  constructor() {
    super("Exact writes are disabled for this writer");
    this.name = "ExactWriteDisabledError";
  }
}

export interface ExactWriterOptions {
  /** Must be exactly `true`; anything else (missing, "true", 1) disables every write. */
  writeEnabled: boolean;
  division: number;
  jobId: string;
  priority: ExactPriority;
  now?: () => number;
}

export interface BankEntryLineHit {
  id: string | null;
  entryId: string | null;
  entryNumber: number | null;
  yourRef: string | null;
  /** Raw decimal text from Exact. */
  amountFc: string | null;
}

function errorMessage(body: string): string {
  try {
    const e = asRow(parseJsonRawNumbers(body))["error"];
    const m = typeof e === "object" && e !== null ? (e as Row)["message"] : undefined;
    const v =
      typeof m === "string"
        ? m
        : typeof m === "object" && m !== null
          ? (m as Row)["value"]
          : undefined;
    if (typeof v === "string") return sanitizeForMessage(v);
  } catch {
    // not JSON
  }
  return sanitizeForMessage(body, 200);
}

export function createExactWriter(transport: ExactTransport, options: ExactWriterOptions) {
  if (!Number.isSafeInteger(options.division) || options.division < 1)
    throw new RangeError("division must be a positive integer");
  if (options.jobId === "") throw new RangeError("jobId is required");
  const enabled = options.writeEnabled === true;
  const now = options.now ?? Date.now;

  function assertWritable(): void {
    if (!enabled) throw new ExactWriteDisabledError();
  }

  /** One call, no retry of any kind. */
  async function sendOnce(
    req: Omit<ExactRequest, "division" | "priority" | "jobId">,
  ): Promise<ExactResponse> {
    const res = await transport({
      ...req,
      division: options.division,
      priority: options.priority,
      jobId: options.jobId,
    });
    if (res.status >= 200 && res.status < 300) return res;
    if (res.status === 401)
      throw new ExactAuthError(
        "Exact rejected the access token; the connection must be re-authorised",
      );
    if (res.status === 429)
      throw new ExactRateLimitedError(
        retryAfterFromHeaders(lowerCaseHeaders(res.headers), now()),
        "Exact rate limit reached",
      );
    throw new ExactApiError(
      res.status,
      `Exact API error ${res.status} on ${req.path}: ${errorMessage(res.body)}`,
    );
  }

  return {
    /** POST the built bank entry. The caller probes first; the outcome of a thrown error is unknown. */
    async createBankEntry(payload: BuiltBankEntry): Promise<BankEntryResponse> {
      assertWritable();
      const res = await sendOnce({
        method: "POST",
        path: EXACT_WRITE_NAMES.rest.bankEntryPath,
        headers: payload.headers,
        body: payload.body,
        api: "rest",
      });
      return parseBankEntryResponse(res.body);
    },

    /** POST a built MatchSet document. The answer is never proof: read back (ADR 0040). */
    async submitMatchSet(
      xml: string,
      opts: { idempotencyKey?: string } = {},
    ): Promise<MatchSetResponse> {
      assertWritable();
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !xml.includes(`<${EXACT_WRITE_NAMES.xml.topic}>`))
        throw new RangeError("not a MatchSets document built by buildMatchSetXml");
      const headers: Record<string, string> = { "Content-Type": "text/xml; charset=utf-8" };
      if (opts.idempotencyKey !== undefined)
        headers[EXACT_WRITE_NAMES.rest.idempotencyHeader] = opts.idempotencyKey;
      const res = await sendOnce({
        method: "POST",
        path: "/docs/XMLUpload.aspx",
        query: { Topic: EXACT_WRITE_NAMES.xml.topic },
        headers,
        body: xml,
        api: "xml",
      });
      return parseMatchSetResponse(res.body);
    },

    /** Duplicate probe: existing bank entry lines with this YourRef in this journal. */
    async findBankEntryLineByRef(args: {
      journalCode: string;
      yourRef: string;
    }): Promise<BankEntryLineHit[]> {
      const q = findExistingBankEntryQuery(args);
      const res = await sendOnce({
        method: "GET",
        path: q.path,
        query: q.query,
        headers: { Accept: "application/json" },
        api: "rest",
      });
      return resultRows(res.body).rows.map((r) => ({
        id: str(r, "ID"),
        entryId: str(r, "EntryID"),
        entryNumber: num(r, "EntryNumber"),
        yourRef: str(r, "YourRef"),
        amountFc: str(r, "AmountFC"),
      }));
    },

    /** Read-back: the open amount of the given entries of one relation (max 20 per call). */
    async readOpenItemLines(args: {
      kind: "receivable" | "payable";
      accountId: string;
      entryNumbers: readonly number[];
    }): Promise<OpenItemLineRow[]> {
      if (args.entryNumbers.length === 0 || args.entryNumbers.length > 20)
        throw new RangeError("1 to 20 entry numbers");
      for (const e of args.entryNumbers)
        if (!Number.isSafeInteger(e) || e < 1) throw new RangeError("invalid entry number");
      const numbers = args.entryNumbers.map((e) => `EntryNumber eq ${e}`).join(" or ");
      const res = await sendOnce({
        method: "GET",
        path:
          args.kind === "receivable"
            ? EXACT_WRITE_NAMES.rest.receivablesPath
            : EXACT_WRITE_NAMES.rest.payablesPath,
        query: {
          $filter: `Account eq ${odataGuid(args.accountId)} and (${numbers})`,
          $select: EXACT_WRITE_NAMES.rest.openItemFields.join(","),
        },
        headers: { Accept: "application/json" },
        api: "rest",
      });
      const { rows, more } = resultRows(res.body);
      // A second page would mean a filter wider than expected: do not guess from half the rows.
      if (more) throw badData("Unexpected paging on read-back", "BAD_SHAPE");
      return rows.map(mapOpenItemLineRow);
    },
  };
}

export type ExactWriter = ReturnType<typeof createExactWriter>;

function str(r: Row, k: string): string | null {
  const v = r[k];
  return typeof v === "string" && v !== "" ? v.trim() : null;
}
function num(r: Row, k: string): number | null {
  const v = str(r, k);
  return v !== null && /^\d{1,15}$/.test(v) ? Number(v) : null;
}

function resultRows(body: string): { rows: Row[]; more: boolean } {
  const d = asRow(parseJsonRawNumbers(body))["d"];
  if (Array.isArray(d)) return { rows: d.map(asRow), more: false };
  const results = asRow(d)["results"];
  if (!Array.isArray(results))
    throw badData("Unexpected response envelope from Exact", "BAD_SHAPE");
  const next = (d as Row)["__next"];
  return { rows: results.map(asRow), more: typeof next === "string" && next !== "" };
}
