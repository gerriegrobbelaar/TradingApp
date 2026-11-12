import { env } from "cloudflare:test";
import type { JobContext } from "../src/jobs/types";
import { runDqChecks } from "../src/dq/run";
import { jobContext, NOW } from "./matching-helpers";
import { emailLogWipeStatements } from "./outbox-wipe";

export const db = env.DB;
export { NOW };

/** Empties the DQ tables (open issues cannot be deleted: they are resolved first). */
export async function resetDq(): Promise<void> {
  await db.batch([
    ...(await emailLogWipeStatements(db)),
    db.prepare("DELETE FROM settings WHERE key IN ('dq.notifications', 'dq.unsynced_since')"),
    db.prepare(
      "UPDATE dq_issues SET status = 'resolved', resolved_at = '2026-01-01T00:00:00.000Z', snoozed_until = NULL WHERE status <> 'resolved'",
    ),
    db.prepare("DELETE FROM dq_issues"),
    db.prepare("DELETE FROM dq_rule_status"),
    db.prepare("DELETE FROM dq_runs"),
    db.prepare("DELETE FROM dq_rules"),
  ]);
}

export function dqContext(over: Partial<JobContext> = {}, e = env): JobContext {
  return jobContext(
    { job: { id: 1, name: "dq.checks", handler: "dq.checks", exactBudget: 0 }, ...over },
    e,
  );
}

export const runDq = (over: Partial<JobContext> = {}, e = env) =>
  runDqChecks(dqContext(over, e), {
    describeHandler: (h) => ({ title: h, implemented: true }),
  });

export interface IssueRow {
  id: number;
  division_id: number;
  rule_id: string;
  fingerprint: string;
  status: string;
  severity: string;
  subject: string;
  message: string;
  payload_json: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  snoozed_until: string | null;
  reopen_count: number;
  amount_minor: number | null;
  currency: string | null;
}

export async function issues(where = "1 = 1"): Promise<IssueRow[]> {
  return (await db.prepare(`SELECT * FROM dq_issues WHERE ${where} ORDER BY id`).all<IssueRow>())
    .results;
}

export const fingerprints = async (where = "status = 'open'"): Promise<string[]> =>
  (await issues(where)).map((i) => i.fingerprint).sort();

export async function ruleStatus(
  ruleId: string,
  divisionId: number,
): Promise<{ status: string; reason: string | null; checked: number; issue_count: number } | null> {
  return db
    .prepare(
      "SELECT status, reason, checked, issue_count FROM dq_rule_status WHERE rule_id = ?1 AND division_id = ?2",
    )
    .bind(ruleId, divisionId)
    .first();
}

/** A D1 whose prepare() throws for statements containing `fragment` (one section fails). */
export function flakyDb(fragment: string): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes(fragment)) throw new Error("simulated failure");
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
