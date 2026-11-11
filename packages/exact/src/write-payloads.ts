/**
 * Pure builders and parsers for the two Exact writes of bank matching (ADR 0040): a bank entry
 * (REST) and a MatchSet (XML). No I/O. Every Exact field name, endpoint and requirement here is
 * a recollection: VERIFY WITH CREDENTIALS (ADR 0040 lists them ranked, with how to check).
 */
import { currencyScale, formatMinor, maskIbans, sha256Hex } from "@camelthorn/core";
import {
  type Row,
  asRow,
  badData,
  boolField,
  intField,
  isGuid,
  minorField,
  parseJsonRawNumbers,
  strField,
  trimField,
} from "./json";
import { sanitizeForMessage } from "./redact";
import {
  type XmlMessage,
  buildXmlEnvelope,
  parseXmlResponse,
  xmlElement,
  xmlTextElement,
} from "./xml";

// ---------------------------------------------------------------------------------------------
// The one table of Exact names (all: verify with credentials)
// ---------------------------------------------------------------------------------------------

export const EXACT_WRITE_NAMES = {
  rest: {
    /** The task brief said /bookkeeping/BankEntries; our recollection is /financialtransaction. */
    bankEntryPath: "/financialtransaction/BankEntries",
    bankEntryLinePath: "/financialtransaction/BankEntryLines",
    receivablesPath: "/cashflow/Receivables",
    payablesPath: "/cashflow/Payables",
    entry: {
      journal: "Journal",
      currency: "Currency",
      financialYear: "FinancialYear",
      financialPeriod: "FinancialPeriod",
      opening: "OpeningBalanceFC",
      closing: "ClosingBalanceFC",
      lines: "BankEntryLines",
    },
    line: {
      glAccount: "GLAccount",
      account: "Account",
      amountFc: "AmountFC",
      amountDc: "AmountDC",
      date: "Date",
      description: "Description",
      ourRef: "OurRef",
      yourRef: "YourRef",
    },
    lineProbeFields: [
      "ID",
      "EntryID",
      "EntryNumber",
      "JournalCode",
      "YourRef",
      "Description",
      "AmountFC",
    ],
    openItemFields: [
      "ID",
      "Account",
      "AccountCode",
      "AmountFC",
      "Currency",
      "IsFullyPaid",
      "EntryNumber",
    ],
    idempotencyHeader: "X-Idempotency-Key",
  },
  xml: {
    topic: "MatchSets",
    matchSet: "MatchSet",
    glAccount: "GLAccount",
    account: "Account",
    codeAttr: "code",
    currency: "Currency",
    description: "Description",
    lines: "MatchLines",
    line: "MatchLine",
    entryNumber: "EntryNumber",
    transactionLineId: "TransactionLineID",
    amount: "Amount",
  },
} as const;

const HEX64_RE = /^[0-9a-f]{64}$/;
const CCY_RE = /^[A-Z]{3}$/;
const CODE_RE = /^[A-Za-z0-9._ -]{1,18}$/;
const EXT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Exact descriptions are short; the cap is a guess (verify). */
export const DESCRIPTION_MAX = 60;

// ---------------------------------------------------------------------------------------------
// Sanitising text that comes from bank data
// ---------------------------------------------------------------------------------------------

/**
 * Conservative text for an Exact field: IBAN-like strings masked, accents folded, anything outside
 * `A-Z a-z 0-9 space . , : / ( ) # & + * _ ' -` (control characters included) becomes a space,
 * whitespace collapsed, cut to `max` characters.
 */
export function sanitizeBankText(text: string, max = DESCRIPTION_MAX): string {
  const folded = maskIbans(text)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9 .,:/()#&+*_'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return folded.slice(0, Math.max(0, max)).trimEnd();
}

// ---------------------------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------------------------

/** Stable sha-256 hex of a canonical JSON array (no ambiguity from separators in values). */
function canonicalHash(parts: readonly unknown[]): string {
  return sha256Hex(JSON.stringify(parts));
}

export function bankEntryIdempotencyKey(
  connectionId: string | number,
  bankTransactionExternalId: string,
  legId: string | number,
): string {
  return canonicalHash([
    "bank-entry/v1",
    String(connectionId),
    bankTransactionExternalId,
    String(legId),
  ]);
}

export interface MatchAllocation {
  itemId: string;
  amountMinor: number;
}

/** Order of `itemIds` and `allocations` does not matter; their content does. */
export function matchSetIdempotencyKey(
  txId: string,
  itemIds: readonly string[],
  allocations: readonly MatchAllocation[],
): string {
  const ids = [...new Set(itemIds)].sort();
  const allocs = allocations
    .map((a) => [a.itemId, a.amountMinor] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return canonicalHash(["matchset/v1", txId, ids, allocs]);
}

/** OData string literal for the probe (single quotes doubled, control characters refused). */
function odataLiteral(v: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F]/.test(v)) throw new RangeError("control characters in OData string");
  return `'${v.replace(/'/g, "''")}'`;
}

export interface BankEntryProbe {
  path: string;
  query: Record<string, string>;
}

/** The OData `$filter` that finds an existing bank entry line by YourRef and journal. */
export function exactDuplicateProbeFilter(args: { journalCode: string; yourRef: string }): string {
  if (!CODE_RE.test(args.journalCode)) throw new RangeError("invalid journal code");
  if (!EXT_ID_RE.test(args.yourRef)) throw new RangeError("invalid yourRef");
  return `YourRef eq ${odataLiteral(args.yourRef)} and JournalCode eq ${odataLiteral(args.journalCode)}`;
}

/**
 * Look up an existing bank entry line by its YourRef (the Revolut transaction id) BEFORE posting,
 * so a lost response never produces a second entry. Returns the REST request to send.
 */
export function findExistingBankEntryQuery(args: {
  journalCode: string;
  yourRef: string;
}): BankEntryProbe {
  return {
    path: EXACT_WRITE_NAMES.rest.bankEntryLinePath,
    query: {
      $filter: exactDuplicateProbeFilter(args),
      $select: EXACT_WRITE_NAMES.rest.lineProbeFields.join(","),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Bank entry (REST)
// ---------------------------------------------------------------------------------------------

export interface BankEntryLineInput {
  /** Signed minor units; money in positive (sign convention: verify). Never zero. */
  amountMinor: number;
  /** Free text from the bank; sanitised, IBANs masked. */
  description: string;
  glAccountId?: string;
  accountId?: string;
  /** Bank reference text; used as the description when `description` is empty. */
  yourRef?: string;
  /** Our reference: Exact OurRef is an integer (the invoice number). */
  ourRef?: number;
  /** Becomes the line YourRef: the Revolut transaction id. */
  bankTransactionExternalId: string;
}

export interface BankEntryInput {
  journalCode: string;
  /** YYYY-MM-DD */
  entryDate: string;
  currency: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  lines: readonly BankEntryLineInput[];
  idempotencyKey: string;
  financialYear?: number;
  financialPeriod?: number;
  /** "iso" (default, YYYY-MM-DD) or "msdate" (/Date(ms)/). Which one Exact accepts: verify. */
  dateFormat?: "iso" | "msdate";
  /** When equal to `currency`, AmountDC is sent too. */
  divisionCurrency?: string;
}

export type WriteBuildError =
  | "invalid_journal"
  | "invalid_currency"
  | "invalid_date"
  | "invalid_idempotency_key"
  | "invalid_amount"
  | "invalid_balance"
  | "no_lines"
  | "zero_amount_line"
  | "invalid_external_id"
  | "duplicate_external_id"
  | "invalid_guid"
  | "invalid_ref"
  | "invalid_period"
  | "balance_mismatch";

export interface BuiltBankEntry {
  ok: true;
  body: string;
  headers: Record<string, string>;
  idempotencyKey: string;
  journalCode: string;
  /** The YourRef of every line, for the duplicate probe and the post-write check. */
  yourRefs: string[];
}
export type BuildBankEntryResult = BuiltBankEntry | { ok: false; error: WriteBuildError };

/** A number written into JSON exactly as given (no float round trip). */
class RawNumber {
  constructor(readonly text: string) {}
}

function toJson(v: unknown): string {
  if (v instanceof RawNumber) return v.text;
  if (Array.isArray(v)) return `[${v.map(toJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}:${toJson(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function validDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

export function buildBankEntryPayload(input: BankEntryInput): BuildBankEntryResult {
  const fail = (error: WriteBuildError): { ok: false; error: WriteBuildError } => ({
    ok: false,
    error,
  });
  const n = EXACT_WRITE_NAMES.rest;
  if (!CODE_RE.test(input.journalCode)) return fail("invalid_journal");
  if (!CCY_RE.test(input.currency)) return fail("invalid_currency");
  if (!validDate(input.entryDate)) return fail("invalid_date");
  if (!HEX64_RE.test(input.idempotencyKey)) return fail("invalid_idempotency_key");
  if (
    !Number.isSafeInteger(input.openingBalanceMinor) ||
    !Number.isSafeInteger(input.closingBalanceMinor)
  )
    return fail("invalid_balance");
  for (const p of [input.financialYear, input.financialPeriod]) {
    if (p !== undefined && (!Number.isSafeInteger(p) || p < 0 || p > 9999))
      return fail("invalid_period");
  }
  if (input.lines.length === 0) return fail("no_lines");
  let scale: number;
  try {
    scale = currencyScale(input.currency);
  } catch {
    return fail("invalid_currency");
  }

  let sum = 0;
  const seen = new Set<string>();
  const marker = ` #${input.idempotencyKey.slice(0, 8)}`;
  const date =
    input.dateFormat === "msdate"
      ? `/Date(${Date.parse(`${input.entryDate}T00:00:00Z`)})/`
      : input.entryDate;
  const withDc = input.divisionCurrency === input.currency;
  const lines: Record<string, unknown>[] = [];
  for (const l of input.lines) {
    if (!Number.isSafeInteger(l.amountMinor)) return fail("invalid_amount");
    if (l.amountMinor === 0) return fail("zero_amount_line");
    if (!EXT_ID_RE.test(l.bankTransactionExternalId)) return fail("invalid_external_id");
    if (seen.has(l.bankTransactionExternalId)) return fail("duplicate_external_id");
    seen.add(l.bankTransactionExternalId);
    for (const g of [l.glAccountId, l.accountId]) {
      if (g !== undefined && !isGuid(g)) return fail("invalid_guid");
    }
    if (l.ourRef !== undefined && (!Number.isSafeInteger(l.ourRef) || l.ourRef < 0))
      return fail("invalid_ref");
    sum += l.amountMinor;
    if (!Number.isSafeInteger(sum)) return fail("invalid_amount");
    const text =
      sanitizeBankText(l.description) || sanitizeBankText(l.yourRef ?? "") || "Bank line";
    const amount = new RawNumber(formatMinor(l.amountMinor, scale));
    lines.push({
      [n.line.glAccount]: l.glAccountId?.toLowerCase(),
      [n.line.account]: l.accountId?.toLowerCase(),
      [n.line.amountFc]: amount,
      [n.line.amountDc]: withDc ? amount : undefined,
      [n.line.date]: date,
      [n.line.description]: sanitizeBankText(text, DESCRIPTION_MAX - marker.length) + marker,
      [n.line.ourRef]: l.ourRef === undefined ? undefined : new RawNumber(String(l.ourRef)),
      [n.line.yourRef]: l.bankTransactionExternalId,
    });
  }
  if (input.closingBalanceMinor - input.openingBalanceMinor !== sum)
    return fail("balance_mismatch");

  const body = toJson({
    [n.entry.journal]: input.journalCode,
    [n.entry.currency]: input.currency,
    [n.entry.financialYear]:
      input.financialYear === undefined ? undefined : new RawNumber(String(input.financialYear)),
    [n.entry.financialPeriod]:
      input.financialPeriod === undefined
        ? undefined
        : new RawNumber(String(input.financialPeriod)),
    [n.entry.opening]: new RawNumber(formatMinor(input.openingBalanceMinor, scale)),
    [n.entry.closing]: new RawNumber(formatMinor(input.closingBalanceMinor, scale)),
    [n.entry.lines]: lines,
  });
  return {
    ok: true,
    body,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      [n.idempotencyHeader]: input.idempotencyKey,
    },
    idempotencyKey: input.idempotencyKey,
    journalCode: input.journalCode,
    yourRefs: input.lines.map((l) => l.bankTransactionExternalId),
  };
}

// ---------------------------------------------------------------------------------------------
// MatchSet (XML)
// ---------------------------------------------------------------------------------------------

export interface MatchLineInput {
  /** Exactly one of entryNumber or transactionLineId. */
  entryNumber?: number;
  transactionLineId?: string;
  /** Signed minor units in `currency`: invoice positive, payment negative (or the reverse). */
  amountMinor: number;
}

export interface MatchSetInput {
  glAccountCode: string;
  /** Relation (account) code. */
  relationCode: string;
  currency: string;
  lines: readonly MatchLineInput[];
  reference: string;
}

export type MatchSetBuildError =
  | "invalid_gl_account"
  | "invalid_relation"
  | "invalid_currency"
  | "too_few_lines"
  | "invalid_line"
  | "duplicate_line"
  | "invalid_amount"
  | "partial_match_not_supported_v1"
  | "invalid_reference";

export type BuildMatchSetResult =
  { ok: true; xml: string; topic: string } | { ok: false; error: MatchSetBuildError };

export function buildMatchSetXml(input: MatchSetInput): BuildMatchSetResult {
  const fail = (error: MatchSetBuildError): { ok: false; error: MatchSetBuildError } => ({
    ok: false,
    error,
  });
  const x = EXACT_WRITE_NAMES.xml;
  if (!CODE_RE.test(input.glAccountCode.trim())) return fail("invalid_gl_account");
  if (!CODE_RE.test(input.relationCode.trim())) return fail("invalid_relation");
  if (!CCY_RE.test(input.currency)) return fail("invalid_currency");
  if (input.lines.length < 2) return fail("too_few_lines");
  let scale: number;
  try {
    scale = currencyScale(input.currency);
  } catch {
    return fail("invalid_currency");
  }
  const reference = sanitizeBankText(input.reference);
  if (reference === "") return fail("invalid_reference");

  const seen = new Set<string>();
  let sum = 0;
  const rows: { key: string; xml: string; amount: number }[] = [];
  for (const l of input.lines) {
    const entryNumber = l.entryNumber;
    const lineId = l.transactionLineId;
    if ((entryNumber === undefined) === (lineId === undefined)) return fail("invalid_line");
    let key: string;
    let ref: string;
    if (entryNumber !== undefined) {
      if (!Number.isSafeInteger(entryNumber) || entryNumber < 1) return fail("invalid_line");
      key = `e:${String(entryNumber).padStart(12, "0")}`;
      ref = xmlTextElement(x.entryNumber, String(entryNumber));
    } else {
      if (lineId === undefined || !isGuid(lineId)) return fail("invalid_line");
      key = `t:${lineId.toLowerCase()}`;
      ref = xmlTextElement(x.transactionLineId, lineId.toLowerCase());
    }
    if (seen.has(key)) return fail("duplicate_line");
    seen.add(key);
    if (!Number.isSafeInteger(l.amountMinor) || l.amountMinor === 0) return fail("invalid_amount");
    sum += l.amountMinor;
    if (!Number.isSafeInteger(sum)) return fail("invalid_amount");
    rows.push({
      key,
      amount: l.amountMinor,
      xml: xmlElement(
        x.line,
        {},
        ref + xmlTextElement(x.amount, formatMinor(l.amountMinor, scale)),
      ),
    });
  }
  // v1: full matches only. A part payment needs Exact's remainder handling (ADR 0040).
  if (sum !== 0) return fail("partial_match_not_supported_v1");
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.amount - b.amount));

  const set = xmlElement(
    x.matchSet,
    {},
    xmlElement(x.glAccount, { [x.codeAttr]: input.glAccountCode.trim() }) +
      xmlElement(x.account, { [x.codeAttr]: input.relationCode.trim() }) +
      xmlElement(x.currency, { [x.codeAttr]: input.currency }) +
      xmlTextElement(x.description, reference) +
      xmlElement(x.lines, {}, rows.map((r) => r.xml).join("")),
  );
  return { ok: true, xml: buildXmlEnvelope(xmlElement(x.topic, {}, set)), topic: x.topic };
}

// ---------------------------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------------------------

export type BankEntryResponse =
  | {
      ok: true;
      entryId: string;
      entryNumber: number | null;
      status: string | null;
      lineYourRefs: string[];
    }
  | { ok: false; error: "bad_response" | "exact_error" | "missing_entry_id" };

/** Parse the JSON answer of the bank entry POST. Never throws; anything unclear is a failure. */
export function parseBankEntryResponse(json: string): BankEntryResponse {
  try {
    const root = asRow(parseJsonRawNumbers(json));
    if (root["error"] !== undefined) return { ok: false, error: "exact_error" };
    const d = asRow(root["d"]);
    const id = strField(d, "EntryID");
    if (id === null || !isGuid(id)) return { ok: false, error: "missing_entry_id" };
    const lines = d["BankEntryLines"];
    const results = Array.isArray(lines)
      ? lines
      : typeof lines === "object" && lines !== null
        ? ((lines as Row)["results"] as unknown)
        : undefined;
    const refs: string[] = [];
    if (Array.isArray(results)) {
      for (const r of results) {
        const y = trimField(asRow(r), "YourRef");
        if (y !== null) refs.push(y);
      }
    }
    const st = d["Status"];
    return {
      ok: true,
      entryId: id.toLowerCase(),
      entryNumber: intField(d, "EntryNumber"),
      status: typeof st === "string" ? st : null,
      lineYourRefs: refs,
    };
  } catch {
    return { ok: false, error: "bad_response" };
  }
}

export interface MatchSetResponse {
  /**
   * Exact answered with a clearly positive message and no warning, error or fatal one. This is NOT
   * proof of a match: the message type codes are unverified (ADR 0014 item 13). Always read back.
   */
  accepted: boolean;
  readBackRequired: true;
  error?: "bad_xml" | "no_success_message" | "exact_reported_problem";
  messages: XmlMessage[];
}

export function parseMatchSetResponse(xml: string): MatchSetResponse {
  let parsed;
  try {
    parsed = parseXmlResponse(xml);
  } catch {
    return { accepted: false, readBackRequired: true, error: "bad_xml", messages: [] };
  }
  const messages = parsed.messages.map((m) => ({
    severity: m.severity,
    description: sanitizeForMessage(m.description, 200),
  }));
  if (messages.some((m) => m.severity !== "info"))
    return { accepted: false, readBackRequired: true, error: "exact_reported_problem", messages };
  if (messages.length === 0)
    return { accepted: false, readBackRequired: true, error: "no_success_message", messages };
  return { accepted: true, readBackRequired: true, messages };
}

// ---------------------------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------------------------

export interface OpenItemLineRow {
  id: string;
  entryNumber: number | null;
  /** OPEN amount, signed, minor units of `currency`. */
  openAmountMinor: number;
  currency: string;
  isFullyPaid: boolean;
}

export interface ExpectedMatchLine {
  entryNumber?: number;
  transactionLineId?: string;
  currency: string;
}

export type ReadBackProblem = "missing" | "ambiguous" | "still_open" | "currency_mismatch";

export type ReadBackVerdict =
  { verified: true } | { verified: false; problems: { index: number; reason: ReadBackProblem }[] };

/**
 * True only when EVERY expected line is found exactly once and has nothing open. A missing row is
 * a failure, not a match (a list may drop fully paid items or the read may have been too narrow).
 * `isFullyPaid` alone is not trusted: the open amount must be zero too.
 */
export function verifyMatchSetApplied(
  rows: readonly OpenItemLineRow[],
  expected: readonly ExpectedMatchLine[],
): ReadBackVerdict {
  if (expected.length === 0)
    return { verified: false, problems: [{ index: -1, reason: "missing" }] };
  const problems: { index: number; reason: ReadBackProblem }[] = [];
  expected.forEach((e, index) => {
    const found = rows.filter((r) =>
      e.transactionLineId !== undefined
        ? r.id.toLowerCase() === e.transactionLineId.toLowerCase()
        : e.entryNumber !== undefined && r.entryNumber === e.entryNumber,
    );
    const row = found[0];
    if (row === undefined) problems.push({ index, reason: "missing" });
    else if (found.length > 1) problems.push({ index, reason: "ambiguous" });
    else if (row.currency !== e.currency) problems.push({ index, reason: "currency_mismatch" });
    else if (row.openAmountMinor !== 0) problems.push({ index, reason: "still_open" });
  });
  return problems.length === 0 ? { verified: true } : { verified: false, problems };
}

/** Map a cashflow read-back row. Throws ExactApiError BAD_SHAPE on unusable data. */
export function mapOpenItemLineRow(r: Row): OpenItemLineRow {
  const id = strField(r, "ID");
  const ccy = trimField(r, "Currency")?.toUpperCase() ?? null;
  if (id === null || ccy === null || !CCY_RE.test(ccy))
    throw badData("Unexpected read-back row", "BAD_SHAPE");
  const open = minorField(r, "AmountFC", ccy);
  if (open === null) throw badData("Unexpected read-back row", "BAD_SHAPE");
  return {
    id,
    entryNumber: intField(r, "EntryNumber"),
    openAmountMinor: open,
    currency: ccy,
    isFullyPaid: boolField(r, "IsFullyPaid"),
  };
}
