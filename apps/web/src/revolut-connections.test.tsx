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
    // A working connection is never re-authorised over (disconnect first, review R2).
    expect(card().queryByRole("button", { name: "Re-authorise Revolut Business" })).toBeNull();
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
            status: "needs_reauth",
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
    const alerts = await card().findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toContain("Nobody has said yet");
    expect(alerts.map((a) => a.textContent).join(" ")).not.toContain("re-authorise,");
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
    ["confirm", /Check the accounts below, then confirm the connection/],
  ])("explains a %s connect", async (result, text) => {
    mockFetch({ ...ME_OK(ADMIN), ...list(NONE) });
    renderApp(`/settings/connections?revolut=${result}`);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  const SUMMARY: api.RevolutPendingSummary = {
    accountCount: 2,
    currencies: ["EUR", "USD"],
    holders: ["Camelthorn Advisory B.V."],
    accounts: [
      { name: "Main", currency: "EUR", state: "active", last4: "5678" },
      { name: "Dollars", currency: "USD", state: "inactive", last4: null },
    ],
    previousAccounts: 0,
    matchingAccounts: 0,
    stateEchoed: false,
  };
  const pendingRow = (
    pending: Partial<api.RevolutPending> = {},
    summary: Partial<api.RevolutPendingSummary> = {},
  ) =>
    row({
      status: "pending",
      connectedBy: null,
      revolut: {
        environment: "production",
        createsBankEntries: false,
        paymentsMode: "drafts",
        pending: {
          until: "2026-11-11T12:15:00.000Z",
          stagedBy: "gerrie@camelthorncapital.com",
          ref: "the-ref",
          summary: { ...SUMMARY, ...summary },
          ...pending,
        },
      },
    });

  it("a staged connection shows what was connected and needs the tick before Confirm", async () => {
    const calls = mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([pendingRow()])),
      "POST /api/connections/revolut/confirm": () => ({ body: { ok: true } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    const confirmBtn = (await screen.findByRole("button", {
      name: "Confirm connection",
    })) as HTMLButtonElement;
    expect(card().getByText("Waiting for your confirmation")).toBeTruthy();
    expect(card().getByText("Camelthorn Advisory B.V.")).toBeTruthy();
    expect(card().getByText("2 accounts in EUR, USD")).toBeTruthy();
    const table = card().getByRole("table", { name: "Revolut accounts that were connected" });
    expect(within(table).getByText("•••• 5678")).toBeTruthy();
    expect(within(table).getByText("No IBAN")).toBeTruthy();
    expect(within(table).getByText(/inactive/)).toBeTruthy();
    // The setup form is not offered while a staging waits.
    expect(card().queryByRole("radio")).toBeNull();
    expect(card().queryByRole("button", { name: /Connect Revolut Business/ })).toBeNull();
    expect(confirmBtn.disabled).toBe(true);
    // Focus moves to the panel heading so a keyboard or screen reader user lands on it.
    expect(document.activeElement?.textContent).toBe("Check what was connected");

    await user.click(
      card().getByRole("checkbox", { name: "This is our Revolut Business account" }),
    );
    expect(confirmBtn.disabled).toBe(false);
    await user.click(confirmBtn);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/connections/revolut/confirm");
    expect(post?.body).toEqual({ ref: "the-ref", ownAccount: true });
    expect(await screen.findByText("Revolut Business is connected.")).toBeTruthy();
  });

  it("accounts that all differ from the ones connected before need a second tick", async () => {
    const calls = mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([pendingRow({}, { previousAccounts: 3, matchingAccounts: 0 })])),
      "POST /api/connections/revolut/confirm": () => ({ body: { ok: true } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    const confirmBtn = (await screen.findByRole("button", {
      name: "Confirm connection",
    })) as HTMLButtonElement;
    expect(card().getByRole("alert").textContent).toContain("may be a different Revolut Business");
    await user.click(
      card().getByRole("checkbox", { name: "This is our Revolut Business account" }),
    );
    expect(confirmBtn.disabled).toBe(true);
    await user.click(
      card().getByRole("checkbox", { name: /Replace the accounts connected before/ }),
    );
    await user.click(confirmBtn);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      ref: "the-ref",
      ownAccount: true,
      replacesAccounts: true,
    });
  });

  it("confirming with a stale sign-in opens the step-up sheet; an expired staging is explained", async () => {
    let answer: { status: number; body: unknown } = {
      status: 401,
      body: { error: "step_up_required" },
    };
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([pendingRow()])),
      "POST /api/connections/revolut/confirm": () => answer,
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await user.click(
      await screen.findByRole("checkbox", { name: "This is our Revolut Business account" }),
    );
    await user.click(card().getByRole("button", { name: "Confirm connection" }));
    const sheet = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    answer = { status: 410, body: { error: "pending_expired" } };
    await user.click(card().getByRole("button", { name: "Confirm connection" }));
    expect((await card().findByRole("alert")).textContent).toContain("not confirmed within 15");
  });

  it("Cancel, not our account removes the staging after a confirmation sheet", async () => {
    const calls = mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([pendingRow()])),
      "POST /api/connections/revolut/disconnect": () => ({ body: { ok: true, changed: true } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await user.click(await screen.findByRole("button", { name: "Cancel, not our account" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const sheet = await screen.findByRole("dialog", { name: "Cancel this connection" });
    await user.click(within(sheet).getByRole("button", { name: "Cancel connection" }));
    expect(calls.find((c) => c.method === "POST")?.url).toBe("/api/connections/revolut/disconnect");
    expect(await screen.findByText(/Connection cancelled/)).toBeTruthy();
  });

  it("non-admins see the staged summary but no ref-bound buttons", async () => {
    mockFetch({ ...ME_OK(VIEWER), ...list(body([pendingRow({ ref: undefined })])) });
    renderApp("/settings/connections");
    await ready();
    expect(await card().findByText("Waiting for your confirmation")).toBeTruthy();
    expect(card().getByText(/An admin must confirm this connection/)).toBeTruthy();
    expect(card().queryByRole("button")).toBeNull();
    expect(card().queryByRole("checkbox")).toBeNull();
  });

  it("a staging whose accounts could not be read only offers Cancel", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(body([pendingRow({ summary: null })])) });
    renderApp("/settings/connections");
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(card().queryByRole("button", { name: "Confirm connection" })).toBeNull();
    expect(card().getByRole("alert").textContent).toContain("could not be read yet");
  });

  it("says when the last staging expired unconfirmed", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(body([row({ status: "disabled", lastError: "pending_expired", connectedBy: null })])),
    });
    renderApp("/settings/connections");
    expect(await screen.findByText(/was not confirmed within 15 minutes/)).toBeTruthy();
    expect(card().getByRole("button", { name: "Connect Revolut Business" })).toBeTruthy();
  });

  it("has no accessibility violations: waiting for confirmation (admin and viewer)", async () => {
    for (const me of [ADMIN, VIEWER]) {
      mockFetch({ ...ME_OK(me), ...list(body([pendingRow()])) });
      const { unmount } = renderApp("/settings/connections");
      await screen.findByText("Check what was connected");
      expect(await axe(document.body)).toHaveNoViolations();
      unmount();
    }
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
