import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import * as api from "./api";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const ME_OK = (me: api.Me) => ({ "GET /api/auth/me": () => ({ body: me }) });

const row = (over: Partial<api.ConnectionRow> = {}): api.ConnectionRow => ({
  kind: "revolut",
  name: "revolut",
  status: "active",
  expiresAt: null,
  lastError: null,
  connectedBy: "gerrie@camelthorncapital.com",
  connectedAt: null,
  divisions: [],
  revolut: { environment: "production", createsBankEntries: false, paymentsMode: "drafts" },
  ...over,
});
const body = (
  rows: api.ConnectionRow[],
  over: Partial<api.ConnectionsResponse> = {},
): api.ConnectionsResponse => ({
  exactConfigured: true,
  revolutConfigured: true,
  connections: rows,
  ...over,
});
const list = (b: api.ConnectionsResponse) => ({ "GET /api/connections": () => ({ body: b }) });
const NONE = body([]);

const card = () => {
  const c = screen.getByRole("heading", { name: "Revolut Business" }).parentElement?.parentElement;
  if (!c) throw new Error("no Revolut card");
  return within(c);
};
const ready = () => screen.findByRole("heading", { name: "Revolut Business" });
const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;

describe("Settings, Connections: Revolut Business", () => {
  it("explains the bank-entries question and blocks Connect until it is answered", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(NONE) });
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderApp("/settings/connections");
    const connect = await screen.findByRole("button", { name: "Connect Revolut Business" });
    expect(card().getByText("Not connected")).toBeTruthy();
    expect(screen.getByText("Who creates bank entries in Exact?")).toBeTruthy();
    expect(screen.getByText(/otherwise every payment is booked twice/)).toBeTruthy();
    expect(
      screen.getByText(/only matches payments to invoices that already have a bank entry/),
    ).toBeTruthy();
    expect(radio(/^This app creates them/).checked).toBe(false);
    expect(radio(/^Revolut's own Exact integration \(or someone else\) creates them/).checked).toBe(
      false,
    );
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Required before you can connect.")).toBeTruthy();

    await user.click(radio(/^Revolut's own Exact integration \(or someone else\) creates them/));
    expect((connect as HTMLButtonElement).disabled).toBe(false);
    await user.click(connect);
    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "/api/connections/revolut/start?environment=production&creates_bank_entries=0&payments_mode=drafts",
      ),
    );
  });

  it("carries the environment, the answer and the payments mode to the start route", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(NONE) });
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await screen.findByRole("button", { name: "Connect Revolut Business" });
    await user.click(radio(/Sandbox/));
    await user.click(radio(/^This app creates them/));
    await user.click(radio(/Pay directly/));
    await user.click(screen.getByRole("button", { name: "Connect Revolut Business" }));
    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "/api/connections/revolut/start?environment=sandbox&creates_bank_entries=1&payments_mode=pay",
      ),
    );
  });

  it("asks for a Google sign-in first when the step-up window has passed", async () => {
    mockFetch({
      "GET /api/auth/me": () => ({ body: { ...ADMIN, stepUpFresh: false } }),
      ...list(NONE),
    });
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await screen.findByRole("button", { name: "Connect Revolut Business" });
    await user.click(radio(/^Revolut's own Exact integration \(or someone else\) creates them/));
    await user.click(screen.getByRole("button", { name: "Connect Revolut Business" }));
    const sheet = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(assign).not.toHaveBeenCalled();
    await user.click(within(sheet).getByRole("button", { name: "Sign in again" }));
    const url = new URL(String(assign.mock.calls[0]?.[0]), "http://x");
    expect(url.pathname).toBe("/api/auth/login");
    expect(url.searchParams.get("step_up")).toBe("1");
  });

  it("shows a connected connection with its saved choices, a sync placeholder and the pay note", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(
        body([
          row({
            revolut: { environment: "sandbox", createsBankEntries: true, paymentsMode: "pay" },
          }),
        ]),
      ),
    });
    renderApp("/settings/connections");
    await screen.findByRole("button", { name: "Disconnect Revolut Business" });
    expect(card().getByText("Connected")).toBeTruthy();
    expect(card().getByText(/Environment: Sandbox \(test\)/)).toBeTruthy();
    expect(card().getByText("Not synced yet")).toBeTruthy();
    expect(card().getByText(/Accounts and balances appear here after the first sync/)).toBeTruthy();
    expect(card().getByText(/Pay mode is not active yet/)).toBeTruthy();
    expect(radio(/^This app creates them/).checked).toBe(true);
    expect(radio(/Pay directly/).checked).toBe(true);
    expect(card().getByRole("button", { name: "Re-authorise Revolut Business" })).toBeTruthy();
    expect(card().queryByRole("group", { name: "Environment" })).toBeNull();
    expect(card().queryByText(/token|PRIVATE KEY/i)).toBeNull();
  });

  it("changing who creates bank entries needs confirmation and goes through the settings route", async () => {
    const calls = mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([row()])),
      "PATCH /api/connections/revolut/settings": () => ({
        body: { ok: true, changed: true, createsBankEntries: true },
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await screen.findByRole("button", { name: "Disconnect Revolut Business" });
    await user.click(radio(/^This app creates them/));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const sheet = await screen.findByRole("dialog", { name: "Change who creates bank entries" });
    expect(within(sheet).getByText(/booked twice/)).toBeTruthy();
    // The saved value stays shown until the change is confirmed.
    expect(radio(/^Revolut's own Exact integration \(or someone else\) creates them/).checked).toBe(
      true,
    );
    await user.click(within(sheet).getByRole("button", { name: "Save change" }));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ createsBankEntries: true });
    expect(patch?.headers["X-Requested-With"]).toBe("camelthorn");
    expect(await screen.findByText("Saved who creates bank entries in Exact.")).toBeTruthy();
  });

  it("changing the payments mode is stored but the note says it is not active", async () => {
    const calls = mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([row()])),
      "PATCH /api/connections/revolut/settings": () => ({ body: { ok: true, changed: true } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await screen.findByRole("button", { name: "Disconnect Revolut Business" });
    await user.click(radio(/Pay directly/));
    const sheet = await screen.findByRole("dialog", { name: "Change the payments mode" });
    expect(within(sheet).getByText(/nothing is sent today/)).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Save change" }));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ paymentsMode: "pay" });
    expect(await screen.findByText("Saved the payments mode.")).toBeTruthy();
  });

  it("a change that needs a fresh sign-in opens the step-up sheet", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([row()])),
      "PATCH /api/connections/revolut/settings": () => ({
        status: 401,
        body: { error: "step_up_required" },
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await screen.findByRole("button", { name: "Disconnect Revolut Business" });
    await user.click(radio(/^This app creates them/));
    const sheet = await screen.findByRole("dialog", { name: "Change who creates bank entries" });
    await user.click(within(sheet).getByRole("button", { name: "Save change" }));
    expect(await screen.findByRole("dialog", { name: "Confirm it's you" })).toBeTruthy();
  });

  it("disconnects only after confirmation and toasts", async () => {
    const calls = mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([row()])),
      "POST /api/connections/revolut/disconnect": () => ({ body: { ok: true, changed: true } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await user.click(await screen.findByRole("button", { name: "Disconnect Revolut Business" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const sheet = await screen.findByRole("dialog", { name: "Disconnect Revolut Business" });
    await user.click(within(sheet).getByRole("button", { name: "Disconnect" }));
    expect(calls.find((c) => c.method === "POST")?.headers["X-Requested-With"]).toBe("camelthorn");
    expect(await screen.findByText(/Disconnected from Revolut Business/)).toBeTruthy();
  });

  it("explains a connection that needs re-authorisation", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([row({ status: "needs_reauth", lastError: "invalid_grant" })])),
    });
    renderApp("/settings/connections");
    await ready();
    expect(await card().findByText("Needs re-authorisation")).toBeTruthy();
    expect(card().getByRole("alert").textContent).toContain(
      "Revolut no longer accepts the saved sign-in.",
    );
    expect(card().getByRole("button", { name: "Re-authorise Revolut Business" })).toBeTruthy();
  });

  it("shows rejected app credentials as a configuration problem without a re-authorise button", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([row({ lastError: "token_endpoint_rejected_credentials" })])),
    });
    renderApp("/settings/connections");
    await ready();
    expect(await card().findByText("Configuration problem")).toBeTruthy();
    expect(card().getByRole("alert").textContent).toContain("REVOLUT_CLIENT_ID");
    expect(card().queryByRole("button", { name: "Re-authorise Revolut Business" })).toBeNull();
    expect(card().getByRole("button", { name: "Disconnect Revolut Business" })).toBeTruthy();
  });

  it("flags an undecided bank-entries choice and blocks re-authorising until it is made", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(
        body([
          row({
            revolut: {
              environment: "production",
              createsBankEntries: null,
              paymentsMode: "drafts",
            },
          }),
        ]),
      ),
    });
    renderApp("/settings/connections");
    await ready();
    expect((await card().findByRole("alert")).textContent).toContain("Nobody has said yet");
    expect(
      (card().getByRole("button", { name: "Re-authorise Revolut Business" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("disables Connect and says why when the server is not configured", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(body([], { revolutConfigured: false })) });
    renderApp("/settings/connections");
    const btn = await screen.findByRole("button", { name: "Connect Revolut Business" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(card().getByText(/not set up on the server yet/)).toBeTruthy();
  });

  it("shows non-admins the saved choices read-only, with no buttons", async () => {
    mockFetch({ ...ME_OK(VIEWER), ...list(body([row()])) });
    renderApp("/settings/connections");
    await ready();
    await card().findByText("Connected");
    expect(card().queryByRole("button")).toBeNull();
    for (const r of card().getAllByRole("radio"))
      expect((r as HTMLInputElement).disabled).toBe(true);
    expect(card().getByText(/Only admins can change this connection/)).toBeTruthy();
    expect(card().queryByRole("group", { name: "Environment" })).toBeNull();
  });

  it("reports the result of the connect round trip once", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(body([row()])) });
    renderApp("/settings/connections?revolut=connected");
    expect(await screen.findByText("Revolut Business is connected.")).toBeTruthy();
  });

  it.each([
    ["denied", /access was not granted/],
    ["unverified", /accounts could not be read/],
    ["error", /Could not finish connecting/],
  ])("explains a %s connect", async (result, text) => {
    mockFetch({ ...ME_OK(ADMIN), ...list(NONE) });
    renderApp(`/settings/connections?revolut=${result}`);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("has no accessibility violations: not connected, connected and needs re-authorisation", async () => {
    for (const b of [
      NONE,
      body([row()]),
      body([row({ status: "needs_reauth", lastError: "invalid_grant" })]),
    ]) {
      mockFetch({ ...ME_OK(ADMIN), ...list(b) });
      const { unmount } = renderApp("/settings/connections");
      await screen.findByRole("heading", { name: "Revolut Business" });
      await vi.waitFor(() => expect(card().getAllByRole("radio").length).toBeGreaterThan(0));
      expect(await axe(document.body)).toHaveNoViolations();
      unmount();
    }
  });
});
