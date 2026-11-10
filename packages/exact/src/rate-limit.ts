export interface RateLimitWindow {
  limit: number | null;
  remaining: number | null;
  /** Epoch milliseconds when the window resets (Exact sends epoch ms; verify, see ADR 0014). */
  resetAtMs: number | null;
}

export interface RateLimitInfo {
  daily: RateLimitWindow;
  minutely: RateLimitWindow;
  /** Retry-After header in milliseconds, when present (seconds on the wire). */
  retryAfterMs: number | null;
}

export function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function int(v: string | undefined): number | null {
  if (v === undefined || !/^\s*\d+\s*$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse Exact's rate-limit headers (case-insensitive): X-RateLimit-Limit/Remaining/Reset (daily)
 * and X-RateLimit-Minutely-Limit/Remaining/Reset. Missing or malformed values become null.
 */
export function parseRateLimitHeaders(headers: Record<string, string>): RateLimitInfo {
  const h = lowerCaseHeaders(headers);
  const retrySeconds = int(h["retry-after"]);
  return {
    daily: {
      limit: int(h["x-ratelimit-limit"]),
      remaining: int(h["x-ratelimit-remaining"]),
      resetAtMs: int(h["x-ratelimit-reset"]),
    },
    minutely: {
      limit: int(h["x-ratelimit-minutely-limit"]),
      remaining: int(h["x-ratelimit-minutely-remaining"]),
      resetAtMs: int(h["x-ratelimit-minutely-reset"]),
    },
    retryAfterMs: retrySeconds === null ? null : retrySeconds * 1000,
  };
}

/** How long to wait after a 429: Retry-After, else the exhausted window's reset, else 60 s. */
export function retryAfterFromHeaders(headers: Record<string, string>, nowMs: number): number {
  const info = parseRateLimitHeaders(headers);
  if (info.retryAfterMs !== null) return info.retryAfterMs;
  const untilReset = (w: RateLimitWindow): number | null =>
    w.resetAtMs === null ? null : Math.max(0, w.resetAtMs - nowMs);
  if (info.daily.remaining === 0) {
    const d = untilReset(info.daily);
    if (d !== null) return d;
  }
  const m = untilReset(info.minutely);
  if (m !== null) return m;
  return 60_000;
}
