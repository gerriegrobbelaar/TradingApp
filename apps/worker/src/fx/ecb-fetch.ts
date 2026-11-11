/**
 * The one outbound request of the ECB import (ADR 0035). The URL is built ONLY by core
 * `ecbRequestUrl` and checked again here against an allow-list (host, https, path prefix, port);
 * no cookies or credentials are sent; redirects are refused; the wait is bounded (15 s) and so is
 * the body (5 MB, counted while streaming). Nothing of the body is ever logged or returned in an
 * error: callers get a code.
 */
export const ECB_HOST = "data-api.ecb.europa.eu";
export const ECB_PATH_PREFIX = "/service/data/EXR/";
export const ECB_TIMEOUT_MS = 15_000;
export const ECB_MAX_BYTES = 5 * 1024 * 1024;

export type EcbFetchResult =
  /** `empty`: the portal has no observations for the window (404 / 204). */
  | { kind: "ok"; text: string; empty: false }
  | { kind: "ok"; text: ""; empty: true }
  /** Network error, timeout, 429, 5xx: try again later. */
  | { kind: "transient"; code: string; status?: number }
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
    u.hash === ""
  );
}

/** Reads at most `max` bytes; null when the body is larger. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
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
export async function fetchEcb(url: string, outer?: AbortSignal): Promise<EcbFetchResult> {
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
      return { kind: "transient", code: "ecb_unavailable", status: res.status };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "permanent", code: "bad_status", status: res.status };
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!/^text\/csv(?:\s*;|$)/.test(type)) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "permanent", code: "bad_content_type", status: res.status };
    }
    const text = await readCapped(res, ECB_MAX_BYTES);
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
