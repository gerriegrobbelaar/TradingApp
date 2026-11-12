/** Settings, Notifications (Phase 8 review V2): sender and alert settings, test email, role gating. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import { nav, type Me } from "./api";
import { notifications } from "./test-fixtures-dq";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const FINANCE: Me = { ...ADMIN, email: "f@camelthorncapital.com", roles: ["finance"] };
const STEP_UP = () => ({ status: 401, body: { error: "step_up_required" } });
const CANARY = "KEY-CANARY-9f3a";

type H = Record<string, (c: Call) => { status?: number; body?: unknown }>;
const base = (over: H = {}, me: Me = ADMIN): H => ({
  "GET /api/auth/me": () => ({ body: me }),
  "GET /api/dq/notifications": () => ({ body: notifications() }),
  ...over,
});
const of = (calls: Call[], path: string, method: string) =>
  calls.filter((c) => c.method === method && c.url.split("?")[0] === path);

async function open(over: H = {}) {
  const calls = mockFetch(base(over));
  const view = renderApp("/settings/notifications");
  await screen.findByRole("heading", { level: 2, name: "Alerts and sender" });
  return { calls, view };
}
const field = (name: string) => screen.getByLabelText(new RegExp(`^${name}`)) as HTMLInputElement;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("the Notifications tab", () => {
  it("shows the status without ever showing the key, with no axe violations", async () => {
    const { view } = await open({
      // A server that wrongly sent a secret must still not get it onto the screen or into storage.
      "GET /api/dq/notifications": () => ({
        body: { ...notifications(), apiKey: CANARY, emailApiKey: CANARY },
      }),
    });
    const status = screen
      .getByRole("heading", { level: 2, name: "Notifications" })
      .closest(".card");
    expect(within(status as HTMLElement).getByText("Configured")).toBeTruthy();
    expect(within(status as HTMLElement).getByText("Set")).toBeTruthy();
    expect(screen.getByText(/3 people with an @camelthorncapital.com address/)).toBeTruthy();
    expect(field("Provider host").value).toBe("api.mailer.example.com");
    expect(field("From address").value).toBe("alerts@camelthorncapital.com");
    expect(field("App address for links").value).toBe("https://app.camelthorncapital.com");
    expect(field("Most alerts per run").value).toBe("10");
    expect(screen.getByRole("switch", { name: "Send alerts and the digest" })).toBeTruthy();
    expect(await screen.findByText(/Updated/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings, Schedules" }).getAttribute("href")).toBe(
      "/settings/schedules",
    );
    expect(document.body.innerHTML).not.toContain(CANARY);
    expect(JSON.stringify({ ...localStorage })).not.toContain(CANARY);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CANARY);
    for (const input of document.querySelectorAll("input")) {
      expect((input as HTMLInputElement).value).not.toContain(CANARY);
    }
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("says the key is not set and the sender is not configured", async () => {
    await open({
      "GET /api/dq/notifications": () => ({
        body: notifications({ apiKeyPresent: false, senderActive: false }),
      }),
    });
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Send test email to me" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows skeleton while loading and a retry when the read fails", async () => {
    let n = 0;
    mockFetch(
      base({
        "GET /api/dq/notifications": () =>
          n++ === 0 ? { status: 500, body: { error: "boom" } } : { body: notifications() },
      }),
    );
    renderApp("/settings/notifications");
    await userEvent.click(await screen.findByRole("button", { name: /try again/i }));
    await screen.findByRole("heading", { level: 2, name: "Alerts and sender" });
  });

  for (const me of [FINANCE, VIEWER]) {
    it(`${me.roles.join()}: no tab, no read, redirected to Appearance`, async () => {
      const calls = mockFetch(base({}, me));
      renderApp("/settings/notifications");
      await screen.findByRole("heading", { level: 2, name: "Theme" });
      expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
      expect(of(calls, "/api/dq/notifications", "GET")).toHaveLength(0);
    });
  }

  it("saves only the changed fields with the rev, then shows the new state", async () => {
    const patched = notifications({ rev: "rev-2" }, { maxAlertsPerRun: 20 });
    const { calls } = await open({ "PATCH /api/dq/notifications": () => ({ body: patched }) });
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const max = field("Most alerts per run");
    await userEvent.clear(max);
    await userEvent.type(max, "20");
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() => expect(of(calls, "/api/dq/notifications", "PATCH")).toHaveLength(1));
    expect(of(calls, "/api/dq/notifications", "PATCH")[0]?.body).toEqual({
      maxAlertsPerRun: 20,
      rev: "rev-1",
    });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(field("Most alerts per run").value).toBe("20");
  });

  it("Enter in a field saves (keyboard only)", async () => {
    const { calls } = await open({
      "PATCH /api/dq/notifications": () => ({
        body: notifications({ rev: "rev-2" }, { enabled: false }),
      }),
    });
    screen.getByRole("switch", { name: "Send alerts and the digest" }).focus();
    await userEvent.keyboard(" ");
    const max = field("Most alerts per run");
    max.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(of(calls, "/api/dq/notifications", "PATCH")).toHaveLength(1));
    expect(of(calls, "/api/dq/notifications", "PATCH")[0]?.body).toEqual({
      enabled: false,
      rev: "rev-1",
    });
  });

  describe("validation mirrors the server", () => {
    const bad: [string, string, string][] = [
      ["Provider host", "https://api.example.com", "plain host name"],
      ["Provider host", "localhost", "plain host name"],
      ["Provider host", "192.168.0.1", "plain host name"],
      ["From address", "Name <a@b.com>", "plain address"],
      ["From address", "a@b", "plain address"],
      ["App address for links", "http://app.example.com", "https address"],
      ["App address for links", "https://app.example.com/path", "https address"],
      ["Most alerts per run", "0", "whole number from 1 to 50"],
      ["Most alerts per run", "51", "whole number from 1 to 50"],
      ["Most alerts per run", "2.5", "whole number from 1 to 50"],
      ["Most alerts per run", "", "whole number from 1 to 50"],
    ];
    for (const [label, value, hint] of bad) {
      it(`${label} = "${value}" is refused before any request`, async () => {
        const { calls } = await open();
        const input = field(label);
        await userEvent.clear(input);
        if (value) await userEvent.type(input, value);
        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(screen.getByText(new RegExp(hint))).toBeTruthy();
        const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        expect(of(calls, "/api/dq/notifications", "PATCH")).toHaveLength(0);
      });
    }

    it("sending on needs a host and a sender address", async () => {
      await open({
        "GET /api/dq/notifications": () => ({
          body: notifications({}, { emailProvider: "disabled", emailHost: "", emailFrom: "" }),
        }),
      });
      await userEvent.click(screen.getByRole("button", { name: "Email API" }));
      expect(screen.getByText(/Sending needs a host name and a sender address/)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });

  describe("changing the host", () => {
    it("asks first, says where the key goes, and Escape cancels without a request", async () => {
      const { calls } = await open();
      const host = field("Provider host");
      await userEvent.clear(host);
      await userEvent.type(host, "Mail.Other.example.org");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("https://mail.other.example.org")).toBeTruthy();
      expect(dialog.textContent).toMatch(/API key will be sent to/);
      expect(of(calls, "/api/dq/notifications", "PATCH")).toHaveLength(0);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(of(calls, "/api/dq/notifications", "PATCH")).toHaveLength(0);
    });

    it("saves after the confirm, with the lowercase host", async () => {
      const { calls } = await open({
        "PATCH /api/dq/notifications": () => ({
          body: notifications({ rev: "rev-2" }, { emailHost: "mail.other.example.org" }),
        }),
      });
      const host = field("Provider host");
      await userEvent.clear(host);
      await userEvent.type(host, "Mail.Other.example.org");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await userEvent.click(
        await screen.findByRole("button", { name: "Save and send the key there" }),
      );
      await waitFor(() => expect(of(calls, "/api/dq/notifications", "PATCH")).toHaveLength(1));
      expect(of(calls, "/api/dq/notifications", "PATCH")[0]?.body).toEqual({
        emailHost: "mail.other.example.org",
        rev: "rev-1",
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("a change that does not touch the host saves without the question", async () => {
      const { calls } = await open({
        "PATCH /api/dq/notifications": () => ({
          body: notifications({ rev: "rev-2" }, { emailFrom: "x@camelthorncapital.com" }),
        }),
      });
      const from = field("From address");
      await userEvent.clear(from);
      await userEvent.type(from, "x@camelthorncapital.com");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(of(calls, "/api/dq/notifications", "PATCH")).toHaveLength(1));
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("a stale rev (409) reloads the current values and says so", async () => {
    let reads = 0;
    const { calls } = await open({
      "GET /api/dq/notifications": () => ({
        body:
          reads++ === 0
            ? notifications()
            : notifications({ rev: "rev-9" }, { maxAlertsPerRun: 33 }),
      }),
      "PATCH /api/dq/notifications": () => ({ status: 409, body: { error: "conflict" } }),
    });
    const max = field("Most alerts per run");
    await userEvent.clear(max);
    await userEvent.type(max, "20");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Someone else changed these settings/,
    );
    await waitFor(() => expect(field("Most alerts per run").value).toBe("33"));
    expect(of(calls, "/api/dq/notifications", "GET")).toHaveLength(2);
  });

  it("without a fresh sign-in shows the sign-in button and changes nothing", async () => {
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => undefined);
    await open({ "PATCH /api/dq/notifications": STEP_UP });
    const max = field("Most alerts per run");
    await userEvent.clear(max);
    await userEvent.type(max, "20");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(field("Most alerts per run").value).toBe("20");
  });

  it("a server refusal is a sentence, not a code", async () => {
    await open({
      "PATCH /api/dq/notifications": () => ({ status: 400, body: { error: "bad_email_host" } }),
    });
    const max = field("Most alerts per run");
    await userEvent.clear(max);
    await userEvent.type(max, "20");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That host name is not valid.");
  });
});

describe("the test email", () => {
  it("sends one, reports it, and waits 60 seconds before another", async () => {
    const { calls } = await open({
      "POST /api/dq/notifications/test": () => ({ body: { status: "sent", code: null } }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Send test email to me" }));
    expect(await screen.findByText(/Test email sent to gerrie@camelthorncapital.com/)).toBeTruthy();
    expect(of(calls, "/api/dq/notifications/test", "POST")).toHaveLength(1);
    expect(screen.getByText(/You can send another in (59|60) s/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Send test email to me" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows the server's refusal (too soon) and the wait", async () => {
    await open({
      "POST /api/dq/notifications/test": () => ({ status: 409, body: { error: "too_soon" } }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Send test email to me" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "A test email was sent in the last minute. Wait 60 seconds before sending another.",
    );
    // One sentence, not a generic "try again" next to the wait.
    expect(screen.queryByText(/Try again/)).toBeNull();
    expect(screen.getByText(/You can send another in/)).toBeTruthy();
  });

  it("explains a failed delivery and a caller who is not a recipient", async () => {
    let n = 0;
    await open({
      "POST /api/dq/notifications/test": () =>
        n++ === 0
          ? { status: 422, body: { error: "not_an_allowed_recipient" } }
          : { body: { status: "failed", code: "http_401" } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Send test email to me" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "A test goes only to an administrator with an @camelthorncapital.com address. Yours is not one, so nothing was sent.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send test email to me" }));
    expect(await screen.findByText(/did not accept the test email \(http 401\)/)).toBeTruthy();
  });

  it("needs a fresh sign-in", async () => {
    await open({ "POST /api/dq/notifications/test": STEP_UP });
    await userEvent.click(screen.getByRole("button", { name: "Send test email to me" }));
    expect(await screen.findByRole("button", { name: "Sign in again" })).toBeTruthy();
  });
});
