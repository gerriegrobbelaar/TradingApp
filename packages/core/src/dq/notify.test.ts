import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  alertKey,
  applySettingsPatch,
  emptyDigest,
  escapeHtml,
  normalizeBaseUrl,
  normalizeEmailHost,
  normalizeFromAddress,
  oneLine,
  parseStoredSettings,
  renderAlert,
  renderAlertSummary,
  renderDigest,
  type DigestData,
} from "./notify";

const HOSTILE = `<script>alert("x")</script> & "Bob's" <img src=x onerror=1>`;

describe("escaping and header safety", () => {
  it("escapes the five HTML characters", () => {
    expect(escapeHtml(`<a href="x">'&</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;",
    );
  });
  it("oneLine removes line breaks and bidi controls (no header injection)", () => {
    expect(oneLine("a\r\nBcc: x@evil.test‮ b")).not.toMatch(/[\r\n‮]/);
  });
});

describe("alert rendering", () => {
  const base = {
    ruleTitle: "Supplier bank details changed",
    area: "payables" as const,
    subject: HOSTILE,
    message: `3 changes ${HOSTILE}`,
    fixPath: "/purchases/payables",
    reopenCount: 1,
    firstSeenAt: "2026-11-12T08:00:00.000Z",
  };
  it("escapes hostile names in html and keeps them verbatim in text", () => {
    const r = renderAlert(base, "https://app.example.com");
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.text).toContain(HOSTILE);
    expect(r.html).toContain('href="https://app.example.com/purchases/payables"');
  });
  it("leads with the number, has no exclamation mark and no tracking", () => {
    const r = renderAlert(base, "");
    expect(r.subject.startsWith("1 critical data issue")).toBe(true);
    expect((r.subject + r.html + r.text).replace("<!doctype html>", "")).not.toContain("!");
    expect(r.html).not.toMatch(/<img|<link|<script|url\(/i);
    expect(r.text).toContain("Fix in the app: /purchases/payables");
    expect(r.text).toContain("came back");
  });
  it("subject never carries untrusted text", () => {
    expect(renderAlert(base, "").subject).not.toContain("script");
  });
  it("summary states the total and caps the list at ten", () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ ruleTitle: "R", subject: `S${i}` }));
    const r = renderAlertSummary({ total: 25, items, listPath: "/x" }, "");
    expect(r.subject.startsWith("25 more critical data issues")).toBe(true);
    expect(r.text).toContain("And 15 more.");
    expect(r.text).not.toContain("S10");
  });
});

describe("digest rendering", () => {
  const data = (): DigestData => {
    const d = emptyDigest("2026-11-12");
    d.bySeverity = { critical: 2, warning: 3, info: 1 };
    d.byArea.bank = { critical: 1, warning: 2, info: 0 };
    d.byArea.fx = { critical: 1, warning: 1, info: 1 };
    d.snoozed = 4;
    d.newSinceYesterday = 5;
    d.oldest = { subject: HOSTILE, severity: "warning", days: 12 };
    d.top = Array.from({ length: 13 }, (_, i) => ({
      severity: i < 2 ? ("critical" as const) : ("warning" as const),
      area: "bank" as const,
      ruleTitle: `Rule ${i}`,
      subject: i === 0 ? HOSTILE : `Subject ${i}`,
      message: "Message",
      fixPath: "/treasury/bank",
    }));
    d.notEvaluated = [{ ruleTitle: HOSTILE, reason: "no_closed_period_marker" }];
    return d;
  };
  it("contains counts by severity and area, new, oldest, top ten and not evaluated", () => {
    const r = renderDigest(data(), "https://app.example.com");
    expect(r.subject).toBe("6 open data quality issues, 2 critical");
    expect(r.text).toContain("2 critical, 3 warning, 1 info. 5 new since yesterday. 4 snoozed.");
    expect(r.text).toContain("- Bank: 1 critical, 2 warning, 0 info");
    expect(r.text).toContain("- FX: 1 critical, 1 warning, 1 info");
    expect(r.text).toContain("open for 12 days (warning)");
    expect(r.text).toContain("Top 10");
    expect(r.text).not.toContain("Rule 10");
    expect(r.text).toContain("Fix: https://app.example.com/treasury/bank");
    expect(r.text).toContain("1 rule was not evaluated");
    expect(r.text).toContain("No closed period marker");
  });
  it("escapes hostile names everywhere in html and has a plain-text twin", () => {
    const r = renderDigest(data(), "");
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img");
    expect(r.html.match(/&lt;script&gt;/g)!.length).toBeGreaterThanOrEqual(3);
    expect(r.text).toContain("Fix in the app: /treasury/bank");
    expect((r.html + r.text).replace("<!doctype html>", "")).not.toContain("!");
    expect(r.html).not.toMatch(/<img|<link|url\(|<script/i);
  });
  it("an empty digest still leads with the number", () => {
    const r = renderDigest(emptyDigest("2026-11-12"), "");
    expect(r.subject).toBe("0 open data quality issues");
    expect(r.text).not.toContain("By area");
    expect(r.text).not.toContain("not evaluated");
  });
  it("singular wording", () => {
    const d = emptyDigest("2026-11-12");
    d.bySeverity.info = 1;
    expect(renderDigest(d, "").subject).toBe("1 open data quality issue");
  });
});

describe("settings validation", () => {
  const cur = DEFAULT_NOTIFICATION_SETTINGS;
  it("accepts a strict base URL and drops nothing silently", () => {
    expect(normalizeBaseUrl("https://App.Example.com/")).toBe("https://app.example.com");
    expect(normalizeBaseUrl("")).toBe("");
    for (const bad of [
      "http://app.example.com",
      "https://app.example.com/path",
      "https://app.example.com?x=1",
      "https://u:p@app.example.com",
      "https://localhost",
      "https://127.0.0.1",
      "javascript:alert(1)",
      "https://app.example.com#x",
    ]) {
      expect(normalizeBaseUrl(bad), bad).toBeNull();
    }
  });
  it("host and sender validation", () => {
    expect(normalizeEmailHost("API.Mail.example.com")).toBe("api.mail.example.com");
    expect(normalizeEmailHost("evil.com/x")).toBeNull();
    expect(normalizeEmailHost("10.0.0.1")).toBeNull();
    expect(normalizeFromAddress("Alerts@Camelthorncapital.com")).toBe(
      "alerts@camelthorncapital.com",
    );
    expect(normalizeFromAddress("A <a@b.com>")).toBeNull();
    expect(normalizeFromAddress("a@b.com,c@d.com")).toBeNull();
  });
  it("patch is strict", () => {
    expect(applySettingsPatch(cur, { nope: 1 })).toEqual({ ok: false, error: "bad_request" });
    expect(applySettingsPatch(cur, { enabled: "yes" })).toEqual({
      ok: false,
      error: "bad_enabled",
    });
    expect(applySettingsPatch(cur, { maxAlertsPerRun: 0 })).toMatchObject({ ok: false });
    expect(applySettingsPatch(cur, { maxAlertsPerRun: 51 })).toMatchObject({ ok: false });
    expect(applySettingsPatch(cur, { maxAlertsPerRun: 2.5 })).toMatchObject({ ok: false });
    expect(applySettingsPatch(cur, { alertRecipients: "everyone" })).toMatchObject({ ok: false });
    expect(applySettingsPatch(cur, { emailProvider: "https" })).toEqual({
      ok: false,
      error: "provider_incomplete",
    });
    const ok = applySettingsPatch(cur, {
      emailProvider: "https",
      emailHost: "api.mail.example.com",
      emailFrom: "alerts@camelthorncapital.com",
      maxAlertsPerRun: 5,
    });
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok)
      expect(ok.changed.sort()).toEqual([
        "emailFrom",
        "emailHost",
        "emailProvider",
        "maxAlertsPerRun",
      ]);
  });
  it("stored garbage falls back per field; an incomplete provider stays disabled", () => {
    expect(parseStoredSettings("nope")).toEqual(cur);
    const s = parseStoredSettings(
      JSON.stringify({ maxAlertsPerRun: 7, baseUrl: "http://x", emailProvider: "https" }),
    );
    expect(s.maxAlertsPerRun).toBe(7);
    expect(s.baseUrl).toBe("");
    expect(s.emailProvider).toBe("disabled");
  });
  it("alert key carries fingerprint and reopen count", () => {
    expect(alertKey("a.b:1", 2)).toBe("dq-alert:a.b:1:2");
  });
});
