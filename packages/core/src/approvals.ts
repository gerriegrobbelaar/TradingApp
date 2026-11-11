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
import { sha256Hex } from "./sha256";

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
 * Version of the rule that joins a payable (open_items) to its purchase entry
 * (`purchaseEntryJoinKey` + `findPurchaseEntryForPayable`). It is part of the mapping fingerprint:
 * bump it whenever the join rule changes, and the "verified" mark stops counting until an admin
 * verifies again.
 */
export const PAYABLE_PURCHASE_JOIN_RULE_VERSION = 1;

/**
 * `settings.key` of the "mapping verified" gate (review S2, ADR 0025). Value JSON:
 * `{ verifiedAt, verifiedBy, adrRef, mappingHash }`. Absent (the default) means NOT verified, and
 * then no entry counts as approved for payment, whatever the table says.
 */
export const APPROVAL_MAPPING_VERIFIED_SETTING = "exact.approval_mapping_verified";

/** The exact text an admin must type to record the verification (a deliberate act). */
export const APPROVAL_MAPPING_CONFIRMATION = "I verified the approval status mapping against Exact";

/**
 * Stable canonical text of what was verified: the status table (code -> status, sorted by code,
 * keys as Exact codes) and the join rule version. Any change to either changes the text.
 */
export function approvalMappingCanonical(
  table: Readonly<Record<number, ApprovalStatus>> = PURCHASE_ENTRY_STATUS_TABLE,
  joinRuleVersion: number = PAYABLE_PURCHASE_JOIN_RULE_VERSION,
): string {
  const rows = Object.keys(table)
    .sort((a, b) => {
      const d = Number(a) - Number(b);
      return Number.isNaN(d) || d === 0 ? (a < b ? -1 : a > b ? 1 : 0) : d;
    })
    .map((k) => [k, (table as Record<string, ApprovalStatus>)[k] ?? null]);
  return JSON.stringify({ format: 1, joinRuleVersion, table: rows });
}

/** SHA-256 hex of `approvalMappingCanonical` (defaults: the CURRENT table and join rule). */
export function approvalMappingHash(
  table: Readonly<Record<number, ApprovalStatus>> = PURCHASE_ENTRY_STATUS_TABLE,
  joinRuleVersion: number = PAYABLE_PURCHASE_JOIN_RULE_VERSION,
): string {
  return sha256Hex(approvalMappingCanonical(table, joinRuleVersion));
}

/** What the stored "verified" marker looks like (all four are required). */
export interface ApprovalMappingVerified {
  verifiedAt: string;
  verifiedBy: string;
  adrRef: string;
  /** approvalMappingHash() of the table and join rule at the moment of verification. */
  mappingHash: string;
}

const HASH_RE = /^[0-9a-f]{64}$/;

/** Parses the stored setting; null (= not verified) for anything that is not complete. */
export function parseApprovalMappingVerified(
  valueJson: string | null,
): ApprovalMappingVerified | null {
  if (valueJson === null) return null;
  try {
    const v: unknown = JSON.parse(valueJson);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const { verifiedAt, verifiedBy, adrRef, mappingHash } = o;
    if (
      typeof verifiedAt !== "string" ||
      Number.isNaN(Date.parse(verifiedAt)) ||
      typeof verifiedBy !== "string" ||
      verifiedBy === "" ||
      typeof adrRef !== "string" ||
      adrRef === "" ||
      typeof mappingHash !== "string" ||
      !HASH_RE.test(mappingHash)
    ) {
      return null;
    }
    return { verifiedAt, verifiedBy, adrRef, mappingHash };
  } catch {
    return null;
  }
}

/**
 * Result of checking the stored marker against the CURRENT table. Only `checkApprovalMapping`
 * creates one (registered in a module-private WeakSet), so `isInvoiceApprovedForPayment` cannot be
 * satisfied by a hand-written `{ verified: true }` or a value that crossed JSON.
 */
export type ApprovalMappingCheck =
  | Readonly<{ verified: false; reason: "not_verified"; marker: null; currentHash: string }>
  | Readonly<{
      verified: false;
      reason: "mapping_changed";
      marker: ApprovalMappingVerified;
      currentHash: string;
    }>
  | Readonly<{
      verified: true;
      reason: null;
      marker: ApprovalMappingVerified;
      currentHash: string;
    }>;

const ISSUED = new WeakSet<object>();

/**
 * Verified only when the stored marker parses AND its `mappingHash` equals the hash of the table
 * and join rule as they are now. A missing or malformed marker is `not_verified`; a marker for an
 * older table (or join rule) is `mapping_changed`.
 */
export function checkApprovalMapping(
  valueJson: string | null,
  table: Readonly<Record<number, ApprovalStatus>> = PURCHASE_ENTRY_STATUS_TABLE,
  joinRuleVersion: number = PAYABLE_PURCHASE_JOIN_RULE_VERSION,
): ApprovalMappingCheck {
  const currentHash = approvalMappingHash(table, joinRuleVersion);
  const marker = parseApprovalMappingVerified(valueJson);
  const check: ApprovalMappingCheck =
    marker === null
      ? { verified: false, reason: "not_verified", marker: null, currentHash }
      : marker.mappingHash === currentHash
        ? { verified: true, reason: null, marker, currentHash }
        : { verified: false, reason: "mapping_changed", marker, currentHash };
  Object.freeze(check);
  ISSUED.add(check);
  return check;
}

/**
 * Join key of an entry number (ADR 0025 addendum, join rule version 1): trimmed text; a purely
 * numeric value loses its leading zeros ("000123", " 123" and 123 are one key, "0" and "000" are
 * "0"); anything else is kept as is, so "A001" and "A1" stay different. Null for missing, empty,
 * negative, non-integer or unsafe numbers.
 */
export function purchaseEntryJoinKey(
  entryNumber: string | number | null | undefined,
): string | null {
  if (entryNumber === null || entryNumber === undefined) return null;
  if (typeof entryNumber === "number") {
    if (!Number.isSafeInteger(entryNumber) || entryNumber < 0) return null;
    return String(entryNumber);
  }
  const t = entryNumber.trim();
  if (t === "") return null;
  if (/^[0-9]+$/.test(t)) return t.replace(/^0+(?=[0-9])/, "");
  return t;
}

/** The side of the join a payable brings (an open_items row of kind payable). */
export interface PayableJoinSide {
  divisionId: number;
  entryNumber: number | string | null;
  journalCode?: string | null;
}
/** The side of the join a cached purchase entry brings. */
export interface PurchaseEntryJoinSide {
  divisionId: number;
  entryNumber: string | number | null;
  journalCode?: string | null;
}

const journalKey = (j: string | null | undefined): string | null => {
  if (j === null || j === undefined) return null;
  const t = j.trim();
  return t === "" ? null : t;
};

/**
 * The ONE purchase entry of a payable, or null: same division, same join key and, when both sides
 * carry a journal code, the same journal. No match or more than one match is null ("not
 * approved", never a guess).
 */
export function findPurchaseEntryForPayable<T extends PurchaseEntryJoinSide>(
  payable: PayableJoinSide,
  entries: readonly T[],
): T | null {
  const key = purchaseEntryJoinKey(payable.entryNumber);
  if (key === null || !Number.isSafeInteger(payable.divisionId)) return null;
  const pj = journalKey(payable.journalCode);
  const hits = entries.filter((e) => {
    if (e.divisionId !== payable.divisionId) return false;
    if (purchaseEntryJoinKey(e.entryNumber) !== key) return false;
    const ej = journalKey(e.journalCode);
    return pj === null || ej === null || pj === ej;
  });
  return hits.length === 1 ? (hits[0] as T) : null;
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
 *  - the status mapping has been verified for the CURRENT table and join rule: `opts.mapping` is a
 *    check returned by `checkApprovalMapping` (from the `exact.approval_mapping_verified` setting)
 *    with `verified === true`, and its hash still equals the table's hash now (review S2). A
 *    missing setting, a malformed one, a mark for an older table or anything not produced by
 *    `checkApprovalMapping` is false.
 * Phase 9 must also join the payable to exactly one entry (`findPurchaseEntryForPayable`) and
 * re-read the entry from Exact before it sends a payment.
 */
export function isInvoiceApprovedForPayment(
  entry: ApprovalForPayment,
  opts: { nowMs: number; maxAgeMs?: number; mapping: ApprovalMappingCheck },
): boolean {
  const m: unknown = opts.mapping;
  if (typeof m !== "object" || m === null || !ISSUED.has(m)) return false;
  if (opts.mapping.verified !== true) return false;
  if (opts.mapping.marker.mappingHash !== approvalMappingHash()) return false;
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
