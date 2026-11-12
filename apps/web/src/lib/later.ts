/**
 * "Later" for the Today queue (Phase 8, D8c, ADR 0047): hide an item until a time, in THIS browser
 * only. There is no server table for it (no migration in this task), so it is not shared between
 * devices or people, and it is lost if the browser clears its storage. Every access is wrapped in
 * try/catch: a blocked or full localStorage means "later" does not stick, never an error.
 */

const KEY_PREFIX = "camelthorn.today.later.v1:";
/** Entries kept at most; the soonest to expire go first. */
const MAX_ENTRIES = 300;
export const LATER_HOURS = 24;

export type LaterMap = Record<string, number>;

const keyFor = (email: string): string => `${KEY_PREFIX}${email.toLowerCase()}`;

/** Postponed items still in the future. Anything unreadable is treated as empty. */
export function readLater(email: string, nowMs: number = Date.now()): LaterMap {
  try {
    const raw = localStorage.getItem(keyFor(email));
    if (raw === null) return {};
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: LaterMap = {};
    for (const [id, until] of Object.entries(v as Record<string, unknown>)) {
      if (typeof until === "number" && Number.isFinite(until) && until > nowMs) out[id] = until;
    }
    return out;
  } catch {
    return {};
  }
}

/** Returns false when the browser would not store it (the item then stays in the queue). */
export function writeLater(email: string, map: LaterMap): boolean {
  try {
    const entries = Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENTRIES);
    localStorage.setItem(keyFor(email), JSON.stringify(Object.fromEntries(entries)));
    return true;
  } catch {
    return false;
  }
}

export const laterUntil = (nowMs: number = Date.now()): number => nowMs + LATER_HOURS * 3_600_000;
