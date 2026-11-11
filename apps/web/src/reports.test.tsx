/**
 * Reporting screens (K3b): ageing for creditors and receivables, balance sheet, profit and loss.
 * States, drill-downs that add up, selectors, export buttons and the print view.
 */
import { norm } from "./test-norm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { strFromU8, unzipSync } from "fflate";
import { addDays, type BalanceSheetResponse, type OpenItemRow } from "@camelthorn/core";
import { VIEWER, mockFetch, renderApp, settle, type Call } from "./test-utils";
import { ONE_DIVISION, STALE, TWO_DIVISIONS, listResponse, row } from "./test-fixtures";
import {
  LEDGER_FRESH,
  LEDGER_NEVER,
  accountBalancesResponse,
  ageingResponse,
  balanceSheetResponse,
  chartResponse,
  profitLossResponse,
  type AgeingFixtureItem,
} from "./test-fixtures-reports";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const AS_OF = "2026-11-11";
const params = (c: Call | undefined) => new URL(c?.url ?? "", "http://x").searchParams;
const callsTo = (calls: Call[], path: string) => calls.filter((c) => c.url.split("?")[0] === path);

const base = (divs = ONE_DIVISION) => ({
  "GET /api/auth/me": () => ({ body: VIEWER }),
  "GET /api/divisions": () => ({ body: divs }),
});

const ITEMS: AgeingFixtureItem[] = [
  {
    relationId: 1,
    relationName: "Acme BV",
    currency: "EUR",
    openMinor: 100_000,
    dueDate: addDays(AS_OF, 20),
  },
  {
    relationId: 1,
    relationName: "Acme BV",
    currency: "EUR",
    openMinor: 50_000,
    dueDate: addDays(AS_OF, -10),
  },
  {
    relationId: 1,
    relationName: "Acme BV",
    currency: "EUR",
    openMinor: -7_500,
    dueDate: addDays(AS_OF, -45),
  },
  {
    relationId: 2,
    relationName: "Zeta Holding",
    currency: "EUR",
    openMinor: 250_000,
    dueDate: addDays(AS_OF, -120),
  },
  { relationId: 2, relationName: "Zeta Holding", currency: "EUR", openMinor: 1_000, dueDate: null },
  {
    relationId: 3,
    relationName: "Bravo Trading",
    currency: "EUR",
    openMinor: 20_000,
    dueDate: addDays(AS_OF, 0),
  },
  {
    relationId: 4,
    relationName: "Tokyo KK",
    currency: "JPY",
    openMinor: 123_456,
    dueDate: addDays(AS_OF, -70),
  },
  {
    relationId: 5,
    relationName: "Kuwait Co",
    currency: "KWD",
    openMinor: 1_234_567,
    dueDate: addDays(AS_OF, -5),
  },
];

const ageing = (kind: "receivable" | "payable" = "receivable", items = ITEMS, over = {}) =>
  ageingResponse(items, kind, over);

// ---- ageing -------------------------------------------------------------------------------------

describe.each([
  {
    kind: "receivable" as const,
    path: "/reporting/receivables-ageing",
    title: "Receivables age analysis",
    list: "/api/invoices",
    party: "Customer",
  },
  {
    kind: "payable" as const,
    path: "/reporting/creditors-ageing",
    title: "Creditors age analysis",
    list: "/api/bills",
    party: "Supplier",
  },
])("$title", ({ kind, path, title, list, party }) => {
  const mock = (over: Record<string, (c: Call) => { status?: number; body?: unknown }> = {}) =>
    mockFetch({
      ...base(),
      "GET /api/reports/ageing": () => ({ body: ageing(kind) }),
      ...over,
    });

  it("leads with the amounts, one table per currency, never summed across currencies", async () => {
    const calls = mock();
    const { container } = renderApp(path);
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
    const eur = await screen.findByRole("region", { name: `${title} in EUR` });
    // Query: this division and kind, today is not sent as asOf.
    const sent = params(callsTo(calls, "/api/reports/ageing")[0]);
    expect(sent.get("kind")).toBe(kind);
    expect(sent.get("division")).toBe("1");
    expect(sent.has("asOf")).toBe(false);
    expect(norm(document.querySelector(".asof")?.textContent)).toContain("As of 11 Nov 2026");

    const head = within(eur)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(head).toEqual([
      party,
      "Not due",
      "1–30 days",
      "31–60 days",
      "61–90 days",
      "90+ days",
      "No due date",
      "Total",
      "Mix",
    ]);
    // Acme: 1,000.00 not due, 500.00 in 1-30, -75.00 in 31-60 (a credit), 1,425.00 in total.
    const acme = within(eur).getByRole("row", { name: /Acme BV/ });
    const cellText = within(acme)
      .getAllByRole("cell")
      .map((c) => norm(c.textContent));
    expect(cellText[0]).toMatch(/^€ 1\.000,00 Acme BV, Not due, 1 item/);
    expect(cellText[1]).toMatch(/^€ 500,00 Acme BV, 1–30 days/);
    expect(cellText[2]).toMatch(/^€ -75,00 ?credit Acme BV, 31–60 days/);
    expect(cellText[6]).toMatch(/^€ 1\.425,00 Acme BV, Total, 3 items/);
    // Grand total row of the currency.
    const total = within(eur).getByRole("row", { name: /^Total/ });
    expect(norm(total.textContent)).toContain("€ 4.135,00");
    // JPY and KWD have their own tables with their own decimals.
    const jpy = screen.getByRole("region", { name: `${title} in JPY` });
    expect(norm(jpy.textContent)).toContain("¥ 123.456");
    const kwd = screen.getByRole("region", { name: `${title} in KWD` });
    expect(norm(kwd.textContent)).toMatch(/1\.234,567/);
    expect(screen.getByText(/never added together/)).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has a focusable scroll region per table and ageing bars with their numbers", async () => {
    mock();
    renderApp(path);
    const region = await screen.findByRole("region", { name: `${title} in EUR` });
    expect(region.getAttribute("tabindex")).toBe("0");
    const bars = within(region).getAllByRole("img");
    const acmeBar = bars[0] as HTMLElement;
    expect(acmeBar.getAttribute("aria-label")).toMatch(/^Share of the outstanding amount: .*\d+%/);
  });

  it("every cell opens the items behind it: right filters, and count and sum match", async () => {
    // Same list rules as the API (ADR 0022): exclusive bounds, open items only.
    const all: OpenItemRow[] = ITEMS.map((i, n) =>
      row({
        id: n + 1,
        kind: kind === "receivable" ? "invoice" : "bill",
        invoiceNumber: `D-${n + 1}`,
        relation: { id: i.relationId, name: i.relationName },
        currency: i.currency,
        openMinor: i.openMinor,
        dueDate: i.dueDate,
      }),
    );
    const matches = (item: OpenItemRow, q: URLSearchParams): boolean => {
      if (item.status !== (q.get("status") ?? "open")) return false;
      const cur = q.get("currency");
      if (cur && item.currency !== cur) return false;
      const rel = q.get("relationId");
      if (rel && String(item.relation.id) !== rel) return false;
      const before = q.get("dueBefore");
      const after = q.get("dueAfter");
      if (before && (item.dueDate === null || !(item.dueDate < before))) return false;
      if (after && (item.dueDate === null || !(item.dueDate > after))) return false;
      if (q.get("noDueDate") === "1" && item.dueDate !== null) return false;
      return true;
    };
    const calls = mock({
      [`GET ${list}`]: (c) => ({ body: listResponse(all.filter((i) => matches(i, params(c)))) }),
    });
    const user = userEvent.setup();
    renderApp(path);
    const eur = await screen.findByRole("region", { name: `${title} in EUR` });
    const report = ageing(kind).currencies.find((c) => c.currency === "EUR");
    if (!report) throw new Error("fixture");
    let opened = 0;
    for (const r of report.rows) {
      const id = r.relation.id as number;
      const buckets = [...Object.entries(r.bucketCounts), ["total", r.count]] as [string, number][];
      for (const [bucket, count] of buckets) {
        if (count === 0) continue;
        const rowEl = within(eur).getByRole("row", { name: new RegExp(r.relation.name as string) });
        const button = within(rowEl)
          .getAllByRole("button")
          .find((b) =>
            b.textContent?.includes(
              `${bucket === "total" ? "Total" : bucketLabel(bucket)}, ${count} ${count === 1 ? "item" : "items"}`,
            ),
          );
        expect(button, `${r.relation.name} ${bucket}`).toBeTruthy();
        const before = callsTo(calls, list).length;
        await user.click(button as HTMLElement);
        const dialog = await screen.findByRole("dialog");
        await waitFor(() => expect(callsTo(calls, list).length).toBe(before + 1));
        const q = params(callsTo(calls, list)[before]);
        expect(q.get("relationId")).toBe(String(id));
        expect(q.get("currency")).toBe("EUR");
        expect(q.get("division")).toBe("1");
        const hint = report.totals.drilldown[bucket as "total"].query;
        for (const [k, v] of Object.entries(hint)) expect(q.get(k), `${bucket} ${k}`).toBe(v);
        // The rows the sheet shows are exactly the cell's items, and it raises no mismatch.
        await waitFor(() => expect(within(dialog).getAllByRole("listitem")).toHaveLength(count));
        expect(within(dialog).queryByText(/Exact data changed/)).toBeNull();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        opened++;
      }
    }
    expect(opened).toBeGreaterThanOrEqual(8);
    // The total row opens the unnarrowed figure: no relation filter, all three of the currency.
    const before = callsTo(calls, list).length;
    const totalRow = within(eur).getByRole("row", { name: /^Total/ });
    await user.click(within(totalRow).getAllByRole("button").at(-1) as HTMLElement);
    await waitFor(() => expect(callsTo(calls, list).length).toBe(before + 1));
    expect(params(callsTo(calls, list)[before]).has("relationId")).toBe(false);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getAllByRole("listitem")).toHaveLength(report.totals.count),
    );
  });

  it("sorts by outstanding (default) or name, and searches by name", async () => {
    mock();
    const user = userEvent.setup();
    renderApp(path);
    const eur = await screen.findByRole("region", { name: `${title} in EUR` });
    const names = () =>
      within(eur)
        .getAllByRole("rowheader")
        .map((h) => h.textContent?.trim())
        .filter((t) => t && !t.startsWith("Total"));
    // Zeta 2.510,00 > Acme 1.425,00 > Bravo 200,00
    expect(names()).toEqual(["Zeta Holding", "Acme BV", "Bravo Trading"]);
    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["Acme BV", "Bravo Trading", "Zeta Holding"]);
    expect(screen.getByRole("button", { name: "Name" }).getAttribute("aria-pressed")).toBe("true");

    await user.type(screen.getByRole("searchbox"), "bravo");
    await waitFor(() => expect(names()).toEqual(["Bravo Trading"]));
    // Totals stay those of all relations and say so.
    expect(norm(within(eur).getByRole("row", { name: /^Total/ }).textContent)).toContain(
      "€ 4.135,00",
    );
    expect(within(eur).getByText(/all 3 relations/)).toBeTruthy();
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "nobody");
    expect(await screen.findByText(`No ${party.toLowerCase()} matches "nobody".`)).toBeTruthy();
  });

  it("shows loading, then an error with a retry that loads again", async () => {
    let n = 0;
    const calls = mock({
      "GET /api/reports/ageing": () =>
        ++n === 1 ? { status: 500, body: { error: "boom" } } : { body: ageing(kind) },
    });
    const user = userEvent.setup();
    renderApp(path);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Could not load this data. Try again.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: `${title} in EUR` });
    expect(callsTo(calls, "/api/reports/ageing")).toHaveLength(2);
  });

  it("distinguishes never read, nothing open and stale", async () => {
    mock({
      "GET /api/reports/ageing": () => ({
        body: ageing(kind, [], { freshness: { ...STALE, lastCompletedAt: null } }),
      }),
    });
    const first = renderApp(path);
    expect(await screen.findByText("No data yet.")).toBeTruthy();
    expect(screen.getByText("Never synced")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to connections" })).toBeTruthy();
    first.unmount();

    mock();
    mockFetch({
      ...base(),
      "GET /api/reports/ageing": () => ({ body: ageing(kind, [], {}) }),
    });
    renderApp(path);
    expect(
      await screen.findByText(kind === "receivable" ? "0 open invoices." : "0 open bills."),
    ).toBeTruthy();
  });

  it("warns when the data is out of date but still shows it", async () => {
    mock({
      "GET /api/reports/ageing": () => ({ body: ageing(kind, ITEMS, { freshness: STALE }) }),
    });
    renderApp(path);
    await screen.findByRole("region", { name: `${title} in EUR` });
    expect(screen.getByText("Out of date")).toBeTruthy();
  });

  it("does not open items of a relation that has not been synced", async () => {
    mock({
      "GET /api/reports/ageing": () => ({
        body: ageing(kind, [
          { relationId: null, relationName: null, currency: "EUR", openMinor: 700, dueDate: null },
        ]),
      }),
    });
    renderApp(path);
    const eur = await screen.findByRole("region", { name: `${title} in EUR` });
    const unknown = within(eur).getByRole("row", { name: /Unknown relation/ });
    expect(within(unknown).queryAllByRole("button")).toHaveLength(0);
    expect(within(unknown).getByText(/Not synced yet/)).toBeTruthy();
    // The total row can still open the figure.
    expect(
      within(within(eur).getByRole("row", { name: /^Total/ })).getAllByRole("button").length,
    ).toBeGreaterThan(0);
  });

  it("shows the amount in the division currency for a foreign currency, with 'at least' when incomplete", async () => {
    mock({
      "GET /api/reports/ageing": () => ({
        body: ageing(kind, [
          {
            relationId: 9,
            relationName: "US Corp",
            currency: "USD",
            openMinor: 100_000,
            dueDate: null,
            dcMinor: 92_000,
          },
          {
            relationId: 9,
            relationName: "US Corp",
            currency: "USD",
            openMinor: 50_000,
            dueDate: null,
            dcMinor: null,
          },
        ]),
      }),
    });
    renderApp(path);
    const usd = await screen.findByRole("region", { name: `${title} in USD` });
    const card = usd.closest(".card") as HTMLElement;
    expect(norm(card.textContent)).toContain("At least € 920,00 in EUR as stored in Exact.");
    expect(norm(card.textContent)).toContain("Some items have no amount in EUR yet.");
  });

  it("never says 'at least € 0,00' when no item has an amount in the division currency", async () => {
    mock({
      "GET /api/reports/ageing": () => ({
        body: ageing(kind, [
          {
            relationId: 9,
            relationName: "Tokyo KK",
            currency: "JPY",
            openMinor: 1_000,
            dueDate: null,
            dcMinor: null,
          },
        ]),
      }),
    });
    renderApp(path);
    const jpy = await screen.findByRole("region", { name: `${title} in JPY` });
    const card = jpy.closest(".card") as HTMLElement;
    expect(norm(card.textContent)).not.toContain("At least");
    expect(norm(card.textContent)).toContain("Not known yet.");
  });

  it("aborts the old request when the administration changes and shows only the new data", async () => {
    const calls = mockFetch({
      ...base(TWO_DIVISIONS),
      "PUT /api/me/division": () => ({ body: { selectedId: 2 } }),
      "GET /api/reports/ageing": (c) => ({
        body:
          params(c).get("division") === "2"
            ? ageing(kind, [
                {
                  relationId: 8,
                  relationName: "Beta Only",
                  currency: "EUR",
                  openMinor: 5_000,
                  dueDate: null,
                },
              ])
            : ageing(kind),
      }),
    });
    const user = userEvent.setup();
    renderApp(path);
    await screen.findByText("Acme BV");
    expect(callsTo(calls, "/api/reports/ageing")[0]?.signal?.aborted).toBe(false);
    await user.selectOptions(screen.getByLabelText("Administration"), "2");
    expect(screen.queryByText("Acme BV")).toBeNull();
    await screen.findByText("Beta Only");
    expect(callsTo(calls, "/api/reports/ageing").map((c) => params(c).get("division"))).toEqual([
      "1",
      "2",
    ]);
    expect(callsTo(calls, "/api/reports/ageing")[0]?.signal?.aborted).toBe(true);
  });

  it("is read-only and has no exclamation marks", async () => {
    mock();
    renderApp(path);
    await screen.findByRole("region", { name: `${title} in EUR` });
    expect(document.body.textContent).not.toContain("!");
    for (const word of [/\bpay\b/i, /approve/i, /match/i, /remind/i]) {
      expect(screen.queryByRole("button", { name: word })).toBeNull();
    }
  });
});

function bucketLabel(bucket: string): string {
  return (
    {
      not_due: "Not due",
      d1_30: "1–30 days",
      d31_60: "31–60 days",
      d61_90: "61–90 days",
      d90_plus: "90+ days",
      no_due_date: "No due date",
    } as Record<string, string>
  )[bucket] as string;
}

// ---- balance sheet ------------------------------------------------------------------------------

describe("Balance sheet", () => {
  const mock = (
    bs: (c: Call) => BalanceSheetResponse | { status: number; body: unknown } = () =>
      balanceSheetResponse(),
    extra: Record<string, (c: Call) => { status?: number; body?: unknown }> = {},
  ) =>
    mockFetch({
      ...base(),
      "GET /api/reports/balance-sheet": (c) => {
        const r = bs(c);
        return "body" in r && "status" in r && typeof r.status === "number" && !("report" in r)
          ? (r as { status: number; body: unknown })
          : { body: r };
      },
      ...extra,
    });

  it("shows sections, lines, subtotals, the comparison column and a zero difference", async () => {
    const calls = mock();
    const { container } = renderApp("/reporting/balance-sheet");
    expect(await screen.findByRole("heading", { level: 1, name: "Balance sheet" })).toBeTruthy();
    const region = await screen.findByRole("region", { name: "Balance sheet" });
    // No year or period in the request: the server picks the current ones.
    const sent = params(callsTo(calls, "/api/reports/balance-sheet")[0]);
    expect(sent.get("division")).toBe("1");
    expect(sent.has("year")).toBe(false);
    expect(sent.has("period")).toBe(false);
    expect(
      within(region)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Account", "2026, up to period 2", "Year end 2025 (all periods)"]);
    const line = (name: string) =>
      norm(within(region).getByRole("row", { name: new RegExp(name) }).textContent);
    expect(line("Bank ING")).toContain("€ 24.000,00");
    expect(line("Bank ING")).toContain("€ 15.000,00");
    expect(line("Total assets")).toContain("€ 25.000,00");
    expect(line("Total liabilities and equity")).toContain("€ 25.000,00");
    expect(line("Result for the year to date")).toContain("€ 10.000,00");
    expect(line("Difference")).toContain("€ 0,00");
    expect(screen.queryByText(/Does not balance/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says 'Does not balance' prominently, with the amount, when the difference is not zero", async () => {
    mock(() =>
      balanceSheetResponse(
        {},
        {
          balances: [
            {
              glAccountExactId: "a-bank",
              year: 2026,
              period: 0,
              amountMinor: 12_345,
              balanceType: "B",
            },
          ],
        },
      ),
    );
    renderApp("/reporting/balance-sheet");
    const alert = await screen.findByRole("alert");
    expect(norm(alert.textContent)).toBe(
      "Does not balance: difference € 123,45 in 2026, up to period 2. Check opening balances.",
    );
    const region = screen.getByRole("region", { name: "Balance sheet" });
    expect(norm(within(region).getByRole("row", { name: /Difference/ }).textContent)).toContain(
      "€ 123,45",
    );
  });

  it("warns when there are no opening balances, for the year and for the comparison year", async () => {
    mock(() =>
      balanceSheetResponse(
        {},
        {
          balances: [
            {
              glAccountExactId: "a-bank",
              year: 2026,
              period: 1,
              amountMinor: 100,
              balanceType: "B",
            },
            {
              glAccountExactId: "a-cap",
              year: 2026,
              period: 1,
              amountMinor: -100,
              balanceType: "B",
            },
          ],
        },
      ),
    );
    renderApp("/reporting/balance-sheet");
    expect(
      await screen.findByText(/No opening balances \(period 0\) are in Exact for 2026/),
    ).toBeTruthy();
    expect(screen.getByText(/No opening balances \(period 0\) are in Exact for 2025/)).toBeTruthy();
  });

  it("shows unclassified lines visibly with an explanation", async () => {
    const accounts = [...(balanceSheetResponse().report ? [] : [])];
    void accounts;
    const odd = balanceSheetResponse(
      {},
      {
        accounts: [
          {
            exactId: "a-odd",
            code: "9999",
            name: "Mystery account",
            type: null,
            typeDescription: null,
            balanceSide: null,
            balanceType: "B",
            isActive: true,
          },
        ],
        balances: [
          {
            glAccountExactId: "a-odd",
            year: 2026,
            period: 1,
            amountMinor: 5_000,
            balanceType: "B",
          },
        ],
      },
    );
    mock(() => odd);
    renderApp("/reporting/balance-sheet");
    const region = await screen.findByRole("region", { name: "Balance sheet" });
    expect(within(region).getByRole("rowheader", { name: "Unclassified" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: /Mystery account/ })).toBeTruthy();
    expect(
      within(region).getByText(/could not be placed in assets, liabilities or equity/),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Does not balance");
  });

  it("notes split keys and a comparison year that was never read", async () => {
    mock(() =>
      balanceSheetResponse({
        splitKeys: 3,
        compareMissing: true,
        compareYear: 2025,
        compareFreshness: LEDGER_NEVER.gl_balances,
      }),
    );
    renderApp("/reporting/balance-sheet");
    expect(
      await screen.findByText(/3 figures were split by Exact over a field this app does not read/),
    ).toBeTruthy();
    expect(screen.getByText(/balances of 2025 have not been read from Exact yet/)).toBeTruthy();
    expect(screen.getByText("The balances of 2025 has not been read from Exact yet.")).toBeTruthy();
  });

  it("separates not synced from no data and loading from error", async () => {
    mock(() =>
      balanceSheetResponse({
        status: "not_synced",
        report: null,
        compareYear: null,
        freshness: LEDGER_NEVER,
        compareFreshness: null,
      }),
    );
    const a = renderApp("/reporting/balance-sheet");
    expect(await screen.findByText("No data yet.")).toBeTruthy();
    expect(screen.getByText(/have not been read from Exact yet. Run a full sync/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export Excel" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Export PDF" }).hasAttribute("disabled")).toBe(true);
    a.unmount();

    mock(() => balanceSheetResponse({ status: "no_data", report: null, compareYear: null }));
    const b = renderApp("/reporting/balance-sheet");
    expect(await screen.findByText("No figures for 2026 yet.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Balance sheet" })).toBeNull();
    b.unmount();

    let n = 0;
    mock(() => (++n === 1 ? { status: 500, body: { error: "x" } } : balanceSheetResponse()));
    const user = userEvent.setup();
    renderApp("/reporting/balance-sheet");
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load this data");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: "Balance sheet" });
  });

  it("warns about a stale comparison year or chart without hiding the report", async () => {
    mock(() =>
      balanceSheetResponse({
        compareFreshness: {
          lastCompletedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
          stale: true,
          staleAfterHours: 192,
        },
        freshness: {
          ...LEDGER_FRESH,
          gl_accounts: { lastCompletedAt: null, stale: true, staleAfterHours: 36 },
        },
      }),
    );
    renderApp("/reporting/balance-sheet");
    await screen.findByRole("region", { name: "Balance sheet" });
    expect(screen.getByText(/The balances of 2025 was last read/)).toBeTruthy();
    expect(screen.getByText(/The chart of accounts has not been read from Exact yet/)).toBeTruthy();
  });

  it("year and period selectors send year and period and keep them in the address", async () => {
    const calls = mock((c) => {
      const q = params(c);
      return balanceSheetResponse(
        {},
        { year: Number(q.get("year") ?? 2026), period: Number(q.get("period") ?? 2) },
      );
    });
    const user = userEvent.setup();
    renderApp("/reporting/balance-sheet");
    await screen.findByRole("region", { name: "Balance sheet" });
    const year = screen.getByLabelText("Year") as HTMLSelectElement;
    const period = screen.getByLabelText("Up to period") as HTMLSelectElement;
    expect(year.value).toBe("2026");
    expect(period.value).toBe("2");
    await user.selectOptions(period, "1");
    await waitFor(() => expect(callsTo(calls, "/api/reports/balance-sheet")).toHaveLength(2));
    expect(params(callsTo(calls, "/api/reports/balance-sheet")[1]).get("period")).toBe("1");
    await user.selectOptions(year, "2025");
    await waitFor(() => expect(callsTo(calls, "/api/reports/balance-sheet")).toHaveLength(3));
    const last = params(callsTo(calls, "/api/reports/balance-sheet")[2]);
    expect(last.get("year")).toBe("2025");
    expect(last.get("period")).toBe("1");
    expect(
      await screen.findByRole("heading", { level: 2, name: "2025, up to period 1" }),
    ).toBeTruthy();
  });

  it("ignores an invalid year or period in the address", async () => {
    const calls = mock();
    renderApp("/reporting/balance-sheet?year=20x6&period=99");
    await screen.findByRole("region", { name: "Balance sheet" });
    const sent = params(callsTo(calls, "/api/reports/balance-sheet")[0]);
    expect(sent.has("year")).toBe(false);
    expect(sent.has("period")).toBe(false);
    // dropping them from the address does not load the report again
    await settle(30);
    expect(callsTo(calls, "/api/reports/balance-sheet")).toHaveLength(1);
  });

  it("defaults to the period the server chose (latest with figures) and says when a later one exists", async () => {
    mock(() => balanceSheetResponse({ latestPeriodWithData: 5 }));
    renderApp("/reporting/balance-sheet");
    await screen.findByRole("region", { name: "Balance sheet" });
    expect((screen.getByLabelText("Up to period") as HTMLSelectElement).value).toBe("2");
    expect(screen.getByText(/Exact has figures up to period 5\./)).toBeTruthy();
  });

  it("says nothing about the latest period when it is the one shown", async () => {
    mock();
    renderApp("/reporting/balance-sheet");
    await screen.findByRole("region", { name: "Balance sheet" });
    expect(screen.queryByText(/Exact has (no )?figures/)).toBeNull();
  });

  it("offers closing periods 13 and up when the year has figures in them", async () => {
    mock(() => balanceSheetResponse({ latestPeriodWithData: 13 }, { year: 2025, period: 12 }));
    renderApp("/reporting/balance-sheet?year=2025");
    await screen.findByRole("region", { name: "Balance sheet" });
    const period = screen.getByLabelText("Up to period") as HTMLSelectElement;
    expect(period.value).toBe("12");
    expect([...period.options].map((o) => o.value)).toContain("13");
    expect(screen.getByText(/Exact has figures up to period 13\./)).toBeTruthy();
  });

  it("opens the period rows of an account: chart once, then balances for the year", async () => {
    const calls = mock(() => balanceSheetResponse(), {
      "GET /api/ledger/accounts": () => ({ body: chartResponse() }),
      "GET /api/ledger/accounts/100/balances": () => ({ body: accountBalancesResponse(100) }),
    });
    const user = userEvent.setup();
    renderApp("/reporting/balance-sheet");
    const region = await screen.findByRole("region", { name: "Balance sheet" });
    expect(callsTo(calls, "/api/ledger/accounts")).toHaveLength(0);
    await user.click(within(region).getByRole("button", { name: /1100 Bank ING/ }));
    const dialog = await screen.findByRole("dialog", { name: "1100 Bank ING" });
    const periods = await within(dialog).findByRole("region", { name: "Periods" });
    expect(params(callsTo(calls, "/api/ledger/accounts")[0]).get("division")).toBe("1");
    expect(params(callsTo(calls, "/api/ledger/accounts/100/balances")[0]).get("year")).toBe("2026");
    const rows = within(periods)
      .getAllByRole("row")
      .map((r) => norm(r.textContent));
    expect(rows[1]).toContain("0 (opening)");
    expect(rows[1]).toContain("€ 14.000,00");
    expect(rows.at(-1)).toContain("€ 24.000,00");
    // The periods the cell is made of add up to the cell (review K3b).
    expect(norm(within(dialog).getByTestId("included-check").textContent)).toBe(
      "€ 24.000,00: periods 0 to 2 (debit less credit), the figure in the report.",
    );
    // A second account reuses the chart.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(callsTo(calls, "/api/ledger/accounts")).toHaveLength(1);
  });

  it("explains an account that the chart does not know", async () => {
    mock(() => balanceSheetResponse(), {
      "GET /api/ledger/accounts": () => ({ body: { ...chartResponse(), accounts: [] } }),
    });
    const user = userEvent.setup();
    renderApp("/reporting/balance-sheet");
    const region = await screen.findByRole("region", { name: "Balance sheet" });
    await user.click(within(region).getByRole("button", { name: /1100 Bank ING/ }));
    expect(await screen.findByText("This account is not in the chart of accounts.")).toBeTruthy();
  });

  it("closes an open account sheet when the administration changes", async () => {
    mockFetch({
      ...base(TWO_DIVISIONS),
      "PUT /api/me/division": () => ({ body: { selectedId: 2 } }),
      "GET /api/reports/balance-sheet": () => ({ body: balanceSheetResponse() }),
      "GET /api/ledger/accounts": () => ({ body: chartResponse() }),
      "GET /api/ledger/accounts/100/balances": () => ({ body: accountBalancesResponse(100) }),
    });
    const user = userEvent.setup();
    renderApp("/reporting/balance-sheet");
    const region = await screen.findByRole("region", { name: "Balance sheet" });
    await user.click(within(region).getByRole("button", { name: /1100 Bank ING/ }));
    await screen.findByRole("dialog");
    // The sheet traps focus: switch through the select via fireEvent.
    fireEvent.change(screen.getByLabelText("Administration"), { target: { value: "2" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

// ---- profit and loss ----------------------------------------------------------------------------

describe("Profit and loss", () => {
  const mock = (
    pl = profitLossResponse,
    extra: Record<string, (c: Call) => { status?: number; body?: unknown }> = {},
  ) =>
    mockFetch({
      ...base(),
      "GET /api/reports/profit-loss": () => ({ body: pl() }),
      ...extra,
    });

  it("shows actual, budget, last year, variances and one-decimal percentages", async () => {
    const calls = mock();
    const { container } = renderApp("/reporting/profit-loss");
    const region = await screen.findByRole("region", { name: "Profit and loss" });
    expect(
      within(region)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Account",
      "Actual",
      "Budget",
      "Variance to budget",
      "Variance to budget %",
      "Last year (2025)",
      "Variance to last year",
      "Variance to last year %",
    ]);
    const rev = within(region).getByRole("row", { name: /Consulting revenue/ });
    const cells = within(rev)
      .getAllByRole("cell")
      .map((c) => norm(c.textContent));
    // Actual 11.500, budget 11.000, +500 (4,5455 % -> 4,6 %), last year 6.000, +5.500 (91,7 %).
    expect(cells).toEqual([
      "€ 11.500,00",
      "€ 11.000,00",
      "€ 500,00",
      "4,6%",
      "€ 6.000,00",
      "€ 5.500,00",
      "91,7%",
    ]);
    // Costs are negative; spending less than the budget is a positive variance.
    const rent = within(region).getByRole("row", { name: /Rent/ });
    expect(
      within(rent)
        .getAllByRole("cell")
        .map((c) => norm(c.textContent))
        .slice(0, 3),
    ).toEqual(["€ -1.500,00", "€ -2.000,00", "€ 500,00"]);
    expect(norm(within(region).getByRole("row", { name: /^Result/ }).textContent)).toContain(
      "€ 10.000,00",
    );
    expect(norm(within(region).getByRole("row", { name: /Total revenue/ }).textContent)).toContain(
      "€ 11.500,00",
    );
    const sent = params(callsTo(calls, "/api/reports/profit-loss")[0]);
    expect(sent.has("periodTo")).toBe(false);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("hides the budget columns with the note when budgets are not available", async () => {
    mock(() => profitLossResponse({}, { budgets: null }));
    renderApp("/reporting/profit-loss");
    const region = await screen.findByRole("region", { name: "Profit and loss" });
    expect(
      screen.getByText("Budget is not available in Exact for this administration."),
    ).toBeTruthy();
    const heads = within(region)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(heads).toEqual([
      "Account",
      "Actual",
      "Last year (2025)",
      "Variance to last year",
      "Variance to last year %",
    ]);
  });

  it("shows a dash, never 0, for a last year that has not been synced, and a dash for a zero base", async () => {
    mock(() => profitLossResponse({}, { compareYear: null }));
    renderApp("/reporting/profit-loss");
    const region = await screen.findByRole("region", { name: "Profit and loss" });
    const rev = within(region).getByRole("row", { name: /Consulting revenue/ });
    const cells = within(rev)
      .getAllByRole("cell")
      .map((c) => norm(c.textContent));
    expect(cells.slice(4)).toEqual(["—not available", "—not available", "—not available"]);
    expect(screen.getByText(/last-year figures are not available/)).toBeTruthy();
    expect(norm(rev.textContent)).not.toMatch(/€ 0,00 ?€ 0,00 ?0,0%/);
  });

  it("uses the period-to selector as periodTo", async () => {
    const calls = mock(() => profitLossResponse());
    const user = userEvent.setup();
    renderApp("/reporting/profit-loss");
    await screen.findByRole("region", { name: "Profit and loss" });
    await user.selectOptions(screen.getByLabelText("Year to date up to period"), "1");
    await waitFor(() => expect(callsTo(calls, "/api/reports/profit-loss")).toHaveLength(2));
    expect(params(callsTo(calls, "/api/reports/profit-loss")[1]).get("periodTo")).toBe("1");
    expect(params(callsTo(calls, "/api/reports/profit-loss")[1]).has("period")).toBe(false);
  });

  it("opens an account's period rows like the balance sheet", async () => {
    const calls = mock(profitLossResponse, {
      "GET /api/ledger/accounts": () => ({ body: chartResponse() }),
      "GET /api/ledger/accounts/105/balances": () => ({ body: accountBalancesResponse(105) }),
    });
    const user = userEvent.setup();
    renderApp("/reporting/profit-loss");
    const region = await screen.findByRole("region", { name: "Profit and loss" });
    await user.click(within(region).getByRole("button", { name: /8000 Consulting revenue/ }));
    const dialog = await screen.findByRole("dialog", { name: "8000 Consulting revenue" });
    await within(dialog).findByRole("region", { name: "Periods" });
    expect(callsTo(calls, "/api/ledger/accounts/105/balances")).toHaveLength(1);
    expect(norm(dialog.textContent)).toContain("€ -9.000,00");
    // Revenue is shown credit less debit: the sheet says so and its periods match the cell.
    expect(norm(within(dialog).getByTestId("included-check").textContent)).toBe(
      "€ 11.500,00: periods 1 to 2 (credit less debit), the figure in the report.",
    );
  });

  it("marks periods outside the report and says when the periods no longer add up to the cell", async () => {
    const changed = accountBalancesResponse(105);
    changed.periods = [
      ...changed.periods.map((p) => (p.period === 1 ? { ...p, amountMinor: -950_000 } : p)),
      { period: 3, amountMinor: -1_000, debitMinor: 0, creditMinor: 1_000, rows: 1 },
    ];
    mock(profitLossResponse, {
      "GET /api/ledger/accounts": () => ({ body: chartResponse() }),
      "GET /api/ledger/accounts/105/balances": () => ({ body: changed }),
    });
    const user = userEvent.setup();
    renderApp("/reporting/profit-loss");
    const region = await screen.findByRole("region", { name: "Profit and loss" });
    await user.click(within(region).getByRole("button", { name: /8000 Consulting revenue/ }));
    const dialog = await screen.findByRole("dialog", { name: "8000 Consulting revenue" });
    const periods = await within(dialog).findByRole("region", { name: "Periods" });
    expect(norm(within(periods).getByRole("row", { name: /^3/ }).textContent)).toContain(
      "not in the report",
    );
    expect(norm(within(dialog).getByTestId("included-check").textContent)).toBe(
      "periods 1 to 2 add up to € 12.000,00 (credit less debit), but the report shows € 11.500,00. The data changed since the report was loaded: reload the report.",
    );
  });

  it("empty and stale states", async () => {
    mock(() =>
      profitLossResponse({
        status: "not_synced",
        report: null,
        freshness: LEDGER_NEVER,
        compareFreshness: null,
      }),
    );
    const a = renderApp("/reporting/profit-loss");
    expect(await screen.findByText("No data yet.")).toBeTruthy();
    expect(screen.getAllByText("Never synced").length).toBeGreaterThan(0);
    a.unmount();
    mock(() =>
      profitLossResponse({
        freshness: {
          ...LEDGER_FRESH,
          gl_balances: {
            lastCompletedAt: new Date(Date.now() - 50 * 3_600_000).toISOString(),
            stale: true,
            staleAfterHours: 36,
          },
        },
      }),
    );
    renderApp("/reporting/profit-loss");
    await screen.findByRole("region", { name: "Profit and loss" });
    expect(screen.getByText("Out of date")).toBeTruthy();
  });
});

// ---- navigation, export and print ---------------------------------------------------------------

describe("Reporting menu", () => {
  it("links to the four real pages and none says 'not built yet'", async () => {
    mockFetch({
      ...base(),
      "GET /api/reports/ageing": () => ({ body: ageing() }),
      "GET /api/reports/balance-sheet": () => ({ body: balanceSheetResponse() }),
      "GET /api/reports/profit-loss": () => ({ body: profitLossResponse() }),
    });
    renderApp("/reporting/balance-sheet");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const hrefs = within(nav)
      .getAllByRole("link", { hidden: true })
      .map((a) => a.getAttribute("href"));
    for (const h of [
      "/reporting/balance-sheet",
      "/reporting/profit-loss",
      "/reporting/creditors-ageing",
      "/reporting/receivables-ageing",
    ]) {
      expect(hrefs).toContain(h);
    }
    expect(screen.queryByText(/not built yet/i)).toBeNull();
    // Treasury and Close are still placeholders.
    expect(hrefs).toContain("/treasury/bank");
  });

  it("sends the placeholder-era addresses to the renamed pages, keeping the query", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/reports/ageing": () => ({ body: ageing() }),
      "GET /api/reports/profit-loss": () => ({ body: profitLossResponse() }),
    });
    const first = renderApp("/reporting/profit-and-loss?year=2026&period=2");
    expect(await screen.findByRole("heading", { level: 1, name: "Profit and loss" })).toBeTruthy();
    const sent = params(callsTo(calls, "/api/reports/profit-loss")[0]);
    expect(sent.get("year")).toBe("2026");
    expect(sent.get("periodTo")).toBe("2");
    first.unmount();
    const second = renderApp("/reporting/creditors-age");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Creditors age analysis" }),
    ).toBeTruthy();
    second.unmount();
    renderApp("/reporting/receivables-age");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Receivables age analysis" }),
    ).toBeTruthy();
  });
});

describe("Export", () => {
  afterEach(() => vi.useRealTimers());

  it("Excel: builds the file in the browser, names it, and downloads a real workbook", async () => {
    mockFetch({ ...base(), "GET /api/reports/ageing": () => ({ body: ageing("payable") }) });
    const blobs: Blob[] = [];
    const urls = { create: vi.fn((b: Blob) => (blobs.push(b), "blob:test")), revoke: vi.fn() };
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: urls.create, revokeObjectURL: urls.revoke }),
    );
    const clicked: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href });
    });
    const user = userEvent.setup();
    renderApp("/reporting/creditors-ageing");
    await screen.findByRole("region", { name: "Creditors age analysis in EUR" });
    await user.click(screen.getByRole("button", { name: "Export Excel" }));
    await waitFor(() => expect(clicked).toHaveLength(1), { timeout: 5000 });
    expect(clicked[0]?.download).toBe("camelthorn-creditors-ageing-alpha-bv-2026-11-11.xlsx");
    expect(clicked[0]?.href).toBe("blob:test");
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
      fr.onerror = () => reject(new Error("read failed"));
      fr.readAsArrayBuffer(blobs[0] as Blob);
    });
    const zip = unzipSync(bytes);
    expect(Object.keys(zip)).toContain("xl/worksheets/sheet3.xlsx".replace("xlsx", "xml"));
    const wb = strFromU8(zip["xl/workbook.xml"] as Uint8Array);
    for (const name of ["EUR", "JPY", "KWD"]) expect(wb).toContain(`name="${name}"`);
    expect(
      await screen.findByText(/Saved camelthorn-creditors-ageing-alpha-bv-2026-11-11.xlsx/),
    ).toBeTruthy();
    // The button is usable again.
    expect(screen.getByRole("button", { name: "Export Excel" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("Excel: a failure is reported, not swallowed", async () => {
    mockFetch({
      ...base(),
      "GET /api/reports/profit-loss": () => ({ body: profitLossResponse() }),
    });
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: () => {
          throw new Error("no");
        },
        revokeObjectURL: vi.fn(),
      }),
    );
    const user = userEvent.setup();
    renderApp("/reporting/profit-loss");
    await screen.findByRole("region", { name: "Profit and loss" });
    await user.click(screen.getByRole("button", { name: "Export Excel" }));
    expect(await screen.findByText("Could not create the Excel file. Try again.")).toBeTruthy();
  });

  it("PDF: opens the print dialog with the print class and file name, and restores both after", async () => {
    mockFetch({
      ...base(),
      "GET /api/reports/balance-sheet": () => ({ body: balanceSheetResponse() }),
    });
    let during: { cls: boolean; title: string } | null = null;
    const print = vi.fn(() => {
      during = {
        cls: document.documentElement.classList.contains("printing"),
        title: document.title,
      };
    });
    vi.stubGlobal("print", print);
    const user = userEvent.setup();
    renderApp("/reporting/balance-sheet");
    await screen.findByRole("region", { name: "Balance sheet" });
    const before = document.title;
    expect(before).toBe("Balance sheet · Camelthorn Finance");
    await user.click(screen.getByRole("button", { name: "Export PDF" }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(during).toEqual({ cls: true, title: "camelthorn-balance-sheet-alpha-bv-2026-p02" });
    // Still marked until the dialog is done.
    expect(document.documentElement.classList.contains("printing")).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(document.documentElement.classList.contains("printing")).toBe(false);
    expect(document.title).toBe(before);
  });

  it("the page carries the print structure: orientation class, print header, hidden controls", async () => {
    mockFetch({
      ...base(),
      "GET /api/reports/ageing": () => ({ body: ageing() }),
      "GET /api/reports/balance-sheet": () => ({ body: balanceSheetResponse() }),
      "GET /api/reports/profit-loss": () => ({ body: profitLossResponse() }),
    });
    const a = renderApp("/reporting/receivables-ageing");
    await screen.findByRole("region", { name: "Receivables age analysis in EUR" });
    let root = document.querySelector("[data-report]") as HTMLElement;
    expect(root.className).toContain("report-landscape");
    const meta = document.querySelector(".print-meta") as HTMLElement;
    expect(meta.className).toContain("print-only");
    expect(norm(meta.textContent)).toContain("Administration: Alpha BV");
    expect(norm(meta.textContent)).toContain("As of 11 Nov 2026");
    expect(norm(meta.textContent)).toMatch(/Source: Exact Online, synced \d+ \w+ 2026/);
    // Everything interactive is marked for removal from the printed page.
    for (const el of document.querySelectorAll(".report-bar, .stamps")) {
      expect(el.className).toContain("no-print");
    }
    a.unmount();

    renderApp("/reporting/balance-sheet");
    await screen.findByRole("region", { name: "Balance sheet" });
    root = document.querySelector("[data-report]") as HTMLElement;
    expect(root.className).toContain("report-portrait");
  });
});
