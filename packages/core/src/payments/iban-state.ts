/**
 * Supplier IBAN trust (Phase 9, P9a, ADR 0049). An IBAN that came from the first Exact sync is NOT
 * trusted. It counts as verified only after an approver confirmed THAT IBAN (its fingerprint); any
 * change in Exact makes the fingerprint differ, so it is unverified again.
 */
import { hasValidIbanChecksum, isPlausibleIban, normalizeIban } from "../iban";
import { sha256Hex } from "../sha256";

/**
 * Identity of an IBAN for comparison and for the approval payload: domain-separated SHA-256 of the
 * normalised IBAN. NOT a secret (an IBAN has little entropy; the full IBAN is in the database
 * anyway). It exists so logs, audit rows and API answers can say "this IBAN" without showing it.
 * Returns null for something that is not even plausible.
 */
export function ibanFingerprint(iban: string | null | undefined): string | null {
  if (typeof iban !== "string") return null;
  const n = normalizeIban(iban);
  if (!isPlausibleIban(n)) return null;
  return sha256Hex(`iban-fp-v1:${n}`);
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
  /** A payment to this very fingerprint was sent (submitted or later) before. */
  paidBefore: boolean;
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
  const fingerprint = sha256Hex(`iban-fp-v1:${n}`);
  const v = facts.verification;
  if (v === null || v.revoked) return { state: "unverified", fingerprint };
  if (v.fingerprint !== fingerprint) return { state: "changed", fingerprint };
  if (facts.paidBefore) return { state: "verified_established", fingerprint };
  return {
    state: same(v.verifiedBy, requesterEmail) ? "verified_by_requester" : "verified_new",
    fingerprint,
  };
}
