/**
 * Revolut Business payment requests and answers (Phase 9, P9b, ADR 0050). Pure: no I/O.
 *
 * NOTHING HERE HAS RUN AGAINST A REAL REVOLUT. Every endpoint, field name, state and error
 * convention below is an UNVERIFIED assumption (A-items in ADR 0050) taken from memory of the
 * public Business API documentation. The rule that follows from that:
 *
 *   STRICT IN SEND, TOLERANT IN PARSE.
 *   - A request body is built field by field from validated inputs; no caller-supplied object is
 *     ever spread into it, and no field is sent that we are not sure the API defines.
 *   - An answer is read for the few fields we need; unknown extra fields are ignored; a field that
 *     is missing or has an unexpected type makes the answer "unreadable", which the caller treats
 *     as OUTCOME UNKNOWN for a write (never as success, never as failure).
 *
 * Money: integer minor units + currency in, a decimal amount out through ONE function
 * (`revolutAmount`). The amount is written into the body as a raw JSON number token ("amount":
 * 1234.50): no float ever exists, and `JSON.stringify` is never applied to it. The sandbox check
 * `amount_format_probe` confirms Revolut accepts a JSON number (A-item) and what it does with a
 * string; until then the number token is what the documentation shows.
 */
import {
  currencyScale,
  formatMinor,
  hasValidIbanChecksum,
  isUuidV4,
  normalizeIban,
  sanitizeSepaText,
} from "@camelthorn/core";
import { arrField, asRow, badData, objField, optStr, parseJsonRawNumbers, reqStr } from "./json";
import { mapTransaction, mapTransactionState, type RevolutTransaction } from "./models";
import { RevolutApiError, RevolutAuthError, RevolutRateLimitedError } from "./transport";
import { RevolutWriteAuthRetryRefused } from "./transport";

/** The job class every payment call must carry: `revolut-payment` or `revolut-payment:<suffix>`. */
export const PAYMENT_JOB_CLASS_RE = /^revolut-payment(?::[A-Za-z0-9_.-]{1,60})?$/;
export const PAYMENT_JOB_ID = "revolut-payment";
export const PAYMENT_RECONCILE_JOB_ID = "revolut-payment:reconcile";
export const isPaymentJobId = (id: string): boolean => PAYMENT_JOB_CLASS_RE.test(id);

/**
 * A-ITEM: Revolut's reference limit. 140 is the SEPA remittance maximum and what the app already
 * sanitises to (core). The sandbox check `reference_charset_probe` finds the real limit and charset.
 */
export const REVOLUT_REFERENCE_MAX = 140;
/** A-ITEM: longest counterparty name we send (the SEPA creditor name limit is 70). */
export const REVOLUT_NAME_MAX = 70;
export const REVOLUT_DRAFT_MAX_PAYMENTS = 50;

const REVOLUT_ID_RE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const CCY_RE = /^[A-Z]{3}$/;

const invalid = (what: string): RangeError => new RangeError(`invalid payment request: ${what}`);

// ---- the single audited amount function -----------------------------------------------------

/**
 * THE ONLY place an integer amount becomes the decimal text sent to Revolut. Integer minor units
 * at the currency's ISO 4217 scale, positive, a safe integer; "1234.50" for EUR 123450, "1234" for
 * JPY. String arithmetic only (core `formatMinor`).
 */
export function revolutAmount(minor: number, currency: string): string {
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 1) {
    throw invalid("amount must be a positive safe integer of minor units");
  }
  if (typeof currency !== "string" || !CCY_RE.test(currency)) throw invalid("currency");
  return formatMinor(minor, currencyScale(currency));
}

/** SEPA-safe reference, capped. Throws when nothing usable is left (never sends an empty one). */
export function revolutReference(raw: string): string {
  if (typeof raw !== "string") throw invalid("reference");
  let ref = sanitizeSepaText(raw);
  if (ref.length > REVOLUT_REFERENCE_MAX) {
    ref = ref
      .slice(0, REVOLUT_REFERENCE_MAX)
      .replace(/[ /]+$/, "")
      .trim();
  }
  if (ref === "") throw invalid("reference is empty after sanitising");
  return ref;
}

/** A counterparty name: control and format characters removed, spaces collapsed, capped. */
export function revolutName(raw: string): string {
  if (typeof raw !== "string") throw invalid("name");
  const name = raw
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REVOLUT_NAME_MAX)
    .trim();
  if (name === "") throw invalid("name is empty");
  return name;
}

/** Draft title that carries our request id, so a lost answer can be found in the list. */
export function draftTitle(requestId: string): string {
  if (!isUuidV4(requestId)) throw invalid("request_id");
  return `CF-${requestId.replace(/-/g, "").slice(0, 12)}`;
}

// ---- request builders -------------------------------------------------------------------------

export interface BuiltRequest {
  method: "POST";
  path: string;
  /** Exact bytes to send. */
  body: string;
}

const str = (v: string): string => JSON.stringify(v);
const obj = (fields: readonly (readonly [string, string])[]): string =>
  `{${fields.map(([k, v]) => `${str(k)}:${v}`).join(",")}}`;

function assertRevolutId(v: string, what: string): string {
  if (typeof v !== "string" || !REVOLUT_ID_RE.test(v)) throw invalid(what);
  return v;
}

export interface CounterpartyInput {
  /** From the verified supplier record only. */
  name: string;
  /** Normalised or not; validated (shape + mod-97) and sent normalised. */
  iban: string;
  currency: string;
}

/** A-ITEM: `POST /counterparty` with company_name + bank_country + currency + iban (no BIC). */
export function buildCreateCounterparty(i: CounterpartyInput): BuiltRequest {
  const iban = normalizeIban(i.iban);
  if (!hasValidIbanChecksum(iban)) throw invalid("iban");
  if (typeof i.currency !== "string" || !CCY_RE.test(i.currency)) throw invalid("currency");
  return {
    method: "POST",
    path: "/counterparty",
    body: obj([
      ["company_name", str(revolutName(i.name))],
      ["bank_country", str(iban.slice(0, 2))],
      ["currency", str(i.currency)],
      ["iban", str(iban)],
    ]),
  };
}

export interface PaymentLeg {
  /** Our Revolut source account (uuid). */
  accountId: string;
  counterpartyId: string;
  /** Only when the counterparty has several accounts. */
  receiverAccountId?: string | undefined;
  amountMinor: number;
  currency: string;
  reference: string;
}

function receiver(l: PaymentLeg): string {
  return obj([
    ["counterparty_id", str(assertRevolutId(l.counterpartyId, "counterparty_id"))],
    ...(l.receiverAccountId !== undefined
      ? ([
          ["account_id", str(assertRevolutId(l.receiverAccountId, "receiver account_id"))],
        ] as const)
      : []),
  ]);
}

export interface PayInput extends PaymentLeg {
  /** Our stored UUIDv4; never generated here, never changed for a retry. */
  requestId: string;
}

/** A-ITEM: `POST /pay` (Company plan). The amount is a raw JSON number token. */
export function buildPay(i: PayInput): BuiltRequest {
  if (!isUuidV4(i.requestId)) throw invalid("request_id");
  return {
    method: "POST",
    path: "/pay",
    body: obj([
      ["request_id", str(i.requestId)],
      ["account_id", str(assertRevolutId(i.accountId, "account_id"))],
      ["receiver", receiver(i)],
      ["amount", revolutAmount(i.amountMinor, i.currency)],
      ["currency", str(i.currency)],
      ["reference", str(revolutReference(i.reference))],
    ]),
  };
}

export interface DraftInput {
  /** Our request id of the payment or batch; the title is derived from it. */
  requestId: string;
  payments: readonly PaymentLeg[];
}

/**
 * A-ITEM: `POST /payment-drafts` with `payments[]` (one entry = one draft, several = a bulk draft
 * approved as one in the Revolut app). The documented create call has NO per-payment request_id, so
 * a lost answer cannot be looked up by it; the title carries a marker instead (see `draftTitle`).
 */
export function buildPaymentDraft(i: DraftInput): BuiltRequest {
  if (i.payments.length < 1 || i.payments.length > REVOLUT_DRAFT_MAX_PAYMENTS) {
    throw invalid("payments count");
  }
  const currency = i.payments[0]?.currency ?? "";
  const items = i.payments.map((p) => {
    if (p.currency !== currency) throw invalid("mixed currency in one draft");
    return obj([
      ["account_id", str(assertRevolutId(p.accountId, "account_id"))],
      ["receiver", receiver(p)],
      ["amount", revolutAmount(p.amountMinor, p.currency)],
      ["currency", str(p.currency)],
      ["reference", str(revolutReference(p.reference))],
    ]);
  });
  return {
    method: "POST",
    path: "/payment-drafts",
    body: obj([
      ["title", str(draftTitle(i.requestId))],
      ["payments", `[${items.join(",")}]`],
    ]),
  };
}

// ---- parsers (tolerant) ------------------------------------------------------------------------

export interface CreatedCounterparty {
  id: string;
  name?: string;
  accounts: { id?: string; iban?: string; currency?: string }[];
}

const unreadable = (what: string): RevolutApiError =>
  badData(`Unreadable Revolut answer: ${what}`, "PAYMENT_ANSWER_UNREADABLE");

export function parseCreatedCounterparty(body: string): CreatedCounterparty {
  let r;
  try {
    r = asRow(parseJsonRawNumbers(body));
    const out: CreatedCounterparty = {
      id: assertRevolutId(reqStr(r, "id"), "counterparty id"),
      accounts: arrField(r, "accounts").map((a) => {
        const row = asRow(a);
        const acc: CreatedCounterparty["accounts"][number] = {};
        const id = optStr(row, "id");
        const iban = optStr(row, "iban");
        const currency = optStr(row, "currency");
        if (id !== undefined) acc.id = id;
        if (iban !== undefined) acc.iban = normalizeIban(iban);
        if (currency !== undefined) acc.currency = currency;
        return acc;
      }),
    };
    const name = optStr(r, "name") ?? optStr(r, "company_name");
    if (name !== undefined) out.name = name;
    return out;
  } catch {
    throw unreadable("counterparty");
  }
}

export interface PayAccepted {
  transactionId: string;
  state: RevolutTransaction["state"];
  requestId?: string;
  reasonCode?: string;
}

/** A-ITEM: `/pay` answers `{ id, state, created_at, ... }`; `state` pending | completed | ... */
export function parsePayAnswer(body: string): PayAccepted {
  try {
    const r = asRow(parseJsonRawNumbers(body));
    const out: PayAccepted = {
      transactionId: reqStr(r, "id"),
      state: mapTransactionState(r["state"]),
    };
    const rid = optStr(r, "request_id");
    if (rid !== undefined) out.requestId = rid;
    const reason = optStr(r, "reason_code");
    if (reason !== undefined) out.reasonCode = reason;
    return out;
  } catch {
    throw unreadable("pay");
  }
}

export function parseDraftCreated(body: string): { id: string } {
  try {
    const r = asRow(parseJsonRawNumbers(body));
    return { id: reqStr(r, "id") };
  } catch {
    throw unreadable("draft");
  }
}

export interface PaymentDraftView {
  id: string;
  title?: string;
  /** Draft level state as Revolut words it (not mapped: we only compare with known words). */
  state?: string;
  payments: { state?: string; transactionId?: string; reasonCode?: string }[];
}

/** A-ITEM: `GET /payment-drafts/{id}`: `{ id, title?, state?, payments: [{ state, transaction_id }] }`. */
export function parsePaymentDraft(raw: unknown): PaymentDraftView {
  try {
    const r = asRow(raw);
    const out: PaymentDraftView = {
      id: reqStr(r, "id"),
      payments: arrField(r, "payments").map((p) => {
        const row = asRow(p);
        const v: PaymentDraftView["payments"][number] = {};
        const st = optStr(row, "state");
        const tx = optStr(row, "transaction_id");
        const rc = optStr(row, "reason_code") ?? optStr(row, "error_message");
        if (st !== undefined) v.state = st.toLowerCase();
        if (tx !== undefined) v.transactionId = tx;
        if (rc !== undefined) v.reasonCode = rc;
        return v;
      }),
    };
    const title = optStr(r, "title");
    if (title !== undefined) out.title = title;
    const st = optStr(r, "state");
    if (st !== undefined) out.state = st.toLowerCase();
    return out;
  } catch {
    throw unreadable("draft view");
  }
}

export function parseTransactionStrict(body: string): RevolutTransaction {
  try {
    return mapTransaction(parseJsonRawNumbers(body));
  } catch {
    throw unreadable("transaction");
  }
}

export { objField };

// ---- classification of a failed write ---------------------------------------------------------

/** What the gate's send ledger says about a write (see RevolutGate.paymentSendState). */
export type SendLedger = "never_attempted" | "attempted" | "unreadable";

/** Safe, short, lower-case code for storage and audit. Never a message, URL or body. */
export function failureCode(e: unknown): string {
  if (e instanceof RevolutApiError) {
    const c = e.code;
    if (typeof c === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(c)) return c.toLowerCase();
    return `http_${e.status}`;
  }
  if (e instanceof RevolutAuthError)
    return /^[a-z][a-z0-9_]{0,40}$/.test(e.message) ? e.message : "auth";
  if (e instanceof RevolutRateLimitedError) return "rate_limited";
  if (e instanceof RangeError) return "invalid_request";
  return "error";
}

export type PaymentFailure =
  /** Proven: the request never left the gate (or was refused locally). Safe to recreate with a new id. */
  | { kind: "not_executed"; code: string }
  /** Revolut answered with a clear refusal of THIS request. */
  | { kind: "rejected"; code: string }
  /** Revolut says the request_id was used already: look it up and adopt it; never resend. */
  | { kind: "duplicate_request_id" }
  /** The request may have been executed. Reconcile by request_id; never retry. */
  | { kind: "unknown"; code: string };

/**
 * Sorts a failed payment write. `ledger` is the gate's own record of whether it ever attempted the
 * network call for this request (written BEFORE the fetch, so `never_attempted` is proof).
 *
 *  - local validation error (RangeError)            -> not_executed
 *  - ledger never_attempted                         -> not_executed (whatever the error)
 *  - 401 / refused-after-401 (the gate DID send)    -> unknown (task rule: only "never sent" is definite)
 *  - 409                                            -> duplicate_request_id (A-ITEM: Revolut's code)
 *  - 429 after an attempt                           -> rejected rate_limited (not processed)
 *  - 400 / 403 / 404 / 422                          -> rejected (A-ITEM: these mean "refused")
 *  - 5xx, network, timeout, gate_unavailable, 200 with an unreadable body, anything else -> unknown
 */
export function classifyPaymentFailure(e: unknown, ledger: SendLedger): PaymentFailure {
  if (e instanceof RangeError) return { kind: "not_executed", code: "invalid_request" };
  if (ledger === "never_attempted") return { kind: "not_executed", code: failureCode(e) };
  if (e instanceof RevolutWriteAuthRetryRefused) {
    return { kind: "unknown", code: "auth_refused_after_send" };
  }
  if (e instanceof RevolutAuthError) return { kind: "unknown", code: failureCode(e) };
  if (e instanceof RevolutRateLimitedError) return { kind: "rejected", code: "rate_limited" };
  if (e instanceof RevolutApiError) {
    if (e.status === 409) return { kind: "duplicate_request_id" };
    if ([400, 403, 404, 422].includes(e.status)) return { kind: "rejected", code: failureCode(e) };
    return { kind: "unknown", code: failureCode(e) };
  }
  return { kind: "unknown", code: "error" };
}
