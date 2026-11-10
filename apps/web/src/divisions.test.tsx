import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { DivisionInfo, DivisionsResponse, Me, SyncResponse } from "./api";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const ME_OK = (me: Me) => ({ "GET /api/auth/me": () => ({ body: me }) });
const FINANCE: Me = { ...ADMIN, email: "f@camelthorncapital.com", roles: ["finance"] };

const div = (id: number, name: string, over: Partial<DivisionInfo> = {}): DivisionInfo => ({
  id,
  division: 1000 + id,
  name,
  currency: "EUR",
  connectionStatus: "active",
  syncing: false,
  lastSync: null,
  ...over,
});
const two: DivisionsResponse = {
  selectedId: 2,
  divisions: [div(1, "Alpha BV"), div(2, "Beta BV")],
};
const divisions = (body: DivisionsResponse) => ({ "GET /api/divisions": () => ({ body }) });
const CONNECTIONS = {
  "GET /api/connections": () => ({
    body: {
      exactConfigured: true,
      connections: [
        {
          kind: "exact",
          name: "exact",
          status: "active",
          expiresAt: null,
          lastError: null,
          connectedBy: "x@camelthorncapital.com",
          connectedAt: null,
          divisions: [],
        },
      ],
    },
  }),
};

describe("administration switcher", () => {
  it("shows the selected administration in a labelled select with every option", async () => {
    mockFetch({ ...ME_OK(VIEWER), ...divisions(two) });
    renderApp("/today");
    const select = (await screen.findByRole("combobox", {
      name: "Administration",
    })) as HTMLSelectElement;
    expect(select.value).toBe("2");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Alpha BV", "Beta BV"]);
    expect(select.closest("nav")).not.toBeNull();
  });

  it("switches by keyboard, saving the choice with the CSRF header", async () => {
    const calls = mockFetch({
      ...ME_OK(VIEWER),
      ...divisions(two),
      "PUT /api/me/division": () => ({ body: { selectedId: 1 } }),
    });
    const user = userEvent.setup();
    renderApp("/today");
    const select = (await screen.findByRole("combobox", {
      name: "Administration",
    })) as HTMLSelectElement;
    select.focus();
    await user.selectOptions(select, "Alpha BV");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/me/division");
    expect(put?.body).toEqual({ divisionId: 1 });
    expect(put?.headers["X-Requested-With"]).toBe("camelthorn");
    await waitFor(() => expect(select.value).toBe("1"));
  });

  it("puts the old choice back and says so when the server refuses", async () => {
    mockFetch({
      ...ME_OK(VIEWER),
      ...divisions(two),
      "PUT /api/me/division": () => ({ status: 404, body: { error: "unknown_division" } }),
    });
    const user = userEvent.setup();
    renderApp("/today");
    const select = (await screen.findByRole("combobox", {
      name: "Administration",
    })) as HTMLSelectElement;
    await user.selectOptions(select, "Alpha BV");
    expect(await screen.findByText("Could not switch administration. Try again.")).toBeTruthy();
    await waitFor(() => expect(select.value).toBe("2"));
  });

  it("is a plain label with a single administration and absent with none", async () => {
    mockFetch({
      ...ME_OK(VIEWER),
      ...divisions({ selectedId: 1, divisions: [div(1, "Only BV")] }),
    });
    const { unmount } = renderApp("/today");
    expect(await screen.findByText("Only BV")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    unmount();
    mockFetch({ ...ME_OK(VIEWER), ...divisions({ selectedId: null, divisions: [] }) });
    renderApp("/today");
    await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not break the app when the division list cannot be loaded", async () => {
    mockFetch({
      ...ME_OK(VIEWER),
      "GET /api/divisions": () => ({ status: 500, body: { error: "internal_error" } }),
    });
    renderApp("/today");
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("has no accessibility violations", async () => {
    mockFetch({ ...ME_OK(VIEWER), ...divisions(two) });
    const { container } = renderApp("/today");
    await screen.findByRole("combobox", { name: "Administration" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

const ok: SyncResponse = {
  status: "ok",
  mode: "incremental",
  callsUsed: 5,
  finishedAt: new Date().toISOString(),
  entities: {
    relations: { status: "ok", rows: 3, calls: 2 },
    receivables: { status: "ok", rows: 1, calls: 1 },
    payables: { status: "ok", rows: 0, calls: 1 },
  },
};

describe("Settings, Connections: data sync", () => {
  it("shows a skeleton, then last sync as an 'Updated x ago' stamp per administration", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    mockFetch({
      ...ME_OK(ADMIN),
      ...CONNECTIONS,
      ...divisions({
        selectedId: 1,
        divisions: [
          div(1, "Alpha BV", {
            lastSync: {
              status: "ok",
              mode: "full",
              error: null,
              finishedAt: fiveMinAgo,
              completedAt: fiveMinAgo,
            },
          }),
          div(2, "Beta BV"),
        ],
      }),
    });
    renderApp("/settings/connections");
    expect(await screen.findByRole("status", { name: "Loading sync status" })).toBeTruthy();
    const alpha = (await screen.findByRole("cell", { name: "Alpha BV" })).closest(
      "tr",
    ) as HTMLElement;
    expect(within(alpha).getByText("Up to date")).toBeTruthy();
    expect(within(alpha).getByText("Updated 5 min ago")).toBeTruthy();
    const beta = screen.getByRole("cell", { name: "Beta BV" }).closest("tr") as HTMLElement;
    expect(within(beta).getByText("Not synced yet")).toBeTruthy();
    expect(within(beta).getByText("Never")).toBeTruthy();
    // the connection card stamp follows the selected administration's last sync
    expect(screen.getAllByText("Updated 5 min ago").length).toBeGreaterThanOrEqual(2);
  });

  it("hides the sync buttons from viewers", async () => {
    mockFetch({ ...ME_OK(VIEWER), ...CONNECTIONS, ...divisions(two) });
    renderApp("/settings/connections");
    await screen.findByRole("cell", { name: "Alpha BV" });
    expect(screen.queryByRole("button", { name: /Sync/ })).toBeNull();
    expect(screen.getByText(/Only admins and finance users can start a sync/)).toBeTruthy();
  });

  it("runs Sync now for finance with progress and a result message, then refreshes", async () => {
    let list = 0;
    const calls = mockFetch({
      ...ME_OK(FINANCE),
      ...CONNECTIONS,
      "GET /api/divisions": () => {
        list++;
        return {
          body: {
            selectedId: 1,
            divisions: [
              div(1, "Alpha BV", {
                lastSync:
                  list > 1
                    ? {
                        status: "ok",
                        mode: "incremental",
                        error: null,
                        finishedAt: new Date().toISOString(),
                        completedAt: null,
                      }
                    : null,
              }),
            ],
          },
        };
      },
      "POST /api/divisions/1/sync": () => ({ body: ok }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    const btn = await screen.findByRole("button", { name: "Sync Alpha BV now" });
    await user.click(btn);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/divisions/1/sync");
    expect(post?.body).toEqual({ mode: "incremental" });
    expect(post?.headers["X-Requested-With"]).toBe("camelthorn");
    expect(
      await screen.findAllByText("Alpha BV is up to date: 3 relations, 1 receivable, 0 payables."),
    ).toBeTruthy();
    await waitFor(() => expect(list).toBe(2));
    expect((await screen.findAllByText("Updated just now")).length).toBeGreaterThan(0);
  });

  it("asks for a full sync explicitly", async () => {
    const calls = mockFetch({
      ...ME_OK(ADMIN),
      ...CONNECTIONS,
      ...divisions(two),
      "POST /api/divisions/2/sync": () => ({ body: { ...ok, mode: "full" } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await user.click(await screen.findByRole("button", { name: "Run a full sync of Beta BV" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ mode: "full" });
  });

  it("explains a partial result and how to continue", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...CONNECTIONS,
      ...divisions(two),
      "POST /api/divisions/1/sync": () => ({ body: { ...ok, status: "partial" } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    await user.click(await screen.findByRole("button", { name: "Sync Alpha BV now" }));
    const msg = (await screen.findAllByText(/is partly synced/))[0] as HTMLElement;
    expect(msg.textContent).toContain("Sync again to continue where it stopped");
    expect(msg.textContent).not.toContain("!");
  });

  it("says when a sync is already running or the connection needs re-authorisation", async () => {
    let n = 0;
    mockFetch({
      ...ME_OK(ADMIN),
      ...CONNECTIONS,
      ...divisions(two),
      "POST /api/divisions/1/sync": () => {
        n++;
        return n === 1
          ? { status: 409, body: { error: "sync_running" } }
          : { status: 409, body: { error: "needs_reauth" } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings/connections");
    const btn = await screen.findByRole("button", { name: "Sync Alpha BV now" });
    await user.click(btn);
    expect((await screen.findAllByText("A sync of Alpha BV is already running."))[0]).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Sync Alpha BV now" }));
    expect((await screen.findAllByText(/needs to be re-authorised/))[0]).toBeTruthy();
  });

  it("disables syncing for an administration whose connection is not active", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...CONNECTIONS,
      ...divisions({
        selectedId: 1,
        divisions: [div(1, "Alpha BV", { connectionStatus: "needs_reauth" })],
      }),
    });
    renderApp("/settings/connections");
    const btn = (await screen.findByRole("button", {
      name: "Sync Alpha BV now",
    })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("has no accessibility violations", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...CONNECTIONS, ...divisions(two) });
    const { container } = renderApp("/settings/connections");
    await screen.findByRole("cell", { name: "Alpha BV" });
    expect(await axe(container)).toHaveNoViolations();
  });
});
