/**
 * Settings, Matching, account map: the control accounts and the opening balance that booking in
 * Exact needs (Phase 7 review B1). The server validates again; this tells the person early.
 */
import { amountErrorText, amountText, parseAmount, type AmountError } from "./allocation";

export type OpeningBalanceError = AmountError | "sign";

export type OpeningBalanceParse =
  { ok: true; minor: bigint | null } | { ok: false; error: OpeningBalanceError };

/** The server's bound (PUT /api/matching/account-map refuses |value| > 1e13 minor units). */
export const OPENING_BALANCE_MAX_MINOR = 10_000_000_000_000n;

/**
 * The optional opening balance of an EMPTY Exact journal, typed as decimal text at the bank
 * account currency's scale (the exact parser of the allocation editor; no floats). Empty means
 * "not set" (null). Zero is allowed (an empty journal opens at 0). One leading ASCII "-" is allowed
 * for a journal that opens overdrawn (the server takes a signed integer); "+", a trailing sign, a
 * unicode minus or a sign followed by a space are refused, so a typo never flips the balance.
 */
export function parseOpeningBalance(text: string, currency: string): OpeningBalanceParse {
  const t = text.trim();
  if (t === "") return { ok: true, minor: null };
  const negative = t.startsWith("-");
  const body = negative ? t.slice(1) : t;
  if (body === "" || /[^0-9.,]/.test(body)) {
    return { ok: false, error: /[-+\u2212]/.test(t) ? "sign" : "format" };
  }
  const r = parseAmount(body, currency);
  let minor: bigint;
  if (r.ok) minor = r.minor;
  else if (r.error === "zero") minor = 0n;
  else return { ok: false, error: r.error };
  if (minor > OPENING_BALANCE_MAX_MINOR) return { ok: false, error: "too_large" };
  return { ok: true, minor: negative ? -minor : minor };
}

export function openingBalanceErrorText(e: OpeningBalanceError, currency: string): string {
  if (e === "sign") {
    return "Use one minus sign in front for a journal that opens overdrawn, for example -250,00. No plus sign or other characters.";
  }
  if (e === "format") {
    return "Type digits with at most one decimal comma or point, for example 1234,50, and a minus sign in front only when the journal opens overdrawn. No thousands separators or spaces.";
  }
  return amountErrorText(e, currency);
}

/**
 * The server sends the stored balance as a signed integer of minor units (or null). Anything that
 * is not a safe integer within the server's bound is dropped, so a malformed answer never prefills.
 */
export function openingBalanceText(minor: number | null | undefined, currency: string): string {
  if (typeof minor !== "number" || !Number.isSafeInteger(minor)) return "";
  const b = BigInt(minor);
  const mag = b < 0n ? -b : b;
  if (mag > OPENING_BALANCE_MAX_MINOR) return "";
  return (b < 0n ? "-" : "") + amountText(mag, currency);
}

/** The request value: a checked BigInt within 1e13 is a safe integer, so Number() is exact. */
export function openingBalanceRequest(p: OpeningBalanceParse): number | null {
  return p.ok && p.minor !== null ? Number(p.minor) : null;
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
