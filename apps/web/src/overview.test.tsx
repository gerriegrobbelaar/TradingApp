import { norm } from "./test-norm";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";
import {
  DIV_REF,
  NEVER,
  ONE_DIVISION,
  STALE,
  TWO_DIVISIONS,
  detail,
  kpis,
  listResponse,
  overview,
  row,
} from "./test-fixtures";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const me = (m = VIEWER) => ({ "GET /api/auth/me": () => ({ body: m }) });
const divs = (body = ONE_DIVISION) => ({ "GET /api/divisions": () => ({ body }) });

describe("Overview", () => {
  it("leads with the number, per currency, and every figure is a button", async () => {
    const eur = kpis("/api/invoices", "EUR");
    const usd = kpis("/api/invoices", "USD", {
      total: { count: 2, minor: 50_000, dcMinor: 46_000, dcComplete: true },
    });
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => ({
        body: overview({ kpis: { receivable: [eur, usd], payable: [kpis("/api/bills")] } }),
      }),
    });
    const { container } = renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    const buttons = within(recv).getAllByRole("button");
    // 5 figures per currency, two currencies.
    expect(buttons).toHaveLength(10);
    const first = buttons[0] as HTMLElement;
    expect(norm(first.textContent)).toMatch(/^€ 12\.345,00Open receivables · 12 items/);
    expect(within(recv).getByRole("heading", { name: "USD", level: 3 })).toBeTruthy();
    // The foreign currency shows its division-currency amount without adding to the EUR line.
    expect(norm(recv.textContent)).toContain("$ 500,00");
    expect(norm(recv.textContent)).toContain("€ 460,00 in EUR");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows overdue figures in the warning colour and the average in days", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => ({ body: overview() }),
    });
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    expect(recv.querySelector(".kpi.bad")).not.toBeNull();
    expect(within(recv).getByRole("button", { name: /12 days/ })).toBeTruthy();
  });

  it("shows a dash for the average when nothing is overdue", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => ({
        body: overview({
          kpis: {
            receivable: [
              kpis("/api/invoices", "EUR", {
                avgDaysOverdue: null,
                overdue: { count: 0, minor: 0, dcMinor: 0, dcComplete: true },
              }),
            ],
            payable: [],
          },
        }),
      }),
    });
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    expect(recv.querySelector(".kpi.bad")).toBeNull();
    expect(within(recv).getByRole("button", { name: /^—/ })).toBeTruthy();
    expect(screen.getByText("0 open bills.")).toBeTruthy();
  });

  it("notes when some items have no amount in the division currency", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => ({
        body: overview({
          kpis: {
            receivable: [
              kpis("/api/invoices", "USD", {
                total: { count: 3, minor: 90_000, dcMinor: 40_000, dcComplete: false },
              }),
            ],
            payable: [],
          },
        }),
      }),
    });
    renderApp("/overview");
    await screen.findByRole("region", { name: "Receivables" });
    expect(screen.getByText("Some items have no amount in EUR yet.")).toBeTruthy();
    expect(norm(document.body.textContent)).toContain("At least € 400,00 in EUR");
  });

  it("opens the items behind a figure with the drilldown filters and the division", async () => {
    const calls = mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => ({ body: overview() }),
      "GET /api/invoices": () => ({
        body: listResponse([
          row({ id: 11, invoiceNumber: "INV-11" }),
          row({
            id: 12,
            invoiceNumber: "INV-12",
            openMinor: -5000,
            bucket: "not_due",
            daysOverdue: -3,
          }),
        ]),
      }),
    });
    const user = userEvent.setup();
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await user.click(within(recv).getByRole("button", { name: /^€.2\.500,00/ }));
    const dialog = await screen.findByRole("dialog", { name: "Overdue receivables (EUR)" });
    expect(await within(dialog).findByText("INV-11 · due 1 Oct 2026")).toBeTruthy();
    const call = calls.find((c) => c.url.startsWith("/api/invoices"));
    const url = new URL(call?.url ?? "", "http://x");
    expect(url.searchParams.get("figure")).toBe("overdue");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("currency")).toBe("EUR");
    expect(url.searchParams.get("division")).toBe("1");
    expect(url.searchParams.get("sort")).toBe("due");
    expect(within(dialog).getByText("€ 2.500,00 in 3 items")).toBeTruthy();
    // A credit row says so.
    expect(within(dialog).getByText("credit", { exact: false })).toBeTruthy();
  });

  it("opens an item inside the drill sheet, goes back, and keeps focus sensible", async () => {
    const r = row({ id: 11, invoiceNumber: "INV-11" });
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => ({ body: overview() }),
      "GET /api/invoices": () => ({ body: listResponse([r]) }),
      "GET /api/open-items/11": () => ({ body: detail(r) }),
    });
    const user = userEvent.setup();
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await user.click(within(recv).getAllByRole("button")[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: /Acme BV/ }));
    expect(await within(dialog).findByText("Has VAT number")).toBeTruthy();
    const back = within(dialog).getByRole("button", { name: "Back to list" });
    await waitFor(() => expect(document.activeElement).toBe(back));
    await user.click(back);
    expect(await within(dialog).findByRole("button", { name: /Acme BV/ })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    // Focus returns to the figure that opened the sheet.
    expect(document.activeElement).toBe(within(recv).getAllByRole("button")[0]);
  });

  it("pages the drill-down with Load more", async () => {
    let page = 0;
    const calls = mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => ({ body: overview() }),
      "GET /api/invoices": () => {
        page += 1;
        return {
          body:
            page === 1
              ? listResponse([row({ id: 1, invoiceNumber: "A-1" })], {
                  nextCursor: "c1",
                  total: 2,
                })
              : listResponse([row({ id: 2, invoiceNumber: "A-2" })], { total: 2 }),
        };
      },
    });
    const user = userEvent.setup();
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await user.click(within(recv).getAllByRole("button")[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("A-1 · due 1 Oct 2026");
    expect(within(dialog).getByText("Showing 1 of 2")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Load more" }));
    await within(dialog).findByText("A-2 · due 1 Oct 2026");
    expect(within(dialog).queryByRole("button", { name: "Load more" })).toBeNull();
    const second = calls.filter((c) => c.url.startsWith("/api/invoices"))[1];
    expect(new URL(second?.url ?? "", "http://x").searchParams.get("cursor")).toBe("c1");
  });

  it("shows an error in the drill sheet with a retry", async () => {
    let n = 0;
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => ({ body: overview() }),
      "GET /api/invoices": () => {
        n += 1;
        return n === 1
          ? { status: 500, body: { error: "boom" } }
          : { body: listResponse([row({ id: 1 })]) };
      },
    });
    const user = userEvent.setup();
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await user.click(within(recv).getAllByRole("button")[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Could not load");
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText(/INV-1001/)).toBeTruthy();
  });

  it("shows skeletons while loading, with a status for screen readers", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => ({ body: overview() }),
    });
    const real = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      String(url).startsWith("/api/overview")
        ? gate.then(() => real(url, init))
        : real(url, init)) as typeof fetch;
    renderApp("/overview");
    expect(
      (await screen.findByRole("status", { name: "Loading overview" })).querySelector(".sk"),
    ).not.toBeNull();
    release();
    await screen.findByRole("region", { name: "Receivables" });
    expect(screen.queryByRole("status", { name: "Loading overview" })).toBeNull();
  });

  it("shows an empty state with a link when nothing was synced", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => ({
        body: overview({ kpis: { receivable: [], payable: [] }, freshness: NEVER, stale: true }),
      }),
    });
    const { container } = renderApp("/overview");
    expect(await screen.findByText("No data yet.")).toBeTruthy();
    expect(screen.getByText(/Connect Exact and run a sync/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to connections" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    expect(screen.getByText("Never synced")).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows the same empty state when no administration exists", async () => {
    mockFetch({ ...me(), ...divs({ selectedId: null, divisions: [] }) });
    renderApp("/overview");
    expect(await screen.findByText("No data yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect Exact" })).toBeTruthy();
  });

  it("warns when the data is out of date and links admins to connections", async () => {
    mockFetch({
      ...me(ADMIN),
      ...divs(),
      "GET /api/overview": () => ({ body: overview({ freshness: STALE, stale: true }) }),
    });
    renderApp("/overview");
    expect(await screen.findByText("Out of date")).toBeTruthy();
    const status = screen.getByRole("status", { name: "" });
    expect(
      within(status).getByRole("link", { name: "Check connections" }).getAttribute("href"),
    ).toBe("/settings/connections");
  });

  it("does not link viewers to connections", async () => {
    mockFetch({
      ...me(VIEWER),
      ...divs(),
      "GET /api/overview": () => ({ body: overview({ freshness: STALE, stale: true }) }),
    });
    renderApp("/overview");
    await screen.findByText("Out of date");
    expect(screen.queryByRole("link", { name: "Check connections" })).toBeNull();
  });

  it("shows an error with a retry", async () => {
    let n = 0;
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/overview": () => {
        n += 1;
        return n === 1 ? { status: 503, body: { error: "x" } } : { body: overview() };
      },
    });
    const user = userEvent.setup();
    renderApp("/overview");
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load this data");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Receivables" })).toBeTruthy();
  });

  it("reloads for the other administration, with no flash of the old figures", async () => {
    const calls = mockFetch({
      ...me(),
      ...divs(TWO_DIVISIONS),
      "PUT /api/me/division": () => ({ body: { selectedId: 2 } }),
      "GET /api/overview": (c) =>
        new URL(c.url, "http://x").searchParams.get("division") === "2"
          ? {
              body: overview({
                division: { ...DIV_REF, id: 2, name: "Beta BV" },
                kpis: {
                  receivable: [
                    kpis("/api/invoices", "EUR", {
                      total: { count: 1, minor: 777, dcMinor: 777, dcComplete: true },
                    }),
                  ],
                  payable: [],
                },
              }),
            }
          : { body: overview() },
    });
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findAllByText(/12\.345,00/);
    await user.selectOptions(screen.getByLabelText("Administration"), "2");
    // The old figure is gone at once, the new one arrives.
    expect(screen.queryByText(/12\.345,00/)).toBeNull();
    expect(await screen.findByText(/7,77/)).toBeTruthy();
    const urls = calls.filter((c) => c.url.startsWith("/api/overview")).map((c) => c.url);
    expect(urls).toEqual(["/api/overview?division=1", "/api/overview?division=2"]);
  });

  it("closes an open drill sheet when the administration changes", async () => {
    mockFetch({
      ...me(),
      ...divs(TWO_DIVISIONS),
      "PUT /api/me/division": () => ({ body: { selectedId: 2 } }),
      "GET /api/overview": () => ({ body: overview() }),
      "GET /api/invoices": () => ({ body: listResponse([row()]) }),
    });
    const user = userEvent.setup();
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await user.click(within(recv).getAllByRole("button")[0] as HTMLElement);
    await screen.findByRole("dialog");
    // The select is behind the scrim for pointer users; keyboard and programmatic changes still happen.
    await user.selectOptions(screen.getByLabelText("Administration"), "2");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("has a sensible heading order and landmarks", async () => {
    mockFetch({ ...me(), ...divs(), "GET /api/overview": () => ({ body: overview() }) });
    renderApp("/overview");
    await screen.findByRole("region", { name: "Receivables" });
    const levels = screen.getAllByRole("heading").map((h) => Number(h.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
    }
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
  });

  it("is the landing page and Today stays reachable", async () => {
    mockFetch({ ...me(), ...divs(), "GET /api/overview": () => ({ body: overview() }) });
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
  });

  it("keeps Today reachable as a placeholder", async () => {
    mockFetch({ ...me(), ...divs() });
    renderApp("/today");
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeTruthy();
    expect(screen.getByText(/not built yet/)).toBeTruthy();
  });
});

describe("copy rules", () => {
  it("has no exclamation marks on the overview", async () => {
    mockFetch({ ...me(), ...divs(), "GET /api/overview": () => ({ body: overview() }) });
    renderApp("/overview");
    await screen.findByRole("region", { name: "Receivables" });
    expect(document.body.textContent).not.toContain("!");
  });
});
