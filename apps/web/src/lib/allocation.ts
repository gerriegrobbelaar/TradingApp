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

const PLAIN = /^(\d+)(?:[.,](\d*))?$/;

/**
 * "1234.50" or "1234,50" at the currency's scale to minor units. No thousands separators, no sign,
 * no exponent; more decimals than the currency has is an error (never rounded silently).
 */
export function parseAmount(text: string, currency: string): AmountParse {
  const t = text.trim();
  if (t === "") return { ok: false, error: "empty" };
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
      return "Type digits only, for example 1234,50. No thousands separators or signs.";
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
  /** Signed open balance: a credit note is negative. */
  openMinor: bigint;
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
    if (!parsed.ok) {
      allValid = false;
      return { minor: null, error: amountErrorText(parsed.error, it.currency) };
    }
    sum += parsed.minor;
    if (parsed.minor > abs(it.openMinor)) {
      allValid = false;
      return {
        minor: parsed.minor,
        error: `More than the ${formatMoney(abs(it.openMinor), it.currency)} still open.`,
      };
    }
    return { minor: parsed.minor, error: null };
  });
  const difference = target - sum;
  let message: string | null = null;
  if (items.length === 0) message = "Add at least one invoice.";
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

/** What to prefill for an added invoice: the smaller of its open balance and what is left. */
export function suggestAllocation(
  txAmountMinor: number | bigint,
  currency: string,
  openMinor: bigint,
  others: readonly bigint[],
): string {
  const left = abs(BigInt(txAmountMinor)) - others.reduce((a, b) => a + b, 0n);
  const want = left <= 0n ? 0n : left < abs(openMinor) ? left : abs(openMinor);
  return want === 0n ? "" : amountText(want, currency);
}
