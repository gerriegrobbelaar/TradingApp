/**
 * Pure builders and parsers for the two Exact writes of bank matching (ADR 0040): a bank entry
 * (REST) and a MatchSet (XML). No I/O. Every Exact field name, endpoint and requirement here is
 * a recollection: VERIFY WITH CREDENTIALS (ADR 0040 lists them ranked, with how to check).
 *
 * Built payloads are frozen and branded (write-brand.ts): the writer sends only objects that
 * came out of these builders, for the division they were built for.
 */
import {
  currencyScale,
  formatMinor,
  hasValidIbanChecksum,
  maskIban,
  maskIbans,
  sha256Hex,
} from "@camelthorn/core";
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
import { brandBuilt } from "./write-brand";
import {
  type XmlMessage,
  buildXmlEnvelope,
  parseXmlResponse,
  xmlElement,
  xmlEscape,
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
    /** Fields of the latest-entry read that gives the next entry's opening balance (A12, VERIFY). */
    bankEntryBalanceFields: ["EntryNumber", "JournalCode", "ClosingBalanceFC", "Currency"],
    openItemFields: [
      "ID",
      "Account",
      "AccountCode",
      "AmountFC",
      "Currency",
      "IsFullyPaid",
      "EntryNumber",
    ],
  },
  xml: {
    uploadPath: "/docs/XMLUpload.aspx",
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

/**
 * Sign convention of bank entry line amounts (ADR 0040 assumption 3, VERIFY): money IN to the bank
 * account is positive (a receipt), money OUT is negative (a payment), seen from the bank account,
 * which is how Exact's bank entry screen and statement imports present them. The builder does not
 * flip signs: `amountMinor` is the bank transaction's own signed amount.
 */
export const BANK_ENTRY_SIGN = "money_in_positive" as const;

const HEX64_RE = /^[0-9a-f]{64}$/;
const CCY_RE = /^[A-Z]{3}$/;
const CODE_RE = /^[A-Za-z0-9._ -]{1,18}$/;
const EXT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Exact EntryNumber and OurRef are 32-bit integers (verify). */
const INT32_MAX = 2_147_483_647;

/** Exact descriptions are short; the cap is a guess (verify). */
export const DESCRIPTION_MAX = 60;
/** Exact YourRef cap is a guess (verify). Revolut ids are 36 characters. */
export const YOUR_REF_MAX = 40;
/** Text from the bank is cut to this before any processing (keeps the IBAN scan cheap). */
const RAW_TEXT_MAX = 2000;
/** Larger answers are not what these endpoints return: refused before parsing. */
export const MAX_WRITE_RESPONSE_CHARS = 1_000_000;

// ---------------------------------------------------------------------------------------------
// Sanitising text that comes from bank data
// ---------------------------------------------------------------------------------------------

/**
 * Second IBAN pass over the already reduced text: a run of letters/digits joined by `-./_`
 * ("NL91-ABNA-0417-1643-00") or glued to a word ("toNL91ABNA0417164300") is not seen by
 * maskIbans. Any 15-34 character window of the compacted run that starts with two letters and
 * two digits and passes the mod-97 check masks the whole run. Over-masking (about 1 in 97 per
 * window on long codes) is the safe direction.
 */
function maskHiddenIbans(text: string): string {
  return text.replace(/[A-Za-z0-9]+(?:[-./_][A-Za-z0-9]+)*/g, (run) => {
    const compact = run.replace(/[-./_]/g, "").toUpperCase();
    if (compact.length < 15) return run;
    for (let i = 0; i + 15 <= compact.length; i++) {
      if (!/^[A-Z]{2}\d{2}/.test(compact.slice(i, i + 4))) continue;
      for (let len = 15; len <= 34 && i + len <= compact.length; len++) {
        const candidate = compact.slice(i, i + len);
        if (hasValidIbanChecksum(candidate)) return maskIban(candidate);
      }
    }
    return run;
  });
}

/**
 * Conservative text for an Exact field: compatibility-normalised (full-width digits become
 * ASCII), control characters removed, IBAN-like strings masked (spaced, lower case, joined by
 * punctuation or glued to a word), accents folded, anything outside
 * `A-Z a-z 0-9 space . , : / ( ) # & + * _ ' -` becomes a space, whitespace collapsed, cut to
 * `max` characters. The cut runs after masking, so it can never expose a hidden IBAN.
 */
export function sanitizeBankText(text: string, max = DESCRIPTION_MAX): string {
  const reduced = text
    .slice(0, RAW_TEXT_MAX)
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9 .,:/()#&+*_'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const masked = maskHiddenIbans(maskIbans(reduced));
  return masked.slice(0, Math.max(0, max)).trimEnd();
}

// ---------------------------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------------------------

/** Stable sha-256 hex of a canonical JSON array (no ambiguity from separators in values). */
function canonicalHash(parts: readonly unknown[]): string {
  return sha256Hex(JSON.stringify(parts));
}

function assertKeyPart(v: string | number, what: string): string {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new RangeError(`${what} must be a safe integer`);
    return String(v);
  }
  if (typeof v !== "string" || v === "") throw new RangeError(`${what} is required`);
  return v;
}

export function bankEntryIdempotencyKey(
  connectionId: string | number,
  bankTransactionExternalId: string,
  legId: string | number,
): string {
  return canonicalHash([
    "bank-entry/v1",
    assertKeyPart(connectionId, "connectionId"),
    assertKeyPart(bankTransactionExternalId, "bankTransactionExternalId"),
    assertKeyPart(legId, "legId"),
  ]);
}

export interface MatchAllocation {
  itemId: string;
  amountMinor: number;
}

/**
 * Order of `itemIds` and `allocations` does not matter; their content does (any amount change
 * gives a new key). Amounts must be safe integers: NaN and Infinity would both serialise as
 * `null` and collide.
 */
export function matchSetIdempotencyKey(
  txId: string,
  itemIds: readonly string[],
  allocations: readonly MatchAllocation[],
): string {
  assertKeyPart(txId, "txId");
  for (const id of itemIds) assertKeyPart(id, "itemId");
  for (const a of allocations) {
    assertKeyPart(a.itemId, "itemId");
    if (!Number.isSafeInteger(a.amountMinor))
      throw new RangeError("amountMinor must be a safe integer");
  }
  const ids = [...new Set(itemIds)].sort();
  const allocs = allocations
    .map((a) => [a.itemId, a.amountMinor] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return canonicalHash(["matchset/v1", txId, ids, allocs]);
}

/**
 * Deterministic short YourRef for one bank line, for when Exact's YourRef is too short for the
 * 36-character Revolut id: `CT` + base36 of the first 48 bits of sha-256 of the external id (at
 * most 12 characters). Depends on the external id only, so the probe can recompute it. A
 * collision (about n^2 / 2^49) makes the probe see a line that is not ours: the worker then
 * stops for a manual check, it never books twice.
 */
export function bankLineShortRef(bankTransactionExternalId: string): string {
  if (!EXT_ID_RE.test(bankTransactionExternalId)) throw new RangeError("invalid external id");
  const hex = canonicalHash(["bank-line-ref/v1", bankTransactionExternalId]).slice(0, 12);
  return `CT${BigInt(`0x${hex}`).toString(36).toUpperCase()}`;
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
 * Look up an existing bank entry line by its YourRef (the Revolut transaction id, or its short
 * ref) BEFORE posting, so a lost response never produces a second entry. Uniqueness ACROSS
 * entries is the worker's job: this probe plus a unique key on the bank transaction in D1. The
 * builder only rejects a duplicate inside one entry.
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

/**
 * Probe for a bank line that ANOTHER system created (Revolut's own Exact feed, ADR 0040 / M7c): the
 * journal, the exact signed amount and a date window. Several hits are ambiguous (the booker stops
 * for a person). VERIFY (A13): that `Date` is filterable with `datetime'..'` and that the feed
 * leaves the line in the journal we mapped.
 */
export function findBankLineByAmountQuery(args: {
  journalCode: string;
  amountMinor: number;
  currency: string;
  /** YYYY-MM-DD, inclusive. */
  dateFrom: string;
  dateTo: string;
}): BankEntryProbe {
  if (!CODE_RE.test(args.journalCode)) throw new RangeError("invalid journal code");
  if (!CCY_RE.test(args.currency)) throw new RangeError("invalid currency");
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor === 0)
    throw new RangeError("invalid amount");
  if (!validDate(args.dateFrom) || !validDate(args.dateTo) || args.dateFrom > args.dateTo)
    throw new RangeError("invalid date window");
  const amount = formatMinor(args.amountMinor, currencyScale(args.currency));
  return {
    path: EXACT_WRITE_NAMES.rest.bankEntryLinePath,
    query: {
      $filter:
        `JournalCode eq ${odataLiteral(args.journalCode)} and AmountFC eq ${amount}` +
        ` and Date ge datetime'${args.dateFrom}T00:00:00' and Date le datetime'${args.dateTo}T23:59:59'`,
      $select: EXACT_WRITE_NAMES.rest.lineProbeFields.join(","),
      $top: "5",
    },
  };
}

/** The latest bank entry of a journal: its closing balance is the next entry's opening balance. */
export function latestBankEntryQuery(journalCode: string): BankEntryProbe {
  if (!CODE_RE.test(journalCode)) throw new RangeError("invalid journal code");
  return {
    path: EXACT_WRITE_NAMES.rest.bankEntryPath,
    query: {
      $filter: `JournalCode eq ${odataLiteral(journalCode)}`,
      $select: EXACT_WRITE_NAMES.rest.bankEntryBalanceFields.join(","),
      $orderby: "EntryNumber desc",
      $top: "1",
    },
  };
}

/**
 * Closing balance of the latest entry (minor units), or null when it cannot be determined: no
 * entry, a currency other than `currency`, an unreadable amount. Never guesses zero.
 */
export function parseLatestClosingBalance(rows: readonly Row[], currency: string): number | null {
  if (rows.length !== 1) return null;
  const r = rows[0] as Row;
  try {
    const ccy = trimField(r, "Currency")?.toUpperCase();
    if (ccy !== currency) return null;
    return minorField(r, "ClosingBalanceFC", currency);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Bank entry (REST)
// ---------------------------------------------------------------------------------------------

export interface BankEntryLineInput {
  /** Signed minor units of the bank transaction: money in positive (BANK_ENTRY_SIGN). Never 0. */
  amountMinor: number;
  /** Free text from the bank; sanitised, IBANs masked. */
  description: string;
  /** At least one of glAccountId / accountId. */
  glAccountId?: string;
  accountId?: string;
  /** Bank reference text; used as the description when `description` is empty. */
  yourRef?: string;
  /** Our reference: Exact OurRef is an integer (the invoice number). */
  ourRef?: number;
  /** The Revolut transaction id: the line YourRef (or its short ref, see `yourRefMode`). */
  bankTransactionExternalId: string;
}

export interface BankEntryInput {
  /** The Exact division the GUIDs belong to; the writer refuses any other division. */
  division: number;
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
  /**
   * "external_id" (default): YourRef is the external id (at most YOUR_REF_MAX characters).
   * "short": YourRef is bankLineShortRef(external id), when Exact's field turns out shorter.
   */
  yourRefMode?: "external_id" | "short";
}

export type WriteBuildError =
  | "invalid_division"
  | "invalid_journal"
  | "invalid_currency"
  | "invalid_date"
  | "invalid_idempotency_key"
  | "invalid_amount"
  | "invalid_balance"
  | "no_lines"
  | "zero_amount_line"
  | "invalid_external_id"
  | "external_id_too_long"
  | "duplicate_external_id"
  | "invalid_guid"
  | "missing_account"
  | "invalid_ref"
  | "invalid_period"
  | "balance_mismatch";

export interface BuiltBankEntryLine {
  externalId: string;
  /** The YourRef actually sent (external id or short ref): probe with this. */
  yourRef: string;
  shortRef: string;
}

export interface BuiltBankEntry {
  readonly ok: true;
  readonly division: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  readonly journalCode: string;
  /** The YourRef of every line as sent, for the duplicate probe and the post-write check. */
  readonly yourRefs: readonly string[];
  readonly lines: readonly Readonly<BuiltBankEntryLine>[];
}
export type BuildBankEntryResult = BuiltBankEntry | { ok: false; error: WriteBuildError };

const DECIMAL_TEXT_RE = /^-?\d+(?:\.\d+)?$/;

/** A number written into JSON exactly as given (no float round trip). */
class RawNumber {
  constructor(readonly text: string) {
    if (!DECIMAL_TEXT_RE.test(text)) throw new RangeError("not a plain decimal");
  }
}

/** JSON writer; every string and key goes through JSON.stringify (no hand-made escaping). */
function toJson(v: unknown): string {
  if (v instanceof RawNumber) return v.text;
  if (Array.isArray(v)) return `[${v.map(toJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}:${toJson(x)}`)
      .join(",")}}`;
  }
  if (typeof v === "number") throw new RangeError("numbers must be RawNumber");
  return JSON.stringify(v);
}

function validDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

function validDivision(d: number): boolean {
  return Number.isSafeInteger(d) && d >= 1;
}

export function buildBankEntryPayload(input: BankEntryInput): BuildBankEntryResult {
  const fail = (error: WriteBuildError): { ok: false; error: WriteBuildError } => ({
    ok: false,
    error,
  });
  const n = EXACT_WRITE_NAMES.rest;
  if (!validDivision(input.division)) return fail("invalid_division");
  if (!CODE_RE.test(input.journalCode)) return fail("invalid_journal");
  if (!CCY_RE.test(input.currency)) return fail("invalid_currency");
  if (input.divisionCurrency !== undefined && !CCY_RE.test(input.divisionCurrency))
    return fail("invalid_currency");
  if (!validDate(input.entryDate)) return fail("invalid_date");
  if (!HEX64_RE.test(input.idempotencyKey)) return fail("invalid_idempotency_key");
  if (
    !Number.isSafeInteger(input.openingBalanceMinor) ||
    !Number.isSafeInteger(input.closingBalanceMinor)
  )
    return fail("invalid_balance");
  if (
    input.financialYear !== undefined &&
    (!Number.isSafeInteger(input.financialYear) ||
      input.financialYear < 1900 ||
      input.financialYear > 9999)
  )
    return fail("invalid_period");
  if (
    input.financialPeriod !== undefined &&
    (!Number.isSafeInteger(input.financialPeriod) ||
      input.financialPeriod < 1 ||
      input.financialPeriod > 99)
  )
    return fail("invalid_period");
  if (input.lines.length === 0) return fail("no_lines");
  const scale = currencyScale(input.currency); // CCY_RE checked above: cannot throw
  const short = input.yourRefMode === "short";

  // Sums in BigInt: exact for any number of safe-integer lines.
  let sum = 0n;
  const seen = new Set<string>();
  const marker = ` #${input.idempotencyKey.slice(0, 8)}`;
  const date =
    input.dateFormat === "msdate"
      ? `/Date(${Date.parse(`${input.entryDate}T00:00:00Z`)})/`
      : input.entryDate;
  const withDc = input.divisionCurrency === input.currency;
  const lines: Record<string, unknown>[] = [];
  const builtLines: Readonly<BuiltBankEntryLine>[] = [];
  for (const l of input.lines) {
    if (!Number.isSafeInteger(l.amountMinor)) return fail("invalid_amount");
    if (l.amountMinor === 0) return fail("zero_amount_line");
    const ext = l.bankTransactionExternalId;
    if (typeof ext !== "string" || !EXT_ID_RE.test(ext)) return fail("invalid_external_id");
    if (!short && ext.length > YOUR_REF_MAX) return fail("external_id_too_long");
    // Exact's OData string comparison is very likely case-insensitive: compare that way too.
    if (seen.has(ext.toLowerCase())) return fail("duplicate_external_id");
    seen.add(ext.toLowerCase());
    if (l.glAccountId === undefined && l.accountId === undefined) return fail("missing_account");
    for (const g of [l.glAccountId, l.accountId]) {
      if (g !== undefined && !isGuid(g)) return fail("invalid_guid");
    }
    if (
      l.ourRef !== undefined &&
      (!Number.isSafeInteger(l.ourRef) || l.ourRef < 0 || l.ourRef > INT32_MAX)
    )
      return fail("invalid_ref");
    sum += BigInt(l.amountMinor);
    const shortRef = bankLineShortRef(ext);
    const yourRef = short ? shortRef : ext;
    builtLines.push(Object.freeze({ externalId: ext, yourRef, shortRef }));
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
      [n.line.yourRef]: yourRef,
    });
  }
  if (BigInt(input.closingBalanceMinor) - BigInt(input.openingBalanceMinor) !== sum)
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
  return brandBuilt<BuiltBankEntry>({
    ok: true,
    division: input.division,
    body,
    // No idempotency header: ExactGate allows only content-type/accept/prefer/if-* headers, and
    // Exact has no idempotency support we know of. The key is stored by the worker instead.
    headers: Object.freeze({ "Content-Type": "application/json", Accept: "application/json" }),
    idempotencyKey: input.idempotencyKey,
    journalCode: input.journalCode,
    yourRefs: Object.freeze(builtLines.map((l) => l.yourRef)),
    lines: Object.freeze(builtLines),
  });
}

// ---------------------------------------------------------------------------------------------
// MatchSet (XML)
// ---------------------------------------------------------------------------------------------

export interface MatchLineInput {
  /** Exactly one of entryNumber or transactionLineId. */
  entryNumber?: number;
  transactionLineId?: string;
  /** Currency of the item; must equal the set's currency (a MatchSet never mixes currencies). */
  currency: string;
  /** Signed minor units in `currency`: invoice positive, payment negative (or the reverse). */
  amountMinor: number;
}

export interface MatchSetInput {
  /** The Exact division the lines belong to; the writer refuses any other division. */
  division: number;
  glAccountCode: string;
  /** Relation (account) code. */
  relationCode: string;
  currency: string;
  lines: readonly MatchLineInput[];
  reference: string;
}

export type MatchSetBuildError =
  | "invalid_division"
  | "invalid_gl_account"
  | "invalid_relation"
  | "invalid_currency"
  | "mixed_currency"
  | "too_few_lines"
  | "invalid_line"
  | "duplicate_line"
  | "invalid_amount"
  | "partial_match_not_supported_v1"
  | "invalid_reference";

export interface BuiltMatchSet {
  readonly ok: true;
  readonly division: number;
  readonly xml: string;
  readonly topic: string;
}

export type BuildMatchSetResult = BuiltMatchSet | { ok: false; error: MatchSetBuildError };

/**
 * A full-match MatchSet document. Lines are sorted by their identity so the output is
 * byte-identical under any input order. Note: the same Exact line given once by entry number and
 * once by transaction line id cannot be detected here (different identifiers); callers use one
 * identifier kind per item.
 */
export function buildMatchSetXml(input: MatchSetInput): BuildMatchSetResult {
  const fail = (error: MatchSetBuildError): { ok: false; error: MatchSetBuildError } => ({
    ok: false,
    error,
  });
  const x = EXACT_WRITE_NAMES.xml;
  if (!validDivision(input.division)) return fail("invalid_division");
  if (!CODE_RE.test(input.glAccountCode.trim())) return fail("invalid_gl_account");
  if (!CODE_RE.test(input.relationCode.trim())) return fail("invalid_relation");
  if (!CCY_RE.test(input.currency)) return fail("invalid_currency");
  if (input.lines.length < 2) return fail("too_few_lines");
  const scale = currencyScale(input.currency); // CCY_RE checked above: cannot throw
  const reference = sanitizeBankText(input.reference);
  if (reference === "") return fail("invalid_reference");

  const seen = new Set<string>();
  let sum = 0n;
  const rows: { key: string; xml: string }[] = [];
  for (const l of input.lines) {
    if (l.currency !== input.currency) return fail("mixed_currency");
    const entryNumber = l.entryNumber;
    const lineId = l.transactionLineId;
    if ((entryNumber === undefined) === (lineId === undefined)) return fail("invalid_line");
    let key: string;
    let ref: string;
    if (entryNumber !== undefined) {
      if (!Number.isSafeInteger(entryNumber) || entryNumber < 1 || entryNumber > INT32_MAX)
        return fail("invalid_line");
      key = `e:${String(entryNumber).padStart(10, "0")}`;
      ref = xmlTextElement(x.entryNumber, String(entryNumber));
    } else {
      if (typeof lineId !== "string" || !isGuid(lineId)) return fail("invalid_line");
      key = `t:${lineId.toLowerCase()}`;
      ref = xmlTextElement(x.transactionLineId, lineId.toLowerCase());
    }
    if (seen.has(key)) return fail("duplicate_line");
    seen.add(key);
    if (!Number.isSafeInteger(l.amountMinor) || l.amountMinor === 0) return fail("invalid_amount");
    sum += BigInt(l.amountMinor);
    rows.push({
      key,
      xml: xmlElement(
        x.line,
        {},
        ref + xmlTextElement(x.amount, formatMinor(l.amountMinor, scale)),
      ),
    });
  }
  // v1: full matches only. A part payment needs Exact's remainder handling (ADR 0040).
  if (sum !== 0n) return fail("partial_match_not_supported_v1");
  // Keys are unique (checked above), so this order is total and input-order independent.
  rows.sort((a, b) => (a.key < b.key ? -1 : 1));

  const set = xmlElement(
    x.matchSet,
    {},
    xmlElement(x.glAccount, { [x.codeAttr]: input.glAccountCode.trim() }) +
      xmlElement(x.account, { [x.codeAttr]: input.relationCode.trim() }) +
      xmlElement(x.currency, { [x.codeAttr]: input.currency }) +
      xmlTextElement(x.description, reference) +
      xmlElement(x.lines, {}, rows.map((r) => r.xml).join("")),
  );
  return brandBuilt<BuiltMatchSet>({
    ok: true,
    division: input.division,
    xml: buildXmlEnvelope(xmlElement(x.topic, {}, set)),
    topic: x.topic,
  });
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
  | {
      ok: false;
      error: "bad_response" | "exact_error" | "missing_entry_id" | "line_mismatch";
      /**
       * Always true: this parser only sees 2xx answers, so Exact may have booked the entry.
       * The worker must run the duplicate probe; it must never re-post on this result.
       */
      outcomeUnknown: true;
    };

/**
 * Parse the JSON answer of the bank entry POST. Never throws; anything unclear is a failure.
 * When `expectedYourRefs` is given and the answer lists its lines, the line references must be
 * exactly the ones sent.
 */
export function parseBankEntryResponse(
  json: string,
  expectedYourRefs?: readonly string[],
): BankEntryResponse {
  const fail = (error: "bad_response" | "exact_error" | "missing_entry_id" | "line_mismatch") =>
    ({ ok: false, error, outcomeUnknown: true }) as const;
  if (typeof json !== "string" || json.length > MAX_WRITE_RESPONSE_CHARS)
    return fail("bad_response");
  try {
    const root = asRow(parseJsonRawNumbers(json));
    if (root["error"] !== undefined) return fail("exact_error");
    const d = asRow(root["d"]);
    const id = strField(d, "EntryID");
    if (id === null || !isGuid(id)) return fail("missing_entry_id");
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
    if (expectedYourRefs !== undefined && Array.isArray(results)) {
      const want = [...expectedYourRefs].map((s) => s.toLowerCase()).sort();
      const got = refs.map((s) => s.toLowerCase()).sort();
      if (want.length !== got.length || want.some((w, i) => w !== got[i]))
        return fail("line_mismatch");
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
    return fail("bad_response");
  }
}

export interface MatchSetResponse {
  /**
   * Exact answered with at least one positive message and no warning, error, fatal or unknown
   * one. This is NOT proof of a match: the message type codes are unverified (ADR 0014 item 13).
   * Always read back.
   */
  accepted: boolean;
  readBackRequired: true;
  error?: "bad_xml" | "no_success_message" | "exact_reported_problem";
  /** Descriptions are redacted (IBANs masked) and capped. */
  messages: XmlMessage[];
}

export function parseMatchSetResponse(xml: string): MatchSetResponse {
  const bad: MatchSetResponse = {
    accepted: false,
    readBackRequired: true,
    error: "bad_xml",
    messages: [],
  };
  if (typeof xml !== "string" || xml.length > MAX_WRITE_RESPONSE_CHARS) return bad;
  let parsed;
  try {
    parsed = parseXmlResponse(xml);
  } catch {
    return bad;
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
  /** The open amount of this item BEFORE the MatchSet, as read for building it. */
  openBeforeMinor: number;
}

export type ReadBackLineState =
  | "closed"
  | "open_unchanged"
  | "missing"
  | "missing_needs_second_query"
  | "ambiguous"
  | "currency_mismatch"
  | "contradictory"
  | "unexpected_open_amount"
  | "no_identifier";

export type ReadBackVerdict =
  | { outcome: "verified" }
  | { outcome: "not_applied" }
  | {
      outcome: "inconclusive";
      /** Per expected line (index into `expected`); "partially_applied" at index -1. */
      problems: {
        index: number;
        reason: Exclude<ReadBackLineState, "closed"> | "partially_applied" | "nothing_expected";
      }[];
    };

function findRows(rows: readonly OpenItemLineRow[], e: ExpectedMatchLine): OpenItemLineRow[] {
  if (e.transactionLineId !== undefined) {
    const id = e.transactionLineId.toLowerCase();
    return rows.filter((r) => r.id.toLowerCase() === id);
  }
  return rows.filter((r) => r.entryNumber === e.entryNumber);
}

function rowState(row: OpenItemLineRow, e: ExpectedMatchLine): ReadBackLineState {
  if (row.currency !== e.currency) return "currency_mismatch";
  if (row.openAmountMinor === 0) return row.isFullyPaid ? "closed" : "contradictory";
  if (row.isFullyPaid) return "contradictory";
  return row.openAmountMinor === e.openBeforeMinor ? "open_unchanged" : "unexpected_open_amount";
}

function lineState(
  e: ExpectedMatchLine,
  primary: readonly OpenItemLineRow[],
  fullyPaid: readonly OpenItemLineRow[] | undefined,
): ReadBackLineState {
  if (e.transactionLineId === undefined && e.entryNumber === undefined) return "no_identifier";
  const found = findRows(primary, e);
  if (found.length > 1) return "ambiguous";
  const row = found[0];
  if (row !== undefined) return rowState(row, e);
  // Absent from the first read: a fully matched item may drop out of the list, or the read may
  // have been too narrow. Never decide from absence alone: ask the second read.
  if (fullyPaid === undefined) return "missing_needs_second_query";
  const paid = findRows(fullyPaid, e);
  if (paid.length > 1) return "ambiguous";
  const p = paid[0];
  if (p === undefined) return "missing";
  const s = rowState(p, e);
  // The second read asked for fully paid rows only: anything but "closed" there is a contradiction.
  return s === "closed" || s === "currency_mismatch" ? s : "contradictory";
}

/**
 * Was the MatchSet applied? Three outcomes, `inconclusive` the fallback for anything not proven:
 *  - verified:     every expected line is found exactly once (in `primary`, or, when absent
 *                  there, in `fullyPaid`) with open amount 0 AND flagged fully paid.
 *  - not_applied:  every expected line is found exactly once in `primary`, still open with exactly
 *                  its amount from before the MatchSet. Only then may the worker consider a new
 *                  attempt (with the SAME idempotency key).
 *  - inconclusive: anything else (missing, duplicate rows, currency or flag contradictions, open
 *                  amounts that moved, a mix of closed and open lines). Needs a manual check.
 * `primary` is the plain read-back (`readOpenItemLines`); `fullyPaid` is the second read for the
 * absent lines (`readOpenItemLines({ fullyPaidOnly: true })`). Without it an absent line is
 * `missing_needs_second_query`, never a success and never a failure.
 */
export function verifyMatchSetApplied(
  primary: readonly OpenItemLineRow[],
  expected: readonly ExpectedMatchLine[],
  fullyPaid?: readonly OpenItemLineRow[],
): ReadBackVerdict {
  if (expected.length === 0)
    return { outcome: "inconclusive", problems: [{ index: -1, reason: "nothing_expected" }] };
  const states = expected.map((e) => lineState(e, primary, fullyPaid));
  if (states.every((s) => s === "closed")) return { outcome: "verified" };
  if (states.every((s) => s === "open_unchanged")) return { outcome: "not_applied" };
  const problems: Extract<ReadBackVerdict, { outcome: "inconclusive" }>["problems"] = [];
  states.forEach((s, index) => {
    if (s !== "closed" && s !== "open_unchanged") problems.push({ index, reason: s });
  });
  if (states.includes("closed") && states.includes("open_unchanged"))
    problems.push({ index: -1, reason: "partially_applied" });
  return { outcome: "inconclusive", problems };
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

// ---------------------------------------------------------------------------------------------
// Booking protocol version (M7c)
// ---------------------------------------------------------------------------------------------

/**
 * Descriptions of the builder rules that the sample outputs below cannot show on their own. Change
 * a string (or anything in EXACT_WRITE_NAMES, BANK_ENTRY_SIGN or a builder) and
 * BOOKING_PROTOCOL_VERSION changes, which invalidates the stored "write path verified" mark: an
 * admin must verify again on a test division (ADR 0044).
 */
export const WRITE_BUILDER_RULES = {
  bankEntry: "bank-entry/v1",
  matchSet: "matchset/v1",
  matching: "full-match-zero-sum-v1",
  descriptionMax: DESCRIPTION_MAX,
  yourRefMax: YOUR_REF_MAX,
  writer: "writer/v1:no-retry,probe-before-post,xml-text/xml-utf8",
  readBack: "read-back/v1:verified|not_applied|inconclusive",
  probe: "probe/v1:yourref+journal,amount+date-window",
} as const;

/** The canonical text hashed into BOOKING_PROTOCOL_VERSION (exported for tests and for diffing). */
export function bookingProtocolCanonical(): string {
  // A fixed sample through BOTH builders: any change of field names, number formatting, escaping,
  // sorting, sanitising or checks shows up in the output and therefore in the version.
  const g1 = "11111111-2222-3333-4444-555555555555";
  const g2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const key = bankEntryIdempotencyKey("c", "tx-sample", "main");
  const entry = buildBankEntryPayload({
    division: 1,
    journalCode: "90",
    entryDate: "2026-01-31",
    currency: "EUR",
    openingBalanceMinor: 100_000,
    closingBalanceMinor: 112_345,
    idempotencyKey: key,
    financialYear: 2026,
    financialPeriod: 1,
    divisionCurrency: "EUR",
    lines: [
      {
        amountMinor: 12_345,
        description: "Café <&> NL91 ABNA 0417 1643 00 \u0007 x",
        glAccountId: g1,
        accountId: g2,
        ourRef: 2026001,
        bankTransactionExternalId: "tx-sample",
      },
    ],
  });
  const set = buildMatchSetXml({
    division: 1,
    glAccountCode: "1300",
    relationCode: "R 1",
    currency: "EUR",
    reference: "Match <sample> & more",
    lines: [
      { entryNumber: 20, currency: "EUR", amountMinor: 12_345 },
      { transactionLineId: g1, currency: "EUR", amountMinor: -12_345 },
    ],
  });
  return JSON.stringify([
    EXACT_WRITE_NAMES,
    BANK_ENTRY_SIGN,
    WRITE_BUILDER_RULES,
    entry.ok ? [entry.body, entry.headers, entry.yourRefs] : entry.error,
    set.ok ? [set.xml, set.topic] : set.error,
    bankLineShortRef("tx-sample"),
    dependencySamples(g1, g2),
  ]);
}

/** Runs `f`; a throw is recorded by its class name and message (a changed refusal changes the hash). */
function attempt(f: () => unknown): unknown {
  try {
    return f();
  } catch (e) {
    return ["threw", e instanceof Error ? `${e.name}:${e.message}` : String(e)];
  }
}

/**
 * Outputs of every helper that decides WHAT is sent or WHETHER something is sent, on adversarial
 * samples (review M7c): the text sanitiser and IBAN masking, XML escaping, money formatting at the
 * scales 0/2/3 and near 2^53, the builders' refusals, the probe and balance queries (a wrong
 * filter turns "already there" into "not found", so they are part of the protocol), the parsers of
 * Exact's answers and the read-back verdicts. A behaviour change in any of them (even in a shared
 * dependency such as @camelthorn/core) changes BOOKING_PROTOCOL_VERSION.
 */
function dependencySamples(g1: string, g2: string): unknown {
  const texts = [
    "NL91ABNA0417164300",
    "nl91 abna 0417 1643 00",
    "toNL91ABNA0417164300x",
    "NL91-ABNA-0417-1643-00",
    "\uFF2E\uFF2C\uFF19\uFF11ABNA0417164300",
    "DE89 3704 0044 0532 0130 00 / GB82WEST12345698765432",
    "Café <script>&amp; ' \" \u202E evil \u0000\u0007 x",
    "a".repeat(80),
    "",
  ];
  // Rows as the writer sees them: through the same raw-number JSON parser.
  const lineRow = (amount: string, paid: boolean, n = 7): Row =>
    asRow(
      parseJsonRawNumbers(
        `{"ID":"${g1}","Account":"${g2}","AccountCode":"R1","AmountFC":${amount},"Currency":"EUR","IsFullyPaid":${paid},"EntryNumber":${n}}`,
      ),
    );
  const verdict = (rows: Row[], before: number, paidRows?: Row[]): unknown =>
    attempt(() =>
      verifyMatchSetApplied(
        rows.map(mapOpenItemLineRow),
        [{ entryNumber: 7, currency: "EUR", openBeforeMinor: before }],
        paidRows?.map(mapOpenItemLineRow),
      ),
    );
  const entryInput = (o: Partial<BankEntryInput>): unknown =>
    attempt(() => {
      const r = buildBankEntryPayload({
        division: 1,
        journalCode: "90",
        entryDate: "2026-01-31",
        currency: "EUR",
        openingBalanceMinor: 0,
        closingBalanceMinor: 100,
        idempotencyKey: bankEntryIdempotencyKey("c", "t1", "main"),
        divisionCurrency: "EUR",
        lines: [
          { amountMinor: 100, description: "x", accountId: g2, bankTransactionExternalId: "t1" },
        ],
        ...o,
      });
      return r.ok ? r.body : r.error;
    });
  const setInput = (o: Partial<MatchSetInput>): unknown =>
    attempt(() => {
      const r = buildMatchSetXml({
        division: 1,
        glAccountCode: "1300",
        relationCode: "R1",
        currency: "EUR",
        reference: "M",
        lines: [
          { entryNumber: 2, currency: "EUR", amountMinor: -100 },
          { entryNumber: 1, currency: "EUR", amountMinor: 100 },
        ],
        ...o,
      });
      return r.ok ? r.xml : r.error;
    });
  return {
    sanitize: texts.map((t) => [sanitizeBankText(t), sanitizeBankText(t, 12)]),
    escape: ["<a href='x'>&\"]]>", "\uD800", "\u0001", "\uFFFE", "ok"].map((t) =>
      attempt(() => xmlEscape(t)),
    ),
    money: [
      [0, 0],
      [-1, 0],
      [1, 2],
      [-1, 2],
      [123_456, 2],
      [-5, 3],
      [1234, 3],
      [9_007_199_254_740_991, 2],
      [-9_007_199_254_740_991, 0],
    ].map(([m, sc]) => attempt(() => formatMinor(m as number, sc as number))),
    scales: ["EUR", "JPY", "KWD", "USD"].map((c) => currencyScale(c)),
    entries: [
      entryInput({ currency: "JPY", divisionCurrency: "JPY" }),
      entryInput({ currency: "KWD", divisionCurrency: "KWD", closingBalanceMinor: 100 }),
      entryInput({ closingBalanceMinor: 101 }),
      entryInput({ openingBalanceMinor: 2 ** 53, closingBalanceMinor: 2 ** 53 + 100 }),
      entryInput({
        lines: [
          { amountMinor: -100, description: "y", glAccountId: g1, bankTransactionExternalId: "t1" },
        ],
        closingBalanceMinor: -100,
      }),
      entryInput({ lines: [] }),
      entryInput({ journalCode: "9'0" }),
    ],
    sets: [
      setInput({}),
      setInput({
        lines: [
          { entryNumber: 1, currency: "EUR", amountMinor: 100 },
          { entryNumber: 2, currency: "EUR", amountMinor: -99 },
        ],
      }),
      setInput({
        lines: [
          { entryNumber: 1, currency: "EUR", amountMinor: 100 },
          { entryNumber: 2, currency: "USD", amountMinor: -100 },
        ],
      }),
      setInput({ lines: [{ entryNumber: 1, currency: "EUR", amountMinor: 0 }] }),
      setInput({ relationCode: "R<1>" }),
      setInput({
        currency: "KWD",
        lines: [
          { entryNumber: 1, currency: "KWD", amountMinor: 1001 },
          { entryNumber: 2, currency: "KWD", amountMinor: -1001 },
        ],
      }),
    ],
    keys: [
      attempt(() => matchSetIdempotencyKey("t1", ["b", "a"], [{ itemId: "a", amountMinor: 1 }])),
      attempt(() => bankEntryIdempotencyKey(1, "t1", "main")),
      bankLineShortRef("00000000-0000-0000-0000-000000000000"),
    ],
    queries: [
      attempt(() => findExistingBankEntryQuery({ journalCode: "90", yourRef: "tx-1" })),
      attempt(() => findExistingBankEntryQuery({ journalCode: "90", yourRef: "a'b" })),
      attempt(() =>
        findBankLineByAmountQuery({
          journalCode: "90",
          amountMinor: -12_345,
          currency: "EUR",
          dateFrom: "2026-01-30",
          dateTo: "2026-02-03",
        }),
      ),
      attempt(() => latestBankEntryQuery("90")),
    ],
    balances: [
      parseLatestClosingBalance([{ ClosingBalanceFC: "12.34", Currency: "EUR" }], "EUR"),
      parseLatestClosingBalance([{ ClosingBalanceFC: "12.34", Currency: "USD" }], "EUR"),
      parseLatestClosingBalance([], "EUR"),
      parseLatestClosingBalance(
        [
          { ClosingBalanceFC: "1", Currency: "EUR" },
          { ClosingBalanceFC: "2", Currency: "EUR" },
        ],
        "EUR",
      ),
    ],
    answers: [
      parseBankEntryResponse(
        JSON.stringify({ d: { EntryID: g1, EntryNumber: 5, BankEntryLines: [{ YourRef: "t1" }] } }),
        ["t1"],
      ),
      parseBankEntryResponse(
        JSON.stringify({ d: { EntryID: g1, BankEntryLines: [{ YourRef: "t2" }] } }),
        ["t1"],
      ),
      parseBankEntryResponse("<html>login</html>", ["t1"]),
      parseBankEntryResponse(JSON.stringify({ error: { message: "x" } }), ["t1"]),
      parseMatchSetResponse(
        '<?xml version="1.0"?><eExact><Messages><Message type="2"><Description>ok</Description></Message></Messages></eExact>',
      ),
      parseMatchSetResponse(
        '<?xml version="1.0"?><eExact><Messages><Message type="0"><Description>no</Description></Message></Messages></eExact>',
      ),
      parseMatchSetResponse("<html>x</html>"),
      parseMatchSetResponse(""),
    ],
    readBack: [
      verdict([lineRow("0", true)], 100),
      verdict([lineRow("1.00", false)], 100),
      verdict([lineRow("0.50", false)], 100),
      verdict([], 100),
      verdict([], 100, [lineRow("0", true)]),
      verdict([], 100, []),
      verdict([lineRow("0", true), lineRow("0", true)], 100),
      verdict([lineRow("0", false)], 100),
    ],
  };
}

/**
 * sha256 of the canonical description of everything that decides what we send to Exact. Computed
 * from code, so ANY change invalidates a stored verification (same idea as the approval-mapping
 * hash in packages/core).
 */
export function computeBookingProtocolVersion(): string {
  return sha256Hex(bookingProtocolCanonical());
}

export const BOOKING_PROTOCOL_VERSION: string = computeBookingProtocolVersion();
