/** Redaction for anything that can end up in an error message or log line. */
import { maskIban } from "@camelthorn/core";

export { maskIban };

// Country + check digits, then groups of four (spaces optional), then up to 3 trailing characters.
const IBAN_RE = /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,3})?\b/g;

/**
 * Mask IBAN-looking strings, bearer tokens, JWTs, PEM blocks and secret-ish key/value pairs
 * (access/refresh tokens, client assertions, webhook signing secrets).
 */
export function sanitizeForMessage(text: string, maxLength = 300): string {
  const cleaned = text
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, "[redacted key]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, "[redacted]")
    .replace(
      /("?(?:access_token|refresh_token|client_secret|client_assertion|signing_secret|id_token|code)"?\s*[:=]\s*)"?[^"&\s,}]+"?/gi,
      "$1[redacted]",
    )
    .replace(/\bv1=[0-9a-f]{16,}/gi, "v1=[redacted]")
    .replace(IBAN_RE, (m) => maskIban(m));
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}
