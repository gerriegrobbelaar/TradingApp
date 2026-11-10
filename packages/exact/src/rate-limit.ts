/**
 * Exact's rate-limit headers, parsed in ONE place for the client (429 waits) and the ExactGate
 * (limiter state). What the headers mean for the limiter is the gate's business: it only ever
 * lets them tighten its own limits (apps/worker/src/exact/gate.ts).
 *
 * Tolerances (all unverified against the live service, ADR 0014 item 12 and ADR 0017):
 *  - header names are case-insensitive;
 *  - numbers may carry surrounding whitespace and a decimal part; anything else ("abc", "Infinity",
 *    "0x10", "1e3", an empty string) and anything beyond 2^53 is "absent" (null);
 *  - reset times are epoch MILLISECONDS; a value below 1e11 can only be epoch SECONDS (1e11 ms is
 *    in 1973) and is multiplied by 1,000;
 *  - Retry-After is delta-SECONDS or an HTTP date.
 */
export interface RateLimitWindow {
  limit: number | null;
  remaining: number | null;
  /** Epoch milliseconds when the window resets (see the tolerances above). */
  resetAtMs: number | null;
}

export interface RateLimitInfo {
  daily: RateLimitWindow;
  minutely: RateLimitWindow;
  /** Retry-After in milliseconds (never negative), when present and readable. */
  retryAfterMs: number | null;
}

export function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** Epoch seconds are tolerated: below 1e11 a number cannot be epoch milliseconds. */
export const toEpochMs = (n: number): number => (n < 1e11 ? n * 1000 : n);

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (!NUMBER_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null;
}

function resetMs(v: string | undefined): number | null {
  const n = num(v);
  return n === null ? null : toEpochMs(n);
}

function retryAfterMs(v: string | undefined, nowMs: number): number | null {
  if (v === undefined) return null;
  const secs = num(v);
  if (secs !== null) return secs >= 0 ? Math.round(secs * 1000) : null;
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/**
 * Parse X-RateLimit-Limit/Remaining/Reset (daily), X-RateLimit-Minutely-Limit/Remaining/Reset
 * and Retry-After. Missing or malformed values become null. `nowMs` is only needed to turn an
 * HTTP-date Retry-After into a wait.
 */
export function parseRateLimitHeaders(
  headers: Record<string, string>,
  nowMs: number = Date.now(),
): RateLimitInfo {
  const h = lowerCaseHeaders(headers);
  return {
    daily: {
      limit: num(h["x-ratelimit-limit"]),
      remaining: num(h["x-ratelimit-remaining"]),
      resetAtMs: resetMs(h["x-ratelimit-reset"]),
    },
    minutely: {
      limit: num(h["x-ratelimit-minutely-limit"]),
      remaining: num(h["x-ratelimit-minutely-remaining"]),
      resetAtMs: resetMs(h["x-ratelimit-minutely-reset"]),
    },
    retryAfterMs: retryAfterMs(h["retry-after"], nowMs),
  };
}

/**
 * How long to wait after a 429: Retry-After, else the daily reset when the daily budget is gone,
 * else the minute window's reset, else 60 s. Never negative; callers clamp to what they accept.
 * `dailyExhausted` lets the gate pass what its own state knows (the daily count may have come
 * from an earlier response); by default it is read from this response.
 */
export function retryAfterFromHeaders(
  headers: Record<string, string>,
  nowMs: number,
  opts: { dailyExhausted?: boolean } = {},
): number {
  const info = parseRateLimitHeaders(headers, nowMs);
  if (info.retryAfterMs !== null) return info.retryAfterMs;
  const untilReset = (w: RateLimitWindow): number | null =>
    w.resetAtMs === null ? null : Math.max(0, w.resetAtMs - nowMs);
  const dailyExhausted =
    opts.dailyExhausted ?? (info.daily.remaining !== null && info.daily.remaining <= 0);
  if (dailyExhausted) {
    const d = untilReset(info.daily);
    if (d !== null) return d;
  }
  const m = untilReset(info.minutely);
  if (m !== null) return m;
  return 60_000;
}
