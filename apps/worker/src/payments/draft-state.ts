/**
 * How we read a Revolut payment draft (P9b, ADR 0050). Pure. Shared by the reconciliation and the
 * submitter's check of earlier attempts for the same invoice (review P9b), so both read a draft the
 * same way. The state words are A-items (A8): anything not clearly done or refused is pending.
 */
import type { PaymentDraftView } from "@camelthorn/revolut";

export const DRAFT_FAILED_WORDS: ReadonlySet<string> = new Set([
  "failed",
  "declined",
  "revoked",
  "cancelled",
  "canceled",
  "rejected",
  "reverted",
  "deleted",
]);

export type DraftVerdict =
  | {
      kind: "paid";
      /** The first payment's transaction id (single drafts), or null. */
      transactionId: string | null;
      /** Every transaction id the draft names (one per payment that has one). */
      transactionIds: string[];
    }
  | { kind: "failed"; code: string }
  | { kind: "pending" }
  /** Some payments done and some refused: a person must look. */
  | { kind: "mixed" };

/** Reads the states of a draft (A-item words). Anything not clearly done or refused is pending. */
export function interpretDraft(v: PaymentDraftView): DraftVerdict {
  const states = v.payments.map((p) => p.state ?? v.state ?? "");
  const transactionIds = v.payments.flatMap((p) =>
    p.transactionId !== undefined ? [p.transactionId] : [],
  );
  if (states.length === 0) {
    const s = v.state ?? "";
    if (s === "completed") return { kind: "paid", transactionId: null, transactionIds: [] };
    if (DRAFT_FAILED_WORDS.has(s)) return { kind: "failed", code: s };
    return { kind: "pending" };
  }
  const done = states.filter((s) => s === "completed").length;
  const bad = states.filter((s) => DRAFT_FAILED_WORDS.has(s));
  if (done === states.length) {
    return {
      kind: "paid",
      transactionId: v.payments[0]?.transactionId ?? null,
      transactionIds,
    };
  }
  if (bad.length > 0 && done > 0) return { kind: "mixed" };
  if (bad.length > 0) return { kind: "failed", code: bad[0] ?? "failed" };
  return { kind: "pending" };
}

/** A draft that can still lead to money leaving (pending, partly or fully done). */
export function draftIsLive(v: PaymentDraftView): boolean {
  return interpretDraft(v).kind !== "failed";
}
