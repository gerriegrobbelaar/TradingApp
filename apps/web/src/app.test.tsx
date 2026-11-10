import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import * as api from "./api";
import { ADMIN, USERS, VIEWER, mockFetch, renderApp } from "./test-utils";

// jsdom has no canvas, so colour contrast is checked in packages/ui instead.
const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

const ME_OK = (me: api.Me) => ({ "GET /api/auth/me": () => ({ body: me }) });
const SIGNED_OUT = {
  "GET /api/auth/me": () => ({ status: 401, body: { error: "unauthenticated" } }),
};

describe("signed-out screens", () => {
  it("shows the sign-in card with a link to the login route and no redirect", async () => {
    mockFetch(SIGNED_OUT);
    const assign = vi.spyOn(api.nav, "assign");
    renderApp();
    expect(screen.getByRole("status").textContent).toContain("Checking your session");
    const link = await screen.findByRole("link", { name: "Sign in with Google" });
    expect(link.getAttribute("href")).toMatch(/^\/api\/auth\/login/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("shows the denied message without exclamation marks", async () => {
    mockFetch(SIGNED_OUT);
    renderApp("/?auth=denied");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "That Google account has no access. Ask an admin to invite your @camelthorncapital.com email.",
    );
    expect(alert.textContent).not.toContain("!");
  });

  it("has no axe violations", async () => {
    mockFetch(SIGNED_OUT);
    const { container } = renderApp("/?auth=denied");
    await screen.findByRole("alert");
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("navigation", () => {
  it("renders the top menu and a coming-soon page with one h1", async () => {
    mockFetch(ME_OK(VIEWER));
    renderApp("/overview");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    for (const name of ["Today", "Overview", "Invoices", "Close", "Settings"]) {
      expect(within(nav).getByRole("link", { name })).toBeTruthy();
    }
    for (const name of ["Purchases", "Treasury", "Reporting"]) {
      expect(within(nav).getByText(name)).toBeTruthy();
    }
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Overview");
    expect(screen.getByText(/not built yet/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toBeTruthy();
  });

  it("redirects / to Today", async () => {
    mockFetch(ME_OK(VIEWER));
    renderApp("/");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Today");
  });

  it("opens a dropdown by keyboard, lists its links and closes on Escape", async () => {
    mockFetch(ME_OK(VIEWER));
    const user = userEvent.setup();
    renderApp("/today");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const trigger = within(nav).getByText("Reporting").closest("summary") as HTMLElement;
    const details = trigger.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);

    trigger.focus();
    await user.keyboard("{Enter}");
    expect(details.open).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    for (const name of [
      "Balance sheet",
      "Profit and loss",
      "Creditors age analysis",
      "Receivables age analysis",
    ]) {
      expect(within(details).getByRole("link", { name })).toBeTruthy();
    }
    await user.keyboard("{Escape}");
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("navigates from a dropdown, closes it and marks the group active", async () => {
    mockFetch(ME_OK(VIEWER));
    const user = userEvent.setup();
    renderApp("/today");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    await user.click(within(nav).getByText("Treasury"));
    await user.click(within(nav).getByRole("link", { name: /Cash forecast/ }));
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Cash forecast");
    const summary = within(nav).getByText("Treasury").closest("summary") as HTMLElement;
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(summary.className).toBe("on");
  });

  it("shows a not-found page for unknown routes", async () => {
    mockFetch(ME_OK(VIEWER));
    renderApp("/nope");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Page not found");
  });

  it("has no axe violations on the main screens", async () => {
    mockFetch({ ...ME_OK(ADMIN), "GET /api/users": () => ({ body: USERS }) });
    for (const path of ["/overview", "/settings/appearance", "/settings/users"]) {
      const { container, unmount } = renderApp(path);
      await screen.findByRole("navigation", { name: "Main" });
      if (path.endsWith("users")) await screen.findByRole("table");
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});

describe("settings", () => {
  it("hides the Users tab from non-admins and redirects away from it", async () => {
    mockFetch(ME_OK(VIEWER));
    renderApp("/settings/users");
    const group = await screen.findByRole("group", { name: "Settings section" });
    expect(within(group).queryByRole("button", { name: "Users" })).toBeNull();
    expect(
      within(group).getByRole("button", { name: "Appearance" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(group).getByRole("button", { name: "Connections" })).toBeTruthy();
  });

  it("shows the Users tab to admins", async () => {
    mockFetch({ ...ME_OK(ADMIN), "GET /api/users": () => ({ body: USERS }) });
    renderApp("/settings/appearance");
    const group = await screen.findByRole("group", { name: "Settings section" });
    expect(within(group).getByRole("button", { name: "Users" })).toBeTruthy();
  });

  it("switches the theme and persists it", async () => {
    mockFetch(ME_OK(VIEWER));
    const user = userEvent.setup();
    renderApp("/settings/appearance");
    const theme = await screen.findByRole("group", { name: "Theme" });
    expect(within(theme).getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(within(theme).getByRole("button", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("camelthorn.theme")).toBe("dark");
    await user.click(within(theme).getByRole("button", { name: "Auto" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("camelthorn.theme")).toBe("auto");
  });

  it("reads the stored theme on load", async () => {
    localStorage.setItem("camelthorn.theme", "light");
    mockFetch(ME_OK(VIEWER));
    renderApp("/settings/appearance");
    const theme = await screen.findByRole("group", { name: "Theme" });
    expect(within(theme).getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});

describe("users", () => {
  const base = { ...ME_OK(ADMIN), "GET /api/users": () => ({ body: USERS }) };

  it("rejects an email outside the company domain without calling the API", async () => {
    const calls = mockFetch(base);
    const user = userEvent.setup();
    renderApp("/settings/users");
    await user.type(await screen.findByLabelText("Email"), "someone@gmail.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Use an @camelthorncapital.com email address.",
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("invites with the chosen roles, sends the CSRF header and toasts", async () => {
    const calls = mockFetch({
      ...base,
      "POST /api/users/invite": () => ({ status: 201, body: { id: 5 } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/users");
    await user.type(await screen.findByLabelText("Email"), " New.Person@CamelthornCapital.com ");
    await user.click(screen.getByRole("checkbox", { name: "finance" }));
    await user.click(screen.getByRole("button", { name: "Send invite" }));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      email: "new.person@camelthorncapital.com",
      roles: ["viewer", "finance"],
    });
    expect(post?.headers["X-Requested-With"]).toBe("camelthorn");
    expect(await screen.findByText("Invited new.person@camelthorncapital.com.")).toBeTruthy();
  });

  it("asks to confirm identity on step_up_required and starts step-up on click", async () => {
    mockFetch({
      ...base,
      "POST /api/users/invite": () => ({ status: 401, body: { error: "step_up_required" } }),
    });
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderApp("/settings/users");
    await user.type(await screen.findByLabelText("Email"), "a@camelthorncapital.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));
    const sheet = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(assign).not.toHaveBeenCalled();
    await user.click(within(sheet).getByRole("button", { name: "Sign in again" }));
    expect(assign).toHaveBeenCalledTimes(1);
    const url = new URL(String(assign.mock.calls[0]?.[0]), "http://x");
    expect(url.pathname).toBe("/api/auth/login");
    expect(url.searchParams.get("step_up")).toBe("1");
    expect(url.searchParams.get("return_to")).toBeTruthy();
  });

  it("removes a user only after confirmation", async () => {
    const calls = mockFetch({ ...base, "DELETE /api/users/2": () => ({ body: { id: 2 } }) });
    const user = userEvent.setup();
    renderApp("/settings/users");
    await user.click(await screen.findByRole("button", { name: /Remove v@camelthorncapital.com/ }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const sheet = await screen.findByRole("dialog", { name: "Remove this user" });
    await user.click(within(sheet).getByRole("button", { name: "Remove user" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(await screen.findByText("Removed v@camelthorncapital.com.")).toBeTruthy();
  });

  it("changes roles and shows the server's plain-language error", async () => {
    mockFetch({
      ...base,
      "PATCH /api/users/1/roles": () => ({ status: 409, body: { error: "last_admin" } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/users");
    await user.click(await screen.findByRole("button", { name: /Change roles for gerrie/ }));
    const sheet = await screen.findByRole("dialog", { name: "Change roles" });
    await user.click(within(sheet).getByRole("checkbox", { name: "admin" }));
    await user.click(within(sheet).getByRole("button", { name: "Save roles" }));
    expect((await within(sheet).findByRole("alert")).textContent).toMatch(/always be one admin/);
  });

  it("shows an inline error when the list fails to load", async () => {
    mockFetch({ ...ME_OK(ADMIN), "GET /api/users": () => ({ status: 500, body: {} }) });
    renderApp("/settings/users");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Something went wrong/);
  });
});
