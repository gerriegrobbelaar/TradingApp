/** Treasury, Bank (R3b): accounts, transactions, filters, sheet, states, read-only. */
import { norm } from "./test-norm";
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { MemoryRouter, useLocation } from "react-router";
import { AppShell } from "./App";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import { BANK_NEVER, BANK_STALE, account, accounts, tx, txDetail, txs } from "./test-fixtures-bank";
import { legNotes } from "./lib/bank";
import { amountWords, maskIban } from "./components/BankParts";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const params = (c: Call | undefined) => new URL(c?.url ?? "", "http://x").searchParams;
const txCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith("/api/bank/transactions"));

function base(over: Record<string, (c: Call) => { status?: number; body?: unknown }> = {}) {
  return {
    "GET /api/auth/me": () => ({ body: ADMIN }),
    "GET /api/bank/accounts": () => ({ body: accounts() }),
    "GET /api/bank/transactions": () => ({ body: txs([tx()]) }),
    ...over,
  };
}
async function table() {
  const t = await screen.findByRole("table", { name: "Transactions" });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  return t;
}
function renderWithLocation(path: string) {
  const loc = { search: "" };
  function Probe() {
    loc.search = useLocation().search;
    return null;
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
      <Probe />
    </MemoryRouter>,
  );
  return loc;
}

describe("Bank: populated", () => {
  it("shows account cards, per-currency totals and masked IBANs", async () => {
    mockFetch(base());
    const { container } = renderApp("/treasury/bank");
    expect(await screen.findByRole("heading", { level: 1, name: "Bank" })).toBeTruthy();
    const list = await screen.findByRole("list", { name: "Accounts" });
    const main = within(list).getByRole("button", { name: /Main EUR/ });
    expect(norm(main.textContent)).toContain("€ 12.345,67");
    expect(main.textContent).toContain("•••• 1234");
    expect(main.textContent).toContain("Balance as of");
    const gbp = within(list).getByRole("button", { name: /Sterling/ });
    expect(norm(gbp.textContent)).toContain("£ 500,25");
    expect(gbp.textContent).toContain("•••• 5678");
    const off = within(list).getByRole("button", { name: /Old USD/ });
    expect(off.textContent).toContain("Inactive");
    expect(off.className).toContain("off");
    const totals = screen.getByRole("region", { name: "Balance by currency" });
    expect(norm(totals.textContent)).toContain("€ 12.345,67 EUR across 1 active account");
    expect(totals.textContent).toContain("never added together");
    await table();
    expect(screen.getByRole("main").textContent).not.toContain("!");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("formats JPY and KWD at their real scale", async () => {
    mockFetch(
      base({
        "GET /api/bank/accounts": () => ({
          body: accounts([
            account({ id: 1, name: "Yen", currency: "JPY", balanceMinor: 12345 }),
            account({ id: 2, name: "Dinar", currency: "KWD", balanceMinor: 12345 }),
          ]),
        }),
        "GET /api/bank/transactions": () => ({
          body: txs([tx({ id: 5, currency: "JPY", amountMinor: 5000 })]),
        }),
      }),
    );
    renderApp("/treasury/bank");
    const list = await screen.findByRole("list", { name: "Accounts" });
    expect(norm(within(list).getByRole("button", { name: /Yen/ }).textContent)).toMatch(
      /12\.345(?!,)/,
    );
    expect(norm(within(list).getByRole("button", { name: /Dinar/ }).textContent)).toContain(
      "12,345",
    );
    const t = await table();
    expect(norm(t.textContent)).toMatch(/\+.*5\.000(?!,)/);
  });

  it("words received and paid for screen readers and never relies on colour", async () => {
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({
          body: txs([
            tx({ id: 1, amountMinor: 250000, counterpartyName: "Client BV" }),
            tx({ id: 2, amountMinor: -12345, counterpartyName: "Paper Co" }),
          ]),
        }),
      }),
    );
    renderApp("/treasury/bank");
    const t = await table();
    const rows = within(t).getAllByRole("row");
    const inRow = rows.find((r) => r.textContent?.includes("Client BV")) as HTMLElement;
    const outRow = rows.find((r) => r.textContent?.includes("Paper Co")) as HTMLElement;
    expect(norm(inRow.textContent)).toContain("Received +€ 2.500,00");
    expect(norm(outRow.textContent)).toContain("Paid \u2212€ 123,45");
    expect(inRow.textContent).not.toMatch(/credit/i);
    expect(outRow.textContent).not.toMatch(/credit/i);
  });

  it("shows every state chip, with pending not final and unknown never completed", async () => {
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({
          body: txs([
            tx({ id: 1, state: "completed", counterpartyName: "A" }),
            tx({
              id: 2,
              state: "pending",
              isFinal: false,
              counterpartyName: "B",
              completedAt: null,
            }),
            tx({ id: 3, state: "declined", counterpartyName: "C" }),
            tx({ id: 4, state: "failed", counterpartyName: "D" }),
            tx({ id: 5, state: "reverted", counterpartyName: "E" }),
            tx({ id: 6, state: "unknown", isFinal: false, counterpartyName: "F" }),
            // a state the server invents later must not become "Completed"
            tx({ id: 7, state: "settled" as never, isFinal: false, counterpartyName: "G" }),
          ]),
        }),
      }),
    );
    renderApp("/treasury/bank");
    const t = await table();
    const rowOf = (n: string) =>
      within(t)
        .getAllByRole("row")
        .find((r) => within(r).queryByRole("button", { name: n })) as HTMLElement;
    expect(rowOf("A").textContent).toContain("Completed");
    expect(rowOf("A").textContent).not.toContain("Not final");
    expect(rowOf("B").textContent).toContain("Pending");
    expect(rowOf("B").textContent).toContain("Not final — not used for matching");
    expect(rowOf("C").textContent).toContain("Declined");
    expect(rowOf("D").textContent).toContain("Failed");
    expect(rowOf("E").textContent).toContain("Reverted");
    for (const n of ["F", "G"]) {
      expect(rowOf(n).textContent).toContain("Unknown");
      expect(rowOf(n).textContent).not.toContain("Completed");
      expect(rowOf(n).textContent).toContain("not used for matching");
    }
  });

  it("pending-only list has no axe violations", async () => {
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({
          body: txs([tx({ state: "pending", isFinal: false, completedAt: null })]),
        }),
      }),
    );
    const { container } = renderApp("/treasury/bank");
    await table();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("totals footer comes from the server per currency, received and paid", async () => {
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({
          body: txs([tx({ id: 1 })], {
            total: 30,
            totalsByCurrency: [
              { currency: "EUR", inMinor: 100000, outMinor: 40000, count: 20 },
              { currency: "GBP", inMinor: 0, outMinor: 2500, count: 10 },
            ],
          }),
        }),
      }),
    );
    renderApp("/treasury/bank");
    const t = await table();
    const foot = t.querySelectorAll("tfoot tr");
    expect(foot).toHaveLength(3);
    expect(norm(foot[0]?.textContent)).toContain(
      "EUR, pending and completed: 20 transactions for these filters",
    );
    expect(norm(foot[0]?.textContent)).toContain("In +€ 1.000,00");
    expect(norm(foot[0]?.textContent)).toContain("Out \u2212€ 400,00");
    expect(norm(foot[1]?.textContent)).toContain(
      "GBP, pending and completed: 10 transactions for these filters",
    );
    expect(norm(foot[1]?.textContent)).toContain("Out \u2212£ 25,00");
    expect(foot[2]?.textContent).toContain(
      "Declined, failed and reverted ones are listed but not counted",
    );
    // the totals never claim money was received or paid: they include pending rows
    expect(t.querySelector("tfoot")?.textContent).not.toMatch(/received|paid/i);
  });
});

describe("Bank: filters and the address", () => {
  it("sends the filters from the address as request parameters", async () => {
    const calls = mockFetch(base());
    renderApp("/treasury/bank?account=2&state=pending&direction=out&from=2026-11-01&to=2026-11-10");
    await table();
    const p = params(txCalls(calls)[0]);
    expect(p.get("account")).toBe("2");
    expect(p.get("state")).toBe("pending");
    expect(p.get("direction")).toBe("out");
    expect(p.get("from")).toBe("2026-11-01");
    expect(p.get("to")).toBe("2026-11-10");
    expect(p.get("limit")).toBe("50");
    expect(p.get("q")).toBeNull();
  });

  it("omits 'all' and writes changes to the address, but keeps the search text out of it", async () => {
    const calls = mockFetch(base());
    const user = userEvent.setup();
    const loc = renderWithLocation("/treasury/bank");
    await table();
    expect(params(txCalls(calls)[0]).has("state")).toBe(false);
    expect(params(txCalls(calls)[0]).has("direction")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Pending" }));
    await user.click(screen.getByRole("button", { name: "Money in" }));
    await user.click(await screen.findByRole("button", { name: /Main EUR/ }));
    await waitFor(() => {
      const last = params(txCalls(calls).at(-1));
      expect(last.get("state")).toBe("pending");
      expect(last.get("direction")).toBe("in");
      expect(last.get("account")).toBe("1");
    });
    await user.type(screen.getByRole("searchbox", { name: "Search transactions" }), "paper");
    await waitFor(() => expect(params(txCalls(calls).at(-1)).get("q")).toBe("paper"));
    const s = new URLSearchParams(loc.search);
    expect(s.get("state")).toBe("pending");
    expect(s.get("direction")).toBe("in");
    expect(s.get("account")).toBe("1");
    expect(s.has("q")).toBe(false);
  });

  it("clicking the selected account card again clears the account filter", async () => {
    const calls = mockFetch(base());
    const user = userEvent.setup();
    renderApp("/treasury/bank?account=1");
    await table();
    const card = await screen.findByRole("button", { name: /Main EUR/ });
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Account: Main EUR")).toBeTruthy();
    await user.click(card);
    await waitFor(() => expect(params(txCalls(calls).at(-1)).has("account")).toBe(false));
    expect(card.getAttribute("aria-pressed")).toBe("false");
  });

  it("drops invalid parameters from the address instead of sending them", async () => {
    const calls = mockFetch(base());
    const loc = renderWithLocation(
      "/treasury/bank?account=abc&state=bogus&direction=sideways&from=2026-02-31&to=nope&q=secret",
    );
    await table();
    for (const c of txCalls(calls)) {
      const p = params(c);
      for (const k of ["account", "state", "direction", "from", "to"]) expect(p.has(k)).toBe(false);
    }
    expect(loc.search).toBe("");
  });

  it("explains an inverted date range and does not request it", async () => {
    const calls = mockFetch(base());
    renderApp("/treasury/bank?from=2026-11-10&to=2026-11-01");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "from date is after the to date",
    );
    await screen.findByRole("list", { name: "Accounts" });
    expect(txCalls(calls)).toHaveLength(0);
    for (const input of screen.getAllByLabelText(/^(From|To)$/)) {
      expect(input.getAttribute("aria-invalid")).toBe("true");
    }
  });

  it("date inputs are native date fields that write the address", async () => {
    const calls = mockFetch(base());
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    await table();
    const from = screen.getByLabelText("From") as HTMLInputElement;
    expect(from.type).toBe("date");
    await user.type(from, "2026-11-03");
    await waitFor(() => expect(params(txCalls(calls).at(-1)).get("from")).toBe("2026-11-03"));
  });

  it("filtered empty list says so and offers no write action", async () => {
    mockFetch(base({ "GET /api/bank/transactions": () => ({ body: txs([]) }) }));
    renderApp("/treasury/bank?state=failed");
    expect(await screen.findByText("No transactions match these filters.")).toBeTruthy();
  });
});

describe("Bank: paging and requests", () => {
  it("loads the next page with the cursor and appends", async () => {
    const calls = mockFetch(
      base({
        "GET /api/bank/transactions": (c) =>
          params(c).get("cursor") === "c2"
            ? { body: txs([tx({ id: 2, counterpartyName: "Second" })]) }
            : {
                body: txs([tx({ id: 1, counterpartyName: "First" })], {
                  nextCursor: "c2",
                  total: 2,
                }),
              },
      }),
    );
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    await table();
    expect(screen.getByText("Showing 1 of 2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: "Second" });
    expect(screen.getByRole("button", { name: "First" })).toBeTruthy();
    expect(screen.getByText("Showing 2 of 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(params(txCalls(calls).at(-1)).get("cursor")).toBe("c2");
  });

  it("aborts requests that are in flight when the page is left", async () => {
    const calls = mockFetch(base());
    const view = renderApp("/treasury/bank");
    await table();
    view.unmount();
    for (const c of calls.filter((x) => x.url.startsWith("/api/bank/accounts"))) {
      expect(c.signal?.aborted).toBe(true);
    }
    for (const c of txCalls(calls)) expect(c.signal?.aborted).toBe(true);
  });

  it("aborts the previous list request when a filter changes", async () => {
    const calls = mockFetch(base());
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    await table();
    const first = txCalls(calls)[0];
    await user.click(screen.getByRole("button", { name: "Completed" }));
    await waitFor(() => expect(txCalls(calls).length).toBeGreaterThan(1));
    expect(first?.signal?.aborted).toBe(true);
  });

  it("refreshes on focus", async () => {
    const calls = mockFetch(base());
    renderApp("/treasury/bank");
    await table();
    const before = calls.filter((c) => c.url.startsWith("/api/bank/accounts")).length;
    // the refresh de-duplicates triggers within 30 seconds of mount, so move the clock
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() =>
        expect(calls.filter((c) => c.url.startsWith("/api/bank/accounts")).length).toBeGreaterThan(
          before,
        ),
      );
    } finally {
      Date.now = realNow;
    }
  });
});

describe("Bank: empty, error and stale states", () => {
  it("not connected: tells an admin where to connect and sends no list request", async () => {
    const calls = mockFetch(
      base({
        "GET /api/bank/accounts": () => ({
          body: accounts([], { connection: null, available: false, freshness: BANK_NEVER }),
        }),
      }),
    );
    const { container } = renderApp("/treasury/bank");
    expect(await screen.findByText("Revolut is not connected.")).toBeTruthy();
    expect(screen.getByText(/Connect Revolut in Settings → Connections/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect Revolut" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    expect(screen.queryByText("Never synced")).toBeNull();
    expect(txCalls(calls)).toHaveLength(0);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("not connected: a non-admin gets the same words without a link", async () => {
    mockFetch(
      base({
        "GET /api/auth/me": () => ({ body: VIEWER }),
        "GET /api/bank/accounts": () => ({
          body: accounts([], { connection: null, available: false, freshness: BANK_NEVER }),
        }),
      }),
    );
    renderApp("/treasury/bank");
    await screen.findByText("Revolut is not connected.");
    expect(screen.queryByRole("link", { name: "Connect Revolut" })).toBeNull();
    expect(screen.getByText(/Ask an administrator/)).toBeTruthy();
  });

  it("connected but waiting for the first sync", async () => {
    const calls = mockFetch(
      base({
        "GET /api/bank/accounts": () => ({
          body: accounts([], { available: false, freshness: BANK_NEVER }),
        }),
      }),
    );
    const { container } = renderApp("/treasury/bank");
    expect(await screen.findByText("Waiting for the first sync.")).toBeTruthy();
    expect(screen.getByText(/first complete run of the Revolut sync job/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open schedules" }).getAttribute("href")).toBe(
      "/settings/schedules",
    );
    expect(screen.getByText("Never synced")).toBeTruthy();
    expect(screen.queryByText(/Updated/)).toBeNull();
    expect(txCalls(calls)).toHaveLength(0);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("connected, synced, no accounts", async () => {
    mockFetch(base({ "GET /api/bank/accounts": () => ({ body: accounts([]) }) }));
    renderApp("/treasury/bank");
    expect(await screen.findByText("No bank accounts found.")).toBeTruthy();
  });

  it("fresh data shows 'Updated x ago'; stale data is a separate, truthful state", async () => {
    mockFetch(base());
    const fresh = renderApp("/treasury/bank");
    expect(await screen.findByText(/^Updated /)).toBeTruthy();
    expect(screen.queryByText("Out of date")).toBeNull();
    fresh.unmount();

    mockFetch(
      base({
        "GET /api/bank/accounts": () => ({ body: accounts(undefined, { freshness: BANK_STALE }) }),
      }),
    );
    const { container } = renderApp("/treasury/bank");
    expect(await screen.findByText("Out of date")).toBeTruthy();
    expect(screen.getByText(/more than 2 hours ago/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Check connections" })).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("an account error has its own message and a working retry", async () => {
    let n = 0;
    mockFetch(
      base({
        "GET /api/bank/accounts": () =>
          ++n === 1 ? { status: 500, body: { error: "boom" } } : { body: accounts() },
      }),
    );
    const user = userEvent.setup();
    const { container } = renderApp("/treasury/bank");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load this data. Try again.");
    expect(await axe(container)).toHaveNoViolations();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Accounts" })).toBeTruthy();
  });

  it("a transactions error keeps the accounts and retries", async () => {
    let n = 0;
    mockFetch(
      base({
        "GET /api/bank/transactions": () =>
          ++n === 1 ? { status: 500, body: { error: "boom" } } : { body: txs([tx()]) },
      }),
    );
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("list", { name: "Accounts" })).toBeTruthy();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Paper Co" })).toBeTruthy();
  });

  it("403 says access is missing", async () => {
    mockFetch(
      base({
        "GET /api/bank/accounts": () => ({ status: 403, body: { error: "forbidden_role" } }),
      }),
    );
    renderApp("/treasury/bank");
    expect((await screen.findByRole("alert")).textContent).toContain("do not have access");
  });

  it("401 ends up on the signed-out screen, not a broken page", async () => {
    mockFetch(
      base({
        "GET /api/bank/accounts": () => ({ status: 401, body: { error: "unauthenticated" } }),
      }),
    );
    renderApp("/treasury/bank");
    await waitFor(() => expect(screen.queryByRole("list", { name: "Accounts" })).toBeNull());
    expect(await screen.findByRole("link", { name: /sign in/i })).toBeTruthy();
  });

  it("a connection that needs attention is flagged above the cards", async () => {
    mockFetch(
      base({
        "GET /api/bank/accounts": () => ({
          body: accounts(undefined, {
            connection: {
              id: 1,
              status: "needs_reauth",
              createsBankEntries: false,
              paymentsMode: "drafts",
            },
          }),
        }),
      }),
    );
    renderApp("/treasury/bank");
    expect(await screen.findByText(/connection needs to be renewed/)).toBeTruthy();
    expect(screen.getByText(/from the last sync and may be out of date/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Accounts" })).toBeTruthy();
  });

  it("a staged (pending) connection that was never read asks for confirmation, not a sync", async () => {
    const calls = mockFetch(
      base({
        "GET /api/bank/accounts": () => ({
          body: accounts([], {
            connection: {
              id: 1,
              status: "pending",
              createsBankEntries: null,
              paymentsMode: "drafts",
            },
            available: false,
            freshness: BANK_NEVER,
          }),
        }),
      }),
    );
    renderApp("/treasury/bank");
    expect(
      await screen.findByText("The Revolut connection is waiting for confirmation."),
    ).toBeTruthy();
    expect(screen.queryByText("Waiting for the first sync.")).toBeNull();
    expect(screen.getByRole("link", { name: "Open connections" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    expect(txCalls(calls)).toHaveLength(0);
  });

  for (const [status, words] of [
    ["needs_reauth", "needs to be renewed"],
    ["expired", "needs to be renewed"],
    ["disabled", "is switched off"],
    ["weird", "is not active"],
  ] as const) {
    it(`never-read ${status} connection: its own words, no link for a viewer`, async () => {
      mockFetch(
        base({
          "GET /api/auth/me": () => ({ body: VIEWER }),
          "GET /api/bank/accounts": () => ({
            body: accounts([], {
              connection: { id: 1, status, createsBankEntries: false, paymentsMode: "drafts" },
              available: false,
              freshness: BANK_NEVER,
            }),
          }),
        }),
      );
      renderApp("/treasury/bank");
      expect(await screen.findByText(new RegExp(`connection ${words}`))).toBeTruthy();
      expect(screen.queryByText("Waiting for the first sync.")).toBeNull();
      expect(screen.queryByRole("link", { name: /connections|schedules/i })).toBeNull();
    });
  }

  it("waiting for the first sync: a viewer gets the words without the schedules link", async () => {
    mockFetch(
      base({
        "GET /api/auth/me": () => ({ body: VIEWER }),
        "GET /api/bank/accounts": () => ({
          body: accounts([], { available: false, freshness: BANK_NEVER }),
        }),
      }),
    );
    renderApp("/treasury/bank");
    expect(await screen.findByText("Waiting for the first sync.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open schedules" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Check connections" })).toBeNull();
  });
});

describe("Bank: multi-leg and the transaction sheet", () => {
  const legA = tx({
    id: 10,
    externalId: "x1",
    legId: "l1",
    amountMinor: -50000,
    counterpartyName: "Own GBP",
  });
  const legB = tx({
    id: 11,
    externalId: "x1",
    legId: "l2",
    amountMinor: 43000,
    currency: "GBP",
    accountId: 2,
    accountName: "Sterling",
    counterpartyName: "Own EUR",
  });

  it("legNotes counts loaded legs per transaction id, as a lower bound unless complete", () => {
    const rows = [legA, tx({ id: 12, externalId: "solo" }), legB];
    expect(legNotes(rows, true).get(10)).toEqual({ count: 2, atLeast: false });
    expect(legNotes(rows, true).get(11)).toEqual({ count: 2, atLeast: false });
    expect(legNotes(rows, true).has(12)).toBe(false);
    expect(legNotes(rows, false).get(10)).toEqual({ count: 2, atLeast: true });
  });

  it("legNotes prefers the server's legCount, also for a leg whose sibling is not loaded", () => {
    const n = legNotes(
      [
        { ...legA, legCount: 3 },
        tx({ id: 12, externalId: "solo", legCount: 1 }),
        tx({ id: 13, externalId: "bad", legCount: -2 }),
      ],
      false,
    );
    expect(n.get(10)).toEqual({ count: 3, atLeast: false });
    expect(n.has(12)).toBe(false);
    expect(n.has(13)).toBe(false);
  });

  it("shows each leg as its own row with a leg note", async () => {
    mockFetch(base({ "GET /api/bank/transactions": () => ({ body: txs([legA, legB]) }) }));
    renderApp("/treasury/bank");
    const t = await table();
    expect(within(t).getAllByText("One of 2 legs, see details")).toHaveLength(2);
    expect(t.textContent).not.toMatch(/Leg \d of/);
  });

  it("a filtered or partial list says 'at least' for legs counted from loaded rows", async () => {
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({ body: txs([legA, legB], { nextCursor: "c2" }) }),
      }),
    );
    renderApp("/treasury/bank");
    const t = await table();
    expect(within(t).getAllByText("One of at least 2 legs, see details")).toHaveLength(2);
  });

  it("an account filter that hides the other leg still shows the server's leg count", async () => {
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({ body: txs([{ ...legA, legCount: 2 }]) }),
      }),
    );
    renderApp("/treasury/bank?account=1");
    const t = await table();
    expect(within(t).getByText("One of 2 legs, see details")).toBeTruthy();
  });

  it("opens the sheet with all fields, the legs, a masked IBAN and plain-word source", async () => {
    const full = "NL91ABNA0417164300";
    const calls = mockFetch(
      base({
        "GET /api/bank/transactions": () => ({ body: txs([legA, legB]) }),
        "GET /api/bank/transactions/10": () => ({
          body: txDetail(
            { ...legA, counterpartyIbanMasked: full, reference: "Ref 99" },
            { legs: [legA, legB], source: "backfill" },
          ),
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    await table();
    await user.click(screen.getByRole("button", { name: "Own GBP" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Nightly catch-up");
    const text = norm(dialog.textContent);
    expect(text).toContain("Ref 99");
    expect(text).toContain("•••• 4300");
    expect(text).not.toContain(full);
    expect(text).not.toContain("NL91");
    expect(text).toContain("2 legs");
    expect(text).toContain("1 of 2 (this one)");
    expect(text).toContain("2 of 2");
    expect(text).toContain("First seen");
    expect(text).toContain("Last update from Revolut");
    expect(text).toContain("Completed, final");
    expect(document.body.textContent).not.toContain(full);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(await axe(dialog)).toHaveNoViolations();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sheet for a pending transaction says it is not final", async () => {
    const p = tx({ id: 20, state: "pending", isFinal: false, completedAt: null });
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({ body: txs([p]) }),
        "GET /api/bank/transactions/20": () => ({ body: txDetail(p, { source: "poll" }) }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    await table();
    await user.click(screen.getByRole("button", { name: "Paper Co" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Regular sync");
    expect(within(dialog).getByRole("status").textContent).toContain(
      "Not final — not used for matching",
    );
    expect(dialog.textContent).toContain("Pending, not final");
  });

  it("sheet error offers a retry", async () => {
    let n = 0;
    mockFetch(
      base({
        "GET /api/bank/transactions/1": () =>
          ++n === 1 ? { status: 500, body: { error: "x" } } : { body: txDetail(tx()) },
      }),
    );
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    await table();
    await user.click(screen.getByRole("button", { name: "Paper Co" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText(/Revolut notified us/)).toBeTruthy();
  });

  it("J and K move between rows, Enter opens, and typing in search does not", async () => {
    const calls = mockFetch(
      base({
        "GET /api/bank/transactions": () => ({
          body: txs([
            tx({ id: 1, counterpartyName: "One" }),
            tx({ id: 2, counterpartyName: "Two" }),
          ]),
        }),
        "GET /api/bank/transactions/2": () => ({
          body: txDetail(tx({ id: 2, counterpartyName: "Two" })),
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    await table();
    await user.keyboard("j");
    expect(document.activeElement?.textContent).toBe("One");
    await user.keyboard("j");
    expect(document.activeElement?.textContent).toBe("Two");
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await waitFor(() => expect(calls.some((c) => c.url === "/api/bank/transactions/2")).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const box = screen.getByRole("searchbox", { name: "Search transactions" });
    await user.click(box);
    await user.keyboard("jk");
    expect(document.activeElement).toBe(box);
    expect((box as HTMLInputElement).value).toBe("jk");
  });
});

describe("Bank: helpers", () => {
  it("masks anything to the last four characters", () => {
    expect(maskIban("NL91ABNA0417164300")).toBe("•••• 4300");
    expect(maskIban("NL••••••••••1234")).toBe("•••• 1234");
    expect(maskIban("NL91****4300")).toBe("•••• 4300"); // core maskIban, what R3a sends
    expect(maskIban("****")).toBe("••••");
    expect(maskIban("nl91 abna 0417 1643 0x")).toBe("•••• 430X");
    expect(maskIban("  ")).toBeNull();
    expect(maskIban("")).toBeNull();
    expect(maskIban(undefined)).toBeNull();
    expect(maskIban("12")).toBe("•••• 12");
    expect(maskIban("acct 12345678 / ref")).toBe("•••• 8REF");
    expect(maskIban("••")).toBe("••••");
  });

  it("amount words: only completed is received or paid; a negative amount is never received", () => {
    const states = ["completed", "pending", "declined", "failed", "reverted", "unknown", "x"];
    for (const st of states) {
      expect(amountWords(-1, st)).not.toMatch(/received|incoming/i);
      expect(amountWords(1, st)).not.toMatch(/paid|outgoing/i);
      if (st !== "completed") {
        expect(amountWords(-1, st)).not.toMatch(/paid/i);
        expect(amountWords(1, st)).not.toMatch(/received/i);
      }
    }
    expect(amountWords(-1, "completed")).toBe("Paid");
    expect(amountWords(1, "completed")).toBe("Received");
    expect(amountWords(1, "pending")).toBe("Incoming, not final");
    expect(amountWords(-1, "declined")).toBe("Outgoing, did not go through");
  });
});

describe("Bank: review R3b, money, states, PII and dates", () => {
  const rowOf = (t: HTMLElement, n: string) =>
    within(t)
      .getAllByRole("row")
      .find((r) => within(r).queryByRole("button", { name: n })) as HTMLElement;

  it("a negative amount never renders as received, in any state; only completed is received or paid", async () => {
    const states = ["completed", "pending", "declined", "failed", "reverted", "unknown"] as const;
    const rows = states.flatMap((st, i) => [
      tx({
        id: i * 2 + 1,
        state: st,
        isFinal: st !== "pending" && st !== "unknown",
        amountMinor: -500,
        counterpartyName: `out-${st}`,
      }),
      tx({
        id: i * 2 + 2,
        state: st,
        isFinal: st !== "pending" && st !== "unknown",
        amountMinor: 500,
        counterpartyName: `in-${st}`,
      }),
    ]);
    mockFetch(base({ "GET /api/bank/transactions": () => ({ body: txs(rows) }) }));
    renderApp("/treasury/bank");
    const t = await table();
    for (const st of states) {
      const out = norm(rowOf(t, `out-${st}`).textContent);
      const inn = norm(rowOf(t, `in-${st}`).textContent);
      expect(out).not.toMatch(/received|incoming/i);
      expect(out).toContain("\u2212€ 5,00");
      expect(inn).not.toMatch(/paid|outgoing/i);
      expect(inn).toContain("+€ 5,00");
      if (st !== "completed") {
        expect(out).not.toMatch(/paid/i);
        expect(inn).not.toMatch(/received/i);
      }
    }
    expect(norm(rowOf(t, "in-pending").textContent)).toContain("Incoming, not final +€ 5,00");
    expect(norm(rowOf(t, "out-declined").textContent)).toContain("Did not go through");
    expect(norm(rowOf(t, "in-reverted").textContent)).toContain("Reversed by Revolut");
    // colour: only completed money in is green; the void states are muted
    expect(rowOf(t, "in-completed").querySelector(".tx-in")).toBeTruthy();
    expect(rowOf(t, "in-pending").querySelector(".tx-in")).toBeNull();
    expect(rowOf(t, "in-failed").querySelector(".tx-void")).toBeTruthy();
  });

  it("zero, the largest safe amount and an unsafe one", async () => {
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({
          body: txs([
            tx({ id: 1, amountMinor: 0, counterpartyName: "Zero" }),
            tx({ id: 2, amountMinor: -Number.MAX_SAFE_INTEGER, counterpartyName: "Huge" }),
            tx({ id: 3, amountMinor: 2 ** 60, counterpartyName: "Unsafe" }),
            tx({ id: 4, amountMinor: -1234, currency: "KWD", counterpartyName: "Dinar" }),
          ]),
        }),
      }),
    );
    renderApp("/treasury/bank");
    const t = await table();
    const zero = norm(rowOf(t, "Zero").textContent);
    expect(zero).toContain("€ 0,00");
    expect(zero).not.toMatch(/[+\u2212]€|received|paid/i);
    expect(norm(rowOf(t, "Huge").textContent)).toContain("\u2212€ 90.071.992.547.409,91");
    expect(rowOf(t, "Unsafe").textContent).toContain("—");
    expect(rowOf(t, "Unsafe").textContent).not.toMatch(/received/i);
    expect(norm(rowOf(t, "Dinar").textContent)).toContain("Paid \u2212KWD 1,234");
    expect(t.textContent).not.toMatch(/legs/);
  });

  it("the date column is the Amsterdam creation day (what From / To filter on), across DST", async () => {
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({
          body: txs([
            // 00:30 in Amsterdam on 1 Nov (CET); completed two days later
            tx({
              id: 1,
              createdAt: "2026-10-31T23:30:00.000Z",
              completedAt: "2026-11-02T10:00:00.000Z",
              counterpartyName: "Midnight",
            }),
            // 00:30 CEST on 25 Oct, the night summer time ends
            tx({ id: 2, createdAt: "2026-10-24T22:30:00.000Z", counterpartyName: "Dst end" }),
            // 00:30 CET on 29 Mar, the night summer time starts
            tx({ id: 3, createdAt: "2026-03-28T23:30:00.000Z", counterpartyName: "Dst start" }),
          ]),
        }),
      }),
    );
    renderApp("/treasury/bank");
    const t = await table();
    expect(rowOf(t, "Midnight").textContent).toContain("1 Nov 2026");
    expect(rowOf(t, "Midnight").textContent).not.toContain("2 Nov 2026");
    expect(rowOf(t, "Dst end").textContent).toContain("25 Oct 2026");
    expect(rowOf(t, "Dst start").textContent).toContain("29 Mar 2026");
  });

  it("drops dates far in the past or future and bounds the date pickers", async () => {
    const calls = mockFetch(base());
    const loc = renderWithLocation("/treasury/bank?from=1899-12-31&to=2300-01-01");
    await table();
    for (const c of txCalls(calls)) {
      expect(params(c).has("from")).toBe(false);
      expect(params(c).has("to")).toBe(false);
    }
    expect(loc.search).toBe("");
    const from = screen.getByLabelText("From") as HTMLInputElement;
    expect(from.min).toBe("2000-01-01");
    expect(from.max).toBe("2099-12-31");
  });

  it("a full IBAN from the server never reaches text, attributes, storage or the address", async () => {
    const full = "NL91ABNA0417164300";
    const spaced = "nl91 abna 0417 1643 00";
    sessionStorage.clear();
    localStorage.clear();
    mockFetch(
      base({
        "GET /api/bank/accounts": () => ({
          body: accounts([account({ ibanMasked: full }), account({ id: 2, ibanMasked: spaced })]),
        }),
        "GET /api/bank/transactions": () => ({
          body: txs([tx({ counterpartyIbanMasked: full })]),
        }),
        "GET /api/bank/transactions/1": () => ({
          body: txDetail(tx({ counterpartyIbanMasked: spaced }), {
            legs: [tx({ counterpartyIbanMasked: full })],
          }),
        }),
      }),
    );
    const user = userEvent.setup();
    const loc = renderWithLocation("/treasury/bank");
    await table();
    await user.click(screen.getByRole("button", { name: "Paper Co" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/Revolut notified us/);
    const html = document.documentElement.outerHTML.replace(/\s+/g, "").toUpperCase();
    expect(html).not.toContain(full);
    expect(html).not.toContain("ABNA0417");
    expect(html).not.toContain("NL91");
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/ABNA|0417/i);
    expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/ABNA|0417/i);
    expect(loc.search).not.toMatch(/ABNA|0417/i);
    expect(JSON.stringify(window.history.state ?? null)).not.toMatch(/ABNA|0417/i);
    expect(dialog.textContent).toContain("4300");
  });

  it("counterparty names are text, not markup", async () => {
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({
          body: txs([tx({ counterpartyName: '<img src=x onerror="alert(1)">Evil' })]),
        }),
      }),
    );
    renderApp("/treasury/bank");
    const t = await table();
    expect(t.querySelector("img")).toBeNull();
    expect(t.textContent).toContain('<img src=x onerror="alert(1)">Evil');
  });

  it("a failed-only filter has no totals and says why", async () => {
    mockFetch(
      base({
        "GET /api/bank/transactions": () => ({
          body: txs([tx({ state: "failed" })], { totalsByCurrency: [] }),
        }),
      }),
    );
    renderApp("/treasury/bank?state=failed");
    const t = await table();
    expect(t.querySelector("tfoot")?.textContent).toContain(
      "No pending or completed transactions for these filters",
    );
  });

  it("a quiet refresh while the sheet is open keeps the sheet and its focus", async () => {
    const calls = mockFetch(
      base({ "GET /api/bank/transactions/1": () => ({ body: txDetail(tx()) }) }),
    );
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    await table();
    await user.click(screen.getByRole("button", { name: "Paper Co" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/Revolut notified us/);
    const focused = document.activeElement;
    const count = () => calls.filter((c) => c.url.startsWith("/api/bank/accounts")).length;
    const before = count();
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(count()).toBeGreaterThan(before));
    } finally {
      Date.now = realNow;
    }
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByText(/Revolut notified us/)).toBeTruthy();
    expect(document.activeElement).toBe(focused);
  });
});

describe("Bank: read-only, sheet included", () => {
  const ACTION =
    /\b(pay|approve|reject|match|book|send|remind|resend|lock|delete|remove|edit|save|submit|sync now|create|bank entry)\b/i;
  function assertNoActions(root: HTMLElement, where: string) {
    for (const b of within(root).queryAllByRole("button")) {
      const name = `${b.textContent ?? ""} ${b.getAttribute("aria-label") ?? ""}`;
      // The filter toggle "Paid" (direction) and the account cards are filters, not actions.
      if (b.closest(".seg") || b.classList.contains("acct")) continue;
      expect(name, `${where}: button "${name}"`).not.toMatch(ACTION);
    }
    expect(
      root.querySelectorAll(
        "form, textarea, select, input[type=checkbox], input[type=radio], input[type=submit], button[type=submit], [contenteditable=true]",
      ),
    ).toHaveLength(0);
    expect(within(root).queryAllByRole("link", { name: ACTION })).toHaveLength(0);
  }

  it("the page and its sheet issue only GET requests and show no action buttons", async () => {
    const calls = mockFetch(
      base({ "GET /api/bank/transactions/1": () => ({ body: txDetail(tx()) }) }),
    );
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    await table();
    assertNoActions(screen.getByRole("main"), "bank");
    await user.click(screen.getByRole("button", { name: "Paper Co" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/Revolut notified us/);
    assertNoActions(dialog, "sheet");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("the menu item is a real link without 'coming soon'", async () => {
    mockFetch(base());
    renderApp("/treasury/bank");
    await table();
    expect(screen.queryByText(/coming soon|not built yet/i)).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const link = within(nav)
      .getAllByRole("link")
      .find((l) => l.getAttribute("href") === "/treasury/bank");
    expect(link).toBeTruthy();
  });
});
