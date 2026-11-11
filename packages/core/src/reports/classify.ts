/**
 * Classification of Exact general ledger accounts into report sections (ADR 0023).
 *
 * Every Type code and keyword below is a RECOLLECTION of Exact's account types, to verify with
 * credentials. That is why the rules are conservative and why nothing is ever dropped: an account
 * that does not clearly belong in a section lands in "unclassified", which the reports show as a
 * line of its own, so totals still reconcile and a wrong guess is visible rather than hidden.
 *
 * Balance sheet (BalanceType 'B'), in this order:
 *  1. The numeric Type code, from BS_TYPE_SECTIONS.
 *  2. Else keywords in TypeDescription (English and Dutch), equity before liabilities before
 *     assets so a word such as "reserve" is not read as an asset.
 *  3. Else unclassified.
 *  Then a side check: assets are expected on the debit side, liabilities and equity on the credit
 *  side. If Exact says the account's BalanceSide is the other one, the guess is not trusted and the
 *  account is unclassified.
 *
 * Profit and loss (BalanceType 'W'): the BalanceSide alone. Credit side = revenue, debit side =
 * costs, unknown side = unclassified.
 */
import type { ResolvedAccount } from "./ledger";

export type BalanceSheetSection = "assets" | "liabilities" | "equity" | "unclassified";
export type ProfitLossSection = "revenue" | "costs" | "unclassified";

/** Exact GLAccount.Type codes (recollection, verify with credentials). */
export const BS_TYPE_SECTIONS: Readonly<Record<number, "assets" | "liabilities">> = {
  10: "assets", // cash
  12: "assets", // bank
  20: "assets", // accounts receivable
  21: "liabilities", // accounts payable
  22: "liabilities", // accounts payable (alternative code)
};

const EQUITY_WORDS =
  /\b(equity|capital|reserves?|retained|eigen vermogen|eigenvermogen|kapitaal|overgedragen)\b/i;
const LIABILITY_WORDS =
  /\b(payables?|creditors?|crediteuren|crediteur|loans?|lening|leningen|liabilit\w*|schuld\w*|vat|btw|tax|belasting\w*|accruals?|provisions?|voorzieningen)\b/i;
const ASSET_WORDS =
  /\b(cash|bank|kas|receivables?|debtors?|debiteuren|debiteur|stock|inventory|voorraad|fixed assets?|vaste activa|assets?|activa|prepaid|vooruitbetaald\w*|investments?)\b/i;

export function classifyBalanceSheetAccount(
  a: Pick<ResolvedAccount, "type" | "typeDescription" | "balanceSide">,
): BalanceSheetSection {
  let section: BalanceSheetSection = "unclassified";
  const byCode = a.type === null ? undefined : BS_TYPE_SECTIONS[a.type];
  if (byCode !== undefined) {
    section = byCode;
  } else if (a.typeDescription !== null) {
    const d = a.typeDescription;
    if (EQUITY_WORDS.test(d)) section = "equity";
    else if (LIABILITY_WORDS.test(d)) section = "liabilities";
    else if (ASSET_WORDS.test(d)) section = "assets";
  }
  if (section === "unclassified" || a.balanceSide === null) return section;
  const expected = section === "assets" ? "D" : "C";
  return a.balanceSide === expected ? section : "unclassified";
}

export function classifyProfitLossAccount(
  a: Pick<ResolvedAccount, "balanceSide">,
): ProfitLossSection {
  if (a.balanceSide === "C") return "revenue";
  if (a.balanceSide === "D") return "costs";
  return "unclassified";
}
