import {
  arrField,
  asRow,
  badData,
  boolField,
  objField,
  optCurrency,
  optMinor,
  optStr,
  reqCurrency,
  reqMinor,
  reqStr,
  type Row,
} from "./json";

// ---- states -------------------------------------------------------------------------------

export type RevolutTransactionState =
  "pending" | "completed" | "declined" | "failed" | "reverted" | "unknown";

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "pending",
  "completed",
  "declined",
  "failed",
  "reverted",
]);

/** Unknown or missing states are 'unknown', never silently 'completed'. */
export function mapTransactionState(raw: unknown): RevolutTransactionState {
  if (typeof raw !== "string") return "unknown";
  const s = raw.trim().toLowerCase();
  return KNOWN_STATES.has(s) ? (s as RevolutTransactionState) : "unknown";
}

/** CLAUDE.md §3: only transactions in a final state are booked. */
export function isFinalState(state: RevolutTransactionState): boolean {
  return (
    state === "completed" || state === "failed" || state === "reverted" || state === "declined"
  );
}

// ---- accounts -----------------------------------------------------------------------------

export type RevolutAccountState = "active" | "inactive" | "unknown";

export interface RevolutAccount {
  id: string;
  name: string;
  balanceMinor: number;
  currency: string;
  state: RevolutAccountState;
  public?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export function mapAccount(raw: unknown): RevolutAccount {
  const r = asRow(raw);
  const currency = reqCurrency(r, "currency");
  const stateRaw = optStr(r, "state")?.toLowerCase();
  const state: RevolutAccountState =
    stateRaw === "active" || stateRaw === "inactive" ? stateRaw : "unknown";
  const out: RevolutAccount = {
    id: reqStr(r, "id"),
    name: optStr(r, "name") ?? "",
    balanceMinor: reqMinor(r, "balance", currency),
    currency,
    state,
  };
  const pub = boolField(r, "public");
  if (pub !== undefined) out.public = pub;
  const c = optStr(r, "created_at");
  if (c !== undefined) out.createdAt = c;
  const u = optStr(r, "updated_at");
  if (u !== undefined) out.updatedAt = u;
  return out;
}

export interface RevolutBankDetails {
  iban?: string;
  bic?: string;
  accountNo?: string;
  sortCode?: string;
  routingNumber?: string;
  beneficiary?: string;
  bankCountry?: string;
  pooled?: boolean;
  uniqueReference?: string;
  schemes: string[];
}

export function mapBankDetails(raw: unknown): RevolutBankDetails {
  const r = asRow(raw);
  const out: RevolutBankDetails = {
    schemes: arrField(r, "schemes").filter((s): s is string => typeof s === "string"),
  };
  const set = (k: keyof Omit<RevolutBankDetails, "schemes" | "pooled">, src: string): void => {
    const v = optStr(r, src);
    if (v !== undefined) out[k] = v;
  };
  set("iban", "iban");
  set("bic", "bic");
  set("accountNo", "account_no");
  set("sortCode", "sort_code");
  set("routingNumber", "routing_number");
  set("beneficiary", "beneficiary");
  set("bankCountry", "bank_country");
  set("uniqueReference", "unique_reference");
  const pooled = boolField(r, "pooled");
  if (pooled !== undefined) out.pooled = pooled;
  return out;
}

// ---- transactions -------------------------------------------------------------------------

export interface RevolutCounterparty {
  id?: string;
  /** 'self' | 'revolut' | 'external' as sent; kept as a string. */
  accountType?: string;
  accountId?: string;
  name?: string;
  /** Full IBAN is kept here; mask with maskIban() before it reaches logs or messages. */
  iban?: string;
}

export interface RevolutCardInfo {
  /** Masked by Revolut, for example 123456******7890. */
  cardNumber?: string;
}

export interface RevolutMerchant {
  name?: string;
  city?: string;
  categoryCode?: string;
  country?: string;
}

export interface RevolutLeg {
  legId: string;
  accountId?: string;
  /** Signed as Revolut gives it: negative for money leaving the account. */
  amountMinor: number;
  currency: string;
  feeMinor?: number;
  billAmountMinor?: number;
  billCurrency?: string;
  balanceMinor?: number;
  counterparty?: RevolutCounterparty;
  description?: string;
  card?: RevolutCardInfo;
}

export interface RevolutTransaction {
  id: string;
  type: string;
  requestId?: string;
  state: RevolutTransactionState;
  reasonCode?: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  reference?: string;
  legs: RevolutLeg[];
  merchant?: RevolutMerchant;
  card?: RevolutCardInfo;
}

function mapCounterparty(raw: Row): RevolutCounterparty {
  const out: RevolutCounterparty = {};
  const id = optStr(raw, "id");
  if (id !== undefined) out.id = id;
  const type = optStr(raw, "account_type") ?? optStr(raw, "type");
  if (type !== undefined) out.accountType = type;
  const accountId = optStr(raw, "account_id");
  if (accountId !== undefined) out.accountId = accountId;
  const name = optStr(raw, "name");
  if (name !== undefined) out.name = name;
  const iban = optStr(raw, "iban");
  if (iban !== undefined) out.iban = iban;
  return out;
}

function mapCard(raw: Row | undefined): RevolutCardInfo | undefined {
  if (raw === undefined) return undefined;
  const n = optStr(raw, "card_number");
  return n === undefined ? {} : { cardNumber: n };
}

function mapLeg(raw: unknown): RevolutLeg {
  const r = asRow(raw);
  const currency = reqCurrency(r, "currency");
  const leg: RevolutLeg = {
    legId: reqStr(r, "leg_id"),
    amountMinor: reqMinor(r, "amount", currency),
    currency,
  };
  const accountId = optStr(r, "account_id");
  if (accountId !== undefined) leg.accountId = accountId;
  const fee = optMinor(r, "fee", currency);
  if (fee !== undefined) leg.feeMinor = fee;
  const billCurrency = optCurrency(r, "bill_currency");
  if (billCurrency !== undefined) {
    leg.billCurrency = billCurrency;
    const bill = optMinor(r, "bill_amount", billCurrency);
    if (bill !== undefined) leg.billAmountMinor = bill;
  }
  const balance = optMinor(r, "balance", currency);
  if (balance !== undefined) leg.balanceMinor = balance;
  const cp = objField(r, "counterparty");
  if (cp !== undefined) leg.counterparty = mapCounterparty(cp);
  const description = optStr(r, "description");
  if (description !== undefined) leg.description = description;
  const card = mapCard(objField(r, "card"));
  if (card !== undefined) leg.card = card;
  return leg;
}

export function mapTransaction(raw: unknown): RevolutTransaction {
  const r = asRow(raw);
  const legs = arrField(r, "legs").map(mapLeg);
  const seen = new Set<string>();
  for (const l of legs) {
    if (seen.has(l.legId)) throw badData("Duplicate leg id in transaction", "BAD_SHAPE");
    seen.add(l.legId);
  }
  const tx: RevolutTransaction = {
    id: reqStr(r, "id"),
    type: optStr(r, "type") ?? "unknown",
    state: mapTransactionState(r["state"]),
    createdAt: reqStr(r, "created_at"),
    legs,
  };
  const requestId = optStr(r, "request_id");
  if (requestId !== undefined) tx.requestId = requestId;
  const reasonCode = optStr(r, "reason_code");
  if (reasonCode !== undefined) tx.reasonCode = reasonCode;
  const updatedAt = optStr(r, "updated_at");
  if (updatedAt !== undefined) tx.updatedAt = updatedAt;
  const completedAt = optStr(r, "completed_at");
  if (completedAt !== undefined) tx.completedAt = completedAt;
  const reference = optStr(r, "reference");
  if (reference !== undefined) tx.reference = reference;
  const m = objField(r, "merchant");
  if (m !== undefined) {
    const merchant: RevolutMerchant = {};
    const name = optStr(m, "name");
    if (name !== undefined) merchant.name = name;
    const city = optStr(m, "city");
    if (city !== undefined) merchant.city = city;
    const cat = optStr(m, "category_code");
    if (cat !== undefined) merchant.categoryCode = cat;
    const country = optStr(m, "country");
    if (country !== undefined) merchant.country = country;
    tx.merchant = merchant;
  }
  const card = mapCard(objField(r, "card"));
  if (card !== undefined) tx.card = card;
  return tx;
}

// ---- counterparties and webhooks ----------------------------------------------------------

export interface RevolutCounterpartyAccount {
  id?: string;
  currency?: string;
  type?: string;
  iban?: string;
  bic?: string;
  accountNo?: string;
  sortCode?: string;
}

export interface RevolutCounterpartyRecord {
  id: string;
  name?: string;
  profileType?: string;
  country?: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  accounts: RevolutCounterpartyAccount[];
}

export function mapCounterpartyRecord(raw: unknown): RevolutCounterpartyRecord {
  const r = asRow(raw);
  const out: RevolutCounterpartyRecord = {
    id: reqStr(r, "id"),
    accounts: arrField(r, "accounts").map((a) => {
      const ar = asRow(a);
      const acc: RevolutCounterpartyAccount = {};
      const pairs: [keyof RevolutCounterpartyAccount, string][] = [
        ["id", "id"],
        ["currency", "currency"],
        ["type", "type"],
        ["iban", "iban"],
        ["bic", "bic"],
        ["accountNo", "account_no"],
        ["sortCode", "sort_code"],
      ];
      for (const [k, src] of pairs) {
        const v = optStr(ar, src);
        if (v !== undefined) acc[k] = v;
      }
      return acc;
    }),
  };
  const pairs: [keyof Omit<RevolutCounterpartyRecord, "id" | "accounts">, string][] = [
    ["name", "name"],
    ["profileType", "profile_type"],
    ["country", "country"],
    ["state", "state"],
    ["createdAt", "created_at"],
    ["updatedAt", "updated_at"],
  ];
  for (const [k, src] of pairs) {
    const v = optStr(r, src);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export type RevolutWebhookEventName = "TransactionCreated" | "TransactionStateChanged";

export interface RevolutWebhook {
  id: string;
  url: string;
  events: string[];
}

export interface RevolutCreatedWebhook extends RevolutWebhook {
  /** HMAC signing secret. Shown once by Revolut: store encrypted, never log. */
  signingSecret: string;
}

export function mapWebhook(raw: unknown): RevolutWebhook {
  const r = asRow(raw);
  return {
    id: reqStr(r, "id"),
    url: reqStr(r, "url"),
    events: arrField(r, "events").filter((e): e is string => typeof e === "string"),
  };
}
