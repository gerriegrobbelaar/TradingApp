import type { BankTransactionDto } from "@camelthorn/core";
import { ApiError } from "../api";
import { describeLoadError } from "./errors";

/** A sentence for people for a failed bank read; 403 gets its own words. */
export function describeBankError(e: unknown): string {
  if (e instanceof ApiError && e.status === 403)
    return "You do not have access to the bank screen.";
  return describeLoadError(e);
}

export type BankStateFilter = "all" | "pending" | "completed" | "failed" | "declined" | "reverted";
export type BankDirectionFilter = "all" | "in" | "out";

export const STATE_FILTERS: readonly BankStateFilter[] = [
  "all",
  "pending",
  "completed",
  "failed",
  "declined",
  "reverted",
];
export const DIRECTION_FILTERS: readonly BankDirectionFilter[] = ["all", "in", "out"];

/**
 * For each row, "leg n of m" when other rows with the same Revolut transaction id are loaded.
 * Counted over the rows loaded, in the order shown: while more pages remain, a leg may still be on
 * a later page, so the page words it as "so far".
 */
export function legNotes(
  rows: readonly BankTransactionDto[],
): Map<number, { index: number; count: number }> {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const g = groups.get(r.externalId);
    if (g) g.push(r.id);
    else groups.set(r.externalId, [r.id]);
  }
  const out = new Map<number, { index: number; count: number }>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.forEach((id, i) => out.set(id, { index: i + 1, count: ids.length }));
  }
  return out;
}
