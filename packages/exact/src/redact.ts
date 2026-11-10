/** Redaction for anything that can end up in an error message or log line. */

const IBAN_RE = /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){10,30}\b/g;

/** "NL91ABNA0417164300" -> "NL91************00" (country+check digits and last 2 kept). */
export function maskIban(iban: string): string {
  const compact = iban.replace(/\s+/g, "");
  if (compact.length <= 6) return "*".repeat(compact.length);
  return compact.slice(0, 4) + "*".repeat(compact.length - 6) + compact.slice(-2);
}

/** Mask IBAN-looking strings, bearer tokens and token-ish key/value pairs. */
export function sanitizeForMessage(text: string, maxLength = 300): string {
  const cleaned = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    // Bare JWTs (header.payload[.signature]) wherever they appear.
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, "[redacted]")
    .replace(
      /("?(?:access_token|refresh_token|client_secret|id_token)"?\s*[:=]\s*)"?[^"&\s,}]+"?/gi,
      "$1[redacted]",
    )
    .replace(IBAN_RE, (m) => maskIban(m));
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}
