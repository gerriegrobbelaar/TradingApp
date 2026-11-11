/**
 * Review K3a: drill-downs that add up, filters in the address (Back, invalid values), division
 * switches with relation filters and open sheets, list freshness, and "read-only" checked
 * through every screen and sheet.
 */
import { norm } from "./test-norm";
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router";
import {
  addDays,
  buildOverviewKpis,
  type CurrencyKpisDto,
  type DrilldownHint,
  type KpiFigure,
  type OpenItemRow,
} from "@camelthorn/core";
import { AppShell } from "./App";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import {
  DIV_REF,
  ONE_DIVISION,
  STALE,
  TWO_DIVISIONS,
  approval,
  approvals,
  detail,
  listResponse,
  overview,
  row,
} from "./test-fixtures";

const params = (c: Call | undefined) => new URL(c?.url ?? "", "http://x").searchParams;
const callsTo = (calls: Call[], path: string) => calls.filter((c) => c.url.startsWith(path));

/** Renders the app with a handle on navigation, for Back / Forward. */
function renderWithHistory(path: string) {
  const nav: { go: NavigateFunction | null; search: string } = { go: null, search: "" };
  function Probe() {
    nav.go = useNavigate();
    nav.search = useLocation().search;
    return null;
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
      <Probe />
    </MemoryRouter>,
  );
  return nav;
}

// ---- drill-downs add up ------------------------------------------------------------------------

const AS_OF = "2026-11-11";

/** The list API's filter semantics (ADR 0022): all bounds exclusive, open items only. */
function matches(item: OpenItemRow, q: URLSearchParams): boolean {
  if ((q.get("status") ?? "open") !== "all" && item.status !== (q.get("status") ?? "open"))
    return false;
  const cur = q.get("currency");
  if (cur && item.currency !== cur.toUpperCase()) return false;
  const before = q.get("dueBefore");
  const after = q.get("dueAfter");
  if (before && (item.dueDate === null || !(item.dueDate < before))) return false;
  if (after && (item.dueDate === null || !(item.dueDate > after))) return false;
  if (q.get("noDueDate") === "1" && item.dueDate !== null) return false;
  return true;
}

/** Same as the worker's kpiQuery (apps/worker/src/read/routes.ts). */
function kpiQuery(figure: KpiFigure): Record<string, string> {
  switch (figure) {
    case "total":
      return {};
    case "overdue":
      return { dueBefore: AS_OF };
    case "due7":
      return { dueAfter: addDays(AS_OF, -1), dueBefore: addDays(AS_OF, 8) };
    case "due30":
      return { dueAfter: addDays(AS_OF, -1), dueBefore: addDays(AS_OF, 31) };
    case "noDueDate":
      return { noDueDate: "1" };
  }
}

function dataset(): OpenItemRow[] {
  const items: OpenItemRow[] = [];
  const dues: (number | null)[] = [-90, -40, -10, -1, 0, 0, 3, 7, 8, 20, 30, 31, 45, null, null];
  // Three rounds, so the larger figures need more than one page of 25 in the sheet.
  [...dues, ...dues, ...dues].forEach((d, i) => {
    for (const currency of ["EUR", "USD", "JPY"]) {
      items.push(
        row({
          id: items.length + 1,
          invoiceNumber: `D-${currency}-${i}`,
          currency,
          dueDate: d === null ? null : addDays(AS_OF, d),
          // Credits on some rows: they reduce every figure they belong to.
          openMinor: (i % 4 === 3 ? -1 : 1) * (1_000 + i * 137),
          dcMinor: currency === "EUR" ? (i % 4 === 3 ? -1 : 1) * (1_000 + i * 137) : null,
          bucket: d === null ? "no_due_date" : d > 0 ? "d1_30" : "not_due",
          daysOverdue: d === null ? null : -d,
        }),
      );
    }
  });
  return items;
}

function overviewFrom(items: OpenItemRow[]) {
  const k = buildOverviewKpis(
    items.map((i) => ({
      kind: "receivable" as const,
      currency: i.currency,
      openMinor: i.openMinor,
      dueDate: i.dueDate,
      dcMinor: i.dcMinor,
    })),
    AS_OF,
  );
  const figures: KpiFigure[] = ["total", "overdue", "due7", "due30", "noDueDate"];
  const receivable: CurrencyKpisDto[] = k.receivable.map((c) => ({
    ...c,
    drilldown: Object.fromEntries(
      figures.map((f) => [
        f,
        {
          path: "/api/invoices",
          query: { status: "open", currency: c.currency, ...kpiQuery(f) },
        } as DrilldownHint,
      ]),
    ) as unknown as Record<KpiFigure, DrilldownHint>,
  }));
  return overview({ asOf: AS_OF, kpis: { receivable, payable: [] } });
}

describe("drill-down sheets show exactly the items behind each figure", () => {
  it("count and sum of every figure's sheet equal the figure, per currency", async () => {
    const items = dataset();
    const ov = overviewFrom(items);
    const calls = mockFetch({
      "GET /api/auth/me": () => ({ body: VIEWER }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/overview": () => ({ body: ov }),
      "GET /api/invoices": (c) => {
        const q = params(c);
        const all = items.filter((i) => matches(i, q));
        // Pages of 25, like the sheet asks for, with server totals over ALL matching rows.
        const start = Number(q.get("cursor") ?? "0");
        const page = all.slice(start, start + Number(q.get("limit")));
        const full = listResponse(all);
        return {
          body: {
            ...full,
            items: page,
            nextCursor: start + page.length < all.length ? String(start + page.length) : null,
          },
        };
      },
    });
    const user = userEvent.setup();
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    const LABELS: [KpiFigure, string][] = [
      ["total", "Open receivables"],
      ["overdue", "Overdue receivables"],
      ["due7", "Receivables due in 7 days"],
      ["due30", "Receivables due in 30 days"],
    ];
    let checked = 0;
    for (const k of ov.kpis.receivable) {
      for (const [figure, label] of LABELS) {
        const amount = k[figure];
        const button = within(recv)
          .getAllByRole("button")
          .find(
            (b) =>
              b.textContent?.includes(label) &&
              b.closest(".ccy-block")?.querySelector(".ccy-title")?.textContent === k.currency,
          );
        expect(button, `${k.currency} ${figure}`).toBeTruthy();
        const before = callsTo(calls, "/api/invoices").length;
        await user.click(button as HTMLElement);
        const dialog = await screen.findByRole("dialog", { name: `${label} (${k.currency})` });
        await waitFor(() => expect(callsTo(calls, "/api/invoices").length).toBe(before + 1));
        // The request carries the hint's filters unchanged plus division, order and paging.
        const sent = params(callsTo(calls, "/api/invoices")[before]);
        for (const [key, v] of Object.entries(k.drilldown[figure].query)) {
          expect(sent.get(key), `${figure} ${key}`).toBe(v);
        }
        expect(sent.get("division")).toBe("1");
        // Load every page, then count and add the rows the sheet shows.
        for (;;) {
          const more = within(dialog).queryByRole("button", { name: "Load more" });
          if (!more) break;
          await user.click(more);
          await waitFor(() =>
            expect(within(dialog).queryByRole("button", { name: "Loading…" })).toBeNull(),
          );
        }
        if (amount.count > 0) {
          const rows = await within(dialog).findAllByRole("listitem");
          expect(rows).toHaveLength(amount.count);
          const ids = rows.map((r) => r.querySelector("b + span")?.textContent ?? "");
          const shown = items.filter((i) => ids.some((t) => t.startsWith(`${i.invoiceNumber} `)));
          expect(shown).toHaveLength(amount.count);
          expect(shown.reduce((n, i) => n + i.openMinor, 0)).toBe(amount.minor);
        } else {
          expect(await within(dialog).findByText("0 items")).toBeTruthy();
        }
        // The figure and the server totals agree: no "changed since" warning.
        expect(within(dialog).queryByText(/add up to/)).toBeNull();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        checked++;
      }
    }
    expect(checked).toBe(12);
  });

  it("warns when the items no longer add up to the figure", async () => {
    mockFetch({
      "GET /api/auth/me": () => ({ body: VIEWER }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/overview": () => ({ body: overview() }),
      // The overview said 12 items, 12.345,00; one was paid in between.
      "GET /api/invoices": () => ({
        body: listResponse([row({ id: 1, openMinor: 1_000_000 })], {
          total: 11,
          totalsByCurrency: [
            {
              currency: "EUR",
              count: 11,
              openMinor: 1_000_000,
              dcMinor: 1_000_000,
              dcMissing: 0,
              dcComplete: true,
              possiblyPaid: 0,
            },
          ],
        }),
      }),
    });
    const user = userEvent.setup();
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await user.click(within(recv).getAllByRole("button")[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    const note = await within(dialog).findByText(/add up to/);
    expect(norm(note.textContent)).toContain(
      "These items add up to € 10.000,00 in 11 items, not € 12.345,00 in 12 items",
    );
  });

  it("returns focus to the row that was opened after Back to list", async () => {
    const a = row({ id: 11, invoiceNumber: "INV-11" });
    const b = row({ id: 12, invoiceNumber: "INV-12", relation: { id: 8, name: "Beta GmbH" } });
    mockFetch({
      "GET /api/auth/me": () => ({ body: VIEWER }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/overview": () => ({ body: overview() }),
      "GET /api/invoices": () => ({ body: listResponse([a, b]) }),
      "GET /api/open-items/12": () => ({ body: detail(b) }),
    });
    const user = userEvent.setup();
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await user.click(within(recv).getAllByRole("button")[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: /Beta GmbH/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Back to list" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: /Beta GmbH/ }),
      ),
    );
  });
});

// ---- filters in the address --------------------------------------------------------------------

const lists = (divisions = ONE_DIVISION, me = VIEWER) => ({
  "GET /api/auth/me": () => ({ body: me }),
  "GET /api/divisions": () => ({ body: divisions }),
});

describe("list filters in the address", () => {
  it("drops invalid values instead of sending them", async () => {
    const calls = mockFetch({
      ...lists(),
      "GET /api/invoices": () => ({ body: listResponse([row()]) }),
    });
    const nav = renderWithHistory(
      "/invoices?view=bogus&currency=12&relationId=abc&relationName=Evil&sort=sideways&q=ok",
    );
    await screen.findByRole("button", { name: "INV-1001" });
    const sent = callsTo(calls, "/api/invoices");
    expect(sent).toHaveLength(1);
    const p = params(sent[0]);
    expect(p.get("status")).toBe("open");
    expect(p.has("currency")).toBe(false);
    expect(p.has("relationId")).toBe(false);
    expect(p.get("sort")).toBe("due");
    expect(p.get("q")).toBe("ok");
    await waitFor(() => expect(nav.search).toBe(""));
    expect(screen.queryByText(/Evil/)).toBeNull();
  });

  it("makes status changes history entries, so Back and Forward restore them", async () => {
    const calls = mockFetch({
      ...lists(),
      "GET /api/invoices": () => ({ body: listResponse([row()]) }),
    });
    const user = userEvent.setup();
    const nav = renderWithHistory("/invoices");
    await screen.findByRole("button", { name: "INV-1001" });
    await user.click(screen.getByRole("button", { name: "Overdue" }));
    await waitFor(() => expect(nav.search).toBe("?view=overdue"));
    await user.click(screen.getByRole("button", { name: "Closed since first sync" }));
    await waitFor(() => expect(nav.search).toBe("?view=closed"));
    act(() => nav.go?.(-1));
    await waitFor(() => expect(nav.search).toBe("?view=overdue"));
    await waitFor(() =>
      expect(params(callsTo(calls, "/api/invoices").at(-1)).get("overdue")).toBe("1"),
    );
    expect(screen.getByRole("button", { name: "Overdue" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    act(() => nav.go?.(1));
    await waitFor(() => expect(nav.search).toBe("?view=closed"));
    await waitFor(() =>
      expect(params(callsTo(calls, "/api/invoices").at(-1)).get("status")).toBe("closed"),
    );
  });

  it("shows the relation name from the rows, not from the address", async () => {
    mockFetch({
      ...lists(),
      "GET /api/invoices": () => ({
        body: listResponse([row({ relation: { id: 7, name: "Acme BV" } })]),
      }),
    });
    renderApp("/invoices?relationId=7&relationName=Somebody%20else");
    const clear = await screen.findByRole("button", { name: "Clear customer filter" });
    await waitFor(() => expect(clear.closest(".chip")?.textContent).toContain("Customer: Acme BV"));
  });

  it("keeps the search text and relation names out of the address (review S7)", async () => {
    const calls = mockFetch({
      ...lists(),
      "GET /api/invoices": () => ({ body: listResponse([]) }),
      "GET /api/relations/7": () => ({
        body: {
          id: 7,
          divisionId: 1,
          exactId: "x",
          code: null,
          name: "Acme BV",
          isCustomer: true,
          isSupplier: false,
          country: null,
          hasVatNumber: false,
          hasEmail: false,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    });
    const user = userEvent.setup();
    const nav = renderWithHistory("/invoices?relationId=7&relationName=Evil");
    // no row carries the relation: its name is looked up by id, never read from the address
    const clear = await screen.findByRole("button", { name: "Clear customer filter" });
    await waitFor(() => expect(clear.closest(".chip")?.textContent).toContain("Customer: Acme BV"));
    expect(callsTo(calls, "/api/relations/7").length).toBeGreaterThan(0);
    await waitFor(() => expect(nav.search).toBe("?relationId=7"));
    await user.type(screen.getByRole("searchbox", { name: "Search invoices" }), "secret");
    await waitFor(() => expect(params(callsTo(calls, "/api/invoices").at(-1)).get("q")).toBe("secret"));
    expect(nav.search).toBe("?relationId=7");
  });

  it("puts focus on the new filter after Show all items for this relation", async () => {
    const r = row({ id: 1, invoiceNumber: "INV-1" });
    mockFetch({
      ...lists(),
      "GET /api/invoices": () => ({ body: listResponse([r]) }),
      "GET /api/open-items/1": () => ({ body: detail(r) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-1" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      await within(dialog).findByRole("button", { name: "Show all items for this relation" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Clear customer filter" }),
      ),
    );
  });
});

// ---- division switching ------------------------------------------------------------------------

describe("switching administration on a list", () => {
  it("explains a relation filter from another administration and offers to clear it", async () => {
    const calls = mockFetch({
      ...lists(),
      "GET /api/invoices": (c) =>
        params(c).has("relationId")
          ? { status: 404, body: { error: "unknown_relation" } }
          : { body: listResponse([row()]) },
    });
    const user = userEvent.setup();
    renderApp("/invoices?relationId=99&relationName=Other");
    expect(await screen.findByText("That customer is not in Alpha BV.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show all invoices" }));
    await screen.findByRole("button", { name: "INV-1001" });
    expect(params(callsTo(calls, "/api/invoices").at(-1)).has("relationId")).toBe(false);
  });

  it("drops the relation filter and never asks the new administration for it", async () => {
    const calls = mockFetch({
      ...lists(TWO_DIVISIONS),
      "PUT /api/me/division": () => ({ body: { selectedId: 2 } }),
      "GET /api/invoices": (c) => ({
        body:
          params(c).get("division") === "2"
            ? listResponse([row({ id: 9, invoiceNumber: "BETA-9" })], {
                division: { ...DIV_REF, id: 2, name: "Beta BV" },
              })
            : listResponse([row()]),
      }),
    });
    const user = userEvent.setup();
    const nav = renderWithHistory("/invoices?relationId=7&relationName=Acme%20BV&view=all");
    await screen.findByRole("button", { name: "INV-1001" });
    await user.selectOptions(screen.getByLabelText("Administration"), "2");
    await screen.findByRole("button", { name: "BETA-9" });
    const forTwo = callsTo(calls, "/api/invoices").filter((c) => params(c).get("division") === "2");
    expect(forTwo.length).toBeGreaterThan(0);
    for (const c of forTwo) expect(params(c).has("relationId")).toBe(false);
    // Other filters stay.
    expect(nav.search).toBe("?view=all");
    expect(screen.queryByRole("button", { name: "Clear customer filter" })).toBeNull();
  });

  it("closes the item sheet in the same render as the switch", async () => {
    const r = row({ id: 1, invoiceNumber: "INV-1" });
    const calls = mockFetch({
      ...lists(TWO_DIVISIONS),
      "PUT /api/me/division": () => ({ body: { selectedId: 2 } }),
      "GET /api/invoices": () => ({ body: listResponse([r]) }),
      "GET /api/open-items/1": () => ({ body: detail(r) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-1" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Has VAT number");
    const before = callsTo(calls, "/api/open-items").length;
    await user.selectOptions(screen.getByLabelText("Administration"), "2");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(callsTo(calls, "/api/open-items")).toHaveLength(before);
  });

  it("closes the Approvals sheet on a switch", async () => {
    mockFetch({
      ...lists(TWO_DIVISIONS),
      "PUT /api/me/division": () => ({ body: { selectedId: 2 } }),
      "GET /api/approvals": () => ({ body: approvals([approval()]) }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals");
    await user.click(await screen.findByRole("button", { name: "Entry 2001" }));
    await screen.findByRole("dialog");
    await user.selectOptions(screen.getByLabelText("Administration"), "2");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// ---- freshness on lists ------------------------------------------------------------------------

describe("freshness on Invoices and Payables", () => {
  it("shows Updated x ago from the list's own freshness", async () => {
    mockFetch({ ...lists(), "GET /api/invoices": () => ({ body: listResponse([row()]) }) });
    renderApp("/invoices");
    expect(await screen.findByText(/Updated 5 min ago/)).toBeTruthy();
    expect(screen.queryByText("Out of date")).toBeNull();
  });

  it("flags stale payables with the amber chip and one sentence", async () => {
    mockFetch({
      ...lists(ONE_DIVISION, ADMIN),
      "GET /api/bills": () => ({
        body: listResponse([row({ kind: "bill" })], {
          freshness: { ...STALE, basis: ["payables"] },
        }),
      }),
    });
    renderApp("/purchases/payables");
    expect(await screen.findByText("Out of date")).toBeTruthy();
    expect(screen.getByText(/Supplier bills was last read/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Check connections" })).toBeTruthy();
  });

  it("keeps the stamp while another filter loads", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    mockFetch({ ...lists(), "GET /api/invoices": () => ({ body: listResponse([row()]) }) });
    const real = globalThis.fetch;
    let n = 0;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/invoices") && ++n === 2)
        return gate.then(() => real(url, init));
      return real(url, init);
    }) as typeof fetch;
    const user = userEvent.setup();
    renderApp("/invoices");
    await screen.findByText(/Updated 5 min ago/);
    await user.click(screen.getByRole("button", { name: "Overdue" }));
    expect(screen.getByText(/Updated 5 min ago/)).toBeTruthy();
    release();
    await screen.findByRole("button", { name: "INV-1001" });
  });
});

// ---- read-only, everywhere ---------------------------------------------------------------------

const ACTION =
  /\b(pay|paid|approve|reject|match|book|send|remind|resend|lock|delete|remove|edit|save|submit|sync now)\b/i;

function assertNoActions(root: HTMLElement, where: string) {
  for (const b of within(root).queryAllByRole("button")) {
    expect(b.textContent ?? "", `${where}: button "${b.textContent}"`).not.toMatch(ACTION);
    expect(b.getAttribute("aria-label") ?? "", where).not.toMatch(ACTION);
  }
  expect(
    root.querySelectorAll("form, textarea, input[type=checkbox], input[type=radio]"),
  ).toHaveLength(0);
}

describe("read-only screens have no write actions, sheets included", () => {
  it("Overview, its drill sheet and the item inside it", async () => {
    const r = row({ id: 11, invoiceNumber: "INV-11" });
    const calls = mockFetch({
      "GET /api/auth/me": () => ({ body: ADMIN }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/overview": () => ({ body: overview() }),
      "GET /api/invoices": () => ({ body: listResponse([r]) }),
      "GET /api/open-items/11": () => ({ body: detail(r) }),
    });
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("region", { name: "Receivables" });
    const main = screen.getByRole("main");
    assertNoActions(main, "overview");
    await user.click(
      within(main).getAllByRole("button", { name: /Show items|€/ })[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("button", { name: /Acme BV/ });
    assertNoActions(dialog, "drill list");
    await user.click(within(dialog).getByRole("button", { name: /Acme BV/ }));
    await within(dialog).findByText("Has VAT number");
    assertNoActions(dialog, "drill item");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  for (const [path, api, name, kind] of [
    ["/invoices", "/api/invoices", "INV-1", "invoice"],
    ["/purchases/payables", "/api/bills", "B-1", "bill"],
  ] as const) {
    it(`${path} and its item sheet`, async () => {
      const r = row({ id: 1, invoiceNumber: name, kind });
      const calls = mockFetch({
        "GET /api/auth/me": () => ({ body: ADMIN }),
        "GET /api/divisions": () => ({ body: ONE_DIVISION }),
        [`GET ${api}`]: () => ({ body: listResponse([r]) }),
        "GET /api/open-items/1": () => ({ body: detail(r) }),
      });
      const user = userEvent.setup();
      renderApp(path);
      await user.click(await screen.findByRole("button", { name }));
      const main = screen.getByRole("main");
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText("Has VAT number");
      assertNoActions(main, path);
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });
  }

  it("/purchases/approvals and its sheet", async () => {
    const calls = mockFetch({
      "GET /api/auth/me": () => ({ body: ADMIN }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/approvals": () => ({ body: approvals([approval()]) }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals");
    await user.click(await screen.findByRole("button", { name: "Entry 2001" }));
    const main = screen.getByRole("main");
    await screen.findByRole("dialog");
    assertNoActions(main, "approvals");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});
