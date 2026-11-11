import { norm } from "./test-norm";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import type { Freshness } from "@camelthorn/core";
import {
  FRESH,
  NEVER,
  ONE_DIVISION,
  TWO_DIVISIONS,
  detail,
  listResponse,
  row,
} from "./test-fixtures";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const base = (divisions = ONE_DIVISION) => ({
  "GET /api/auth/me": () => ({ body: VIEWER }),
  "GET /api/divisions": () => ({ body: divisions }),
});
async function loaded(name?: string) {
  const t = await screen.findByRole("table", name ? { name } : {});
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  return t;
}
const params = (c: Call | undefined) => new URL(c?.url ?? "", "http://x").searchParams;
const listCalls = (calls: Call[], path = "/api/invoices") =>
  calls.filter((c) => c.url.startsWith(path));

const R1 = row({ id: 1, invoiceNumber: "INV-1", dueDate: "2026-10-01", openMinor: 100_000 });
const R2 = row({
  id: 2,
  invoiceNumber: "INV-2",
  relation: { id: 8, name: "Beta GmbH" },
  dueDate: "2026-12-01",
  bucket: "not_due",
  daysOverdue: -20,
  openMinor: -2500,
});
const R3 = row({
  id: 3,
  invoiceNumber: null,
  entryNumber: 77,
  currency: "USD",
  openMinor: 5000,
  dueDate: null,
  bucket: "no_due_date",
  daysOverdue: null,
});

describe("Invoices list", () => {
  it("shows rows with ageing chips, overdue text, credits and totals per currency", async () => {
    mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1, R2, R3]) }),
    });
    const { container } = renderApp("/invoices");
    const table = await loaded("Invoices");
    expect(within(table).getByRole("button", { name: "INV-1" })).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Entry 77" })).toBeTruthy();
    expect(within(table).getByText("31–60 days")).toBeTruthy();
    expect(within(table).getByText("41 days overdue")).toBeTruthy();
    expect(within(table).getByText("Due in 20 days")).toBeTruthy();
    expect(within(table).getByText("No due date", { selector: ".cap" })).toBeTruthy();
    expect(norm(table.textContent)).toContain("€ -25,00 credit");
    // Totals: one row per currency, never summed across.
    const totals = table.querySelectorAll("tfoot tr");
    expect(totals).toHaveLength(2);
    expect(norm(totals[0]?.textContent ?? "")).toContain("Total EUR, all 2 items matching");
    expect(norm(totals[0]?.textContent ?? "")).toContain("€ 975,00");
    expect(norm(totals[1]?.textContent ?? "")).toContain("$ 50,00");
    expect(screen.getByText("Balances as of 11 Nov 2026")).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("asks the API for the open items of the selected administration, due-date ascending", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1]) }),
    });
    renderApp("/invoices");
    await loaded();
    const p = params(listCalls(calls)[0]);
    expect(p.get("status")).toBe("open");
    expect(p.get("division")).toBe("1");
    expect(p.get("sort")).toBe("due");
    expect(p.get("limit")).toBe("50");
    expect(p.has("overdue")).toBe(false);
  });

  it("switches between Open, Overdue, Closed and All", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1]) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await loaded();
    const seg = screen.getByRole("group", { name: "Show" });
    expect(within(seg).getByRole("button", { name: "Open" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(within(seg).getByRole("button", { name: "Overdue" }));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(params(listCalls(calls)[1]).get("overdue")).toBe("1");
    expect(params(listCalls(calls)[1]).get("status")).toBe("open");
    await user.click(within(seg).getByRole("button", { name: "Closed since first sync" }));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(3));
    expect(params(listCalls(calls)[2]).get("status")).toBe("closed");
    expect(params(listCalls(calls)[2]).has("overdue")).toBe(false);
    await user.click(within(seg).getByRole("button", { name: "All" }));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(4));
    expect(params(listCalls(calls)[3]).get("status")).toBe("all");
  });

  it("shows closed items without ageing", async () => {
    mockFetch({
      ...base(),
      "GET /api/invoices": () => ({
        body: listResponse([
          row({ id: 5, status: "closed", openMinor: 0, bucket: null, daysOverdue: null }),
        ]),
      }),
    });
    renderApp("/invoices?view=closed");
    const table = await loaded();
    expect(within(table).getByText("Closed", { selector: ".chip" })).toBeTruthy();
  });

  it("searches after typing pauses and sends the text as q", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1]) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await loaded();
    await user.type(screen.getByRole("searchbox", { name: "Search invoices" }), "acme");
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(params(listCalls(calls)[1]).get("q")).toBe("acme");
  });

  it("toggles the due-date sort and requests -due", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1]) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    const th = await screen.findByRole("columnheader", { name: /Due date/ });
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    await user.click(within(th).getByRole("button"));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(params(listCalls(calls)[1]).get("sort")).toBe("-due");
    expect(screen.getByRole("columnheader", { name: /Due date/ }).getAttribute("aria-sort")).toBe(
      "descending",
    );
    await user.click(
      within(screen.getByRole("columnheader", { name: /Due date/ })).getByRole("button"),
    );
    await waitFor(() => expect(listCalls(calls)).toHaveLength(3));
    expect(params(listCalls(calls)[2]).get("sort")).toBe("due");
  });

  it("filters by currency once the list holds more than one", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1, R3]) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await loaded();
    const select = screen.getByLabelText("Currency");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All currencies", "EUR", "USD"]);
    await user.selectOptions(select, "USD");
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(params(listCalls(calls)[1]).get("currency")).toBe("USD");
  });

  it("keeps the currency choices after narrowing to one currency", async () => {
    mockFetch({
      ...base(),
      "GET /api/invoices": (c) => ({
        body: params(c).get("currency") === "USD" ? listResponse([R3]) : listResponse([R1, R3]),
      }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await loaded();
    await user.selectOptions(screen.getByLabelText("Currency"), "USD");
    await screen.findByRole("button", { name: "Entry 77" });
    expect(within(screen.getByLabelText("Currency")).getAllByRole("option")).toHaveLength(3);
  });

  it("narrows to a relation from the item sheet and clears it again", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1]) }),
      "GET /api/open-items/1": () => ({ body: detail(R1) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-1" }));
    const dialog = await screen.findByRole("dialog", { name: "Invoice details" });
    await user.click(
      await within(dialog).findByRole("button", { name: "Show all items for this relation" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(params(listCalls(calls)[1]).get("relationId")).toBe("7");
    const clear = await screen.findByRole("button", { name: "Clear customer filter" });
    expect(clear.closest(".chip")?.textContent).toContain("Customer: Acme BV");
    await user.click(clear);
    await waitFor(() => expect(listCalls(calls)).toHaveLength(3));
    expect(params(listCalls(calls)[2]).has("relationId")).toBe(false);
  });

  it("restores filters from the address", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1]) }),
    });
    renderApp("/invoices?view=overdue&q=acme&currency=usd&relationId=7&sort=-due");
    await loaded();
    const p = params(listCalls(calls)[0]);
    expect(p.get("overdue")).toBe("1");
    expect(p.get("q")).toBe("acme");
    expect(p.get("currency")).toBe("USD");
    expect(p.get("relationId")).toBe("7");
    expect(p.get("sort")).toBe("-due");
  });

  it("tells never read, nothing open and nothing matching apart", async () => {
    let fresh: Freshness = FRESH;
    mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([], { freshness: fresh }) }),
    });
    // Read completely, nothing open: a number, not "not synced".
    const first = renderApp("/invoices");
    expect(await screen.findByText("0 open invoices.")).toBeTruthy();
    expect(screen.getByText("Nothing is open in Exact for this administration.")).toBeTruthy();
    expect(screen.queryByText(/not been read|read from Exact yet/)).toBeNull();
    first.unmount();
    // Filters on: say so.
    const second = renderApp("/invoices?q=zzz");
    expect(await screen.findByText("No invoices match these filters.")).toBeTruthy();
    expect(screen.getByText(/Clear a filter or change the search/)).toBeTruthy();
    second.unmount();
    // Never read completely: neither "0 open" nor "no match", and the stamp says Never synced.
    fresh = NEVER;
    renderApp("/invoices");
    expect(await screen.findByText("No invoices read from Exact yet.")).toBeTruthy();
    expect(screen.queryByText("0 open invoices.")).toBeNull();
    expect(screen.getByText("Never synced")).toBeTruthy();
  });

  it("shows an error with a retry", async () => {
    let n = 0;
    mockFetch({
      ...base(),
      "GET /api/invoices": () => {
        n += 1;
        return n === 1 ? { status: 500, body: { error: "x" } } : { body: listResponse([R1]) };
      },
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load this data");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "INV-1" })).toBeTruthy();
  });

  it("explains a search index that is still building", async () => {
    mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ status: 503, body: { error: "search_index_building" } }),
    });
    renderApp("/invoices?q=a");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "search index is still being built",
    );
  });

  it("shows skeleton rows while loading", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    mockFetch({ ...base(), "GET /api/invoices": () => ({ body: listResponse([R1]) }) });
    const real = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      String(url).startsWith("/api/invoices")
        ? gate.then(() => real(url, init))
        : real(url, init)) as typeof fetch;
    const { container } = renderApp("/invoices");
    await waitFor(() => expect(container.querySelectorAll(".sk-row").length).toBeGreaterThan(0));
    expect(container.querySelector(".dt")?.getAttribute("aria-busy")).toBe("true");
    release();
    await screen.findByRole("button", { name: "INV-1" });
  });

  it("pages with Load more and shows the running count", async () => {
    let n = 0;
    const calls = mockFetch({
      ...base(),
      "GET /api/invoices": () => {
        n += 1;
        return {
          body:
            n === 1
              ? listResponse([R1], { nextCursor: "abc", total: 2 })
              : listResponse([R2], { total: 2 }),
        };
      },
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await screen.findByText("Showing 1 of 2");
    await user.dblClick(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: "INV-2" });
    expect(screen.getByRole("button", { name: "INV-1" })).toBeTruthy();
    expect(listCalls(calls)).toHaveLength(2);
    expect(params(listCalls(calls)[1]).get("cursor")).toBe("abc");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("starts from the first page again when a filter changes", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/invoices": (c) => ({
        body: params(c).get("overdue")
          ? listResponse([R1])
          : listResponse([R2], { nextCursor: "abc", total: 5 }),
      }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await screen.findByRole("button", { name: "INV-2" });
    await user.click(screen.getByRole("button", { name: "Overdue" }));
    await screen.findByRole("button", { name: "INV-1" });
    expect(screen.queryByRole("button", { name: "INV-2" })).toBeNull();
    expect(params(listCalls(calls)[1]).has("cursor")).toBe(false);
  });

  it("opens the item sheet with every detail, Yes/No flags and provenance", async () => {
    mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1]) }),
      "GET /api/open-items/1": () => ({
        body: detail(R1, {
          rate: "1.0856",
          provenance: {
            lastSeenAt: "2026-11-11T02:00:00.000Z",
            lastSeenSyncId: 3,
            missedCycles: 1,
            source: "list",
          },
        }),
      }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-1" }));
    const dialog = await screen.findByRole("dialog", { name: "Invoice details" });
    await within(dialog).findByText("Has VAT number");
    const dl = (label: string) =>
      within(dialog).getByText(label, { selector: "dt" }).parentElement?.querySelector("dd")
        ?.textContent;
    expect(dl("Has email")).toBe("No");
    expect(dl("Has VAT number")).toBe("Yes");
    expect(dl("Country")).toBe("NL");
    expect(dl("Document")).toBe("INV-1");
    expect(norm(dl("Booked rate in Exact") ?? "")).toBe(
      "1,0856 (as stored in Exact; direction unverified)",
    );
    expect(norm(dl("Invoice total") ?? "")).toBe("€ 1.000,00");
    expect(norm(dl("Amount as stored") ?? "")).toBe("€ 1.000,00");
    expect(dl("Due date")).toBe("1 Oct 2026");
    expect(within(dialog).getByText(/Last seen in Exact 11 Nov 2026, 03:00/)).toBeTruthy();
    expect(within(dialog).getByText(/Source: Nightly full read/)).toBeTruthy();
    expect(within(dialog).getByText(/Missed in 1 full reads since/)).toBeTruthy();
    // No emails, IBANs or buttons for actions that do not exist yet.
    expect(dialog.textContent).not.toMatch(/@|IBAN/);
    expect(within(dialog).queryByRole("button", { name: /pay|approve|match/i })).toBeNull();
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it("says when the invoice total is not known and shows no link without an Exact URL", async () => {
    const r = row({ id: 1, originalMinor: null, dcMinor: null });
    mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([r]) }),
      "GET /api/open-items/1": () => ({ body: detail(r, { relation: null }) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-1001" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Not known")).toBeTruthy();
    expect(within(dialog).getByText("No EUR amount yet")).toBeTruthy();
    expect(within(dialog).getByText("This relation has not been synced yet.")).toBeTruthy();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("shows an error in the item sheet when the item is gone", async () => {
    mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1]) }),
      "GET /api/open-items/1": () => ({ status: 404, body: { error: "not_found" } }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-1" }));
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByRole("alert")).textContent).toContain("no longer exists");
  });

  it("moves with J and K, opens with Enter and closes with Escape, returning focus", async () => {
    mockFetch({
      ...base(),
      "GET /api/invoices": () => ({ body: listResponse([R1, R2]) }),
      "GET /api/open-items/2": () => ({ body: detail(R2) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await screen.findByRole("button", { name: "INV-1" });
    await user.keyboard("jj");
    const second = screen.getByRole("button", { name: "INV-2" });
    expect(document.activeElement).toBe(second);
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Keys do not move the list behind an open sheet.
    await user.keyboard("k");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(second);
    expect(screen.getByText(/move,/).querySelectorAll(".kbd").length).toBeGreaterThan(0);
  });

  it("does not steal J or K from the search box", async () => {
    mockFetch({ ...base(), "GET /api/invoices": () => ({ body: listResponse([R1]) }) });
    const user = userEvent.setup();
    renderApp("/invoices");
    await screen.findByRole("button", { name: "INV-1" });
    const box = screen.getByRole("searchbox");
    await user.click(box);
    await user.keyboard("jk");
    expect((box as HTMLInputElement).value).toBe("jk");
  });

  it("reloads for the other administration and aborts the old request", async () => {
    const calls = mockFetch({
      ...base(TWO_DIVISIONS),
      "PUT /api/me/division": () => ({ body: { selectedId: 2 } }),
      "GET /api/invoices": (c) => ({
        body:
          params(c).get("division") === "2"
            ? listResponse([row({ id: 9, invoiceNumber: "BETA-9" })])
            : listResponse([R1]),
      }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await screen.findByRole("button", { name: "INV-1" });
    expect(listCalls(calls)[0]?.signal?.aborted).toBe(false);
    await user.selectOptions(screen.getByLabelText("Administration"), "2");
    expect(screen.queryByRole("button", { name: "INV-1" })).toBeNull();
    await screen.findByRole("button", { name: "BETA-9" });
    expect(listCalls(calls).map((c) => params(c).get("division"))).toEqual(["1", "2"]);
    expect(listCalls(calls)[0]?.signal?.aborted).toBe(true);
  });

  it("shows the connect empty state with no administration", async () => {
    mockFetch({ ...base({ selectedId: null, divisions: [] }) });
    renderApp("/invoices");
    expect(await screen.findByText("No data yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect Exact" })).toBeTruthy();
  });

  it("has no exclamation marks", async () => {
    mockFetch({ ...base(), "GET /api/invoices": () => ({ body: listResponse([R1]) }) });
    renderApp("/invoices");
    await loaded();
    expect(document.body.textContent).not.toContain("!");
  });
});

describe("Payables list", () => {
  it("uses the bills endpoint with supplier wording", async () => {
    const calls = mockFetch({
      ...base(),
      "GET /api/bills": () => ({
        body: listResponse([
          row({
            id: 4,
            kind: "bill",
            invoiceNumber: "B-4",
            relation: { id: 3, name: "Supplier BV" },
          }),
        ]),
      }),
      "GET /api/open-items/4": () => ({
        body: detail(row({ id: 4, kind: "bill", invoiceNumber: "B-4" })),
      }),
    });
    const user = userEvent.setup();
    const { container } = renderApp("/purchases/payables");
    const table = await loaded("Payables");
    expect(screen.getByRole("heading", { level: 1, name: "Payables" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Supplier" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Bill" })).toBeTruthy();
    expect(listCalls(calls, "/api/bills")).toHaveLength(1);
    expect(listCalls(calls, "/api/invoices")).toHaveLength(0);
    expect(await axe(container)).toHaveNoViolations();
    await user.click(within(table).getByRole("button", { name: "B-4" }));
    expect(await screen.findByRole("dialog", { name: "Bill details" })).toBeTruthy();
    // Read-only phase: no pay, approve or match buttons anywhere.
    expect(screen.queryByRole("button", { name: /^(pay|approve|match)/i })).toBeNull();
  });
});
