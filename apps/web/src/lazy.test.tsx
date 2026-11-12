/** Code splitting (Phase 7 review N9): fallbacks are accessible and every lazy route still loads. */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { configureAxe } from "vitest-axe";
import { Lazy, lazyNamed } from "./components/Lazy";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";
import { accounts } from "./test-fixtures-bank";
import { autoItem, booking, config, outbox, queue, stats } from "./test-fixtures-matching";
import { balanceSheetResponse } from "./test-fixtures-reports";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

describe("Lazy", () => {
  it("shows a busy region with one polite status line until the chunk arrives", async () => {
    let release: (m: { Late: () => React.JSX.Element }) => void = () => undefined;
    const Late = lazyNamed(
      () =>
        new Promise<{ Late: () => React.JSX.Element }>((resolve) => {
          release = resolve;
        }),
      "Late",
    );
    const { container } = render(
      <Lazy label="Loading the report">
        <Late />
      </Lazy>,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading the report");
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
    await act(async () => release({ Late: () => <p>Loaded</p> }));
    expect(await screen.findByText("Loaded")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a chunk that fails to load", () => {
  it("shows a retry card (not a blank page), focuses it, and Try again loads the file again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    let calls = 0;
    const Flaky = lazyNamed(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch dynamically imported module");
      return { Flaky: () => <h2>Loaded on the second try</h2> };
    }, "Flaky");
    const { container } = render(
      <PageErrorBoundary path="/x">
        <Lazy>
          <Flaky />
        </Lazy>
      </PageErrorBoundary>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be loaded");
    expect(alert.textContent).not.toContain("dynamically imported");
    const heading = screen.getByRole("heading", { name: /could not be loaded/ });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Loaded on the second try" })).toBeTruthy();
    expect(calls).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a module without the named export counts as a failed load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Missing = lazyNamed(async () => ({}) as { Gone: () => React.JSX.Element }, "Gone");
    render(
      <Lazy>
        <Missing />
      </Lazy>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
  });

  it("a render error that is not a load failure still reaches the page error boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Broken = lazyNamed(
      async () => ({
        Broken: (): React.JSX.Element => {
          throw new Error("boom");
        },
      }),
      "Broken",
    );
    render(
      <PageErrorBoundary path="/x">
        <Lazy>
          <Broken />
        </Lazy>
      </PageErrorBoundary>,
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("lazy routes still load", () => {
  const common = {
    "GET /api/auth/me": () => ({ body: ADMIN }),
    "GET /api/matching/stats": () => ({ body: stats() }),
    "GET /api/matching/queue": () => ({ body: queue() }),
    "GET /api/matching/auto": () => ({ body: { items: [autoItem()], nextCursor: null } }),
    "GET /api/matching/config": () => ({ body: config() }),
    "GET /api/booking/settings": () => ({ body: booking() }),
    "GET /api/booking/outbox": () => ({ body: outbox() }),
    "GET /api/bank/accounts": () => ({ body: accounts() }),
  };

  it("the balance sheet", async () => {
    mockFetch({
      ...common,
      "GET /api/reports/balance-sheet": () => ({ body: balanceSheetResponse() }),
    });
    renderApp("/reporting/balance-sheet");
    expect(await screen.findByRole("heading", { level: 1, name: "Balance sheet" })).toBeTruthy();
  });

  it("the bank matching tabs", async () => {
    mockFetch(common);
    renderApp("/treasury/bank?tab=auto");
    expect(await screen.findByRole("table", { name: "Matched automatically" })).toBeTruthy();
  });

  it("the matching settings and the FX tab", async () => {
    mockFetch({ ...common, "GET /api/fx/rates": () => ({ status: 500, body: { error: "x" } }) });
    renderApp("/settings/matching");
    expect(await screen.findByRole("heading", { level: 2, name: "Booking in Exact" })).toBeTruthy();
  });

  it("a viewer still reaches Settings", async () => {
    mockFetch({ ...common, "GET /api/auth/me": () => ({ body: VIEWER }) });
    renderApp("/settings/appearance");
    expect(await screen.findByRole("heading", { level: 2, name: "Theme" })).toBeTruthy();
  });
});
