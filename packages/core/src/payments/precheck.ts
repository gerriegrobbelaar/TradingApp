/**
 * Pre-checks for one payment request (CLAUDE.md 4.3, ADR 0049). Pure: the worker gathers the facts
 * and this function says which block codes apply. It returns EVERY code, in the order of
 * PAYMENT_BLOCK_CODES, and never throws on bad data (bad data is a block).
 *
 * Doubt is a block: an unknown approval, an unverified mapping, a missing rate or a stale IBAN
 * read never lets a request through.
 */
import type { RateTable } from "../fx";
import { eurEquivalent, type EurAmount } from "./eur";
import { assessIban, PAYABLE_IBAN_STATES, type IbanFacts, type IbanState } from "./iban-state";
import { buildPaymentReference } from "./text";
import {
  PAYMENT_BALANCE_MAX_AGE_MS,
  PAYMENT_BLOCK_CODES,
  PAYMENT_IBAN_MAX_AGE_MS,
  PAYMENT_MAX_MINOR,
  type PaymentBlockCode,
  type PaymentSettings,
  type PaymentWarningCode,
} from "./types";

export type InvoiceApproval = "approved" | "not_approved" | "mapping_unverified" | "unknown";

export interface PrecheckInput {
  nowMs: number;
  /** The feature switch (settings payments.enabled). */
  paymentsEnabled: boolean;
  settings: PaymentSettings;
  requesterEmail: string;
  /** Null when the payable does not exist. */
  item: {
    kind: "invoice" | "bill";
    /** Closed in Exact, or status other than open. */
    closed: boolean;
    openMinor: number;
    currency: string;
    invoiceNumber: string | null;
    /** The IBAN printed on / stored with the invoice, when there is one. */
    invoiceIban: string | null;
    /**
     * The division's open payables were read completely recently (sync_state `payables`, 26 h):
     * otherwise the open balance may be out of date (paid or changed in Exact since). Not
     * fresh = `open_item_stale`.
     */
    fresh: boolean;
  } | null;
  /**
   * Result of `isInvoiceApprovedForPayment` on the one purchase entry of the payable, or the
   * reason it could not be asked.
   */
  approval: InvoiceApproval;
  supplier: { found: boolean; isSupplier: boolean } | null;
  iban: IbanFacts;
  /** When the supplier's bank accounts were last read completely, epoch ms (null = never). */
  ibanReadAtMs: number | null;
  /** The amount to pay; undefined = the open balance. */
  requestedAmountMinor?: number;
  conflicts: {
    openRequest: boolean;
    openBatch: boolean;
    paidSinceSync: boolean;
    /**
     * Any request for this invoice was ever confirmed `paid` by the bank. Until P9b proves the
     * booking in Exact reduced the open balance, a second payment of the same invoice is refused
     * whatever the open balance says (review P9a).
     */
    paidBefore: boolean;
  };
  source: {
    found: boolean;
    active: boolean;
    currency: string;
    /** Last known Revolut balance; null when unknown. */
    balanceMinor: number | null;
    balanceAtMs: number | null;
    /** Sum of other open requests on this account in this currency (minor units). */
    reservedMinor: number;
  } | null;
  /** Sum of EUR equivalents of the open and paid requests of the last 24 hours (rolling window). */
  dailyTotalEurMinor: number;
  rates: RateTable | null;
}

export interface PrecheckResult {
  ok: boolean;
  blocks: PaymentBlockCode[];
  warnings: PaymentWarningCode[];
  /** The amount that would be paid (null if it could not be determined). */
  amountMinor: number | null;
  currency: string | null;
  reference: string | null;
  eur: EurAmount | null;
  /**
   * The EUR figure the four-eyes LIMIT is judged on: the amount's, or for a part payment the open
   * balance's when that is larger, so splitting a large invoice into small parts cannot dodge the
   * second approver (review P9a). Null when no rate.
   */
  limitEur: EurAmount | null;
  ibanState: IbanState;
  ibanFingerprint: string | null;
}

export function precheckPayment(input: PrecheckInput): PrecheckResult {
  const blocks = new Set<PaymentBlockCode>();
  const warnings = new Set<PaymentWarningCode>();
  const { item, settings } = input;

  if (!input.paymentsEnabled) blocks.add("payments_disabled");

  // ---- the payable -----------------------------------------------------------------------
  let amount: number | null = null;
  if (item === null) {
    blocks.add("payable_not_found");
  } else {
    if (item.kind !== "bill") blocks.add("not_a_payable");
    if (item.fresh !== true) blocks.add("open_item_stale");
    if (item.closed || !Number.isSafeInteger(item.openMinor) || item.openMinor <= 0) {
      blocks.add("nothing_open");
    } else {
      const wanted = input.requestedAmountMinor ?? item.openMinor;
      if (!Number.isSafeInteger(wanted) || wanted <= 0 || wanted > PAYMENT_MAX_MINOR) {
        blocks.add("amount_invalid");
      } else if (wanted > item.openMinor) {
        blocks.add("amount_exceeds_open");
      } else if (wanted !== item.openMinor && !settings.allowPartial) {
        blocks.add("amount_not_open_balance");
      } else {
        amount = wanted;
      }
    }
    if (!settings.allowedCurrencies.includes(item.currency)) blocks.add("currency_not_supported");
    if (input.source !== null && input.source.found && input.source.currency !== item.currency) {
      blocks.add("currency_mismatch_source");
    }
  }

  // ---- Exact approval --------------------------------------------------------------------
  if (input.approval === "mapping_unverified") blocks.add("approval_mapping_unverified");
  else if (input.approval === "not_approved") blocks.add("invoice_not_approved");
  else if (input.approval === "unknown") blocks.add("approval_unknown");

  // ---- double payment --------------------------------------------------------------------
  if (input.conflicts.openRequest) blocks.add("already_in_request");
  if (input.conflicts.openBatch) blocks.add("already_in_batch");
  if (input.conflicts.paidBefore !== false) blocks.add("already_paid");
  if (input.conflicts.paidSinceSync) blocks.add("paid_since_last_sync");

  // ---- supplier and IBAN -----------------------------------------------------------------
  if (input.supplier === null || !input.supplier.found || !input.supplier.isSupplier) {
    blocks.add("supplier_not_found");
  }
  const iban = assessIban(input.iban, input.requesterEmail);
  switch (iban.state) {
    case "missing":
      blocks.add("iban_missing");
      break;
    case "invalid":
      blocks.add("iban_invalid");
      break;
    case "unverified":
      blocks.add("iban_unverified");
      break;
    case "changed":
      blocks.add("iban_changed");
      break;
    default:
      break;
  }
  if (PAYABLE_IBAN_STATES.includes(iban.state)) {
    // The invoice carries its own IBAN snapshot: when it differs from the supplier record the
    // difference is a person's call, not ours.
    if (item?.invoiceIban) {
      const inv = assessIban({ ...input.iban, recordIban: item.invoiceIban }, input.requesterEmail);
      if (inv.fingerprint !== iban.fingerprint) blocks.add("iban_mismatch_invoice");
    }
  }
  if (
    iban.state !== "missing" &&
    (input.ibanReadAtMs === null ||
      !Number.isFinite(input.ibanReadAtMs) ||
      input.nowMs - input.ibanReadAtMs > PAYMENT_IBAN_MAX_AGE_MS ||
      input.ibanReadAtMs > input.nowMs + 60_000)
  ) {
    blocks.add("iban_cache_stale");
  }

  // ---- limits ----------------------------------------------------------------------------
  let eur: EurAmount | null = null;
  let limitEur: EurAmount | null = null;
  if (amount !== null && item !== null) {
    eur = eurEquivalent(amount, item.currency, input.rates);
    limitEur =
      eur !== null && amount < item.openMinor
        ? eurEquivalent(item.openMinor, item.currency, input.rates)
        : eur;
    if (eur === null) {
      blocks.add("no_eur_rate");
    } else {
      if (eur.minor > settings.maxRequestMinor) blocks.add("over_request_limit");
      if (
        !Number.isSafeInteger(input.dailyTotalEurMinor) ||
        input.dailyTotalEurMinor < 0 ||
        input.dailyTotalEurMinor + eur.minor > settings.maxDailyMinor
      ) {
        blocks.add("over_daily_limit");
      }
    }
  }

  // ---- source account --------------------------------------------------------------------
  const src = input.source;
  if (src === null || !src.found) {
    blocks.add("source_account_unknown");
  } else {
    if (!src.active) blocks.add("source_account_inactive");
    const known =
      src.balanceMinor !== null &&
      Number.isSafeInteger(src.balanceMinor) &&
      src.balanceAtMs !== null;
    if (!known) {
      warnings.add("balance_unknown");
      if (settings.blockOnInsufficientBalance) blocks.add("insufficient_balance");
    } else {
      if (input.nowMs - (src.balanceAtMs as number) > PAYMENT_BALANCE_MAX_AGE_MS) {
        warnings.add("balance_stale");
      }
      if (amount !== null && (src.balanceMinor as number) - src.reservedMinor < amount) {
        warnings.add("balance_below_amount");
        if (settings.blockOnInsufficientBalance) blocks.add("insufficient_balance");
      }
    }
  }

  // ---- reference -------------------------------------------------------------------------
  const built = buildPaymentReference(item?.invoiceNumber ?? null);
  if (built.reference === null) blocks.add("reference_empty");
  if (built.shortened) warnings.add("reference_shortened");

  const ordered = PAYMENT_BLOCK_CODES.filter((c) => blocks.has(c));
  return {
    ok: ordered.length === 0,
    blocks: ordered,
    warnings: [...warnings],
    amountMinor: amount,
    currency: item?.currency ?? null,
    reference: built.reference,
    eur,
    limitEur,
    ibanState: iban.state,
    ibanFingerprint: iban.fingerprint,
  };
}
