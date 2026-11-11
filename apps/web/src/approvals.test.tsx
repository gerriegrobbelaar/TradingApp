import { norm } from "./test-norm";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { ageTone } from "./pages/Approvals";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import { ONE_DIVISION, STALE, approval, approvals } from "./test-fixtures";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const base = (me = VIEWER) => ({
  "GET /api/auth/me": () => ({ body: me }),
  "GET /api/divisions": () => ({ body: ONE_DIVISION }),
});
const params = (c: Call | undefined) => new URL(c?.url ?? "", "http://x").searchParams;
const apiCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith("/api/approvals"));

async function loaded() {
  const t = await screen.findByRole("table", { name: "Approvals" });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  return t;
}

const LATE = approval({ id: 1, entryNumber: "2001", ageDays: 5 });
const SOON = approval({
  id: 2,
  entryNumber: "2002",
  relation: { id: 4, name: "Other BV" },
  ageDays: 3,
  hasPdf: false,
  amountMinor: -1500,
});
const DONE = approval({
  id: 3,
  entryNumber: null,
  status: "approved",
  ageDays: 40,
  hasPdf: null,
  relation: null,
});

describe("ageTone", () => {
  it("warns only for pending approvals older than 3 days", () => {
    expect(ageTone({ status: "pending_approval", ageDays: 4 })).toBe("warn");
    expect(ageTone({ status: "pending_approval", ageDays: 3 })).toBe("neutral");
    expect(ageTone({ status: "pending_approval", ageDays: null })).toBe("neutral");
    expect(ageTone({ status: "approved", ageDays: 90 })).toBe("neutral");
  });
});

describe("Approvals", () => {
  it("lists pending approvals by default, with counts per status and an age chip", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/approvals": () => ({
        body: approvals([LATE, SOON], {
          countsByStatus: { pending_approval: 2, approved: 9, rejected: 1, unknown: 2 },
        }),
      }),
    });
    const { container } = renderApp("/purchases/approvals");
    const table = await loaded();
    const p = params(apiCalls(calls)[0]);
    expect(p.get("status")).toBe("pending_approval");
    expect(p.get("division")).toBe("1");
    expect(p.get("limit")).toBe("50");
    const seg = screen.getByRole("group", { name: "Approval status" });
    expect(within(seg).getByRole("button", { name: /Pending/ }).textContent).toContain("2");
    expect(within(seg).getByRole("button", { name: /Approved/ }).textContent).toContain("9");
    expect(within(seg).getByRole("button", { name: /Rejected/ }).textContent).toContain("1");
    // All = every status, including unknown.
    expect(within(seg).getByRole("button", { name: /^All/ }).textContent).toContain("14");
    // 5 days is late, 3 days is not.
    const late = within(table).getByText(/^5 days/);
    expect(late.className).toContain("warn");
    expect(late.textContent).toContain("waiting, more than 3 days");
    expect(within(table).getByText("3 days").className).not.toContain("warn");
    expect(within(table).getByText("No PDF")).toBeTruthy();
    expect(norm(table.textContent)).toContain("€ -15,00 credit");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("switches status and sends it to the API", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/approvals": (c) => ({
        body: params(c).get("status") === "all" ? approvals([DONE]) : approvals([LATE]),
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals");
    await loaded();
    await user.click(screen.getByRole("button", { name: /^All/ }));
    await screen.findByRole("button", { name: "Bill" });
    expect(params(apiCalls(calls)[1]).get("status")).toBe("all");
    // Approved items are never flagged as late and a missing relation reads plainly.
    expect(screen.getByText("Unknown supplier")).toBeTruthy();
    expect(screen.getByText("40 days").className).not.toContain("warn");
  });

  it("searches", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/approvals": () => ({ body: approvals([LATE]) }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals");
    await loaded();
    await user.type(screen.getByRole("searchbox", { name: "Search approvals" }), "acme");
    await waitFor(() => expect(apiCalls(calls)).toHaveLength(2));
    expect(params(apiCalls(calls)[1]).get("q")).toBe("acme");
  });

  it("shows a clear state when approval status is not synced yet", async () => {
    mockFetch({
      ...base(ADMIN),
      "GET /api/approvals": () => ({ body: approvals([], { available: false }) }),
    });
    const { container } = renderApp("/purchases/approvals");
    expect(await screen.findByText("Approval status is not synced yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("link", { name: "Check connections" })).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("does not offer a connections link to viewers when not synced", async () => {
    mockFetch({
      ...base(),
      "GET /api/approvals": () => ({ body: approvals([], { available: false }) }),
    });
    renderApp("/purchases/approvals");
    await screen.findByText("Approval status is not synced yet");
    expect(screen.queryByRole("link", { name: "Check connections" })).toBeNull();
  });

  it("shows an empty state when nothing is pending", async () => {
    mockFetch({ ...base(), "GET /api/approvals": () => ({ body: approvals([]) }) });
    renderApp("/purchases/approvals");
    expect(await screen.findByText("0 bills are waiting for approval.")).toBeTruthy();
  });

  it("flags stale data", async () => {
    mockFetch({
      ...base(),
      "GET /api/approvals": () => ({ body: approvals([LATE], { freshness: STALE }) }),
    });
    renderApp("/purchases/approvals");
    expect(await screen.findByText("Out of date")).toBeTruthy();
  });

  it("shows an error with a retry", async () => {
    let n = 0;
    mockFetch({
      ...base(),
      "GET /api/approvals": () => {
        n += 1;
        return n === 1 ? { status: 500, body: { error: "x" } } : { body: approvals([LATE]) };
      },
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals");
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Entry 2001" })).toBeTruthy();
  });

  it("opens a read-only detail sheet from a row with keyboard", async () => {
    mockFetch({ ...base(), "GET /api/approvals": () => ({ body: approvals([LATE, SOON]) }) });
    const user = userEvent.setup();
    renderApp("/purchases/approvals");
    await loaded();
    await user.keyboard("j");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Approval details" });
    expect(norm(dialog.textContent)).toContain("€ 450,00");
    expect(dialog.textContent).toContain("Pending");
    expect(dialog.textContent).toContain("waiting 5 days");
    expect(within(dialog).getByText("Attached")).toBeTruthy();
    // Read-only: only the Close button.
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Close"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pages with Load more", async () => {
    let n = 0;
    const calls = mockFetch({
      ...base(),
      "GET /api/approvals": () => {
        n += 1;
        return {
          body:
            n === 1
              ? approvals([LATE], { nextCursor: "z", total: 2 })
              : approvals([SOON], { total: 2 }),
        };
      },
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals");
    await screen.findByText("Showing 1 of 2");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: "Entry 2002" });
    expect(params(apiCalls(calls)[1]).get("cursor")).toBe("z");
  });

  it("has no action buttons and no exclamation marks", async () => {
    mockFetch({ ...base(), "GET /api/approvals": () => ({ body: approvals([LATE]) }) });
    renderApp("/purchases/approvals");
    await loaded();
    expect(screen.queryByRole("button", { name: /^(approve|reject|pay)\b/i })).toBeNull();
    expect(document.body.textContent).not.toContain("!");
    expect(screen.getByRole("heading", { level: 1, name: "Approvals" })).toBeTruthy();
  });

  it("shows the connect empty state with no administration", async () => {
    mockFetch({
      "GET /api/auth/me": () => ({ body: VIEWER }),
      "GET /api/divisions": () => ({ body: { selectedId: null, divisions: [] } }),
    });
    renderApp("/purchases/approvals");
    expect(await screen.findByText("No data yet.")).toBeTruthy();
  });
});
