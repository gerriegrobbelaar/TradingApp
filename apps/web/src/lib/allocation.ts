/**
 * Manual allocation maths (M7d, ADR 0043). Money is BigInt minor units; a typed amount is read as
 * decimal TEXT at the currency's real scale, never through a float. The server checks everything
 * again; this only tells the person early. No Number arithmetic: the one `Number(...)` turns a
 * checked, safe-integer BigInt into the JSON number the API takes.
 */
import { formatMoney, minorToDecimal, scaleOf } from "./format";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export type AmountError = "empty" | "format" | "decimals" | "zero" | "too_large";

export type AmountParse = { ok: true; minor: bigint } | { ok: false; error: AmountError };

/** ASCII digits only (no `u` flag, so `\d` never matches Arabic-Indic or full-width digits). */
const PLAIN = /^([0-9]+)(?:[.,]([0-9]*))?$/;
/** Longer text is never a sensible amount; refused before BigInt sees it. */
const MAX_TEXT = 24;

/**
 * Typed amount (decimal TEXT) to minor units at the currency's scale. Rule (ADR 0043):
 *  - ASCII digits, optionally ONE decimal separator, which may be "," (Dutch) or "." (as the
 *    prefill writes it): "1234,50" and "1234.50" are the same;
 *  - no thousands separators, no spaces inside, no sign, no exponent ("1e3"), no other digits
 *    (Arabic-Indic, full-width), no direction marks; leading/trailing whitespace is ignored;
 *  - more decimals than the currency has is an error, never rounded: "1,500" is refused for EUR
 *    (2 decimals) and JPY (0), and is 1.500 for KWD (3). The total must still equal the bank
 *    amount exactly, so a misread grouping cannot be submitted unnoticed.
 */
export function parseAmount(text: string, currency: string): AmountParse {
  const t = text.trim();
  if (t === "") return { ok: false, error: "empty" };
  if (t.length > MAX_TEXT) return { ok: false, error: "too_large" };
  const m = PLAIN.exec(t);
  if (!m) return { ok: false, error: "format" };
  const whole = m[1] as string;
  const frac = m[2] ?? "";
  const scale = scaleOf(currency);
  if (frac.length > scale) return { ok: false, error: "decimals" };
  const minor = BigInt(whole + frac.padEnd(scale, "0"));
  if (minor === 0n) return { ok: false, error: "zero" };
  if (minor > MAX_SAFE) return { ok: false, error: "too_large" };
  return { ok: true, minor };
}

export function amountErrorText(e: AmountError, currency: string): string {
  const scale = scaleOf(currency);
  switch (e) {
    case "empty":
      return "Type an amount.";
    case "format":
      return "Type digits with at most one decimal comma or point, for example 1234,50. No thousands separators, spaces or signs.";
    case "decimals":
      return scale === 0
        ? `${currency} has no decimals. Type a whole number.`
        : `${currency} has at most ${scale} decimals.`;
    case "zero":
      return "The amount must be more than zero.";
    case "too_large":
      return "That amount is too large.";
  }
}

/** The amount as editable text ("1234.50") for a magnitude. */
export function amountText(minor: bigint, currency: string): string {
  return minorToDecimal(minor < 0n ? -minor : minor, scaleOf(currency));
}

/** Which way a payment must go to settle the item: invoices and supplier credit notes are paid by money in. */
export function settlesDirection(kind: "invoice" | "bill", openMinor: bigint): "in" | "out" {
  return (kind === "invoice") === openMinor > 0n ? "in" : "out";
}

export interface AllocItem {
  openItemId: number;
  kind: "invoice" | "bill";
  currency: string;
  /** Signed open balance from Exact: a credit note is negative. */
  openMinor: bigint;
  /**
   * What is still FREE (|open| minus live matches recorded here), from the server
   * (GET /api/matching/items). Null while it is being checked: nothing can be submitted then.
   */
  freeMinor: bigint | null;
  /** Server status of the item ("open"; anything else cannot take an amount). */
  status?: string;
  /** What the person typed. */
  text: string;
}

export interface AllocRowCheck {
  minor: bigint | null;
  error: string | null;
}

export interface AllocationCheck {
  rows: AllocRowCheck[];
  sumMinor: bigint;
  /** The bank amount minus the sum: positive is still to allocate, negative is too much. */
  differenceMinor: bigint;
  /** What to tell the person about the total; null when every amount is valid and they add up. */
  message: string | null;
  /** The request body when everything is valid, else null. */
  request: { openItemId: number; allocatedMinor: number }[] | null;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/** The size of a signed amount in minor units (a safe integer). */
export const magnitude = (n: number): number => (n < 0 ? -n : n);

/** Validates the allocations against the bank line, live while the person types. */
export function checkAllocations(
  txAmountMinor: number | bigint,
  txCurrency: string,
  items: readonly AllocItem[],
): AllocationCheck {
  const tx = BigInt(txAmountMinor);
  const target = abs(tx);
  const direction: "in" | "out" = tx >= 0n ? "in" : "out";
  const seen = new Set<number>();
  let sum = 0n;
  let allValid = items.length > 0;
  const rows: AllocRowCheck[] = items.map((it) => {
    const parsed = parseAmount(it.text, it.currency);
    if (seen.has(it.openItemId)) {
      allValid = false;
      return { minor: null, error: "This invoice is listed twice." };
    }
    seen.add(it.openItemId);
    if (it.currency !== txCurrency) {
      allValid = false;
      return {
        minor: parsed.ok ? parsed.minor : null,
        error: `This invoice is in ${it.currency} but the payment is in ${txCurrency}.`,
      };
    }
    if (settlesDirection(it.kind, it.openMinor) !== direction) {
      allValid = false;
      return {
        minor: parsed.ok ? parsed.minor : null,
        error:
          it.openMinor < 0n
            ? "A credit note is settled by a payment in the other direction."
            : "This invoice is settled by a payment in the other direction.",
      };
    }
    if (it.status !== undefined && it.status !== "open") {
      allValid = false;
      return { minor: parsed.ok ? parsed.minor : null, error: "This invoice is closed now." };
    }
    if (!parsed.ok) {
      allValid = false;
      return { minor: null, error: amountErrorText(parsed.error, it.currency) };
    }
    sum += parsed.minor;
    if (it.freeMinor === null) {
      allValid = false;
      return { minor: parsed.minor, error: null };
    }
    if (parsed.minor > it.freeMinor) {
      allValid = false;
      const matched = abs(it.openMinor) - it.freeMinor;
      return {
        minor: parsed.minor,
        error:
          matched > 0n
            ? `More than the ${formatMoney(it.freeMinor, it.currency)} still free (${formatMoney(abs(it.openMinor), it.currency)} open in Exact, ${formatMoney(matched, it.currency)} already matched here).`
            : `More than the ${formatMoney(it.freeMinor, it.currency)} still open.`,
      };
    }
    return { minor: parsed.minor, error: null };
  });
  const difference = target - sum;
  let message: string | null = null;
  const checking = items.some((it) => it.freeMinor === null);
  if (items.length === 0) message = "Add at least one invoice.";
  else if (checking) message = "Checking what is still open on the invoices…";
  else if (difference > 0n) {
    message = `${formatMoney(difference, txCurrency)} still to allocate.`;
  } else if (difference < 0n) {
    message = `${formatMoney(-difference, txCurrency)} too much. The amounts must add up to ${formatMoney(target, txCurrency)}.`;
  }
  const ok = allValid && difference === 0n && rows.every((r) => r.error === null);
  return {
    rows,
    sumMinor: sum,
    differenceMinor: difference,
    message,
    request: ok
      ? items.map((it, i) => ({
          openItemId: it.openItemId,
          allocatedMinor: toSafeNumber((rows[i] as AllocRowCheck).minor as bigint),
        }))
      : null,
  };
}

/** A BigInt already checked to be a safe integer, as the JSON number the API takes. */
export function toSafeNumber(n: bigint): number {
  if (n > MAX_SAFE || n < -MAX_SAFE) throw new RangeError("amount out of range");
  return Number(n);
}

/** What to prefill for an added invoice: the smaller of what is free on it and what is left. */
export function suggestAllocation(
  txAmountMinor: number | bigint,
  currency: string,
  freeMinor: bigint,
  others: readonly bigint[],
): string {
  const left = abs(BigInt(txAmountMinor)) - others.reduce((a, b) => a + b, 0n);
  const cap = abs(freeMinor);
  const want = left <= 0n ? 0n : left < cap ? left : cap;
  return want === 0n ? "" : amountText(want, currency);
}
