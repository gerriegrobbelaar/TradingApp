/**
 * Settings, Matching, account map: the control accounts and the opening balance that booking in
 * Exact needs (Phase 7 review B1). The server validates again; this tells the person early.
 */
import { amountText, parseAmount, type AmountError } from "./allocation";

export type OpeningBalanceParse =
  { ok: true; minor: bigint | null } | { ok: false; error: AmountError };

/**
 * The optional opening balance of an EMPTY Exact journal, typed as decimal text at the bank
 * account currency's scale (the exact parser of the allocation editor; no floats). Empty means
 * "not set" (null). Zero is allowed here (an empty journal opens at 0), unlike an allocation. No
 * sign: a journal that opens overdrawn is entered in Exact first.
 */
export function parseOpeningBalance(text: string, currency: string): OpeningBalanceParse {
  if (text.trim() === "") return { ok: true, minor: null };
  const r = parseAmount(text, currency);
  if (r.ok) return { ok: true, minor: r.minor };
  if (r.error === "zero") return { ok: true, minor: 0n };
  return { ok: false, error: r.error };
}

/** The server sends the stored balance as a decimal string of minor units; anything else is dropped. */
export function openingBalanceText(minor: string | null | undefined, currency: string): string {
  if (typeof minor !== "string" || !/^[0-9]{1,18}$/.test(minor)) return "";
  return amountText(BigInt(minor), currency);
}

export const CONTROL_ACCOUNTS_HELP =
  "Needed to book matches in Exact. Without these, matches wait and nothing is booked.";

/** A mapped account is incomplete for booking until both control accounts are filled in. */
export function controlAccountsMissing(a: {
  divisionId: number | null;
  receivableGlAccountCode?: string | null | undefined;
  payableGlAccountCode?: string | null | undefined;
}): boolean {
  return (
    a.divisionId !== null &&
    ((a.receivableGlAccountCode ?? "") === "" || (a.payableGlAccountCode ?? "") === "")
  );
}
