/** IBAN helpers shared by the Exact client, the sync and the audit log. No I/O. */

/**
 * Upper case, no whitespace, no invisible format characters. Unicode compatibility forms are
 * folded first (NFKC), so a full-width "ＮＬ９１" or a non-breaking space becomes plain ASCII;
 * zero-width and other format characters (Unicode category Cf, for example U+200B) are dropped.
 * Real lookalikes from another script (Cyrillic "А" for Latin "A") are NOT folded: the result
 * then fails `isPlausibleIban`. Does not validate.
 */
export function normalizeIban(iban: string): string {
  return iban
    .normalize("NFKC")
    .replace(/[\s\p{Cf}]+/gu, "")
    .toUpperCase();
}

/**
 * Shape check only (2 letters, 2 digits, 1-30 letters or digits, ASCII); the mod-97 checksum is
 * not verified here (see `hasValidIbanChecksum`). Use on a normalised value.
 */
export function isPlausibleIban(normalised: string): boolean {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(normalised);
}

/**
 * ISO 13616 mod-97 check on a normalised, plausible IBAN: move the first four characters to the
 * end, letters become 10..35, the number mod 97 must be 1. Country lengths are not checked.
 * The sync stores IBANs that fail this check (they are still what Exact holds, and a new one still
 * raises the payment-safety flag); paying to one must be refused (Phase 9).
 */
export function hasValidIbanChecksum(normalised: string): boolean {
  if (!isPlausibleIban(normalised)) return false;
  const rearranged = normalised.slice(4) + normalised.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : ch;
    for (const d of digits) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/**
 * The one masking format used everywhere (audit rows, error messages, logs): country and check
 * digits plus the last four characters, for example "NL91ABNA0417164300" -> "NL91****4300".
 * Input of 8 characters or fewer is fully hidden ("****"). Spaces and case are ignored.
 */
export function maskIban(iban: string): string {
  const compact = normalizeIban(iban);
  if (compact.length <= 8) return "****";
  return `${compact.slice(0, 4)}****${compact.slice(-4)}`;
}
