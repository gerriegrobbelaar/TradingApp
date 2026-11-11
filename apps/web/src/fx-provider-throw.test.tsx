/**
 * Review S2: even if building the rate table throws (a shape the validator let through), the app
 * shows the 'rates could not be read' state instead of an exception during render.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VIEWER, mockFetch, renderApp } from "./test-utils";
import { ONE_DIVISION, detail, listResponse, row } from "./test-fixtures";
import { fxRates } from "./test-fixtures-fx";

vi.mock("./lib/fx", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/fx")>();
  return {
    ...real,
    rateTableFromResponse: () => {
      throw new RangeError("cannot build a table");
    },
  };
});

describe("FxProvider when the rate table cannot be built", () => {
  it("is the 'could not be read' state; the page and the shell stay up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const item = row({ id: 1, invoiceNumber: "INV-USD", currency: "USD", dcMinor: 9_000 });
    mockFetch({
      "GET /api/auth/me": () => ({ body: VIEWER }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/fx/rates": () => ({ body: fxRates() }),
      "GET /api/invoices": () => ({ body: listResponse([item]) }),
      "GET /api/open-items/1": () => ({ body: detail(item) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-USD" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("No estimate: the ECB rates could not be read");
    expect(screen.queryByRole("alert")).toBeNull(); // no error boundary was needed
    expect(screen.getByRole("navigation")).toBeTruthy();
  });
});
