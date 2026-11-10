/** IBAN helpers shared by the Exact client, the sync and the audit log. No I/O. */

/** Upper case, no whitespace. Does not validate. */
export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

/**
 * Shape check only (2 letters, 2 digits, 1-30 letters or digits); the mod-97 checksum is not
 * verified here. Use on a normalised value.
 */
export function isPlausibleIban(normalised: string): boolean {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(normalised);
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
