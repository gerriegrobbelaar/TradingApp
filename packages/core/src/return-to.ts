/**
 * Core has no DOM or Workers lib, but URL exists in every runtime we ship to (browser, Workers,
 * Node). Declared locally, minimal, so this file does not depend on a lib setting.
 */
interface MinimalUrl {
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly searchParams: { has(name: string): boolean; delete(name: string): void };
}
declare const URL: new (input: string, base: string) => MinimalUrl;

/** Placeholder origin used when the caller has none (browser code); never leaves this function. */
const FALLBACK_ORIGIN = "https://app.invalid";
const MAX_LENGTH = 2048;

/**
 * Only same-origin relative paths; anything else becomes "/". The value is resolved against the
 * app origin and must stay on it, so "//host", "/\\host", "https://host", "/\thost" and their
 * percent-decoded forms are all refused. The result is the URL's own (percent-encoded)
 * path + query + fragment, safe to put in a Location header.
 *
 * The one-shot `auth` query flag (set by the denied-sign-in redirect) is dropped so a notice
 * is never replayed after sign-in. The query is only re-serialised when that flag was present.
 */
export function safeReturnTo(raw: string | null | undefined, appOrigin?: string): string {
  const origin = appOrigin ?? FALLBACK_ORIGIN;
  if (!raw || raw.length > MAX_LENGTH) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  let u: MinimalUrl;
  try {
    u = new URL(raw, origin);
  } catch {
    return "/";
  }
  if (u.origin !== origin) return "/";
  if (u.searchParams.has("auth")) u.searchParams.delete("auth");
  const out = `${u.pathname}${u.search}${u.hash}`;
  return out.startsWith("/") && !out.startsWith("//") ? out : "/";
}
