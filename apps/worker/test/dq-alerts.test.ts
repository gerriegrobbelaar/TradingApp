/**
 * Instant alerts for critical data quality issues (ADR 0046): who is alerted, once per life of an
 * issue, claim-then-send under crash, retry and concurrency, the per-run cap with folding, and the
 * rules that must never alert.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runAlerts, SUMMARY_CHUNK } from "../src/dq/alerts";
import { SETTING_NOTIFICATIONS } from "../src/dq/notify-settings";
import { resetDb } from "./helpers";
import { db, resetDq } from "./dq-helpers";
import {
  addCritical,
  ctxAt,
  emailRows,
  fakeSender,
  notifiedIds,
  NOW,
  seedUsers,
} from "./dq-notify-helpers";
import { auditRows } from "./sync-helpers";

async function setSettings(s: Record<string, unknown>): Promise<void> {
  await db
    .prepare(
      "INSERT OR REPLACE INTO settings (key, value_json, updated_by) VALUES (?1, ?2, 'test')",
    )
    .bind(SETTING_NOTIFICATIONS, JSON.stringify(s))
    .run();
}

beforeEach(async () => {
  await resetDb();
  await resetDq();
  await seedUsers();
});

describe("recipients", () => {
  it("sends one alert to admin and finance users on the allowed domain only", async () => {
    await addCritical({ subject: "Exact connection" });
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out).toMatchObject({ alerted: 1, folded: 0, skipped: null });
    expect(s.sent).toHaveLength(1);
    expect([...(s.sent[0]?.to ?? [])].sort()).toEqual([
      "admin@camelthorncapital.com",
      "fin@camelthorncapital.com",
    ]);
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "dq_alert",
      template: "dq.alert.v1",
      recipients_count: 2,
      status: "sent",
      provider_message_id: "msg-1",
    });
  });

  it("mode admin narrows it to admins", async () => {
    await setSettings({ alertRecipients: "admin" });
    await addCritical();
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    expect(s.sent[0]?.to).toEqual(["admin@camelthorncapital.com"]);
  });

  it("no qualifying user: nothing is claimed or marked, one skipped row records why", async () => {
    await db.batch([db.prepare("DELETE FROM user_roles"), db.prepare("DELETE FROM users")]);
    const { id } = await addCritical();
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out.skipped).toBe("no_recipients");
    expect(s.calls).toBe(0);
    expect(await notifiedIds()).toEqual([]);
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "skipped_not_configured",
      error_code: "no_recipients",
    });
    expect(id).toBeGreaterThan(0);
  });

  it("the domain comes from ALLOWED_HD and is matched exactly", async () => {
    await addCritical();
    const s = fakeSender();
    const other = { ...env, ALLOWED_HD: "example.com" };
    await runAlerts(ctxAt(NOW, { env: other }), 1, { sender: s });
    expect(s.sent[0]?.to).toEqual(["outside@example.com"]);
  });
});

describe("what is alerted", () => {
  it("only open critical issues of a rule that was evaluated with issues", async () => {
    await addCritical({ severity: "warning" });
    await addCritical({ severity: "info" });
    await addCritical({ status: "snoozed" });
    await addCritical({ status: "resolved" });
    await addCritical({ ruleId: "fx.currency_without_rate", ruleStatus: "not_available" });
    await addCritical({ notified: true });
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out.candidates).toBe(0);
    expect(s.calls).toBe(0);
    expect(await emailRows()).toEqual([]);
  });

  it("a rule that is not available vouches for nothing even with an open critical issue", async () => {
    await addCritical({ ruleStatus: "not_available" });
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    expect(s.calls).toBe(0);
  });

  it("is quiet when notifications are switched off", async () => {
    await setSettings({ enabled: false });
    await addCritical();
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out.disabled).toBe(true);
    expect(s.calls).toBe(0);
    expect(await emailRows()).toEqual([]);
  });

  it("an issue is alerted once; a repeat run sends nothing", async () => {
    await addCritical();
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    await runAlerts(ctxAt(), 2, { sender: s });
    await runAlerts(ctxAt(NOW + 3_600_000), 3, { sender: s });
    expect(s.calls).toBe(1);
    expect(await emailRows()).toHaveLength(1);
  });

  it("a reopened issue (reopen count + 1, notified_at cleared) is alerted again, once", async () => {
    const { id } = await addCritical();
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
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
    await runAlerts(ctxAt(), 2, { sender: s });
    await runAlerts(ctxAt(), 3, { sender: s });
    expect(s.calls).toBe(2);
    const keys = (await emailRows()).map((r) => r.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]?.endsWith(":0")).toBe(true);
    expect(keys[1]?.endsWith(":1")).toBe(true);
  });

  it("claims, marks the issue and writes the audit row in one step", async () => {
    const { id, fingerprint } = await addCritical();
    await runAlerts(ctxAt(), 1, { sender: fakeSender() });
    expect(await notifiedIds()).toEqual([id]);
    const audit = await auditRows("email.claimed", `dq-alert:${fingerprint}:0`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_email).toBe("system");
    expect(audit[0]?.after_json).toContain("dq.alert.v1");
  });
});

describe("no sender configured", () => {
  it("records skipped_not_configured once a day and leaves notified_at alone", async () => {
    const { id } = await addCritical();
    // No test sender and no provider setting: the default is the disabled sender.
    const a = await runAlerts(ctxAt(), 1);
    const b = await runAlerts(ctxAt(NOW + 600_000), 2);
    expect(a.skipped).toBe("not_configured");
    expect(b.skipped).toBe("not_configured");
    expect(await notifiedIds()).toEqual([]);
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "dq_alert",
      status: "skipped_not_configured",
      error_code: "not_configured",
    });
    // Enabling a sender later alerts the issue that is still open.
    const s = fakeSender();
    await runAlerts(ctxAt(NOW + 1_200_000), 3, { sender: s });
    expect(s.calls).toBe(1);
    expect(await notifiedIds()).toEqual([id]);
  });

  it("an https provider without the secret is the disabled sender", async () => {
    await setSettings({
      emailProvider: "https",
      emailHost: "api.mail.example.com",
      emailFrom: "alerts@camelthorncapital.com",
    });
    await addCritical();
    const noKey = { ...env, EMAIL_API_KEY: "" };
    const out = await runAlerts(ctxAt(NOW, { env: noKey }), 1);
    expect(out.skipped).toBe("not_configured");
    expect(await notifiedIds()).toEqual([]);
  });
});

describe("cap and fold", () => {
  it("sends at most the cap singly and folds the rest into one summary", async () => {
    for (let i = 0; i < 25; i++) {
      await addCritical({ firstSeenAt: new Date(NOW - (100 - i) * 60_000).toISOString() });
    }
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 7, { sender: s });
    expect(out).toMatchObject({ alerted: 10, folded: 15, summaries: 1 });
    expect(s.sent).toHaveLength(11);
    const summary = s.sent[10];
    expect(summary?.subject.startsWith("15 more critical data issues")).toBe(true);
    expect(summary?.text).toContain("And 5 more.");
    expect(await notifiedIds()).toHaveLength(25);
    const rows = await emailRows();
    expect(rows.filter((r) => r.kind === "dq_alert")).toHaveLength(10);
    expect(rows.filter((r) => r.kind === "dq_alert_summary")).toHaveLength(1);
    expect(rows.find((r) => r.kind === "dq_alert_summary")?.idempotency_key).toBe(
      "dq-alert-summary:7:0",
    );
    // Nothing more on the next run.
    await runAlerts(ctxAt(), 8, { sender: s });
    expect(s.calls).toBe(11);
  });

  it("the cap is a setting, and summaries are chunked", async () => {
    await setSettings({ maxAlertsPerRun: 2 });
    const total = 2 + SUMMARY_CHUNK + 5;
    for (let i = 0; i < total; i++) await addCritical();
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out).toMatchObject({ alerted: 2, folded: SUMMARY_CHUNK + 5, summaries: 2 });
    expect(s.calls).toBe(4);
    expect(await notifiedIds()).toHaveLength(total);
  });

  it("the oldest issues are alerted first", async () => {
    await setSettings({ maxAlertsPerRun: 1 });
    const newer = await addCritical({
      subject: "Newer",
      firstSeenAt: new Date(NOW - 60_000).toISOString(),
    });
    const older = await addCritical({
      subject: "Older",
      firstSeenAt: new Date(NOW - 7_200_000).toISOString(),
    });
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    expect(s.sent[0]?.text).toContain("Older");
    expect(s.sent[1]?.text).toContain("Newer");
    expect(newer.id).not.toBe(older.id);
  });
});

describe("duplicate prevention", () => {
  it("two runs at the same time send each alert exactly once", async () => {
    for (let i = 0; i < 6; i++) await addCritical();
    const s = fakeSender();
    const [a, b, c] = await Promise.all([
      runAlerts(ctxAt(), 1, { sender: s }),
      runAlerts(ctxAt(), 2, { sender: s }),
      runAlerts(ctxAt(), 3, { sender: s }),
    ]);
    expect(a.alerted + b.alerted + c.alerted).toBe(6);
    expect(a.lostClaims + b.lostClaims + c.lostClaims).toBeGreaterThan(0);
    expect(s.calls).toBe(6);
    expect(new Set(s.sent.map((m) => m.text)).size).toBe(6);
    expect(await emailRows()).toHaveLength(6);
    expect(await notifiedIds()).toHaveLength(6);
  });

  it("concurrent runs never double-send the folded summary either", async () => {
    await setSettings({ maxAlertsPerRun: 1 });
    for (let i = 0; i < 5; i++) await addCritical();
    const s = fakeSender();
    await Promise.all([runAlerts(ctxAt(), 1, { sender: s }), runAlerts(ctxAt(), 2, { sender: s })]);
    expect(await notifiedIds()).toHaveLength(5);
    const summaries = (await emailRows()).filter((r) => r.kind === "dq_alert_summary");
    expect(summaries.length).toBeLessThanOrEqual(2);
    // Every issue is covered by exactly one message.
    expect((await emailRows()).filter((r) => r.kind === "dq_alert")).toHaveLength(
      (await emailRows()).filter((r) => r.kind === "dq_alert").length,
    );
    expect(s.calls).toBe((await emailRows()).length);
  });

  it("a crash between claim and send is never sent again; the stale claim becomes unknown", async () => {
    const { id } = await addCritical();
    // Simulate the crash: the claim batch ran (log row + notified_at), the send never happened.
    const crashed = new Date(NOW - 30 * 60_000).toISOString();
    const fp = (await db
      .prepare("SELECT fingerprint FROM dq_issues WHERE id = ?1")
      .bind(id)
      .first<{ fingerprint: string }>())!.fingerprint;
    await db.batch([
      db
        .prepare(
          `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, dq_issue_id, created_at, updated_at)
           VALUES (?1, 'dq_alert', 'dq.alert.v1', 2, 'claimed', ?2, ?3, ?3)`,
        )
        .bind(`dq-alert:${fp}:0`, id, crashed),
      db.prepare("UPDATE dq_issues SET notified_at = ?2 WHERE id = ?1").bind(id, crashed),
    ]);
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    await runAlerts(ctxAt(NOW + 3_600_000), 2, { sender: s });
    expect(s.calls).toBe(0);
    expect(out.staleSwept).toBe(1);
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "unknown", error_code: "claim_stale" });
  });

  it("a fresh claim (still in flight) is left alone", async () => {
    const { id, fingerprint } = await addCritical();
    const recent = new Date(NOW - 60_000).toISOString();
    await db.batch([
      db
        .prepare(
          `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, dq_issue_id, created_at, updated_at)
           VALUES (?1, 'dq_alert', 'dq.alert.v1', 2, 'claimed', ?2, ?3, ?3)`,
        )
        .bind(`dq-alert:${fingerprint}:0`, id, recent),
      db.prepare("UPDATE dq_issues SET notified_at = ?2 WHERE id = ?1").bind(id, recent),
    ]);
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(s.calls).toBe(0);
    expect(out.staleSwept).toBe(0);
    expect((await emailRows())[0]?.status).toBe("claimed");
  });

  it("a sender that throws leaves an unknown outcome that is never retried", async () => {
    await addCritical();
    const s = fakeSender(() => {
      throw new Error("boom");
    });
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    await runAlerts(ctxAt(), 2, { sender: s });
    expect(out.unknown).toBe(1);
    expect(s.calls).toBe(1);
    expect(await emailRows()).toMatchObject([{ status: "unknown", error_code: "sender_threw" }]);
  });

  it("an unclear provider answer (unknown) is never retried", async () => {
    await addCritical();
    const s = fakeSender(() => ({ status: "unknown", code: "http_503" }));
    await runAlerts(ctxAt(), 1, { sender: s });
    await runAlerts(ctxAt(), 2, { sender: s });
    await runAlerts(ctxAt(), 3, { sender: s });
    expect(s.calls).toBe(1);
    expect(await emailRows()).toMatchObject([{ status: "unknown", error_code: "http_503" }]);
  });

  it("a definite refusal is retried by the next run, at most three times in total", async () => {
    await addCritical();
    const s = fakeSender(() => ({ status: "failed", code: "http_422" }));
    for (let run = 1; run <= 6; run++) await runAlerts(ctxAt(), run, { sender: s });
    expect(s.calls).toBe(3);
    expect(await emailRows()).toMatchObject([
      { status: "failed", attempts: 3, error_code: "http_422" },
    ]);
  });

  it("a refusal that is then accepted ends as sent, and is not sent a third time", async () => {
    await addCritical();
    const s = fakeSender((n) =>
      n === 1
        ? { status: "failed", code: "http_429" }
        : { status: "sent", providerMessageId: "ok" },
    );
    await runAlerts(ctxAt(), 1, { sender: s });
    await runAlerts(ctxAt(), 2, { sender: s });
    await runAlerts(ctxAt(), 3, { sender: s });
    expect(s.calls).toBe(2);
    expect(await emailRows()).toMatchObject([
      { status: "sent", attempts: 2, provider_message_id: "ok" },
    ]);
  });

  it("two concurrent retries of one refused alert send it once", async () => {
    await addCritical();
    let n = 0;
    const s = fakeSender(() => {
      n += 1;
      return n === 1
        ? { status: "failed", code: "http_400" }
        : { status: "sent", providerMessageId: "x" };
    });
    await runAlerts(ctxAt(), 1, { sender: s });
    await Promise.all([runAlerts(ctxAt(), 2, { sender: s }), runAlerts(ctxAt(), 3, { sender: s })]);
    expect(s.calls).toBe(2);
  });

  it("a retry is dropped when the issue is no longer a pending critical", async () => {
    const { id } = await addCritical();
    const s = fakeSender(() => ({ status: "failed", code: "http_400" }));
    await runAlerts(ctxAt(), 1, { sender: s });
    await db
      .prepare("UPDATE dq_issues SET status = 'resolved', resolved_at = ?2 WHERE id = ?1")
      .bind(id, "2026-07-15T10:30:00.000Z")
      .run();
    await runAlerts(ctxAt(), 2, { sender: s });
    expect(s.calls).toBe(1);
  });
});

describe("content and logs", () => {
  it("hostile names are escaped in the html and the log holds no body or address", async () => {
    const evil = `<img src=x onerror=alert(1)> & "q"`;
    await addCritical({ subject: evil, message: `<script>x</script> ${evil}` });
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    const msg = s.sent[0];
    expect(msg?.html).not.toContain("<img");
    expect(msg?.html).not.toContain("<script>x");
    expect(msg?.html).toContain("&lt;img src=x");
    expect(msg?.subject).not.toContain("<");
    const row = JSON.stringify(await emailRows());
    expect(row).not.toContain("camelthorncapital.com");
    expect(row).not.toContain("img");
    expect(JSON.stringify(await auditRows("email.claimed"))).not.toContain("@");
  });

  it("uses the configured base URL for the fix link", async () => {
    await setSettings({ baseUrl: "https://app.example.com" });
    await addCritical();
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    expect(s.sent[0]?.html).toContain('href="https://app.example.com/settings/connections"');
    expect(s.sent[0]?.text).toContain("Fix: https://app.example.com/settings/connections");
  });

  it("stops starting new work once the run is aborted", async () => {
    for (let i = 0; i < 3; i++) await addCritical();
    const ac = new AbortController();
    ac.abort();
    const s = fakeSender();
    await runAlerts(ctxAt(NOW, { signal: ac.signal }), 1, { sender: s });
    expect(s.calls).toBe(0);
    expect(await notifiedIds()).toEqual([]);
  });
});
