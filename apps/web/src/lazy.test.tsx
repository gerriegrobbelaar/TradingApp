/** Code splitting (Phase 7 review N9): fallbacks are accessible and every lazy route still loads. */
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
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
