const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim and lowercase. Every email compare and store in the app goes through this. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Deliberately loose shape check (one "@", a dot in the domain, no whitespace). */
export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test(normalizeEmail(raw));
}

/** True when the (normalised) email's domain is exactly `domain` (case-insensitive). */
export function isEmailInDomain(email: string, domain: string): boolean {
  const d = normalizeEmail(domain);
  if (d === "") return false;
  return normalizeEmail(email).endsWith(`@${d}`);
}
