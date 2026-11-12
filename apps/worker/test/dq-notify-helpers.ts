import type { EmailMessage, EmailSendResult } from "@camelthorn/core";
import { env } from "cloudflare:test";
import type { EmailSender } from "../src/email/sender";
import type { JobContext } from "../src/jobs/types";
import { addUser } from "./helpers";
import { jobContext, NOW } from "./matching-helpers";

export const db = env.DB;
export { NOW };

export interface FakeSender extends EmailSender {
  sent: EmailMessage[];
  /** Number of send() calls, including ones that answered failed or unknown. */
  calls: number;
}

/** A sender that records every message; `answer` decides the result (default: sent). */
export function fakeSender(
  answer: (n: number, msg: EmailMessage) => EmailSendResult | Promise<EmailSendResult> = (n) => ({
    status: "sent",
    providerMessageId: `msg-${n}`,
  }),
): FakeSender {
  const s: FakeSender = {
    kind: "https",
    sent: [],
    calls: 0,
    async send(msg) {
      s.calls += 1;
      s.sent.push(msg);
      return answer(s.calls, msg);
    },
  };
  return s;
}

export const ctxAt = (nowMs: number = NOW, over: Partial<JobContext> = {}): JobContext =>
  jobContext(
    {
      job: { id: 1, name: "dq.checks", handler: "dq.checks", exactBudget: 0 },
      now: () => nowMs,
      ...over,
    },
    env,
  );

let seq = 0;

/** A critical, open, never notified issue whose rule's last verdict is `issues`. */
export async function addCritical(
  over: {
    subject?: string;
    message?: string;
    severity?: "info" | "warning" | "critical";
    status?: "open" | "snoozed" | "resolved";
    ruleStatus?: "issues" | "not_available" | "ok";
    ruleId?: string;
    notified?: boolean;
    reopenCount?: number;
    firstSeenAt?: string;
    /** Same fingerprint in two divisions, or a re-inserted row. */
    fingerprint?: string;
    divisionId?: number;
  } = {},
): Promise<{ id: number; fingerprint: string }> {
  const ruleId = over.ruleId ?? "integrations.exact_connection";
  seq += 1;
  const fingerprint = over.fingerprint ?? `${ruleId}:t${seq}`;
  const divisionId = over.divisionId ?? 0;
  const status = over.status ?? "open";
  await db
    .prepare(
      `INSERT OR IGNORE INTO dq_rule_status (division_id, rule_id, status, reason, checked, issue_count, evaluated_at)
       VALUES (?4, ?1, ?2, ?3, 1, 0, '2026-07-15T09:00:00.000Z')`,
    )
    .bind(
      ruleId,
      over.ruleStatus ?? "issues",
      (over.ruleStatus ?? "issues") === "not_available" ? "no_data" : null,
      divisionId,
    )
    .run();
  const r = await db
    .prepare(
      `INSERT INTO dq_issues (division_id, rule_id, fingerprint, area, severity, status, subject, message, fix,
         payload_json, first_seen_at, last_seen_at, resolved_at, snoozed_until, reopen_count, notified_at)
       VALUES (?12, ?1, ?2, 'integrations', ?3, ?4, ?5, ?6, 'connections', '{}', ?7, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      ruleId,
      fingerprint,
      over.severity ?? "critical",
      status,
      over.subject ?? `Subject ${seq}`,
      over.message ?? "1 problem needs attention",
      over.firstSeenAt ?? new Date(NOW - 3_600_000).toISOString(),
      status === "resolved" ? "2026-07-15T09:30:00.000Z" : null,
      status === "snoozed" ? "2026-08-01T00:00:00.000Z" : null,
      over.reopenCount ?? 0,
      over.notified ? "2026-07-14T00:00:00.000Z" : null,
      divisionId,
    )
    .run();
  return { id: r.meta.last_row_id, fingerprint };
}

export interface EmailRow {
  idempotency_key: string;
  kind: string;
  template: string;
  recipients_count: number;
  status: string;
  attempts: number;
  dq_issue_id: number | null;
  provider_message_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export async function emailRows(where = "1 = 1"): Promise<EmailRow[]> {
  return (await db.prepare(`SELECT * FROM email_log WHERE ${where} ORDER BY id`).all<EmailRow>())
    .results;
}

export async function notifiedIds(): Promise<number[]> {
  return (
    await db
      .prepare("SELECT id FROM dq_issues WHERE notified_at IS NOT NULL ORDER BY id")
      .all<{ id: number }>()
  ).results.map((r) => r.id);
}

/** The standard recipient set: two that qualify and several that must not. */
export async function seedUsers(): Promise<void> {
  await addUser("admin@camelthorncapital.com", ["admin"]);
  await addUser("fin@camelthorncapital.com", ["finance"]);
  await addUser("viewer@camelthorncapital.com", ["viewer"]);
  await addUser("approver@camelthorncapital.com", ["approver"]);
  await addUser("outside@example.com", ["admin"]);
  await addUser("sub@evil.camelthorncapital.com", ["admin"]);
  await addUser("gone@camelthorncapital.com", ["admin"], { disabled: true });
  const ext = await addUser("accountant@camelthorncapital.com", ["finance"]);
  await db.prepare("UPDATE users SET is_external = 1 WHERE id = ?1").bind(ext).run();
}

/** A finished run of the checks job (what the digest reads to know the checks are alive). */
export async function addCheckRun(
  startedAtMs: number = NOW - 30 * 60_000,
  status: "ok" | "partial" | "error" = "ok",
): Promise<void> {
  const at = new Date(startedAtMs).toISOString();
  await db
    .prepare(
      `INSERT INTO dq_runs (started_at, finished_at, status, engine_version) VALUES (?1, ?1, ?2, '1')`,
    )
    .bind(at, status)
    .run();
}
