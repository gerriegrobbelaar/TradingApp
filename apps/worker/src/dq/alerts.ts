/**
 * Instant alerts for critical data quality issues (ADR 0046), run by `dq.checks` after the issues
 * have been reconciled.
 *
 * An issue is alerted once per life: critical, open (never snoozed), notified_at IS NULL (new or
 * reopened: the reconcile clears it on reopen) and its rule's last status is `issues` (a rule that is
 * not_available, not_configured, disabled or failed vouches for nothing). CLAIM THEN SEND:
 *
 *  1. one D1 batch inserts the email_log row (unique key `dq-alert:<fingerprint>:<reopen count>`),
 *     sets dq_issues.notified_at and writes the audit row, all conditional on the same facts, so two
 *     concurrent runs cannot both win;
 *  2. only the winner calls the sender; the answer is recorded;
 *  3. a crash between 1 and 2 leaves a stale claim that becomes `unknown` and is never sent again
 *     (a missing alert is visible in the log, a flood of duplicates is not acceptable); a definite
 *     refusal (`failed`) is retried by a later run, at most three attempts in total.
 *
 * At most `maxAlertsPerRun` single alerts go out per run; the rest are claimed together and sent as
 * summary alerts (80 issues per summary). With no sender configured nothing is claimed and
 * `notified_at` stays NULL, so enabling the sender later alerts the issues that are still open; one
 * `skipped_not_configured` row per day records that alerts were pending.
 */
import {
  DQ_FIX_PATHS,
  MAX_EMAIL_ATTEMPTS,
  DQ_HEALTH_PATH,
  alertKey,
  alertSkippedKey,
  alertSummaryKey,
  amsterdamParts,
  dqRuleById,
  renderAlert,
  renderAlertSummary,
  type DqArea,
  type DqFixTarget,
} from "@camelthorn/core";
import {
  claimAudit,
  claimInsert,
  deliver,
  pruneEmailLog,
  recordSkipped,
  reclaimFailed,
  sweepStaleClaims,
} from "../email/log";
import { senderFromSettings, type EmailSender } from "../email/sender";
import type { JobContext } from "../jobs/types";
import { loadNotificationSettings, loadRecipients } from "./notify-settings";
import { safeText } from "./store";

export const SUMMARY_CHUNK = 80;
const MAX_CANDIDATES = 1000;
const MAX_RETRIES = 20;

export interface AlertOutcome {
  /** Notifications are switched off in the settings. */
  disabled: boolean;
  candidates: number;
  alerted: number;
  folded: number;
  summaries: number;
  retried: number;
  failed: number;
  unknown: number;
  /** Claims another run won first (no send here). */
  lostClaims: number;
  staleSwept: number;
  skipped: "not_configured" | "no_recipients" | null;
}

const emptyOutcome = (): AlertOutcome => ({
  disabled: false,
  candidates: 0,
  alerted: 0,
  folded: 0,
  summaries: 0,
  retried: 0,
  failed: 0,
  unknown: 0,
  lostClaims: 0,
  staleSwept: 0,
  skipped: null,
});

interface IssueRow {
  id: number;
  rule_id: string;
  fingerprint: string;
  area: string;
  subject: string;
  message: string;
  fix: string;
  reopen_count: number;
  first_seen_at: string;
}

const PENDING_WHERE = `i.status = 'open' AND i.severity = 'critical' AND s.status = 'issues'`;
const SELECT_ISSUE = `SELECT i.id, i.rule_id, i.fingerprint, i.area, i.subject, i.message, i.fix,
  i.reopen_count, i.first_seen_at FROM dq_issues i
  JOIN dq_rule_status s ON s.division_id = i.division_id AND s.rule_id = i.rule_id`;

export interface AlertDeps {
  /** Test seam; production builds the sender from the settings and the secret. */
  sender?: EmailSender;
}

export async function runAlerts(
  ctx: JobContext,
  jobRunId: number,
  deps: AlertDeps = {},
): Promise<AlertOutcome> {
  const db = ctx.env.DB;
  const out = emptyOutcome();
  const nowMs = ctx.now();
  const nowIso = new Date(nowMs).toISOString();
  const { settings } = await loadNotificationSettings(db);
  if (!settings.enabled) return { ...out, disabled: true };

  out.staleSwept = await sweepStaleClaims(db, nowMs);

  // An issue whose alert key for this life already exists was alerted (or tried) before: it is
  // marked, never alerted twice. Without this an issue that lost its notified_at by another path
  // would keep a single-alert slot for ever (its claim always conflicts) and starve new issues.
  await db
    .prepare(
      `UPDATE dq_issues SET notified_at = ?1
       WHERE notified_at IS NULL AND status = 'open' AND severity = 'critical'
         AND EXISTS (SELECT 1 FROM email_log l
                     WHERE l.idempotency_key = 'dq-alert:' || dq_issues.fingerprint || ':' || dq_issues.reopen_count)`,
    )
    .bind(nowIso)
    .run();

  const pending = (
    await db
      .prepare(
        `${SELECT_ISSUE} WHERE ${PENDING_WHERE} AND i.notified_at IS NULL
         ORDER BY i.first_seen_at, i.id LIMIT ${MAX_CANDIDATES}`,
      )
      .all<IssueRow>()
  ).results;
  const retryKeys = (
    await db
      .prepare(
        // Only refusals whose issue is still a pending critical in the same life: a refusal for an
        // issue that was resolved, or reopened under a new key, must not hold a retry slot for ever.
        `SELECT l.idempotency_key AS k, l.dq_issue_id AS id FROM email_log l
           JOIN dq_issues i ON i.id = l.dq_issue_id
           JOIN dq_rule_status s ON s.division_id = i.division_id AND s.rule_id = i.rule_id
         WHERE l.kind = 'dq_alert' AND l.status = 'failed' AND l.attempts < ?1 AND ${PENDING_WHERE}
           AND l.idempotency_key = 'dq-alert:' || i.fingerprint || ':' || i.reopen_count
         ORDER BY l.id LIMIT ${MAX_RETRIES}`,
      )
      .bind(MAX_EMAIL_ATTEMPTS)
      .all<{ k: string; id: number }>()
  ).results;
  out.candidates = pending.length;
  if (pending.length === 0 && retryKeys.length === 0) return out;

  const sender = deps.sender ?? ctx.emailSender ?? senderFromSettings(ctx.env, settings);
  const recipients = await loadRecipients(db, ctx.env.ALLOWED_HD, settings.alertRecipients);
  if (sender.kind === "disabled" || recipients.length === 0) {
    out.skipped = sender.kind === "disabled" ? "not_configured" : "no_recipients";
    await recordSkipped(
      db,
      alertSkippedKey(amsterdamParts(nowMs).date),
      "dq_alert",
      recipients.length,
      out.skipped,
      nowIso,
    );
    return out;
  }
  const to = recipients.map((r) => r.email);

  const tally = (status: string): void => {
    if (status === "failed") out.failed += 1;
    else if (status === "unknown") out.unknown += 1;
  };
  const send = async (row: IssueRow, key: string): Promise<void> => {
    const rule = dqRuleById(row.rule_id);
    const fixPath = Object.hasOwn(DQ_FIX_PATHS, row.fix)
      ? DQ_FIX_PATHS[row.fix as DqFixTarget]
      : "/";
    const msg = renderAlert(
      {
        ruleTitle: rule?.title ?? row.rule_id,
        area: rule?.area ?? (row.area as DqArea),
        subject: safeText(row.subject),
        message: safeText(row.message),
        fixPath,
        reopenCount: row.reopen_count,
        firstSeenAt: row.first_seen_at,
      },
      settings.baseUrl,
    );
    const r = await deliver(db, sender, key, { to, ...msg }, new Date(ctx.now()).toISOString());
    tally(r.status);
  };

  // 1. Definite refusals from earlier runs, while the issue is still a pending critical.
  for (const rk of retryKeys) {
    if (ctx.signal.aborted) return out;
    const row = await db
      .prepare(`${SELECT_ISSUE} WHERE ${PENDING_WHERE} AND i.id = ?1`)
      .bind(rk.id)
      .first<IssueRow>();
    if (row === null || alertKey(row.fingerprint, row.reopen_count) !== rk.k) continue;
    if (!(await reclaimFailed(db, rk.k, new Date(ctx.now()).toISOString()))) {
      out.lostClaims += 1;
      continue;
    }
    out.retried += 1;
    await send(row, rk.k);
  }

  // 2. New and reopened criticals: the first N singly, the rest folded into summaries.
  const single = pending.slice(0, settings.maxAlertsPerRun);
  const rest = pending.slice(settings.maxAlertsPerRun);
  for (const row of single) {
    if (ctx.signal.aborted) return out;
    const key = alertKey(row.fingerprint, row.reopen_count);
    const spec = { key, kind: "dq_alert", recipients: to.length, issueId: row.id } as const;
    const res = await db.batch([
      claimInsert(db, spec, nowIso, {
        sql: `EXISTS (SELECT 1 FROM dq_issues WHERE id = ?1 AND status = 'open' AND severity = 'critical'
                AND notified_at IS NULL AND reopen_count = ?2)`,
        binds: [row.id, row.reopen_count],
      }),
      db
        .prepare(
          `UPDATE dq_issues SET notified_at = ?2
           WHERE id = ?1 AND notified_at IS NULL AND status = 'open' AND changes() = 1`,
        )
        .bind(row.id, nowIso),
      claimAudit(db, spec, "system"),
    ]);
    if ((res[0]?.meta.changes ?? 0) !== 1) {
      out.lostClaims += 1;
      continue;
    }
    out.alerted += 1;
    await send(row, key);
  }

  for (let n = 0; n * SUMMARY_CHUNK < rest.length; n += 1) {
    if (ctx.signal.aborted) return out;
    const chunk = rest.slice(n * SUMMARY_CHUNK, (n + 1) * SUMMARY_CHUNK);
    const key = alertSummaryKey(jobRunId, n);
    const spec = { key, kind: "dq_alert_summary", recipients: to.length, issueId: null } as const;
    const ids = chunk.map((c) => c.id);
    const inList = (from: number): string => ids.map((_, i) => `?${i + from}`).join(",");
    const res = await db.batch([
      claimInsert(db, spec, nowIso, {
        sql: `EXISTS (SELECT 1 FROM dq_issues WHERE id IN (${inList(1)}) AND status = 'open'
                AND severity = 'critical' AND notified_at IS NULL)`,
        binds: ids,
      }),
      db
        .prepare(
          `UPDATE dq_issues SET notified_at = ?1
           WHERE id IN (${inList(2)}) AND notified_at IS NULL AND status = 'open' AND changes() = 1
           RETURNING id`,
        )
        .bind(nowIso, ...ids),
      claimAudit(db, spec, "system", true),
    ]);
    if ((res[0]?.meta.changes ?? 0) !== 1) {
      out.lostClaims += 1;
      continue;
    }
    // Only the issues THIS claim marked are in the message: one another run marked in between was
    // (or will be) alerted by that run.
    const mine = new Set(((res[1]?.results ?? []) as { id: number }[]).map((r) => r.id));
    const claimed = chunk.filter((c) => mine.has(c.id));
    out.folded += claimed.length;
    out.summaries += 1;
    const msg = renderAlertSummary(
      {
        total: claimed.length,
        items: claimed.map((c) => ({
          ruleTitle: dqRuleById(c.rule_id)?.title ?? c.rule_id,
          subject: safeText(c.subject),
        })),
        listPath: DQ_HEALTH_PATH,
      },
      settings.baseUrl,
    );
    const r = await deliver(db, sender, key, { to, ...msg }, new Date(ctx.now()).toISOString());
    tally(r.status);
  }

  // Housekeeping that belongs to the log, once per run (cheap, indexed).
  await pruneEmailLog(db, nowMs);
  return out;
}
