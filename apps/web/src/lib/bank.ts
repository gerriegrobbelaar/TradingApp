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

export interface LegNote {
  /** Legs of this Revolut transaction: exact, or a lower bound when `atLeast`. */
  count: number;
  atLeast: boolean;
}

/**
 * For each row that is one leg of a multi-leg Revolut transaction, how many legs it has. The
 * server's `legCount` is used when present. Without it the legs are counted over the rows loaded,
 * which is a lower bound while more pages remain or a filter (account, direction, state, dates,
 * search) can hide the other legs, so the note then says "at least". No leg index is shown: the
 * load order is not the leg order the sheet lists.
 */
export function legNotes(
  rows: readonly BankTransactionDto[],
  complete: boolean,
): Map<number, LegNote> {
  const groups = new Map<string, number>();
  for (const r of rows) groups.set(r.externalId, (groups.get(r.externalId) ?? 0) + 1);
  const out = new Map<number, LegNote>();
  for (const r of rows) {
    const server = r.legCount;
    if (typeof server === "number" && Number.isSafeInteger(server) && server >= 1) {
      if (server > 1) out.set(r.id, { count: server, atLeast: false });
      continue;
    }
    const loaded = groups.get(r.externalId) ?? 1;
    if (loaded > 1) out.set(r.id, { count: loaded, atLeast: !complete });
  }
  return out;
}

export function legNoteText(n: LegNote): string {
  return `${n.atLeast ? "One of at least" : "One of"} ${n.count} legs, see details`;
}
