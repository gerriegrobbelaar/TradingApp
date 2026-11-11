/** Settings, Matching (M7d): account map, thresholds, automatic switch, patterns, booking card. */
import { norm } from "./test-norm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import { nav, type Me } from "./api";
import {
  AUTO_MATCH_CONFIRM_PHRASE,
  BOOKING_ENABLE_PHRASE,
  BOOKING_VERIFY_PHRASE,
} from "@camelthorn/core";
import { BLOCKER_FALLBACK } from "./lib/matching-labels";
import {
  accountMap,
  booking,
  config,
  outbox,
  outboxItem,
  pattern,
  stats,
} from "./test-fixtures-matching";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const FINANCE: Me = { ...ADMIN, email: "f@camelthorncapital.com", roles: ["finance"] };
const of = (calls: Call[], path: string, method = "GET") =>
  calls.filter((c) => c.method === method && c.url.split("?")[0] === path);

type H = Record<string, (c: Call) => { status?: number; body?: unknown }>;
function base(over: H = {}, me: Me = ADMIN): H {
  return {
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/matching/stats": () => ({ body: stats() }),
    "GET /api/matching/config": () => ({ body: config() }),
    "GET /api/matching/account-map": () => ({ body: accountMap() }),
    "GET /api/matching/patterns": () => ({ body: { patterns: [pattern()] } }),
    "GET /api/booking/settings": () => ({ body: booking() }),
    "GET /api/booking/outbox": () => ({ body: outbox() }),
    ...over,
  };
}
const STEP_UP = () => ({ status: 401, body: { error: "step_up_required" } });
afterEach(() => vi.restoreAllMocks());

function card(name: string): HTMLElement {
  const h = screen.getByRole("heading", { level: 2, name });
  return h.closest(".card") as HTMLElement;
}
async function open(over: H = {}, me: Me = ADMIN) {
  const calls = mockFetch(base(over, me));
  const view = renderApp("/settings/matching");
  for (const name of [
    "Account map",
    "Matching thresholds",
    "Automatic matching",
    "Ledger patterns",
    "Booking in Exact",
  ]) {
    await screen.findByRole("heading", { level: 2, name });
  }
  return { calls, view };
}

describe("the Matching tab", () => {
  it("is in the Settings menu and shows every card to an admin, without axe violations", async () => {
    const { view } = await open();
    expect(screen.getByRole("button", { name: "Matching" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    for (const name of [
      "Account map",
      "Matching thresholds",
      "Automatic matching",
      "Ledger patterns",
      "Booking in Exact",
    ]) {
      await screen.findByRole("heading", { level: 2, name });
    }
    await screen.findByText("Bank costs");
    expect((await screen.findAllByText("Off", { selector: ".chip" })).length).toBeGreaterThan(0);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  const APPROVER: Me = { ...ADMIN, email: "a@camelthorncapital.com", roles: ["approver"] };
  for (const me of [FINANCE, APPROVER, VIEWER]) {
    it(`${me.roles.join()}: the current state and the booking card read-only, no admin reads, no buttons`, async () => {
      const calls = mockFetch(
        base(
          {
            "GET /api/booking/settings": () => ({ body: booking({ enabled: true }) }),
            "GET /api/booking/outbox": () => ({
              body: outbox([outboxItem({ status: "failed" })]),
            }),
          },
          me,
        ),
      );
      renderApp("/settings/matching");
      expect(await screen.findByRole("heading", { level: 2, name: "Matching" })).toBeTruthy();
      expect(await screen.findByText("Bank accounts without an administration")).toBeTruthy();
      expect(screen.queryByRole("heading", { level: 2, name: "Account map" })).toBeNull();
      // Booking in Exact: readable by every role (orchestrator decision M7d), no actions.
      await screen.findByRole("heading", { level: 2, name: "Booking in Exact" });
      await screen.findByRole("table", { name: "Booking queue" });
      expect(await screen.findByText(/Only an administrator can verify/)).toBeTruthy();
      expect(
        screen.queryByRole("button", {
          name: /Enable|Disable|Verify|Save|Add pattern|Retry|Booked manually|Give up/,
        }),
      ).toBeNull();
      expect(of(calls, "/api/matching/config")).toHaveLength(0);
      expect(of(calls, "/api/matching/patterns")).toHaveLength(0);
      expect(of(calls, "/api/matching/account-map")).toHaveLength(0);
      expect(of(calls, "/api/booking/settings").length).toBeGreaterThan(0);
      expect(of(calls, "/api/booking/outbox").length).toBeGreaterThan(0);
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });
  }

  it("viewers see the same summary and unmapped accounts are counted", async () => {
    mockFetch(
      base(
        {
          "GET /api/matching/stats": () => ({
            body: stats({ unmappedAccounts: 2, autoEnabled: true }),
          }),
        },
        VIEWER,
      ),
    );
    renderApp("/settings/matching");
    expect(await screen.findByText("2 accounts, not matched until mapped")).toBeTruthy();
  });

  it("a failed read says so with Try again", async () => {
    let fail = true;
    mockFetch(
      base({
        "GET /api/matching/account-map": () =>
          fail ? { status: 500, body: { error: "x" } } : { body: accountMap() },
      }),
    );
    const user = userEvent.setup();
    renderApp("/settings/matching");
    const alert = await screen.findByRole("alert");
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Sterling")).toBeTruthy();
  });
});

describe("account map", () => {
  it("highlights unmapped accounts and masks the account numbers", async () => {
    await open();
    const c = card("Account map");
    const rows = await within(c).findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.className).not.toContain("mt-unmapped");
    expect(rows[1]?.className).toContain("mt-unmapped");
    expect(within(rows[1] as HTMLElement).getByText("Not matched until mapped")).toBeTruthy();
    expect(c.textContent).toContain("2819");
    expect(c.textContent).not.toContain("GB29");
  });

  it("saves one account with its journal and bank ledger account", async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      "PUT /api/matching/account-map": () => ({ body: accountMap() }),
    });
    const c = card("Account map");
    const rows = await within(c).findAllByRole("listitem");
    const row = rows[1] as HTMLElement;
    expect(within(row).queryByRole("button", { name: /Save/ })).toBeNull(); // nothing changed yet
    await user.selectOptions(within(row).getByLabelText("Administration"), "2");
    const save = within(row).getByRole("button", { name: "Save the mapping of Sterling" });
    expect((save as HTMLButtonElement).disabled).toBe(true); // journal and ledger account missing
    expect(within(row).getByRole("alert").textContent).toMatch(/Fill in the journal code/);
    await user.type(within(row).getByLabelText("Journal code"), "RB2");
    await user.type(within(row).getByLabelText("Bank ledger account"), "1220");
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(of(calls, "/api/matching/account-map", "PUT")).toHaveLength(1));
    expect(of(calls, "/api/matching/account-map", "PUT")[0]?.body).toEqual({
      bankAccountId: 2,
      divisionId: 2,
      journalCode: "RB2",
      bankGlAccountCode: "1220",
    });
    await waitFor(() => expect(of(calls, "/api/matching/account-map").length).toBeGreaterThan(1));
  });

  it("refuses a bad journal code before sending", async () => {
    const user = userEvent.setup();
    const { calls } = await open();
    const row = (await within(card("Account map")).findAllByRole("listitem"))[1] as HTMLElement;
    await user.selectOptions(within(row).getByLabelText("Administration"), "1");
    await user.type(within(row).getByLabelText("Journal code"), "bad code!");
    await user.type(within(row).getByLabelText("Bank ledger account"), "1220");
    expect(
      (
        within(row).getByRole("button", {
          name: "Save the mapping of Sterling",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(of(calls, "/api/matching/account-map", "PUT")).toHaveLength(0);
  });

  it("removing a mapping asks first and says what follows", async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      "PUT /api/matching/account-map": () => ({ body: accountMap() }),
    });
    const row = (await within(card("Account map")).findAllByRole("listitem"))[0] as HTMLElement;
    await user.selectOptions(within(row).getByLabelText("Administration"), "");
    await user.click(within(row).getByRole("button", { name: "Remove the mapping of Main EUR" }));
    expect(of(calls, "/api/matching/account-map", "PUT")).toHaveLength(0);
    expect(within(row).getByText(/will no longer be matched/)).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: "Yes, remove" }));
    await waitFor(() =>
      expect(of(calls, "/api/matching/account-map", "PUT")[0]?.body).toEqual({
        bankAccountId: 1,
        divisionId: null,
      }),
    );
  });

  it("explains live matches and asks for a sign-in", async () => {
    const user = userEvent.setup();
    let mode: "live" | "step" = "live";
    await open({
      "PUT /api/matching/account-map": () =>
        mode === "live" ? { status: 409, body: { error: "has_live_matches" } } : STEP_UP(),
    });
    const row = (await within(card("Account map")).findAllByRole("listitem"))[0] as HTMLElement;
    await user.selectOptions(within(row).getByLabelText("Administration"), "2");
    await user.click(within(row).getByRole("button", { name: "Save the mapping of Main EUR" }));
    expect(
      await within(row).findByText(/Undo them before changing its administration/),
    ).toBeTruthy();
    mode = "step";
    await user.click(within(row).getByRole("button", { name: "Save the mapping of Main EUR" }));
    expect(await within(row).findByText(/needs a Google sign-in/)).toBeTruthy();
  });
});

describe("thresholds", () => {
  it("shows the core rule in plain words and blocks saving until the values are valid", async () => {
    const user = userEvent.setup();
    const { calls } = await open({ "PUT /api/matching/config": () => ({ body: config() }) });
    const c = card("Matching thresholds");
    const score = within(c).getByLabelText(/Automatic match score/);
    const save = within(c).getByRole("button", { name: "Save thresholds" });
    expect((save as HTMLButtonElement).disabled).toBe(true); // nothing changed
    await user.clear(score);
    await user.type(score, "90");
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(c).getAllByText(/Automatic match score must be a whole number from 95 to 100/).length,
    ).toBeGreaterThan(0);
    await user.clear(score);
    await user.type(score, "97");
    const gap = within(c).getByLabelText(/Gap to the next candidate/);
    await user.clear(gap);
    await user.type(gap, "9");
    expect(
      within(c).getAllByText(/Gap to the next candidate must be a whole number from 10 to 100/)
        .length,
    ).toBeGreaterThan(0);
    await user.clear(gap);
    await user.type(gap, "30");
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(of(calls, "/api/matching/config", "PUT")).toHaveLength(1));
    expect(of(calls, "/api/matching/config", "PUT")[0]?.body).toEqual({
      config: {
        autoMatchMinScore: 97,
        autoMatchMinGap: 30,
        suggestMinScore: 50,
        maxCandidates: 5,
        amountToleranceMinor: 0,
        blockAutoOnRecentIbanChangeDays: 90,
        autoLedgerPatterns: false,
        autoTxTypes: ["transfer", "topup", "card_payment"],
        noMatchTxTypes: ["exchange"],
        internalAccountTypes: ["self"],
      },
    });
  });

  it("checks the suggestion score against the automatic score and the lists", async () => {
    const user = userEvent.setup();
    await open();
    const c = card("Matching thresholds");
    const sug = within(c).getByLabelText(/Suggestion score/);
    await user.clear(sug);
    await user.type(sug, "99");
    expect(
      within(c).getAllByText(
        /Suggestion score must be a whole number from 1 to the automatic match score/,
      ).length,
    ).toBeGreaterThan(0);
    await user.clear(sug);
    await user.type(sug, "50");
    const list = within(c).getByLabelText(/Types that may be automatic/);
    await user.clear(list);
    await user.type(list, "transfer, exchange");
    expect(within(c).getByRole("alert").textContent).toMatch(/both auto and no-match/);
    expect(
      (within(c).getByRole("button", { name: "Save thresholds" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("fills in the defaults without saving and needs a sign-in to save", async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      "GET /api/matching/config": () => ({
        body: config({ config: { ...config().config, autoMatchMinScore: 99 } }),
      }),
      "PUT /api/matching/config": STEP_UP,
    });
    const c = card("Matching thresholds");
    const score = within(c).getByLabelText(/Automatic match score/) as HTMLInputElement;
    expect(score.value).toBe("99");
    await user.click(within(c).getByRole("button", { name: "Fill in the defaults" }));
    expect(score.value).toBe("95");
    expect(of(calls, "/api/matching/config", "PUT")).toHaveLength(0);
    await user.click(within(c).getByRole("button", { name: "Save thresholds" }));
    expect(await within(c).findByText(/needs a Google sign-in/)).toBeTruthy();
  });

  it("says when the stored settings are not valid", async () => {
    await open({
      "GET /api/matching/config": () => ({
        body: config({ configErrors: ["autoMatchMinScore is bad"] }),
      }),
    });
    expect(
      await within(card("Matching thresholds")).findByText(/stored settings are not valid/),
    ).toBeTruthy();
    expect(
      (
        within(card("Automatic matching")).getByRole("button", {
          name: "Enable automatic matching…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("automatic matching switch", () => {
  it("enabling needs the typed phrase exactly and a fresh sign-in", async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => undefined);
    let step = true;
    const { calls } = await open({
      "PUT /api/matching/config": () =>
        step ? STEP_UP() : { body: config({ autoEnabled: true }) },
    });
    const c = card("Automatic matching");
    expect(norm(c.textContent)).toContain("Off. Every line waits in To review");
    await user.click(within(c).getByRole("button", { name: "Enable automatic matching…" }));
    const dialog = await screen.findByRole("dialog", { name: "Enable automatic matching" });
    const go = within(dialog).getByRole("button", { name: "Enable automatic matching" });
    const input = within(dialog).getByLabelText(`Type “${AUTO_MATCH_CONFIRM_PHRASE}” to confirm`);
    expect((go as HTMLButtonElement).disabled).toBe(true);
    for (const wrong of [
      AUTO_MATCH_CONFIRM_PHRASE.toLowerCase(),
      `${AUTO_MATCH_CONFIRM_PHRASE} `,
      AUTO_MATCH_CONFIRM_PHRASE.slice(0, -1),
      ` ${AUTO_MATCH_CONFIRM_PHRASE}`,
    ]) {
      await user.clear(input);
      await user.type(input, wrong);
      expect((go as HTMLButtonElement).disabled, wrong).toBe(true);
    }
    await user.clear(input);
    await user.type(input, AUTO_MATCH_CONFIRM_PHRASE);
    expect((go as HTMLButtonElement).disabled).toBe(false);
    await user.click(go);
    expect(await within(dialog).findByText(/Nothing was changed/)).toBeTruthy();
    expect(of(calls, "/api/matching/config", "PUT")[0]?.body).toEqual({
      autoEnabled: true,
      confirm: AUTO_MATCH_CONFIRM_PHRASE,
    });
    await user.click(within(dialog).getByRole("button", { name: "Sign in again" }));
    expect(assign).toHaveBeenCalled();
    step = false;
    await user.click(go);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(of(calls, "/api/matching/config").length).toBeGreaterThan(1));
  });

  it("uses the phrase the server sends", async () => {
    const user = userEvent.setup();
    await open({
      "GET /api/matching/config": () => ({ body: config({ autoConfirmPhrase: "TURN IT ON" }) }),
    });
    await user.click(
      within(card("Automatic matching")).getByRole("button", {
        name: "Enable automatic matching…",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Type “TURN IT ON” to confirm/), "TURN IT ON");
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Enable automatic matching",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("turning it off is immediate, needs no phrase, and is the only direction without a sheet", async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      "GET /api/matching/config": () => ({ body: config({ autoEnabled: true }) }),
      "POST /api/matching/auto/disable": () => ({ body: config({ autoEnabled: false }) }),
    });
    const c = card("Automatic matching");
    expect(within(c).getByText("On")).toBeTruthy();
    await user.click(within(c).getByRole("button", { name: "Turn off automatic matching" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(of(calls, "/api/matching/auto/disable", "POST")).toHaveLength(1));
    expect(of(calls, "/api/matching/auto/disable", "POST")[0]?.body).toEqual({});
    await waitFor(() => expect(of(calls, "/api/matching/config").length).toBeGreaterThan(1));
  });

  it("a refused enable says why", async () => {
    const user = userEvent.setup();
    await open({
      "PUT /api/matching/config": () => ({ status: 422, body: { error: "config_invalid" } }),
    });
    await user.click(
      within(card("Automatic matching")).getByRole("button", {
        name: "Enable automatic matching…",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/to confirm/), AUTO_MATCH_CONFIRM_PHRASE);
    await user.click(within(dialog).getByRole("button", { name: "Enable automatic matching" }));
    expect(await within(dialog).findByText(/stored matching settings are not valid/)).toBeTruthy();
  });
});

describe("ledger patterns", () => {
  it("lists patterns, adds one after validating the regex with the core subset", async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      "POST /api/matching/patterns": () => ({ status: 201, body: { pattern: pattern({ id: 2 }) } }),
    });
    const c = card("Ledger patterns");
    expect(await within(c).findByText("Bank costs")).toBeTruthy();
    expect(c.textContent).toContain("name matches ^revolut");
    await user.click(within(c).getByRole("button", { name: "Add pattern…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add ledger pattern" });
    const add = within(dialog).getByRole("button", { name: "Add pattern" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/^Name/), "Card fees");
    await user.type(within(dialog).getByLabelText(/Ledger account code/), "4510");
    const re = within(dialog).getByLabelText(/Counterparty name pattern/);
    await user.type(re, "(a+)+$");
    expect(await within(dialog).findByText(/repeated group contains another repeat/)).toBeTruthy();
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await user.clear(re);
    await user.type(re, "^stripe|^adyen");
    expect((add as HTMLButtonElement).disabled).toBe(false);
    // the test box uses the same safe matcher
    await user.type(within(dialog).getByLabelText("Text to test"), "Stripe Payments Europe");
    expect(within(dialog).getByText("matches")).toBeTruthy();
    await user.clear(within(dialog).getByLabelText("Text to test"));
    await user.type(within(dialog).getByLabelText("Text to test"), "Acme");
    expect(within(dialog).getByText("does not match")).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText("Direction"), "out");
    await user.click(add);
    await waitFor(() => expect(of(calls, "/api/matching/patterns", "POST")).toHaveLength(1));
    expect(of(calls, "/api/matching/patterns", "POST")[0]?.body).toEqual({
      name: "Card fees",
      ledgerAccountCode: "4510",
      counterpartyNameRegex: "^stripe|^adyen",
      referenceRegex: null,
      type: null,
      direction: "out",
      maxAmountMinor: null,
      enabled: true,
    });
    await waitFor(() => expect(of(calls, "/api/matching/patterns").length).toBeGreaterThan(1));
  });

  it("edits a pattern with its values filled in, and the sign-in is explained", async () => {
    const user = userEvent.setup();
    const { calls } = await open({ "PUT /api/matching/patterns/1": STEP_UP });
    const c = card("Ledger patterns");
    await user.click(await within(c).findByRole("button", { name: "Edit Bank costs" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit ledger pattern" });
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Bank costs");
    expect((within(dialog).getByLabelText(/Largest amount/) as HTMLInputElement).value).toBe(
      "2500",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save pattern" }));
    expect(await within(dialog).findByText(/Nothing was changed/)).toBeTruthy();
    expect(of(calls, "/api/matching/patterns/1", "PUT")).toHaveLength(1);
  });

  it("deleting asks first", async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      "DELETE /api/matching/patterns/1": () => ({ body: { deleted: true } }),
    });
    const c = card("Ledger patterns");
    await user.click(await within(c).findByRole("button", { name: "Delete Bank costs" }));
    expect(of(calls, "/api/matching/patterns/1", "DELETE")).toHaveLength(0);
    await user.click(within(c).getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => expect(of(calls, "/api/matching/patterns/1", "DELETE")).toHaveLength(1));
  });

  it("explains a pattern the server refuses, and an empty list", async () => {
    const user = userEvent.setup();
    await open({
      "GET /api/matching/patterns": () => ({ body: { patterns: [] } }),
      "POST /api/matching/patterns": () => ({
        status: 422,
        body: { error: "pattern_not_allowed" },
      }),
    });
    const c = card("Ledger patterns");
    expect(await within(c).findByText("No patterns yet.")).toBeTruthy();
    await user.click(within(c).getByRole("button", { name: "Add pattern…" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "X");
    await user.type(within(dialog).getByLabelText(/Ledger account code/), "1");
    await user.type(within(dialog).getByLabelText(/Payment type/), "fee");
    await user.click(within(dialog).getByRole("button", { name: "Add pattern" }));
    expect(await within(dialog).findByText(/outside the safe subset/)).toBeTruthy();
  });

  it("flags a stored pattern that the safe rules refuse now", async () => {
    await open({
      "GET /api/matching/patterns": () => ({
        body: { patterns: [pattern({ referenceRegex: "(?:a|aa)".repeat(20) })] },
      }),
    });
    const c = card("Ledger patterns");
    expect(await within(c).findByText(/outside the safe rules now/)).toBeTruthy();
  });

  it("a new pattern starts empty each time", async () => {
    const user = userEvent.setup();
    await open();
    const c = card("Ledger patterns");
    await user.click(await within(c).findByRole("button", { name: "Add pattern…" }));
    let dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "Leftover");
    await user.keyboard("{Escape}");
    // typed text: the sheet asks first (review M7d)
    await user.click(within(dialog).getByRole("button", { name: "Discard and close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(within(c).getByRole("button", { name: "Add pattern…" }));
    dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe("");
  });
});

describe("booking in Exact", () => {
  const verified = {
    at: "2026-11-05T10:00:00.000Z",
    by: "gerrie@camelthorncapital.com",
    note: "Booked a test invoice on the test division",
    protocolVersion: "2026-11-a",
  };

  it("Off: not switched on and not verified yet", async () => {
    await open();
    const c = card("Booking in Exact");
    expect(await within(c).findByText("Off", { selector: ".chip" })).toBeTruthy();
    expect(within(c).getByText("Not verified yet")).toBeTruthy();
    expect(
      (within(c).getByRole("button", { name: "Enable booking…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(c).getByText(/Verify the write path first/)).toBeTruthy();
    expect(
      within(c).getByText("This app creates the bank entries in Exact, then matches them."),
    ).toBeTruthy();
  });

  it("Off with blockers: lists them in plain words, warns when the write format changed, cannot enable", async () => {
    await open({
      "GET /api/booking/settings": () => ({
        body: booking({
          verified,
          protocolChanged: true,
          blockers: ["protocol_changed", "bank_entries_undecided", "something_new"],
          createsBankEntries: null,
        }),
      }),
    });
    const c = card("Booking in Exact");
    expect(await within(c).findByText("Off", { selector: ".chip" })).toBeTruthy();
    expect(
      within(c).getByText("The Exact write format changed since it was verified. Verify it again."),
    ).toBeTruthy();
    expect(
      within(c).getByText(/The Exact write format changed since you verified it/),
    ).toBeTruthy();
    expect(within(c).getByText(/not decided who creates the bank entries/)).toBeTruthy();
    expect(within(c).getByText(BLOCKER_FALLBACK)).toBeTruthy();
    expect(c.textContent).not.toContain("something_new");
    expect(
      (within(c).getByRole("button", { name: "Enable booking…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("On but blocked: the chip says Blocked and Disable is still offered", async () => {
    await open({
      "GET /api/booking/settings": () => ({
        body: booking({ enabled: true, verified, blockers: ["no_exact_connection"] }),
      }),
    });
    const c = card("Booking in Exact");
    expect(await within(c).findByText("Blocked")).toBeTruthy();
    expect(within(c).getByText(/Exact is not connected/)).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Disable booking" })).toBeTruthy();
  });

  it("Ready: shows who verified it and offers Disable", async () => {
    await open({
      "GET /api/booking/settings": () => ({ body: booking({ enabled: true, verified }) }),
    });
    const c = card("Booking in Exact");
    expect(await within(c).findByText("Ready")).toBeTruthy();
    expect(c.textContent).toContain("Verified by gerrie@camelthorncapital.com on 5 Nov 2026");
    expect(c.textContent).toContain("Booked a test invoice on the test division");
    expect(within(c).getByRole("button", { name: "Disable booking" })).toBeTruthy();
    expect(within(c).queryByRole("button", { name: "Enable booking…" })).toBeNull();
  });

  it("verifying needs a note, the exact phrase and a fresh sign-in", async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      "POST /api/booking/verify": (c) =>
        (c.body as { confirm: string }).confirm ? STEP_UP() : { status: 422, body: { error: "x" } },
    });
    const c = card("Booking in Exact");
    await user.click(await within(c).findByRole("button", { name: "Verify write path…" }));
    const dialog = await screen.findByRole("dialog", { name: "Verify the Exact write path" });
    const go = within(dialog).getByRole("button", { name: "Record the verification" });
    const phrase = BOOKING_VERIFY_PHRASE;
    const input = within(dialog).getByLabelText(`Type “${phrase}” to confirm`);
    await user.type(input, phrase);
    expect((go as HTMLButtonElement).disabled).toBe(true); // note still empty
    await user.type(within(dialog).getByLabelText(/What did you check/), "Test invoice booked");
    expect((go as HTMLButtonElement).disabled).toBe(false);
    await user.clear(input);
    await user.type(input, phrase.toLowerCase());
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await user.clear(input);
    await user.type(input, phrase);
    await user.click(go);
    expect(await within(dialog).findByText(/Nothing was changed/)).toBeTruthy();
    expect(of(calls, "/api/booking/verify", "POST")[0]?.body).toEqual({
      note: "Test invoice booked",
      confirm: phrase,
    });
  });

  it("enabling needs ENABLE EXACT BOOKING typed exactly; disabling is immediate", async () => {
    const user = userEvent.setup();
    let enabled = false;
    const { calls } = await open({
      "GET /api/booking/settings": () => ({ body: booking({ enabled, verified }) }),
      "PUT /api/booking/settings": (c) => {
        enabled = (c.body as { enabled: boolean }).enabled;
        return { body: booking({ enabled, verified }) };
      },
    });
    const c = card("Booking in Exact");
    await user.click(await within(c).findByRole("button", { name: "Enable booking…" }));
    const dialog = await screen.findByRole("dialog", { name: "Enable booking in Exact" });
    const go = within(dialog).getByRole("button", { name: "Enable booking" });
    const input = within(dialog).getByLabelText(`Type “${BOOKING_ENABLE_PHRASE}” to confirm`);
    expect((go as HTMLButtonElement).disabled).toBe(true);
    for (const near of [
      BOOKING_ENABLE_PHRASE.slice(0, -1),
      BOOKING_ENABLE_PHRASE.toLowerCase(),
      ` ${BOOKING_ENABLE_PHRASE}`,
      `${BOOKING_ENABLE_PHRASE} `,
      BOOKING_ENABLE_PHRASE.replace(" ", "  "),
    ]) {
      await user.clear(input);
      await user.type(input, near);
      expect((go as HTMLButtonElement).disabled, JSON.stringify(near)).toBe(true);
    }
    await user.clear(input);
    await user.type(input, BOOKING_ENABLE_PHRASE);
    expect((go as HTMLButtonElement).disabled).toBe(false);
    await user.click(go);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(of(calls, "/api/booking/settings", "PUT")[0]?.body).toEqual({
      enabled: true,
      confirm: BOOKING_ENABLE_PHRASE,
    });
    expect(await within(c).findByText("Ready")).toBeTruthy();
    await user.click(within(c).getByRole("button", { name: "Disable booking" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(of(calls, "/api/booking/settings", "PUT")).toHaveLength(2));
    // Switching off sends no phrase and needs no fresh sign-in (orchestrator decision M7d).
    expect(of(calls, "/api/booking/settings", "PUT")[1]?.body).toEqual({ enabled: false });
    expect(await within(c).findByText("Off", { selector: ".chip" })).toBeTruthy();
  });

  it("explains a refused enable", async () => {
    const user = userEvent.setup();
    await open({
      "GET /api/booking/settings": () => ({ body: booking({ verified }) }),
      "PUT /api/booking/settings": () => ({ status: 409, body: { error: "blocked" } }),
    });
    await user.click(
      await within(card("Booking in Exact")).findByRole("button", { name: "Enable booking…" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/to confirm/), BOOKING_ENABLE_PHRASE);
    await user.click(within(dialog).getByRole("button", { name: "Enable booking" }));
    expect(
      await within(dialog).findByText(/cannot be switched on until the listed blockers/),
    ).toBeTruthy();
  });
});

describe("booking queue", () => {
  const items = [
    outboxItem({ id: 1, status: "failed" }),
    outboxItem({ id: 2, status: "verified", exactRef: "BK-2", lastErrorCode: null, attempts: 1 }),
    outboxItem({ id: 3, status: "outcome_unknown", counterpartyName: "Unknown Co" }),
  ];

  it("shows counts, status chips with what they mean, and actions only where they help", async () => {
    await open({
      "GET /api/booking/outbox": () => ({
        body: outbox(items, { failed: 1, verified: 1, outcome_unknown: 1 }),
      }),
    });
    const c = card("Booking in Exact");
    const t = await within(c).findByRole("table", { name: "Booking queue" });
    await within(t).findAllByText("Failed");
    const counts = within(c).getByRole("list", { name: "Counts by status" });
    expect(norm(counts.textContent)).toContain("Failed 1");
    expect(norm(counts.textContent)).toContain("Booked 1");
    expect(norm(counts.textContent)).toContain("Outcome unknown 1");
    expect(t.textContent).toContain("Exact refused it. Nothing was booked.");
    expect(t.textContent).toContain("We could not tell whether Exact booked it");
    expect(t.textContent).toContain("Exact reference BK-2");
    expect(t.textContent).toContain("Error code: exact_rejected");
    const rows = within(t).getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: /Retry/ })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole("button")).toBeNull(); // booked: nothing to do
    expect(within(rows[2] as HTMLElement).getAllByRole("button")).toHaveLength(3);
  });

  it("resolving needs a note and a confirmation, then the queue is refreshed", async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      "POST /api/booking/outbox/1/resolve": () => ({ body: {} }),
    });
    const c = card("Booking in Exact");
    const t = await within(c).findByRole("table", { name: "Booking queue" });
    await user.click(await within(t).findByRole("button", { name: "Booked manually: Paper Co" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark as booked manually" });
    const go = within(dialog).getByRole("button", { name: "Booked manually" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText("Note (required)"), "Booked in Exact on 10 Nov");
    expect((go as HTMLButtonElement).disabled).toBe(false);
    expect(of(calls, "/api/booking/outbox/1/resolve", "POST")).toHaveLength(0);
    await user.click(go);
    await waitFor(() => expect(of(calls, "/api/booking/outbox/1/resolve", "POST")).toHaveLength(1));
    expect(of(calls, "/api/booking/outbox/1/resolve", "POST")[0]?.body).toEqual({
      resolution: "booked_manually",
      note: "Booked in Exact on 10 Nov",
    });
    await waitFor(() => expect(of(calls, "/api/booking/outbox").length).toBeGreaterThan(1));
  });

  it("Retry warns about double booking, and Give up says Exact is untouched; a step-up is explained", async () => {
    const user = userEvent.setup();
    await open({ "POST /api/booking/outbox/1/resolve": STEP_UP });
    const c = card("Booking in Exact");
    const t = await within(c).findByRole("table", { name: "Booking queue" });
    await user.click(await within(t).findByRole("button", { name: "Retry: Paper Co" }));
    let dialog = await screen.findByRole("dialog", { name: "Retry booking in Exact" });
    expect(dialog.textContent).toContain("it may be booked twice");
    await user.type(within(dialog).getByLabelText("Note (required)"), "Checked, not there");
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText(/Nothing was changed/)).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(within(t).getByRole("button", { name: "Give up: Paper Co" }));
    dialog = await screen.findByRole("dialog", { name: "Give up booking" });
    expect(dialog.textContent).toContain("Exact is not changed");
  });

  it("filters by status and shows an empty and an error state", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base({
        "GET /api/booking/outbox": (cl) =>
          new URL(cl.url, "http://x").searchParams.get("status") === "manual_required"
            ? { body: outbox([], {}) }
            : { body: outbox() },
      }),
    );
    renderApp("/settings/matching");
    const c = await screen
      .findByRole("heading", { level: 2, name: "Booking in Exact" })
      .then((h) => h.closest(".card") as HTMLElement);
    await within(c).findByRole("table", { name: "Booking queue" });
    await user.selectOptions(within(c).getByLabelText("Show"), "manual_required");
    expect(await within(c).findByText("Nothing in the booking queue.")).toBeTruthy();
    expect(
      new URL(of(calls, "/api/booking/outbox").at(-1)?.url ?? "", "http://x").searchParams.get(
        "status",
      ),
    ).toBe("manual_required");
  });

  it("an unreadable queue says so without hiding the settings", async () => {
    await open({ "GET /api/booking/outbox": () => ({ status: 500, body: { error: "x" } }) });
    const c = card("Booking in Exact");
    expect(await within(c).findByText(/Could not load this data/)).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Verify write path…" })).toBeTruthy();
  });
});
