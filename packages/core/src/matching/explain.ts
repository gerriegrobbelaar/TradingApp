/** Plain-English explanations built from structured reasons. Pure; no locale dependencies. */
import { currencyScale } from "../money";
import type { Candidate, MatchItem, MatchTx } from "./types";

export function itemLabel(item: MatchItem): string {
  return item.invoiceNumber ?? item.entryNumber ?? item.yourRef ?? `item ${item.id}`;
}

/** '€ 1.234,00' for EUR, 'USD 1.234,00' otherwise; exact for any bigint. */
export function formatAmount(minor: bigint, currency: string): string {
  const scale = currencyScale(currency);
  const neg = minor < 0n;
  const digits = (neg ? -minor : minor).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = scale > 0 ? `,${digits.slice(digits.length - scale)}` : "";
  const prefix = currency === "EUR" ? "€ " : `${currency} `;
  return `${neg ? "-" : ""}${prefix}${whole}${frac}`;
}

export interface ExplainContext {
  tx: MatchTx;
  items: MatchItem[];
}

const BLOCKS: Record<string, string> = {
  tx_frozen: "The transaction is frozen, so it needs a person",
  tx_state_conflict: "The transaction has a state conflict, so it needs a person",
  item_closed: "The item is closed",
  item_has_live_match: "The item already has a live match",
  claimed_by_earlier_transaction: "An earlier transaction in this run already claims the item",
  currency_mismatch: "The currencies differ, and foreign-currency matches are never automatic",
  iban_not_known_for_supplier:
    "The account number is not one of the supplier's known IBANs, so check for fraud",
  iban_recently_changed: "The supplier's IBAN was added or changed recently",
  not_full_payment: "The payment does not settle the open balance exactly",
  suggestion_only: "A match on amount alone is a suggestion only",
  ledger_auto_disabled: "Ledger patterns are never matched automatically",
  score_below_threshold: "The score is below the automatic threshold",
  close_second_candidate: "Another candidate scores almost as high",
  not_top_candidate: "Another candidate scores higher",
};

export function explainBlock(code: string): string {
  return `${BLOCKS[code] ?? code}, so it goes to review`;
}

export function explainCandidate(c: Candidate, ctx: ExplainContext): string[] {
  const { tx } = ctx;
  const byId = new Map(ctx.items.map((i) => [i.id, i]));
  const labels = c.allocations.map((a) => {
    const it = byId.get(a.itemId);
    return it ? itemLabel(it) : `item ${a.itemId}`;
  });
  const single = c.itemId !== null ? byId.get(c.itemId) : undefined;
  const label = labels[0] ?? (single ? itemLabel(single) : "the item");
  const amt = formatAmount(tx.amountMinor, tx.currency);
  const out: string[] = [];

  if (c.kind === "ledger") {
    const detail = c.reasons.find((r) => r.code === "pattern")?.detail ?? "a known pattern";
    out.push(
      `${amt} fits the pattern "${detail}" for ledger account ${c.ledgerAccountCode ?? "unknown"}`,
    );
  } else if (c.reasons.some((r) => r.code === "currency_mismatch")) {
    const cur = single ? single.currency : "another currency";
    out.push(`${amt} is in ${tx.currency}, but ${label} is open in ${cur}`);
  } else if (c.groupId !== undefined) {
    out.push(`${amt} equals the combined open balance of ${labels.join(", ")}`);
  } else if (c.kind === "full") {
    out.push(`${amt} equals the open balance of ${label}`);
  } else if (c.kind === "partial") {
    out.push(
      `${amt} is a part payment on ${label}; ${formatAmount(c.remainingMinor, tx.currency)} stays open`,
    );
  } else {
    const surplus = tx.amountMinor - c.allocatedMinor;
    out.push(
      `${amt} is ${formatAmount(surplus, tx.currency)} more than the open balance of ${label}`,
    );
  }

  for (const r of c.reasons) {
    switch (r.code) {
      case "invoice_number_in_reference":
        out.push(`The reference contains ${r.detail ?? label}`);
        break;
      case "iban_matches_relation":
        out.push("The account number belongs to the relation");
        break;
      case "unique_for_relation":
        out.push("It is the only open item of the relation with this amount");
        break;
      case "single_amount_candidate":
        out.push("It is the only open item with this amount");
        break;
      case "multiple_amount_candidates":
        out.push("Several open items have this amount");
        break;
      case "name_similar":
        out.push("The counterparty name resembles the relation name");
        break;
      case "due_date_near":
        out.push("The payment is within 7 days of the due date");
        break;
      default:
        break;
    }
  }
  return out;
}
