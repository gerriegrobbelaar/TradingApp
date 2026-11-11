/**
 * The item read-back BEFORE the first write (Phase 7 review B2a, ADR 0044). Pure: no I/O.
 *
 * Booking a bank entry first and finding out afterwards that the invoice was already settled in
 * Exact would leave a second bank line behind. So the items are read from Exact before the bank
 * entry is posted, and the answer decides whether anything is sent at all:
 *
 *   open_as_expected  every item is open with exactly the amount the plan was built on: go on.
 *   already_settled   at least one item is closed in Exact: send NOTHING (`already_settled_in_exact`).
 *   changed           an item is open with another amount: send NOTHING (`items_changed`).
 *   inconclusive      missing, duplicated, other currency, contradictory: send NOTHING
 *                     (`preflight_inconclusive`).
 *
 * Only `open_as_expected` may lead to a POST; there is deliberately no way to turn one of the other
 * three into "matched": a match is `matched_in_exact` only when OUR MatchSet was verified applied.
 */
import type { ReadBackVerdict } from "@camelthorn/exact";

export type Preflight = "open_as_expected" | "already_settled" | "changed" | "inconclusive";

/** The code a person sees (outbox `last_error_code`, matches.exact_note) for a refused preflight. */
export const PREFLIGHT_CODE: Record<Exclude<Preflight, "open_as_expected">, string> = {
  already_settled: "already_settled_in_exact",
  changed: "items_changed",
  inconclusive: "preflight_inconclusive",
};

export function preflightFromVerdict(v: ReadBackVerdict): Preflight {
  if (v.outcome === "not_applied") return "open_as_expected";
  if (v.outcome === "verified") return "already_settled";
  const reasons = new Set<string>(v.problems.map((p) => p.reason));
  if (reasons.has("partially_applied")) return "already_settled";
  if (reasons.has("unexpected_open_amount")) return "changed";
  return "inconclusive";
}

/**
 * Last error codes after which OUR MatchSet may really have landed in Exact (a lost, unreadable,
 * unconfirmed or failed-after-send answer). When the items turn out closed on a later read, such a
 * row may be finished as booked. After an explicit refusal (`matchset_refused`,
 * `matchset_not_applied`, a 4xx) or when nothing was ever sent, closed items are somebody else's
 * doing: the row ends `manual_required`, never `matched_in_exact` (review B2a).
 */
const POST_MAY_HAVE_LANDED: ReadonlySet<string> = new Set([
  "network",
  "gate_error",
  "auth_after_send",
  "auth_retry_refused",
  "write_error",
  "stale_sending",
  "not_visible_after_post",
  "readback_inconclusive",
  "matchset_answer_unreadable",
  "matchset_no_success_message",
  "matchset_accepted",
]);

export function ourPostMayHaveLanded(attempts: number, lastErrorCode: string | null): boolean {
  if (attempts <= 0 || lastErrorCode === null) return false;
  return POST_MAY_HAVE_LANDED.has(lastErrorCode) || /^exact_http_\d{3}$/.test(lastErrorCode);
}
