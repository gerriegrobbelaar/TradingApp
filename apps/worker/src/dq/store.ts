/**
 * Storage of the DQ rule overrides, issues and run summaries (ADR 0045). Issue changes made by a
 * run are conditional on the status the plan was made from, so a concurrent run or a person acting
 * in between is never overwritten (the guard triggers of migration 0026 enforce the rest).
 */
import {
  DQ_ENGINE_VERSION,
  dqRuleById,
  planCounts,
  planReconcile,
  type DqExistingIssue,
  type DqIssue,
  type DqReconcilePlan,
  type DqRuleOverride,
  type DqRuleResult,
} from "@camelthorn/core";
import { maskDeep, auditStatement } from "../db/audit";

/** Resolved issues older than this are deleted by every run (the keep-live trigger allows it). */
export const RESOLVED_RETENTION_DAYS = 180;
const CHUNK = 40;
/** Strict IBAN lookalike left after masking: such text is replaced, never stored. */
const IBAN_LEFTOVER = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
const MAX_PAYLOAD = 3500;

export interface RuleRow {
  id: string;
  enabled: number;
  severity: string | null;
  threshold_json: string | null;
  rev: string;
  updated_by: string;
  updated_at: string;
}

/** `{"value": 5}` -> 5, `{"codes": ["1999"]}` -> ["1999"], anything else -> undefined. */
export function parseThreshold(json: string | null): number | string[] | undefined {
  if (json === null) return undefined;
  try {
    const v = JSON.parse(json) as { value?: unknown; codes?: unknown };
    if (typeof v.value === "number") return v.value;
    if (Array.isArray(v.codes) && v.codes.every((c) => typeof c === "string")) {
      return v.codes as string[];
    }
  } catch {
    // a stored value we cannot read counts as no override
  }
  return undefined;
}

export const thresholdToJson = (t: number | readonly string[] | null): string | null =>
  t === null
    ? null
    : typeof t === "number"
      ? JSON.stringify({ value: t })
      : JSON.stringify({ codes: t });

export async function loadRuleRows(db: D1Database): Promise<Map<string, RuleRow>> {
  const rows = (await db.prepare("SELECT * FROM dq_rules").all<RuleRow>()).results;
  return new Map(rows.map((r) => [r.id, r]));
}

export function toOverrides(rows: ReadonlyMap<string, RuleRow>): Map<string, DqRuleOverride> {
  const out = new Map<string, DqRuleOverride>();
  for (const [id, r] of rows) {
    if (dqRuleById(id) === undefined) continue; // a row for a rule that no longer exists
    out.set(id, {
      enabled: r.enabled === 1,
      severity: r.severity,
      threshold: parseThreshold(r.threshold_json),
    });
  }
  return out;
}

/** Text that is safe to store: IBAN-like text masked by the audit masker, leftovers replaced. */
export function safeText(s: string): string {
  const masked = String(maskDeep(s));
  return IBAN_LEFTOVER.test(masked.toUpperCase()) ? "[redacted]" : masked;
}

function payloadOf(issue: DqIssue): string {
  const safe = maskDeep(issue.details) as Record<string, unknown>;
  const text = JSON.stringify(safe);
  return text.length <= MAX_PAYLOAD ? text : "{}";
}

interface IssueRow {
  id: number;
  rule_id: string;
  fingerprint: string;
  status: DqExistingIssue["status"];
  snoozed_until: string | null;
}

async function loadExisting(
  db: D1Database,
  divisionId: number,
  ruleIds: readonly string[],
): Promise<DqExistingIssue[]> {
  if (ruleIds.length === 0) return [];
  const marks = ruleIds.map((_, i) => `?${i + 2}`).join(",");
  const rows = (
    await db
      .prepare(
        `SELECT id, rule_id, fingerprint, status, snoozed_until FROM dq_issues
         WHERE division_id = ?1 AND rule_id IN (${marks})`,
      )
      .bind(divisionId, ...ruleIds)
      .all<IssueRow>()
  ).results;
  return rows.map((r) => ({
    id: r.id,
    ruleId: r.rule_id,
    fingerprint: r.fingerprint,
    status: r.status,
    snoozedUntil: r.snoozed_until,
  }));
}

function bindFields(
  i: DqIssue,
  nowIso: string,
): [string, string, string, string, number | null, string | null, string, string] {
  return [
    i.severity,
    safeText(i.subject),
    safeText(i.message),
    i.fix,
    i.amountMinor,
    i.currency,
    payloadOf(i),
    nowIso,
  ];
}

/** The statements that apply a plan for one division (0 = global) at `nowIso`. */
export function planStatements(
  db: D1Database,
  divisionId: number,
  plan: DqReconcilePlan,
  nowIso: string,
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const i of plan.insert) {
    const rule = dqRuleById(i.ruleId);
    if (!rule) continue;
    out.push(
      db
        .prepare(
          `INSERT INTO dq_issues (division_id, rule_id, fingerprint, area, severity, status, subject, message,
             fix, amount_minor, currency, payload_json, first_seen_at, last_seen_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
           ON CONFLICT (division_id, fingerprint) DO UPDATE SET
             severity = excluded.severity, subject = excluded.subject, message = excluded.message,
             fix = excluded.fix, amount_minor = excluded.amount_minor, currency = excluded.currency,
             payload_json = excluded.payload_json, last_seen_at = excluded.last_seen_at
           WHERE dq_issues.status <> 'resolved'`,
        )
        .bind(divisionId, i.ruleId, i.fingerprint, rule.area, ...bindFields(i, nowIso)),
    );
  }
  const refresh = `severity = ?2, subject = ?3, message = ?4, fix = ?5, amount_minor = ?6, currency = ?7,
                   payload_json = ?8, last_seen_at = ?9`;
  for (const { id, issue } of plan.refresh) {
    out.push(
      db
        .prepare(`UPDATE dq_issues SET ${refresh} WHERE id = ?1 AND status = 'open'`)
        .bind(id, ...bindFields(issue, nowIso)),
    );
  }
  for (const { id, issue } of plan.keepSnoozed) {
    out.push(
      db
        .prepare(`UPDATE dq_issues SET ${refresh} WHERE id = ?1 AND status = 'snoozed'`)
        .bind(id, ...bindFields(issue, nowIso)),
    );
  }
  for (const { id, issue } of plan.unsnooze) {
    // notified_at is kept (ADR 0046): an issue is alerted once per life (reopen count); the end of a
    // snooze is not a new life, and its alert key already exists.
    out.push(
      db
        .prepare(
          `UPDATE dq_issues SET ${refresh}, status = 'open', snoozed_until = NULL, snoozed_by = NULL,
             snooze_note = NULL
           WHERE id = ?1 AND status = 'snoozed'`,
        )
        .bind(id, ...bindFields(issue, nowIso)),
    );
  }
  for (const { id, issue } of plan.reopen) {
    // The explicit reopen path: reopen_count goes up by one in the same statement (trigger).
    out.push(
      db
        .prepare(
          `UPDATE dq_issues SET ${refresh}, status = 'open', resolved_at = NULL, resolved_by = NULL,
             resolution_note = NULL, reopen_count = reopen_count + 1, notified_at = NULL
           WHERE id = ?1 AND status = 'resolved'`,
        )
        .bind(id, ...bindFields(issue, nowIso)),
    );
  }
  for (const id of plan.resolve) {
    out.push(
      db
        .prepare(
          `UPDATE dq_issues SET status = 'resolved', resolved_at = ?2, resolved_by = 'system',
             resolution_note = NULL, snoozed_until = NULL, snoozed_by = NULL, snooze_note = NULL
           WHERE id = ?1 AND status IN ('open', 'snoozed')`,
        )
        .bind(id, nowIso),
    );
  }
  return out;
}

async function runChunks(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK));
  }
}

export interface DivisionOutcome {
  newIssues: number;
  refreshed: number;
  reopened: number;
  unsnoozed: number;
  resolved: number;
}

/**
 * Reconciles the results of one pass (one division, or the global pass with id 0) with the stored
 * issues and records the status of every rule. Safe to repeat: the second call finds the issues
 * already stored and only moves last_seen.
 */
export async function applyResults(
  db: D1Database,
  divisionId: number,
  results: readonly DqRuleResult[],
  nowIso: string,
  runId: number | null,
): Promise<DivisionOutcome> {
  const existing = await loadExisting(
    db,
    divisionId,
    results.map((r) => r.ruleId),
  );
  const plan = planReconcile(existing, results, nowIso);
  await runChunks(db, planStatements(db, divisionId, plan, nowIso));
  const statusRows = results.map((r) =>
    db
      .prepare(
        `INSERT INTO dq_rule_status (division_id, rule_id, status, reason, checked, issue_count, evaluated_at, run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (division_id, rule_id) DO UPDATE SET status = excluded.status, reason = excluded.reason,
           checked = excluded.checked, issue_count = excluded.issue_count,
           evaluated_at = excluded.evaluated_at, run_id = excluded.run_id`,
      )
      .bind(
        divisionId,
        r.ruleId,
        r.status,
        r.status === "ok" || r.status === "issues" ? null : (r.reason ?? "unknown"),
        r.checked,
        r.status === "ok" || r.status === "issues" ? r.total : 0,
        nowIso,
        runId,
      ),
  );
  await runChunks(db, statusRows);
  const c = planCounts(plan);
  return { ...c };
}

export interface RunSummary {
  jobRunId: number;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "partial" | "error";
  divisions: number;
  rulesEvaluated: number;
  rulesUnavailable: number;
  outcome: DivisionOutcome;
  errorCode: string | null;
}

/** Writes (or updates) the run row, the audit row of the run, and prunes old resolved issues. */
export async function recordRun(db: D1Database, s: RunSummary): Promise<number> {
  const open =
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM dq_issues WHERE status = 'open'")
        .first<{ n: number }>()
    )?.n ?? 0;
  const cutoff = new Date(
    Date.parse(s.finishedAt) - RESOLVED_RETENTION_DAYS * 86_400_000,
  ).toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO dq_runs (job_run_id, started_at, finished_at, status, divisions, rules_evaluated,
           rules_unavailable, new_issues, reopened_issues, resolved_issues, open_issues, engine_version, error_code)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (job_run_id) DO UPDATE SET finished_at = excluded.finished_at, status = excluded.status,
           divisions = excluded.divisions, rules_evaluated = excluded.rules_evaluated,
           rules_unavailable = excluded.rules_unavailable, new_issues = excluded.new_issues,
           reopened_issues = excluded.reopened_issues, resolved_issues = excluded.resolved_issues,
           open_issues = excluded.open_issues, engine_version = excluded.engine_version,
           error_code = excluded.error_code`,
      )
      .bind(
        s.jobRunId,
        s.startedAt,
        s.finishedAt,
        s.status,
        s.divisions,
        s.rulesEvaluated,
        s.rulesUnavailable,
        s.outcome.newIssues,
        s.outcome.reopened,
        s.outcome.resolved,
        open,
        DQ_ENGINE_VERSION,
        s.errorCode,
      ),
    db.prepare("DELETE FROM dq_issues WHERE status = 'resolved' AND resolved_at < ?1").bind(cutoff),
    ...(s.outcome.newIssues + s.outcome.reopened + s.outcome.resolved > 0
      ? [
          // One audit row per run that changed anything (a quiet run adds none).
          auditStatement(db, {
            actorEmail: "system",
            action: "dq.run",
            entity: "dq_run",
            entityId: s.jobRunId,
            after: {
              status: s.status,
              divisions: s.divisions,
              rulesEvaluated: s.rulesEvaluated,
              rulesUnavailable: s.rulesUnavailable,
              ...s.outcome,
            },
          }),
        ]
      : []),
  ]);
  const row = await db
    .prepare("SELECT id FROM dq_runs WHERE job_run_id = ?1")
    .bind(s.jobRunId)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

/**
 * Housekeeping (D8a review, ADR 0046): the open and snoozed issues of administrations that are no
 * longer synchronised (sync switched off, connection disabled or removed) are resolved with reason
 * `division_not_synchronised`, but only after a GRACE period of UNSYNCED_GRACE_DAYS without
 * synchronisation. "Disabled" is also what a failed re-authorisation leaves behind (the callback
 * fails closed), and an admin may switch an administration off for an hour: resolving at once would
 * throw away snoozes and notes and, when the administration comes back, reopen every issue with a new
 * reopen count, so each critical one would be alerted AGAIN. The first time a division is seen
 * unsynchronised is kept in setting `dq.unsynced_since`; a division that is synchronised again
 * leaves the map. Until the grace has passed only its rule status rows are removed (they vouch for
 * nothing now: no instant alert goes out for that administration). Global issues (division 0) are
 * never touched. One audit row (count only) per resolving pass.
 */
export const UNSYNCED_REASON = "division_not_synchronised";
export const UNSYNCED_GRACE_DAYS = 7;
export const SETTING_UNSYNCED_SINCE = "dq.unsynced_since";
const MAX_UNSYNCED = 50;

function parseSince(json: string | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (json === undefined) return out;
  try {
    const v: unknown = JSON.parse(json);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [k, at] of Object.entries(v as Record<string, unknown>)) {
      if (/^[1-9]\d{0,12}$/.test(k) && typeof at === "string" && !Number.isNaN(Date.parse(at))) {
        out.set(Number(k), at);
      }
    }
  } catch {
    // unreadable: start the grace again (the safe direction)
  }
  return out;
}

export async function resolveUnsyncedDivisions(
  db: D1Database,
  activeDivisionIds: readonly number[],
  nowIso: string,
): Promise<number> {
  const ids = [...activeDivisionIds];
  const notIn = (from: number): string =>
    ids.length > 0 ? `AND division_id NOT IN (${ids.map((_, i) => `?${i + from}`).join(",")})` : "";
  const unsynced = (
    await db
      .prepare(
        `SELECT DISTINCT division_id AS d FROM dq_issues
         WHERE division_id > 0 ${notIn(1)} AND status IN ('open', 'snoozed')
         ORDER BY division_id LIMIT ${MAX_UNSYNCED}`,
      )
      .bind(...ids)
      .all<{ d: number }>()
  ).results.map((r) => r.d);
  await db
    .prepare(`DELETE FROM dq_rule_status WHERE division_id > 0 ${notIn(1)}`)
    .bind(...ids)
    .run();

  const row = await db
    .prepare("SELECT value_json FROM settings WHERE key = ?1")
    .bind(SETTING_UNSYNCED_SINCE)
    .first<{ value_json: string }>();
  const before = parseSince(row?.value_json);
  const since = new Map<number, string>();
  for (const d of unsynced) since.set(d, before.get(d) ?? nowIso);
  const nowMs = Date.parse(nowIso);
  const due = unsynced.filter(
    (d) => nowMs - Date.parse(since.get(d) ?? nowIso) >= UNSYNCED_GRACE_DAYS * 86_400_000,
  );
  for (const d of due) since.delete(d);

  const sinceJson = JSON.stringify(Object.fromEntries([...since].sort((a, b) => a[0] - b[0])));
  const writeSince = db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES (?1, ?2, 'system', ?3)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = 'system',
         updated_at = excluded.updated_at
       WHERE settings.value_json IS NOT excluded.value_json`,
    )
    .bind(SETTING_UNSYNCED_SINCE, sinceJson, nowIso);
  if (due.length === 0) {
    if (row !== null || since.size > 0) await writeSince.run();
    return 0;
  }
  const inDue = due.map((_, i) => `?${i + 2}`).join(",");
  const count =
    (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM dq_issues
           WHERE division_id IN (${due.map((_, i) => `?${i + 1}`).join(",")}) AND status IN ('open', 'snoozed')`,
        )
        .bind(...due)
        .first<{ n: number }>()
    )?.n ?? 0;
  const out = await db.batch([
    db
      .prepare(
        `UPDATE dq_issues SET status = 'resolved', resolved_at = ?1, resolved_by = 'system',
           resolution_note = '${UNSYNCED_REASON}', snoozed_until = NULL, snoozed_by = NULL, snooze_note = NULL
         WHERE division_id IN (${inDue}) AND status IN ('open', 'snoozed')`,
      )
      .bind(nowIso, ...due),
    auditStatement(
      db,
      {
        actorEmail: "system",
        action: "dq.unsynced_resolved",
        entity: "dq_issue",
        after: {
          reason: UNSYNCED_REASON,
          issues: count,
          divisions: due.length,
          graceDays: UNSYNCED_GRACE_DAYS,
        },
      },
      { sql: "changes() > 0", binds: [] },
    ),
    writeSince,
  ]);
  return out[0]?.meta.changes ?? 0;
}
