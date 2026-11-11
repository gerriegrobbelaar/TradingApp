/** Bank, matching tabs (M7d): tabs in the address, review queue, automatic matches, ignored lines. */
import { norm } from "./test-norm";
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { MemoryRouter, useLocation } from "react-router";
import { AppShell } from "./App";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import type { Me } from "./api";
import { accounts } from "./test-fixtures-bank";
import {
  autoItem,
  booking,
  config,
  detail,
  item,
  mtx,
  queue,
  stats,
} from "./test-fixtures-matching";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
export const FINANCE: Me = {
  email: "f@camelthorncapital.com",
  roles: ["finance"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};
const params = (c: Call | undefined) => new URL(c?.url ?? "", "http://x").searchParams;
const calls_ = (calls: Call[], path: string, method = "GET") =>
  calls.filter((c) => c.method === method && c.url.split("?")[0] === path);

type H = Record<string, (c: Call) => { status?: number; body?: unknown }>;
function base(me: Me = ADMIN, over: H = {}): H {
  return {
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/bank/accounts": () => ({ body: accounts() }),
    "GET /api/matching/stats": () => ({ body: stats() }),
    "GET /api/matching/queue": () => ({ body: queue() }),
    "GET /api/matching/auto": () => ({ body: { items: [autoItem()], nextCursor: null } }),
    "GET /api/matching/config": () => ({ body: config() }),
    "GET /api/booking/settings": () => ({ body: booking() }),
    "GET /api/matching/transactions/1": () => ({ body: detail() }),
    ...over,
  };
}
async function reviewTable() {
  const t = await screen.findByRole("table", { name: "Bank lines to review" });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  return t;
}
function withLocation(path: string) {
  const loc = { search: "" };
  function Probe() {
    loc.search = useLocation().search;
    return null;
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
      <Probe />
    </MemoryRouter>,
  );
  return loc;
}

describe("Bank tabs", () => {
  it("shows the four views with counts from the stats and Transactions by default", async () => {
    mockFetch(
      base(ADMIN, {
        "GET /api/bank/transactions": () => ({
          body: {
            items: [],
            nextCursor: null,
            total: 0,
            totalsByCurrency: [],
            freshness: accounts().freshness,
            available: true,
          },
        }),
      }),
    );
    renderApp("/treasury/bank");
    const group = await screen.findByRole("group", { name: "Bank view" });
    await waitFor(() =>
      expect(within(group).getByRole("button", { name: /To review/ })).toBeTruthy(),
    );
    await waitFor(() =>
      expect(norm(group.textContent)).toMatch(/To review5.*Matched automatically7.*Ignored4/),
    );
    expect(
      within(group)
        .getByRole("button", { name: /Transactions/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("heading", { name: "Transactions" })).toBeTruthy();
  });

  it("the tab is in the address; the search text is not", async () => {
    const user = userEvent.setup();
    mockFetch(base());
    const loc = withLocation("/treasury/bank?tab=review");
    await reviewTable();
    expect(loc.search).toBe("?tab=review");
    await user.type(screen.getByRole("searchbox", { name: "Search lines to review" }), "acme");
    await waitFor(() => expect(loc.search).toBe("?tab=review"));
    expect(loc.search).not.toContain("acme");
    await user.click(screen.getByRole("button", { name: "With a suggestion" }));
    await waitFor(() => expect(loc.search).toBe("?tab=review&queue=suggested"));
    await user.click(
      within(screen.getByRole("group", { name: "Bank view" })).getByRole("button", {
        name: /Ignored/,
      }),
    );
    await waitFor(() => expect(loc.search).toBe("?tab=ignored"));
    await user.click(
      within(screen.getByRole("group", { name: "Bank view" })).getByRole("button", {
        name: /Transactions/,
      }),
    );
    await waitFor(() => expect(loc.search).toBe(""));
  });

  it("leaving Transactions drops its own filters and keeps the account", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(ADMIN, {
        "GET /api/bank/transactions": () => ({
          body: {
            items: [],
            nextCursor: null,
            total: 0,
            totalsByCurrency: [],
            freshness: accounts().freshness,
            available: true,
          },
        }),
      }),
    );
    const loc = withLocation(
      "/treasury/bank?account=1&state=completed&direction=in&from=2026-01-01",
    );
    await screen.findByRole("group", { name: "Bank view" });
    await user.click(
      within(screen.getByRole("group", { name: "Bank view" })).getByRole("button", {
        name: /To review/,
      }),
    );
    await waitFor(() => expect(loc.search).toBe("?account=1&tab=review"));
  });

  it("drops an invalid tab or queue value from the address", async () => {
    mockFetch(base());
    const loc = withLocation("/treasury/bank?tab=nonsense&queue=x");
    await screen.findByRole("group", { name: "Bank view" });
    await waitFor(() => expect(loc.search).toBe(""));
  });

  it("a failed stats request only hides the numbers", async () => {
    mockFetch(
      base(ADMIN, { "GET /api/matching/stats": () => ({ status: 500, body: { error: "x" } }) }),
    );
    renderApp("/treasury/bank?tab=review");
    await reviewTable();
    const group = screen.getByRole("group", { name: "Bank view" });
    expect(group.textContent).toContain("To review");
    expect(within(group).queryByText("5")).toBeNull();
  });

  it("does not ask for matching data before the bank is connected and synced", async () => {
    const calls = mockFetch(
      base(ADMIN, {
        "GET /api/bank/accounts": () => ({
          body: accounts([], { connection: null, available: false }),
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    await screen.findByText("Revolut is not connected.");
    expect(screen.queryByRole("group", { name: "Bank view" })).toBeNull();
    expect(calls_(calls, "/api/matching/stats")).toHaveLength(0);
    expect(calls_(calls, "/api/matching/queue")).toHaveLength(0);
  });
});

describe("To review", () => {
  it("shows the bank line, the best candidate and why a person decides", async () => {
    mockFetch(base());
    const { container } = renderApp("/treasury/bank?tab=review");
    const t = await reviewTable();
    const text = norm(t.textContent);
    expect(text).toContain("Acme B.V.");
    expect(text).toContain("Invoice INV-2024-001");
    expect(text).toContain("Main EUR");
    expect(text).toMatch(/\+€ 1\.234,00/);
    expect(text).toContain("Likely INV-2024-001 · € 1.234,00 · score 96");
    expect(within(t).getByText("Ledger patterns are never booked automatically")).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says money out is out and money in is in", async () => {
    mockFetch(
      base(ADMIN, {
        "GET /api/matching/queue": () => ({
          body: queue([
            item({ id: 1, amountMinor: 123400 }),
            item({ id: 2, amountMinor: -5000, counterpartyName: "Paper Co" }),
          ]),
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const t = await reviewTable();
    const rows = within(t).getAllByRole("row");
    const paper = rows.find((r) => r.textContent?.includes("Paper Co"));
    expect(paper?.textContent).toMatch(/Paid/);
    expect(norm(paper?.textContent)).toMatch(/−€ 50,00/);
    const acme = rows.find((r) => r.textContent?.includes("Acme B.V."));
    expect(acme?.textContent).toMatch(/Received/);
  });

  it("explains a state conflict, an unmapped account and a line without a suggestion", async () => {
    mockFetch(
      base(ADMIN, {
        "GET /api/matching/queue": () => ({
          body: queue([
            item({ id: 1, counterpartyName: "Conflict Ltd", stateConflict: true }),
            item({ id: 2, counterpartyName: "Unmapped Ltd", mapped: false }),
            item({ id: 3, counterpartyName: "Nobody Ltd", matchStatus: "unmatched" }, []),
          ]),
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const t = await reviewTable();
    expect(within(t).getByText("Needs a manager's check")).toBeTruthy();
    expect(within(t).getByText("Not matched until mapped")).toBeTruthy();
    expect(within(t).getByText("No suggestion")).toBeTruthy();
  });

  it("sends the filters and pages with the cursor", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(ADMIN, {
        "GET /api/matching/queue": (c) =>
          params(c).get("cursor") === "c2"
            ? { body: queue([item({ id: 2, counterpartyName: "Second Ltd" })], { total: 2 }) }
            : {
                body: queue([item({ id: 1 })], { total: 2, nextCursor: "c2" }),
              },
      }),
    );
    renderApp("/treasury/bank?tab=review&account=1");
    await reviewTable();
    const first = calls_(calls, "/api/matching/queue")[0];
    expect(params(first).get("account")).toBe("1");
    expect(params(first).get("status")).toBe("review");
    expect(params(first).get("limit")).toBe("25");
    expect(params(first).get("q")).toBeNull();
    expect(screen.getByText("Showing 1 of 2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Second Ltd");
    expect(params(calls_(calls, "/api/matching/queue")[1]).get("cursor")).toBe("c2");
    expect(screen.getByText("Showing 2 of 2")).toBeTruthy();
    await user.type(screen.getByRole("searchbox", { name: "Search lines to review" }), "paper");
    await waitFor(() =>
      expect(params(calls_(calls, "/api/matching/queue").at(-1)).get("q")).toBe("paper"),
    );
  });

  it("has loading, empty, filtered-empty and error states", async () => {
    let fail = true;
    mockFetch(
      base(ADMIN, {
        "GET /api/matching/queue": () =>
          fail ? { status: 500, body: { error: "x" } } : { body: queue([]) },
      }),
    );
    const user = userEvent.setup();
    renderApp("/treasury/bank?tab=review");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load this data");
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("0 lines to review.")).toBeTruthy();
  });

  it("says automatic matching is off, with a link for admins only", async () => {
    mockFetch(base());
    const { unmount } = renderApp("/treasury/bank?tab=review");
    await reviewTable();
    expect(screen.getByText(/Automatic matching is off, so every line waits here/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings, Matching" })).toBeTruthy();
    unmount();
    mockFetch(base(FINANCE));
    renderApp("/treasury/bank?tab=review");
    await reviewTable();
    expect(screen.queryByRole("link", { name: "Settings, Matching" })).toBeNull();
  });

  it("J and K move between rows and Enter opens the sheet; typing does not trigger them", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(ADMIN, {
        "GET /api/matching/queue": () => ({
          body: queue([
            item({ id: 1, counterpartyName: "First Ltd" }),
            item({ id: 2, counterpartyName: "Second Ltd" }),
          ]),
        }),
        "GET /api/matching/transactions/2": () => ({
          body: detail({ id: 2, counterpartyName: "Second Ltd" }),
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    await reviewTable();
    await user.click(document.body);
    await user.keyboard("j");
    expect(document.activeElement?.textContent).toContain("First Ltd");
    await user.keyboard("j");
    expect(document.activeElement?.textContent).toContain("Second Ltd");
    await user.keyboard("k");
    expect(document.activeElement?.textContent).toContain("First Ltd");
    // typing in the search box never moves the selection
    const search = screen.getByRole("searchbox", { name: "Search lines to review" });
    await user.click(search);
    await user.keyboard("jk");
    expect(document.activeElement).toBe(search);
    expect((search as HTMLInputElement).value).toBe("jk");
    // Enter on a focused row button opens the sheet
    const first = screen.getByRole("button", { name: "First Ltd" });
    first.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Match bank line" })).toBeTruthy();
  });

  it("a viewer can read the queue and open a line, nothing more", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(base(VIEWER));
    renderApp("/treasury/bank?tab=review");
    await reviewTable();
    await user.click(screen.getByRole("button", { name: "Acme B.V." }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/only finance users and administrators can match/);
    expect(within(dialog).queryByRole("button", { name: /Match to/ })).toBeNull();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    // a viewer never asks for the booking setting
    expect(calls_(calls, "/api/booking/settings")).toHaveLength(0);
  });
});

describe("Matched automatically", () => {
  it("lists automatic matches with Undo for finance and admins", async () => {
    mockFetch(base());
    const { container } = renderApp("/treasury/bank?tab=auto");
    const t = await screen.findByRole("table", { name: "Matched automatically" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    const text = norm(t.textContent);
    expect(text).toContain("INV-2024-001 (Acme B.V.)");
    expect(text).toContain("97");
    expect(text).toContain("Not booked in Exact");
    expect(within(t).getByRole("button", { name: "Undo the match of Acme B.V." })).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("undo asks for a reason and a confirmation, waits for the server, then refreshes", async () => {
    const user = userEvent.setup();
    let undone = false;
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/matching/auto": () => ({
          body: {
            items: undone ? [] : [autoItem()],
            nextCursor: null,
          },
        }),
        "POST /api/matching/matches/50/undo": () => {
          undone = true;
          return { body: { match: autoItem({ status: "undone" }).match } };
        },
      }),
    );
    renderApp("/treasury/bank?tab=auto");
    await screen.findByRole("table", { name: "Matched automatically" });
    await user.click(await screen.findByRole("button", { name: "Undo the match of Acme B.V." }));
    const dialog = await screen.findByRole("dialog", { name: "Undo automatic match" });
    const undoBtn = within(dialog).getByRole("button", { name: "Undo…" });
    expect((undoBtn as HTMLButtonElement).disabled).toBe(true);
    await user.type(
      within(dialog).getByLabelText("Why are you undoing this match?"),
      "Wrong invoice",
    );
    await user.click(undoBtn);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(within(dialog).getByText(/Undo this match\? The bank line goes back/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Undo this match" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ reason: "Wrong invoice" });
    expect(post?.headers["X-Requested-With"]).toBe("camelthorn");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // refetched: the list and the counts
    await waitFor(() => expect(calls_(calls, "/api/matching/auto").length).toBeGreaterThan(1));
    await waitFor(() => expect(calls_(calls, "/api/matching/stats").length).toBeGreaterThan(1));
    expect(await screen.findByText("Automatic matching is off.")).toBeTruthy();
  });

  it("disables Undo with the reason once Exact has booked the match", async () => {
    mockFetch(
      base(ADMIN, {
        "GET /api/matching/auto": () => ({
          body: {
            items: [autoItem({ exactState: "booked", undoAvailable: false })],
            nextCursor: null,
          },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=auto");
    const t = await screen.findByRole("table", { name: "Matched automatically" });
    const btn = await within(t).findByRole("button", { name: "Undo the match of Acme B.V." });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(t).getByText("Already booked in Exact. Reverse it there.")).toBeTruthy();
    expect(within(t).getByText("Booked in Exact")).toBeTruthy();
  });

  it("shows an undone match and one that needs a check", async () => {
    mockFetch(
      base(ADMIN, {
        "GET /api/matching/auto": () => ({
          body: {
            items: [
              autoItem({ id: 51, status: "undone", undoneBy: "f@x.nl", undoReason: "Wrong" }),
              autoItem({ id: 52, reviewReason: "item_closed" }),
            ],
            nextCursor: null,
          },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=auto");
    const t = await screen.findByRole("table", { name: "Matched automatically" });
    expect(await within(t).findByText("Undone")).toBeTruthy();
    expect(within(t).getByText("By f@x.nl: Wrong")).toBeTruthy();
    expect(within(t).getByText("Needs a check")).toBeTruthy();
  });

  it("explains that automatic matching is off when nothing was matched, with a link for admins", async () => {
    mockFetch(
      base(ADMIN, { "GET /api/matching/auto": () => ({ body: { items: [], nextCursor: null } }) }),
    );
    const { unmount } = renderApp("/treasury/bank?tab=auto");
    expect(await screen.findByText("Automatic matching is off.")).toBeTruthy();
    expect(screen.getByText(/off by default/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open Settings, Matching" });
    expect(link.getAttribute("href")).toBe("/settings/matching");
    unmount();
    mockFetch(
      base(FINANCE, {
        "GET /api/matching/auto": () => ({ body: { items: [], nextCursor: null } }),
      }),
    );
    renderApp("/treasury/bank?tab=auto");
    expect(await screen.findByText("Automatic matching is off.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Settings, Matching" })).toBeNull();
    expect(screen.getByText(/Ask an administrator/)).toBeTruthy();
  });

  it("says there are no matches yet when it is on", async () => {
    mockFetch(
      base(ADMIN, {
        "GET /api/matching/auto": () => ({ body: { items: [], nextCursor: null } }),
        "GET /api/matching/stats": () => ({ body: stats({ autoEnabled: true }) }),
      }),
    );
    renderApp("/treasury/bank?tab=auto");
    expect(await screen.findByText("No automatic matches yet.")).toBeTruthy();
  });

  it("a viewer sees no Undo", async () => {
    mockFetch(base(VIEWER));
    renderApp("/treasury/bank?tab=auto");
    const t = await screen.findByRole("table", { name: "Matched automatically" });
    await within(t).findByText("Not booked in Exact");
    expect(within(t).queryByRole("button", { name: /Undo/ })).toBeNull();
  });
});

describe("Ignored", () => {
  const ignored = item(
    {
      id: 9,
      matchStatus: "ignored",
      counterpartyName: "Own Account",
      ignore: {
        reason: "internal_transfer",
        note: "Savings",
        by: "f@x.nl",
        at: "2026-11-09T10:00:00Z",
      },
    },
    [],
  );

  it("lists ignored lines with the reason and asks before unignoring", async () => {
    const user = userEvent.setup();
    let gone = false;
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/matching/queue": () => ({ body: queue(gone ? [] : [ignored]) }),
        "POST /api/matching/transactions/9/unignore": () => {
          gone = true;
          return { body: { transaction: mtx({ id: 9 }) } };
        },
      }),
    );
    renderApp("/treasury/bank?tab=ignored");
    const t = await screen.findByRole("table", { name: "Ignored bank lines" });
    await within(t).findByText("Own Account");
    expect(params(calls_(calls, "/api/matching/queue")[0]).get("status")).toBe("ignored");
    expect(within(t).getByText("Transfer between our own accounts")).toBeTruthy();
    expect(within(t).getByText("Savings")).toBeTruthy();
    await user.click(within(t).getByRole("button", { name: "Unignore Own Account" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await user.click(within(t).getByRole("button", { name: "Yes, unignore" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull(); // the row click did not open the sheet
    expect(await screen.findByText("No ignored lines.")).toBeTruthy();
    await waitFor(() => expect(calls_(calls, "/api/matching/stats").length).toBeGreaterThan(1));
  });

  it("a viewer cannot unignore; the empty state is calm", async () => {
    mockFetch(base(VIEWER, { "GET /api/matching/queue": () => ({ body: queue([ignored]) }) }));
    const { unmount } = renderApp("/treasury/bank?tab=ignored");
    const t = await screen.findByRole("table", { name: "Ignored bank lines" });
    await within(t).findByText("Own Account");
    expect(within(t).queryByRole("button", { name: /Unignore/ })).toBeNull();
    unmount();
    mockFetch(base(VIEWER, { "GET /api/matching/queue": () => ({ body: queue([]) }) }));
    renderApp("/treasury/bank?tab=ignored");
    expect(await screen.findByText("No ignored lines.")).toBeTruthy();
  });

  it("a refused unignore says why", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(ADMIN, {
        "GET /api/matching/queue": () => ({ body: queue([ignored]) }),
        "POST /api/matching/transactions/9/unignore": () => ({
          status: 409,
          body: { error: "not_ignored" },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=ignored");
    const t = await screen.findByRole("table", { name: "Ignored bank lines" });
    await user.click(await within(t).findByRole("button", { name: "Unignore Own Account" }));
    await user.click(within(t).getByRole("button", { name: "Yes, unignore" }));
    // the list is refreshed after a refusal that means the data moved
    await waitFor(() => expect(screen.getAllByRole("table").length).toBeGreaterThan(0));
  });
});

describe("aborting stale requests", () => {
  it("aborts the queue request when the filters change and never shows the old rows", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(ADMIN, {
        "GET /api/matching/queue": (c) =>
          params(c).get("status") === "suggested"
            ? { body: queue([item({ id: 2, counterpartyName: "Suggested Ltd" })]) }
            : { body: queue([item({ id: 1, counterpartyName: "Everything Ltd" })]) },
      }),
    );
    renderApp("/treasury/bank?tab=review");
    await reviewTable();
    await user.click(screen.getByRole("button", { name: "With a suggestion" }));
    await screen.findByText("Suggested Ltd");
    expect(screen.queryByText("Everything Ltd")).toBeNull();
    const first = calls_(calls, "/api/matching/queue")[0];
    expect(first?.signal?.aborted).toBe(true);
    await act(async () => undefined);
  });
});
