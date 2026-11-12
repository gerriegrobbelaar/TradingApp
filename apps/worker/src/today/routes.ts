/**
 * Today queue (Phase 8, D8c, ADR 0047). Read-only.
 *
 *  GET /api/today?division=&limit=&cursor=     any role
 *
 * One merged, ranked list of things a person can act on, built from data we already have:
 *  - pending approvals (purchase_entries.status = pending_approval) of the chosen administration;
 *  - bank lines with a suggested match (the matching review queue);
 *  - bookings that need a person (outbox manual_required, outcome_unknown) and stale settlements;
 *  - open data quality issues, critical and warning, not snoozed;
 *  - payment requests (Phase 9 final review S2, ADR 0053): `payment_approval` (pending a second
 *    person; only for an approver, never their own request) and `payment_ready` (approved, not sent;
 *    only for finance). Both read D1 through idx_payments_status / idx_payment_batches_status.
 *
 * Cost: five index-backed queries (approvals, matches, bookings, issues per scope), each reads at
 * most CAP + 1 rows, plus the counts and the last data check run. Each source is read IN QUEUE
 * ORDER (the same priority / since / id-as-text rule as core `compareToday`), so its first CAP rows
 * are its top CAP. The merge, order (core `pageToday`) and cursor are computed in memory over at
 * most 5 x (CAP + 1) rows, so a page costs the same however deep the cursor is. When a source is
 * cut, nothing past its last read row is served (core `cappedHorizon`): the queue is always a true
 * prefix of the full order, and `cappedKinds` names the cut sources; handling the first ones
 * reveals the rest. No full IBAN, no email, no free bank text leaves here: only names that
 * Approvals and Bank already show, amounts and codes. Nothing here writes.
 */
import {
  DQ_FIX_PATHS,
  maskIbans,
  TODAY_DQ_SKIPPED_RULES,
  TODAY_KINDS,
  TODAY_PAYMENT_READY_RULE,
  TODAY_PRIORITY,
  TODAY_STALE_SETTLEMENT_RULE,
  ageDaysBetween,
  approvalAgeDays,
  canonicalSince,
  cappedHorizon,
  approvalPriority,
  decodeTodayCursor,
  pageToday,
  severityOfPriority,
  sortToday,
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
  /** Lower-case e-mail of the caller (never shown), for "not your own request". */
  email: string;
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

/** No `since` sorts last (core NO_SINCE). */
const NO_SINCE_SQL = "'9999-12-31T23:59:59.999Z'";

/**
 * Queue order: `since` (submitted, else the entry date at midnight UTC) ascending, then the id as
 * text. Priority (late above 3 days) only grows with age, so oldest-first is also priority-first.
 * The sort runs over the pending entries of one administration only (idx_purchase_entries_list
 * finds them); stored instants are `toISOString` text (Exact sync), so text order is time order.
 */
export const APPROVALS_SQL = `SELECT pe.id, pe.entry_number, pe.relation_name, r.name AS relation_row_name,
    pe.currency, pe.amount_minor, pe.entry_date, pe.submitted_at
  FROM purchase_entries pe
  LEFT JOIN relations r ON r.division_id = pe.division_id AND r.exact_id = pe.relation_id
  WHERE pe.division_id = ?1 AND pe.status = 'pending_approval'
  ORDER BY COALESCE(pe.submitted_at,
             CASE WHEN pe.entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                  THEN pe.entry_date || 'T00:00:00.000Z' END, ${NO_SINCE_SQL}) ASC,
           CAST(pe.id AS TEXT) ASC LIMIT ${TODAY_SOURCE_CAP + 1}`;
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
    since: canonicalSince(r.submitted_at) ?? dayStart(r.entry_date),
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

/** Queue order: oldest bank line first, then the id as text (the sort covers suggested lines only). */
export const MATCHES_SQL = `SELECT t.id, t.amount_minor, t.currency, t.counterparty_name, a.name AS account_name,
    t.created_at,
    (SELECT s.score FROM match_suggestions s WHERE s.bank_transaction_id = t.id AND s.rank = 1) AS score
  FROM bank_transactions t LEFT JOIN bank_accounts a ON a.id = t.bank_account_id
  WHERE t.match_status = 'suggested' AND t.is_final = 1 AND t.state = 'completed'
  ORDER BY t.created_at ASC, CAST(t.id AS TEXT) ASC LIMIT ${TODAY_SOURCE_CAP + 1}`;
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
    since: canonicalSince(r.created_at),
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

/** Queue order: unknown outcome (100) before manual (80), then oldest change, then id as text. */
export const BOOKING_SQL = `SELECT o.id, o.status, o.kind, o.updated_at, o.attempts, t.amount_minor, t.currency
  FROM exact_write_outbox o
  JOIN matches m ON m.id = o.match_id
  LEFT JOIN bank_transactions t ON t.id = m.bank_transaction_id
  WHERE o.status IN ('outcome_unknown', 'manual_required') AND o.division_id = ?1 AND m.undone_at IS NULL
  ORDER BY CASE o.status WHEN 'outcome_unknown' THEN 0 ELSE 1 END ASC, o.updated_at ASC,
           CAST(o.id AS TEXT) ASC LIMIT ${TODAY_SOURCE_CAP + 1}`;
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
    since: canonicalSince(r.updated_at),
    ageDays: age,
    amountMinor: r.amount_minor,
    currency: r.currency,
    fix: "booking",
    fixPath: DQ_FIX_PATHS.booking,
    actions: todayActions("booking", ref.roles, false),
    issueId: null,
  };
}

// ---- payment requests -------------------------------------------------------------------------------

/** A ready request older than this is no longer a queue item (the DQ rule still reports it). */
export const PAYMENT_READY_LOOKBACK_MS = 7 * 86_400_000;
const HOUR = 3_600_000;

interface PaymentRow {
  kind: "payment" | "batch";
  id: number;
  amount_minor: number;
  currency: string;
  created_at: string;
  expires_at: string;
}

const PAYMENT_ID_SQL = "CASE kind WHEN 'batch' THEN 'batch-' || id ELSE CAST(id AS TEXT) END";
/**
 * Requests waiting for a second person: this administration, not yet expired, NOT requested by the
 * caller (?2, lower case). Each branch is found by status through idx_payments_status /
 * idx_payment_batches_status (status, created_at); only that small set is sorted. Top-level
 * requests only: the items of a batch are decided with the batch. Queue order: oldest first, then
 * the id as text (`batch-N` for a batch), the same total order as core `compareToday`.
 */
export const PAYMENT_APPROVAL_SQL = `SELECT kind, id, amount_minor, currency, created_at, expires_at FROM (
    SELECT 'payment' AS kind, p.id AS id, p.amount_minor AS amount_minor, p.currency AS currency,
           p.created_at AS created_at, p.expires_at AS expires_at
      FROM payments p
     WHERE p.status = 'pending_approval' AND p.division_id = ?1 AND p.batch_id IS NULL
       AND p.requested_by <> ?2 AND p.expires_at > ?3
    UNION ALL
    SELECT 'batch', b.id, b.total_minor, b.currency, b.created_at, b.expires_at
      FROM payment_batches b
     WHERE b.status = 'pending_approval' AND b.division_id = ?1
       AND b.requested_by <> ?2 AND b.expires_at > ?3
  ) ORDER BY created_at ASC, ${PAYMENT_ID_SQL} ASC LIMIT ${TODAY_SOURCE_CAP + 1}`;
export const PAYMENT_APPROVAL_COUNT_SQL = `SELECT
    (SELECT COUNT(*) FROM payments WHERE status = 'pending_approval' AND division_id = ?1
        AND batch_id IS NULL AND requested_by <> ?2 AND expires_at > ?3)
  + (SELECT COUNT(*) FROM payment_batches WHERE status = 'pending_approval' AND division_id = ?1
        AND requested_by <> ?2 AND expires_at > ?3) AS n`;

/** Approved, not sent (status ready) in this administration, created within the look-back (?2). */
export const PAYMENT_READY_SQL = `SELECT kind, id, amount_minor, currency, created_at, expires_at FROM (
    SELECT 'payment' AS kind, p.id AS id, p.amount_minor AS amount_minor, p.currency AS currency,
           p.created_at AS created_at, p.expires_at AS expires_at
      FROM payments p
     WHERE p.status = 'ready' AND p.division_id = ?1 AND p.batch_id IS NULL AND p.created_at >= ?2
    UNION ALL
    SELECT 'batch', b.id, b.total_minor, b.currency, b.created_at, b.expires_at
      FROM payment_batches b
     WHERE b.status = 'ready' AND b.division_id = ?1 AND b.created_at >= ?2
  ) ORDER BY created_at ASC, ${PAYMENT_ID_SQL} ASC LIMIT ${TODAY_SOURCE_CAP + 1}`;
export const PAYMENT_READY_COUNT_SQL = `SELECT
    (SELECT COUNT(*) FROM payments WHERE status = 'ready' AND division_id = ?1
        AND batch_id IS NULL AND created_at >= ?2)
  + (SELECT COUNT(*) FROM payment_batches WHERE status = 'ready' AND division_id = ?1
        AND created_at >= ?2) AS n`;

const hours = (n: number): string => `${n} ${n === 1 ? "hour" : "hours"}`;

function expiryText(expiresAt: string, nowMs: number): string {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return "expiry unknown";
  if (t <= nowMs) return "expired";
  return `expires in ${hours(Math.ceil((t - nowMs) / HOUR))}`;
}

function paymentItem(
  r: PaymentRow,
  ref: Ref,
  kind: "payment_approval" | "payment_ready",
): TodayItemDto {
  const approval = kind === "payment_approval";
  const priority = approval ? TODAY_PRIORITY.paymentApproval : TODAY_PRIORITY.paymentReady;
  const since = canonicalSince(r.created_at);
  const waited = since === null ? 0 : Math.floor(Math.max(0, ref.nowMs - Date.parse(since)) / HOUR);
  const what = r.kind === "batch" ? "Batch" : "Payment";
  return {
    kind,
    id: `${kind}:${r.kind === "batch" ? "batch-" : ""}${r.id}`,
    title: approval
      ? `${hours(waited)} waiting for a second approver`
      : `${hours(waited)} since approval, not sent`,
    subtitle: `${what} ${r.id} · ${expiryText(r.expires_at, ref.nowMs)}`,
    severity: severityOfPriority(priority),
    priority,
    since,
    ageDays: ageDaysBetween(r.created_at, ref.nowMs),
    amountMinor: r.amount_minor,
    currency: r.currency,
    fix: approval ? "payment_approvals" : "payments",
    fixPath: DQ_FIX_PATHS[approval ? "payment_approvals" : "payments"],
    actions: todayActions(kind, ref.roles, false),
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

/**
 * A bank line that has a match suggestion already shows as a match item; its "unmatched for too long"
 * issue would list the same line twice (review V1 N3). The filter is the one of MATCHES_SQL, so a line
 * is hidden here only when it really is listed as a match item.
 */
const NOT_SUGGESTED_LINE = `NOT (i.rule_id = 'bank.unmatched_old' AND EXISTS (
    SELECT 1 FROM bank_transactions t
    WHERE t.id = json_extract(i.payload_json, '$.txId') AND t.match_status = 'suggested'
      AND t.is_final = 1 AND t.state = 'completed'))`;
/**
 * An issue about a ready payment is the same thing as its `payment_ready` item: hidden only when the
 * caller sees that item (?2 = the caller's division when the caller holds finance, else -1; ?3 = the
 * same look-back cut-off as PAYMENT_READY_SQL). Anyone else still gets the issue.
 */
const NOT_READY_PAYMENT_ITEM = `NOT (i.rule_id = '${TODAY_PAYMENT_READY_RULE}' AND (
    (json_extract(i.payload_json, '$.subjectKind') = 'payment' AND EXISTS (
       SELECT 1 FROM payments p WHERE p.id = json_extract(i.payload_json, '$.subjectId')
         AND p.status = 'ready' AND p.batch_id IS NULL AND p.division_id = ?2 AND p.created_at >= ?3))
    OR (json_extract(i.payload_json, '$.subjectKind') = 'batch' AND EXISTS (
       SELECT 1 FROM payment_batches b WHERE b.id = json_extract(i.payload_json, '$.subjectId')
         AND b.status = 'ready' AND b.division_id = ?2 AND b.created_at >= ?3))))`;
const SKIPPED = TODAY_DQ_SKIPPED_RULES.map((r) => `'${r}'`).join(", ");
/**
 * One query per scope (the division, then the global id 0; ?2 and ?3 see NOT_READY_PAYMENT_ITEM), in queue order: the priority of
 * `issueItem` (stale settlements 75, critical 90, warning 60), then first seen, then id as text.
 * idx_dq_issues_list finds the open rows of the scope; only those are sorted.
 */
export const DQ_SQL = `SELECT i.id, i.rule_id, i.severity, i.subject, i.message, i.fix, i.amount_minor, i.currency,
    i.first_seen_at
  FROM dq_issues i LEFT JOIN dq_rules r ON r.id = i.rule_id
  WHERE i.division_id = ?1 AND i.status = 'open' AND i.severity_rank >= 1 AND COALESCE(r.enabled, 1) = 1
    AND i.rule_id NOT IN (${SKIPPED})
    AND ${NOT_SUGGESTED_LINE}
    AND ${NOT_READY_PAYMENT_ITEM}
  ORDER BY CASE WHEN i.rule_id = '${TODAY_STALE_SETTLEMENT_RULE}' THEN ${TODAY_PRIORITY.staleSettlements}
                WHEN i.severity_rank = 2 THEN ${TODAY_PRIORITY.dqCritical}
                ELSE ${TODAY_PRIORITY.dqWarning} END DESC,
           i.first_seen_at ASC, CAST(i.id AS TEXT) ASC LIMIT ${TODAY_SOURCE_CAP + 1}`;
export const DQ_COUNT_SQL = `SELECT i.rule_id AS rule_id, COUNT(*) AS n
  FROM dq_issues i LEFT JOIN dq_rules r ON r.id = i.rule_id
  WHERE i.division_id = ?1 AND i.status = 'open' AND i.severity_rank >= 1 AND COALESCE(r.enabled, 1) = 1
    AND i.rule_id NOT IN (${SKIPPED})
    AND ${NOT_SUGGESTED_LINE}
    AND ${NOT_READY_PAYMENT_ITEM}
  GROUP BY i.rule_id`;

function issueItem(r: IssueRow, ref: Ref): TodayItemDto {
  const stale = r.rule_id === TODAY_STALE_SETTLEMENT_RULE;
  const priority = stale
    ? TODAY_PRIORITY.staleSettlements
    : r.severity === "critical"
      ? TODAY_PRIORITY.dqCritical
      : TODAY_PRIORITY.dqWarning;
  const kind: TodayKind = stale ? "booking" : "dq";
  // Own keys only: `"constructor" in DQ_FIX_PATHS` is true and would make fixPath a function.
  const fix = (Object.hasOwn(DQ_FIX_PATHS, r.fix) ? r.fix : "bank") as DqFixTarget;
  return {
    kind,
    id: stale ? `booking:stale-${r.id}` : `dq:${r.id}`,
    title: clean(r.message, 160),
    subtitle: clean(r.subject),
    severity: severityOfPriority(priority),
    priority,
    since: canonicalSince(r.first_seen_at),
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

export const DQ_LAST_RUN_SQL = "SELECT status, finished_at FROM dq_runs ORDER BY id DESC LIMIT 1";

/** One source as read: its first CAP rows as items, and whether it had more. */
interface Source {
  kind: TodayKind;
  items: TodayItemDto[];
  capped: boolean;
}

function source<R>(kind: TodayKind, rows: readonly R[], toItem: (r: R) => TodayItemDto): Source {
  return {
    kind,
    items: rows.slice(0, TODAY_SOURCE_CAP).map(toItem),
    capped: rows.length > TODAY_SOURCE_CAP,
  };
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
  const roles = ctx.session?.roles ?? [];
  const sees = { approval: roles.includes("approver"), ready: roles.includes("finance") };
  const nowIso = new Date(ctx.nowMs).toISOString();
  const readyCutoff = new Date(ctx.nowMs - PAYMENT_READY_LOOKBACK_MS).toISOString();
  const ref: Ref = {
    divisionId,
    roles,
    email: (ctx.session?.email ?? "").toLowerCase(),
    nowMs: ctx.nowMs,
    todayDate: today(ctx),
  };
  // The DQ query hides a ready-payment issue only for the division whose ready items this caller sees.
  const readyDivision = sees.ready && divisionId !== null ? divisionId : -1;
  const dqScopes = divisionId === null ? [0] : [divisionId, 0];
  const none = { results: [] as never[] };

  // One batch: every query in a single round trip to D1.
  const stmts = [
    db.prepare(DQ_LAST_RUN_SQL),
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
    ...(divisionId !== null && sees.approval
      ? [
          db.prepare(PAYMENT_APPROVAL_SQL).bind(divisionId, ref.email, nowIso),
          db.prepare(PAYMENT_APPROVAL_COUNT_SQL).bind(divisionId, ref.email, nowIso),
        ]
      : []),
    ...(divisionId !== null && sees.ready
      ? [
          db.prepare(PAYMENT_READY_SQL).bind(divisionId, readyCutoff),
          db.prepare(PAYMENT_READY_COUNT_SQL).bind(divisionId, readyCutoff),
        ]
      : []),
    ...dqScopes.flatMap((s) => [
      db.prepare(DQ_SQL).bind(s, readyDivision, readyCutoff),
      db.prepare(DQ_COUNT_SQL).bind(s, readyDivision, readyCutoff),
    ]),
  ];
  const out = await db.batch<Record<string, unknown>>(stmts);
  let at = 0;
  const next = (): { results: Record<string, unknown>[] } => out[at++] ?? none;
  const run = next().results[0] as { status: string; finished_at: string | null } | undefined;
  const sources: Source[] = [];
  sources.push(source("match", next().results as unknown as MatchRow[], (r) => matchItem(r, ref)));
  const matchCount = Number(next().results[0]?.["n"] ?? 0);
  let approvalCount = 0;
  let bookingCount = 0;
  if (divisionId !== null) {
    sources.push(
      source("approval", next().results as unknown as ApprovalRow[], (r) => approvalItem(r, ref)),
    );
    approvalCount = Number(next().results[0]?.["n"] ?? 0);
    sources.push(
      source("booking", next().results as unknown as BookingRow[], (r) => bookingItem(r, ref)),
    );
    bookingCount = Number(next().results[0]?.["n"] ?? 0);
  }
  let paymentApprovalCount = 0;
  let paymentReadyCount = 0;
  if (divisionId !== null && sees.approval) {
    sources.push(
      source("payment_approval", next().results as unknown as PaymentRow[], (r) =>
        paymentItem(r, ref, "payment_approval"),
      ),
    );
    paymentApprovalCount = Number(next().results[0]?.["n"] ?? 0);
  }
  if (divisionId !== null && sees.ready) {
    sources.push(
      source("payment_ready", next().results as unknown as PaymentRow[], (r) =>
        paymentItem(r, ref, "payment_ready"),
      ),
    );
    paymentReadyCount = Number(next().results[0]?.["n"] ?? 0);
  }
  const dqCountByRule = new Map<string, number>();
  for (let i = 0; i < dqScopes.length; i++) {
    const rows = next().results as unknown as IssueRow[];
    sources.push(source("dq", rows, (r) => issueItem(r, ref)));
    for (const c of next().results) {
      const rule = String(c["rule_id"]);
      dqCountByRule.set(rule, (dqCountByRule.get(rule) ?? 0) + Number(c["n"]));
    }
  }

  const items = sources.flatMap((s) => s.items);
  const capped = sources.filter((s) => s.capped);
  const horizon = cappedHorizon(
    capped.flatMap((s) => {
      const last = sortToday(s.items).at(-1);
      return last ? [last] : [];
    }),
  );

  const staleCount = dqCountByRule.get(TODAY_STALE_SETTLEMENT_RULE) ?? 0;
  const dqTotal = [...dqCountByRule.values()].reduce((a, b) => a + b, 0);
  const counts: Record<TodayKind, number> = {
    approval: approvalCount,
    match: matchCount,
    booking: bookingCount + staleCount,
    dq: dqTotal - staleCount,
    payment_approval: paymentApprovalCount,
    payment_ready: paymentReadyCount,
  };
  // Exact per kind: a kind is cut when it has more matching rows than were read (the batch is one
  // transaction, so the counts and the rows agree).
  const read = (k: TodayKind): number => items.filter((i) => i.kind === k).length;
  const cappedKinds = TODAY_KINDS.filter((k) => counts[k] > read(k));
  const { page, nextCursor } = pageToday(items, limit, cursor, horizon);
  const runStatus = run?.status;
  const body: TodayResponse = {
    items: page,
    nextCursor,
    counts,
    total: TODAY_KINDS.reduce((n, k) => n + counts[k], 0),
    capped: capped.length > 0 || cappedKinds.length > 0,
    cappedKinds,
    notChecked:
      divisionId === null
        ? [
            "approval",
            "booking",
            ...(sees.approval ? (["payment_approval"] as const) : []),
            ...(sees.ready ? (["payment_ready"] as const) : []),
          ]
        : [],
    dqLastRun:
      run === undefined
        ? null
        : {
            status: runStatus === "ok" || runStatus === "partial" ? runStatus : "error",
            finishedAt: canonicalSince(run.finished_at),
          },
    approvalMappingVerified: (await readMappingCheck(db)).verified,
    generatedAt: new Date(ctx.nowMs).toISOString(),
  };
  return json(body);
}

export function registerTodayRoutes(router: Router): void {
  router.add("GET", "/api/today", ANY_ROLE, guarded(todayHandler));
}
