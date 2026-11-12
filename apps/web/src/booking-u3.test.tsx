/**
 * Phase 7 final-review fixes, web part (U3): the verification checklist (S7), the booking preview
 * and the enable dialog (S8, B2), control accounts and the opening balance in the account map (B1),
 * blocker and deferral wording, and the lazy-loaded screens (N9).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import {
  BOOKING_ENABLE_PHRASE,
  BOOKING_VERIFY_CHECKS,
  BOOKING_VERIFY_PHRASE,
} from "@camelthorn/core";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import type { Me } from "./api";
import {
  accountMap,
  autoItem,
  booking,
  config,
  detail,
  match,
  outbox,
  pattern,
  previewItem,
  stats,
} from "./test-fixtures-matching";
import { accounts } from "./test-fixtures-bank";
import { VERIFY_CHECK_TEXT } from "./lib/matching-labels";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const FINANCE: Me = { ...ADMIN, email: "f@camelthorncapital.com", roles: ["finance"] };
const of = (calls: Call[], path: string, method = "GET") =>
  calls.filter((c) => c.method === method && c.url.split("?")[0] === path);
const STEP_UP = () => ({ status: 401, body: { error: "step_up_required" } });

type H = Record<string, (c: Call) => { status?: number; body?: unknown }>;
function base(over: H = {}, me: Me = ADMIN): H {
  return {
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/matching/stats": () => ({ body: stats() }),
    "GET /api/matching/config": () => ({ body: config() }),
    "GET /api/matching/account-map": () => ({ body: accountMap() }),
    "GET /api/matching/patterns": () => ({ body: { patterns: [pattern()] } }),
    "GET /api/matching/auto": () => ({ body: { items: [autoItem()], nextCursor: null } }),
    "GET /api/booking/settings": () => ({ body: booking() }),
    "GET /api/booking/outbox": () => ({ body: outbox() }),
    ...over,
  };
}
afterEach(() => vi.restoreAllMocks());

function card(name: string): HTMLElement {
  return screen.getByRole("heading", { level: 2, name }).closest(".card") as HTMLElement;
}
async function openSettings(over: H = {}, me: Me = ADMIN) {
  const calls = mockFetch(base(over, me));
  const view = renderApp("/settings/matching");
  await screen.findByRole("heading", { level: 2, name: "Booking in Exact" });
  return { calls, view };
}

const VERIFIED = {
  at: "2026-11-05T10:00:00.000Z",
  by: "gerrie@camelthorncapital.com",
  note: "Booked a test invoice",
  protocolVersion: "2026-11-a",
};

// ---- S7: verification checklist -----------------------------------------------------------------

describe("verify dialog: one tick box per check", () => {
  async function openVerify(over: H = {}) {
    const user = userEvent.setup();
    const r = await openSettings(over);
    await user.click(
      await within(card("Booking in Exact")).findByRole("button", { name: "Verify write path…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Verify the Exact write path" });
    return { user, dialog, ...r };
  }

  it("shows every check of core with its instruction", async () => {
    const { dialog } = await openVerify();
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(BOOKING_VERIFY_CHECKS.length);
    for (const c of BOOKING_VERIFY_CHECKS) {
      expect(
        within(dialog).getByRole("checkbox", { name: new RegExp(VERIFY_CHECK_TEXT[c].label) }),
      ).toBeTruthy();
      expect(dialog.textContent).toContain(VERIFY_CHECK_TEXT[c].how);
    }
    expect(dialog.textContent).toContain("0 of 7");
  });

  it("stays disabled until ALL boxes are ticked, the phrase matches and the note is filled in", async () => {
    const { user, dialog } = await openVerify();
    const go = within(dialog).getByRole("button", {
      name: "Record the verification",
    }) as HTMLButtonElement;
    await user.type(
      within(dialog).getByLabelText(`Type “${BOOKING_VERIFY_PHRASE}” to confirm`),
      BOOKING_VERIFY_PHRASE,
    );
    await user.type(
      within(dialog).getByLabelText(/What did you check/),
      "All seven done on the test division",
    );
    const boxes = within(dialog).getAllByRole("checkbox");
    for (const [i, box] of boxes.entries()) {
      expect(go.disabled, `after ${i} boxes`).toBe(true);
      await user.click(box);
    }
    expect(go.disabled).toBe(false);
    expect(dialog.textContent).toContain("7 of 7");
    await user.click(boxes[3] as HTMLElement); // untick one
    expect(go.disabled).toBe(true);
    await user.click(boxes[3] as HTMLElement);
    expect(go.disabled).toBe(false);
    // the note is required as before
    await user.clear(within(dialog).getByLabelText(/What did you check/));
    expect(go.disabled).toBe(true);
  });

  it("sends the ticked checks in canonical order, whatever order they were ticked in", async () => {
    const { user, dialog, calls } = await openVerify({
      "POST /api/booking/verify": () => ({ body: booking({ verified: VERIFIED }) }),
    });
    for (const box of [...within(dialog).getAllByRole("checkbox")].reverse()) {
      await user.click(box);
    }
    await user.type(
      within(dialog).getByLabelText(`Type “${BOOKING_VERIFY_PHRASE}” to confirm`),
      BOOKING_VERIFY_PHRASE,
    );
    await user.type(within(dialog).getByLabelText(/What did you check/), "Done on test division");
    await user.click(within(dialog).getByRole("button", { name: "Record the verification" }));
    await waitFor(() => expect(of(calls, "/api/booking/verify", "POST")).toHaveLength(1));
    expect(of(calls, "/api/booking/verify", "POST")[0]?.body).toEqual({
      note: "Done on test division",
      confirm: BOOKING_VERIFY_PHRASE,
      checks: [...BOOKING_VERIFY_CHECKS],
    });
  });

  it("maps a server answer of checks_incomplete to a sentence", async () => {
    const { user, dialog } = await openVerify({
      "POST /api/booking/verify": () => ({ status: 400, body: { error: "checks_incomplete" } }),
    });
    for (const box of within(dialog).getAllByRole("checkbox")) await user.click(box);
    await user.type(
      within(dialog).getByLabelText(`Type “${BOOKING_VERIFY_PHRASE}” to confirm`),
      BOOKING_VERIFY_PHRASE,
    );
    await user.type(within(dialog).getByLabelText(/What did you check/), "Done on test division");
    await user.click(within(dialog).getByRole("button", { name: "Record the verification" }));
    expect(await within(dialog).findByText(/Tick every check first/)).toBeTruthy();
    expect(dialog.textContent).not.toContain("checks_incomplete");
  });

  it("has no axe violations", async () => {
    const { dialog } = await openVerify();
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it("says what verifying means and which mode it is for", async () => {
    const { dialog } = await openVerify();
    expect(dialog.textContent).toContain(
      "You are confirming that you posted the same bodies that Preview booking shows by hand on a TEST administration",
    );
    expect(dialog.textContent).toContain("Nothing is sent to Exact by this dialog");
    expect(dialog.textContent).toContain(
      "Verified for: this app creates the bank entries in Exact, then matches them",
    );
  });

  it("needs a note of at least 10 characters (the server's bound) and allows up to 500", async () => {
    const { user, dialog } = await openVerify();
    for (const box of within(dialog).getAllByRole("checkbox")) await user.click(box);
    await user.type(within(dialog).getByLabelText(/to confirm/), BOOKING_VERIFY_PHRASE);
    const go = within(dialog).getByRole("button", {
      name: "Record the verification",
    }) as HTMLButtonElement;
    const note = within(dialog).getByLabelText(/What did you check/) as HTMLTextAreaElement;
    await user.type(note, "Too short");
    expect(go.disabled).toBe(true);
    expect(within(dialog).getByText("Write at least 10 characters.")).toBeTruthy();
    await user.type(note, "!");
    expect(go.disabled).toBe(false);
    expect(note.maxLength).toBe(500);
  });

  it("cannot verify while the mode is undecided, and warns about another mode, a new format and a running switch", async () => {
    const a = await openVerify({
      "GET /api/booking/settings": () => ({ body: booking({ createsBankEntries: null }) }),
    });
    for (const box of within(a.dialog).getAllByRole("checkbox")) await a.user.click(box);
    await a.user.type(within(a.dialog).getByLabelText(/to confirm/), BOOKING_VERIFY_PHRASE);
    await a.user.type(
      within(a.dialog).getByLabelText(/What did you check/),
      "Done on test division",
    );
    expect(a.dialog.textContent).toContain("Decide first who creates the bank entries");
    expect(
      (
        within(a.dialog).getByRole("button", {
          name: "Record the verification",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    a.view.unmount();
    const b = await openVerify({
      "GET /api/booking/settings": () => ({
        body: booking({
          enabled: true,
          protocolChanged: true,
          divisions: [1],
          verified: { ...VERIFIED, checks: [...BOOKING_VERIFY_CHECKS], createsBankEntries: false },
        }),
      }),
    });
    expect(b.dialog.textContent).toContain("The earlier verification was done for another mode");
    expect(b.dialog.textContent).toContain("The Exact write format changed");
    expect(b.dialog.textContent).toContain("Recording a verification switches it off");
  });

  it("the verification card shows the ticked checks and the mode it was verified for", async () => {
    await openSettings({
      "GET /api/booking/settings": () => ({
        body: booking({
          verified: {
            ...VERIFIED,
            checks: [...BOOKING_VERIFY_CHECKS],
            createsBankEntries: true,
          },
        }),
      }),
    });
    const c = card("Booking in Exact");
    const list = await within(c).findByRole("list", { name: "Checks ticked at verification" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(BOOKING_VERIFY_CHECKS.length);
    expect(list.textContent).toContain(VERIFY_CHECK_TEXT.balance_chain.label);
    expect(c.textContent).toContain("Mode: this app creates the bank entries");
    expect(c.textContent).not.toContain("so verify again");
  });

  it("says so when the verified mode differs from the current mode, and never shows a raw code", async () => {
    await openSettings({
      "GET /api/booking/settings": () => ({
        body: booking({
          verified: { ...VERIFIED, checks: ["future_check"], createsBankEntries: false },
          createsBankEntries: true,
          blockers: ["mode_changed"],
        }),
      }),
    });
    const c = card("Booking in Exact");
    expect(await within(c).findByText(/this differs from the current setting/i)).toBeTruthy();
    expect(c.textContent).toContain("A check this version does not know");
    expect(c.textContent).not.toContain("future_check");
    expect(c.textContent).toContain("Who creates the bank entries changed since you verified");
  });
});

// ---- blockers -------------------------------------------------------------------------------------

describe("booking blockers in plain words", () => {
  it("explains the four new blockers and still the earlier ones", async () => {
    await openSettings({
      "GET /api/booking/settings": () => ({
        body: booking({
          verified: VERIFIED,
          blockers: [
            "control_accounts_missing",
            "journal_unmapped",
            "no_division_allowed",
            "mode_changed",
            "not_verified",
            "something_new",
          ],
        }),
      }),
    });
    const c = card("Booking in Exact");
    await within(c).findByText(/Booking cannot be switched on until this is fixed/);
    expect(within(c).getByText(/no debtors or creditors control account/)).toBeTruthy();
    expect(within(c).getByText(/no Exact journal or bank ledger account/)).toBeTruthy();
    expect(within(c).getByText(/No administration is allowed for booking/)).toBeTruthy();
    expect(within(c).getByText(/Who creates the bank entries changed/)).toBeTruthy();
    expect(within(c).getByText(/has not been verified/)).toBeTruthy();
    expect(c.textContent).not.toMatch(/control_accounts_missing|mode_changed|something_new/);
  });
});

// ---- S8, B2: enable dialog ---------------------------------------------------------------------

describe("enable dialog: watermark, backlog, administrations, matches per run", () => {
  const READY = () => booking({ verified: VERIFIED });
  async function openEnable(over: H = {}, settings = READY()) {
    const user = userEvent.setup();
    const r = await openSettings({
      "GET /api/booking/settings": () => ({ body: settings }),
      ...over,
    });
    await user.click(
      await within(card("Booking in Exact")).findByRole("button", { name: "Enable booking…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Enable booking in Exact" });
    return { user, dialog, ...r };
  }
  async function fill(
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
    names: string[],
  ) {
    for (const n of names)
      await user.click(await within(dialog).findByRole("checkbox", { name: n }));
    await user.type(within(dialog).getByLabelText(/to confirm/), BOOKING_ENABLE_PHRASE);
  }

  it("states that the server sets the watermark at the switch-on, and what stays behind", async () => {
    const { dialog } = await openEnable(
      {},
      booking({ verified: VERIFIED, backlogIfEnabledNow: 12 }),
    );
    expect(
      within(dialog).getByText(
        /Only matches made from the moment you press Enable booking are booked/,
      ),
    ).toBeTruthy();
    expect(dialog.textContent).toContain("12 existing matches will NOT be booked");
    expect(dialog.textContent).toContain("The server records that moment");
  });

  it("uses what switching on NOW leaves behind, not the backlog of an older watermark", async () => {
    const { dialog } = await openEnable(
      {},
      booking({
        verified: VERIFIED,
        bookingFrom: "2026-11-01T00:00:00.000Z",
        backlogCount: 1,
        backlogIfEnabledNow: 7,
      }),
    );
    expect(dialog.textContent).toContain("7 existing matches will NOT be booked");
  });

  it("says when nothing is left behind, and uses the singular", async () => {
    const a = await openEnable({}, booking({ verified: VERIFIED, backlogIfEnabledNow: 0 }));
    expect(a.dialog.textContent).toContain("no existing matches that stay behind");
    a.view.unmount();
    const b = await openEnable({}, booking({ verified: VERIFIED, backlogIfEnabledNow: 1 }));
    expect(b.dialog.textContent).toContain("1 existing match will NOT be booked");
  });

  it("requires an administration, defaults to one per run, saves the limits, re-reads, then switches on", async () => {
    let enabled = false;
    const { user, dialog, calls } = await openEnable({
      "GET /api/booking/settings": () => ({
        body: enabled
          ? booking({
              enabled: true,
              verified: VERIFIED,
              divisions: [1, 2],
              maxPerRun: 5,
              bookingFrom: "2026-11-11T09:00:00.000Z",
            })
          : READY(),
      }),
      "PUT /api/booking/settings": (c) => {
        if ((c.body as { enabled?: boolean }).enabled === true) enabled = true;
        return {
          body: booking({
            enabled,
            verified: VERIFIED,
            divisions: [1, 2],
            maxPerRun: 5,
            ...(enabled ? { bookingFrom: "2026-11-11T09:00:00.000Z" } : {}),
          }),
        };
      },
    });
    const go = within(dialog).getByRole("button", { name: "Enable booking" }) as HTMLButtonElement;
    await user.type(within(dialog).getByLabelText(/to confirm/), BOOKING_ENABLE_PHRASE);
    expect(go.disabled).toBe(true); // phrase typed, but no administration picked
    expect(await within(dialog).findByText("Pick at least one administration.")).toBeTruthy();
    const perRun = within(dialog).getByLabelText("Matches booked per run") as HTMLSelectElement;
    expect(perRun.value).toBe("1");
    expect([...perRun.options].map((o) => o.value)).toEqual(["1", "2", "3", "5", "10"]);
    await user.click(await within(dialog).findByRole("checkbox", { name: "Camelthorn Holding" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Camelthorn B.V." }));
    expect(go.disabled).toBe(false);
    await user.selectOptions(perRun, "5");
    expect(within(dialog).getByText(/Raising this from 1 to 5/)).toBeTruthy();
    const getsBefore = of(calls, "/api/booking/settings").length;
    await user.click(go);
    await waitFor(() => expect(of(calls, "/api/booking/settings", "PUT")).toHaveLength(2));
    const puts = of(calls, "/api/booking/settings", "PUT").map((c) => c.body);
    // the two shapes the server takes, never mixed, limits first; no client-chosen watermark
    expect(puts).toEqual([
      { divisions: [1, 2], maxPerRun: 5 },
      { enabled: true, confirm: BOOKING_ENABLE_PHRASE },
    ]);
    // a fresh read happened between opening and the first write
    const order = calls.filter((c) => c.url.split("?")[0] === "/api/booking/settings");
    const firstPut = order.findIndex((c) => c.method === "PUT");
    expect(order.slice(getsBefore, firstPut).some((c) => c.method === "GET")).toBe(true);
    expect(await screen.findByText(/Booking in Exact is on for matches made from/)).toBeTruthy();
  });

  it("sends no limits call when they are unchanged", async () => {
    const { user, dialog, calls } = await openEnable(
      {
        "PUT /api/booking/settings": () => ({
          body: booking({ enabled: true, verified: VERIFIED, divisions: [1] }),
        }),
      },
      booking({ verified: VERIFIED, divisions: [1] }),
    );
    // the saved allow-list is pre-ticked
    expect(
      (
        (await within(dialog).findByRole("checkbox", {
          name: "Camelthorn B.V.",
        })) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await user.type(within(dialog).getByLabelText(/to confirm/), BOOKING_ENABLE_PHRASE);
    await user.click(within(dialog).getByRole("button", { name: "Enable booking" }));
    await waitFor(() => expect(of(calls, "/api/booking/settings", "PUT")).toHaveLength(1));
    expect(of(calls, "/api/booking/settings", "PUT")[0]?.body).toEqual({
      enabled: true,
      confirm: BOOKING_ENABLE_PHRASE,
    });
  });

  it("drops a saved administration that is not shown, and says so", async () => {
    const { dialog } = await openEnable({}, booking({ verified: VERIFIED, divisions: [1, 99] }));
    expect(
      await within(dialog).findByText(/1 administration on the saved list is not available/),
    ).toBeTruthy();
  });

  it("refuses to enable from a stale form when a blocker appeared meanwhile", async () => {
    let reads = 0;
    const { user, dialog, calls } = await openEnable({
      "GET /api/booking/settings": () => {
        reads += 1;
        return {
          body:
            reads <= 1
              ? READY()
              : booking({
                  verified: VERIFIED,
                  blockers: ["no_exact_connection", "writes_disabled"],
                }),
        };
      },
    });
    await fill(user, dialog, ["Camelthorn B.V."]);
    await user.click(within(dialog).getByRole("button", { name: "Enable booking" }));
    expect(
      await within(dialog).findByText(/Something changed since this dialog opened/),
    ).toBeTruthy();
    expect(of(calls, "/api/booking/settings", "PUT")).toHaveLength(0);
  });

  it("a server refusal (blocked) is explained and the card is refreshed", async () => {
    const { user, dialog, calls } = await openEnable({
      "PUT /api/booking/settings": (c) =>
        (c.body as { enabled?: boolean }).enabled === true
          ? { status: 409, body: { error: "blocked", blockers: ["no_exact_connection"] } }
          : { body: booking({ verified: VERIFIED, divisions: [1] }) },
    });
    await fill(user, dialog, ["Camelthorn B.V."]);
    const getsBefore = of(calls, "/api/booking/settings").length;
    await user.click(within(dialog).getByRole("button", { name: "Enable booking" }));
    expect(await within(dialog).findByText(/until the listed blockers are fixed/)).toBeTruthy();
    await waitFor(() =>
      expect(of(calls, "/api/booking/settings").length).toBeGreaterThan(getsBefore + 1),
    );
  });

  it("the Enable button is available when only the switch and the allow-list are missing", async () => {
    await openSettings({ "GET /api/booking/settings": () => ({ body: READY() }) });
    const c = card("Booking in Exact");
    const btn = await within(c).findByRole("button", { name: "Enable booking…" });
    expect(READY().blockers).toEqual(["no_division_allowed", "writes_disabled"]);
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    // "switched off" is not listed as something to fix while it is off
    expect(c.textContent).not.toContain("Booking in Exact is switched off.");
  });

  it("keeps Enable disabled for any other blocker and says why", async () => {
    for (const blocker of [
      "control_accounts_missing",
      "journal_unmapped",
      "no_exact_connection",
      "something_new",
    ]) {
      const { view } = await openSettings({
        "GET /api/booking/settings": () => ({
          body: booking({ verified: VERIFIED, blockers: [blocker, "writes_disabled"] }),
        }),
      });
      const c = card("Booking in Exact");
      const btn = (await within(c).findByRole("button", {
        name: "Enable booking…",
      })) as HTMLButtonElement;
      expect(btn.disabled, blocker).toBe(true);
      expect(btn.getAttribute("aria-describedby")).toBe("booking-enable-why");
      expect(c.textContent).toContain("Enable is available once everything listed above is fixed.");
      view.unmount();
    }
  });

  it("while on, an enable-only blocker is shown as affecting single matches, not as stopping booking", async () => {
    await openSettings({
      "GET /api/booking/settings": () => ({
        body: booking({
          enabled: true,
          verified: VERIFIED,
          divisions: [1],
          bookingFrom: "2026-11-10T08:00:00.000Z",
          blockers: ["control_accounts_missing"],
        }),
      }),
    });
    const c = card("Booking in Exact");
    expect(await within(c).findByText("Ready")).toBeTruthy();
    expect(c.textContent).toContain("Booking is on, but this needs fixing:");
    expect(c.textContent).toContain("the others are still booked");
  });

  it("a missing fresh sign-in is explained and nothing is switched on", async () => {
    const { user, dialog, calls } = await openEnable({ "PUT /api/booking/settings": STEP_UP });
    await fill(user, dialog, ["Camelthorn B.V."]);
    await user.click(within(dialog).getByRole("button", { name: "Enable booking" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      /needs a Google sign-in/,
    );
    // the limits call asked for the sign-in; the switch was never sent
    expect(
      of(calls, "/api/booking/settings", "PUT").filter(
        (c) => (c.body as { enabled?: boolean }).enabled === true,
      ),
    ).toHaveLength(0);
  });

  it("asks before closing once something was picked (Escape)", async () => {
    const { user, dialog } = await openEnable();
    await user.click(await within(dialog).findByRole("checkbox", { name: "Camelthorn B.V." }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Enable booking in Exact" })).toBeTruthy();
  });

  it("shows the watermark, backlog, administrations and per-run number on the card when set", async () => {
    await openSettings({
      "GET /api/booking/settings": () => ({
        body: booking({
          enabled: true,
          verified: VERIFIED,
          bookingFrom: "2026-11-10T08:00:00.000Z",
          backlogCount: 3,
          divisions: [1],
          maxPerRun: 1,
        }),
      }),
    });
    const c = card("Booking in Exact");
    expect(await within(c).findByText(/Only matches made after .+ are booked/)).toBeTruthy();
    expect(c.textContent).toContain("3 existing matches made before that will NOT be booked");
    expect(c.textContent).toContain("1 administration");
  });

  it("has no axe violations", async () => {
    const { dialog } = await openEnable();
    await within(dialog).findByRole("checkbox", { name: "Camelthorn B.V." });
    expect(await axe(dialog)).toHaveNoViolations();
  });
});

// ---- S8: preview -----------------------------------------------------------------------------------

describe("preview booking", () => {
  const items = [1, 2, 3, 4].map((i) =>
    autoItem({ id: 50 + i }, { id: i, counterpartyName: `Customer ${i}` }),
  );
  async function openPreview(over: H = {}) {
    const user = userEvent.setup();
    const r = await openSettings({
      "GET /api/matching/auto": () => ({ body: { items, nextCursor: null } }),
      ...over,
    });
    await user.click(
      await within(card("Booking in Exact")).findByRole("button", { name: "Preview booking…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Preview booking" });
    return { user, dialog, ...r };
  }

  it("says up front that nothing is sent, and lists live matches that are not booked", async () => {
    const { dialog } = await openPreview({
      "GET /api/matching/auto": () => ({
        body: {
          items: [
            ...items.slice(0, 2),
            autoItem({ id: 90, exactState: "booked" }, { id: 9, counterpartyName: "Booked Co" }),
            autoItem({ id: 91, status: "undone" }, { id: 8, counterpartyName: "Undone Co" }),
          ],
          nextCursor: null,
        },
      }),
    });
    expect(within(dialog).getByText("Nothing was sent to Exact.")).toBeTruthy();
    expect(await within(dialog).findAllByRole("checkbox")).toHaveLength(2);
    expect(dialog.textContent).not.toContain("Booked Co");
    expect(dialog.textContent).not.toContain("Undone Co");
    expect(
      (within(dialog).getByRole("button", { name: "Preview booking" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("allows at most three matches", async () => {
    const { user, dialog } = await openPreview();
    const boxes = await within(dialog).findAllByRole("checkbox");
    for (const b of boxes.slice(0, 3)) await user.click(b);
    expect((boxes[3] as HTMLInputElement).disabled).toBe(true);
    await user.click(boxes[0] as HTMLElement);
    expect((boxes[3] as HTMLInputElement).disabled).toBe(false);
  });

  it("shows both exact bodies with Copy, the hashes, the reads and the note, and sends only match ids", async () => {
    const { user, dialog, calls } = await openPreview({
      "POST /api/booking/preview": () => ({
        body: {
          items: [
            previewItem({ matchId: 51 }),
            previewItem({
              matchId: 52,
              mode: "matched",
              matchSetXml: null,
              bankEntryBody: null,
              bankEntryHash: null,
              matchSetHash: null,
              wouldDefer: { code: "control_account_unknown" },
            }),
          ],
        },
      }),
    });
    // userEvent.setup() installs its own clipboard; spy on that one
    const write = vi.spyOn(navigator.clipboard, "writeText");
    const boxes = await within(dialog).findAllByRole("checkbox");
    await user.click(boxes[1] as HTMLElement);
    await user.click(boxes[0] as HTMLElement);
    await user.click(within(dialog).getByRole("button", { name: "Preview booking" }));
    const first = await within(dialog).findByRole("region", { name: "Preview of match 51" });
    expect(of(calls, "/api/booking/preview", "POST")[0]?.body).toEqual({ matchIds: [51, 52] });
    const bank = within(first).getByLabelText("Bank entry body");
    expect(bank.tagName).toBe("PRE");
    // byte for byte what the server sent (no pretty printing)
    expect(bank.textContent).toBe(previewItem().bankEntryBody);
    expect(within(first).getByLabelText("Match body (XML)").textContent).toContain("<MatchSet>");
    expect(first.textContent).toContain("a".repeat(64));
    expect(first.textContent).toContain("b".repeat(64));
    expect(within(first).getByText(/Nothing blocks this match/)).toBeTruthy();
    expect(first.textContent).toContain("a match of the bank line against the invoices");
    expect(first.textContent).toContain("0 lines found");
    expect(first.textContent).toContain("open as expected");
    expect(first.textContent).toMatch(/1[.,]000[.,]00/);
    await user.click(within(first).getByRole("button", { name: "Copy Bank entry body" }));
    expect(write).toHaveBeenCalledWith(previewItem().bankEntryBody);
    expect(await within(first).findByText("Copied the bank entry body.")).toBeTruthy();
    expect(within(dialog).getAllByText("Nothing was sent to Exact.").length).toBeGreaterThanOrEqual(
      2,
    );
    const second = within(dialog).getByRole("region", { name: "Preview of match 52" });
    expect(second.textContent).toContain(
      "Would not be booked now The debtors or creditors control account is not filled in",
    );
    expect(second.textContent).not.toContain("control_account_unknown");
    expect(second.textContent).toContain("No bank entry body");
  });

  it("warns about the placeholder bank line number and explains read problems and v1 rules", async () => {
    const { user, dialog } = await openPreview({
      "POST /api/booking/preview": () => ({
        body: {
          items: [
            previewItem({
              matchSetBankLinePlaceholder: true,
              matchSetXml: "<MatchSet><BankEntryLine>999999999</BankEntryLine></MatchSet>",
              wouldDefer: { code: "part_payment_not_supported_v1" },
              reads: {
                probeHits: null,
                closingBalanceMinor: null,
                openingBalanceSource: null,
                preflight: "inconclusive",
                readError: "rate_limited",
              },
            }),
          ],
        },
      }),
    });
    await user.click((await within(dialog).findAllByRole("checkbox"))[0] as HTMLElement);
    await user.click(within(dialog).getByRole("button", { name: "Preview booking" }));
    const r = await within(dialog).findByRole("region", { name: "Preview of match 50" });
    expect(r.textContent).toContain("uses the placeholder number 999999999");
    expect(r.textContent).toContain("A part payment is not booked automatically yet");
    expect(r.textContent).toContain("Exact asked us to slow down");
    expect(r.textContent).toContain("could not be checked");
    expect(r.textContent).not.toMatch(/rate_limited|part_payment/);
  });

  it("cuts a huge body for display, turns Copy off and points at the hash", async () => {
    const { user, dialog } = await openPreview({
      "POST /api/booking/preview": () => ({
        body: { items: [previewItem({ matchSetXml: `<X>${"y".repeat(60_000)}</X>` })] },
      }),
    });
    await user.click((await within(dialog).findAllByRole("checkbox"))[0] as HTMLElement);
    await user.click(within(dialog).getByRole("button", { name: "Preview booking" }));
    const r = await within(dialog).findByRole("region", { name: "Preview of match 50" });
    expect(within(r).getByLabelText("Match body (XML)").textContent?.length).toBe(40_000);
    expect(
      (within(r).getByRole("button", { name: "Copy Match body (XML)" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(r.textContent).toContain("too long to show in full");
  });

  it("masks a full IBAN that a body would contain, and says the copy is no longer byte for byte", async () => {
    const { user, dialog } = await openPreview({
      "POST /api/booking/preview": () => ({
        body: {
          items: [
            previewItem({
              bankEntryBody: JSON.stringify({ Description: "Payment from NL91ABNA0417164300" }),
              matchSetXml: "<Note>GB29NWBK60161331926819</Note>",
            }),
          ],
        },
      }),
    });
    await user.click((await within(dialog).findAllByRole("checkbox"))[0] as HTMLElement);
    await user.click(within(dialog).getByRole("button", { name: "Preview booking" }));
    const r = await within(dialog).findByRole("region", { name: "Preview of match 50" });
    expect(dialog.textContent).not.toMatch(/NL91ABNA0417164300|GB29NWBK60161331926819/);
    expect(dialog.textContent).toContain("4300");
    expect(within(r).getAllByText(/was masked here/)).toHaveLength(2);
  });

  it("asks for a fresh sign-in and shows nothing as sent", async () => {
    const { user, dialog } = await openPreview({ "POST /api/booking/preview": STEP_UP });
    await user.click((await within(dialog).findAllByRole("checkbox"))[0] as HTMLElement);
    await user.click(within(dialog).getByRole("button", { name: "Preview booking" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      /needs a Google sign-in/,
    );
    expect(within(dialog).queryByRole("region")).toBeNull();
  });

  it("works from a match's own sheet for an administrator only", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      base({
        "GET /api/matching/transactions/1": () => ({ body: detail({}, [], match({ id: 50 })) }),
        "POST /api/booking/preview": () => ({ body: { items: [previewItem()] } }),
        "GET /api/bank/accounts": () => ({ body: accounts() }),
      }),
    );
    renderApp("/treasury/bank?tab=auto");
    const table = await screen.findByRole("table", { name: "Matched automatically" });
    await waitFor(() => expect(table.querySelector(".sk-row")).toBeNull());
    await user.click(within(table).getByText("INV-2024-001 (Acme B.V.)"));
    const sheet = await screen.findByRole("dialog");
    await user.click(await within(sheet).findByRole("button", { name: "Preview booking…" }));
    const preview = await screen.findByRole("dialog", { name: "Preview booking" });
    expect(within(preview).queryAllByRole("checkbox")).toHaveLength(0);
    await user.click(within(preview).getByRole("button", { name: "Preview booking" }));
    await within(preview).findByRole("region", { name: "Preview of match 50" });
    expect(of(calls, "/api/booking/preview", "POST")[0]?.body).toEqual({ matchIds: [50] });
  });

  it("finance and viewers get no preview button anywhere", async () => {
    for (const me of [FINANCE, VIEWER]) {
      const user = userEvent.setup();
      mockFetch(
        base(
          {
            "GET /api/matching/transactions/1": () => ({ body: detail({}, [], match({ id: 50 })) }),
            "GET /api/bank/accounts": () => ({ body: accounts() }),
          },
          me,
        ),
      );
      const { unmount } = renderApp("/treasury/bank?tab=auto");
      const table = await screen.findByRole("table", { name: "Matched automatically" });
      await waitFor(() => expect(table.querySelector(".sk-row")).toBeNull());
      await user.click(within(table).getByText("INV-2024-001 (Acme B.V.)"));
      const sheet = await screen.findByRole("dialog");
      await within(sheet).findByText("Matched");
      expect(within(sheet).queryByRole("button", { name: /Preview booking/ })).toBeNull();
      unmount();
    }
  });

  it("the booking card of a viewer has no Verify, Preview or Enable buttons", async () => {
    await openSettings({}, VIEWER);
    const c = card("Booking in Exact");
    expect(await within(c).findByText(/Only an administrator can verify/)).toBeTruthy();
    for (const name of [/Verify write path/, /Preview booking/, /Enable booking/]) {
      expect(within(c).queryByRole("button", { name })).toBeNull();
    }
    expect(await within(c).findByText(/Only an administrator can verify/)).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { dialog } = await openPreview();
    await within(dialog).findAllByRole("checkbox");
    expect(await axe(dialog)).toHaveNoViolations();
  });
});

// ---- deferred matches -------------------------------------------------------------------------------

describe("deferred matches", () => {
  it("show a calm chip with the plain reason in the matched list", async () => {
    mockFetch(
      base({
        "GET /api/bank/accounts": () => ({ body: accounts() }),
        "GET /api/matching/auto": () => ({
          body: {
            items: [
              autoItem({ id: 50, bookingDeferredCode: "control_account_unknown" }),
              autoItem({ id: 51, bookingDeferredCode: "brand_new_code" }, { id: 5 }),
              autoItem({ id: 52 }, { id: 6 }),
              autoItem(
                { id: 53, bookingDeferredCode: "fee_not_supported_v1", exactState: "booked" },
                { id: 7 },
              ),
            ],
            nextCursor: null,
          },
        }),
      }),
    );
    renderApp("/treasury/bank?tab=auto");
    const table = await screen.findByRole("table", { name: "Matched automatically" });
    await waitFor(() => expect(table.querySelector(".sk-row")).toBeNull());
    const text = table.textContent ?? "";
    expect(text).toContain(
      "Cannot be booked yet: the debtors or creditors control account is not filled in",
    );
    expect(text).toContain("Cannot be booked yet: something else is missing");
    expect(text.match(/Cannot be booked yet/g)).toHaveLength(2); // not on the plain or booked rows
    expect(text).not.toMatch(/control_account_unknown|brand_new_code|fee_not_supported_v1/);
  });

  it("show the chip and the manual-booking note on the match's own sheet", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(
        {
          "GET /api/bank/accounts": () => ({ body: accounts() }),
          "GET /api/matching/transactions/1": () => ({
            body: detail({}, [], match({ id: 50, bookingDeferredCode: "bank_balance_unknown" })),
          }),
        },
        FINANCE,
      ),
    );
    renderApp("/treasury/bank?tab=auto");
    const table = await screen.findByRole("table", { name: "Matched automatically" });
    await waitFor(() => expect(table.querySelector(".sk-row")).toBeNull());
    await user.click(within(table).getByText("INV-2024-001 (Acme B.V.)"));
    const sheet = await screen.findByRole("dialog");
    expect(
      await within(sheet).findByText(
        "Cannot be booked yet: the opening balance of the journal in Exact is not known",
      ),
    ).toBeTruthy();
  });

  it("a match booked by a person in Exact says so", async () => {
    const user = userEvent.setup();
    mockFetch(
      base(
        {
          "GET /api/bank/accounts": () => ({ body: accounts() }),
          "GET /api/matching/transactions/1": () => ({
            body: detail(
              {},
              [],
              match({ id: 50, exactState: "booked", bookedManually: true, undoAvailable: false }),
            ),
          }),
        },
        FINANCE,
      ),
    );
    renderApp("/treasury/bank?tab=auto");
    const table = await screen.findByRole("table", { name: "Matched automatically" });
    await waitFor(() => expect(table.querySelector(".sk-row")).toBeNull());
    await user.click(within(table).getByText("INV-2024-001 (Acme B.V.)"));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText(/booked by a person in Exact/)).toBeTruthy();
  });
});

// ---- B1: control accounts and the opening balance ------------------------------------------------

describe("account map: control accounts and opening balance", () => {
  const rowOf = async (index: number) =>
    (await within(card("Account map")).findAllByRole("listitem"))[index] as HTMLElement;

  it("shows the fields with the help text and the saved values", async () => {
    await openSettings({
      "GET /api/matching/account-map": () => ({
        body: accountMap({
          accounts: [
            {
              ...accountMap().accounts[0]!,
              openingBalanceMinor: 123450,
            },
          ],
        }),
      }),
    });
    const row = await rowOf(0);
    expect((within(row).getByLabelText("Debtors control account") as HTMLInputElement).value).toBe(
      "1300",
    );
    expect(
      (within(row).getByLabelText("Creditors control account") as HTMLInputElement).value,
    ).toBe("1600");
    expect(
      (within(row).getByLabelText(/Opening balance of an empty journal \(EUR/) as HTMLInputElement)
        .value,
    ).toBe("1234.50");
    expect(row.textContent).toContain(
      "Needed to book matches in Exact. Without these, matches wait and nothing is booked.",
    );
  });

  it("highlights a mapped account with missing control accounts and explains the blocker", async () => {
    await openSettings({
      "GET /api/matching/account-map": () => ({
        body: accountMap({
          accounts: [
            {
              ...accountMap().accounts[0]!,
              receivableGlAccountCode: null,
              payableGlAccountCode: "1600",
            },
          ],
        }),
      }),
    });
    const row = await rowOf(0);
    expect(row.className).toContain("mt-unmapped");
    expect(within(row).getByText("Not booked until control accounts are filled in")).toBeTruthy();
    expect(row.textContent).toContain("no debtors or creditors control account");
  });

  it("explains an unmapped account with the journal blocker too", async () => {
    await openSettings();
    const row = await rowOf(1);
    expect(row.className).toContain("mt-unmapped");
    expect(row.textContent).toContain("no Exact journal or bank ledger account");
  });

  it("saves the control accounts and the exact opening balance (no floats)", async () => {
    const user = userEvent.setup();
    const { calls } = await openSettings({
      "PUT /api/matching/account-map": () => ({ body: accountMap() }),
    });
    const row = await rowOf(1); // the GBP account, not mapped yet
    await user.selectOptions(within(row).getByLabelText("Administration"), "2");
    await user.type(within(row).getByLabelText("Journal code"), "RB2");
    await user.type(within(row).getByLabelText("Bank ledger account"), "1220");
    await user.type(within(row).getByLabelText("Debtors control account"), "1300");
    await user.type(within(row).getByLabelText("Creditors control account"), "1600");
    await user.type(
      within(row).getByLabelText(/Opening balance of an empty journal \(GBP/),
      "12345,67",
    );
    await user.click(within(row).getByRole("button", { name: "Save the mapping of Sterling" }));
    await waitFor(() => expect(of(calls, "/api/matching/account-map", "PUT")).toHaveLength(1));
    expect(of(calls, "/api/matching/account-map", "PUT")[0]?.body).toEqual({
      bankAccountId: 2,
      divisionId: 2,
      journalCode: "RB2",
      bankGlAccountCode: "1220",
      receivableGlAccountCode: "1300",
      payableGlAccountCode: "1600",
      openingBalanceMinor: 1234567,
    });
  });

  it("refuses a bad control account code or opening balance before sending", async () => {
    const user = userEvent.setup();
    const { calls } = await openSettings();
    const row = await rowOf(0);
    const save = () =>
      within(row).getByRole("button", {
        name: "Save the mapping of Main EUR",
      }) as HTMLButtonElement;
    const receivable = within(row).getByLabelText("Debtors control account");
    await user.clear(receivable);
    await user.type(receivable, "bad code!");
    expect(save().disabled).toBe(true);
    expect(within(row).getByText(/Use the ledger account code/)).toBeTruthy();
    await user.clear(receivable);
    await user.type(receivable, "1300x");
    expect(save().disabled).toBe(false);
    const opening = within(row).getByLabelText(/Opening balance of an empty journal/);
    for (const bad of [
      "1,234.50",
      "12.345",
      "1e3",
      "abc",
      "+5",
      "5-",
      "--5",
      "- 5",
      "\u22125",
      "\u0661\u0662",
      "\uff11\uff12",
      "100000000000,01",
      "1 000",
    ]) {
      await user.clear(opening);
      await user.type(opening, bad);
      expect(save().disabled, bad).toBe(true);
      expect(within(row).getByRole("alert")).toBeTruthy();
    }
    await user.clear(opening);
    await user.type(opening, "0");
    expect(save().disabled).toBe(false); // an empty journal may open at zero
    await user.clear(opening);
    await user.type(opening, "-250,5");
    expect(save().disabled).toBe(false); // an overdrawn journal: one minus sign in front
    expect(row.textContent).toMatch(/reads as .*-.*250[.,]50/);
    expect(of(calls, "/api/matching/account-map", "PUT")).toHaveLength(0);
  });

  it("clearing the opening balance sends null; zero sends 0", async () => {
    const user = userEvent.setup();
    const { calls } = await openSettings({
      "GET /api/matching/account-map": () => ({
        body: accountMap({
          accounts: [{ ...accountMap().accounts[0]!, openingBalanceMinor: 500 }],
        }),
      }),
      "PUT /api/matching/account-map": () => ({ body: accountMap() }),
    });
    const row = await rowOf(0);
    const opening = within(row).getByLabelText(/Opening balance of an empty journal/);
    await user.clear(opening);
    await user.click(within(row).getByRole("button", { name: "Save the mapping of Main EUR" }));
    await waitFor(() => expect(of(calls, "/api/matching/account-map", "PUT")).toHaveLength(1));
    expect(of(calls, "/api/matching/account-map", "PUT")[0]?.body).toMatchObject({
      openingBalanceMinor: null,
    });
  });

  it("sends a negative opening balance as a signed integer, and leaves an untouched one out", async () => {
    const user = userEvent.setup();
    const { calls } = await openSettings({
      "GET /api/matching/account-map": () => ({
        body: accountMap({
          accounts: [{ ...accountMap().accounts[0]!, openingBalanceMinor: -2550 }],
        }),
      }),
      "PUT /api/matching/account-map": () => ({ body: accountMap() }),
    });
    const row = await rowOf(0);
    const opening = within(row).getByLabelText(
      /Opening balance of an empty journal/,
    ) as HTMLInputElement;
    expect(opening.value).toBe("-25.50");
    // another field changes: the opening balance is not sent (absent keeps the stored value)
    await user.type(within(row).getByLabelText("Debtors control account"), "9");
    await user.click(within(row).getByRole("button", { name: "Save the mapping of Main EUR" }));
    await waitFor(() => expect(of(calls, "/api/matching/account-map", "PUT")).toHaveLength(1));
    expect(of(calls, "/api/matching/account-map", "PUT")[0]?.body).not.toHaveProperty(
      "openingBalanceMinor",
    );
  });

  it("an opening balance in JPY has no decimals and in KWD three", async () => {
    const user = userEvent.setup();
    const { calls } = await openSettings({
      "GET /api/matching/account-map": () => ({
        body: accountMap({
          accounts: [
            { ...accountMap().accounts[0]!, bankAccountId: 7, accountName: "Yen", currency: "JPY" },
            {
              ...accountMap().accounts[0]!,
              bankAccountId: 8,
              accountName: "Dinar",
              currency: "KWD",
            },
          ],
        }),
      }),
      "PUT /api/matching/account-map": () => ({ body: accountMap() }),
    });
    const yen = await rowOf(0);
    const o1 = within(yen).getByLabelText(/Opening balance of an empty journal \(JPY/);
    await user.type(o1, "12,5");
    expect(within(yen).getByText(/JPY has no decimals/)).toBeTruthy();
    await user.clear(o1);
    await user.type(o1, "-1250");
    await user.click(within(yen).getByRole("button", { name: "Save the mapping of Yen" }));
    await waitFor(() => expect(of(calls, "/api/matching/account-map", "PUT")).toHaveLength(1));
    expect(of(calls, "/api/matching/account-map", "PUT")[0]?.body).toMatchObject({
      openingBalanceMinor: -1250,
    });
    const dinar = await rowOf(1);
    await user.type(within(dinar).getByLabelText(/\(KWD/), "1,234");
    await user.click(within(dinar).getByRole("button", { name: "Save the mapping of Dinar" }));
    await waitFor(() => expect(of(calls, "/api/matching/account-map", "PUT")).toHaveLength(2));
    expect(of(calls, "/api/matching/account-map", "PUT")[1]?.body).toMatchObject({
      openingBalanceMinor: 1234,
    });
  });

  it("a save needs a fresh sign-in, which is explained", async () => {
    const user = userEvent.setup();
    await openSettings({ "PUT /api/matching/account-map": STEP_UP });
    const row = await rowOf(0);
    await user.type(within(row).getByLabelText("Debtors control account"), "9");
    await user.click(within(row).getByRole("button", { name: "Save the mapping of Main EUR" }));
    expect(await within(row).findByText(/needs a Google sign-in/)).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { view } = await openSettings();
    await rowOf(0);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

// ---- N9: lazy screens ------------------------------------------------------------------------------

describe("lazy-loaded screens", () => {
  it("shows an accessible loading state, then the screen, for the matching settings", async () => {
    mockFetch(base());
    renderApp("/settings/matching");
    // the screen arrives once its chunk and data are in
    expect(await screen.findByRole("heading", { level: 2, name: "Booking in Exact" })).toBeTruthy();
  });
});
