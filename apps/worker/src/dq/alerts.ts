/**
 * Instant alerts for critical data quality issues (ADR 0046), run by `dq.checks` after the issues
 * have been reconciled.
 *
 * An issue is alerted once per life: critical, open (never snoozed), notified_at IS NULL (new or
 * reopened: the reconcile clears it on reopen) and its rule's last status is `issues` (a rule that is
 * not_available, not_configured, disabled or failed vouches for nothing). CLAIM THEN SEND:
 *
 *  1. one D1 batch inserts the email_log row (unique key `dq-alert:<issue row id>:<reopen count>`),
 *     sets dq_issues.notified_at and writes the audit row, all conditional on the same facts, so two
 *     concurrent runs cannot both win;
 *  2. only the winner calls the sender; the answer is recorded;
 *  3. a crash between 1 and 2 leaves a stale claim that becomes `unknown` and is never sent again
 *     (a missing alert is visible in the log, a flood of duplicates is not acceptable); a definite
 *     refusal (`failed`) is retried by a later run, at most three attempts in total.
 *
 * At most `maxAlertsPerRun` mails (retries and single alerts together) go out per run; everything
 * else that is pending is claimed together and sent as ONE summary alert that lists ten and states
 * the total. A summary the provider refuses gives its issues back (notified_at cleared), so the next
 * run tries again; a 429 (rate limit) ends the run's sending at once, and sends are spaced. A
 * fingerprint is alerted at most once per 24 hours (the rest is left to the digest). With no sender
 * configured nothing is claimed and `notified_at` stays NULL, so enabling the sender later alerts
 * the issues that are still open; one `skipped_not_configured` row per day records that alerts were
 * pending.
 */
import {
  DQ_FIX_PATHS,
  MAX_EMAIL_ATTEMPTS,
  DQ_HEALTH_PATH,
  alertKey,
  legacyAlertKey,
  alertSkippedKey,
  alertSummaryKey,
  amsterdamParts,
  dqRuleById,
  renderAlert,
  renderAlertSummary,
  type DqArea,
  type DqFixTarget,
  type EmailSendResult,
} from "@camelthorn/core";
import {
  claimAudit,
  claimInsert,
  deliver,
  finishEmail,
  pruneEmailLog,
  recordSkipped,
  reclaimFailed,
  sweepStaleClaims,
} from "../email/log";
import { senderFromSettings, type EmailSender } from "../email/sender";
import type { JobContext } from "../jobs/types";
import { loadNotificationSettings, loadRecipients } from "./notify-settings";
import { safeText } from "./store";

/** Issue ids per D1 statement (D1 allows 100 bound parameters). */
export const ID_CHUNK = 80;
const MAX_CANDIDATES = 1000;
const MAX_RETRIES = 20;
/** A refused alert is retried no sooner than this after its last attempt. */
export const RETRY_BACKOFF_MS = 15 * 60_000;
/** The same fingerprint is alerted at most once in this time; the daily digest covers the rest. */
export const ALERT_COOLDOWN_MS = 24 * 3_600_000;

export interface AlertOutcome {
  /** Notifications are switched off in the settings. */
  disabled: boolean;
  candidates: number;
  /** Single alerts claimed by this run (a claim is not a delivery: see `sent`). */
  alerted: number;
  /** Mails the provider accepted in this run (singles, retries and the summary). */
  sent: number;
  folded: number;
  summaries: number;
  retried: number;
  failed: number;
  unknown: number;
  /** Alerts left to the digest because the same fingerprint was alerted in the last 24 hours. */
  suppressed: number;
  /** The provider answered 429: sending stopped for this run. */
  rateLimited: boolean;
  /** Claims another run won first (no send here). */
  lostClaims: number;
  staleSwept: number;
  skipped: "not_configured" | "no_recipients" | null;
}

const emptyOutcome = (): AlertOutcome => ({
  disabled: false,
  candidates: 0,
  alerted: 0,
  sent: 0,
  folded: 0,
  summaries: 0,
  retried: 0,
  failed: 0,
  unknown: 0,
  suppressed: 0,
  rateLimited: false,
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
  /** Test seam for the pause between sends; production waits for real. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
                     WHERE l.idempotency_key = 'dq-alert:' || dq_issues.id || ':' || dq_issues.reopen_count
                        -- Keys written before review V1 (fingerprint based): only for the same issue row,
                        -- so an upgrade does not re-alert and a shared fingerprint is not mistaken.
                        OR (l.idempotency_key = 'dq-alert:' || dq_issues.fingerprint || ':' || dq_issues.reopen_count
                            AND l.dq_issue_id = dq_issues.id))`,
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
        // A refusal is not retried before RETRY_BACKOFF_MS has passed (a rate limit needs room).
        `SELECT l.idempotency_key AS k, l.dq_issue_id AS id FROM email_log l
           JOIN dq_issues i ON i.id = l.dq_issue_id
           JOIN dq_rule_status s ON s.division_id = i.division_id AND s.rule_id = i.rule_id
         WHERE l.kind = 'dq_alert' AND l.status = 'failed' AND l.attempts < ?1 AND ${PENDING_WHERE}
           AND l.updated_at <= ?2
           AND l.idempotency_key IN ('dq-alert:' || i.id || ':' || i.reopen_count,
                                     'dq-alert:' || i.fingerprint || ':' || i.reopen_count)
         ORDER BY l.id LIMIT ${MAX_RETRIES}`,
      )
      .bind(MAX_EMAIL_ATTEMPTS, new Date(nowMs - RETRY_BACKOFF_MS).toISOString())
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

  // Cooldown (N2): a critical whose fingerprint was alerted in the last 24 hours (a flapping issue
  // that resolves and reopens) is marked as handled without a mail; the digest still lists it. Only
  // for a rule that was really evaluated, and only after the sender is known to work.
  const cooled = await db
    .prepare(
      `UPDATE dq_issues SET notified_at = ?1
       WHERE notified_at IS NULL AND status = 'open' AND severity = 'critical'
         AND EXISTS (SELECT 1 FROM dq_rule_status s WHERE s.division_id = dq_issues.division_id
                       AND s.rule_id = dq_issues.rule_id AND s.status = 'issues')
         AND EXISTS (SELECT 1 FROM email_log l JOIN dq_issues j ON j.id = l.dq_issue_id
                     WHERE l.kind = 'dq_alert'
                       AND l.status IN ('claimed', 'sent', 'delivered', 'bounced', 'unknown')
                       AND l.created_at > ?2
                       AND j.fingerprint = dq_issues.fingerprint AND j.division_id = dq_issues.division_id)`,
    )
    .bind(nowIso, new Date(nowMs - ALERT_COOLDOWN_MS).toISOString())
    .run();
  out.suppressed = cooled.meta.changes;
  const cooledIds = new Set<number>();
  if (out.suppressed > 0) {
    const marked = (
      await db
        .prepare("SELECT id FROM dq_issues WHERE notified_at = ?1 AND severity = 'critical'")
        .bind(nowIso)
        .all<{ id: number }>()
    ).results;
    for (const m of marked) cooledIds.add(m.id);
  }

  const sleep = deps.sleep ?? realSleep;
  /** True once a rate limit answered: nothing more is sent in this run. */
  let stop = false;
  let mails = 0;
  const tally = (r: { status: string; code?: string }): void => {
    if (r.status === "sent") out.sent += 1;
    else if (r.status === "failed") {
      out.failed += 1;
      if (r.code === "http_429") {
        stop = true;
        out.rateLimited = true;
      }
    } else if (r.status === "unknown") out.unknown += 1;
  };
  /** Delivers a CLAIMED message, spaced from the previous one. */
  const dispatch = async (
    key: string,
    msg: { subject: string; html: string; text: string },
  ): Promise<EmailSendResult> => {
    const spacing = sender.spacingMs ?? 0;
    if (mails > 0 && spacing > 0) await sleep(spacing);
    mails += 1;
    const r = await deliver(db, sender, key, { to, ...msg }, new Date(ctx.now()).toISOString());
    tally(r);
    return r;
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
    await dispatch(key, msg);
  };

  // 1. Definite refusals from earlier runs, while the issue is still a pending critical.
  for (const rk of retryKeys) {
    if (ctx.signal.aborted) return out;
    if (stop || out.retried >= settings.maxAlertsPerRun) break;
    const row = await db
      .prepare(`${SELECT_ISSUE} WHERE ${PENDING_WHERE} AND i.id = ?1`)
      .bind(rk.id)
      .first<IssueRow>();
    if (
      row === null ||
      (rk.k !== alertKey(row.id, row.reopen_count) &&
        rk.k !== legacyAlertKey(row.fingerprint, row.reopen_count))
    ) {
      continue;
    }
    if (!(await reclaimFailed(db, rk.k, new Date(ctx.now()).toISOString()))) {
      out.lostClaims += 1;
      continue;
    }
    out.retried += 1;
    await send(row, rk.k);
  }

  // 2. New and reopened criticals: the first N (what the cap leaves after the retries) singly.
  const live = pending.filter((p) => !cooledIds.has(p.id));
  const room = Math.max(0, settings.maxAlertsPerRun - out.retried);
  const single = live.slice(0, room);
  const rest = live.slice(room);
  for (const row of single) {
    if (ctx.signal.aborted) return out;
    if (stop) break;
    const key = alertKey(row.id, row.reopen_count);
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

  // 3. Everything beyond the cap: ONE summary (it lists ten and states the total).
  if (rest.length > 0 && !stop && !ctx.signal.aborted) {
    await sendSummary(rest);
  }

  async function sendSummary(items: IssueRow[]): Promise<void> {
    const key = alertSummaryKey(jobRunId, 0);
    const spec = { key, kind: "dq_alert_summary", recipients: to.length, issueId: null } as const;
    const ids = items.map((c) => c.id);
    const inList = (n: number, from: number): string =>
      Array.from({ length: n }, (_, i) => `?${i + from}`).join(",");
    const first = ids.slice(0, ID_CHUNK);
    // The claim row is written first (only while some of these issues are still pending); the
    // marks follow. A crash in between leaves a claim without marks: the issues stay pending and
    // the next run alerts them.
    const claim = await db.batch([
      claimInsert(db, spec, nowIso, {
        sql: `EXISTS (SELECT 1 FROM dq_issues WHERE id IN (${inList(first.length, 1)}) AND status = 'open'
                AND severity = 'critical' AND notified_at IS NULL)`,
        binds: first,
      }),
      claimAudit(db, spec, "system"),
    ]);
    if ((claim[0]?.meta.changes ?? 0) !== 1) {
      out.lostClaims += 1;
      return;
    }
    const marks: D1PreparedStatement[] = [];
    for (let at = 0; at < ids.length; at += ID_CHUNK) {
      const part = ids.slice(at, at + ID_CHUNK);
      marks.push(
        db
          .prepare(
            `UPDATE dq_issues SET notified_at = ?1
             WHERE id IN (${inList(part.length, 2)}) AND notified_at IS NULL AND status = 'open'
               AND severity = 'critical'
             RETURNING id`,
          )
          .bind(nowIso, ...part),
      );
    }
    const marked = await db.batch(marks);
    // Only the issues THIS claim marked are in the message: one another run marked in between was
    // (or will be) alerted by that run.
    const mine = new Set(
      marked.flatMap((m) => ((m.results ?? []) as { id: number }[]).map((r) => r.id)),
    );
    const claimed = items.filter((c) => mine.has(c.id));
    if (claimed.length === 0) {
      await finishEmail(db, key, { status: "failed", code: "nothing_to_send" }, nowIso);
      return;
    }
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
    const r = await dispatch(key, msg);
    if (r.status === "failed") {
      // Definitely refused: give the issues back so a later run sends them again (the summary key
      // is per run, so this does not collide). `unknown` is never undone.
      const undo: D1PreparedStatement[] = [];
      const cids = claimed.map((c) => c.id);
      for (let at = 0; at < cids.length; at += ID_CHUNK) {
        const part = cids.slice(at, at + ID_CHUNK);
        undo.push(
          db
            .prepare(
              `UPDATE dq_issues SET notified_at = NULL
               WHERE id IN (${inList(part.length, 2)}) AND notified_at = ?1`,
            )
            .bind(nowIso, ...part),
        );
      }
      await db.batch(undo);
    }
  }

  // Housekeeping that belongs to the log, once per run (cheap, indexed).
  await pruneEmailLog(db, nowMs);
  return out;
}
