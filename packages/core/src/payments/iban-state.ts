/**
 * Supplier IBAN trust (Phase 9, P9a, ADR 0049). An IBAN that came from the first Exact sync is NOT
 * trusted. It counts as verified only after an approver confirmed THAT IBAN (its fingerprint); any
 * change in Exact makes the fingerprint differ, so it is unverified again.
 */
import { hasValidIbanChecksum, isPlausibleIban, normalizeIban } from "../iban";
import { hmacSha256Hex } from "../sha256";

/** Shortest accepted fingerprint key (the Workers secret PAYMENTS_IBAN_KEY, ADR 0049). */
export const IBAN_FINGERPRINT_KEY_MIN = 32;

/** A usable fingerprint key: a string of at least 32 characters with no surrounding blanks. */
export const isIbanFingerprintKey = (k: unknown): k is string =>
  typeof k === "string" && k.length >= IBAN_FINGERPRINT_KEY_MIN && k.trim() === k;

/**
 * Identity of an IBAN for comparison, audit rows, API answers and the approval payload:
 * HMAC-SHA-256 of the normalised IBAN under a per-install key (review P9a). An IBAN has little
 * entropy: an UNKEYED hash next to a masked IBAN (country, check digits, last four) could be
 * brute-forced back to the IBAN in seconds, so the key (a Workers secret, never stored in D1 or
 * logged) is what makes the fingerprint safe to show. Returns null for something that is not even
 * plausible, and for a missing or short key (callers fail closed).
 */
export function ibanFingerprint(iban: string | null | undefined, key: string): string | null {
  if (typeof iban !== "string" || !isIbanFingerprintKey(key)) return null;
  const n = normalizeIban(iban);
  if (!isPlausibleIban(n)) return null;
  return hmacSha256Hex(key, `iban-fp-v2:${n}`);
}

export type IbanState =
  | "missing"
  | "invalid"
  | "unverified"
  | "changed"
  | "verified_new"
  | "verified_by_requester"
  | "verified_established";

/** States in which a payment may go to the IBAN at all. */
export const PAYABLE_IBAN_STATES: readonly IbanState[] = [
  "verified_new",
  "verified_by_requester",
  "verified_established",
];

export interface IbanFacts {
  /** The supplier's IBAN as Exact holds it (full, in memory only). */
  recordIban: string | null | undefined;
  /** The latest verification entry of this supplier, whatever it covers. */
  verification: { fingerprint: string; verifiedBy: string; revoked: boolean } | null;
  /** A payment to this very fingerprint was confirmed `paid` by the bank before. */
  paidBefore: boolean;
  /** The fingerprint key (Workers secret PAYMENTS_IBAN_KEY). Missing or short: state `invalid`. */
  fingerprintKey: string;
}

export interface IbanAssessment {
  state: IbanState;
  /** Null for missing or invalid. */
  fingerprint: string | null;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function assessIban(facts: IbanFacts, requesterEmail: string): IbanAssessment {
  const raw = facts.recordIban;
  if (typeof raw !== "string" || normalizeIban(raw) === "") {
    return { state: "missing", fingerprint: null };
  }
  const n = normalizeIban(raw);
  if (!isPlausibleIban(n) || !hasValidIbanChecksum(n)) {
    return { state: "invalid", fingerprint: null };
  }
  const fingerprint = ibanFingerprint(n, facts.fingerprintKey);
  if (fingerprint === null) return { state: "invalid", fingerprint: null };
  const v = facts.verification;
  if (v === null || v.revoked) return { state: "unverified", fingerprint };
  if (v.fingerprint !== fingerprint) return { state: "changed", fingerprint };
  if (facts.paidBefore) return { state: "verified_established", fingerprint };
  return {
    state: same(v.verifiedBy, requesterEmail) ? "verified_by_requester" : "verified_new",
    fingerprint,
  };
}
