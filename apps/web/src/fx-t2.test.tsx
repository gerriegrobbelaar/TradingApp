/**
 * Phase 6 review fixes S2, S5, S6, S7, S11, N1, N6 on the screens: stale and outage rates, the
 * item sheet's labelled rates, estimate labels on aggregates, and a bad answer from the Worker.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KpiAmountDto } from "@camelthorn/core";
import { VIEWER, mockFetch, renderApp } from "./test-utils";
import { ONE_DIVISION, detail, kpis, listResponse, overview, row } from "./test-fixtures";
import { ageingResponse } from "./test-fixtures-reports";
import { fxOutage, fxRates, fxStale } from "./test-fixtures-fx";
import { norm } from "./test-norm";

const me = () => ({ "GET /api/auth/me": () => ({ body: VIEWER }) });
const divs = () => ({ "GET /api/divisions": () => ({ body: ONE_DIVISION }) });
const rates = (body: unknown) => ({ "GET /api/fx/rates": () => ({ body }) });
const amt = (minor: number, dc: number): KpiAmountDto => ({
  count: 1,
  minor,
  dcMinor: dc,
  dcComplete: true,
});
const usd = (id = 1, over = {}) =>
  row({
    id,
    invoiceNumber: `INV-USD-${id}`,
    currency: "USD",
    originalMinor: 10_000,
    openMinor: 10_000,
    dcMinor: 9_000,
    ...over,
  });

const STALE_CHIP = "Rates from 6 Nov, 3 working days old";
const HIDDEN = "ECB rates are 7 working days old; estimates are hidden";

describe("S7: invoices and payables with old rates", () => {
  for (const [path, label, table] of [
    ["/invoices", "GET /api/invoices", "Invoices"],
    ["/purchases/payables", "GET /api/bills", "Payables"],
  ] as const) {
    it(`${path}: fresh rates show no chip and keep the wording for screen readers`, async () => {
      mockFetch({
        ...me(),
        ...divs(),
        ...rates(fxRates()),
        [label]: () => ({ body: listResponse([usd()]) }),
      });
      renderApp(path);
      const t = await screen.findByRole("table", { name: table });
      await waitFor(() => expect(norm(t.textContent)).toContain("about € 92,14"));
      expect(screen.queryByText(STALE_CHIP)).toBeNull();
      expect(norm(t.textContent)).toContain("at today's ECB rate");
      expect(t.querySelector(".fx-row .sr-only")?.textContent).toContain("today's");
    });

    it(`${path}: stale rates show the chip once at the top and date the row estimate`, async () => {
      mockFetch({
        ...me(),
        ...divs(),
        ...rates(fxStale()),
        [label]: () => ({ body: listResponse([usd(1), usd(2)]) }),
      });
      renderApp(path);
      const t = await screen.findByRole("table", { name: table });
      await waitFor(() => expect(t.querySelectorAll(".fx-row")).toHaveLength(2));
      expect(screen.getAllByText(STALE_CHIP)).toHaveLength(1);
      // above the list, not inside the table
      expect(t.contains(screen.getByText(STALE_CHIP))).toBe(false);
      for (const line of Array.from(t.querySelectorAll(".fx-row"))) {
        expect(norm(line.textContent)).toBe("about € 92,14 at the ECB rate of 6 Nov");
        expect(line.querySelector(".sr-only")).toBeNull(); // visible, not only spoken
      }
    });

    it(`${path}: rates past the cut-off hide every estimate and say why`, async () => {
      mockFetch({
        ...me(),
        ...divs(),
        ...rates(fxOutage()),
        [label]: () => ({ body: listResponse([usd()]) }),
      });
      renderApp(path);
      const t = await screen.findByRole("table", { name: table });
      await screen.findByText(HIDDEN);
      expect(t.querySelectorAll(".fx-row")).toHaveLength(0);
      expect(norm(t.textContent)).not.toContain("about");
      expect(norm(t.textContent)).toContain("$ 100,00"); // the original amount stays
      expect(screen.getAllByText(HIDDEN)).toHaveLength(1);
    });
  }

  it("no chip on a list with only administration-currency rows, even when rates are stale", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxStale()),
      "GET /api/invoices": () => ({ body: listResponse([row({ id: 5 })]) }),
    });
    renderApp("/invoices");
    await screen.findByRole("table", { name: "Invoices" });
    expect(screen.queryByText(STALE_CHIP)).toBeNull();
  });

  it("5 working days old still estimates (dated); 6 hides", async () => {
    const at = (days: number) =>
      fxRates({
        asOf: "2026-11-03",
        rates: fxRates().rates.map((r) => ({ ...r, rateDate: "2026-11-03" })),
        stale: true,
        staleReason: "older_than_one_working_day",
        workingDaysOld: days,
      });
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(at(5)),
      "GET /api/invoices": () => ({ body: listResponse([usd()]) }),
    });
    const first = renderApp("/invoices");
    const t = await screen.findByRole("table", { name: "Invoices" });
    await waitFor(() => expect(norm(t.textContent)).toContain("at the ECB rate of 3 Nov"));
    first.unmount();
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(at(6)),
      "GET /api/invoices": () => ({ body: listResponse([usd()]) }),
    });
    renderApp("/invoices");
    await screen.findByText("ECB rates are 6 working days old; estimates are hidden");
  });
});

describe("S7: Overview, ageing and the item sheet during an outage", () => {
  const usdKpis = kpis("/api/invoices", "USD", {
    total: amt(10_000, 9_000),
    overdue: { count: 0, minor: 0, dcMinor: 0, dcComplete: true },
    due7: { count: 0, minor: 0, dcMinor: 0, dcComplete: true },
    due30: { count: 0, minor: 0, dcMinor: 0, dcComplete: true },
  });

  it("the Overview keeps the original and Exact's booked amount, no estimate, one notice", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxOutage()),
      "GET /api/overview": () => ({
        body: overview({ kpis: { receivable: [kpis("/api/invoices"), usdKpis], payable: [] } }),
      }),
    });
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await screen.findByText(HIDDEN);
    const text = norm(recv.textContent);
    expect(text).toContain("$ 100,00");
    expect(text).toContain("€ 90,00 booked in Exact");
    expect(text).not.toContain("about");
    expect(text).not.toContain("Total in € at today's ECB rates");
    expect(screen.getAllByText(HIDDEN)).toHaveLength(1);
  });

  it("the Overview shows the stale chip once, not once per card", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxStale()),
      "GET /api/overview": () => ({
        body: overview({
          kpis: {
            receivable: [kpis("/api/invoices"), usdKpis],
            payable: [kpis("/api/bills", "USD")],
          },
        }),
      }),
    });
    renderApp("/overview");
    await screen.findByRole("region", { name: "Payables" });
    await waitFor(() => expect(screen.getAllByText(STALE_CHIP)).toHaveLength(1));
    // the intro says 'latest' rather than 'today's' while the rates are old
    const recv = screen.getByRole("region", { name: "Receivables" });
    expect(norm(recv.textContent)).toContain("An estimate at the latest ECB rates");
  });

  it("an aggregate difference is labelled an estimate; an item's is not", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxRates()),
      "GET /api/overview": () => ({
        body: overview({ kpis: { receivable: [kpis("/api/invoices"), usdKpis], payable: [] } }),
      }),
    });
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await waitFor(() =>
      expect(norm(recv.textContent)).toContain("Booked € 90,00 · estimated difference +€ 2,14"),
    );
    expect(norm(recv.textContent)).not.toMatch(/· difference/);
  });

  it("the ageing report has no converted card and one notice", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxOutage()),
      "GET /api/reports/ageing": () => ({
        body: ageingResponse([
          {
            relationId: 2,
            relationName: "Beta",
            currency: "USD",
            openMinor: 10_000,
            dueDate: "2026-12-01",
          },
        ]),
      }),
    });
    renderApp("/reporting/receivables-ageing");
    await screen.findByText(HIDDEN);
    expect(screen.queryByRole("heading", { name: /Total in € at today's ECB rates/ })).toBeNull();
    expect(screen.getAllByText(HIDDEN)).toHaveLength(1);
  });

  it("the item sheet says there is no estimate and shows no ECB rate", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxOutage()),
      "GET /api/invoices": () => ({ body: listResponse([usd()]) }),
      "GET /api/open-items/1": () => ({ body: detail(usd(), { rate: "0.9" }) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-USD-1" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("No estimate: the ECB rates are 7 working days old");
    expect(within(dialog).queryByText("ECB today")).toBeNull();
    // Exact's own figures remain
    expect(within(dialog).getByText("Booked rate in Exact")).toBeTruthy();
  });
});

describe("S11: the item sheet labels its rates", () => {
  const open = async (item: ReturnType<typeof usd>, over = {}, fx = fxRates()) => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fx),
      "GET /api/invoices": () => ({ body: listResponse([item]) }),
      "GET /api/open-items/1": () => ({ body: detail(item, over) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-USD-1" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Booked rate in Exact");
    return dialog;
  };
  const value = (dialog: HTMLElement, label: string) =>
    norm(
      within(dialog).getByText(label, { selector: "dt" }).parentElement?.querySelector("dd")
        ?.textContent ?? "",
    );

  it("shows Exact's raw rate as stored, the implied rate and the ECB rate, each with a direction", async () => {
    const dialog = await open(usd(), { rate: "0.92" });
    expect(value(dialog, "Booked rate in Exact")).toBe(
      "1 USD = € 0,92 (as stored; direction unverified)",
    );
    expect(value(dialog, "Implied booked rate")).toBe(
      "1 USD = € 0,9000 (booked amount divided by open amount)",
    );
    expect(value(dialog, "ECB today")).toBe("1 EUR = 1,0853 USD (10 Nov)");
  });

  it("renders the booked rate only when Exact sent one", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxRates()),
      "GET /api/invoices": () => ({ body: listResponse([usd()]) }),
      "GET /api/open-items/1": () => ({ body: detail(usd(), { rate: null }) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-USD-1" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("ECB today");
    expect(within(dialog).queryByText("Booked rate in Exact")).toBeNull();
    expect(within(dialog).queryByText("Exchange rate")).toBeNull();
  });

  it("leaves out the implied rate when the booked amount is not known", async () => {
    const dialog = await open(usd(1, { dcMinor: null }), { rate: "0.92" });
    expect(within(dialog).queryByText("Implied booked rate")).toBeNull();
    expect(value(dialog, "ECB today")).toContain("1 EUR = 1,0853 USD");
  });

  it("dates the ECB line when the rates are old", async () => {
    const dialog = await open(usd(), { rate: "0.92" }, fxStale());
    expect(value(dialog, "ECB rate of 6 Nov")).toBe("1 EUR = 1,0853 USD");
    expect(within(dialog).getAllByText(/at the ECB rate of 6 Nov/).length).toBeGreaterThan(0);
  });
});

describe("S2: a malformed rates answer", () => {
  it("is the 'could not be read' state on the item sheet and the FX tab, with no crash", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates({ rates: "oops", base: "EUR" }),
      "GET /api/invoices": () => ({ body: listResponse([usd()]) }),
      "GET /api/open-items/1": () => ({ body: detail(usd(), { rate: null }) }),
    });
    const user = userEvent.setup();
    const { unmount } = renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-USD-1" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("No estimate: the ECB rates could not be read");
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();

    mockFetch({ ...me(), ...divs(), ...rates(null) });
    renderApp("/settings/fx");
    expect(await screen.findByText("Could not load the ECB rates. Try again.")).toBeTruthy();
  });
});
