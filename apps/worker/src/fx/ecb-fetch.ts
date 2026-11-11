/**
 * The one outbound request of the ECB import (ADR 0036). The URL is built ONLY by core
 * `ecbRequestUrl` and checked again here against an allow-list (host, https, path prefix, port);
 * no cookies or credentials are sent; redirects are refused; the wait is bounded (15 s) and so is
 * the body (5 MB, counted while streaming). Nothing of the body is ever logged or returned in an
 * error: callers get a code.
 */
export const ECB_HOST = "data-api.ecb.europa.eu";
export const ECB_PATH_PREFIX = "/service/data/EXR/";
export const ECB_TIMEOUT_MS = 15_000;
export const ECB_MAX_BYTES = 5 * 1024 * 1024;
/** The only query keys core `ecbRequestUrl` writes; anything else is refused. */
const ALLOWED_QUERY = new Set(["format", "startPeriod", "endPeriod", "lastNObservations"]);
/** Longest Retry-After we accept from a 429 (the import cannot wait longer within its window). */
export const ECB_MAX_RETRY_AFTER_SECONDS = 3600;

export type EcbFetchResult =
  /** `empty`: the portal has no observations for the window (404 / 204). */
  | { kind: "ok"; text: string; empty: false }
  | { kind: "ok"; text: ""; empty: true }
  /** Network error, timeout, 429, 5xx: try again later (`retryAfterSeconds` from a 429/503). */
  | { kind: "transient"; code: string; status?: number; retryAfterSeconds?: number }
  /** Redirect, wrong content type, too large, other 4xx: retrying will not help. */
  | { kind: "permanent"; code: string; status?: number };

export function isAllowedEcbUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.hostname === ECB_HOST &&
    u.port === "" &&
    u.username === "" &&
    u.password === "" &&
    u.pathname.startsWith(ECB_PATH_PREFIX) &&
    u.hash === "" &&
    !raw.includes("#") &&
    queryAllowed(u.searchParams)
  );
}

/** Only the keys core writes, each at most once, and `format=csvdata` exactly once. */
function queryAllowed(q: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const [k, v] of q) {
    if (!ALLOWED_QUERY.has(k) || seen.has(k)) return false;
    seen.add(k);
    if (k === "format" && v !== "csvdata") return false;
  }
  return seen.has("format");
}

/**
 * Retry-After as whole seconds (delta-seconds or an HTTP date), bounded to 0..1 hour; undefined
 * when absent or unreadable.
 */
export function parseRetryAfter(raw: string | null, nowMs: number): number | undefined {
  if (raw === null) return undefined;
  const t = raw.trim();
  let s: number;
  if (/^\d{1,7}$/.test(t)) s = Number(t);
  else {
    const at = Date.parse(t);
    if (Number.isNaN(at)) return undefined;
    s = Math.ceil((at - nowMs) / 1000);
  }
  return Math.min(Math.max(s, 0), ECB_MAX_RETRY_AFTER_SECONDS);
}

/** CSV as the portal sends it for `format=csvdata`, or the SDMX-CSV media type. */
const CSV_TYPE_RE = /^(?:text\/csv|application\/vnd\.sdmx\.data\+csv)\s*(?:;|$)/;

/**
 * Reads at most `max` bytes (counted on the decoded bytes as they stream: the runtime undoes any
 * gzip before we see them); null when the body is larger. Every read races `signal`, so the 15 s
 * timeout also bounds a body that trickles in after the headers.
 */
async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (res.headers.get("content-length") !== null && Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

/**
 * `outer` is the run's own signal (deadline, lost lease): when it aborts, this throws the abort
 * so the runner records the timeout; only OUR 15 s timer is classified as transient.
 */
export async function fetchEcb(
  url: string,
  outer?: AbortSignal,
  now: () => number = Date.now,
): Promise<EcbFetchResult> {
  if (!isAllowedEcbUrl(url)) return { kind: "permanent", code: "url_not_allowed" };
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, ECB_TIMEOUT_MS);
  const forward = () => ac.abort();
  outer?.addEventListener("abort", forward);
  try {
    if (outer?.aborted) ac.abort();
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "text/csv" },
      redirect: "manual",
      signal: ac.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "permanent", code: "redirect_refused", status: res.status };
    }
    if (res.status === 204 || res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "ok", text: "", empty: true };
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      const after = parseRetryAfter(res.headers.get("retry-after"), now());
      return {
        kind: "transient",
        code: res.status === 429 ? "ecb_rate_limited" : "ecb_unavailable",
        status: res.status,
        ...(after === undefined ? {} : { retryAfterSeconds: after }),
      };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "permanent", code: "bad_status", status: res.status };
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!CSV_TYPE_RE.test(type)) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "permanent", code: "bad_content_type", status: res.status };
    }
    const text = await readCapped(res, ECB_MAX_BYTES, ac.signal);
    if (text === null) return { kind: "permanent", code: "response_too_large" };
    return { kind: "ok", text, empty: false };
  } catch (e) {
    if (outer?.aborted) throw e;
    // A network failure or our own timeout. The error text is not kept (it may carry a URL).
    return { kind: "transient", code: timedOut ? "ecb_timeout" : "ecb_network" };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forward);
  }
}
