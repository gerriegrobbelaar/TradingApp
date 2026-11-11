/** The match sheet (M7d): candidates, manual allocation, ledger, ignore, conflicts, rejections. */
import { norm } from "./test-norm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import { nav, type Me } from "./api";
import { accounts } from "./test-fixtures-bank";
import { ONE_DIVISION, TWO_DIVISIONS, listResponse, row } from "./test-fixtures";
import { bookingSentence } from "./lib/matching-labels";
import {
  alloc,
  autoItem,
  booking,
  cand,
  detail,
  item,
  match,
  mtx,
  queue,
  stats,
  withItemBalances,
} from "./test-fixtures-matching";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const FINANCE: Me = { ...ADMIN, email: "f@camelthorncapital.com", roles: ["finance"] };
const APPROVER: Me = { ...ADMIN, email: "a@camelthorncapital.com", roles: ["approver"] };
const params = (c: Call | undefined) => new URL(c?.url ?? "", "http://x").searchParams;
const of = (calls: Call[], path: string, method = "GET") =>
  calls.filter((c) => c.method === method && c.url.split("?")[0] === path);

type H = Record<string, (c: Call) => { status?: number; body?: unknown }>;
function base(me: Me = FINANCE, over: H = {}, matched: Record<number, number> = {}): H {
  return withItemBalances(
    {
      "GET /api/auth/me": () => ({ body: me }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/bank/accounts": () => ({ body: accounts() }),
      "GET /api/matching/stats": () => ({ body: stats() }),
      "GET /api/matching/queue": () => ({ body: queue([item()]) }),
      "GET /api/matching/transactions/1": () => ({ body: detail() }),
      "GET /api/booking/settings": () => ({ body: booking() }),
      ...over,
    },
    matched,
  );
}
async function openSheet(user: ReturnType<typeof userEvent.setup>, who = "Acme B.V.") {
  const t = await screen.findByRole("table", { name: "Bank lines to review" });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  await user.click(within(t).getByRole("button", { name: who }));
  const dialog = await screen.findByRole("dialog", { name: "Match bank line" });
  await within(dialog).findByText("Counterparty");
  return dialog;
}
const pick = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, n = 1) => {
  const radios = within(dialog).getAllByRole("radio");
  await user.click(radios[n - 1] as HTMLElement);
};
const matchSelected = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Match to selected" });

afterEach(() => vi.restoreAllMocks());

describe("transaction and candidates", () => {
  it("shows the line with a masked account and the ranked candidates with the engine's sentences", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(FINANCE, {
        "GET /api/matching/transactions/1": () => ({
          body: detail({}, [
            cand({ rank: 1 }),
            cand({
              rank: 2,
              score: 70,
              kind: "partial",
              allocatedMinor: 123400,
              remainingMinor: 50000,
              explanation: ["€ 1.234,00 is a part payment on INV-2024-002; € 500,00 stays open"],
              reasonCodes: ["amount_partial", "due_date_near"],
              blocked: [
                { code: "not_full_payment", text: "x" },
                { code: "not_top_candidate", text: "y" },
              ],
              allocations: [
                alloc({
                  openItemId: 11,
                  invoiceNumber: "INV-2024-002",
                  remainingMinorAfter: 50000,
                }),
              ],
            }),
            cand({
              rank: 3,
              score: 60,
              allocations: [alloc({ openItemId: 12, invoiceNumber: "INV-3" })],
            }),
            cand({
              rank: 4,
              score: 58,
              allocations: [alloc({ openItemId: 13, invoiceNumber: "INV-4" })],
            }),
            cand({
              rank: 5,
              score: 55,
              allocations: [alloc({ openItemId: 14, invoiceNumber: "INV-5" })],
            }),
            cand({
              rank: 6,
              score: 51,
              allocations: [alloc({ openItemId: 15, invoiceNumber: "INV-6" })],
            }),
          ]),
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    const text = norm(dialog.textContent);
    expect(text).toContain("•••• 4300");
    expect(text).not.toContain("NL91");
    expect(text).toContain("+€ 1.234,00");
    expect(text).toContain("Invoice INV-2024-001");
    expect(within(dialog).getAllByRole("radio")).toHaveLength(5); // at most five
    expect(text).toContain("€ 1.234,00 equals the open balance of INV-2024-001");
    expect(text).toContain("The reference contains INV-2024-001");
    expect(text).toContain("€ 500,00 stays open");
    expect(text).toContain("Part payment");
    expect(text).toContain("Invoice number in the reference");
    expect(text).toContain("Paid close to the due date");
    expect(text).toContain("This does not pay the open balance in full");
    expect(text).toContain("Another candidate scores higher");
    expect(text).not.toContain("INV-6");
  });

  it("selects nothing by itself: Match to selected is disabled until a candidate is chosen", async () => {
    const user = userEvent.setup();
    mockFetch(base());
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    for (const r of within(dialog).getAllByRole("radio"))
      expect((r as HTMLInputElement).checked).toBe(false);
    expect((matchSelected(dialog) as HTMLButtonElement).disabled).toBe(true);
    await pick(user, dialog);
    expect((matchSelected(dialog) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an overpayment candidate cannot be matched as it is, and says what to do", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(FINANCE, {
        "GET /api/matching/transactions/1": () => ({
          body: detail({}, [
            cand({
              kind: "overpayment",
              allocatedMinor: 100000,
              surplusMinor: 23400,
              allocations: [alloc({ allocatedMinor: 100000 })],
            }),
          ]),
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    expect((matchSelected(dialog) as HTMLButtonElement).disabled).toBe(true);
    expect(norm(dialog.textContent)).toContain("€ 234,00 more than INV-2024-001 has open");
  });

  it("with no candidates it says so and still offers the other routes", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(FINANCE, { "GET /api/matching/transactions/1": () => ({ body: detail({}, []) }) }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(within(dialog).getByText("No candidates")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Match to another invoice…" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Match to selected" })).toBeNull();
  });

  it("has no axe violations", async () => {
    const user = userEvent.setup();
    mockFetch(base());
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it("shows a skeleton while loading and an error with Try again when the detail fails", async () => {
    const user = userEvent.setup();
    let fail = true;
    mockFetch(
      base(FINANCE, {
        "GET /api/matching/transactions/1": () =>
          fail ? { status: 500, body: { error: "x" } } : { body: detail() },
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const t = await screen.findByRole("table", { name: "Bank lines to review" });
    await user.click(await within(t).findByRole("button", { name: "Acme B.V." }));
    const dialog = await screen.findByRole("dialog");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("The server could not do this");
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("Counterparty")).toBeTruthy();
  });

  it("Escape closes the sheet and returns focus to the row", async () => {
    const user = userEvent.setup();
    mockFetch(base());
    renderApp("/treasury/bank?tab=review");
    await openSheet(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement?.textContent).toContain("Acme B.V.");
  });
});

describe("matching a candidate", () => {
  it("asks for confirmation, says nothing is booked in Exact yet, then posts exactly what was shown", async () => {
    const user = userEvent.setup();
    let done = false;
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/matching/queue": () => ({ body: queue(done ? [] : [item()]) }),
        "POST /api/matching/matches": () => {
          done = true;
          return { status: 201, body: { match: match({ source: "manual" }) } };
        },
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    await user.click(matchSelected(dialog));
    expect(of(calls, "/api/matching/matches", "POST")).toHaveLength(0); // nothing sent yet
    const text = within(dialog).getByTestId("confirm-text");
    expect(norm(text.textContent)).toBe(
      "Match € 1.234,00 to INV-2024-001 (Acme B.V.). This is recorded in the app only. Nothing is booked in Exact, because booking in Exact is off. No money is paid or moved.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
    await waitFor(() => expect(of(calls, "/api/matching/matches", "POST")).toHaveLength(1));
    expect(of(calls, "/api/matching/matches", "POST")[0]?.body).toEqual({
      transactionId: 1,
      allocations: [{ openItemId: 10, allocatedMinor: 123400 }],
    });
    // waits for the server, then refetches the queue and the counts (no optimistic UI)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(of(calls, "/api/matching/queue").length).toBeGreaterThan(1));
    await waitFor(() => expect(of(calls, "/api/matching/stats").length).toBeGreaterThan(1));
    expect(await screen.findByText("0 lines to review.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Recorded the match/);
  });

  it("does not remove the row before the server answered", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const calls = mockFetch(
      base(FINANCE, {
        "POST /api/matching/matches": () => ({ status: 201, body: { match: match() } }),
      }),
    );
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") await gate;
      return inner(url, init);
    });
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    await user.click(matchSelected(dialog));
    await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
    const btn = within(dialog).getByRole("button", { name: "Record this match" });
    expect((btn as HTMLButtonElement).disabled).toBe(true); // one request at a time
    expect(screen.getByRole("table", { name: "Bank lines to review" }).textContent).toContain(
      "Acme B.V.",
    );
    release?.();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(of(calls, "/api/matching/matches", "POST")).toHaveLength(1);
  });

  it("the wording follows the real booking state: a matrix of off / blocked / ready / unreadable for finance and admin", async () => {
    const user = userEvent.setup();
    const states: [string, () => { status?: number; body?: unknown }, string][] = [
      ["off", () => ({ body: booking({ enabled: false }) }), bookingSentence(booking())],
      [
        "off with blockers",
        () => ({ body: booking({ enabled: false, blockers: ["not_verified"] }) }),
        bookingSentence(booking()),
      ],
      [
        "ready",
        () => ({ body: booking({ enabled: true }) }),
        bookingSentence(booking({ enabled: true })),
      ],
      [
        "blocked",
        () => ({ body: booking({ enabled: true, blockers: ["no_exact_connection"] }) }),
        bookingSentence(booking({ enabled: true, blockers: ["x"] })),
      ],
      [
        "protocol changed",
        () => ({ body: booking({ enabled: true, protocolChanged: true }) }),
        bookingSentence(booking({ enabled: true, blockers: ["x"] })),
      ],
      ["unreadable", () => ({ status: 500, body: { error: "boom" } }), bookingSentence(null)],
    ];
    for (const me of [FINANCE, ADMIN]) {
      for (const [name, reply, sentence] of states) {
        mockFetch(base(me, { "GET /api/booking/settings": reply }));
        const { unmount } = renderApp("/treasury/bank?tab=review");
        const dialog = await openSheet(user);
        await pick(user, dialog);
        await user.click(matchSelected(dialog));
        const text = norm(within(dialog).getByTestId("confirm-text").textContent);
        expect(text, `${me.roles.join()} ${name}`).toBe(
          `Match € 1.234,00 to INV-2024-001 (Acme B.V.). ${norm(sentence)}`,
        );
        const promisesBooking =
          /then booked in Exact automatically afterwards and cannot be undone here/;
        if (name === "ready") expect(text).toMatch(promisesBooking);
        else expect(text, name).not.toMatch(promisesBooking);
        expect(text).toContain("No money is paid or moved.");
        unmount();
      }
    }
  });

  it("a viewer's sheet reads the booking setting too (open to every role) but offers no action", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(base(VIEWER));
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(of(calls, "/api/booking/settings").length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Match to selected/ })).toBeNull();
  });

  it("Back returns to the candidates without sending anything", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(base());
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    await user.click(matchSelected(dialog));
    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).getAllByRole("radio")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("keyboard only: J/Enter opens, Space picks, the confirmation takes focus, Back returns it, Escape closes", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(base());
    renderApp("/treasury/bank?tab=review");
    const t = await screen.findByRole("table", { name: "Bank lines to review" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("j");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Match bank line" });
    await within(dialog).findByText("Counterparty");
    const radio = within(dialog).getAllByRole("radio")[0] as HTMLElement;
    radio.focus();
    await user.keyboard(" ");
    expect((radio as HTMLInputElement).checked).toBe(true);
    // "j" typed inside the sheet does nothing to the list behind it
    await user.keyboard("j");
    matchSelected(dialog).focus();
    await user.keyboard("{Enter}");
    const heading = within(dialog).getByRole("heading", { name: "Check before you record this" });
    expect(document.activeElement).toBe(heading);
    await user.tab();
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Back");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      within(dialog).getByRole("heading", { name: "Candidates, best first" }),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("a candidate for another relation needs the confirmation box and sends it", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/matching/transactions/1": () => ({
          body: detail({}, [
            cand({
              reasonCodes: ["amount_equals_open", "iban_belongs_to_other_relation"],
              blocked: [{ code: "iban_belongs_to_other_relation", text: "x" }],
            }),
          ]),
        }),
        "POST /api/matching/matches": () => ({ status: 201, body: { match: match() } }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(
      within(dialog).getByText("The sender's account belongs to another customer or supplier"),
    ).toBeTruthy();
    await pick(user, dialog);
    await user.click(matchSelected(dialog));
    const box = within(dialog).getByRole("checkbox", {
      name: "I confirm this invoice belongs to a different customer/supplier than the sender's account",
    });
    const record = within(dialog).getByRole("button", { name: "Record this match" });
    expect((record as HTMLButtonElement).disabled).toBe(true);
    await user.click(box);
    expect((record as HTMLButtonElement).disabled).toBe(false);
    await user.click(record);
    await waitFor(() => expect(of(calls, "/api/matching/matches", "POST")).toHaveLength(1));
    expect(of(calls, "/api/matching/matches", "POST")[0]?.body).toEqual({
      transactionId: 1,
      allocations: [{ openItemId: 10, allocatedMinor: 123400 }],
      confirmDifferentRelation: true,
    });
  });

  it("when only the server knows it is another relation, it shows the box and asks again", async () => {
    const user = userEvent.setup();
    let n = 0;
    const calls = mockFetch(
      base(FINANCE, {
        "POST /api/matching/matches": (c) => {
          n += 1;
          return (c.body as { confirmDifferentRelation?: boolean }).confirmDifferentRelation
            ? { status: 201, body: { match: match() } }
            : { status: 409, body: { error: "different_relation" } };
        },
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    await user.click(matchSelected(dialog));
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
    expect(
      await within(dialog).findByText(/belongs to a different customer or supplier/),
    ).toBeTruthy();
    const box = within(dialog).getByRole("checkbox");
    expect(
      (within(dialog).getByRole("button", { name: "Record this match" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(box);
    await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
    await waitFor(() => expect(n).toBe(2));
    expect(of(calls, "/api/matching/matches", "POST")[1]?.body).toMatchObject({
      confirmDifferentRelation: true,
    });
    // the first refusal did not refresh the sheet (nothing moved)
    expect(of(calls, "/api/matching/transactions/1")).toHaveLength(1);
  });

  it("a missing fresh sign-in shows the sign-in button and changes nothing", async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => undefined);
    mockFetch(
      base(FINANCE, {
        "POST /api/matching/matches": () => ({ status: 401, body: { error: "step_up_required" } }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    await user.click(matchSelected(dialog));
    await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
    const alert = await within(dialog).findByText(
      /needs a Google sign-in from the last 15 minutes/,
    );
    expect(alert.textContent).toContain("Nothing was changed");
    await user.click(within(dialog).getByRole("button", { name: "Sign in again" }));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]?.[0])).toContain("step_up=1");
  });

  const REFUSALS: [number, string, RegExp][] = [
    [409, "item_has_live_match", /Another match already uses this invoice/],
    [409, "already_matched", /matched in the meantime/],
    [409, "tx_ignored", /ignored in the meantime/],
    [409, "tx_state_conflict", /An administrator must check it first/],
    [409, "item_changed", /paid, closed or matched elsewhere/],
    [422, "allocation_exceeds_open", /more than what is still free/],
    [422, "allocation_sum_mismatch", /add up to the bank line exactly/],
    [422, "division_inactive", /not being synced/],
    [422, "currency_mismatch", /currency of the invoice|invoice currency differs/i],
    [422, "direction_mismatch", /other direction/],
    [422, "account_not_mapped", /not linked to an administration/],
    [422, "tx_not_final", /not final yet/],
    [404, "not_found", /no longer exists/],
  ];
  for (const [status, code, re] of REFUSALS) {
    it(`${code} is said in plain words and the sheet and the queue are refreshed`, async () => {
      const user = userEvent.setup();
      const calls = mockFetch(
        base(FINANCE, {
          "POST /api/matching/matches": () => ({ status, body: { error: code } }),
        }),
      );
      renderApp("/treasury/bank?tab=review");
      const dialog = await openSheet(user);
      await pick(user, dialog);
      await user.click(matchSelected(dialog));
      await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
      const alert = await within(dialog).findByText(re);
      expect(alert.textContent).not.toContain(code);
      await waitFor(() =>
        expect(of(calls, "/api/matching/transactions/1").length).toBeGreaterThan(1),
      );
      await waitFor(() => expect(of(calls, "/api/matching/queue").length).toBeGreaterThan(1));
      await waitFor(() => expect(of(calls, "/api/matching/stats").length).toBeGreaterThan(1));
      // still open, back on the candidates, the message kept
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(within(dialog).getByText(re)).toBeTruthy();
    });
  }

  it("a server error that is not about the data keeps the confirmation open", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(FINANCE, {
        "POST /api/matching/matches": () => ({ status: 500, body: { error: "boom" } }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    await user.click(matchSelected(dialog));
    await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
    expect(await within(dialog).findByText(/Nothing was changed/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Record this match" })).toBeTruthy();
    expect(of(calls, "/api/matching/transactions/1")).toHaveLength(1);
  });
});

describe("matching another invoice", () => {
  const items = [
    row({
      id: 21,
      invoiceNumber: "INV-21",
      openMinor: 100000,
      relation: { id: 7, name: "Acme BV" },
    }),
    row({
      id: 22,
      invoiceNumber: "INV-22",
      openMinor: 50000,
      relation: { id: 7, name: "Acme BV" },
    }),
    row({
      id: 23,
      invoiceNumber: "CN-23",
      openMinor: -20000,
      relation: { id: 8, name: "Beta BV" },
    }),
  ];
  const picker = (over: H = {}): H =>
    base(FINANCE, {
      "GET /api/invoices": () => ({ body: listResponse(items) }),
      "GET /api/bills": () => ({ body: listResponse([]) }),
      ...over,
    });

  it("searches open items of the administration and splits the payment with live validation", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      picker({
        "POST /api/matching/matches": () => ({ status: 201, body: { match: match() } }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole("button", { name: "Match to another invoice…" }));
    await within(dialog).findByText("INV-21");
    const q = of(calls, "/api/invoices")[0];
    expect(params(q).get("division")).toBe("1");
    expect(params(q).get("status")).toBe("open");
    expect(params(q).get("currency")).toBe("EUR");
    await user.click(within(dialog).getByRole("button", { name: "Add INV-21" }));
    const input = within(dialog).getByLabelText("Amount for INV-21 (EUR)") as HTMLInputElement;
    expect(input.value).toBe("1000.00"); // the smaller of what is open and what the payment is
    expect(norm(within(dialog).getByTestId("alloc-total").textContent)).toBe(
      "€ 234,00 still to allocate.",
    );
    expect(
      (within(dialog).getByRole("button", { name: "Review this match" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Add INV-22" }));
    const second = within(dialog).getByLabelText("Amount for INV-22 (EUR)") as HTMLInputElement;
    expect(second.value).toBe("234.00");
    expect(within(dialog).getByTestId("alloc-total").textContent).toMatch(
      /€.1\.234,00 allocated, equal to the bank amount of €.1\.234,00/,
    );
    // too much on the second invoice
    await user.clear(second);
    await user.type(second, "600");
    expect(norm(within(dialog).getByTestId("alloc-total").textContent)).toBe(
      "€ 366,00 too much. The amounts must add up to € 1.234,00.",
    );
    expect(within(dialog).getByText("More than the € 500,00 still open.")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "Review this match" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.clear(second);
    await user.type(second, "234,00");
    await user.click(within(dialog).getByRole("button", { name: "Review this match" }));
    expect(norm(within(dialog).getByTestId("confirm-text").textContent)).toMatch(
      /^Match € 1\.234,00 across 2 invoices\. This is recorded in the app only/,
    );
    expect(within(dialog).getByText("€ 1.000,00 to INV-21 (Acme BV)")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
    await waitFor(() => expect(of(calls, "/api/matching/matches", "POST")).toHaveLength(1));
    expect(of(calls, "/api/matching/matches", "POST")[0]?.body).toEqual({
      transactionId: 1,
      allocations: [
        { openItemId: 21, allocatedMinor: 100000 },
        { openItemId: 22, allocatedMinor: 23400 },
      ],
    });
  });

  it("refuses a different currency, shows credit notes and removes an item", async () => {
    const user = userEvent.setup();
    mockFetch(
      picker({
        "GET /api/invoices": () => ({
          body: listResponse([
            ...items,
            row({ id: 24, invoiceNumber: "USD-1", currency: "USD", openMinor: 1000 }),
          ]),
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole("button", { name: "Match to another invoice…" }));
    await within(dialog).findByText("CN-23");
    expect(within(dialog).getByText(/\(credit note\)/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Add USD-1" }));
    expect(
      within(dialog).getByText("This invoice is in USD but the payment is in EUR."),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Add CN-23" }));
    // a credit note is settled by money out, and this payment is money in
    expect(
      within(dialog).getByText("A credit note is settled by a payment in the other direction."),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Remove USD-1" }));
    expect(within(dialog).queryByLabelText("Amount for USD-1 (USD)")).toBeNull();
    // an item that is added is no longer offered
    expect(within(dialog).queryByRole("button", { name: "Add CN-23" })).toBeNull();
  });

  it("a payment out searches bills first and can narrow to the relation of the first pick", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      picker({
        "GET /api/matching/transactions/1": () => ({
          body: detail({ amountMinor: -50000, matchStatus: "unmatched" }, []),
        }),
        "GET /api/bills": () => ({
          body: listResponse([
            row({
              id: 31,
              kind: "bill",
              invoiceNumber: "BILL-31",
              openMinor: 50000,
              relation: { id: 9, name: "Paper Co" },
            }),
          ]),
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole("button", { name: "Match to another invoice…" }));
    await within(dialog).findByText("BILL-31");
    expect(of(calls, "/api/bills").length).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("button", { name: "Add BILL-31" }));
    await user.click(within(dialog).getByRole("button", { name: "Only Paper Co" }));
    await waitFor(() => expect(params(of(calls, "/api/bills").at(-1)).get("relationId")).toBe("9"));
    expect(
      (within(dialog).getByRole("button", { name: "Review this match" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("searches only the line's own administration, without a selector, whatever the switcher shows", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      picker({
        "GET /api/divisions": () => ({ body: { ...TWO_DIVISIONS, selectedId: 2 } }),
        "GET /api/matching/transactions/1": () => ({
          body: detail({ divisionId: 1, matchStatus: "unmatched" }, []),
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole("button", { name: "Match to another invoice…" }));
    await within(dialog).findByText("INV-21");
    expect(within(dialog).queryByLabelText("Administration")).toBeNull();
    for (const c of of(calls, "/api/invoices")) expect(params(c).get("division")).toBe("1");
    expect(norm(dialog.textContent)).toContain("of Alpha BV, the administration");
  });

  it("checks the free balance with the server: an amount already matched elsewhere in the app is refused before review", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(
        FINANCE,
        {
          "GET /api/invoices": () => ({ body: listResponse(items) }),
          "GET /api/bills": () => ({ body: listResponse([]) }),
        },
        { 21: 50000 },
      ),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole("button", { name: "Match to another invoice…" }));
    await within(dialog).findByText("INV-21");
    await user.click(within(dialog).getByRole("button", { name: "Add INV-21" }));
    await waitFor(() => expect(of(calls, "/api/matching/items").length).toBeGreaterThan(0));
    expect(params(of(calls, "/api/matching/items")[0]).get("ids")).toBe("21");
    await waitFor(() =>
      expect(norm(dialog.textContent)).toContain(
        "More than the € 500,00 still free (€ 1.000,00 open in Exact, € 500,00 already matched here).",
      ),
    );
    expect(norm(dialog.textContent)).toContain("€ 500,00 already matched here · € 500,00 free");
    expect(
      (within(dialog).getByRole("button", { name: "Review this match" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("re-reads the balances right before the confirmation and stays in the editor when one moved", async () => {
    const user = userEvent.setup();
    let matchedElsewhere = 0;
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/invoices": () => ({ body: listResponse(items) }),
        "GET /api/bills": () => ({ body: listResponse([]) }),
        "GET /api/matching/items": () => ({
          body: {
            items: [
              {
                openItemId: 21,
                divisionId: 1,
                kind: "invoice",
                currency: "EUR",
                status: "open",
                openMinor: 200000,
                matchedMinor: matchedElsewhere,
                freeMinor: 200000 - matchedElsewhere,
              },
            ],
          },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole("button", { name: "Match to another invoice…" }));
    await within(dialog).findByText("INV-21");
    await user.click(within(dialog).getByRole("button", { name: "Add INV-21" }));
    const input = within(dialog).getByLabelText("Amount for INV-21 (EUR)");
    await user.clear(input);
    await user.type(input, "1234,00");
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("button", { name: "Review this match" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    matchedElsewhere = 190000; // another person matched most of it meanwhile
    const before = of(calls, "/api/matching/items").length;
    await user.click(within(dialog).getByRole("button", { name: "Review this match" }));
    expect(
      await within(dialog).findByText(
        "An invoice changed in the meantime. Check the amounts below.",
      ),
    ).toBeTruthy();
    expect(of(calls, "/api/matching/items").length).toBe(before + 1);
    expect(within(dialog).queryByTestId("confirm-text")).toBeNull();
    expect(
      (within(dialog).getByLabelText("Amount for INV-21 (EUR)") as HTMLInputElement).value,
    ).toBe("1234,00");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("a 422 from the server on submit goes back to the editor with the typed amounts kept", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      picker({
        "POST /api/matching/matches": () => ({
          status: 422,
          body: { error: "allocation_exceeds_open" },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole("button", { name: "Match to another invoice…" }));
    await within(dialog).findByText("INV-21");
    await user.click(within(dialog).getByRole("button", { name: "Add INV-21" }));
    await user.click(within(dialog).getByRole("button", { name: "Add INV-22" }));
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("button", { name: "Review this match" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await user.click(within(dialog).getByRole("button", { name: "Review this match" }));
    await user.click(await within(dialog).findByRole("button", { name: "Record this match" }));
    expect(await within(dialog).findByText(/more than what is still free/)).toBeTruthy();
    expect(
      (within(dialog).getByLabelText("Amount for INV-22 (EUR)") as HTMLInputElement).value,
    ).toBe("234.00");
    expect(of(calls, "/api/matching/matches", "POST")).toHaveLength(1);
  });

  it("Escape while typing an amount asks before throwing the allocations away", async () => {
    const user = userEvent.setup();
    mockFetch(picker());
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole("button", { name: "Match to another invoice…" }));
    await within(dialog).findByText("INV-21");
    await user.click(within(dialog).getByRole("button", { name: "Add INV-21" }));
    const input = within(dialog).getByLabelText("Amount for INV-21 (EUR)");
    await user.click(input);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Match bank line" })).toBe(dialog);
    expect(
      within(dialog).getByRole("alertdialog", { name: /Discard what you typed/ }),
    ).toBeTruthy();
    await user.keyboard("{Escape}"); // = keep editing
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    expect(
      (within(dialog).getByLabelText("Amount for INV-21 (EUR)") as HTMLInputElement).value,
    ).toBe("1000.00");
    await user.click(
      within(dialog).getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement,
    );
    await user.click(within(dialog).getByRole("button", { name: "Discard and close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a double click on Record sends one request; the server's 409 for a repeat is a refresh, not a duplicate", async () => {
    const user = userEvent.setup();
    let posts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const calls = mockFetch(
      base(FINANCE, {
        "POST /api/matching/matches": () => {
          posts++;
          return posts === 1
            ? { status: 201, body: { match: match() } }
            : { status: 409, body: { error: "already_matched" } };
        },
      }),
    );
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") await gate;
      return inner(url, init);
    });
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    await user.click(matchSelected(dialog));
    const rec = within(dialog).getByRole("button", { name: "Record this match" });
    await user.click(rec);
    await user.click(rec);
    await user.dblClick(rec);
    expect((rec as HTMLButtonElement).disabled).toBe(true);
    release?.();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(of(calls, "/api/matching/matches", "POST")).toHaveLength(1);
  });
});

describe("booking to a ledger account", () => {
  it("suggests the pattern's account, validates the code and confirms", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/matching/transactions/1": () => ({
          body: detail({ amountMinor: -1500, matchStatus: "unmatched" }, [
            cand({
              kind: "ledger",
              rule: 4,
              allocations: [],
              allocatedMinor: 1500,
              ledgerAccountCode: "4500",
              explanation: ['€ 15,00 fits the pattern "Bank costs" for ledger account 4500'],
              reasonCodes: ["pattern"],
              blocked: [{ code: "ledger_auto_disabled", text: "x" }],
            }),
          ]),
        }),
        "POST /api/matching/matches": () => ({
          status: 201,
          body: { match: match({ source: "ledger" }) },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(within(dialog).getByText("Known ledger pattern")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Match to a ledger account…" }));
    const input = within(dialog).getByLabelText("Ledger account code");
    await user.type(input, "45 00");
    expect(within(dialog).getByRole("alert").textContent).toMatch(
      /letters, digits, dots or hyphens/,
    );
    expect(
      (within(dialog).getByRole("button", { name: "Review this match" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Use 4500" }));
    expect((input as HTMLInputElement).value).toBe("4500");
    await user.click(within(dialog).getByRole("button", { name: "Review this match" }));
    expect(norm(within(dialog).getByTestId("confirm-text").textContent)).toBe(
      "Match € 15,00 to ledger account 4500 instead of an invoice. This is recorded in the app only. Nothing is booked in Exact, because booking in Exact is off. No money is paid or moved.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
    await waitFor(() => expect(of(calls, "/api/matching/matches", "POST")).toHaveLength(1));
    expect(of(calls, "/api/matching/matches", "POST")[0]?.body).toEqual({
      transactionId: 1,
      ledgerAccountCode: "4500",
    });
  });

  it("matches a selected ledger candidate through the same confirmation", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/matching/transactions/1": () => ({
          body: detail({ amountMinor: -1500 }, [
            cand({
              kind: "ledger",
              allocations: [],
              allocatedMinor: 1500,
              ledgerAccountCode: "4500",
            }),
          ]),
        }),
        "POST /api/matching/matches": () => ({ status: 201, body: { match: match() } }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    await user.click(matchSelected(dialog));
    expect(norm(within(dialog).getByTestId("confirm-text").textContent)).toMatch(
      /^Match € 15,00 to ledger account 4500 instead of an invoice\./,
    );
    await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
    await waitFor(() =>
      expect(of(calls, "/api/matching/matches", "POST")[0]?.body).toEqual({
        transactionId: 1,
        ledgerAccountCode: "4500",
      }),
    );
  });
});

describe("ignoring a line", () => {
  it("asks for a reason, confirms and posts", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(FINANCE, {
        "POST /api/matching/transactions/1/ignore": () => ({
          body: { transaction: mtx({ matchStatus: "ignored" }) },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole("button", { name: "Ignore…" }));
    await user.selectOptions(within(dialog).getByLabelText("Reason"), "other");
    expect(
      (within(dialog).getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(dialog).getByText("Add a note when the reason is other.")).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Note (optional)"), "Personal");
    await user.click(within(dialog).getByRole("button", { name: "Review" }));
    const text = norm(within(dialog).getByTestId("confirm-text").textContent);
    expect(text).toContain("Ignore € 1.234,00 on Main EUR.");
    expect(text).toContain("You can unignore it later.");
    expect(text).not.toContain("recorded in the app only");
    await user.click(within(dialog).getByRole("button", { name: "Ignore this line" }));
    await waitFor(() =>
      expect(of(calls, "/api/matching/transactions/1/ignore", "POST")).toHaveLength(1),
    );
    expect(of(calls, "/api/matching/transactions/1/ignore", "POST")[0]?.body).toEqual({
      reason: "other",
      note: "Personal",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("an ignored line shows who ignored it and can be unignored", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/matching/transactions/1": () => ({
          body: detail({
            matchStatus: "ignored",
            ignore: {
              reason: "not_ours",
              note: "Not ours",
              by: "f@x.nl",
              at: "2026-11-09T10:00:00Z",
            },
          }),
        }),
        "POST /api/matching/transactions/1/unignore": () => ({ body: { transaction: mtx() } }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(within(dialog).getByText("Ignored")).toBeTruthy();
    expect(within(dialog).getByText(/Not ours/)).toBeTruthy();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Unignore" }));
    await waitFor(() =>
      expect(of(calls, "/api/matching/transactions/1/unignore", "POST")).toHaveLength(1),
    );
  });
});

describe("state conflicts", () => {
  const conflict = (): H => ({
    "GET /api/matching/transactions/1": () => ({
      body: detail({ stateConflict: true, matchStatus: "unmatched" }),
    }),
  });

  it("shows a distinct badge and no way to match; admins can clear it with a note", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(ADMIN, {
        ...conflict(),
        "POST /api/matching/transactions/1/clear-conflict": () => ({
          body: { transaction: mtx() },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(within(dialog).getByText("Needs a manager's check")).toBeTruthy();
    expect(within(dialog).getByText(/Revolut reported a different final state/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Match to selected" })).toBeNull();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    const clear = within(dialog).getByRole("button", { name: "Clear conflict…" });
    expect((clear as HTMLButtonElement).disabled).toBe(true); // a note is required
    await user.type(
      within(dialog).getByLabelText("What did you check? (required)"),
      "Checked in Revolut",
    );
    await user.click(clear);
    expect(of(calls, "/api/matching/transactions/1/clear-conflict", "POST")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Clear the conflict" }));
    await waitFor(() =>
      expect(of(calls, "/api/matching/transactions/1/clear-conflict", "POST")[0]?.body).toEqual({
        note: "Checked in Revolut",
      }),
    );
  });

  it("clearing needs a fresh sign-in", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(ADMIN, {
        ...conflict(),
        "POST /api/matching/transactions/1/clear-conflict": () => ({
          status: 401,
          body: { error: "step_up_required" },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await user.type(within(dialog).getByLabelText("What did you check? (required)"), "ok");
    await user.click(within(dialog).getByRole("button", { name: "Clear conflict…" }));
    await user.click(within(dialog).getByRole("button", { name: "Clear the conflict" }));
    expect(await within(dialog).findByText(/needs a Google sign-in/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Sign in again" })).toBeTruthy();
  });

  it("finance users see the explanation but cannot clear it", async () => {
    const user = userEvent.setup();
    mockFetch(base(FINANCE, conflict()));
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(within(dialog).getByText("Needs a manager's check")).toBeTruthy();
    expect(within(dialog).getByText("Ask an administrator to check this line.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Clear conflict/ })).toBeNull();
  });
});

describe("unmapped accounts", () => {
  it("says the line is not matched until the account is mapped", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(ADMIN, {
        "GET /api/matching/transactions/1": () => ({ body: detail({ mapped: false }) }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(within(dialog).getByText("Not matched until mapped")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Map it in Settings, Matching" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Match to selected" })).toBeNull();
  });
});

describe("a line that is already matched", () => {
  const matched = (m = match()): H => ({
    "GET /api/matching/transactions/1": () => ({
      body: detail({ matchStatus: "matched" }, [], m),
    }),
    "GET /api/matching/queue": () => ({ body: queue([item({ matchStatus: "matched" }, [])]) }),
  });

  it("shows the match and lets finance undo it with a reason", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(FINANCE, {
        ...matched(),
        "POST /api/matching/matches/50/undo": () => ({
          body: { match: match({ status: "undone" }) },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(within(dialog).getByText("Matched automatically")).toBeTruthy();
    expect(within(dialog).getByText("Not booked in Exact")).toBeTruthy();
    expect(norm(dialog.textContent)).toContain("€ 1.234,00 to INV-2024-001 (Acme B.V.)");
    await user.type(within(dialog).getByLabelText("Why are you undoing this match?"), "Wrong");
    await user.click(within(dialog).getByRole("button", { name: "Undo…" }));
    await user.click(within(dialog).getByRole("button", { name: "Undo this match" }));
    await waitFor(() => expect(of(calls, "/api/matching/matches/50/undo", "POST")).toHaveLength(1));
    expect(of(calls, "/api/matching/matches/50/undo", "POST")[0]?.body).toEqual({
      reason: "Wrong",
    });
  });

  it("disables Undo when Exact has booked it, and a refused undo is explained", async () => {
    const user = userEvent.setup();
    mockFetch(base(FINANCE, matched(match({ exactState: "booked", undoAvailable: false }))));
    const view = renderApp("/treasury/bank?tab=review");
    let dialog = await openSheet(user);
    expect(
      (within(dialog).getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(dialog).getByText("Already booked in Exact. Reverse it there.")).toBeTruthy();
    view.unmount();

    mockFetch(
      base(FINANCE, {
        ...matched(),
        "POST /api/matching/matches/50/undo": () => ({
          status: 409,
          body: { error: "already_booked_in_exact" },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    dialog = await openSheet(user);
    await user.type(within(dialog).getByLabelText("Why are you undoing this match?"), "x");
    await user.click(within(dialog).getByRole("button", { name: "Undo…" }));
    await user.click(within(dialog).getByRole("button", { name: "Undo this match" }));
    expect(
      await within(dialog).findByText("Already booked in Exact. Reverse it there."),
    ).toBeTruthy();
  });

  it("flags a match whose data changed and says it is never booked", async () => {
    const user = userEvent.setup();
    mockFetch(base(FINANCE, matched(match({ reviewReason: "over_allocated" }))));
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(within(dialog).getByText(/paid elsewhere, so this match now exceeds/)).toBeTruthy();
    expect(within(dialog).getByText(/never booked in Exact/)).toBeTruthy();
  });

  it("shows the part payment that stays open", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(
        FINANCE,
        matched(
          match({ allocations: [alloc({ allocatedMinor: 100000, remainingMinorAfter: 23400 })] }),
        ),
      ),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(norm(dialog.textContent)).toContain("€ 234,00 stays open");
  });

  it("a viewer sees the match and no Undo", async () => {
    const user = userEvent.setup();
    mockFetch(base(VIEWER, matched()));
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    expect(within(dialog).getByText("Matched")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Undo/ })).toBeNull();
  });
});

describe("role matrix", () => {
  const ACTIONS = [
    "Match to selected",
    "Match to another invoice…",
    "Match to a ledger account…",
    "Ignore…",
  ];
  const cases: [string, Me, boolean][] = [
    ["viewer", VIEWER, false],
    ["approver", APPROVER, false],
    ["finance", FINANCE, true],
    ["admin", ADMIN, true],
    ["finance and approver", { ...FINANCE, roles: ["finance", "approver"] }, true],
  ];
  for (const [name, me, can] of cases) {
    it(`${name}: ${can ? "can" : "cannot"} act on a line`, async () => {
      const user = userEvent.setup();
      const calls = mockFetch(base(me));
      renderApp("/treasury/bank?tab=review");
      const dialog = await openSheet(user);
      for (const a of ACTIONS) {
        const found = within(dialog).queryByRole("button", { name: a });
        expect(found !== null, `${name} ${a}`).toBe(can);
      }
      expect(within(dialog).queryAllByRole("radio").length > 0).toBe(can);
      // the candidates are still shown to everyone
      expect(within(dialog).getAllByText(/INV-2024-001/).length).toBeGreaterThan(0);
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });
  }

  it("uses the same rule as the server: matching writes are finance|admin, clearing a conflict admin", () => {
    const src =
      Object.values(
        import.meta.glob("../../worker/src/matching/routes.ts", {
          query: "?raw",
          import: "default",
          eager: true,
        }) as Record<string, string>,
      )[0] ?? "";
    expect(src).toMatch(/const FINANCE = \{ roles: \["finance", "admin"\] \} as const;/);
    for (const route of [
      '"POST", "/api/matching/matches", FINANCE',
      '"POST", "/api/matching/matches/:id/undo", FINANCE',
      '"POST", "/api/matching/transactions/:id/ignore", FINANCE',
      '"POST", "/api/matching/transactions/:id/unignore", FINANCE',
    ]) {
      expect(src.replace(/\s+/g, " "), route).toContain(route);
    }
    expect(src.replace(/\s+/g, " ")).toContain(
      '"POST", "/api/matching/transactions/:id/clear-conflict", ADMIN_STEP_UP',
    );
  });

  it("a 403 from the server (roles changed meanwhile) is said plainly and nothing is pretended", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(FINANCE, {
        "POST /api/matching/matches": () => ({ status: 403, body: { error: "forbidden" } }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    const dialog = await openSheet(user);
    await pick(user, dialog);
    await user.click(matchSelected(dialog));
    await user.click(within(dialog).getByRole("button", { name: "Record this match" }));
    expect(await within(dialog).findByText("You do not have permission to do this.")).toBeTruthy();
    expect(screen.queryByText(/Recorded the match/)).toBeNull();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("a view-only person never gets a write action anywhere on the Bank matching tabs", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base(VIEWER, {
        "GET /api/matching/auto": () => ({ body: { items: [autoItem()], nextCursor: null } }),
      }),
    );
    renderApp("/treasury/bank?tab=review");
    await openSheet(user);
    await user.keyboard("{Escape}");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});
