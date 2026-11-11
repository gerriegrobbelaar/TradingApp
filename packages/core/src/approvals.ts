/**
 * Purchase-entry approval status (Phase 4, task K4, ADR 0025). Pure: no I/O.
 *
 * Exact reports a purchase entry's state as a numeric `Status`. THE MAPPING BELOW IS NOT VERIFIED
 * AGAINST A REAL ADMINISTRATION: every row is a recollection and the whole table is flagged
 * "verify with credentials" (ADR 0025). The rules that keep it safe whatever the table says:
 *
 *  - a code that is not in the table is `unknown`, never `approved`;
 *  - only `approved` allows a payment (`isInvoiceApprovedForPayment`), so a wrong guess towards
 *    `pending_approval` or `rejected` can only stop a payment, never allow one;
 *  - the one `approved` row is therefore the one to check first (and Phase 9 must not enable
 *    paying until it has been checked, see the ADR).
 */
import { addDays, dayNumber } from "./ageing";
import type { ApprovalStatus } from "./api-types";
import { amsterdamDate } from "./local-time";

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending_approval",
  "approved",
  "rejected",
  "unknown",
];

/**
 * THE mapping table: Exact `Status` code -> ApprovalStatus. Verify with credentials (ADR 0025).
 * Add or change codes here only; nothing else in the code base looks at raw codes.
 */
export const PURCHASE_ENTRY_STATUS_TABLE: Readonly<
  Record<number, Exclude<ApprovalStatus, "unknown">>
> = {
  // Unverified: "5 = waiting for approval" (the reviewer's recollection).
  5: "pending_approval",
  // Unverified: "50 = processed / final". The dangerous row: it allows payment.
  50: "approved",
};

/** The ApprovalStatus of an Exact status code; null, NaN and unlisted codes are `unknown`. */
export function approvalStatusFromCode(
  code: number | null,
  table: Readonly<Record<number, ApprovalStatus>> = PURCHASE_ENTRY_STATUS_TABLE,
): ApprovalStatus {
  if (code === null || !Number.isInteger(code)) return "unknown";
  return Object.prototype.hasOwnProperty.call(table, code) ? (table[code] ?? "unknown") : "unknown";
}

/** Exact codes that mean "waiting for approval": entries in them are read whatever their age. */
export function pendingStatusCodes(
  table: Readonly<Record<number, ApprovalStatus>> = PURCHASE_ENTRY_STATUS_TABLE,
): number[] {
  return Object.entries(table)
    .filter(([, s]) => s === "pending_approval")
    .map(([c]) => Number(c))
    .sort((a, b) => a - b);
}

/**
 * Purchase entries are read when their entry date or last change is within this many days, or when
 * they are still waiting for approval (ADR 0025). Bounds the volume of the read.
 */
export const PURCHASE_ENTRY_WINDOW_DAYS = 120;

/** Phase 9 pre-check "invoice approved in Exact": true ONLY for `approved`. Unknown is false. */
export function isInvoiceApprovedForPayment(entry: { status: ApprovalStatus }): boolean {
  return entry.status === "approved";
}

/**
 * Whole Amsterdam calendar days an item has been waiting: from the submission (or, without it,
 * the entry date) to `today`, never negative. Null unless the item is pending approval or has no
 * usable date.
 */
export function approvalAgeDays(
  item: { status: ApprovalStatus; submittedAt: string | null; entryDate: string | null },
  today: string,
): number | null {
  if (item.status !== "pending_approval") return null;
  const from =
    item.submittedAt !== null ? amsterdamDate(item.submittedAt) : (item.entryDate ?? null);
  if (from === null) return null;
  try {
    return Math.max(0, dayNumber(today) - dayNumber(from));
  } catch {
    return null;
  }
}

/** First date of the read window for `today` (Amsterdam calendar date). */
export const purchaseWindowStart = (today: string): string =>
  addDays(today, -PURCHASE_ENTRY_WINDOW_DAYS);
