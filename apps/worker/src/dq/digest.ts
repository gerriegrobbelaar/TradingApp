/**
 * Job `dq.digest` (daily, 08:00 Europe/Amsterdam by default; ADR 0046): one e-mail per recipient with
 * the open issues by severity and area, what is new, the oldest open issue, the ten most important
 * items with fix links, and the rules that were not evaluated (with reasons).
 *
 * Idempotent per recipient and Amsterdam day: key `dq-digest:<date>:<user id>`, claimed before the
 * send. A repeated or overlapping run finds the claims and sends nothing again; a definite refusal
 * (`failed`) is claimed again by the retry, an `unknown` outcome never is. With no sender configured
 * nothing is sent and one `skipped_not_configured` row records the day.
 */
import {
  DQ_AREAS,
  DQ_CHECKS_STALE_MS,
  DQ_FIX_PATHS,
  DQ_RULES,
  amsterdamParts,
  digestKey,
  digestSkippedKey,
  dqRuleById,
  emptyDigest,
  renderDigest,
  type DigestData,
  type DqArea,
  type DqFixTarget,
  type DqSeverity,
} from "@camelthorn/core";
import {
  claimPlain,
  deliver,
  pruneEmailLog,
  reclaimFailed,
  recordSkipped,
  sweepStaleClaims,
} from "../email/log";
import { senderFromSettings, type EmailSender } from "../email/sender";
import type { HandlerResult, JobContext } from "../jobs/types";
import { loadNotificationSettings, loadRecipients } from "./notify-settings";
import { safeText } from "./store";

const DAY_MS = 86_400_000;
const NOT_EVALUATED_CAP = 30;
/** Issues of a rule that an admin switched off are not counted (the same rule as /api/dq/summary). */
const LIVE_RULE = `(SELECT 1 FROM dq_rules r WHERE r.id = dq_issues.rule_id AND r.enabled = 0)`;

export async function loadDigestData(db: D1Database, nowMs: number): Promise<DigestData> {
  const d = emptyDigest(amsterdamParts(nowMs).date);
  const lastRun = await db
    .prepare("SELECT started_at, status FROM dq_runs ORDER BY id DESC LIMIT 1")
    .first<{ started_at: string; status: "ok" | "partial" | "error" }>();
  const lastMs = lastRun === null ? NaN : Date.parse(lastRun.started_at);
  d.checks = {
    lastRunAt: lastRun?.started_at ?? null,
    lastStatus: lastRun?.status ?? null,
    stale: !Number.isFinite(lastMs) || nowMs - lastMs > DQ_CHECKS_STALE_MS,
  };
  const counts = (
    await db
      .prepare(
        `SELECT severity, area, COUNT(*) AS n FROM dq_issues WHERE status = 'open' AND NOT EXISTS ${LIVE_RULE} GROUP BY severity, area`,
      )
      .all<{ severity: DqSeverity; area: DqArea; n: number }>()
  ).results;
  for (const c of counts) {
    if (!(DQ_AREAS as readonly string[]).includes(c.area)) continue;
    d.bySeverity[c.severity] += c.n;
    d.byArea[c.area][c.severity] += c.n;
  }
  d.snoozed =
    (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM dq_issues WHERE status = 'snoozed' AND NOT EXISTS ${LIVE_RULE}`,
        )
        .first<{ n: number }>()
    )?.n ?? 0;
  d.newSinceYesterday =
    (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM dq_issues WHERE status = 'open' AND first_seen_at >= ?1
             AND NOT EXISTS ${LIVE_RULE}`,
        )
        .bind(new Date(nowMs - DAY_MS).toISOString())
        .first<{ n: number }>()
    )?.n ?? 0;
  const oldest = await db
    .prepare(
      `SELECT subject, severity, first_seen_at FROM dq_issues WHERE status = 'open'
         AND NOT EXISTS ${LIVE_RULE}
       ORDER BY first_seen_at, id LIMIT 1`,
    )
    .first<{ subject: string; severity: DqSeverity; first_seen_at: string }>();
  if (oldest !== null) {
    d.oldest = {
      subject: safeText(oldest.subject),
      severity: oldest.severity,
      days: Math.max(0, Math.floor((nowMs - Date.parse(oldest.first_seen_at)) / DAY_MS)),
    };
  }
  const top = (
    await db
      .prepare(
        `SELECT rule_id, area, severity, subject, message, fix FROM dq_issues WHERE status = 'open'
           AND NOT EXISTS ${LIVE_RULE}
         ORDER BY severity_rank DESC, first_seen_at, id LIMIT 10`,
      )
      .all<{
        rule_id: string;
        area: DqArea;
        severity: DqSeverity;
        subject: string;
        message: string;
        fix: string;
      }>()
  ).results;
  d.top = top.map((t) => ({
    severity: t.severity,
    area: t.area,
    ruleTitle: dqRuleById(t.rule_id)?.title ?? t.rule_id,
    subject: safeText(t.subject),
    message: safeText(t.message),
    fixPath: Object.hasOwn(DQ_FIX_PATHS, t.fix) ? DQ_FIX_PATHS[t.fix as DqFixTarget] : "/",
  }));
  const status = (
    await db
      .prepare(
        `SELECT DISTINCT rule_id, reason FROM dq_rule_status
         WHERE status IN ('not_available', 'not_configured', 'error')
           AND NOT EXISTS (SELECT 1 FROM dq_rules r WHERE r.id = dq_rule_status.rule_id AND r.enabled = 0)`,
      )
      .all<{ rule_id: string; reason: string | null }>()
  ).results;
  const order = new Map(DQ_RULES.map((r, i) => [r.id, i]));
  d.notEvaluated = status
    .filter((s) => order.has(s.rule_id))
    .sort(
      (a, b) =>
        (order.get(a.rule_id) ?? 0) - (order.get(b.rule_id) ?? 0) ||
        (a.reason ?? "").localeCompare(b.reason ?? ""),
    )
    .slice(0, NOT_EVALUATED_CAP)
    .map((s) => ({
      ruleTitle: dqRuleById(s.rule_id)?.title ?? s.rule_id,
      reason: s.reason ?? "unknown",
    }));
  return d;
}

export interface DigestDeps {
  sender?: EmailSender;
}

export async function runDigest(ctx: JobContext, deps: DigestDeps = {}): Promise<HandlerResult> {
  const db = ctx.env.DB;
  const nowMs = ctx.now();
  const nowIso = new Date(nowMs).toISOString();
  const { settings } = await loadNotificationSettings(db);
  if (!settings.enabled) {
    return { status: "skipped", code: "notifications_disabled", summary: {} };
  }
  const swept = await sweepStaleClaims(db, nowMs);
  await pruneEmailLog(db, nowMs);

  const date = amsterdamParts(nowMs).date;
  const sender = deps.sender ?? ctx.emailSender ?? senderFromSettings(ctx.env, settings);
  const recipients = await loadRecipients(db, ctx.env.ALLOWED_HD, settings.alertRecipients);
  if (sender.kind === "disabled" || recipients.length === 0) {
    const reason = sender.kind === "disabled" ? "not_configured" : "no_recipients";
    await recordSkipped(db, digestSkippedKey(date), "dq_digest", recipients.length, reason, nowIso);
    return {
      status: "skipped",
      code: reason === "not_configured" ? "email_not_configured" : "no_recipients",
      summary: { recipients: recipients.length, staleSwept: swept },
    };
  }

  const msg = renderDigest(await loadDigestData(db, nowMs), settings.baseUrl);
  let sent = 0;
  let already = 0;
  let failed = 0;
  let unknown = 0;
  for (const r of recipients) {
    if (ctx.signal.aborted) break;
    const key = digestKey(date, r.id);
    const won =
      (await claimPlain(db, { key, kind: "dq_digest", recipients: 1 }, nowIso)) ||
      (await reclaimFailed(db, key, nowIso));
    if (!won) {
      already += 1;
      continue;
    }
    const res = await deliver(
      db,
      sender,
      key,
      { to: [r.email], ...msg },
      new Date(ctx.now()).toISOString(),
    );
    if (res.status === "sent") sent += 1;
    else if (res.status === "failed") failed += 1;
    else unknown += 1;
    // Rate limited: the recipients left are retried by the job retry, not hammered now.
    if (res.status === "failed" && res.code === "http_429") break;
    if (sender.spacingMs) await new Promise((r) => setTimeout(r, sender.spacingMs));
  }
  const summary = {
    recipients: recipients.length,
    sent,
    already,
    failed,
    unknown,
    staleSwept: swept,
  };
  if (failed > 0) {
    return { status: "partial", code: "send_failed", summary, retry: { delaySeconds: 600 } };
  }
  if (unknown > 0) return { status: "partial", code: "send_unknown", summary };
  return { status: "ok", summary };
}
