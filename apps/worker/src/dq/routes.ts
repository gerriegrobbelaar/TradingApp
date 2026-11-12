/**
 * Data quality API (Phase 8, D8a, ADR 0045). Shapes: packages/core api-types (Dq*).
 *
 *  GET   /api/dq/summary                   any role   counts by severity and area, last run, every rule's status
 *  GET   /api/dq/issues                    any role   cursor list with filters
 *  POST  /api/dq/issues/:id/snooze         finance, admin   {until, note}            audited, idempotent
 *  POST  /api/dq/issues/:id/resolve-note   finance, admin   {note}                   audited, idempotent
 *  GET   /api/dq/rules                     admin
 *  PATCH /api/dq/rules/:id                 admin, step-up   {enabled?, severity?, threshold?, confirm?, rev}
 *
 * Every write is one batch of change + audit row (ADR 0013); the audit row is conditional on the
 * change having happened, so a repeated request writes no second row. Responses never contain a
 * full IBAN (the payload is masked when it is stored). CSRF is enforced by the router.
 */
import {
  DQ_AREAS,
  DQ_FIX_PATHS,
  DQ_LOOSEN_PHRASE,
  DQ_RULES,
  DQ_SEVERITIES,
  dqRuleById,
  isCriticalRule,
  isLooseningChange,
  resolveRuleConfig,
  thresholdValid,
  type DqArea,
  type DqDetails,
  type DqFixTarget,
  type DqIssueDto,
  type DqIssueResponse,
  type DqIssuesResponse,
  type DqRuleConfig,
  type DqRuleDef,
  type DqRuleDto,
  type DqRulePatchResponse,
  type DqRuleStatusDto,
  type DqRulesResponse,
  type DqRunDto,
  type DqSeverity,
  type DqSummaryResponse,
} from "@camelthorn/core";
import { auditStatement } from "../db/audit";
import { ANY_ROLE, BadRequest, guarded, positiveIntParam, resolveDivision } from "../read/routes";
import { json, type Ctx, type Router } from "../router";
import { loadRuleRows, thresholdToJson, toOverrides, safeText, type RuleRow } from "./store";

const FINANCE = { roles: ["finance", "admin"] } as const;
const ADMIN = { roles: ["admin"] } as const;
const ADMIN_STEP_UP = { roles: ["admin"], stepUp: true } as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
export const MAX_SNOOZE_DAYS = 90;
const MIN_SNOOZE_MS = 60_000;

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422 = 400,
  ) {
    super(code);
  }
}

const safely =
  (fn: (ctx: Ctx) => Promise<Response>) =>
  async (ctx: Ctx): Promise<Response> => {
    try {
      return await guarded(fn)(ctx);
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.code }, err.status);
      throw err;
    }
  };

const actor = (ctx: Ctx): string => {
  if (!ctx.session) throw new BadRequest("unauthenticated");
  return ctx.session.email;
};

async function readBody(ctx: Ctx, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const len = Number(ctx.request.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > 10_000) throw new ApiError("bad_request");
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    throw new ApiError("bad_request");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("bad_request");
  }
  const rec = body as Record<string, unknown>;
  if (Object.keys(rec).some((k) => !allowed.includes(k))) throw new ApiError("bad_request");
  return rec;
}

/** A note from a person: trimmed, 1..200 characters, no control or bidi characters. */
function note(v: unknown): string {
  if (typeof v !== "string") throw new ApiError("bad_note");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(v)) {
    throw new ApiError("bad_note");
  }
  const t = v.trim();
  if (t.length === 0 || t.length > 200) throw new ApiError("bad_note");
  return t;
}

function idParam(ctx: Ctx): number {
  const raw = ctx.params["id"] ?? "";
  if (!/^[1-9]\d{0,12}$/.test(raw)) throw new ApiError("not_found", 404);
  return Number(raw);
}

// ---- rows to DTOs -----------------------------------------------------------------------------------

interface IssueSql {
  id: number;
  division_id: number;
  rule_id: string;
  area: DqArea;
  severity: DqSeverity;
  status: DqIssueDto["status"];
  subject: string;
  message: string;
  fix: string;
  amount_minor: number | null;
  currency: string | null;
  payload_json: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  snoozed_until: string | null;
  snoozed_by: string | null;
  snooze_note: string | null;
  reopen_count: number;
  notified_at: string | null;
  severity_rank: number;
}

const ISSUE_COLUMNS = `i.id, i.division_id, i.rule_id, i.area, i.severity, i.status, i.subject, i.message, i.fix,
  i.amount_minor, i.currency, i.payload_json, i.first_seen_at, i.last_seen_at, i.resolved_at, i.resolved_by,
  i.resolution_note, i.snoozed_until, i.snoozed_by, i.snooze_note, i.reopen_count, i.notified_at, i.severity_rank`;

function details(json_: string): DqDetails {
  try {
    const v: unknown = JSON.parse(json_);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as DqDetails) : {};
  } catch {
    return {};
  }
}

export function toIssueDto(r: IssueSql): DqIssueDto {
  const fix = (r.fix in DQ_FIX_PATHS ? r.fix : "bank") as DqFixTarget;
  return {
    id: r.id,
    divisionId: r.division_id,
    ruleId: r.rule_id,
    area: r.area,
    severity: r.severity,
    status: r.status,
    // Defence in depth: whatever is stored, a full IBAN never leaves the API.
    subject: safeText(r.subject),
    message: safeText(r.message),
    fix,
    fixPath: DQ_FIX_PATHS[fix],
    amountMinor: r.amount_minor,
    currency: r.currency,
    details: details(r.payload_json),
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    resolutionNote: r.resolution_note,
    snoozedUntil: r.snoozed_until,
    snoozedBy: r.snoozed_by,
    snoozeNote: r.snooze_note,
    reopenCount: r.reopen_count,
    notifiedAt: r.notified_at,
  };
}

async function loadIssue(db: D1Database, id: number): Promise<IssueSql | null> {
  return db
    .prepare(`SELECT ${ISSUE_COLUMNS} FROM dq_issues i WHERE i.id = ?1`)
    .bind(id)
    .first<IssueSql>();
}

/** The divisions an answer covers: the chosen one plus the global pass (id 0). */
async function scopeIds(ctx: Ctx): Promise<number[]> {
  const raw = ctx.url.searchParams.get("division");
  try {
    const d = await resolveDivision(ctx);
    return [d.id, 0];
  } catch (e) {
    // An unknown division is an error; no division at all still has global issues.
    if (raw === null && e instanceof BadRequest && e.code === "no_division") return [0];
    throw e;
  }
}

// ---- summary ----------------------------------------------------------------------------------------

interface StatusSql {
  division_id: number;
  rule_id: string;
  status: DqRuleStatusDto["status"];
  reason: string | null;
  checked: number;
  evaluated_at: string;
}

async function summaryHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const ids = await scopeIds(ctx);
  const divisionId = ids[0] as number;
  const [runRow, counts, statuses, ruleRows] = await Promise.all([
    db.prepare("SELECT * FROM dq_runs ORDER BY id DESC LIMIT 1").first<{
      id: number;
      started_at: string;
      finished_at: string | null;
      status: DqRunDto["status"];
      divisions: number;
      rules_evaluated: number;
      rules_unavailable: number;
      new_issues: number;
      resolved_issues: number;
      open_issues: number;
    }>(),
    db
      .prepare(
        `SELECT i.rule_id, i.area, i.severity, i.status, COUNT(*) AS n
         FROM dq_issues i LEFT JOIN dq_rules r ON r.id = i.rule_id
         WHERE i.division_id IN (?1, ?2) AND i.status IN ('open', 'snoozed') AND COALESCE(r.enabled, 1) = 1
         GROUP BY i.rule_id, i.area, i.severity, i.status`,
      )
      .bind(ids[0], ids[1] ?? 0)
      .all<{ rule_id: string; area: DqArea; severity: DqSeverity; status: string; n: number }>(),
    db
      .prepare(
        "SELECT division_id, rule_id, status, reason, checked, evaluated_at FROM dq_rule_status WHERE division_id IN (?1, ?2)",
      )
      .bind(ids[0], ids[1] ?? 0)
      .all<StatusSql>(),
    loadRuleRows(db),
  ]);
  const open: Record<DqSeverity, number> = { info: 0, warning: 0, critical: 0 };
  const byArea = Object.fromEntries(
    DQ_AREAS.map((a) => [a, { info: 0, warning: 0, critical: 0 }]),
  ) as Record<DqArea, Record<DqSeverity, number>>;
  const openByRule = new Map<string, number>();
  let snoozed = 0;
  for (const c of counts.results) {
    if (c.status === "snoozed") {
      snoozed += c.n;
      continue;
    }
    open[c.severity] += c.n;
    byArea[c.area][c.severity] += c.n;
    openByRule.set(c.rule_id, (openByRule.get(c.rule_id) ?? 0) + c.n);
  }
  const statusBy = new Map(
    statuses.results.map((s) => [`${s.division_id}:${s.rule_id}`, s] as const),
  );
  const overrides = toOverrides(ruleRows);
  const rules: DqRuleStatusDto[] = DQ_RULES.map((rule) => {
    const config = resolveRuleConfig(rule, overrides.get(rule.id));
    const st = statusBy.get(`${rule.scope === "global" ? 0 : divisionId}:${rule.id}`);
    return {
      ruleId: rule.id,
      area: rule.area,
      title: rule.title,
      severity: config.severity,
      enabled: config.enabled,
      // A switched-off rule shows as disabled even if an older run stored another status.
      status: !config.enabled ? "disabled" : (st?.status ?? "never_run"),
      reason: !config.enabled ? "rule_disabled" : (st?.reason ?? null),
      checked: st?.checked ?? 0,
      openIssues: openByRule.get(rule.id) ?? 0,
      evaluatedAt: st?.evaluated_at ?? null,
    };
  });
  const body: DqSummaryResponse = {
    divisionId,
    lastRun: runRow
      ? {
          id: runRow.id,
          startedAt: runRow.started_at,
          finishedAt: runRow.finished_at,
          status: runRow.status,
          divisions: runRow.divisions,
          rulesEvaluated: runRow.rules_evaluated,
          rulesUnavailable: runRow.rules_unavailable,
          newIssues: runRow.new_issues,
          resolvedIssues: runRow.resolved_issues,
          openIssues: runRow.open_issues,
        }
      : null,
    open,
    snoozed,
    byArea,
    rules,
  };
  return json(body);
}

// ---- issues -----------------------------------------------------------------------------------------

const STATUSES = ["open", "resolved", "snoozed", "all"] as const;

function decodeCursor(raw: string | null): { rank: number; id: number } | null {
  if (raw === null) return null;
  const m = /^([0-2]):([1-9]\d{0,12})$/.exec(raw);
  if (!m) throw new BadRequest("bad_cursor");
  return { rank: Number(m[1]), id: Number(m[2]) };
}

async function issuesHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const q = ctx.url.searchParams;
  const ids = await scopeIds(ctx);
  const status = q.get("status") ?? "open";
  if (!(STATUSES as readonly string[]).includes(status)) throw new BadRequest("bad_status");
  const area = q.get("area");
  if (area !== null && !(DQ_AREAS as readonly string[]).includes(area))
    throw new BadRequest("bad_area");
  const severity = q.get("severity");
  if (severity !== null && !(DQ_SEVERITIES as readonly string[]).includes(severity)) {
    throw new BadRequest("bad_severity");
  }
  const rule = q.get("rule");
  if (rule !== null && dqRuleById(rule) === undefined) throw new BadRequest("bad_rule");
  const limitRaw = positiveIntParam(q.get("limit"), "limit");
  if (limitRaw !== null && limitRaw > MAX_LIMIT) throw new BadRequest("bad_limit");
  const limit = limitRaw ?? DEFAULT_LIMIT;
  const cursor = decodeCursor(q.get("cursor"));

  const where = ["i.division_id IN (?1, ?2)", "COALESCE(r.enabled, 1) = 1"];
  const binds: (string | number)[] = [ids[0] as number, ids[1] ?? 0];
  const bind = (v: string | number): string => {
    binds.push(v);
    return `?${binds.length}`;
  };
  if (status !== "all") where.push(`i.status = ${bind(status)}`);
  if (area !== null) where.push(`i.area = ${bind(area)}`);
  if (severity !== null) where.push(`i.severity = ${bind(severity)}`);
  if (rule !== null) where.push(`i.rule_id = ${bind(rule)}`);
  if (cursor !== null) {
    const rank = bind(cursor.rank);
    where.push(
      `(i.severity_rank < ${rank} OR (i.severity_rank = ${rank} AND i.id < ${bind(cursor.id)}))`,
    );
  }
  const rows = (
    await db
      .prepare(
        `SELECT ${ISSUE_COLUMNS} FROM dq_issues i LEFT JOIN dq_rules r ON r.id = i.rule_id
         WHERE ${where.join(" AND ")} ORDER BY i.severity_rank DESC, i.id DESC LIMIT ${limit + 1}`,
      )
      .bind(...binds)
      .all<IssueSql>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const body: DqIssuesResponse = {
    issues: page.map(toIssueDto),
    nextCursor: rows.length > limit && last ? `${last.severity_rank}:${last.id}` : null,
  };
  return json(body);
}

// ---- snooze and resolve ----------------------------------------------------------------------------

async function snoozeHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const id = idParam(ctx);
  const who = actor(ctx);
  const b = await readBody(ctx, ["until", "note"]);
  const text = note(b["note"]);
  const untilRaw = b["until"];
  const untilMs = typeof untilRaw === "string" ? Date.parse(untilRaw) : NaN;
  if (typeof untilRaw !== "string" || Number.isNaN(untilMs)) throw new ApiError("bad_until");
  if (untilMs < ctx.nowMs + MIN_SNOOZE_MS) throw new ApiError("until_in_past");
  if (untilMs > ctx.nowMs + MAX_SNOOZE_DAYS * 86_400_000) throw new ApiError("until_too_far");
  const until = new Date(untilMs).toISOString();
  const before = await loadIssue(db, id);
  if (!before) throw new ApiError("not_found", 404);
  const out = await db.batch([
    db
      .prepare(
        `UPDATE dq_issues SET status = 'snoozed', snoozed_until = ?2, snoozed_by = ?3, snooze_note = ?4
         WHERE id = ?1 AND status = 'open'`,
      )
      .bind(id, until, who, text),
    auditStatement(
      db,
      {
        actorEmail: who,
        action: "dq.issue_snoozed",
        entity: "dq_issue",
        entityId: id,
        before: { status: before.status, ruleId: before.rule_id },
        after: { status: "snoozed", until, note: text },
      },
      { sql: "changes() = 1", binds: [] },
    ),
  ]);
  if ((out[0]?.meta.changes ?? 0) !== 1) {
    const now = await loadIssue(db, id);
    // An identical repeat of a request that already succeeded answers the same way.
    if (now?.status === "snoozed" && now.snoozed_by === who && now.snoozed_until === until) {
      return json({ issue: toIssueDto(now) } satisfies DqIssueResponse);
    }
    throw new ApiError(now ? "not_open" : "not_found", now ? 409 : 404);
  }
  return json({
    issue: toIssueDto((await loadIssue(db, id)) as IssueSql),
  } satisfies DqIssueResponse);
}

async function resolveHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const id = idParam(ctx);
  const who = actor(ctx);
  const b = await readBody(ctx, ["note"]);
  const text = note(b["note"]);
  const nowIso = new Date(ctx.nowMs).toISOString();
  const before = await loadIssue(db, id);
  if (!before) throw new ApiError("not_found", 404);
  const out = await db.batch([
    db
      .prepare(
        `UPDATE dq_issues SET status = 'resolved', resolved_at = ?2, resolved_by = ?3, resolution_note = ?4,
           snoozed_until = NULL, snoozed_by = NULL, snooze_note = NULL
         WHERE id = ?1 AND status IN ('open', 'snoozed')`,
      )
      .bind(id, nowIso, who, text),
    auditStatement(
      db,
      {
        actorEmail: who,
        action: "dq.issue_resolved",
        entity: "dq_issue",
        entityId: id,
        before: { status: before.status, ruleId: before.rule_id },
        after: { status: "resolved", note: text },
      },
      { sql: "changes() = 1", binds: [] },
    ),
  ]);
  if ((out[0]?.meta.changes ?? 0) !== 1) {
    const now = await loadIssue(db, id);
    if (now?.status === "resolved" && now.resolved_by === who && now.resolution_note === text) {
      return json({ issue: toIssueDto(now) } satisfies DqIssueResponse);
    }
    throw new ApiError("already_resolved", 409);
  }
  return json({
    issue: toIssueDto((await loadIssue(db, id)) as IssueSql),
  } satisfies DqIssueResponse);
}

// ---- rules ------------------------------------------------------------------------------------------

function toRuleDto(rule: DqRuleDef, row: RuleRow | undefined): DqRuleDto {
  const config = resolveRuleConfig(
    rule,
    row ? toOverrides(new Map([[rule.id, row]])).get(rule.id) : undefined,
  );
  return {
    id: rule.id,
    area: rule.area,
    title: rule.title,
    description: rule.description,
    defaultSeverity: rule.defaultSeverity,
    severity: config.severity,
    enabled: config.enabled,
    fix: rule.fix,
    thresholdSpec: rule.threshold,
    threshold:
      config.threshold === null
        ? null
        : Array.isArray(config.threshold)
          ? [...config.threshold]
          : (config.threshold as number),
    isOverridden: row !== undefined,
    rev: row?.rev ?? null,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

async function rulesHandler(ctx: Ctx): Promise<Response> {
  const rows = await loadRuleRows(ctx.env.DB);
  const body: DqRulesResponse = {
    rules: DQ_RULES.map((r) => toRuleDto(r, rows.get(r.id))),
    loosenPhrase: DQ_LOOSEN_PHRASE,
  };
  return json(body);
}

const summaryOf = (c: DqRuleConfig): Record<string, unknown> => ({
  enabled: c.enabled,
  severity: c.severity,
  threshold: c.threshold,
});

async function patchRuleHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const who = actor(ctx);
  const rule = dqRuleById(ctx.params["id"] ?? "");
  if (!rule) throw new ApiError("not_found", 404);
  const b = await readBody(ctx, ["enabled", "severity", "threshold", "confirm", "rev"]);
  if (!("rev" in b) || (b["rev"] !== null && typeof b["rev"] !== "string"))
    throw new ApiError("bad_rev");
  const rev = b["rev"] as string | null;
  if (b["enabled"] === undefined && b["severity"] === undefined && b["threshold"] === undefined) {
    throw new ApiError("nothing_to_change");
  }
  if (b["enabled"] !== undefined && typeof b["enabled"] !== "boolean")
    throw new ApiError("bad_enabled");
  if (
    b["severity"] !== undefined &&
    !(DQ_SEVERITIES as readonly unknown[]).includes(b["severity"])
  ) {
    throw new ApiError("bad_severity");
  }
  if (b["threshold"] !== undefined && !thresholdValid(rule.threshold, b["threshold"])) {
    throw new ApiError("bad_threshold");
  }
  if (b["confirm"] !== undefined && typeof b["confirm"] !== "string")
    throw new ApiError("bad_request");

  const rows = await loadRuleRows(db);
  const row = rows.get(rule.id);
  if ((row?.rev ?? null) !== rev) throw new ApiError("conflict", 409);
  const prev = resolveRuleConfig(
    rule,
    row ? toOverrides(new Map([[rule.id, row]])).get(rule.id) : undefined,
  );
  const next: DqRuleConfig = {
    enabled: (b["enabled"] as boolean | undefined) ?? prev.enabled,
    severity: (b["severity"] as DqSeverity | undefined) ?? prev.severity,
    threshold:
      b["threshold"] === undefined || b["threshold"] === null
        ? prev.threshold
        : (b["threshold"] as number | string[]),
  };
  if (JSON.stringify(summaryOf(prev)) === JSON.stringify(summaryOf(next))) {
    return json({ rule: toRuleDto(rule, row) } satisfies DqRulePatchResponse);
  }
  if (
    isCriticalRule(prev) &&
    isLooseningChange(rule, prev, next) &&
    b["confirm"] !== DQ_LOOSEN_PHRASE
  ) {
    throw new ApiError("confirmation_required", 422);
  }
  const nowIso = new Date(ctx.nowMs).toISOString();
  const nextRev = crypto.randomUUID();
  const sev = next.severity === rule.defaultSeverity ? null : next.severity;
  const thr =
    next.threshold === null ||
    JSON.stringify(next.threshold) === JSON.stringify(rule.threshold?.default ?? null)
      ? null
      : thresholdToJson(next.threshold as number | string[]);
  const change =
    row === undefined
      ? db
          .prepare(
            `INSERT INTO dq_rules (id, enabled, severity, threshold_json, rev, updated_by, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (id) DO NOTHING`,
          )
          .bind(rule.id, next.enabled ? 1 : 0, sev, thr, nextRev, who, nowIso)
      : db
          .prepare(
            `UPDATE dq_rules SET enabled = ?2, severity = ?3, threshold_json = ?4, rev = ?5, updated_by = ?6,
               updated_at = ?7 WHERE id = ?1 AND rev = ?8`,
          )
          .bind(rule.id, next.enabled ? 1 : 0, sev, thr, nextRev, who, nowIso, row.rev);
  const out = await db.batch([
    change,
    auditStatement(
      db,
      {
        actorEmail: who,
        action: "dq.rule_changed",
        entity: "dq_rule",
        entityId: rule.id,
        before: summaryOf(prev),
        after: summaryOf(next),
      },
      { sql: "changes() = 1", binds: [] },
    ),
  ]);
  if ((out[0]?.meta.changes ?? 0) !== 1) throw new ApiError("conflict", 409);
  const fresh = (await loadRuleRows(db)).get(rule.id);
  return json({ rule: toRuleDto(rule, fresh) } satisfies DqRulePatchResponse);
}

export function registerDqRoutes(router: Router): void {
  router.add("GET", "/api/dq/summary", ANY_ROLE, safely(summaryHandler));
  router.add("GET", "/api/dq/issues", ANY_ROLE, safely(issuesHandler));
  router.add("POST", "/api/dq/issues/:id/snooze", FINANCE, safely(snoozeHandler));
  router.add("POST", "/api/dq/issues/:id/resolve-note", FINANCE, safely(resolveHandler));
  router.add("GET", "/api/dq/rules", ADMIN, safely(rulesHandler));
  router.add("PATCH", "/api/dq/rules/:id", ADMIN_STEP_UP, safely(patchRuleHandler));
}
