/**
 * Today queue ranking (Phase 8, D8c, ADR 0047). Pure: no I/O.
 *
 * One merged queue of things a person can act on. Order: priority (high first), then the one
 * that has waited longest (`since` ascending, unknown last), then the id as plain text. The order
 * is total and does not depend on the page size, so a cursor is just the last item's key.
 */
import type { DqFixTarget, DqSeverity } from "./dq";
import type { Role } from "./roles";

export const TODAY_KINDS = ["approval", "match", "booking", "dq"] as const;
export type TodayKind = (typeof TODAY_KINDS)[number];

/** Server-side actions. "Later" is not here: it lives in the browser (ADR 0047). */
export type TodayAction = "open" | "snooze" | "resolve";

export interface TodayItemDto {
  kind: TodayKind;
  /** Stable across reloads: `approval:12`, `match:34`, `booking:56`, `booking:stale-78`, `dq:90`. */
  id: string;
  /** Leads with the number (days waiting, score, age). */
  title: string;
  subtitle: string;
  severity: DqSeverity;
  /** 0..100, higher first. */
  priority: number;
  /** When the thing started waiting (ISO instant), or null. */
  since: string | null;
  ageDays: number | null;
  amountMinor: number | null;
  currency: string | null;
  /** Where "Fix" leads: a key, mapped to a path by DQ_FIX_PATHS. */
  fix: DqFixTarget;
  fixPath: string;
  /** What this caller may do. Empty: nothing, the person has to ask someone else. */
  actions: TodayAction[];
  /** The data quality issue behind the item (snooze and resolve act on it), else null. */
  issueId: number | null;
}

export interface TodayResponse {
  items: TodayItemDto[];
  nextCursor: string | null;
  /** Items per kind that match right now (exact, not capped). */
  counts: Record<TodayKind, number>;
  total: number;
  /** A source had more rows than one answer reads; the rest show after these are handled. */
  capped: boolean;
  /** False until approval status mapping was verified (ADR 0025): pending approvals may be off. */
  approvalMappingVerified: boolean;
  generatedAt: string;
}

export const TODAY_PRIORITY = {
  bookingOutcomeUnknown: 100,
  dqCritical: 90,
  bookingManualRequired: 80,
  staleSettlements: 75,
  dqWarning: 60,
  approvalLate: 55,
  matchSuggested: 45,
  approvalWaiting: 40,
} as const;

/** Approvals waiting longer than this many days rank higher (same limit as the Approvals screen). */
export const TODAY_APPROVAL_LATE_DAYS = 3;

/** Data quality rules the queue shows through a better source (no duplicate items). */
export const TODAY_DQ_SKIPPED_RULES: readonly string[] = [
  "bank.booking_outcome_unknown",
  "bank.booking_manual_required",
  "payables.approvals_overdue",
];
export const TODAY_STALE_SETTLEMENT_RULE = "bank.stale_settlements";

export function approvalPriority(ageDays: number | null): number {
  return ageDays !== null && ageDays > TODAY_APPROVAL_LATE_DAYS
    ? TODAY_PRIORITY.approvalLate
    : TODAY_PRIORITY.approvalWaiting;
}

export function severityOfPriority(priority: number): DqSeverity {
  return priority >= TODAY_PRIORITY.dqCritical
    ? "critical"
    : priority >= TODAY_PRIORITY.dqWarning
      ? "warning"
      : "info";
}

const hasRole = (roles: readonly Role[], ...any: Role[]): boolean =>
  roles.some((r) => any.includes(r));

/** What the caller may do with an item (the server enforces its own role rules again). */
export function todayActions(
  kind: TodayKind,
  roles: readonly Role[],
  hasIssue: boolean,
): TodayAction[] {
  switch (kind) {
    case "approval":
    case "match":
      return ["open"];
    case "booking":
      // Needs an admin; the others only see that something is waiting.
      if (!hasRole(roles, "admin")) return [];
      return hasIssue ? ["open", "snooze", "resolve"] : ["open"];
    case "dq":
      return hasRole(roles, "finance", "admin") ? ["open", "snooze", "resolve"] : ["open"];
  }
}

/** Whole days between two instants, never negative; null when either cannot be read. */
export function ageDaysBetween(sinceIso: string | null, nowMs: number): number | null {
  if (sinceIso === null) return null;
  const t = Date.parse(sinceIso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

const NO_SINCE = "9999-12-31T23:59:59.999Z";
const sinceKey = (i: Pick<TodayItemDto, "since">): string => i.since ?? NO_SINCE;

type SortKey = Pick<TodayItemDto, "priority" | "since" | "id">;

/** Negative: a before b. Total order. */
export function compareToday(a: SortKey, b: SortKey): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const sa = sinceKey(a);
  const sb = sinceKey(b);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortToday<T extends SortKey>(items: readonly T[]): T[] {
  return [...items].sort(compareToday);
}

// ---- cursor ----------------------------------------------------------------------------------------

export interface TodayCursor {
  priority: number;
  since: string;
  id: string;
}

const b64 = (s: string): string =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string): string => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

export function encodeTodayCursor(item: SortKey): string {
  return b64(JSON.stringify([item.priority, sinceKey(item), item.id]));
}

const ID_RE = /^(approval|match|booking|dq):(stale-)?[1-9]\d{0,12}$/;

/** Null for anything we did not issue (strict shape). */
export function decodeTodayCursor(raw: string): TodayCursor | null {
  try {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return null;
    const v: unknown = JSON.parse(unb64(raw));
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [priority, since, id] = v as unknown[];
    if (
      typeof priority !== "number" ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 100
    ) {
      return null;
    }
    if (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(since)) return null;
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    return { priority, since, id };
  } catch {
    return null;
  }
}

/** Items strictly after the cursor in queue order. */
export function afterCursor<T extends SortKey>(items: readonly T[], c: TodayCursor): T[] {
  const key: SortKey = {
    priority: c.priority,
    since: c.since === NO_SINCE ? null : c.since,
    id: c.id,
  };
  return items.filter((i) => compareToday(i, key) > 0);
}

/** Sorts, applies the cursor and cuts one page; `nextCursor` is set when more remain. */
export function pageToday<T extends SortKey>(
  items: readonly T[],
  limit: number,
  cursor: TodayCursor | null,
): { page: T[]; nextCursor: string | null } {
  const sorted = sortToday(items);
  const rest = cursor ? afterCursor(sorted, cursor) : sorted;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return {
    page,
    nextCursor: rest.length > limit && last ? encodeTodayCursor(last) : null,
  };
}
