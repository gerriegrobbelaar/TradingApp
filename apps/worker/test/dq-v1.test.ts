/**
 * Phase 8 final-review fixes (task V1): alert keys per issue row (B1), digest and job_stale
 * (S1, S4), summary alerts and rate limits (S3), source freshness (S5), cooldown and counts (N1, N2),
 * the Today duplicate (N3), the one-off guard on exact.bank_balances (N7).
 */
import { legacyAlertKey } from "@camelthorn/core";
import { beforeEach, describe, expect, it } from "vitest";
import { runAlerts } from "../src/dq/alerts";
import { loadDigestData, runDigest } from "../src/dq/digest";
import { SETTING_NOTIFICATIONS } from "../src/dq/notify-settings";
import { httpsSender } from "../src/email/sender";
import { DEFAULT_JOBS_VERSION, seedDefaultJobs } from "../src/jobs/defaults";
import { db, fingerprints, resetDq, ruleStatus, runDq } from "./dq-helpers";
import {
  addCheckRun,
  addCritical,
  ctxAt,
  emailRows,
  fakeSender,
  NOW,
  notifiedIds,
  seedUsers,
} from "./dq-notify-helpers";
import { resetDb } from "./helpers";
import {
  addItem,
  addRelation,
  markOpenItemsSynced,
  markSourcesSynced,
  resetWorld,
  type World,
} from "./matching-helpers";
import { auditRows } from "./sync-helpers";

const DAY = 86_400_000;
const later = (n: number): number => NOW + n * 20 * 60_000;
let w: World;

beforeEach(async () => {
  await resetDb();
  await resetDq();
  w = await resetWorld();
  await seedUsers();
});

describe("B1: alert keys belong to the issue row", () => {
  it("the same fingerprint in two administrations is two alerts", async () => {
    const a = await addCritical({
      fingerprint: "integrations.exact_connection:exact",
      divisionId: 1,
    });
    const b = await addCritical({
      fingerprint: "integrations.exact_connection:exact",
      divisionId: 2,
    });
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out.sent).toBe(2);
    expect(s.calls).toBe(2);
    expect(await notifiedIds()).toEqual([a.id, b.id]);
    expect((await emailRows()).map((r) => r.idempotency_key)).toEqual([
      `dq-alert:${a.id}:0`,
      `dq-alert:${b.id}:0`,
    ]);
  });

  it("a row deleted by retention and inserted again is alerted again", async () => {
    const fp = "integrations.exact_connection:exact";
    const first = await addCritical({ fingerprint: fp });
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    // Retention: resolved long ago, then deleted. The email_log row (400 days) outlives it.
    await db.batch([
      db
        .prepare("UPDATE dq_issues SET status = 'resolved', resolved_at = ?2 WHERE id = ?1")
        .bind(first.id, "2026-01-01T00:00:00.000Z"),
      db.prepare("DELETE FROM dq_issues WHERE id = ?1").bind(first.id),
    ]);
    const second = await addCritical({ fingerprint: fp });
    expect(second.id).not.toBe(first.id);
    const out = await runAlerts(ctxAt(later(1)), 2, { sender: s });
    expect(out.sent).toBe(1);
    expect(s.calls).toBe(2);
    expect(await notifiedIds()).toEqual([second.id]);
  });

  it("upgrade: an open issue alerted under the old key keeps its mark and is not alerted again", async () => {
    const a = await addCritical({ notified: true });
    const fp = (
      await db
        .prepare("SELECT fingerprint AS f FROM dq_issues WHERE id = ?1")
        .bind(a.id)
        .first<{ f: string }>()
    )?.f as string;
    await db
      .prepare(
        `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, dq_issue_id, created_at, updated_at)
         VALUES (?1, 'dq_alert', 'dq.alert.v1', 2, 'sent', ?2, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')`,
      )
      .bind(legacyAlertKey(fp, 0), a.id)
      .run();
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    await runAlerts(ctxAt(later(1)), 2, { sender: s });
    expect(s.calls).toBe(0);
    expect(await notifiedIds()).toEqual([a.id]);
  });

  it("upgrade: a pending issue whose OWN old-format key exists is marked, one that only shares the fingerprint is alerted", async () => {
    const fp = "integrations.exact_connection:exact";
    const own = await addCritical({ fingerprint: fp, divisionId: 1 });
    const other = await addCritical({ fingerprint: fp, divisionId: 2 });
    // Old-format key written for the row of division 1 only.
    await db
      .prepare(
        `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, dq_issue_id, created_at, updated_at)
         VALUES (?1, 'dq_alert', 'dq.alert.v1', 2, 'sent', ?2, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
      )
      .bind(legacyAlertKey(fp, 0), own.id)
      .run();
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    expect(s.calls).toBe(1);
    expect(await emailRows("status = 'sent' AND created_at > '2026-07-01'")).toHaveLength(1);
    expect(await notifiedIds()).toEqual([own.id, other.id]);
  });
});

describe("S3: summaries, rate limits, spacing", () => {
  it("a 429 stops the run's sending; nothing else is claimed and the next run carries on", async () => {
    for (let i = 0; i < 4; i++) await addCritical();
    const s = fakeSender((n) =>
      n === 1
        ? { status: "failed", code: "http_429" }
        : { status: "sent", providerMessageId: `m${n}` },
    );
    const a = await runAlerts(ctxAt(), 1, { sender: s });
    expect(s.calls).toBe(1);
    expect(a).toMatchObject({ rateLimited: true, failed: 1, sent: 0, alerted: 1 });
    // Only the first issue was claimed; the other three are untouched and still pending.
    expect(await notifiedIds()).toHaveLength(1);
    // Inside the back-off nothing is retried and the pending ones go out.
    const b = await runAlerts(ctxAt(NOW + 60_000), 2, { sender: s });
    expect(b).toMatchObject({ retried: 0, alerted: 3, sent: 3 });
    // After the back-off the refused alert is retried.
    const c = await runAlerts(ctxAt(later(2)), 3, { sender: s });
    expect(c).toMatchObject({ retried: 1, sent: 1 });
    expect(await emailRows("status = 'sent'")).toHaveLength(4);
  });

  it("a 429 on the summary gives its issues back; the next run sends them", async () => {
    await db
      .prepare("INSERT OR REPLACE INTO settings (key, value_json, updated_by) VALUES (?1, ?2, 't')")
      .bind(SETTING_NOTIFICATIONS, JSON.stringify({ maxAlertsPerRun: 1 }))
      .run();
    for (let i = 0; i < 4; i++) await addCritical();
    const s = fakeSender((_n, m) =>
      /more critical data issues/.test(m.subject) && s.calls === 2
        ? { status: "failed", code: "http_429" }
        : { status: "sent", providerMessageId: "ok" },
    );
    const a = await runAlerts(ctxAt(), 1, { sender: s });
    expect(a).toMatchObject({ alerted: 1, folded: 3, summaries: 1, failed: 1, rateLimited: true });
    expect(await notifiedIds()).toHaveLength(1);
    const b = await runAlerts(ctxAt(later(1)), 2, { sender: s });
    // The 3 given-back issues: one single (cap 1) and one summary of the other 2.
    expect(b).toMatchObject({ alerted: 1, folded: 2, summaries: 1, sent: 2 });
    expect(await notifiedIds()).toHaveLength(4);
    const summaryRows = await emailRows("kind = 'dq_alert_summary'");
    expect(summaryRows.map((r) => r.status)).toEqual(["failed", "sent"]);
  });

  it("a backlog is one summary that lists ten and states the total", async () => {
    await db
      .prepare("INSERT OR REPLACE INTO settings (key, value_json, updated_by) VALUES (?1, ?2, 't')")
      .bind(SETTING_NOTIFICATIONS, JSON.stringify({ maxAlertsPerRun: 2 }))
      .run();
    for (let i = 0; i < 40; i++) await addCritical({ subject: `Issue ${i}` });
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out).toMatchObject({ alerted: 2, folded: 38, summaries: 1 });
    expect(s.calls).toBe(3);
    const text = s.sent[2]?.text ?? "";
    expect(text).toContain("38 more critical data issues");
    expect(text.match(/^- /gm)).toHaveLength(10);
    expect(text).toContain("And 28 more.");
  });

  it("sends are spaced by the sender's own pause", async () => {
    for (let i = 0; i < 3; i++) await addCritical();
    const s = { ...fakeSender(), spacingMs: 250 };
    const waits: number[] = [];
    await runAlerts(ctxAt(), 1, {
      sender: s,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([250, 250]);
  });

  it("the https sender passes Retry-After on a 429", async () => {
    const mk = (headers: Record<string, string>) =>
      httpsSender({
        host: "api.mail.example.com",
        from: "alerts@camelthorncapital.com",
        apiKey: "K",
        fetchFn: () => Promise.resolve(new Response("{}", { status: 429, headers })),
      });
    const msg = { to: ["a@camelthorncapital.com"], subject: "S", html: "h", text: "t" };
    expect(await mk({ "retry-after": "120" }).send(msg)).toEqual({
      status: "failed",
      code: "http_429",
      retryAfterSeconds: 120,
    });
    expect(await mk({ "retry-after": "999999" }).send(msg)).toMatchObject({
      retryAfterSeconds: 3600,
    });
    expect(await mk({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }).send(msg)).toEqual({
      status: "failed",
      code: "http_429",
    });
  });
});

describe("N1 and N2: counts and cooldown", () => {
  it("counts accepted sends, not claims", async () => {
    await addCritical();
    await addCritical();
    const s = fakeSender((n) =>
      n === 1
        ? { status: "unknown", code: "http_503" }
        : { status: "sent", providerMessageId: "m" },
    );
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out).toMatchObject({ alerted: 2, sent: 1, unknown: 1 });
  });

  it("a fingerprint that comes back within 24 hours is left to the digest, after that it is alerted", async () => {
    const { id } = await addCritical();
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    const reopen = async (): Promise<void> => {
      await db.batch([
        db
          .prepare("UPDATE dq_issues SET status = 'resolved', resolved_at = ?2 WHERE id = ?1")
          .bind(id, "2026-07-15T10:30:00.000Z"),
        db
          .prepare(
            `UPDATE dq_issues SET status = 'open', resolved_at = NULL, reopen_count = reopen_count + 1,
             notified_at = NULL WHERE id = ?1`,
          )
          .bind(id),
      ]);
    };
    await reopen();
    const soon = await runAlerts(ctxAt(NOW + 3_600_000), 2, { sender: s });
    expect(soon).toMatchObject({ suppressed: 1, sent: 0 });
    expect(s.calls).toBe(1);
    expect(await notifiedIds()).toEqual([id]);
    // Another reopen a day and a bit after the first alert: alerted again.
    await reopen();
    const away = await runAlerts(ctxAt(NOW + DAY + 3_600_000), 3, { sender: s });
    expect(away).toMatchObject({ suppressed: 0, sent: 1 });
    expect(s.calls).toBe(2);
  });

  it("a refused alert does not start a cooldown", async () => {
    const { id } = await addCritical();
    const s = fakeSender((n) =>
      n === 1 ? { status: "failed", code: "http_422" } : { status: "sent", providerMessageId: "m" },
    );
    await runAlerts(ctxAt(), 1, { sender: s });
    await db
      .prepare("UPDATE dq_issues SET status = 'resolved', resolved_at = ?2 WHERE id = ?1")
      .bind(id, "2026-07-15T10:30:00.000Z")
      .run();
    await db
      .prepare(
        `UPDATE dq_issues SET status = 'open', resolved_at = NULL, reopen_count = 1, notified_at = NULL WHERE id = ?1`,
      )
      .bind(id)
      .run();
    const out = await runAlerts(ctxAt(later(1)), 2, { sender: s });
    expect(out).toMatchObject({ suppressed: 0, sent: 1 });
  });
});

describe("S4: the digest says when the checks are not running", () => {
  beforeEach(async () => {
    await db.prepare("DELETE FROM dq_runs").run();
  });

  it("leads with 'never run' instead of a zero", async () => {
    const s = fakeSender();
    await runDigest(ctxAt(), { sender: s });
    const m = s.sent[0]!;
    expect(m.subject).toBe("Data quality checks have never run");
    expect(m.text).toContain("have never run, so the issue counts are not known");
    expect(m.text).not.toMatch(/\b0 open/);
    expect(m.html).not.toMatch(/\b0 open/);
  });

  it("leads with the date of the last run when it is stale", async () => {
    await addCritical();
    await addCheckRun(NOW - 3 * DAY);
    const s = fakeSender();
    await runDigest(ctxAt(), { sender: s });
    const m = s.sent[0]!;
    expect(m.subject).toBe("Data quality checks have not run since 2026-07-12");
    expect(m.text).toContain("The counts below are from that run.");
    expect(m.text).toContain("All administrations.");
  });

  it("a recent run reads as before and a partial run is flagged", async () => {
    await addCritical();
    await addCheckRun(NOW - 20 * 60_000, "partial");
    const s = fakeSender();
    await runDigest(ctxAt(), { sender: s });
    const m = s.sent[0]!;
    expect(m.subject).toBe("1 open data quality issue, 1 critical");
    expect(m.text).toContain("did not finish all rules");
  });

  it("does not count issues of a rule that is switched off, nor list it as not evaluated", async () => {
    await addCheckRun();
    await addCritical({ ruleId: "integrations.exact_connection" });
    await addCritical({ ruleId: "fx.rate_stale", severity: "warning" });
    await db
      .prepare(
        `INSERT INTO dq_rules (id, enabled, rev, updated_by, updated_at)
         VALUES ('fx.rate_stale', 0, 'r', 't', '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO dq_rule_status (division_id, rule_id, status, reason, evaluated_at)
         VALUES (0, 'fx.currency_without_rate', 'not_available', 'x', '2026-07-15T09:00:00.000Z')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO dq_rules (id, enabled, rev, updated_by, updated_at)
         VALUES ('fx.currency_without_rate', 0, 'r', 't', '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    const d = await loadDigestData(db, NOW);
    expect(d.bySeverity).toEqual({ critical: 1, warning: 0, info: 0 });
    expect(d.notEvaluated.map((n) => n.ruleTitle)).not.toContain("Foreign currency without a rate");
    expect(d.checks).toMatchObject({ lastStatus: "ok", stale: false });
  });
});

describe("S5: sources that were never synchronised or are stale are not judged", () => {
  const SECTION_RULES: [string, string][] = [
    ["payables.duplicate_invoices", "open items"],
    ["master.supplier_no_iban", "relations"],
    ["bank.unmatched_old", "bank lines"],
  ];

  it("never synchronised: not_available with source_never_synced, never ok", async () => {
    await markOpenItemsSynced(w.divisionId, null);
    await markSourcesSynced(w.divisionId, w.revolutConnectionId, null);
    await runDq();
    for (const [rule] of SECTION_RULES) {
      expect(await ruleStatus(rule, w.divisionId), rule).toMatchObject({
        status: "not_available",
        reason: "source_never_synced",
      });
    }
  });

  it("older than 26 hours: not_available with source_stale and open issues stay open", async () => {
    const rel = await addRelation({ divisionId: w.divisionId, name: "Acme B.V.", ibans: [] });
    for (let i = 0; i < 2; i++) {
      await addItem({
        divisionId: w.divisionId,
        kind: "bill",
        invoiceNumber: "F-1",
        openMinor: 10_000,
        relationExactId: rel.exactId,
        relationName: "Acme B.V.",
      });
    }
    await runDq();
    const before = await fingerprints();
    expect(before.some((f) => f.startsWith("payables.duplicate_invoices"))).toBe(true);
    const old = new Date(NOW - 27 * 3_600_000).toISOString();
    await markOpenItemsSynced(w.divisionId, old);
    await markSourcesSynced(w.divisionId, w.revolutConnectionId, old);
    await runDq({ now: () => NOW + 60_000 });
    for (const [rule] of SECTION_RULES) {
      expect(await ruleStatus(rule, w.divisionId), rule).toMatchObject({
        status: "not_available",
        reason: "source_stale",
      });
    }
    // Nothing was auto-resolved on the strength of data nobody refreshed.
    expect(await fingerprints()).toEqual(before);
  });

  it("a fresh sync judges again", async () => {
    await runDq();
    expect(await ruleStatus("payables.duplicate_invoices", w.divisionId)).toMatchObject({
      status: "ok",
    });
  });

  it("the Revolut read counts for bank lines only", async () => {
    await db
      .prepare(
        "UPDATE revolut_sync_state SET last_completed_at = ?2 WHERE connection_id = ?1 AND entity = 'transactions'",
      )
      .bind(w.revolutConnectionId, new Date(NOW - 30 * 3_600_000).toISOString())
      .run();
    await runDq();
    expect(await ruleStatus("bank.unmatched_old", w.divisionId)).toMatchObject({
      status: "not_available",
      reason: "source_stale",
    });
    expect(await ruleStatus("payables.duplicate_invoices", w.divisionId)).toMatchObject({
      status: "ok",
    });
  });
});

describe("S1: a job that skips on purpose is not stale", () => {
  it("dq.digest ending email_not_configured raises no job_stale warning; another code does", async () => {
    await db
      .prepare(
        `INSERT INTO jobs (name, handler, schedule_json, enabled, created_at, last_scheduled_at, last_status)
         VALUES ('dq.digest', 'dq.digest', '{"kind":"cron","expr":"0 8 * * *"}', 1, '2026-06-01T00:00:00.000Z',
                 '2026-06-01T00:00:00.000Z', 'skipped')`,
      )
      .run();
    const jobId = (
      await db.prepare("SELECT id FROM jobs WHERE name = 'dq.digest'").first<{ id: number }>()
    )?.id as number;
    const run = (code: string): Promise<unknown> =>
      db
        .prepare(
          `INSERT INTO job_runs (job_id, scheduled_for, status, error_code, queued_at, finished_at)
           VALUES (?1, '2026-07-15T06:00:00.000Z', 'skipped', ?2, '2026-06-02T06:00:00.000Z', '2026-06-02T06:00:01.000Z')`,
        )
        .bind(jobId, code)
        .run();
    await run("email_not_configured");
    await runDq();
    expect(await fingerprints()).not.toContain("integrations.job_stale:job|dq.digest");
    await db.prepare("DELETE FROM job_runs").run();
    await run("some_other_reason");
    await db.prepare("UPDATE jobs SET last_status = 'skipped' WHERE id = ?1").bind(jobId).run();
    await runDq({ now: () => NOW + 60_000 });
    expect(await fingerprints()).toContain("integrations.job_stale:job|dq.digest");
  });
});

describe("N7: the one-off guard on exact.bank_balances", () => {
  async function jobRow(): Promise<{ enabled: number; next_run_at: string | null } | null> {
    return db
      .prepare("SELECT enabled, next_run_at FROM jobs WHERE name = 'exact.bank_balances'")
      .first();
  }
  const setMarker = (v: number): Promise<unknown> =>
    db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value_json, updated_by) VALUES ('seed.default_jobs', json_object('version', ?1), 'test')",
      )
      .bind(v)
      .run();

  it("switches an enabled row off once, with an audit row, and not again", async () => {
    await seedDefaultJobs(db, NOW);
    await db
      .prepare(
        "UPDATE jobs SET enabled = 1, next_run_at = '2026-07-15T10:05:00.000Z' WHERE name = 'exact.bank_balances'",
      )
      .run();
    await setMarker(5);
    expect(await seedDefaultJobs(db, NOW)).toBe("applied");
    expect(await jobRow()).toEqual({ enabled: 0, next_run_at: null });
    const audit = await auditRows("job.forced_off", "exact.bank_balances");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after_json).toContain("awaiting_live_verification");
    // An admin who switches it on after the upgrade is not overruled by a later start.
    await db.prepare("UPDATE jobs SET enabled = 1 WHERE name = 'exact.bank_balances'").run();
    expect(await seedDefaultJobs(db, NOW)).toBe("current");
    expect((await jobRow())?.enabled).toBe(1);
    expect(DEFAULT_JOBS_VERSION).toBeGreaterThanOrEqual(6);
  });

  it("writes no audit row when the job was already off, and leaves other jobs alone", async () => {
    await seedDefaultJobs(db, NOW);
    await db.prepare("UPDATE jobs SET enabled = 1 WHERE name = 'dq.checks'").run();
    await setMarker(5);
    const before = (await auditRows("job.forced_off", "exact.bank_balances")).length;
    await seedDefaultJobs(db, NOW);
    expect(await auditRows("job.forced_off", "exact.bank_balances")).toHaveLength(before);
    expect(
      (
        await db
          .prepare("SELECT enabled FROM jobs WHERE name = 'dq.checks'")
          .first<{ enabled: number }>()
      )?.enabled,
    ).toBe(1);
  });
});
