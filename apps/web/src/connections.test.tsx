import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import * as api from "./api";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const ME_OK = (me: api.Me) => ({ "GET /api/auth/me": () => ({ body: me }) });

const EXACT_ACTIVE: api.ConnectionsResponse = {
  exactConfigured: true,
  connections: [
    {
      kind: "exact",
      name: "exact",
      status: "active",
      expiresAt: null,
      lastError: null,
      connectedBy: "gerrie@camelthorncapital.com",
      connectedAt: null,
      divisions: [{ division: 123456, name: "Camelthorn Advisory B.V.", currency: "EUR" }],
    },
  ],
};
const NONE: api.ConnectionsResponse = { exactConfigured: true, connections: [] };
const REAUTH: api.ConnectionsResponse = {
  exactConfigured: true,
  connections: [
    {
      ...(EXACT_ACTIVE.connections[0] as api.ConnectionRow),
      status: "needs_reauth",
      lastError: "invalid_grant",
    },
  ],
};

const list = (body: api.ConnectionsResponse) => ({ "GET /api/connections": () => ({ body }) });

describe("Settings, Connections", () => {
  it("shows a skeleton while loading, then the connected state with divisions", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(EXACT_ACTIVE) });
    renderApp("/settings/connections");
    expect(await screen.findByRole("status", { name: "Loading connections" })).toBeTruthy();
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("Camelthorn Advisory B.V.")).toBeTruthy();
    expect(screen.getByText("123456")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-authorise" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/token/i);
  });

  it("shows Not connected with a Connect button", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(NONE) });
    renderApp("/settings/connections");
    expect(await screen.findByText("Not connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Exact Online" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("explains a connection that needs re-authorisation", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(REAUTH) });
    renderApp("/settings/connections");
    expect(await screen.findByText("Needs re-authorisation")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Exact no longer accepts the saved sign-in.",
    );
    expect(screen.getByRole("button", { name: "Re-authorise" })).toBeTruthy();
  });

  it("hides the buttons from non-admins", async () => {
    mockFetch({ ...ME_OK(VIEWER), ...list(EXACT_ACTIVE) });
    renderApp("/settings/connections");
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-authorise" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.getByText(/Only admins can change this connection/)).toBeTruthy();
  });

  it("disables Connect and says why when the server is not configured", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list({ exactConfigured: false, connections: [] }) });
    renderApp("/settings/connections");
    const btn = await screen.findByRole("button", { name: "Connect Exact Online" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/not set up on the server yet/)).toBeTruthy();
  });

  it("navigates to the start route when the sign-in is fresh", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(NONE) });
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await user.click(await screen.findByRole("button", { name: "Connect Exact Online" }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/api/connections/exact/start"));
  });

  it("asks for a Google sign-in first when the step-up window has passed", async () => {
    mockFetch({
      "GET /api/auth/me": () => ({ body: { ...ADMIN, stepUpFresh: false } }),
      ...list(NONE),
    });
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await user.click(await screen.findByRole("button", { name: "Connect Exact Online" }));
    const sheet = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(assign).not.toHaveBeenCalled();
    await user.click(within(sheet).getByRole("button", { name: "Sign in again" }));
    const url = new URL(String(assign.mock.calls[0]?.[0]), "http://x");
    expect(url.pathname).toBe("/api/auth/login");
    expect(url.searchParams.get("step_up")).toBe("1");
    expect(url.searchParams.get("return_to")).toBe("/settings/connections");
  });

  it("disconnects only after confirmation and toasts", async () => {
    const calls = mockFetch({
      ...ME_OK(ADMIN),
      ...list(EXACT_ACTIVE),
      "POST /api/connections/exact/disconnect": () => ({ body: { ok: true } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const sheet = await screen.findByRole("dialog", { name: "Disconnect Exact Online" });
    await user.click(within(sheet).getByRole("button", { name: "Disconnect" }));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.headers["X-Requested-With"]).toBe("camelthorn");
    expect(await screen.findByText(/Disconnected from Exact Online/)).toBeTruthy();
  });

  it("handles step_up_required on disconnect like the Users tab", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(EXACT_ACTIVE),
      "POST /api/connections/exact/disconnect": () => ({
        status: 401,
        body: { error: "step_up_required" },
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    const sheet = await screen.findByRole("dialog", { name: "Disconnect Exact Online" });
    await user.click(within(sheet).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("dialog", { name: "Confirm it's you" })).toBeTruthy();
  });

  it("returns keyboard focus to the button that opened a sheet", async () => {
    mockFetch({
      "GET /api/auth/me": () => ({ body: { ...ADMIN, stepUpFresh: false } }),
      ...list(EXACT_ACTIVE),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    const reauth = await screen.findByRole("button", { name: "Re-authorise" });
    await user.click(reauth);
    const sheet = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(document.activeElement).toBe(reauth));
    const disc = screen.getByRole("button", { name: "Disconnect" });
    await user.click(disc);
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(disc));
  });

  it("reports the result of the connect round trip once and cleans the URL", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(EXACT_ACTIVE) });
    renderApp("/settings/connections?exact=connected");
    expect(await screen.findByText("Exact Online is connected.")).toBeTruthy();
  });

  it("explains a denied connect", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(NONE) });
    renderApp("/settings/connections?exact=denied");
    expect(await screen.findByText(/access was not granted/)).toBeTruthy();
  });

  it("shows an error when the list cannot be loaded", async () => {
    mockFetch({ ...ME_OK(ADMIN), "GET /api/connections": () => ({ status: 500, body: {} }) });
    renderApp("/settings/connections");
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
  });

  it("has no accessibility violations", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(REAUTH) });
    const { container } = renderApp("/settings/connections");
    await screen.findByText("Needs re-authorisation");
    expect(await axe(container)).toHaveNoViolations();
  });
});
