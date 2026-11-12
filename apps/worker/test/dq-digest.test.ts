/**
 * The daily digest job (ADR 0046), the e-mail retention rule, and the D8a housekeeping that resolves
 * issues of administrations that are no longer synchronised.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { loadDigestData, runDigest } from "../src/dq/digest";
import { SETTING_NOTIFICATIONS } from "../src/dq/notify-settings";
import { pruneEmailLog } from "../src/email/log";
import { addUser, resetDb } from "./helpers";
import { db, dqContext, issues, resetDq, runDq } from "./dq-helpers";
import { addCritical, ctxAt, emailRows, fakeSender, NOW, seedUsers } from "./dq-notify-helpers";
import { addItem, addRelation, resetWorld, type World } from "./matching-helpers";
import { auditRows } from "./sync-helpers";

const DAY = 86_400_000;
let w: World;

beforeEach(async () => {
  await resetDb();
  await resetDq();
  w = await resetWorld();
  await seedUsers();
});

describe("dq.digest", () => {
  it("sends nothing without a sender and records skipped_not_configured once per day", async () => {
    await addCritical();
    const a = await runDigest(ctxAt());
    const b = await runDigest(ctxAt(NOW + 3_600_000));
    expect(a).toMatchObject({ status: "skipped", code: "email_not_configured" });
    expect(b.code).toBe("email_not_configured");
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "dq_digest",
      status: "skipped_not_configured",
      error_code: "not_configured",
    });
  });

  it("sends one e-mail per recipient with the content the brief asks for", async () => {
    await addCritical({
      subject: "Exact connection",
      firstSeenAt: new Date(NOW - 10 * DAY).toISOString(),
    });
    await addCritical({ severity: "warning", subject: "Late bank line" });
    await addCritical({ status: "snoozed" });
    const s = fakeSender();
    const res = await runDigest(ctxAt(), { sender: s });
    expect(res).toMatchObject({ status: "ok", summary: { recipients: 2, sent: 2 } });
    expect(s.sent.map((m) => m.to.join()).sort()).toEqual([
      "admin@camelthorncapital.com",
      "fin@camelthorncapital.com",
    ]);
    const m = s.sent[0]!;
    expect(m.subject).toBe("2 open data quality issues, 1 critical");
    expect(m.text).toContain("1 critical, 1 warning, 0 info. 1 new since yesterday. 1 snoozed.");
    expect(m.text).toContain("Integrations: 1 critical, 1 warning, 0 info");
    expect(m.text).toContain("open for 10 days (critical)");
    expect(m.text).toContain("[critical] ");
    expect(m.text).toContain("Fix in the app: /settings/connections");
    expect(m.html).toContain("<h3>By area</h3>");
    expect(m.text + m.html).not.toContain("<img");
    const rows = await emailRows();
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r) => r.kind === "dq_digest" && r.status === "sent" && r.recipients_count === 1),
    ).toBe(true);
  });

  it("is idempotent per recipient and day, and sends again the next day", async () => {
    await addCritical();
    const s = fakeSender();
    await runDigest(ctxAt(), { sender: s });
    const again = await runDigest(ctxAt(NOW + 3_600_000), { sender: s });
    expect(again.summary).toMatchObject({ sent: 0, already: 2 });
    expect(s.calls).toBe(2);
    await runDigest(ctxAt(NOW + DAY), { sender: s });
    expect(s.calls).toBe(4);
  });

  it("two concurrent runs send each recipient's digest once", async () => {
    await addCritical();
    const s = fakeSender();
    await Promise.all([runDigest(ctxAt(), { sender: s }), runDigest(ctxAt(), { sender: s })]);
    expect(s.calls).toBe(2);
    expect(await emailRows()).toHaveLength(2);
  });

  it("a refused recipient is retried alone; an unclear one is never retried", async () => {
    await addCritical();
    let failOnce = true;
    const s = fakeSender((_n, msg) => {
      if (msg.to[0] === "admin@camelthorncapital.com" && failOnce) {
        failOnce = false;
        return { status: "failed", code: "http_429" };
      }
      if (msg.to[0] === "fin@camelthorncapital.com") return { status: "unknown", code: "timeout" };
      return { status: "sent", providerMessageId: "m" };
    });
    const first = await runDigest(ctxAt(), { sender: s });
    expect(first).toMatchObject({
      status: "partial",
      code: "send_failed",
      retry: { delaySeconds: 600 },
    });
    const second = await runDigest(ctxAt(NOW + 600_000), { sender: s });
    expect(second).toMatchObject({ status: "ok", summary: { sent: 1, already: 1, unknown: 0 } });
    // admin: 2 sends in total (refused, then accepted); fin: 1 (unknown, never again)
    expect(s.sent.filter((m) => m.to[0] === "admin@camelthorncapital.com")).toHaveLength(2);
    expect(s.sent.filter((m) => m.to[0] === "fin@camelthorncapital.com")).toHaveLength(1);
  });

  it("escapes hostile issue and rule text", async () => {
    await addCritical({ subject: `<script>alert(1)</script>`, message: `"><img src=x>` });
    const s = fakeSender();
    await runDigest(ctxAt(), { sender: s });
    expect(s.sent[0]?.html).not.toContain("<script>alert");
    expect(s.sent[0]?.html).not.toContain("<img src=x>");
    expect(s.sent[0]?.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("lists the rules that were not evaluated with their reasons", async () => {
    await db
      .prepare(
        `INSERT INTO dq_rule_status (division_id, rule_id, status, reason, evaluated_at)
         VALUES (0, 'ledger.closed_period_bookings', 'not_available', 'no_closed_period_marker', '2026-07-15T09:00:00.000Z'),
                (0, 'master.vat_code_country', 'not_configured', 'vat_code_not_synced', '2026-07-15T09:00:00.000Z')`,
      )
      .run();
    const d = await loadDigestData(db, NOW);
    expect(d.notEvaluated.map((n) => n.reason).sort()).toEqual([
      "no_closed_period_marker",
      "vat_code_not_synced",
    ]);
    const s = fakeSender();
    await runDigest(ctxAt(), { sender: s });
    expect(s.sent[0]?.text).toContain("No closed period marker");
    expect(s.sent[0]?.text).toContain("2 rules were not evaluated");
  });

  it("an empty day still reports the number", async () => {
    const s = fakeSender();
    await runDigest(ctxAt(), { sender: s });
    expect(s.sent[0]?.subject).toBe("0 open data quality issues");
  });

  it("is quiet when notifications are switched off, and with no qualifying user", async () => {
    await db
      .prepare("INSERT INTO settings (key, value_json) VALUES (?1, ?2)")
      .bind(SETTING_NOTIFICATIONS, JSON.stringify({ enabled: false }))
      .run();
    const s = fakeSender();
    expect(await runDigest(ctxAt(), { sender: s })).toMatchObject({
      code: "notifications_disabled",
    });
    await db.prepare("DELETE FROM settings WHERE key = ?1").bind(SETTING_NOTIFICATIONS).run();
    await db.batch([db.prepare("DELETE FROM user_roles"), db.prepare("DELETE FROM users")]);
    await addUser("only.viewer@camelthorncapital.com", ["viewer"]);
    expect(await runDigest(ctxAt(), { sender: s })).toMatchObject({ code: "no_recipients" });
    expect(s.calls).toBe(0);
    expect((await emailRows()).map((r) => r.error_code)).toEqual(["no_recipients"]);
  });

  it("the result summary holds counts only", async () => {
    await addCritical();
    const res = await runDigest(ctxAt(), { sender: fakeSender() });
    for (const v of Object.values(res.summary)) expect(typeof v).toBe("number");
  });
});

describe("e-mail log retention", () => {
  it("deletes rows older than 400 days and keeps the rest", async () => {
    const mk = (key: string, ageDays: number): Promise<unknown> =>
      db
        .prepare(
          `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, created_at, updated_at)
           VALUES (?1, 'dq_digest', 'dq.digest.v1', 1, 'sent', ?2, ?2)`,
        )
        .bind(key, new Date(Date.now() - ageDays * DAY).toISOString())
        .run();
    await mk("old-1", 500);
    await mk("old-2", 401);
    await mk("keep-1", 399);
    await mk("keep-2", 10);
    const n = await pruneEmailLog(db, Date.now());
    expect(n).toBe(2);
    expect((await emailRows()).map((r) => r.idempotency_key)).toEqual(["keep-1", "keep-2"]);
  });
});

describe("dq.checks with alerts and housekeeping", () => {
  async function seedCriticalIbanChange(): Promise<void> {
    const rel = await addRelation({
      divisionId: w.divisionId,
      ibans: [],
      ibanChangedAt: "2026-07-10T00:00:00.000Z",
    });
    await addItem({
      divisionId: w.divisionId,
      kind: "bill",
      invoiceNumber: "F-1",
      openMinor: 10_000,
      relationExactId: rel.exactId,
      relationName: "Acme B.V.",
    });
  }

  it("alerts a new critical issue once, in the same run that found it", async () => {
    await seedCriticalIbanChange();
    const s = fakeSender();
    const deps = {
      describeHandler: (h: string) => ({ title: h, implemented: true }),
      alerts: { sender: s },
    };
    const { runDqChecks } = await import("../src/dq/run");
    const first = await runDqChecks(
      dqContext({
        run: {
          id: 11,
          attempt: 1,
          scheduledFor: new Date(NOW).toISOString(),
          requestedBy: "system",
        },
      }),
      deps,
    );
    const critical = (await issues("severity = 'critical' AND status = 'open'")).filter(
      (i) => i.rule_id === "payables.supplier_iban_changed",
    );
    expect(critical).toHaveLength(1);
    expect(first.summary["alertsSent"]).toBeGreaterThanOrEqual(1);
    const sentAfterFirst = s.calls;
    expect(sentAfterFirst).toBeGreaterThanOrEqual(1);
    await runDqChecks(
      dqContext({
        run: {
          id: 12,
          attempt: 1,
          scheduledFor: new Date(NOW).toISOString(),
          requestedBy: "system",
        },
      }),
      deps,
    );
    expect(s.calls).toBe(sentAfterFirst);
    expect(s.sent.some((m) => m.subject.includes("Supplier"))).toBe(true);
  });

  it("an alert failure never fails the checks", async () => {
    await seedCriticalIbanChange();
    const bad = new Proxy(env, {
      get(t, p) {
        if (p === "ALLOWED_HD") throw new Error("boom");
        return Reflect.get(t, p) as unknown;
      },
    });
    const res = await runDq({ env: bad });
    expect(res.status).toBe("ok");
    expect(res.summary["alertsError"]).toBe(1);
    expect((await issues("status = 'open'")).length).toBeGreaterThan(0);
  });

  it("resolves open issues of administrations that are no longer synchronised, with a reason and an audit row", async () => {
    await seedCriticalIbanChange();
    await runDq();
    const open = (await issues("division_id = " + w.divisionId + " AND status = 'open'")).length;
    expect(open).toBeGreaterThan(0);
    const globalBefore = (await issues("division_id = 0 AND status = 'open'")).length;
    await db
      .prepare("UPDATE divisions SET sync_enabled = 0 WHERE id = ?1")
      .bind(w.divisionId)
      .run();
    const res = await runDq();
    expect(res.summary["resolvedUnsynced"]).toBe(open);
    const rows = await issues("division_id = " + w.divisionId);
    expect(rows.every((r) => r.status === "resolved" && r.resolved_by === "system")).toBe(true);
    const note = await db
      .prepare(
        "SELECT DISTINCT resolution_note AS n FROM dq_issues WHERE division_id = ?1 AND resolved_by = 'system' AND resolution_note IS NOT NULL",
      )
      .bind(w.divisionId)
      .all<{ n: string }>();
    expect(note.results.map((r) => r.n)).toEqual(["division_not_synchronised"]);
    expect((await issues("division_id = 0 AND status = 'open'")).length).toBeGreaterThanOrEqual(
      globalBefore,
    );
    const stale = await db
      .prepare("SELECT COUNT(*) AS n FROM dq_rule_status WHERE division_id = ?1")
      .bind(w.divisionId)
      .first<{ n: number }>();
    expect(stale?.n).toBe(0);
    expect((await auditRows("dq.unsynced_resolved")).length).toBeGreaterThanOrEqual(1);
    // A second run changes nothing more.
    const again = await runDq();
    expect(again.summary["resolvedUnsynced"]).toBe(0);
  });
});
