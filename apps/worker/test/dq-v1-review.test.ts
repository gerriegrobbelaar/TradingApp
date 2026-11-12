/**
 * Reviewer's adversarial cases for task V1: no duplicate and no lost alert across races, crashes and
 * give-backs (B1); the cooldown leaves issues to the digest, which really lists them (N2); a 429 ends
 * the run and retries stay bounded (S3); spacing is bounded and never real time in tests; the
 * freshness gate fails closed (S5).
 */
import { MAX_EMAIL_ATTEMPTS, MAX_ALERTS_LIMIT } from "@camelthorn/core";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { RETRY_BACKOFF_MS, runAlerts } from "../src/dq/alerts";
import { loadDigestData, runDigest } from "../src/dq/digest";
import { SETTING_NOTIFICATIONS } from "../src/dq/notify-settings";
import { SEND_SPACING_MS } from "../src/email/sender";
import { db, flakyDb, resetDq, ruleStatus, runDq } from "./dq-helpers";
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
import { resetWorld, type World } from "./matching-helpers";

const MIN = 60_000;
let w: World;

async function setNotify(v: Record<string, unknown>): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO settings (key, value_json, updated_by) VALUES (?1, ?2, 't')")
    .bind(SETTING_NOTIFICATIONS, JSON.stringify(v))
    .run();
}

async function notifiedAt(id: number): Promise<string | null> {
  return (
    (
      await db
        .prepare("SELECT notified_at AS n FROM dq_issues WHERE id = ?1")
        .bind(id)
        .first<{ n: string | null }>()
    )?.n ?? null
  );
}

beforeEach(async () => {
  await resetDb();
  await resetDq();
  w = await resetWorld();
  await seedUsers();
});

describe("B1 races and crashes (reviewer)", () => {
  it("two concurrent runs send every issue exactly once", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push((await addCritical()).id);
    const s = fakeSender();
    const [a, b] = await Promise.all([
      runAlerts(ctxAt(NOW), 1, { sender: s }),
      runAlerts(ctxAt(NOW + 1), 2, { sender: s }),
    ]);
    expect(a.alerted + b.alerted).toBe(6);
    expect(s.calls).toBe(6);
    const keys = (await emailRows("kind = 'dq_alert'")).map((r) => r.idempotency_key).sort();
    expect(keys).toEqual(ids.map((id) => `dq-alert:${id}:0`).sort());
    expect(await notifiedIds()).toEqual(ids);
  });

  it("an issue another run marked (folded into its summary) after this run listed it is not sent singly", async () => {
    const one = await addCritical();
    const two = await addCritical();
    const theirs = "2026-07-15T10:00:00.456Z";
    const s = fakeSender(async (n) => {
      if (n === 1) {
        // Meanwhile a concurrent run claims issue two in its summary.
        await db
          .prepare("UPDATE dq_issues SET notified_at = ?2 WHERE id = ?1")
          .bind(two.id, theirs)
          .run();
      }
      return { status: "sent", providerMessageId: `m${n}` };
    });
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out).toMatchObject({ alerted: 1, lostClaims: 1 });
    expect(s.calls).toBe(1);
    expect((await emailRows("kind = 'dq_alert'")).map((r) => r.dq_issue_id)).toEqual([one.id]);
    expect(await notifiedAt(two.id)).toBe(theirs);
  });

  it("a sender that throws (crash between claim and answer) is never sent again", async () => {
    const { id } = await addCritical();
    const s = fakeSender(() => {
      throw new Error("isolate died");
    });
    const a = await runAlerts(ctxAt(), 1, { sender: s });
    expect(a).toMatchObject({ alerted: 1, unknown: 1, sent: 0 });
    for (let i = 1; i <= 3; i++) {
      await runAlerts(ctxAt(NOW + i * 30 * MIN), 1 + i, { sender: s });
    }
    expect(s.calls).toBe(1);
    expect(await notifiedIds()).toEqual([id]);
    expect((await emailRows("kind = 'dq_alert'")).map((r) => r.status)).toEqual(["unknown"]);
  });

  it("a claim row left behind with notified_at lost is swept and marks the issue, not a second mail", async () => {
    const { id } = await addCritical();
    await db
      .prepare(
        `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, dq_issue_id, created_at, updated_at)
         VALUES (?1, 'dq_alert', 'dq.alert.v1', 2, 'claimed', ?2, ?3, ?3)`,
      )
      .bind(`dq-alert:${id}:0`, id, new Date(NOW - 40 * MIN).toISOString())
      .run();
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out.staleSwept).toBe(1);
    expect(s.calls).toBe(0);
    expect(await notifiedIds()).toEqual([id]);
  });

  it("a reopened issue is a new life: alerted again under a new key once the cooldown is over", async () => {
    const { id } = await addCritical();
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    await db
      .prepare(
        "UPDATE dq_issues SET reopen_count = reopen_count + 1, notified_at = NULL WHERE id = ?1",
      )
      .bind(id)
      .run();
    await runAlerts(ctxAt(NOW + 25 * 60 * MIN), 2, { sender: s });
    expect(s.calls).toBe(2);
    expect((await emailRows("kind = 'dq_alert'")).map((r) => r.idempotency_key)).toEqual([
      `dq-alert:${id}:0`,
      `dq-alert:${id}:1`,
    ]);
  });

  it("a refused summary gives back only the marks it set, not one another run set meanwhile", async () => {
    await setNotify({ maxAlertsPerRun: 1 });
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await addCritical()).id);
    const other = "2026-07-15T10:00:00.123Z";
    const s = fakeSender(async (_n, m) => {
      if (/more critical data issues/.test(m.subject)) {
        // While the summary is in flight, another run takes one of its issues (as if it had been
        // reopened and claimed again: a different mark).
        await db
          .prepare("UPDATE dq_issues SET notified_at = ?2 WHERE id = ?1")
          .bind(ids[3], other)
          .run();
        return { status: "failed", code: "http_422" };
      }
      return { status: "sent", providerMessageId: "m" };
    });
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out).toMatchObject({ alerted: 1, folded: 3, summaries: 1, failed: 1 });
    expect(await notifiedAt(ids[1] as number)).toBeNull();
    expect(await notifiedAt(ids[2] as number)).toBeNull();
    expect(await notifiedAt(ids[3] as number)).toBe(other);
  });

  it("a provider that refuses every summary does not keep the backlog pending for ever", async () => {
    await setNotify({ maxAlertsPerRun: 2 });
    for (let i = 0; i < 6; i++) await addCritical();
    // Singles are refused definitely (and retried up to the limit), summaries are refused too.
    const s = fakeSender(() => ({ status: "failed", code: "http_401" }));
    for (let run = 0; run < 30; run++) {
      await runAlerts(ctxAt(NOW + run * 20 * MIN), run + 1, { sender: s });
    }
    const pending = (
      await db
        .prepare("SELECT COUNT(*) AS n FROM dq_issues WHERE notified_at IS NULL")
        .first<{ n: number }>()
    )?.n;
    expect(pending).toBe(0);
    for (const r of await emailRows("kind = 'dq_alert'")) {
      expect(r.attempts).toBeLessThanOrEqual(MAX_EMAIL_ATTEMPTS);
    }
    const callsAfter = s.calls;
    await runAlerts(ctxAt(NOW + 40 * 20 * MIN), 99, { sender: s });
    expect(s.calls).toBe(callsAfter);
  });
});

describe("N2 cooldown is left to the digest, and the digest lists it (reviewer)", () => {
  it("a cooled-down critical is counted and listed in the digest data", async () => {
    const { id } = await addCritical({ subject: "Exact connection expired" });
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    await db
      .prepare(
        "UPDATE dq_issues SET reopen_count = reopen_count + 1, notified_at = NULL WHERE id = ?1",
      )
      .bind(id)
      .run();
    const out = await runAlerts(ctxAt(NOW + 60 * MIN), 2, { sender: s });
    expect(out.suppressed).toBe(1);
    await addCheckRun(NOW + 50 * MIN);
    const d = await loadDigestData(db, NOW + 61 * MIN);
    expect(d.bySeverity.critical).toBe(1);
    expect(d.top.map((t) => t.subject)).toContain("Exact connection expired");
  });

  it("the cooldown never touches another administration's issue nor a rule that is not evaluated", async () => {
    const fp = "integrations.exact_connection:exact";
    const a = await addCritical({ fingerprint: fp, divisionId: 1 });
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    const b = await addCritical({ fingerprint: fp, divisionId: 2 });
    const out = await runAlerts(ctxAt(NOW + 20 * MIN), 2, { sender: s });
    expect(out).toMatchObject({ suppressed: 0, alerted: 1 });
    expect(await notifiedIds()).toEqual([a.id, b.id]);
    // A reopened issue whose rule is not evaluated now is neither alerted nor marked by the cooldown.
    await db
      .prepare("UPDATE dq_issues SET reopen_count = 1, notified_at = NULL WHERE id = ?1")
      .bind(a.id)
      .run();
    await db
      .prepare(
        "UPDATE dq_rule_status SET status = 'not_available', reason = 'no_data', issue_count = 0 WHERE division_id = 1",
      )
      .run();
    const later = await runAlerts(ctxAt(NOW + 40 * MIN), 3, { sender: s });
    expect(later.suppressed).toBe(0);
    expect(await notifiedAt(a.id)).toBeNull();
  });
});

describe("S3 rate limits and spacing (reviewer)", () => {
  it("a provider that answers 429 for ever: at most MAX_EMAIL_ATTEMPTS sends, spaced by the backoff", async () => {
    await addCritical();
    const s = fakeSender(() => ({ status: "failed", code: "http_429" }));
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      const t = NOW + i * 5 * MIN;
      const before = s.calls;
      await runAlerts(ctxAt(t), i + 1, { sender: s });
      if (s.calls > before) times.push(t);
    }
    expect(s.calls).toBe(MAX_EMAIL_ATTEMPTS);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(
        RETRY_BACKOFF_MS,
      );
    }
    const [row] = await emailRows("kind = 'dq_alert'");
    expect(row).toMatchObject({ status: "failed", attempts: MAX_EMAIL_ATTEMPTS });
  });

  it("a 429 on a retry stops the run before any new issue is claimed", async () => {
    const first = await addCritical();
    let refuse = true;
    const s = fakeSender(() =>
      refuse ? { status: "failed", code: "http_429" } : { status: "sent", providerMessageId: "m" },
    );
    await runAlerts(ctxAt(), 1, { sender: s });
    const second = await addCritical();
    const out = await runAlerts(ctxAt(NOW + 16 * MIN), 2, { sender: s });
    expect(out).toMatchObject({ retried: 1, rateLimited: true, alerted: 0 });
    expect(await notifiedAt(second.id)).toBeNull();
    refuse = false;
    await runAlerts(ctxAt(NOW + 32 * MIN), 3, { sender: s });
    expect(await notifiedIds()).toEqual([first.id, second.id]);
    expect((await emailRows("status = 'sent'")).length).toBe(2);
  });

  it("the longest run waits (cap) x spacing: bounded and far inside the run time limit", async () => {
    await setNotify({ maxAlertsPerRun: MAX_ALERTS_LIMIT });
    for (let i = 0; i < MAX_ALERTS_LIMIT + 10; i++) await addCritical();
    const s = Object.assign(fakeSender(), { spacingMs: SEND_SPACING_MS });
    const waits: number[] = [];
    const out = await runAlerts(ctxAt(), 1, {
      sender: s,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(out).toMatchObject({ alerted: MAX_ALERTS_LIMIT, summaries: 1, folded: 10 });
    // One pause between two mails, none before the first.
    expect(waits).toHaveLength(MAX_ALERTS_LIMIT);
    expect(waits.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(60_000);
  });

  it("the digest spaces its mails with the seam (no real timer), and stops at a 429", async () => {
    await addCheckRun();
    const s = Object.assign(fakeSender(), { spacingMs: SEND_SPACING_MS });
    const waits: number[] = [];
    const ok = await runDigest(ctxAt(), {
      sender: s,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(ok.status).toBe("ok");
    expect(s.calls).toBeGreaterThanOrEqual(2);
    expect(waits).toEqual(Array.from({ length: s.calls - 1 }, () => SEND_SPACING_MS));

    // The next day: new keys (the log of today cannot be deleted).
    await addCheckRun(NOW + 24 * 60 * MIN - 30 * MIN);
    const limited = Object.assign(
      fakeSender(() => ({ status: "failed", code: "http_429" })),
      { spacingMs: 1 },
    );
    const waits2: number[] = [];
    const r = await runDigest(ctxAt(NOW + 24 * 60 * MIN), {
      sender: limited,
      sleep: (ms) => {
        waits2.push(ms);
        return Promise.resolve();
      },
    });
    expect(limited.calls).toBe(1);
    expect(waits2).toEqual([]);
    expect(r).toMatchObject({ status: "partial", code: "send_failed" });
  });
});

describe("S5 freshness fails closed (reviewer)", () => {
  it("a freshness read that fails leaves every gated section out; nothing is ok and nothing resolves", async () => {
    await runDq();
    expect(await ruleStatus("payables.duplicate_invoices", w.divisionId)).toMatchObject({
      status: "ok",
    });
    const broken = { ...env, DB: flakyDb("'relation_ibans', 'purchase_entries', 'gl_balances')") };
    await runDq({ now: () => NOW + MIN }, broken);
    for (const rule of [
      "payables.duplicate_invoices",
      "master.supplier_no_iban",
      "bank.unmatched_old",
    ]) {
      expect(await ruleStatus(rule, w.divisionId), rule).toMatchObject({
        status: "not_available",
        reason: "source_stale",
      });
    }
  });
});
