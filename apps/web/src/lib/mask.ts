/**
 * Defensive masking of server text before it reaches the page (review M7d). The worker already
 * masks IBANs in every matching answer; the UI masks again so a regression on the server (or a new
 * field) cannot put a full IBAN in the DOM, a title, an aria label or a URL. Uses core's maskIbans
 * (country-aware, over-masks rather than under-masks).
 *
 * Identifiers are not text for people and must reach the server again byte for byte: a SHA-256 in
 * hex or a base64url cursor can look like an IBAN (two letters, two digits, alphanumerics), and
 * masking it corrupts an approval hash or a "load more" cursor (review P9c). Such fields are kept
 * ONLY when the key is listed below AND the value has the exact identifier shape; anything else in
 * that field (a full IBAN by mistake, say) is masked like any other string.
 */
import { maskIbans } from "@camelthorn/core";

export function maskIbanLike(text: string): string;
export function maskIbanLike(text: string | null | undefined): string | null;
export function maskIbanLike(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  return maskIbans(text);
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Opaque list cursors: base64url (matching, bank) or digits and colons (payments, data quality). */
const CURSOR = /^[A-Za-z0-9_:-]{1,200}$/;

/** Field name -> the only shape that field may keep unmasked. */
export const IDENTIFIER_SHAPES: Readonly<Record<string, RegExp>> = {
  payloadHash: HEX64,
  ibanFingerprint: HEX64,
  protocolVersion: HEX64,
  bankEntryHash: HEX64,
  matchSetHash: HEX64,
  mappingHash: HEX64,
  currentMappingHash: HEX64,
  ibanFingerprintShort: HEX16,
  requestId: UUID,
  providerId: UUID,
  nextCursor: CURSOR,
  cursor: CURSOR,
};

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** True when `value` under `key` is an identifier that must not be masked. */
export function isKeptIdentifier(key: string | null, value: string): boolean {
  if (key === null || !own(IDENTIFIER_SHAPES, key)) return false;
  return (IDENTIFIER_SHAPES[key] as RegExp).test(value);
}

/**
 * Every string inside a JSON answer, IBAN-masked (objects and arrays are copied, numbers, booleans
 * and null are kept), except identifier fields of the exact identifier shape (see above). Applied
 * to every matching, booking, data quality and payments answer at the API boundary.
 */
export function maskDeep<T>(value: T): T {
  return walk(value, null, 0) as T;
}

function walk(v: unknown, key: string | null, depth: number): unknown {
  if (typeof v === "string") return isKeptIdentifier(key, v) ? v : maskIbans(v);
  if (v === null || typeof v !== "object" || depth > 20) return v;
  if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k, depth + 1);
  return out;
}
