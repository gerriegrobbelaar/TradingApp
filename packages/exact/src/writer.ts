/**
 * The Exact write path for bank matching (ADR 0040). Transport only, no fetch. Separate from the
 * read client on purpose: the read client is GET-only, so a reads-only code path cannot write
 * because it never holds a writer, and a writer without `writeEnabled: true` refuses every write.
 *
 * The guard is strict and evaluated twice: `writeEnabled` must be the boolean `true` when the
 * writer is created AND at the moment of every write call (so flipping the options object to
 * false later disables it, and flipping it to true later does not enable a writer created
 * disabled). Only payload objects produced by `buildBankEntryPayload` / `buildMatchSetXml`, for
 * this writer's division, are sent.
 *
 * Writes are NEVER retried here (a retried POST can book twice), and transport errors are
 * re-thrown untouched. If the transport throws or the answer is lost, the outcome is unknown:
 * the caller must run the duplicate probe (`findBankEntryLineByRef`) or read back before
 * deciding anything.
 *
 * Callers: the worker's booking executor (apps/worker/src/booking/executor.ts, ADR 0044) is the
 * only allowed caller (source scan in apps/worker/test/exact-write-guard.test.ts). The ExactGate
 * refuses every other write, and these two only while the fail-closed booking switch is on.
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
import { isBuilt } from "./write-brand";
import {
  type BankEntryResponse,
  type BuiltBankEntry,
  type BuiltMatchSet,
  EXACT_WRITE_NAMES,
  type MatchSetResponse,
  type OpenItemLineRow,
  findBankLineByAmountQuery,
  findExistingBankEntryQuery,
  latestBankEntryQuery,
  mapOpenItemLineRow,
  parseBankEntryResponse,
  parseLatestClosingBalance,
  parseMatchSetResponse,
} from "./write-payloads";

export class ExactWriteDisabledError extends Error {
  constructor() {
    super("Exact writes are disabled for this writer");
    this.name = "ExactWriteDisabledError";
  }
}

/** The payload was not built by this package's builders, or was built for another division. */
export class ExactWritePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExactWritePayloadError";
  }
}

export interface ExactWriterOptions {
  /** Must be exactly `true` (at creation and at call time); anything else disables writes. */
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
    if (typeof v === "string") return sanitizeForMessage(v, 200);
  } catch {
    // not JSON
  }
  return sanitizeForMessage(body.slice(0, 2000), 200);
}

export function createExactWriter(transport: ExactTransport, options: ExactWriterOptions) {
  // Snapshot everything but the guard flag, so later mutation cannot redirect a write.
  const division = options.division;
  const jobId = options.jobId;
  const priority = options.priority;
  if (!Number.isSafeInteger(division) || division < 1)
    throw new RangeError("division must be a positive integer");
  if (typeof jobId !== "string" || jobId === "") throw new RangeError("jobId is required");
  const enabledAtCreation = options.writeEnabled === true;
  const now = options.now ?? Date.now;

  function assertWritable(): void {
    // Both checks, strict boolean: "true", 1 or an object never enable writes.
    if (!enabledAtCreation || options.writeEnabled !== true) throw new ExactWriteDisabledError();
  }

  function assertPayload(payload: { division: number }): void {
    if (!isBuilt(payload)) throw new ExactWritePayloadError("payload was not built by the builder");
    if (payload.division !== division)
      throw new ExactWritePayloadError("payload was built for another division");
  }

  /** One call, no retry of any kind; transport errors propagate untouched. */
  async function sendOnce(
    req: Omit<ExactRequest, "division" | "priority" | "jobId">,
  ): Promise<ExactResponse> {
    const res = await transport({ ...req, division, priority, jobId });
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
    /**
     * POST the built bank entry. The caller probes first. A thrown error, or any non-ok result,
     * leaves the outcome unknown: probe again, never re-post blind.
     */
    async createBankEntry(payload: BuiltBankEntry): Promise<BankEntryResponse> {
      assertWritable();
      assertPayload(payload);
      const res = await sendOnce({
        method: "POST",
        path: EXACT_WRITE_NAMES.rest.bankEntryPath,
        headers: { ...payload.headers },
        body: payload.body,
        api: "rest",
      });
      return parseBankEntryResponse(res.body, payload.yourRefs);
    },

    /** POST a built MatchSet document. The answer is never proof: read back (ADR 0040). */
    async submitMatchSet(payload: BuiltMatchSet): Promise<MatchSetResponse> {
      assertWritable();
      assertPayload(payload);
      const res = await sendOnce({
        method: "POST",
        path: EXACT_WRITE_NAMES.xml.uploadPath,
        query: { Topic: payload.topic },
        headers: { "Content-Type": "text/xml; charset=utf-8" },
        body: payload.xml,
        api: "xml",
      });
      return parseMatchSetResponse(res.body);
    },

    /**
     * Duplicate probe: existing bank entry lines with this YourRef in this journal. Any hit
     * (even one with unreadable fields) means "do not post".
     */
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
      return probeHits(res.body);
    },

    /**
     * Bank line created by another system (Revolut's own Exact feed): same journal, exact signed
     * amount, date window. Zero hits = not there (yet); one = the line; several = ambiguous.
     */
    async findBankLineByAmount(args: {
      journalCode: string;
      amountMinor: number;
      currency: string;
      dateFrom: string;
      dateTo: string;
    }): Promise<BankEntryLineHit[]> {
      const q = findBankLineByAmountQuery(args);
      const res = await sendOnce({
        method: "GET",
        path: q.path,
        query: q.query,
        headers: { Accept: "application/json" },
        api: "rest",
      });
      return probeHits(res.body);
    },

    /**
     * Closing balance of the latest bank entry of a journal (the next entry's opening balance), in
     * minor units, or null when it cannot be determined (no entry, other currency, unreadable).
     */
    async readLatestClosingBalance(args: {
      journalCode: string;
      currency: string;
    }): Promise<number | null> {
      const q = latestBankEntryQuery(args.journalCode);
      const res = await sendOnce({
        method: "GET",
        path: q.path,
        query: q.query,
        headers: { Accept: "application/json" },
        api: "rest",
      });
      return parseLatestClosingBalance(resultRows(res.body).rows, args.currency);
    },

    /**
     * Read-back: the open amount of the given entries of one relation (max 20 per call).
     * `fullyPaidOnly` is the second read for lines absent from the first one (ADR 0040).
     */
    async readOpenItemLines(args: {
      kind: "receivable" | "payable";
      accountId: string;
      entryNumbers: readonly number[];
      fullyPaidOnly?: boolean;
    }): Promise<OpenItemLineRow[]> {
      if (args.entryNumbers.length === 0 || args.entryNumbers.length > 20)
        throw new RangeError("1 to 20 entry numbers");
      for (const e of args.entryNumbers)
        if (!Number.isSafeInteger(e) || e < 1) throw new RangeError("invalid entry number");
      const numbers = args.entryNumbers.map((e) => `EntryNumber eq ${e}`).join(" or ");
      const paid = args.fullyPaidOnly === true ? " and IsFullyPaid eq true" : "";
      const res = await sendOnce({
        method: "GET",
        path:
          args.kind === "receivable"
            ? EXACT_WRITE_NAMES.rest.receivablesPath
            : EXACT_WRITE_NAMES.rest.payablesPath,
        query: {
          $filter: `Account eq ${odataGuid(args.accountId)} and (${numbers})${paid}`,
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

/**
 * Probe answers: one hit per row. A further page (`__next`) means MORE lines than were shown: an
 * extra unreadable hit is added so the caller can never read a paged answer as "exactly one" or
 * "none" (review M7c).
 */
function probeHits(body: string): BankEntryLineHit[] {
  const { rows, more } = resultRows(body);
  const hits: BankEntryLineHit[] = rows.map((r) => ({
    id: str(r, "ID"),
    entryId: str(r, "EntryID"),
    entryNumber: num(r, "EntryNumber"),
    yourRef: str(r, "YourRef"),
    amountFc: str(r, "AmountFC"),
  }));
  if (more)
    hits.push({ id: null, entryId: null, entryNumber: null, yourRef: null, amountFc: null });
  return hits;
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
