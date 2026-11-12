/**
 * The https e-mail sender (ADR 0046): request shape, and the classification that makes
 * claim-then-send safe (only a definite refusal is `failed`; everything unclear is `unknown`).
 */
import type { DqNotificationSettings } from "@camelthorn/core";
import { describe, expect, it } from "vitest";
import { disabledSender, httpsSender, senderFromSettings } from "../src/email/sender";

const msg = {
  to: ["a@camelthorncapital.com", "b@camelthorncapital.com"],
  subject: "S",
  html: "<p>h</p>",
  text: "t",
};
const mk = (fetchFn: typeof fetch) =>
  httpsSender({
    host: "api.mail.example.com",
    from: "alerts@camelthorncapital.com",
    apiKey: "KEY-123",
    fetchFn,
  });
const reply =
  (status: number, body = "{}"): typeof fetch =>
  () =>
    Promise.resolve(new Response(body, { status }));

describe("request", () => {
  it("posts JSON to the configured host with the bearer key and does not follow redirects", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f: typeof fetch = (input, init) => {
      seen = { url: String(input), init: init ?? {} };
      return Promise.resolve(new Response(JSON.stringify({ id: "prov-1" }), { status: 200 }));
    };
    const r = await mk(f).send(msg);
    expect(r).toEqual({ status: "sent", providerMessageId: "prov-1" });
    expect(seen!.url).toBe("https://api.mail.example.com/emails");
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.redirect).toBe("manual");
    const h = seen!.init.headers as Record<string, string>;
    expect(h["authorization"]).toBe("Bearer KEY-123");
    const body = JSON.parse(String(seen!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      from: "alerts@camelthorncapital.com",
      to: msg.to,
      subject: "S",
      html: "<p>h</p>",
      text: "t",
    });
  });

  it("refuses to send to nobody", async () => {
    const r = await mk(reply(200)).send({ ...msg, to: [] });
    expect(r).toEqual({ status: "failed", code: "no_recipients" });
  });
});

describe("classification", () => {
  it("2xx is sent, with or without a readable id", async () => {
    expect(await mk(reply(200, "not json")).send(msg)).toEqual({
      status: "sent",
      providerMessageId: null,
    });
    expect(await mk(reply(202, '{"id": 5}')).send(msg)).toEqual({
      status: "sent",
      providerMessageId: null,
    });
  });
  it("4xx (not 408) is a definite refusal", async () => {
    for (const s of [400, 401, 403, 422, 429]) {
      expect(await mk(reply(s)).send(msg), String(s)).toEqual({
        status: "failed",
        code: `http_${s}`,
      });
    }
  });
  it("408, 3xx and 5xx are unknown: the message may have been accepted", async () => {
    for (const s of [301, 302, 408, 500, 502, 503, 504]) {
      expect(await mk(reply(s)).send(msg), String(s)).toEqual({
        status: "unknown",
        code: `http_${s}`,
      });
    }
  });
  it("network errors and timeouts are unknown", async () => {
    expect(await mk(() => Promise.reject(new TypeError("fetch failed"))).send(msg)).toEqual({
      status: "unknown",
      code: "network_error",
    });
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(await mk(() => Promise.reject(timeout)).send(msg)).toEqual({
      status: "unknown",
      code: "timeout",
    });
  });
  it("the result never carries the key, an address or the provider's text", async () => {
    const r = await mk(reply(400, "KEY-123 a@camelthorncapital.com secret text")).send(msg);
    expect(JSON.stringify(r)).not.toMatch(/KEY-123|camelthorn|secret/);
  });
});

describe("senderFromSettings", () => {
  const base: DqNotificationSettings = {
    enabled: true,
    alertRecipients: "admin_finance",
    baseUrl: "",
    maxAlertsPerRun: 10,
    emailProvider: "https",
    emailHost: "api.mail.example.com",
    emailFrom: "alerts@camelthorncapital.com",
  };
  it("is active only with provider, host, sender and key", () => {
    expect(senderFromSettings({ EMAIL_API_KEY: "k" }, base).kind).toBe("https");
    expect(senderFromSettings({ EMAIL_API_KEY: "  " }, base)).toBe(disabledSender);
    expect(senderFromSettings({}, base)).toBe(disabledSender);
    expect(senderFromSettings({ EMAIL_API_KEY: "k" }, { ...base, emailProvider: "disabled" })).toBe(
      disabledSender,
    );
    expect(senderFromSettings({ EMAIL_API_KEY: "k" }, { ...base, emailHost: "" })).toBe(
      disabledSender,
    );
    expect(senderFromSettings({ EMAIL_API_KEY: "k" }, { ...base, emailFrom: "" })).toBe(
      disabledSender,
    );
  });
  it("the disabled sender sends nothing", async () => {
    expect(await disabledSender.send(msg)).toEqual({ status: "skipped_not_configured" });
  });
});
