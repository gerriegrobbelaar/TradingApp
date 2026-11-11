/**
 * Purchase-entry approval status (Phase 4, task K4, ADR 0025). Pure: no I/O.
 *
 * Exact reports a purchase entry's state as a numeric `Status`. THE MAPPING BELOW IS NOT VERIFIED
 * AGAINST A REAL ADMINISTRATION: every row is a recollection and the whole table is flagged
 * "verify with credentials" (ADR 0025). The rules that keep it safe whatever the table says:
 *
 *  - a code that is not in the table is `unknown`, never `approved`;
 *  - only `approved` allows a payment (`isInvoiceApprovedForPayment`, which also requires the row
 *    to be recently confirmed by a read), so a wrong guess towards `pending_approval` or
 *    `rejected` can only stop a payment, never allow one;
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

/**
 * Longest a cached row may be unconfirmed for the payment pre-check: every row in the read's scope
 * is refreshed by the nightly full read, so a row not seen for 36 hours means the reads are failing
 * or the entry left the scope (older than the window and not pending) and is no longer refreshed.
 * Callers may ask for less, never for more.
 */
export const APPROVAL_MAX_AGE_MS = 36 * 60 * 60 * 1000;
/** A last-seen stamp further in the future than this is not trusted (clock or data fault). */
const APPROVAL_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * `settings.key` of the "mapping verified" gate (review S2, ADR 0025). Value JSON:
 * `{ verifiedAt, verifiedBy, adrRef }`. Absent (the default) means NOT verified, and then no
 * entry counts as approved for payment, whatever the table says.
 */
export const APPROVAL_MAPPING_VERIFIED_SETTING = "exact.approval_mapping_verified";

/** The exact text an admin must send to record the verification (a deliberate, typed act). */
export const APPROVAL_MAPPING_CONFIRMATION =
  "I verified the approval status mapping against Exact";

/** What the stored "verified" marker looks like (all three are required). */
export interface ApprovalMappingVerified {
  verifiedAt: string;
  verifiedBy: string;
  adrRef: string;
}

/** Parses the stored setting; null (= not verified) for anything that is not complete. */
export function parseApprovalMappingVerified(valueJson: string | null): ApprovalMappingVerified | null {
  if (valueJson === null) return null;
  try {
    const v: unknown = JSON.parse(valueJson);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const { verifiedAt, verifiedBy, adrRef } = o;
    if (
      typeof verifiedAt !== "string" ||
      Number.isNaN(Date.parse(verifiedAt)) ||
      typeof verifiedBy !== "string" ||
      verifiedBy === "" ||
      typeof adrRef !== "string" ||
      adrRef === ""
    ) {
      return null;
    }
    return { verifiedAt, verifiedBy, adrRef };
  } catch {
    return null;
  }
}

/** What the payment pre-check needs of a cached purchase entry (purchase_entries row). */
export interface ApprovalForPayment {
  /** Stored, derived status. */
  status: ApprovalStatus;
  /** Exact's raw Status: re-derived with the CURRENT table, so a corrected table applies at once. */
  statusCode: number | null;
  /** When a read last returned the row (`synced_at`), ISO instant. */
  lastSeenAt: string | null;
  /** Complete reads in a row that did not see it (`missed_cycles`); > 0 means "maybe gone". */
  missedCycles: number;
}

/**
 * Phase 9 pre-check "invoice approved in Exact" (CLAUDE.md 4.3) on the CACHE. True ONLY when every
 * one of these holds; anything missing, unparsable or doubtful is false:
 *  - the stored status is `approved` AND the raw code maps to `approved` under the current table
 *    (a stale derivation, a hand-edited row or a code removed from the table is not approved);
 *  - the row was seen by a read within `maxAgeMs` (default and upper bound APPROVAL_MAX_AGE_MS)
 *    and not in the future;
 *  - the last complete read saw it (`missedCycles` is 0);
 *  - the status mapping has been verified on a real division (`opts.mappingVerified === true`,
 *    from the `exact.approval_mapping_verified` setting; default false, review S2).
 * Phase 9 must also re-read the entry from Exact before it sends a payment.
 */
export function isInvoiceApprovedForPayment(
  entry: ApprovalForPayment,
  opts: { nowMs: number; maxAgeMs?: number; mappingVerified?: boolean },
): boolean {
  if (opts.mappingVerified !== true) return false;
  if (entry.status !== "approved") return false;
  if (approvalStatusFromCode(entry.statusCode) !== "approved") return false;
  if (!Number.isSafeInteger(entry.missedCycles) || entry.missedCycles !== 0) return false;
  const maxAge = Math.min(opts.maxAgeMs ?? APPROVAL_MAX_AGE_MS, APPROVAL_MAX_AGE_MS);
  if (!Number.isFinite(opts.nowMs) || !(maxAge > 0)) return false;
  if (entry.lastSeenAt === null) return false;
  const seen = Date.parse(entry.lastSeenAt);
  if (Number.isNaN(seen)) return false;
  const age = opts.nowMs - seen;
  return age >= -APPROVAL_FUTURE_TOLERANCE_MS && age <= maxAge;
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
