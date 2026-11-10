const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Trim and lowercase. Every email compare and store in the app goes through this. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Deliberately loose shape check (exactly one "@", a dot in the domain, no whitespace or
 * control characters).
 */
export function isValidEmail(raw: string): boolean {
  const email = normalizeEmail(raw);
  return EMAIL_RE.test(email) && !CONTROL_RE.test(email);
}

/**
 * True when the email has exactly one "@", a non-empty local part, and its domain equals
 * `domain` exactly (after normalising both). Subdomains, look-alike suffixes such as
 * `x@domain.evil.test` and `x@evil@domain` are refused.
 */
export function isEmailInDomain(email: string, domain: string): boolean {
  const d = normalizeEmail(domain);
  if (d === "") return false;
  const e = normalizeEmail(email);
  const at = e.indexOf("@");
  if (at <= 0 || at !== e.lastIndexOf("@")) return false;
  return e.slice(at + 1) === d;
}
