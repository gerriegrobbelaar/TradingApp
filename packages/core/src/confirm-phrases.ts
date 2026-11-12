import { formatMoney, money } from "./money";

/**
 * Typed confirmation phrases, ONE source for the worker, the web and the tests (review M7d). The
 * person must type the phrase exactly (case-sensitive, no trimming); the server compares with
 * `===` again.
 */
/** PUT /api/matching/config {autoEnabled: true, confirm}. */
export const AUTO_MATCH_CONFIRM_PHRASE = "ENABLE AUTOMATIC MATCHING";
/** POST /api/booking/verify {confirm} (M7c). */
export const BOOKING_VERIFY_PHRASE = "I VERIFIED THE EXACT WRITE PATH ON A TEST DIVISION";
/** PUT /api/booking/settings {enabled: true, confirm} (M7c). Switching off needs no phrase. */
export const BOOKING_ENABLE_PHRASE = "ENABLE EXACT BOOKING";

/** True only for the exact phrase: no trimming, no case folding, no Unicode normalisation. */
export function phraseMatches(typed: string, phrase: string): boolean {
  return phrase.length > 0 && typed === phrase;
}

/** PATCH /api/dq/rules/:id when it loosens a rule whose severity is critical (D8a). */
export const DQ_LOOSEN_PHRASE = "LOOSEN CRITICAL DATA QUALITY RULE";

/** PUT /api/payments/switch {enabled: true, confirm} (P9a, ADR 0049). Switching off needs no phrase. */
export const PAYMENTS_ENABLE_PHRASE = "ENABLE PAYMENTS";
/** POST /api/payments/verify {confirm} (P9a): the checklist of PAYMENTS_VERIFY_CHECKS was done. */
export const PAYMENTS_VERIFY_PHRASE = "I VERIFIED THE PAYMENT PATH ON THE REVOLUT SANDBOX";
/** PATCH /api/settings/payments when it loosens a control (limit up, four-eyes off, ...). */
export const PAYMENTS_LOOSEN_PHRASE = "LOOSEN PAYMENT CONTROLS";

/**
 * The phrase a person types to confirm one payment: it contains the amount AND the last four
 * characters of the beneficiary IBAN, so a stale sheet, a wrong invoice or a changed bank account
 * cannot be confirmed by habit. "PAY 1234.56 EUR TO 4300".
 *
 * It is not a secret: the sheet shows it (the API returns it with a draft) so the person can type
 * it. Its purpose is attention, and the web must show it as text and never pre-fill the input. What
 * protects the money is server-side: the requester's fresh sign-in, the pre-checks run again and
 * the payload hash compared at confirmation (ADR 0049).
 */
export function paymentConfirmPhrase(
  amountMinor: number,
  currency: string,
  ibanLastFour: string,
): string {
  return `PAY ${formatMoney(money(amountMinor, currency))} ${currency} TO ${ibanLastFour.toUpperCase()}`;
}

/** The phrase for a batch: "PAY BATCH 3 INVOICES 1234.56 EUR". */
export function batchConfirmPhrase(count: number, totalMinor: number, currency: string): string {
  return `PAY BATCH ${count} INVOICES ${formatMoney(money(totalMinor, currency))} ${currency}`;
}
