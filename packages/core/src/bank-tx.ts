/**
 * Bank transaction state transitions (Phase 5, ADR 0033). Pure: no I/O.
 *
 * A Revolut transaction is refreshed from several sources (webhook, poll, backfill) that can
 * deliver the same transaction out of order. The stored state must only move forward:
 *
 *   unknown --> pending --> completed --> reverted
 *                      \--> declined | failed
 *
 * Rules (old = stored leg, new = incoming leg, "not older" = the new `updated_at` is not before the
 * stored one; a missing timestamp on either side counts as not older):
 *  1. No stored leg: apply.
 *  2. New state `unknown` never replaces a known state. (Stored `unknown`: refresh if not older.)
 *  3. Stored `unknown`, new known: apply.
 *  4. Stored pending ('created' counts as pending): new pending refreshes if not older; a new
 *     final state always applies.
 *  5. Stored final: a new pending is NEVER applied (a stale or late event cannot reopen a booked
 *     transaction). The same final state refreshes the descriptive fields if not older.
 *  6. Stored final, different final: only completed -> reverted is legal (it is a later event in
 *     a transaction's life) and only if not older. Every other change (failed -> completed,
 *     reverted -> completed, declined -> failed, ...) is refused as a conflict: bookings key off
 *     final states, so an impossible change is surfaced, not applied.
 */

export type StoredBankTxState =
  "created" | "pending" | "completed" | "declined" | "failed" | "reverted" | "unknown";

export const FINAL_BANK_TX_STATES: readonly StoredBankTxState[] = [
  "completed",
  "declined",
  "failed",
  "reverted",
];

export const isFinalBankTxState = (s: StoredBankTxState): boolean =>
  FINAL_BANK_TX_STATES.includes(s);

export type LegDecisionReason =
  | "new"
  | "forward"
  | "refresh"
  | "older"
  | "unknown_ignored"
  | "regress_blocked"
  | "conflict_blocked";

export interface LegDecision {
  apply: boolean;
  reason: LegDecisionReason;
}

export interface LegStamp {
  state: StoredBankTxState;
  /** Epoch ms of the transaction's `updated_at`, null when unknown. */
  updatedAtMs: number | null;
}

const rank = (s: StoredBankTxState): StoredBankTxState => (s === "created" ? "pending" : s);

export function decideLegUpdate(stored: LegStamp | null, incoming: LegStamp): LegDecision {
  if (stored === null) return { apply: true, reason: "new" };
  const notOlder =
    stored.updatedAtMs === null ||
    incoming.updatedAtMs === null ||
    incoming.updatedAtMs >= stored.updatedAtMs;
  const refresh: LegDecision = notOlder
    ? { apply: true, reason: "refresh" }
    : { apply: false, reason: "older" };
  const old = rank(stored.state);
  const next = rank(incoming.state);

  if (next === "unknown") {
    return old === "unknown" ? refresh : { apply: false, reason: "unknown_ignored" };
  }
  if (old === "unknown") return { apply: true, reason: "forward" };
  if (old === "pending") {
    return next === "pending" ? refresh : { apply: true, reason: "forward" };
  }
  // Stored final.
  if (next === "pending") return { apply: false, reason: "regress_blocked" };
  if (next === old) return refresh;
  if (old === "completed" && next === "reverted") {
    return notOlder ? { apply: true, reason: "forward" } : { apply: false, reason: "older" };
  }
  return { apply: false, reason: "conflict_blocked" };
}

/** IBAN compact form for storage: no spaces, upper case. Empty input gives null. */
export function compactIban(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const c = v.replace(/\s+/g, "").toUpperCase();
  return c === "" ? null : c;
}
