/**
 * "Later" for the Today queue (Phase 8, D8c, ADR 0047): hide an item until a time, in THIS browser
 * only. There is no server table for it (no migration in this task), so it is not shared between
 * devices or people, and it is lost if the browser clears its storage. Every access is wrapped in
 * try/catch: a blocked or full localStorage means "later" does not stick, never an error.
 *
 * An entry remembers the item's priority when it was postponed. A postponed item comes back:
 *  - when the time is up (24 hours), and
 *  - at once when its priority goes UP (it got worse: a warning became critical, an approval
 *    became late). Postponing a warning never hides the critical it turns into.
 * Whatever is stored, nothing is hidden for longer than 24 hours from now: a corrupted or
 * hand-edited entry far in the future is ignored.
 */

const KEY_PREFIX = "camelthorn.today.later.v2:";
/** Entries kept at most; the soonest to expire go first. */
const MAX_ENTRIES = 300;
export const LATER_HOURS = 24;
const LATER_MS = LATER_HOURS * 3_600_000;
/** Clock differences between tabs: an entry may be this much past the 24 hours. */
const SLACK_MS = 60_000;
/** The shape of a Today item id (core today.ts); anything else in storage is dropped. */
const ID_RE = /^(approval|match|booking|dq):(stale-)?[1-9]\d{0,12}$/;

export interface LaterEntry {
  /** Epoch ms when the item comes back. */
  until: number;
  /** The item's priority when it was postponed. */
  priority: number;
}
export type LaterMap = Record<string, LaterEntry>;

const keyFor = (email: string): string => `${KEY_PREFIX}${email.toLowerCase()}`;

/** Postponed items still in the future. Anything unreadable is treated as empty. */
export function readLater(email: string, nowMs: number = Date.now()): LaterMap {
  try {
    const raw = localStorage.getItem(keyFor(email));
    if (raw === null) return {};
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: LaterMap = {};
    for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
      if (!ID_RE.test(id) || e === null || typeof e !== "object" || Array.isArray(e)) continue;
      const { u, p } = e as { u?: unknown; p?: unknown };
      if (typeof u !== "number" || !Number.isFinite(u)) continue;
      if (u <= nowMs || u > nowMs + LATER_MS + SLACK_MS) continue;
      if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 100) continue;
      out[id] = { until: u, priority: p };
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
      .sort((a, b) => b[1].until - a[1].until)
      .slice(0, MAX_ENTRIES)
      .map(([id, e]) => [id, { u: e.until, p: e.priority }] as const);
    localStorage.setItem(keyFor(email), JSON.stringify(Object.fromEntries(entries)));
    return true;
  } catch {
    return false;
  }
}

export const laterUntil = (nowMs: number = Date.now()): number => nowMs + LATER_MS;

/** True while the item stays hidden: postponed, time not up, and not worse than when postponed. */
export function isPostponed(
  map: LaterMap,
  item: { id: string; priority: number },
  nowMs: number = Date.now(),
): boolean {
  const e = Object.hasOwn(map, item.id) ? map[item.id] : undefined;
  return e !== undefined && e.until > nowMs && item.priority <= e.priority;
}
