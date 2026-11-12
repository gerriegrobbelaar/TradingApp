/**
 * The e-mail ledger (migration 0027, ADR 0046): claim, then send, then record the answer.
 *
 *  claim     INSERT (idempotency key unique) BEFORE the provider is called. Only the writer whose insert
 *            changed a row may send. Callers that tie the claim to other data (an issue's notified_at)
 *            build their own batch with `claimInsert`.
 *  deliver   calls the sender and records the answer. A sender that throws, or a record that cannot be
 *            written, leaves the row 'claimed'; `sweepStaleClaims` turns it into 'unknown'. An unknown
 *            e-mail is never sent again.
 *  reclaim   only a 'failed' row (the provider definitely refused it) may be claimed again, at most
 *            MAX_EMAIL_ATTEMPTS times in total.
 *
 * The log holds no address, subject or body: kind, template id, recipient count, status, provider
 * message id and an error code.
 */
import {
  EMAIL_LOG_RETENTION_DAYS,
  EMAIL_TEMPLATES,
  MAX_EMAIL_ATTEMPTS,
  STALE_CLAIM_MS,
  type EmailKind,
  type EmailMessage,
  type EmailSendResult,
} from "@camelthorn/core";
import { auditStatement } from "../db/audit";
import type { EmailSender } from "./sender";

export interface ClaimSpec {
  key: string;
  kind: EmailKind;
  recipients: number;
  issueId?: number | null;
}

/** INSERT of the claim row; with `onlyIf` the row is written only while that condition holds. */
export function claimInsert(
  db: D1Database,
  spec: ClaimSpec,
  nowIso: string,
  onlyIf?: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  const base = 6;
  const cond = onlyIf
    ? onlyIf.sql.replace(/\?(\d+)/g, (_m, n: string) => `?${Number(n) + base}`)
    : "1";
  return db
    .prepare(
      `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, attempts,
         dq_issue_id, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, 'claimed', 1, ?5, ?6, ?6
       WHERE ${cond}
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(
      spec.key,
      spec.kind,
      EMAIL_TEMPLATES[spec.kind],
      spec.recipients,
      spec.issueId ?? null,
      nowIso,
      ...(onlyIf?.binds ?? []),
    );
}

/** Audit row for a claim, written only when the previous statement changed exactly `n` rows. */
export function claimAudit(
  db: D1Database,
  spec: ClaimSpec,
  actor: string,
  atLeastOne = false,
): D1PreparedStatement {
  return auditStatement(
    db,
    {
      actorEmail: actor,
      action: "email.claimed",
      entity: "email_log",
      entityId: spec.key,
      after: { kind: spec.kind, template: EMAIL_TEMPLATES[spec.kind], recipients: spec.recipients },
    },
    { sql: atLeastOne ? "changes() >= 1" : "changes() = 1", binds: [] },
  );
}

/** Plain claim (digest, test): true when this caller won the key (and `onlyIf` held). */
export async function claimPlain(
  db: D1Database,
  spec: ClaimSpec,
  nowIso: string,
  actor = "system",
  onlyIf?: { sql: string; binds: unknown[] },
): Promise<boolean> {
  const out = await db.batch([claimInsert(db, spec, nowIso, onlyIf), claimAudit(db, spec, actor)]);
  return (out[0]?.meta.changes ?? 0) === 1;
}

/** A refused ('failed') e-mail may be claimed again; true when this caller won the retry. */
export async function reclaimFailed(db: D1Database, key: string, nowIso: string): Promise<boolean> {
  const out = await db
    .prepare(
      `UPDATE email_log SET status = 'claimed', attempts = attempts + 1, error_code = NULL, updated_at = ?2
       WHERE idempotency_key = ?1 AND status = 'failed' AND attempts < ?3`,
    )
    .bind(key, nowIso, MAX_EMAIL_ATTEMPTS)
    .run();
  return out.meta.changes === 1;
}

export async function finishEmail(
  db: D1Database,
  key: string,
  r: EmailSendResult,
  nowIso: string,
): Promise<void> {
  const status = r.status;
  const id = r.status === "sent" ? r.providerMessageId : null;
  const code =
    r.status === "failed" || r.status === "unknown"
      ? r.code
      : r.status === "skipped_not_configured"
        ? "not_configured"
        : null;
  await db
    .prepare(
      `UPDATE email_log SET status = ?2, provider_message_id = ?3, error_code = ?4, updated_at = ?5
       WHERE idempotency_key = ?1 AND status = 'claimed'`,
    )
    .bind(
      key,
      status,
      id,
      code === null ? null : code.replace(/[^a-z0-9_]/g, "_").slice(0, 64),
      nowIso,
    )
    .run();
}

/** Sends a CLAIMED e-mail and records the answer. Never throws. */
export async function deliver(
  db: D1Database,
  sender: EmailSender,
  key: string,
  msg: EmailMessage,
  nowIso: string,
): Promise<EmailSendResult> {
  let result: EmailSendResult;
  try {
    result = await sender.send(msg);
  } catch {
    result = { status: "unknown", code: "sender_threw" };
  }
  try {
    await finishEmail(db, key, result, nowIso);
  } catch {
    // The row stays 'claimed'; the sweep makes it 'unknown'. Never send again.
  }
  return result;
}

/** A claim older than STALE_CLAIM_MS never got an answer: unknown, and never sent again. */
export async function sweepStaleClaims(db: D1Database, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - STALE_CLAIM_MS).toISOString();
  const out = await db
    .prepare(
      `UPDATE email_log SET status = 'unknown', error_code = 'claim_stale', updated_at = ?1
       WHERE status = 'claimed' AND updated_at < ?2`,
    )
    .bind(new Date(nowMs).toISOString(), cutoff)
    .run();
  return out.meta.changes;
}

/** Retention (ADR 0046): rows older than 400 days go; the delete trigger protects younger ones. */
export async function pruneEmailLog(db: D1Database, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - EMAIL_LOG_RETENTION_DAYS * 86_400_000).toISOString();
  const out = await db.prepare("DELETE FROM email_log WHERE created_at < ?1").bind(cutoff).run();
  return out.meta.changes;
}

/** One row per key and day that says why nothing was sent. Does not touch what it is about. */
export async function recordSkipped(
  db: D1Database,
  key: string,
  kind: EmailKind,
  recipients: number,
  reason: "not_configured" | "no_recipients",
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, attempts,
         error_code, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'skipped_not_configured', 1, ?5, ?6, ?6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(key, kind, EMAIL_TEMPLATES[kind], recipients, reason, nowIso)
    .run();
}
