/**
 * Review V2 (adversarial): validation parity with the server, the host confirmation cannot be
 * skipped, races on save and on the test, the test never uses unsaved settings, countdown on a
 * fake clock, focus after save and after a conflict, no key anywhere.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySettingsPatch, type DqNotificationsResponse } from "@camelthorn/core";
import { ADMIN, mockFetch, renderApp, type Call } from "./test-utils";
import { notifications } from "./test-fixtures-dq";
import { checkForm } from "./pages/Notifications";

type H = Record<string, (c: Call) => { status?: number; body?: unknown }>;
const base = (over: H = {}): H => ({
  "GET /api/auth/me": () => ({ body: ADMIN }),
  "GET /api/dq/notifications": () => ({ body: notifications() }),
  ...over,
});
const of = (calls: Call[], path: string, method: string) =>
  calls.filter((c) => c.method === method && c.url.split("?")[0] === path);
const PATCHES = (calls: Call[]) => of(calls, "/api/dq/notifications", "PATCH");
const TESTS = (calls: Call[]) => of(calls, "/api/dq/notifications/test", "POST");

async function open(over: H = {}) {
  const calls = mockFetch(base(over));
  renderApp("/settings/notifications");
  await screen.findByRole("heading", { level: 2, name: "Alerts and sender" });
  return calls;
}
const field = (name: string) => screen.getByLabelText(new RegExp(`^${name}`)) as HTMLInputElement;
const setValue = (name: string, value: string) =>
  fireEvent.change(field(name), { target: { value } });
const saveButton = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const testButton = () =>
  screen.getByRole("button", { name: "Send test email to me" }) as HTMLButtonElement;

afterEach(() => vi.useRealTimers());

describe("validation parity with the server (core applySettingsPatch)", () => {
  const saved = notifications();
  const form = (over: Partial<Record<string, string>>) => ({
    enabled: true,
    provider: "https" as const,
    host: saved.settings.emailHost,
    from: saved.settings.emailFrom,
    baseUrl: saved.settings.baseUrl,
    recipients: "admin_finance" as const,
    max: "10",
    ...over,
  });
  const cases: [string, string][] = [
    // Host: SSRF forms, IP literals in other notations, trailing dot, port, userinfo, path, IDN.
    ["host", "0x7f.0x1"],
    ["host", "017700000001.0"],
    ["host", "127.0.0.1"],
    ["host", "2130706433"],
    ["host", "[::1]"],
    ["host", "api.example.com."],
    ["host", "api.example.com:443"],
    ["host", "user@api.example.com"],
    ["host", "api.example.com/emails"],
    ["host", "https://api.example.com"],
    ["host", "api..example.com"],
    ["host", "-api.example.com"],
    ["host", "аpi.mailer.com"], // Cyrillic a: a lookalike in Unicode form
    ["host", "api.mailer.com​"],
    ["host", "localhost"],
    ["host", "mail.internal"],
    ["host", "metadata.google.internal"],
    ["host", "api.example.com\r\nx"],
    // From: header injection and display names.
    ["from", "a@camelthorncapital.com\r\nBcc: x@evil.com"],
    ["from", "a@camelthorncapital.com\nBcc:x@evil.com"],
    ["from", "a@camelthorncapital.com,x@evil.com"],
    ["from", "a@camelthorncapital.com;x@evil.com"],
    ["from", "Alerts <a@camelthorncapital.com>"],
    ["from", '"a"@camelthorncapital.com'],
    ["from", "a b@camelthorncapital.com"],
    ["from", "a@camelthorncapital.com%0d%0abcc:x@evil.com"],
    ["from", "a@b"],
    ["from", "a@аpple.com"],
    // Base URL: https only, no userinfo, path, query, fragment, private or numeric host.
    ["baseUrl", "http://app.example.com"],
    ["baseUrl", "javascript:alert(1)"],
    ["baseUrl", "https://user:pw@app.example.com"],
    ["baseUrl", "https://user@app.example.com"],
    ["baseUrl", "https://0x7f.0x1"],
    ["baseUrl", "https://127.0.0.1"],
    ["baseUrl", "https://[::1]"],
    ["baseUrl", "https://localhost"],
    ["baseUrl", "https://app.example.com."],
    ["baseUrl", "https://app.example.com/x"],
    ["baseUrl", "https://app.example.com?x=1"],
    ["baseUrl", "https://app.example.com#x"],
    ["baseUrl", "//app.example.com"],
    ["max", "1e1"],
    ["max", "0x10"],
    ["max", "-1"],
    ["max", "10.0"],
    ["max", "١٠"], // Arabic-Indic digits
  ];
  for (const [k, v] of cases) {
    it(`${k} = ${JSON.stringify(v)}: refused by the form AND by the server`, () => {
      const c = checkForm(form({ [k]: v }), saved);
      expect(c.ok).toBe(false);
      // The number field is stricter than the server (which gets a JSON number): digits only.
      if (k === "max") return;
      const serverKey = { host: "emailHost", from: "emailFrom", baseUrl: "baseUrl" }[k] as string;
      expect(applySettingsPatch(saved.settings, { [serverKey]: v }).ok).toBe(false);
    });
  }
  const good: [string, string, string][] = [
    ["host", " API.Other.example.com ", "api.other.example.com"],
    ["host", "xn--pple-43d.com", "xn--pple-43d.com"],
    ["from", " Ops@CamelthornCapital.com ", "ops@camelthorncapital.com"],
    ["baseUrl", "https://APP.example.org/", "https://app.example.org"],
    ["baseUrl", "https://app.example.org:8443", "https://app.example.org:8443"],
  ];
  for (const [k, v, want] of good) {
    it(`${k} = ${JSON.stringify(v)}: accepted by both, as the same value`, () => {
      const c = checkForm(form({ [k]: v }), saved);
      expect(c.ok).toBe(true);
      const serverKey = { host: "emailHost", from: "emailFrom", baseUrl: "baseUrl" }[k] as
        "emailHost" | "emailFrom" | "baseUrl";
      const r = applySettingsPatch(saved.settings, { [serverKey]: v });
      expect(r.ok && r.value[serverKey]).toBe(want);
      expect(c.ok && c.patch[serverKey]).toBe(want);
    });
  }

  it("the form never refuses on its own what the server accepts, and sends nothing but known fields", async () => {
    const calls = await open({
      "PATCH /api/dq/notifications": () => ({ body: notifications({ rev: "rev-2" }) }),
    });
    setValue("From address", "ops@camelthorncapital.com");
    setValue("App address for links", "");
    fireEvent.click(saveButton());
    await waitFor(() => expect(PATCHES(calls)).toHaveLength(1));
    const body = PATCHES(calls)[0]?.body as Record<string, unknown>;
    expect(body).toEqual({ emailFrom: "ops@camelthorncapital.com", baseUrl: "", rev: "rev-1" });
  });

  it("the From field is plain text: no browser rewriting (IDN to punycode, newline stripping)", async () => {
    await open();
    expect(field("From address").type).toBe("text");
    expect(field("From address").inputMode).toBe("email");
  });

  it("a header-injection From typed in the page is refused before any request", async () => {
    const calls = await open();
    setValue("From address", "a@camelthorncapital.com\r\nBcc: x@evil.com");
    expect(field("From address").getAttribute("aria-invalid")).toBe("true");
    expect(saveButton().disabled).toBe(true);
    fireEvent.submit(saveButton().closest("form") as HTMLFormElement);
    await new Promise((r) => setTimeout(r, 20));
    expect(PATCHES(calls)).toHaveLength(0);
  });
});

describe("the host confirmation cannot be skipped", () => {
  it("Enter in the host field asks; Enter again on the open question saves nothing", async () => {
    const calls = await open();
    const host = field("Provider host");
    await userEvent.clear(host);
    await userEvent.type(host, "mail.other.example.org{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("https://mail.other.example.org")).toBeTruthy();
    expect(document.activeElement).toBe(dialog);
    await userEvent.keyboard("{Enter}{Enter}");
    await new Promise((r) => setTimeout(r, 20));
    expect(PATCHES(calls)).toHaveLength(0);
  });

  it("a direct form submit (no click on Save) still asks first", async () => {
    const calls = await open();
    setValue("Provider host", "mail.other.example.org");
    fireEvent.submit(saveButton().closest("form") as HTMLFormElement);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(PATCHES(calls)).toHaveLength(0);
  });

  it("switching sending on for a host saved while off asks, and names that host", async () => {
    const calls = await open({
      "GET /api/dq/notifications": () => ({
        body: notifications({ senderActive: false }, { emailProvider: "disabled" }),
      }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Email API" }));
    await userEvent.click(saveButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("https://api.mailer.example.com")).toBeTruthy();
    expect(PATCHES(calls)).toHaveLength(0);
  });

  it("switching sending off does not ask (the key goes nowhere)", async () => {
    const calls = await open({
      "PATCH /api/dq/notifications": () => ({
        body: notifications({ rev: "rev-2" }, { emailProvider: "disabled" }),
      }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Off" }));
    setValue("Provider host", "mail.other.example.org");
    await userEvent.click(saveButton());
    await waitFor(() => expect(PATCHES(calls)).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a double click on the confirm sends one request", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const calls = mockFetch(
      base({
        "PATCH /api/dq/notifications": () => ({
          body: notifications({ rev: "rev-2" }, { emailHost: "mail.other.example.org" }),
        }),
      }),
    );
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") await gate;
      return realFetch(url, init);
    });
    renderApp("/settings/notifications");
    await screen.findByRole("heading", { level: 2, name: "Alerts and sender" });
    setValue("Provider host", "mail.other.example.org");
    fireEvent.click(saveButton());
    const confirm = await screen.findByRole("button", { name: "Save and send the key there" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(PATCHES(calls)).toHaveLength(1);
  });

  it("a punycode host gets an extra warning in the question", async () => {
    await open();
    setValue("Provider host", "api.xn--mailr-dva.com");
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("https://api.xn--mailr-dva.com")).toBeTruthy();
    expect(dialog.textContent).toMatch(/punycode/);
  });
});

describe("save: focus, conflicts, double submit", () => {
  it("double click on Save sends one request; focus lands on the form heading after", async () => {
    const calls = await open({
      "PATCH /api/dq/notifications": () => ({
        body: notifications({ rev: "rev-2" }, { maxAlertsPerRun: 20 }),
      }),
    });
    setValue("Most alerts per run", "20");
    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    fireEvent.submit(saveButton().closest("form") as HTMLFormElement);
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 2, name: "Alerts and sender" }),
      ),
    );
    expect(PATCHES(calls)).toHaveLength(1);
  });

  it("after a confirmed host change focus lands on the form heading, not the page body", async () => {
    await open({
      "PATCH /api/dq/notifications": () => ({
        body: notifications({ rev: "rev-2" }, { emailHost: "mail.other.example.org" }),
      }),
    });
    setValue("Provider host", "mail.other.example.org");
    await userEvent.click(saveButton());
    await userEvent.click(
      await screen.findByRole("button", { name: "Save and send the key there" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 2, name: "Alerts and sender" }),
    );
  });

  it("a 409 keeps the page (no skeleton flash), focuses the notice and shows the new values", async () => {
    let reads = 0;
    await open({
      "GET /api/dq/notifications": () => ({
        body:
          reads++ === 0
            ? notifications()
            : notifications({ rev: "rev-9" }, { maxAlertsPerRun: 33 }),
      }),
      "PATCH /api/dq/notifications": () => ({ status: 409, body: { error: "conflict" } }),
    });
    setValue("Most alerts per run", "20");
    await userEvent.click(saveButton());
    const alert = await screen.findByText(/Someone else changed these settings first/);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    await waitFor(() => expect(field("Most alerts per run").value).toBe("33"));
  });

  it("a quiet refresh that brings another rev while editing says the edits were replaced", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-12T10:00:00Z"));
    let reads = 0;
    await open({
      "GET /api/dq/notifications": () => ({
        body:
          reads++ === 0
            ? notifications()
            : notifications({ rev: "rev-7" }, { maxAlertsPerRun: 44 }),
      }),
    });
    setValue("Most alerts per run", "20");
    vi.setSystemTime(Date.parse("2026-11-12T10:05:00Z"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(field("Most alerts per run").value).toBe("44"));
    // The notice follows in the next render (it is set from the effect that sees the new rev).
    expect(await screen.findByText(/Someone else changed these settings first/)).toBeTruthy();
  });

  it("never-saved settings (rev null) are sent with rev null", async () => {
    const calls = await open({
      "GET /api/dq/notifications": () => ({
        body: { ...notifications(), rev: null } as unknown as DqNotificationsResponse,
      }),
      "PATCH /api/dq/notifications": () => ({ body: notifications({ rev: "rev-1" }) }),
    });
    setValue("Most alerts per run", "12");
    await userEvent.click(saveButton());
    await waitFor(() => expect(PATCHES(calls)).toHaveLength(1));
    expect((PATCHES(calls)[0]?.body as { rev: unknown }).rev).toBeNull();
  });

  it("Discard works on an invalid form too", async () => {
    await open();
    setValue("Provider host", "localhost");
    const discard = screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement;
    expect(discard.disabled).toBe(false);
    await userEvent.click(discard);
    expect(field("Provider host").value).toBe("api.mailer.example.com");
    expect(field("Provider host").getAttribute("aria-invalid")).toBeNull();
  });
});

describe("the test email never uses unsaved settings", () => {
  it("is off while the form has changes, with the reason, and on again after Discard", async () => {
    const calls = await open({
      "POST /api/dq/notifications/test": () => ({ body: { status: "sent", code: null } }),
    });
    setValue("Provider host", "mail.other.example.org");
    expect(testButton().disabled).toBe(true);
    expect(screen.getByText(/The test uses the saved settings/)).toBeTruthy();
    fireEvent.click(testButton());
    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(testButton().disabled).toBe(false);
    await userEvent.click(testButton());
    await waitFor(() => expect(TESTS(calls)).toHaveLength(1));
    // The request carries no settings at all: the server uses what is saved.
    expect(TESTS(calls)[0]?.body).toEqual({});
  });

  it("a double click sends one test", async () => {
    const calls = await open({
      "POST /api/dq/notifications/test": () => ({ body: { status: "sent", code: null } }),
    });
    fireEvent.click(testButton());
    fireEvent.click(testButton());
    await screen.findByText(/Test email sent to/);
    fireEvent.click(testButton());
    expect(TESTS(calls)).toHaveLength(1);
  });
});

describe("the countdown on a fake clock", () => {
  const fake = () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(Date.parse("2026-11-12T10:00:00Z"));
  };
  const tick = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it("counts 60, 30, 1, then the button is back and the timer has stopped", async () => {
    fake();
    await open({
      "POST /api/dq/notifications/test": () => ({ body: { status: "sent", code: null } }),
    });
    // Watch the one-second intervals started from here on (the countdown's), and which are cleared.
    const started: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      const id = realSet(fn, ms);
      if (ms === 1000) started.push(id);
      return id;
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((id?: unknown) => {
      cleared.add(id);
      realClear(id as Parameters<typeof clearInterval>[0]);
    }) as typeof clearInterval);
    fireEvent.click(testButton());
    await screen.findByText(/Test email sent to/);
    expect(await screen.findByText("You can send another in 60 s.")).toBeTruthy();
    tick(30_000);
    expect(screen.getByText("You can send another in 30 s.")).toBeTruthy();
    tick(29_000);
    expect(screen.getByText("You can send another in 1 s.")).toBeTruthy();
    expect(testButton().disabled).toBe(true);
    tick(1_000);
    expect(screen.queryByText(/You can send another/)).toBeNull();
    expect(testButton().disabled).toBe(false);
    // The countdown interval stopped itself once the wait was over (it does not tick forever).
    expect(started).toHaveLength(1);
    expect(cleared.has(started[0])).toBe(true);
  });

  it("uses the server's wait when it gives one, and caps a silly one at an hour", async () => {
    fake();
    let n = 0;
    await open({
      "POST /api/dq/notifications/test": () => ({
        status: 409,
        body: { error: "too_soon", retryAfterSeconds: n++ === 0 ? 17 : 10_000_000 },
      }),
    });
    fireEvent.click(testButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/Wait 17 seconds/);
    expect(screen.getByText("You can send another in 17 s.")).toBeTruthy();
    tick(17_000);
    expect(testButton().disabled).toBe(false);
    fireEvent.click(testButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/Wait 3600 seconds/);
    expect(screen.getByText("You can send another in 3600 s.")).toBeTruthy();
  });

  it("not configured starts no wait", async () => {
    fake();
    await open({
      "POST /api/dq/notifications/test": () => ({
        body: { status: "skipped_not_configured", code: null },
      }),
    });
    fireEvent.click(testButton());
    await screen.findByText(/the sender is not set up/);
    expect(screen.queryByText(/You can send another/)).toBeNull();
    expect(testButton().disabled).toBe(false);
  });

  it("an odd provider code is not echoed into the page", async () => {
    await open({
      "POST /api/dq/notifications/test": () => ({
        body: { status: "failed", code: "<img src=x onerror=alert(1)>" },
      }),
    });
    fireEvent.click(testButton());
    const msg = await screen.findByText(/did not accept the test email/);
    expect(msg.textContent).toBe(
      "The provider did not accept the test email. Check the host, sender address and key.",
    );
  });
});
