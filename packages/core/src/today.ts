/**
 * Today queue ranking (Phase 8, D8c, ADR 0047). Pure: no I/O.
 *
 * One merged queue of things a person can act on. Order: priority (high first), then the one
 * that has waited longest (`since` ascending, unknown last), then the id as plain text. The order
 * is total and does not depend on the page size, so a cursor is just the last item's key.
 */
import type { DqFixTarget, DqSeverity } from "./dq";
import type { Role } from "./roles";

export const TODAY_KINDS = [
  "approval",
  "match",
  "booking",
  "dq",
  "payment_approval",
  "payment_ready",
] as const;
export type TodayKind = (typeof TODAY_KINDS)[number];

/** Server-side actions. "Later" is not here: it lives in the browser (ADR 0047). */
export type TodayAction = "open" | "snooze" | "resolve";

export interface TodayItemDto {
  kind: TodayKind;
  /**
   * Stable across reloads: `approval:12`, `match:34`, `booking:56`, `booking:stale-78`, `dq:90`,
   * `payment_approval:5`, `payment_approval:batch-2`, `payment_ready:7`, `payment_ready:batch-3`.
   */
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
  /** The kinds whose source was cut at the cap (each named on the page). */
  cappedKinds: TodayKind[];
  /**
   * Kinds that were NOT looked at for this answer (no administration chosen: approvals and
   * bookings). An empty queue never claims these are clear.
   */
  notChecked: TodayKind[];
  /**
   * The last run of the data checks, or null when they never ran. The queue's data issues are only
   * as fresh as this; an empty queue with no (or a failed) run is not "all good".
   */
  dqLastRun: { status: "ok" | "partial" | "error"; finishedAt: string | null } | null;
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
  /** A payment waiting for a second person (approvers only); it expires 24 h after the request. */
  paymentApproval: 85,
  /** Approved but not sent (finance). */
  paymentReady: 70,
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
/**
 * The DQ rule about a ready payment. Its issue is hidden from the queue ONLY for a viewer who sees
 * that same payment as a `payment_ready` item (same payment, same administration); everybody else
 * still gets the issue.
 */
export const TODAY_PAYMENT_READY_RULE = "payments.ready_not_sent";

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
    case "payment_approval":
      // The sheet to approve is in the app (the link); only an approver gets the item at all.
      return hasRole(roles, "approver") ? ["open"] : [];
    case "payment_ready":
      return hasRole(roles, "finance") ? ["open"] : [];
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
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * One spelling per instant (`toISOString`, years 0000..9999) or null. The order compares `since`
 * as text and the cursor carries it, so every source must spell instants the same way: "...33Z"
 * and "...33.000Z" would sort apart, and a year outside 4 digits would make a cursor we issued
 * fail to decode.
 */
export function canonicalSince(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  const iso = new Date(t).toISOString();
  return CANONICAL.test(iso) ? iso : null;
}
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

const ID_RE =
  /^(approval|match|booking|dq|payment_approval|payment_ready):(stale-|batch-)?[1-9]\d{0,12}$/;

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
    if (typeof since !== "string" || (since !== NO_SINCE && canonicalSince(since) !== since)) {
      return null;
    }
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

/**
 * The last item that can be shown in true queue order when some sources were cut at the cap: the
 * earliest (in queue order) of the capped sources' last rows. Every source is read in queue order,
 * so beyond this point a capped source may have rows we did not read that would rank in between.
 * Null when nothing was capped.
 */
export function cappedHorizon<T extends SortKey>(lastOfCapped: readonly T[]): T | null {
  return sortToday(lastOfCapped)[0] ?? null;
}

/**
 * Sorts, applies the cursor and cuts one page; `nextCursor` is set when more remain. With a
 * `horizon` (see cappedHorizon) nothing after it is served: the list is always a true prefix of
 * the full queue, never a capped source's first rows followed by lower-ranked rows of others.
 */
export function pageToday<T extends SortKey>(
  items: readonly T[],
  limit: number,
  cursor: TodayCursor | null,
  horizon: SortKey | null = null,
): { page: T[]; nextCursor: string | null } {
  const all = sortToday(items);
  const sorted = horizon === null ? all : all.filter((i) => compareToday(i, horizon) <= 0);
  const rest = cursor ? afterCursor(sorted, cursor) : sorted;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return {
    page,
    nextCursor: rest.length > limit && last ? encodeTodayCursor(last) : null,
  };
}
