/**
 * Today queue (Phase 8, D8c, ADR 0047). Read-only.
 *
 *  GET /api/today?division=&limit=&cursor=     any role
 *
 * One merged, ranked list of things a person can act on, built from data we already have:
 *  - pending approvals (purchase_entries.status = pending_approval) of the chosen administration;
 *  - bank lines with a suggested match (the matching review queue);
 *  - bookings that need a person (outbox manual_required, outcome_unknown) and stale settlements;
 *  - open data quality issues, critical and warning, not snoozed.
 *
 * Cost: four index-backed queries, each reads at most CAP + 1 rows, plus four counts. The merge,
 * order (core `pageToday`) and cursor are computed in memory over at most 5 x (CAP + 1) rows, so a
 * page costs the same however deep the cursor is. `capped` says a source had more rows than CAP;
 * handling the first ones reveals the rest. No full IBAN, no email, no free bank text leaves here:
 * only names that Approvals and Bank already show, amounts and codes. Nothing here writes.
 */
import {
  DQ_FIX_PATHS,
  maskIbans,
  TODAY_DQ_SKIPPED_RULES,
  TODAY_KINDS,
  TODAY_PRIORITY,
  TODAY_STALE_SETTLEMENT_RULE,
  ageDaysBetween,
  approvalAgeDays,
  approvalPriority,
  decodeTodayCursor,
  pageToday,
  severityOfPriority,
  todayActions,
  type DqFixTarget,
  type DqSeverity,
  type Role,
  type TodayItemDto,
  type TodayKind,
  type TodayResponse,
} from "@camelthorn/core";
import { json, type Ctx, type Router } from "../router";
import { readMappingCheck } from "../read/approvals-routes";
import {
  ANY_ROLE,
  BadRequest,
  guarded,
  positiveIntParam,
  resolveDivision,
  today,
} from "../read/routes";

/** Rows read per source for one answer. */
export const TODAY_SOURCE_CAP = 100;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const TEXT_MAX = 120;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const clean = (s: string | null | undefined, max = TEXT_MAX): string =>
  Array.from(
    maskIbans(String(s ?? ""))
      .replace(CONTROL, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, max)
    .join("");

const dayStart = (d: string | null): string | null =>
  d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : null;

interface Ref {
  divisionId: number | null;
  roles: readonly Role[];
  nowMs: number;
  todayDate: string;
}

// ---- sources ----------------------------------------------------------------------------------------

interface ApprovalRow {
  id: number;
  entry_number: string | null;
  relation_name: string | null;
  relation_row_name: string | null;
  currency: string;
  amount_minor: number;
  entry_date: string | null;
  submitted_at: string | null;
}

/** Same ordering expression as the Approvals list, so the index is used (idx_purchase_entries_list). */
export const APPROVALS_SQL = `SELECT pe.id, pe.entry_number, pe.relation_name, r.name AS relation_row_name,
    pe.currency, pe.amount_minor, pe.entry_date, pe.submitted_at
  FROM purchase_entries pe
  LEFT JOIN relations r ON r.division_id = pe.division_id AND r.exact_id = pe.relation_id
  WHERE pe.division_id = ?1 AND pe.status = 'pending_approval'
  ORDER BY COALESCE(pe.entry_date, '0000-01-01') ASC, pe.id ASC LIMIT ${TODAY_SOURCE_CAP + 1}`;
export const APPROVALS_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM purchase_entries WHERE division_id = ?1 AND status = 'pending_approval'";

function approvalItem(r: ApprovalRow, ref: Ref): TodayItemDto {
  const age = approvalAgeDays(
    { status: "pending_approval", submittedAt: r.submitted_at, entryDate: r.entry_date },
    ref.todayDate,
  );
  const priority = approvalPriority(age);
  const supplier = clean(r.relation_name ?? r.relation_row_name) || "Unknown supplier";
  const entry = r.entry_number ? `Entry ${clean(r.entry_number, 40)}` : "Bill";
  return {
    kind: "approval",
    id: `approval:${r.id}`,
    title:
      age === null
        ? "Waiting for approval"
        : `${age} ${age === 1 ? "day" : "days"} waiting for approval`,
    subtitle: `${entry} · ${supplier}`,
    severity: severityOfPriority(priority),
    priority,
    since: r.submitted_at ?? dayStart(r.entry_date),
    ageDays: age,
    amountMinor: r.amount_minor,
    currency: r.currency,
    fix: "approvals",
    fixPath: DQ_FIX_PATHS.approvals,
    actions: todayActions("approval", ref.roles, false),
    issueId: null,
  };
}

interface MatchRow {
  id: number;
  amount_minor: number;
  currency: string;
  counterparty_name: string | null;
  account_name: string | null;
  created_at: string;
  score: number | null;
}

/** Rows in id order: idx_bank_tx_match (match_status) gives them without a sort. */
export const MATCHES_SQL = `SELECT t.id, t.amount_minor, t.currency, t.counterparty_name, a.name AS account_name,
    t.created_at,
    (SELECT s.score FROM match_suggestions s WHERE s.bank_transaction_id = t.id AND s.rank = 1) AS score
  FROM bank_transactions t LEFT JOIN bank_accounts a ON a.id = t.bank_account_id
  WHERE t.match_status = 'suggested' AND t.is_final = 1 AND t.state = 'completed'
  ORDER BY t.id ASC LIMIT ${TODAY_SOURCE_CAP + 1}`;
export const MATCHES_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM bank_transactions WHERE match_status = 'suggested' AND is_final = 1 AND state = 'completed'";

const MATCH_PATH = `${DQ_FIX_PATHS.matching}?tab=review&queue=suggested`;

function matchItem(r: MatchRow, ref: Ref): TodayItemDto {
  const who = clean(r.counterparty_name) || "Unknown counterparty";
  const account = clean(r.account_name, 60);
  return {
    kind: "match",
    id: `match:${r.id}`,
    title: r.score === null ? "Match suggested" : `${r.score}% match suggested`,
    subtitle: account ? `${who} · ${account}` : who,
    severity: severityOfPriority(TODAY_PRIORITY.matchSuggested),
    priority: TODAY_PRIORITY.matchSuggested,
    since: r.created_at,
    ageDays: ageDaysBetween(r.created_at, ref.nowMs),
    amountMinor: r.amount_minor,
    currency: r.currency,
    fix: "matching",
    fixPath: MATCH_PATH,
    actions: todayActions("match", ref.roles, false),
    issueId: null,
  };
}

interface BookingRow {
  id: number;
  status: "manual_required" | "outcome_unknown";
  kind: "bank_entry" | "matchset";
  updated_at: string;
  attempts: number;
  amount_minor: number | null;
  currency: string | null;
}

export const BOOKING_SQL = `SELECT o.id, o.status, o.kind, o.updated_at, o.attempts, t.amount_minor, t.currency
  FROM exact_write_outbox o
  JOIN matches m ON m.id = o.match_id
  LEFT JOIN bank_transactions t ON t.id = m.bank_transaction_id
  WHERE o.status IN ('outcome_unknown', 'manual_required') AND o.division_id = ?1 AND m.undone_at IS NULL
  ORDER BY o.id ASC LIMIT ${TODAY_SOURCE_CAP + 1}`;
export const BOOKING_COUNT_SQL = `SELECT COUNT(*) AS n FROM exact_write_outbox o JOIN matches m ON m.id = o.match_id
  WHERE o.status IN ('outcome_unknown', 'manual_required') AND o.division_id = ?1 AND m.undone_at IS NULL`;

function bookingItem(r: BookingRow, ref: Ref): TodayItemDto {
  const unknown = r.status === "outcome_unknown";
  const priority = unknown
    ? TODAY_PRIORITY.bookingOutcomeUnknown
    : TODAY_PRIORITY.bookingManualRequired;
  const age = ageDaysBetween(r.updated_at, ref.nowMs);
  const what = r.kind === "matchset" ? "match in Exact" : "bank entry in Exact";
  return {
    kind: "booking",
    id: `booking:${r.id}`,
    title: `${age ?? 0} ${age === 1 ? "day" : "days"}: ${
      unknown ? "booking outcome unknown" : "booking needs a person"
    }`,
    subtitle: `${what[0]?.toUpperCase() ?? ""}${what.slice(1)} · ${r.attempts} ${
      r.attempts === 1 ? "attempt" : "attempts"
    }`,
    severity: severityOfPriority(priority),
    priority,
    since: r.updated_at,
    ageDays: age,
    amountMinor: r.amount_minor,
    currency: r.currency,
    fix: "booking",
    fixPath: DQ_FIX_PATHS.booking,
    actions: todayActions("booking", ref.roles, false),
    issueId: null,
  };
}

interface IssueRow {
  id: number;
  rule_id: string;
  severity: DqSeverity;
  subject: string;
  message: string;
  fix: string;
  amount_minor: number | null;
  currency: string | null;
  first_seen_at: string;
}

const SKIPPED = TODAY_DQ_SKIPPED_RULES.map((r) => `'${r}'`).join(", ");
/** One query per scope (the division, then the global id 0): idx_dq_issues_list gives the order. */
export const DQ_SQL = `SELECT i.id, i.rule_id, i.severity, i.subject, i.message, i.fix, i.amount_minor, i.currency,
    i.first_seen_at
  FROM dq_issues i LEFT JOIN dq_rules r ON r.id = i.rule_id
  WHERE i.division_id = ?1 AND i.status = 'open' AND i.severity_rank >= 1 AND COALESCE(r.enabled, 1) = 1
    AND i.rule_id NOT IN (${SKIPPED})
  ORDER BY i.severity_rank DESC, i.id DESC LIMIT ${TODAY_SOURCE_CAP + 1}`;
export const DQ_COUNT_SQL = `SELECT i.rule_id AS rule_id, COUNT(*) AS n
  FROM dq_issues i LEFT JOIN dq_rules r ON r.id = i.rule_id
  WHERE i.division_id = ?1 AND i.status = 'open' AND i.severity_rank >= 1 AND COALESCE(r.enabled, 1) = 1
    AND i.rule_id NOT IN (${SKIPPED})
  GROUP BY i.rule_id`;

function issueItem(r: IssueRow, ref: Ref): TodayItemDto {
  const stale = r.rule_id === TODAY_STALE_SETTLEMENT_RULE;
  const priority = stale
    ? TODAY_PRIORITY.staleSettlements
    : r.severity === "critical"
      ? TODAY_PRIORITY.dqCritical
      : TODAY_PRIORITY.dqWarning;
  const kind: TodayKind = stale ? "booking" : "dq";
  const fix = (r.fix in DQ_FIX_PATHS ? r.fix : "bank") as DqFixTarget;
  return {
    kind,
    id: stale ? `booking:stale-${r.id}` : `dq:${r.id}`,
    title: clean(r.message, 160),
    subtitle: clean(r.subject),
    severity: severityOfPriority(priority),
    priority,
    since: r.first_seen_at,
    ageDays: ageDaysBetween(r.first_seen_at, ref.nowMs),
    amountMinor: r.amount_minor,
    currency: r.currency,
    fix,
    fixPath: DQ_FIX_PATHS[fix],
    actions: todayActions(kind, ref.roles, true),
    issueId: r.id,
  };
}

// ---- handler ----------------------------------------------------------------------------------------

async function divisionOrNone(ctx: Ctx): Promise<number | null> {
  const raw = ctx.url.searchParams.get("division");
  try {
    return (await resolveDivision(ctx)).id;
  } catch (e) {
    // No administration at all still has bank lines and global issues; a wrong one is an error.
    if (raw === null && e instanceof BadRequest && e.code === "no_division") return null;
    throw e;
  }
}

async function todayHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const q = ctx.url.searchParams;
  const limit = positiveIntParam(q.get("limit"), "limit") ?? DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) throw new BadRequest("bad_limit");
  const rawCursor = q.get("cursor");
  const cursor = rawCursor === null ? null : decodeTodayCursor(rawCursor);
  if (rawCursor !== null && cursor === null) throw new BadRequest("bad_cursor");
  const divisionId = await divisionOrNone(ctx);
  const ref: Ref = {
    divisionId,
    roles: ctx.session?.roles ?? [],
    nowMs: ctx.nowMs,
    todayDate: today(ctx),
  };
  const dqScopes = divisionId === null ? [0] : [divisionId, 0];
  const none = { results: [] as never[] };

  // One batch: every query in a single round trip to D1.
  const stmts = [
    db.prepare(MATCHES_SQL),
    db.prepare(MATCHES_COUNT_SQL),
    ...(divisionId === null
      ? []
      : [
          db.prepare(APPROVALS_SQL).bind(divisionId),
          db.prepare(APPROVALS_COUNT_SQL).bind(divisionId),
          db.prepare(BOOKING_SQL).bind(divisionId),
          db.prepare(BOOKING_COUNT_SQL).bind(divisionId),
        ]),
    ...dqScopes.flatMap((s) => [db.prepare(DQ_SQL).bind(s), db.prepare(DQ_COUNT_SQL).bind(s)]),
  ];
  const out = await db.batch<Record<string, unknown>>(stmts);
  let at = 0;
  const next = (): { results: Record<string, unknown>[] } => out[at++] ?? none;
  const matches = next().results as unknown as MatchRow[];
  const matchCount = Number(next().results[0]?.["n"] ?? 0);
  let approvals: ApprovalRow[] = [];
  let approvalCount = 0;
  let bookings: BookingRow[] = [];
  let bookingCount = 0;
  if (divisionId !== null) {
    approvals = next().results as unknown as ApprovalRow[];
    approvalCount = Number(next().results[0]?.["n"] ?? 0);
    bookings = next().results as unknown as BookingRow[];
    bookingCount = Number(next().results[0]?.["n"] ?? 0);
  }
  const issues: IssueRow[] = [];
  let dqCapped = false;
  const dqCountByRule = new Map<string, number>();
  for (let i = 0; i < dqScopes.length; i++) {
    const rows = next().results as unknown as IssueRow[];
    if (rows.length > TODAY_SOURCE_CAP) dqCapped = true;
    issues.push(...rows.slice(0, TODAY_SOURCE_CAP));
    for (const c of next().results) {
      const rule = String(c["rule_id"]);
      dqCountByRule.set(rule, (dqCountByRule.get(rule) ?? 0) + Number(c["n"]));
    }
  }

  const capped =
    dqCapped ||
    matches.length > TODAY_SOURCE_CAP ||
    approvals.length > TODAY_SOURCE_CAP ||
    bookings.length > TODAY_SOURCE_CAP;
  const items: TodayItemDto[] = [
    ...matches.slice(0, TODAY_SOURCE_CAP).map((r) => matchItem(r, ref)),
    ...approvals.slice(0, TODAY_SOURCE_CAP).map((r) => approvalItem(r, ref)),
    ...bookings.slice(0, TODAY_SOURCE_CAP).map((r) => bookingItem(r, ref)),
    ...issues.map((r) => issueItem(r, ref)),
  ];

  const staleCount = dqCountByRule.get(TODAY_STALE_SETTLEMENT_RULE) ?? 0;
  const dqTotal = [...dqCountByRule.values()].reduce((a, b) => a + b, 0);
  const counts: Record<TodayKind, number> = {
    approval: approvalCount,
    match: matchCount,
    booking: bookingCount + staleCount,
    dq: dqTotal - staleCount,
  };
  const { page, nextCursor } = pageToday(items, limit, cursor);
  const body: TodayResponse = {
    items: page,
    nextCursor,
    counts,
    total: TODAY_KINDS.reduce((n, k) => n + counts[k], 0),
    capped,
    approvalMappingVerified: (await readMappingCheck(db)).verified,
    generatedAt: new Date(ctx.nowMs).toISOString(),
  };
  return json(body);
}

export function registerTodayRoutes(router: Router): void {
  router.add("GET", "/api/today", ANY_ROLE, guarded(todayHandler));
}
