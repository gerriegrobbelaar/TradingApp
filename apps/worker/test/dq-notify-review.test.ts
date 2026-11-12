/**
 * Review D8b: adversarial cases for the notifications (ADR 0046) — recipient look-alikes, sender
 * hardening (SSRF host forms, header injection, hostile answers), retry starvation, and an issue
 * whose alert key already exists never taking a single-alert slot again.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { runAlerts } from "../src/dq/alerts";
import { isAllowedRecipient } from "../src/dq/notify-settings";
import { httpsSender } from "../src/email/sender";
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

const D = "camelthorncapital.com";

describe("recipient allow-list", () => {
  it.each([
    "x@evilcamelthorncapital.com",
    "x@camelthorncapital.com.evil.com",
    "x@sub.camelthorncapital.com",
    "x@camelthorncapital.co",
    "x@camelthorncapital.com.",
    "x@camelthorncapitaI.com".replace("I", "Ι"),
    "Kelvin@camelthorncapital.com",
    "x\r\nbcc: y@camelthorncapital.com",
    "x\n@camelthorncapital.com",
    "x y@camelthorncapital.com",
    '"x y"@camelthorncapital.com',
    "x,y@camelthorncapital.com",
    "Name <x@camelthorncapital.com>",
    "x@y@camelthorncapital.com",
    ".x@camelthorncapital.com",
    "x.@camelthorncapital.com",
    "x..y@camelthorncapital.com",
    "@camelthorncapital.com",
    "x(comment)@camelthorncapital.com",
    "",
  ])("rejects %j", (addr) => {
    expect(isAllowedRecipient(addr, D)).toBe(false);
  });

  it.each([
    "x@camelthorncapital.com",
    "X.Y@CamelthornCapital.com",
    "x+alerts@camelthorncapital.com",
    "  x@camelthorncapital.com ",
  ])("accepts %j", (addr) => {
    expect(isAllowedRecipient(addr, D)).toBe(true);
  });

  it("an empty allowed domain allows nobody", () => {
    expect(isAllowedRecipient("x@camelthorncapital.com", "")).toBe(false);
  });
});

describe("https sender hardening", () => {
  const msg = { to: ["a@camelthorncapital.com"], subject: "S", html: "h", text: "t" };
  const never: typeof fetch = () => {
    throw new Error("fetch must not be called");
  };
  const mk = (host: string, fetchFn: typeof fetch = never, from = "alerts@camelthorncapital.com") =>
    httpsSender({ host, from, apiKey: "KEY", fetchFn });

  it.each([
    "0x7f.0x1",
    "127.0.0.1",
    "017700000001.0",
    "localhost",
    "mail.localhost",
    "metadata.google.internal",
    "router.home.arpa",
    "api.example.com:8443",
    "user@api.example.com",
    "api.example.com/emails?x=",
    "[::1]",
    "",
  ])("never sends the key to host %j", async (host) => {
    expect(await mk(host).send(msg)).toEqual({ status: "failed", code: "bad_host" });
  });

  it("refuses a header-injecting recipient, sender or subject without calling the provider", async () => {
    for (const m of [
      { ...msg, to: ["a@camelthorncapital.com\r\nBcc: b@evil.com"] },
      { ...msg, to: ["A <a@camelthorncapital.com>"] },
      { ...msg, subject: "S\r\nBcc: b@evil.com" },
      { ...msg, subject: "S x" },
    ]) {
      expect(await mk("api.mail.example.com").send(m)).toEqual({
        status: "failed",
        code: "bad_message",
      });
    }
    expect(await mk("api.mail.example.com", never, "a@b.com\r\nx: y").send(msg)).toEqual({
      status: "failed",
      code: "bad_message",
    });
  });

  it.each([
    ["not json", "<html>ok</html>"],
    ["null", "null"],
    ["array", '[{"id":"x"}]'],
    ["prototype", '{"__proto__":{"id":"proto"}}'],
    ["id with a newline", '{"id":"a\\nb"}'],
    ["id too long", JSON.stringify({ id: "x".repeat(201) })],
    ["id not a string", '{"id":42}'],
    ["huge body", JSON.stringify({ id: "ok", pad: "x".repeat(100_000) })],
  ])("an accepted message with a hostile answer (%s) is sent, id null", async (_n, body) => {
    const r = await mk("api.mail.example.com", () =>
      Promise.resolve(new Response(body, { status: 202 })),
    ).send(msg);
    expect(r).toEqual({ status: "sent", providerMessageId: null });
  });

  it("classifies redirects, 408 and 5xx as unknown, other 4xx as failed", async () => {
    const at = (status: number) =>
      mk("api.mail.example.com", () =>
        Promise.resolve(new Response(null, { status, headers: { location: "https://x.y/" } })),
      ).send(msg);
    expect(await at(302)).toEqual({ status: "unknown", code: "http_302" });
    expect(await at(408)).toEqual({ status: "unknown", code: "http_408" });
    expect(await at(503)).toEqual({ status: "unknown", code: "http_503" });
    expect(await at(429)).toEqual({ status: "failed", code: "http_429" });
    expect(await at(401)).toEqual({ status: "failed", code: "http_401" });
  });
});

describe("alert retries and slots", () => {
  beforeEach(async () => {
    await resetDb();
    await resetDq();
    await seedUsers();
  });

  it("refusals for issues that are no longer pending never starve the retry of a pending one", async () => {
    // 25 refused alerts whose issues were resolved since: older rows than the one that matters.
    for (let i = 0; i < 25; i += 1) {
      const gone = await addCritical({ status: "resolved" });
      await db
        .prepare(
          `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, attempts,
             dq_issue_id, error_code, created_at, updated_at)
           VALUES (?1, 'dq_alert', 'dq.alert.v1', 2, 'failed', 1, ?2, 'http_429', ?3, ?3)`,
        )
        .bind(`dq-alert:${gone.fingerprint}:0`, gone.id, new Date(NOW - 7_200_000).toISOString())
        .run();
    }
    const s1 = fakeSender((n) =>
      n === 1 ? { status: "failed", code: "http_429" } : { status: "sent", providerMessageId: "m" },
    );
    const live = await addCritical();
    await runAlerts(ctxAt(), 1, { sender: s1 });
    expect(s1.calls).toBe(1);
    const out = await runAlerts(ctxAt(NOW + 3_600_000), 2, { sender: s1 });
    expect(out.retried).toBe(1);
    expect(s1.calls).toBe(2);
    expect((await emailRows(`dq_issue_id = ${live.id}`))[0]).toMatchObject({
      status: "sent",
      attempts: 2,
    });
  });

  it("an issue whose alert key exists is marked, never sent again, and keeps no slot", async () => {
    // Ten issues that were alerted in this life but lost notified_at (for example by a snooze that
    // ended under the D8a code): with maxAlertsPerRun 10 they would take every single slot.
    for (let i = 0; i < 10; i += 1) {
      const a = await addCritical({ firstSeenAt: new Date(NOW - 10 * 86_400_000).toISOString() });
      await db
        .prepare(
          `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, attempts,
             dq_issue_id, created_at, updated_at)
           VALUES (?1, 'dq_alert', 'dq.alert.v1', 2, 'sent', 1, ?2, ?3, ?3)`,
        )
        .bind(`dq-alert:${a.fingerprint}:0`, a.id, new Date(NOW - 86_400_000).toISOString())
        .run();
    }
    const fresh = await addCritical({ subject: "Brand new" });
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(s.calls).toBe(1);
    expect(out).toMatchObject({ alerted: 1, folded: 0, lostClaims: 0, candidates: 1 });
    expect(s.sent[0]?.text).toContain("Brand new");
    expect(await notifiedIds()).toHaveLength(11);
    expect((await notifiedIds()).includes(fresh.id)).toBe(true);
  });

  it("the end of a snooze does not alert the issue a second time", async () => {
    const a = await addCritical();
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    expect(s.calls).toBe(1);
    // What the reconcile does when a snooze ends (store.ts unsnooze) — notified_at is kept now.
    await db
      .prepare(
        "UPDATE dq_issues SET status = 'snoozed', snoozed_until = '2026-07-16T00:00:00.000Z' WHERE id = ?1",
      )
      .bind(a.id)
      .run();
    await db
      .prepare(
        "UPDATE dq_issues SET status = 'open', snoozed_until = NULL, notified_at = NULL WHERE id = ?1",
      )
      .bind(a.id)
      .run();
    const out = await runAlerts(ctxAt(NOW + 86_400_000), 2, { sender: s });
    expect(s.calls).toBe(1);
    expect(out.lostClaims).toBe(0);
    expect(await notifiedIds()).toEqual([a.id]);
  });
});
