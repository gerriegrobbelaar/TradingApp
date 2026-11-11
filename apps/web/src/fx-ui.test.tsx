import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { KpiAmountDto } from "@camelthorn/core";
import { FxProvider, useFxRates } from "./fx";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";
import { DIV_REF, ONE_DIVISION, detail, kpis, listResponse, overview, row } from "./test-fixtures";
import { ageingResponse } from "./test-fixtures-reports";
import { account, accounts, tx, txDetail, txs } from "./test-fixtures-bank";
import {
  GBP_DIVISION,
  NOTICE,
  fxHistory,
  fxNever,
  fxRates,
  fxRatesNoGbp,
  fxStale,
  importJob,
  jobsResponse,
} from "./test-fixtures-fx";
import { norm } from "./test-norm";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const me = (m = VIEWER) => ({ "GET /api/auth/me": () => ({ body: m }) });
const divs = (body = ONE_DIVISION) => ({ "GET /api/divisions": () => ({ body }) });
const rates = (body = fxRates()) => ({ "GET /api/fx/rates": () => ({ body }) });
const amt = (minor: number, dc: number, complete = true, count = 1): KpiAmountDto => ({
  count,
  minor,
  dcMinor: dc,
  dcComplete: complete,
});
const NOW_RATE = "about € 92,14 at today's ECB rate (rate 1,0853 USD per EUR, 10 Nov)";

/** USD receivables: 100,00 USD open, 90,00 EUR booked. */
const usdKpis = (path: "/api/invoices" | "/api/bills", over = {}) =>
  kpis(path, "USD", {
    total: amt(10_000, 9_000),
    overdue: amt(0, 0, true, 0),
    due7: amt(0, 0, true, 0),
    due30: amt(0, 0, true, 0),
    ...over,
  });

const ov = (receivable = [usdKpis("/api/invoices")], payable = [kpis("/api/bills")]) => ({
  "GET /api/overview": () => ({ body: overview({ kpis: { receivable, payable } }) }),
});

async function recvRegion() {
  return screen.findByRole("region", { name: "Receivables" });
}

describe("Overview: foreign currency figures", () => {
  it("shows the original amount first, then the euro estimate, booked amount and difference", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      ...ov([kpis("/api/invoices"), usdKpis("/api/invoices")]),
    });
    const { container } = renderApp("/overview");
    const recv = await recvRegion();
    await waitFor(() => expect(norm(recv.textContent)).toContain(NOW_RATE));
    const text = norm(recv.textContent);
    expect(text).toContain("$ 100,00"); // the original stays the big number
    expect(text).toContain("Booked € 90,00 · estimated difference +€ 2,14");
    expect(text).toContain("You would receive € 2,14 more than booked. (unrealised gain)");
    // the old "Exact's own amount" line is replaced, not repeated
    expect(text).not.toContain("(booked rate in Exact)");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("uses payable wording on the payables side", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      ...ov([kpis("/api/invoices")], [usdKpis("/api/bills")]),
    });
    renderApp("/overview");
    const pay = await screen.findByRole("region", { name: "Payables" });
    await waitFor(() => expect(norm(pay.textContent)).toContain(NOW_RATE));
    expect(norm(pay.textContent)).toContain(
      "You would pay € 2,14 more than booked. (unrealised loss)",
    );
  });

  it("says the booked amount is not known yet, never 0", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      ...ov([usdKpis("/api/invoices", { total: amt(10_000, 0, false, 2) })]),
    });
    renderApp("/overview");
    const recv = await recvRegion();
    await waitFor(() => expect(norm(recv.textContent)).toContain("Booked amount not known yet"));
    expect(norm(recv.textContent)).not.toContain("difference");
    expect(norm(recv.textContent)).not.toContain("Booked € 0,00");
  });

  it("says 'No ECB rate for GBP' when a currency has no rate (not an error)", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxRatesNoGbp()),
      ...ov([kpis("/api/invoices"), kpis("/api/invoices", "GBP", { total: amt(5_000, 5_800) })]),
    });
    renderApp("/overview");
    const recv = await recvRegion();
    await waitFor(() => expect(norm(recv.textContent)).toContain("No ECB rate for GBP"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the amber chip for old rates and for rates never imported", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxStale()),
      ...ov([kpis("/api/invoices"), usdKpis("/api/invoices")]),
    });
    const { unmount } = renderApp("/overview");
    await recvRegion();
    expect(await screen.findAllByText("Rates from 6 Nov, 3 working days old")).not.toHaveLength(0);
    unmount();

    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxNever()),
      ...ov([kpis("/api/invoices"), usdKpis("/api/invoices")]),
    });
    renderApp("/overview");
    await recvRegion();
    expect(await screen.findAllByText("No ECB rates imported yet")).not.toHaveLength(0);
    expect(norm(document.body.textContent)).toContain("No ECB rate for USD");
  });

  it("falls back to Exact's own amount line when the rates cannot be read", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/fx/rates": () => ({ status: 500, body: { error: "internal_error" } }),
      ...ov([usdKpis("/api/invoices")]),
    });
    renderApp("/overview");
    const recv = await recvRegion();
    expect(norm(recv.textContent)).toContain("€ 90,00 booked in Exact");
    expect(norm(recv.textContent)).not.toContain("today's ECB rate");
  });
});

describe("Overview: total in € at today's ECB rates", () => {
  it("adds the per-currency converted totals, once per currency, and labels it an estimate", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      ...ov([
        kpis("/api/invoices"),
        usdKpis("/api/invoices"),
        kpis("/api/invoices", "JPY", { total: amt(10_000, 6_000) }),
      ]),
    });
    renderApp("/overview");
    const recv = await recvRegion();
    const head = await within(recv).findByRole("region", {
      name: "Total in € at today's ECB rates, receivables",
    });
    const text = norm(head.textContent);
    // 1.234.500 cents EUR + 9214 (USD) + 6042 (JPY 10.000)
    expect(text).toContain("Open receivables about € 12.497,56");
    expect(text).toContain("Estimate, ECB rates of 10 Nov");
    expect(text).toContain("An estimate at today's ECB rates, for information only.");
    expect(text).toContain("The original amounts stay as they are.");
    // the per-currency figures are still there and untouched
    expect(norm(recv.textContent)).toContain("€ 12.345,00");
    expect(norm(recv.textContent)).toContain("$ 100,00");
  });

  it("lists currencies it could not include", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxRatesNoGbp()),
      ...ov([kpis("/api/invoices"), kpis("/api/invoices", "GBP", { total: amt(5_000, 5_800) })]),
    });
    renderApp("/overview");
    const recv = await recvRegion();
    const head = await within(recv).findByRole("region", {
      name: "Total in € at today's ECB rates, receivables",
    });
    expect(norm(head.textContent)).toContain("Not included: GBP (no ECB rate)");
    expect(norm(head.textContent)).toContain("Open receivables about € 12.345,00");
  });

  it("is left out when only the administration currency is involved", async () => {
    mockFetch({ ...me(), ...divs(), ...rates(), ...ov([kpis("/api/invoices")]) });
    renderApp("/overview");
    await recvRegion();
    await waitFor(() => expect(screen.queryByText("Total in € at today's ECB rates")).toBeNull());
  });

  it("works in a GBP administration: USD and EUR are converted through the EUR cross rate", async () => {
    mockFetch({
      ...me(),
      ...divs(GBP_DIVISION),
      ...rates(),
      "GET /api/overview": () => ({
        body: overview({
          division: { ...DIV_REF, currency: "GBP" },
          kpis: {
            receivable: [
              kpis("/api/invoices", "GBP", { total: amt(5_000, 5_000) }),
              usdKpis("/api/invoices"),
              kpis("/api/invoices", "EUR", { total: amt(10_000, 8_700) }),
            ],
            payable: [],
          },
        }),
      }),
    });
    renderApp("/overview");
    const recv = await recvRegion();
    const head = await within(recv).findByRole("region", {
      name: "Total in GBP at today's ECB rates, receivables",
    });
    // 5.000 + 8.035 (USD 100 via EUR) + 8.720 (EUR 100 * 0.872) pence = £ 217,55
    expect(norm(head.textContent)).toContain("Open receivables about £ 217,55");
    // the USD line is converted straight to pounds, with the cross rate and the older GBP date
    expect(norm(recv.textContent)).toContain(
      "about £ 80,35 at the ECB rate of 6 Nov (1 USD = 0,803464 GBP)",
    );
    expect(norm(recv.textContent)).toContain("Booked £ 90,00");
  });
});

describe("Invoices and payables: rows and the item sheet", () => {
  it("shows a compact euro line in foreign rows and the difference in the sheet (receivable)", async () => {
    const usd = row({
      id: 1,
      invoiceNumber: "INV-USD",
      currency: "USD",
      originalMinor: 10_000,
      openMinor: 10_000,
      dcMinor: 9_000,
    });
    const eur = row({ id: 2, invoiceNumber: "INV-EUR" });
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      "GET /api/invoices": () => ({ body: listResponse([usd, eur]) }),
      "GET /api/open-items/1": () => ({ body: detail(usd, { storedMinor: 10_000 }) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    const table = await screen.findByRole("table", { name: "Invoices" });
    await waitFor(() => expect(norm(table.textContent)).toContain("about € 92,14"));
    // the EUR row has no secondary line
    const eurRow = within(table)
      .getByRole("button", { name: "INV-EUR" })
      .closest("tr") as HTMLElement;
    expect(norm(eurRow.textContent)).not.toContain("about");
    await user.click(within(table).getByRole("button", { name: "INV-USD" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/Open balance in EUR at today's ECB rate/);
    const t = norm(dialog.textContent);
    expect(t).toContain(NOW_RATE);
    // an item: "difference" (computed from this one item), with the rate wording
    expect(t).toContain("Booked € 90,00 · difference +€ 2,14 at today's ECB rate");
    expect(t).toContain("You would receive € 2,14 more than booked. (unrealised gain)");
    expect(t).toContain("An estimate with today's rate, not the rate on the day.");
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it("uses payable wording for a bill and 'get back' for a purchase credit note", async () => {
    const bill = row({
      id: 3,
      kind: "bill",
      invoiceNumber: "BILL-1",
      currency: "USD",
      originalMinor: 10_000,
      openMinor: 10_000,
      dcMinor: 9_000,
    });
    const credit = row({
      id: 4,
      kind: "bill",
      invoiceNumber: "CN-1",
      currency: "USD",
      originalMinor: -10_000,
      openMinor: -10_000,
      dcMinor: -9_000,
    });
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      "GET /api/bills": () => ({ body: listResponse([bill, credit]) }),
      "GET /api/open-items/3": () => ({ body: detail(bill) }),
      "GET /api/open-items/4": () => ({ body: detail(credit) }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const table = await screen.findByRole("table", { name: "Payables" });
    await user.click(await within(table).findByRole("button", { name: "BILL-1" }));
    let dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(norm(dialog.textContent)).toContain(
        "You would pay € 2,14 more than booked. (unrealised loss)",
      ),
    );
    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(within(table).getByRole("button", { name: "CN-1" }));
    dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(norm(dialog.textContent)).toContain(
        "You would get back € 2,14 more than booked. (unrealised gain)",
      ),
    );
  });

  it("shows 'Booked amount not known yet' in the sheet when Exact has no euro amount", async () => {
    const usd = row({ id: 1, currency: "USD", openMinor: 10_000, dcMinor: null });
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      "GET /api/invoices": () => ({ body: listResponse([usd]) }),
      "GET /api/open-items/1": () => ({ body: detail(usd) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    const table = await screen.findByRole("table", { name: "Invoices" });
    await user.click(await within(table).findByRole("button", { name: "INV-1001" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(norm(dialog.textContent)).toContain("Booked amount not known yet"));
    expect(norm(dialog.textContent)).toContain(NOW_RATE);
  });

  it("shows the missing-rate text in the row and the sheet", async () => {
    const gbp = row({ id: 1, currency: "GBP", openMinor: 5_000, dcMinor: 5_800 });
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxRatesNoGbp()),
      "GET /api/invoices": () => ({ body: listResponse([gbp]) }),
      "GET /api/open-items/1": () => ({ body: detail(gbp) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    const table = await screen.findByRole("table", { name: "Invoices" });
    await waitFor(() => expect(norm(table.textContent)).toContain("No ECB rate for GBP"));
    await user.click(within(table).getByRole("button", { name: "INV-1001" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(norm(dialog.textContent)).toContain("No ECB rate for GBP"));
  });
});

describe("Ageing reports: total in € at today's ECB rates", () => {
  const items = [
    {
      relationId: 1,
      relationName: "Acme",
      currency: "EUR",
      openMinor: 100_000,
      dueDate: "2026-12-01",
    },
    {
      relationId: 2,
      relationName: "Beta",
      currency: "USD",
      openMinor: 10_000,
      dueDate: "2026-12-01",
    },
    {
      relationId: 2,
      relationName: "Beta",
      currency: "USD",
      openMinor: 5_000,
      dueDate: "2026-09-01",
    },
    {
      relationId: 3,
      relationName: "Gamma",
      currency: "GBP",
      openMinor: 7_000,
      dueDate: "2026-12-01",
    },
  ];

  it("adds a converted row per bucket, with the rate date and the currencies left out", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxRatesNoGbp()),
      "GET /api/reports/ageing": () => ({ body: ageingResponse(items) }),
    });
    const { container } = renderApp("/reporting/receivables-ageing");
    const heading = await screen.findByRole("heading", {
      name: "Total in € at today's ECB rates",
      level: 2,
    });
    const card = heading.closest("section") as HTMLElement;
    const text = norm(card.textContent);
    // not due: 1.000,00 EUR + 100,00 USD (9214 cents) = 1.092,14
    expect(text).toContain("about € 1.092,14");
    // 61-90 days: 50,00 USD / 1.0853 = 46,07
    expect(text).toContain("about € 46,07");
    // total: 1.000,00 EUR + 150,00 USD converted once (15000 / 1.0853 = 13820.7 -> 13821)
    expect(text).toContain("about € 1.138,21");
    expect(text).toContain("ECB rates of 10 Nov; for information only");
    // buckets without items show a dash, not "about € 0,00"
    expect(text).not.toContain("about € 0,00");
    expect(text).toContain("Not included: GBP (no ECB rate)");
    // per-currency tables are unchanged and still separate
    expect(screen.getByRole("heading", { name: "USD", level: 2 })).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is not shown when every currency is the administration currency", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      "GET /api/reports/ageing": () => ({
        body: ageingResponse([items[0] as (typeof items)[number]]),
      }),
    });
    renderApp("/reporting/receivables-ageing");
    await screen.findByRole("heading", { name: "EUR", level: 2 });
    expect(screen.queryByRole("heading", { name: "Total in € at today's ECB rates" })).toBeNull();
  });
});

describe("Bank: total at today's ECB rates and the transaction sheet", () => {
  it("adds 'About € X in total' under the totals strip and keeps the per-currency balances", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      "GET /api/bank/accounts": () => ({ body: accounts() }),
      "GET /api/bank/transactions": () => ({ body: txs([tx()]) }),
    });
    const { container } = renderApp("/treasury/bank");
    const strip = await screen.findByRole("region", { name: "Balance by currency" });
    // 12.345,67 EUR + 500,25 GBP / 0.872 (573,68 EUR)
    await waitFor(() =>
      expect(norm(strip.textContent)).toContain(
        "About € 12.919,35 in total at the ECB rate of 6 Nov",
      ),
    );
    expect(norm(strip.textContent)).toContain("Estimate, ECB rates of 6 Nov");
    expect(norm(strip.textContent)).toContain("£ 500,25");
    expect(norm(strip.textContent)).toContain(
      "Currencies are shown separately and never added together.",
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is left out when every balance is in the administration currency", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      "GET /api/bank/accounts": () => ({ body: accounts([account()]) }),
      "GET /api/bank/transactions": () => ({ body: txs([tx()]) }),
    });
    renderApp("/treasury/bank");
    await screen.findByRole("region", { name: "Balance by currency" });
    await waitFor(() => expect(screen.queryByText(/in total at today/)).toBeNull());
  });

  it("shows the euro equivalent in the transaction sheet with the today's-rate caveat", async () => {
    const t = tx({ id: 10, currency: "USD", amountMinor: -12_345, counterpartyName: "Cloud Inc" });
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(),
      "GET /api/bank/accounts": () => ({ body: accounts() }),
      "GET /api/bank/transactions": () => ({ body: txs([t]) }),
      "GET /api/bank/transactions/10": () => ({ body: txDetail(t) }),
    });
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    await user.click(await screen.findByRole("button", { name: /Cloud Inc/ }));
    const dialog = await screen.findByRole("dialog");
    // 12345 / 1.0853 = 11374.8 -> 11375
    await waitFor(() =>
      expect(norm(dialog.textContent)).toMatch(/about (€ -113,75|-€ 113,75) at today's ECB rate/),
    );
    expect(norm(dialog.textContent)).toContain("Today's rate, not the rate on the day.");
    // no booked amount is claimed for a bank transaction
    expect(norm(dialog.textContent)).not.toContain("Booked");
  });
});

describe("FxProvider", () => {
  function Probe() {
    const fx = useFxRates();
    return (
      <p data-testid="probe">
        {fx.status}:{fx.table?.rates["USD"] ?? "none"}
      </p>
    );
  }

  it("reads the rates once for the page and keeps them while a refresh is running", async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    mockFetch({
      "GET /api/fx/rates": () => {
        calls += 1;
        return {
          body:
            calls === 1
              ? fxRates()
              : fxRates({
                  rates: [{ currency: "USD", rate: "1.1", rateDate: "2026-11-11", source: "ECB" }],
                }),
        };
      },
    });
    // hold the second answer back so the screen has to show the first one meanwhile
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
      if (calls < 1) return (real as typeof fetch)(...args);
      return new Promise<Response>((resolve) => {
        release = () => resolve((real as typeof fetch)(...args));
      });
    });
    let now = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    render(
      <FxProvider>
        <Probe />
        <Probe />
      </FxProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("probe")[0]?.textContent).toBe("ready:1.0853"),
    );
    expect(calls).toBe(1); // two consumers, one request
    now += 31_000; // past the minimum gap between refreshes
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(release).not.toBeNull());
    // the new answer has not arrived: the old value stays, there is no loading state
    expect(screen.getAllByTestId("probe")[0]?.textContent).toBe("ready:1.0853");
    await act(async () => {
      (release as unknown as () => void)();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByTestId("probe")[0]?.textContent).toBe("ready:1.1"));
    spy.mockRestore();
  });

  it("keeps the rates it has when a later read fails", async () => {
    let n = 0;
    mockFetch({
      "GET /api/fx/rates": () => {
        n += 1;
        return n === 1 ? { body: fxRates() } : { status: 500, body: { error: "internal_error" } };
      },
    });
    let now = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    render(
      <FxProvider>
        <Probe />
      </FxProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:1.0853"));
    now += 31_000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(n).toBe(2));
    expect(screen.getByTestId("probe").textContent).toBe("ready:1.0853");
    spy.mockRestore();
  });

  it("reports an error only when the first read fails", async () => {
    mockFetch({ "GET /api/fx/rates": () => ({ status: 500, body: { error: "internal_error" } }) });
    render(
      <FxProvider>
        <Probe />
      </FxProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("error:none"));
  });
});

describe("Settings, FX rates", () => {
  const tab = (
    m = VIEWER,
    r = fxRates(),
    extra: Record<string, () => { status?: number; body?: unknown }> = {},
  ) =>
    mockFetch({
      ...me(m),
      ...divs(),
      ...rates(r),
      "GET /api/fx/history": () => ({ body: fxHistory() }),
      ...extra,
    });

  it("lists the latest rates with dates, the verbatim notice and the freshness chip", async () => {
    tab();
    const { container } = renderApp("/settings/fx");
    const table = await screen.findByRole("table", { name: /Latest ECB reference rate/ });
    const t = norm(table.textContent);
    expect(t).toContain("USD");
    expect(within(table).getByRole("row", { name: /USD 1,0853 10 Nov 2026/ })).toBeTruthy();
    expect(
      within(table).getByRole("row", { name: /GBP 0,8720 6 Nov 2026 Not published since 6 Nov/ }),
    ).toBeTruthy();
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.getByText("Rates from 10 Nov, up to date")).toBeTruthy();
    expect(screen.getByText(/^Last import: 10 Nov 2026, \d\d:\d\d — OK/)).toBeTruthy();
    // N6: the accountant caveat is the API notice, once; no second copy of it on the tab
    expect(document.body.textContent?.match(/accountant/g)).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open schedules" }).getAttribute("href")).toBe(
      "/settings/schedules",
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows the stale chip and a failed last import", async () => {
    tab(VIEWER, { ...fxStale(), lastImportStatus: "error" });
    renderApp("/settings/fx");
    expect(await screen.findByText("Rates from 6 Nov, 3 working days old")).toBeTruthy();
    expect(screen.getByText(/^Last import: .* — failed/)).toBeTruthy();
    expect(screen.getByText(/The last import failed/)).toBeTruthy();
  });

  it("explains the never-imported state", async () => {
    tab(VIEWER, fxNever());
    const { container } = renderApp("/settings/fx");
    expect(await screen.findByText("No ECB rates imported yet")).toBeTruthy();
    expect(screen.getByText("No ECB rates imported yet.")).toBeTruthy();
    expect(screen.getByText("Last import: never run")).toBeTruthy();
    expect(screen.queryByRole("table", { name: /Latest ECB/ })).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is readable by every role and only finance and admin get Import now", async () => {
    tab(VIEWER);
    const { unmount } = renderApp("/settings/fx");
    await screen.findByRole("table", { name: /Latest ECB/ });
    expect(screen.queryByRole("button", { name: /Import now/ })).toBeNull();
    unmount();
    tab({ ...VIEWER, roles: ["finance"] });
    renderApp("/settings/fx");
    expect(await screen.findByRole("button", { name: "Import now" })).toBeTruthy();
  });

  it("shows the history of a chosen currency as a chart with a text alternative and a table", async () => {
    const calls = tab(VIEWER, fxRates(), {
      "GET /api/fx/history": () => ({ body: fxHistory("GBP") }),
    });
    const user = userEvent.setup();
    const { container } = renderApp("/settings/fx");
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Currency for the rate history" }),
      "GBP",
    );
    const chart = await screen.findByRole("img", {
      name: /GBP per 1 EUR over 5 ECB publication days/,
    });
    const label = chart.getAttribute("aria-label") ?? "";
    expect(label).toContain("from 1,0712 on 2 Nov to 1,0853 on 6 Nov");
    expect(label).toContain("Lowest 1,0712 on 2 Nov, highest 1,0953 on 4 Nov");
    expect(chart.querySelector("path.fx-series")?.getAttribute("d")).toBe(
      "M0 160 L150 109 L300 0 L450 89 L600 67",
    );
    const hist = calls.filter((c) => c.url.startsWith("/api/fx/history"));
    expect(hist.at(-1)?.url).toBe("/api/fx/history?currency=GBP&days=90");
    const table = screen.getByRole("table", {
      name: /GBP per 1 EUR, one row per ECB publication day/,
    });
    // newest first
    expect(within(table).getAllByRole("row")[1]?.textContent).toContain("6 Nov 2026");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("states an empty history and a failed one", async () => {
    tab(VIEWER, fxRates(), {
      "GET /api/fx/history": () => ({ body: { currency: "USD", base: "EUR", points: [] } }),
    });
    const { unmount } = renderApp("/settings/fx");
    expect(await screen.findByText("No USD rates in the last 90 days.")).toBeTruthy();
    unmount();
    tab(VIEWER, fxRates(), {
      "GET /api/fx/history": () => ({ status: 500, body: { error: "internal_error" } }),
    });
    renderApp("/settings/fx");
    expect(await screen.findByText("Could not load the rate history. Try again.")).toBeTruthy();
  });

  describe("Import now", () => {
    const FIN = { ...ADMIN, roles: ["finance" as const] };
    const click = async () => {
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Import now" }));
    };

    it("starts the import job through Run now and says so", async () => {
      const calls = tab(FIN, fxRates(), {
        "GET /api/jobs": () => ({
          body: jobsResponse([importJob({ id: 3, name: "other" }), importJob()]),
        }),
        "POST /api/jobs/9/run": () => ({ body: { runId: 1, status: "queued" } }),
      });
      renderApp("/settings/fx");
      await click();
      expect(
        await screen.findByText("Started the ECB import. The rates update here when it finishes."),
      ).toBeTruthy();
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/jobs/9/run")).toBe(true);
      // a cooldown follows: the button is off for a while
      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: /Import now/ }) as HTMLButtonElement).disabled,
        ).toBe(true),
      );
    });

    it("says when it is already running (409)", async () => {
      tab(FIN, fxRates(), {
        "GET /api/jobs": () => ({ body: jobsResponse() }),
        "POST /api/jobs/9/run": () => ({ status: 409, body: { error: "already_running" } }),
      });
      renderApp("/settings/fx");
      await click();
      expect(await screen.findByText(/The ECB import is already running/)).toBeTruthy();
    });

    it("shows the cooldown from a 429 and disables the button", async () => {
      tab(FIN, fxRates(), {
        "GET /api/jobs": () => ({ body: jobsResponse() }),
        "POST /api/jobs/9/run": () => ({
          status: 429,
          body: { error: "cooldown", retryAfterSeconds: 20 },
        }),
      });
      renderApp("/settings/fx");
      await click();
      expect(await screen.findByText("Wait 20 seconds before importing again.")).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Import now (please wait)" })).toBeTruthy(),
      );
    });

    it("offers a fresh sign-in when the job needs step-up", async () => {
      tab(FIN, fxRates(), {
        "GET /api/jobs": () => ({ body: jobsResponse() }),
        "POST /api/jobs/9/run": () => ({ status: 401, body: { error: "step_up_required" } }),
      });
      renderApp("/settings/fx");
      await click();
      expect(
        await screen.findByText(/needs a Google sign-in from the last 15 minutes/),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    });

    it("says so when the job is not there or the server cannot be reached", async () => {
      tab(FIN, fxRates(), { "GET /api/jobs": () => ({ body: jobsResponse([]) }) });
      const { unmount } = renderApp("/settings/fx");
      await click();
      expect(await screen.findByText("The ECB import job was not found.")).toBeTruthy();
      unmount();
      tab(FIN, fxRates(), { "GET /api/jobs": () => ({ status: 500, body: {} }) });
      const second = renderApp("/settings/fx");
      await click();
      // the server answered: it is not a network problem
      expect(
        await screen.findByText("The server could not start the import. Try again."),
      ).toBeTruthy();
      second.unmount();
      tab(FIN, fxRates(), {
        "GET /api/jobs": () => {
          throw new TypeError("Failed to fetch");
        },
      });
      renderApp("/settings/fx");
      await click();
      expect(await screen.findByText("Could not reach the server. Try again.")).toBeTruthy();
    });
  });
});
