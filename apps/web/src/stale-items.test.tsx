import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VIEWER, mockFetch, renderApp } from "./test-utils";
import { ONE_DIVISION, detail, listResponse, row } from "./test-fixtures";
import { norm } from "./test-norm";

const base = () => ({
  "GET /api/auth/me": () => ({ body: VIEWER }),
  "GET /api/divisions": () => ({ body: ONE_DIVISION }),
});
const CHIP = "Possibly paid — not seen in the last sync";

async function loaded() {
  const t = await screen.findByRole("table", { name: "Invoices" });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  return t;
}

describe("possibly paid (review S8)", () => {
  it("flags rows missed by the last full read, in the list and the sheet, and states the cadence", async () => {
    const r1 = row({ id: 1, invoiceNumber: "INV-1", possiblyPaid: true });
    const r2 = row({ id: 2, invoiceNumber: "INV-2" });
    mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([r1, r2]) }),
      "GET /api/open-items/1": () => ({ body: detail(r1) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    const table = await loaded();
    expect(within(table).getAllByText(CHIP)).toHaveLength(1);
    expect(screen.getByText("Open items refresh nightly")).toBeTruthy();
    expect(norm(document.body.textContent)).toContain("possibly paid: Exact did not list it in the last nightly read");
    await user.click(within(table).getByRole("button", { name: "INV-1" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(CHIP)).toBeTruthy();
  });

  it("shows no note when nothing is possibly paid", async () => {
    mockFetch({ ...base(), "GET /api/invoices": () => ({ body: listResponse([row()]) }) });
    renderApp("/invoices");
    await loaded();
    expect(screen.queryByText(CHIP)).toBeNull();
    expect(document.body.textContent).not.toContain("possibly paid");
  });
});

describe("closed and all views (review S9)", () => {
  it("explains the scope and never shows a 0,00 balance for a closed row", async () => {
    const closed = row({
      id: 3,
      invoiceNumber: "INV-3",
      status: "closed",
      openMinor: 0,
      originalMinor: null,
      bucket: null,
      daysOverdue: null,
    });
    mockFetch({ ...base(), "GET /api/invoices": () => ({ body: listResponse([closed]) }) });
    renderApp("/invoices?view=closed");
    const table = await loaded();
    expect(screen.getByText(/only items that were open at some sync since this app first read Exact/)).toBeTruthy();
    expect(norm(table.textContent)).not.toContain("0,00");
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows the invoiced total of a closed row when it is known", async () => {
    const closed = row({
      id: 4,
      status: "closed",
      openMinor: 0,
      originalMinor: 12_500,
      bucket: null,
      daysOverdue: null,
    });
    mockFetch({ ...base(), "GET /api/invoices": () => ({ body: listResponse([closed]) }) });
    renderApp("/invoices?view=all");
    const table = await loaded();
    expect(norm(table.textContent)).toContain("€ 125,00 invoiced");
  });
});
