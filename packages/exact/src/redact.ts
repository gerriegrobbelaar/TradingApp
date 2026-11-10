/** Redaction for anything that can end up in an error message or log line. */
import { maskIban } from "@camelthorn/core";

export { maskIban };

const IBAN_RE = /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){10,30}\b/g;

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
