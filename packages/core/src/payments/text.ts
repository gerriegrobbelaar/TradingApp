/**
 * Text rules for a payment: the reference line (SEPA character set) and the request id.
 * Pure. The reference is built from the invoice number and nothing else the supplier controls.
 */
import { PAYMENT_REFERENCE_MAX } from "./types";

/**
 * Characters SEPA credit transfers allow in text: a-z A-Z 0-9 / - ? : ( ) . , ' + and space.
 * Everything else is replaced by a space (letters with accents lose the accent first).
 */
const SEPA_ALLOWED = /[A-Za-z0-9/\-?:().,'+ ]/;

export function sanitizeSepaText(input: string): string {
  if (typeof input !== "string") return "";
  let out = "";
  // NFKD splits "é" into "e" + a combining mark; marks are dropped, format characters
  // (zero-width, bidi controls) vanish, everything else outside the set becomes a space.
  for (const ch of input.normalize("NFKD")) {
    if (/\p{M}|\p{Cf}/u.test(ch)) continue;
    out += SEPA_ALLOWED.test(ch) ? ch : " ";
  }
  out = out
    .replace(/\/{2,}/g, "/")
    .replace(/ {2,}/g, " ")
    .trim();
  // SEPA: no leading or trailing "/" in an identifier-like field; cheap to honour everywhere.
  out = out.replace(/^\/+|\/+$/g, "").trim();
  return out;
}

export interface BuiltReference {
  /** Null when nothing usable is left (the pre-check then blocks with `reference_empty`). */
  reference: string | null;
  shortened: boolean;
}

/** "Invoice <number>", sanitised and capped. The number is the only input. */
export function buildPaymentReference(
  invoiceNumber: string | number | null | undefined,
  max: number = PAYMENT_REFERENCE_MAX,
): BuiltReference {
  if (invoiceNumber === null || invoiceNumber === undefined) {
    return { reference: null, shortened: false };
  }
  const number = sanitizeSepaText(String(invoiceNumber));
  if (number === "") return { reference: null, shortened: false };
  const full = `Invoice ${number}`;
  if (full.length <= max) return { reference: full, shortened: false };
  // Cut, then drop a trailing space or slash left by the cut.
  const cut = full
    .slice(0, max)
    .replace(/[ /]+$/, "")
    .trim();
  return { reference: cut, shortened: true };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A lower-case UUID version 4 (the shape of `crypto.randomUUID()`). */
export const isUuidV4 = (v: unknown): v is string => typeof v === "string" && UUID_V4.test(v);
