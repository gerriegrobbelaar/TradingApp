export const SESSION_COOKIE = "__Host-session";
export const FLOW_COOKIE = "__Host-oauth";
/** Round-trip cookie of the admin's Exact connect flow (separate from the Google sign-in one). */
export const EXACT_FLOW_COOKIE = "__Host-exact-oauth";
/** Round-trip cookie of the admin's Revolut connect flow. */
export const REVOLUT_FLOW_COOKIE = "__Host-revolut-oauth";

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name !== "" && !out.has(name)) out.set(name, part.slice(i + 1).trim());
  }
  return out;
}

/** `__Host-` cookies must be Secure, Path=/ and have no Domain attribute. */
export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name: string): string {
  return setCookie(name, "", 0);
}
