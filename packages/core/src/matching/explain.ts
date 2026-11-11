/**
 * Plain-English explanations built from structured reasons. Pure; no locale dependencies.
 * Text that comes from outside (invoice numbers, pattern descriptions, account codes) is cleaned:
 * control and format characters (zero-width, bidi marks) removed, IBAN-like strings masked, cut
 * to 60 characters. Counterparty IBANs and raw bank references are never included.
 */
import { currencyScale } from "../money";
import { maskIbans } from "../redact";
import type { Candidate, MatchItem, MatchTx } from "./types";

const MAX_LABEL = 60;

/** Removes control/format characters, masks IBANs, cuts to `max` characters. */
export function cleanText(s: string, max = MAX_LABEL): string {
  const stripped = maskIbans(s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim());
  const chars = [...stripped];
  return chars.length > max ? `${chars.slice(0, max).join("")}...` : stripped;
}

export function itemLabel(item: MatchItem): string {
  const raw = item.invoiceNumber ?? item.entryNumber ?? item.yourRef;
  const clean = raw === null ? "" : cleanText(raw);
  return clean === "" ? `item ${item.id}` : clean;
}

/** '€ 1.234,00' for EUR, 'USD 1.234,00' otherwise; exact for any bigint. */
export function formatAmount(minor: bigint, currency: string): string {
  let scale = 2;
  let code = currency;
  try {
    scale = currencyScale(currency);
  } catch {
    code = "???";
  }
  const neg = minor < 0n;
  const digits = (neg ? -minor : minor).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = scale > 0 ? `,${digits.slice(digits.length - scale)}` : "";
  const prefix = code === "EUR" ? "€ " : `${code} `;
  return `${neg ? "-" : ""}${prefix}${whole}${frac}`;
}

export interface ExplainContext {
  tx: MatchTx;
  items: MatchItem[] | ReadonlyMap<number, MatchItem>;
}

const BLOCKS: Record<string, string> = {
  tx_frozen: "The transaction is frozen, so it needs a person",
  tx_state_conflict: "The transaction has a state conflict, so it needs a person",
  tx_type_not_auto: "This type of transaction is never matched automatically",
  item_closed: "The item is closed",
  item_has_live_match: "The item already has a live match",
  claimed_by_earlier_transaction: "An earlier transaction in this run already claims the item",
  currency_mismatch: "The currencies differ, and foreign-currency matches are never automatic",
  reference_not_exact:
    "The invoice number in the reference is not an exact plain-text match (missing prefix, look-alike or hidden characters)",
  iban_belongs_to_other_relation: "The account number belongs to another relation",
  reference_names_other_item: "The reference also names another open item",
  iban_not_known_for_supplier:
    "The account number is not one of the supplier's known IBANs, so check for fraud",
  iban_recently_changed: "The supplier's IBAN was added or changed recently",
  amount_difference: "The amount differs from the open balance",
  not_full_payment: "The payment does not settle the open balance exactly",
  suggestion_only: "A match on amount alone is a suggestion only",
  ledger_auto_disabled: "Ledger patterns are never matched automatically",
  score_below_threshold: "The score is below the automatic threshold",
  close_second_candidate: "Another candidate scores almost as high",
  not_top_candidate: "Another candidate scores higher",
};

export function explainBlock(code: string): string {
  return `${BLOCKS[code] ?? cleanText(code, 40)}, so it goes to review`;
}

export function explainCandidate(c: Candidate, ctx: ExplainContext): string[] {
  const { tx } = ctx;
  const byId: ReadonlyMap<number, MatchItem> = Array.isArray(ctx.items)
    ? new Map(ctx.items.map((i) => [i.id, i]))
    : ctx.items;
  const labels = c.allocations.map((a) => {
    const it = byId.get(a.itemId);
    return it ? itemLabel(it) : `item ${a.itemId}`;
  });
  const single = c.itemId !== null ? byId.get(c.itemId) : undefined;
  const label = labels[0] ?? (single ? itemLabel(single) : "the item");
  const amt = formatAmount(tx.amountMinor, tx.currency);
  const out: string[] = [];

  if (c.kind === "ledger") {
    const detail = c.reasons.find((r) => r.code === "pattern")?.detail;
    out.push(
      `${amt} fits the pattern "${detail ? cleanText(detail) : "a known pattern"}" for ledger account ${cleanText(c.ledgerAccountCode ?? "unknown", 20)}`,
    );
  } else if (c.reasons.some((r) => r.code === "currency_mismatch")) {
    const cur = single ? cleanText(single.currency, 3) : "another currency";
    out.push(`${amt} is in ${cleanText(tx.currency, 3)}, but ${label} is open in ${cur}`);
  } else if (c.groupId !== undefined) {
    out.push(`${amt} equals the combined open balance of ${labels.join(", ")}`);
  } else if (c.kind === "full" && c.remainingMinor === 0n && c.surplusMinor === 0n) {
    out.push(`${amt} equals the open balance of ${label}`);
  } else if (c.kind === "partial" || c.remainingMinor > 0n) {
    out.push(
      `${amt} is a part payment on ${label}; ${formatAmount(c.remainingMinor, tx.currency)} stays open`,
    );
  } else {
    out.push(
      `${amt} is ${formatAmount(c.surplusMinor, tx.currency)} more than the open balance of ${label}`,
    );
  }

  for (const r of c.reasons) {
    switch (r.code) {
      case "invoice_number_in_reference":
        out.push(
          c.referenceLevel === "exact" || c.referenceLevel === undefined
            ? `The reference contains ${r.detail ?? label}`
            : `The reference resembles ${r.detail ?? label}, but not exactly`,
        );
        break;
      case "iban_matches_relation":
        out.push("The account number belongs to the relation");
        break;
      case "iban_belongs_to_other_relation":
        out.push("The account number belongs to another relation");
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
      case "amount_within_tolerance": {
        const d = c.remainingMinor > 0n ? c.remainingMinor : c.surplusMinor;
        out.push(
          `${formatAmount(d, tx.currency)} difference from the open balance, within the tolerance`,
        );
        break;
      }
      default:
        break;
    }
  }
  return out;
}
