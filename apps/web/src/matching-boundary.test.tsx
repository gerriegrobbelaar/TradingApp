/**
 * Error boundaries around the matching screens (M7d): a malformed answer must not blank the shell,
 * the page keeps working, and the fallback shows no data or error text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADMIN, mockFetch, renderApp } from "./test-utils";
import { accounts } from "./test-fixtures-bank";
import { ONE_DIVISION } from "./test-fixtures";
import { booking, detail, item, queue, stats } from "./test-fixtures-matching";

afterEach(() => vi.restoreAllMocks());

const base = (over: Record<string, () => { status?: number; body?: unknown }> = {}) => ({
  "GET /api/auth/me": () => ({ body: ADMIN }),
  "GET /api/divisions": () => ({ body: ONE_DIVISION }),
  "GET /api/bank/accounts": () => ({ body: accounts() }),
  "GET /api/matching/stats": () => ({ body: stats() }),
  "GET /api/booking/settings": () => ({ body: booking() }),
  ...over,
});

describe("match sheet boundary", () => {
  it("a malformed detail leaves the page and the sheet's close button working", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    mockFetch(
      base({
        "GET /api/matching/queue": () => ({ body: queue([item()]) }),
        // candidates is not a list: the sheet body throws while rendering
        "GET /api/matching/transactions/1": () => ({
          body: { ...detail(), candidates: null, secret: "NL91ABNA0417164300" },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const t = await screen.findByRole("table", { name: "Bank lines to review" });
    await user.click(await within(t).findByRole("button", { name: "Acme B.V." }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Something went wrong in this panel/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NL91|TypeError|secret/);
    expect(screen.getByRole("navigation")).toBeTruthy();
    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("table", { name: "Bank lines to review" })).toBeTruthy();
    expect(logged).toHaveBeenCalled();
  });
});

describe("page boundary", () => {
  it("a malformed queue row shows the page fallback and keeps the menu", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch(
      base({
        "GET /api/matching/queue": () => ({
          body: { ...queue(), items: [{ transaction: null, candidates: [] }] },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Something went wrong on this page");
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/TypeError|at \w+ \(/);
  });

  it("a malformed settings answer is caught the same way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch(
      base({
        "GET /api/matching/account-map": () => ({
          body: { accounts: [{ bankAccountId: 1 }], divisions: null },
        }),
        "GET /api/matching/config": () => ({ body: { nonsense: true } }),
        "GET /api/matching/patterns": () => ({ body: { patterns: [] } }),
        "GET /api/booking/outbox": () => ({ body: { items: [] } }),
      }),
    );
    renderApp("/settings/matching");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("navigation")).toBeTruthy();
  });
});
