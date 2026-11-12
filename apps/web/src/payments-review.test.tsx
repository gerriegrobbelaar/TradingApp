/**
 * Adversarial tests from the P9c review: client keys, stale sheets, a payload that changes under an
 * approver, role combinations, honest wording, settings PATCH semantics and request bodies.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { maskIbans, PAYMENT_STATUSES, PAYMENTS_LOOSEN_PHRASE } from "@camelthorn/core";
import { ADMIN, VIEWER, mockFetch, renderApp, settle, type Call } from "./test-utils";
import { norm } from "./test-norm";
import { ONE_DIVISION, listResponse, row } from "./test-fixtures";
import { accounts } from "./test-fixtures-bank";
import {
  APPROVER,
  FINANCE,
  batch,
  event,
  ibanStatus,
  payment,
  paymentsSettings,
} from "./test-fixtures-payments";
import type { Me } from "./api";
import { OUTCOME_UNKNOWN_TEXT, statusText } from "./lib/payment-labels";

type H = (c: Call) => { status?: number; body?: unknown };
const posts = (calls: Call[], path: string) =>
  calls.filter((c) => c.method === "POST" && c.url === path);
/** Looks like an IBAN to a naive mask: two letters, two digits, then alphanumerics. */
const IBANISH_HASH = `de89370400440532013000${"a".repeat(42)}`;
const OTHER_HASH = `be68539007547034${"b".repeat(48)}`;

describe("the test hashes really look like IBANs", () => {
  it("a plain mask would corrupt them", () => {
    expect(IBANISH_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(OTHER_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(maskIbans(IBANISH_HASH)).not.toBe(IBANISH_HASH);
    expect(maskIbans(OTHER_HASH)).not.toBe(OTHER_HASH);
  });
});

afterEach(() => {
  // Nothing of a payment is kept in the browser.
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
});

const B1 = row({
  id: 1,
  kind: "bill",
  invoiceNumber: "BILL-77",
  relation: { id: 7, name: "Acme Supplies BV" },
  openMinor: 123456,
});
const on = paymentsSettings({ enabled: true, blockers: [] });

function twoEurAccounts() {
  const a = accounts();
  const first = a.accounts[0];
  if (!first) throw new Error("fixture");
  return { ...a, accounts: [first, { ...first, id: 2, name: "Spare EUR" }] };
}

function payables(me: Me, extra: Record<string, H> = {}) {
  return mockFetch({
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/divisions": () => ({ body: ONE_DIVISION }),
    "GET /api/bills": () => ({ body: listResponse([B1]) }),
    "GET /api/bank/accounts": () => ({ body: twoEurAccounts() }),
    "GET /api/settings/payments": () => ({ body: on }),
    ...extra,
  });
}

async function openPay(user: ReturnType<typeof userEvent.setup>) {
  const t = await screen.findByRole("table", { name: "Payables" });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  await user.click(within(t).getByRole("button", { name: /^Pay BILL-77/ }));
  return screen.findByRole("dialog");
}
const keyOf = (c: Call | undefined) => (c?.body as { clientKey: string }).clientKey;

describe("client key semantics", () => {
  it("retries with the same key after a lost answer, and a new key for another account", async () => {
    let n = 0;
    const calls = payables(FINANCE, {
      "POST /api/payments": () => {
        n += 1;
        if (n <= 2) throw new TypeError("Failed to fetch");
        return { status: 201, body: { payment: payment(), replayed: true, warnings: [] } };
      },
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await openPay(user);
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    const review = within(dlg).getByRole("button", { name: "Review payment" });
    await user.click(review);
    expect(await within(dlg).findByText(/cannot tell whether this arrived/)).toBeTruthy();
    // a different account is a different payload: never the same key
    await user.click(within(dlg).getByRole("radio", { name: /Spare EUR/ }));
    await user.click(review);
    await within(dlg).findByText(/cannot tell whether this arrived/);
    // back to the first account: the first key again, so a draft made by the lost call is replayed
    await user.click(within(dlg).getByRole("radio", { name: /Main EUR/ }));
    await user.click(review);
    await within(dlg).findByTestId("pay-phrase");
    const c = posts(calls, "/api/payments");
    expect(c).toHaveLength(3);
    expect(c.map((x) => (x.body as { sourceAccountId: number }).sourceAccountId)).toEqual([
      1, 2, 1,
    ]);
    expect(keyOf(c[0])).toBe(keyOf(c[2]));
    expect(keyOf(c[1])).not.toBe(keyOf(c[0]));
  });

  it("a second opening of the sheet is a new key (a new decision)", async () => {
    const calls = payables(FINANCE, {
      "POST /api/payments": () => ({
        status: 422,
        body: { error: "blocked", blocks: ["iban_unverified"] },
      }),
      "GET /api/payments/ibans/7": () => ({ body: { iban: ibanStatus() } }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    for (let i = 0; i < 2; i++) {
      const dlg = await openPay(user);
      await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
      await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
      await within(dlg).findByText("This payment cannot be requested yet.");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    const c = posts(calls, "/api/payments");
    expect(c).toHaveLength(2);
    expect(keyOf(c[0])).not.toBe(keyOf(c[1]));
  });
});

describe("the draft must be the one asked for", () => {
  it("refuses a draft for another bill or account and offers no phrase", async () => {
    payables(FINANCE, {
      "POST /api/payments": () => ({
        status: 201,
        body: { payment: payment({ openItemId: 99 }), replayed: true, warnings: [] },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await openPay(user);
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
    expect(await within(dlg).findByTestId("pay-mismatch")).toBeTruthy();
    expect(within(dlg).queryByLabelText("Confirmation text")).toBeNull();
    expect(
      (within(dlg).getByRole("button", { name: "Review payment" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("says so when Exact's open amount moved, and the phrase follows the server's amount", async () => {
    payables(FINANCE, {
      "POST /api/payments": () => ({
        status: 201,
        body: { payment: payment({ amountMinor: 100000 }), replayed: false, warnings: [] },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await openPay(user);
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
    expect(norm((await within(dlg).findByTestId("pay-amount-moved")).textContent)).toContain(
      "€ 1.234,56",
    );
    expect(within(dlg).getByTestId("pay-phrase").textContent).toBe("PAY 1000.00 EUR TO 4300");
  });
});

describe("the typed phrase", () => {
  it("Enter in the field sends nothing", async () => {
    const calls = payables(FINANCE, {
      "POST /api/payments": () => ({
        status: 201,
        body: { payment: payment(), replayed: false, warnings: [] },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await openPay(user);
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
    const input = await within(dlg).findByLabelText("Confirmation text");
    await user.type(input, "PAY 1234.56 EUR TO 4300{Enter}");
    await settle(30);
    expect(posts(calls, "/api/payments/11/confirm")).toHaveLength(0);
  });

  it("drops what was typed when the request read again is another payload", async () => {
    let current = payment();
    payables(FINANCE, {
      "POST /api/payments": () => ({
        status: 201,
        body: { payment: current, replayed: false, warnings: [] },
      }),
      "POST /api/payments/11/confirm": () => {
        current = payment({ amountMinor: 123400, payloadHash: OTHER_HASH });
        return { status: 409, body: { error: "controls_changed" } };
      },
      "GET /api/payments/11": () => ({ body: { payment: current, events: [] } }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await openPay(user);
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
    await user.type(
      await within(dlg).findByLabelText("Confirmation text"),
      "PAY 1234.56 EUR TO 4300",
    );
    await user.click(within(dlg).getByRole("button", { name: "Confirm payment" }));
    await waitFor(() =>
      expect(within(dlg).getByTestId("pay-phrase").textContent).toBe("PAY 1234.00 EUR TO 4300"),
    );
    expect((within(dlg).getByLabelText("Confirmation text") as HTMLInputElement).value).toBe("");
  });
});

// ---- approving --------------------------------------------------------------------------------

function approvals(
  me: Me,
  first = payment({ status: "pending_approval" }),
  over: Record<string, H> = {},
) {
  const state = { current: first };
  const calls = mockFetch({
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/divisions": () => ({ body: ONE_DIVISION }),
    "GET /api/payments": () => ({ body: { items: [state.current], nextCursor: null } }),
    "GET /api/payment-batches": () => ({ body: { items: [], nextCursor: null } }),
    "GET /api/payments/11": () => ({ body: { payment: state.current, events: [event()] } }),
    "GET /api/bank/accounts": () => ({ body: accounts() }),
    "POST /api/payments/11/approve": () => ({
      body: { payment: { ...state.current, status: "ready" } },
    }),
    ...over,
  });
  return { calls, state };
}
async function openFirst(user: ReturnType<typeof userEvent.setup>) {
  const t = await screen.findByRole("table", { name: "Payments" });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  await user.click(within(t).getByRole("button", { name: "BILL-77" }));
  return screen.findByRole("dialog");
}

describe("a payload that changes under the approver", () => {
  it("blocks deciding until the new details are acknowledged, then sends the NEW hash exactly", async () => {
    const { calls, state } = approvals(
      APPROVER,
      payment({ status: "pending_approval", payloadHash: IBANISH_HASH }),
    );
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    state.current = payment({
      status: "pending_approval",
      amountMinor: 999999,
      payloadHash: OTHER_HASH,
    });
    await user.click(within(dlg).getByRole("button", { name: "Check status again" }));
    const note = await within(dlg).findByTestId("pay-payload-changed");
    expect(note.textContent).toContain(IBANISH_HASH.slice(0, 12));
    expect(note.textContent).toContain(OTHER_HASH.slice(0, 12));
    const approve = within(dlg).getByRole("button", {
      name: "Approve payment",
    }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await user.click(approve);
    expect(posts(calls, "/api/payments/11/approve")).toHaveLength(0);
    expect(norm(dlg.textContent)).toContain("€ 9.999,99");
    await user.click(within(note).getByRole("button", { name: "I have read the new details" }));
    expect(within(dlg).queryByTestId("pay-payload-changed")).toBeNull();
    await user.click(within(dlg).getByRole("button", { name: "Approve payment" }));
    await waitFor(() => expect(posts(calls, "/api/payments/11/approve")).toHaveLength(1));
    expect(posts(calls, "/api/payments/11/approve")[0]?.body).toEqual({ payloadHash: OTHER_HASH });
  });

  it("sends an IBAN-looking hash unmasked", async () => {
    const { calls } = approvals(
      APPROVER,
      payment({ status: "pending_approval", payloadHash: IBANISH_HASH }),
    );
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    await user.click(within(dlg).getByRole("button", { name: "Approve payment" }));
    await waitFor(() => expect(posts(calls, "/api/payments/11/approve")).toHaveLength(1));
    expect(posts(calls, "/api/payments/11/approve")[0]?.body).toEqual({
      payloadHash: IBANISH_HASH,
    });
  });
});

describe("roles, including people with several roles", () => {
  const who = (roles: string[], email = "x@camelthorncapital.com"): Me =>
    ({ ...APPROVER, email, roles }) as Me;
  const cases: { name: string; me: Me; mine: boolean; approve: boolean }[] = [
    { name: "approver", me: who(["approver"]), mine: false, approve: true },
    {
      name: "finance and approver, not the requester",
      me: who(["finance", "approver"]),
      mine: false,
      approve: true,
    },
    {
      name: "finance and approver, the requester",
      me: who(["finance", "approver"], FINANCE.email),
      mine: true,
      approve: false,
    },
    {
      name: "approver, the requester in other letter case",
      me: who(["approver"], FINANCE.email.toUpperCase()),
      mine: true,
      approve: false,
    },
    { name: "admin only", me: who(["admin"]), mine: false, approve: false },
    { name: "admin and finance", me: who(["admin", "finance"]), mine: false, approve: false },
    { name: "viewer", me: VIEWER, mine: false, approve: false },
    { name: "viewer and approver", me: who(["viewer", "approver"]), mine: false, approve: true },
  ];
  for (const c of cases) {
    it(`${c.name}: approve ${c.approve ? "offered" : "not offered"}`, async () => {
      approvals(c.me);
      const user = userEvent.setup();
      renderApp("/purchases/approvals?tab=payments");
      const dlg = await openFirst(user);
      const btn = within(dlg).queryByRole("button", { name: "Approve payment" });
      const down = within(dlg).queryByRole("button", { name: "Turn down" });
      expect(btn !== null).toBe(c.approve);
      expect(down !== null).toBe(c.approve);
    });
  }

  it("an admin cancels anyone's request; finance only their own; nobody can cancel an unconfirmed outcome", async () => {
    for (const [me, status, can] of [
      [ADMIN, "pending_approval", true],
      [{ ...FINANCE, email: "other@camelthorncapital.com" }, "pending_approval", false],
      [FINANCE, "pending_approval", true],
      [ADMIN, "outcome_unknown", false],
      [FINANCE, "submitted", false],
    ] as const) {
      const { calls } = approvals(me, payment({ status }));
      const user = userEvent.setup();
      const view = renderApp("/purchases/approvals?tab=payments");
      const dlg = await openFirst(user);
      expect(
        within(dlg).queryByRole("button", { name: "Cancel this request" }) !== null,
        `${me.roles.join("+")} ${status}`,
      ).toBe(can);
      if (status === "outcome_unknown") {
        expect(dlg.textContent).toContain(OUTCOME_UNKNOWN_TEXT);
        expect(within(dlg).queryByLabelText("Confirmation text")).toBeNull();
        expect(within(dlg).queryByRole("button", { name: /retry|try again|pay/i })).toBeNull();
      }
      expect(calls.some((x) => x.method === "POST")).toBe(false);
      view.unmount();
    }
  });
});

describe("words", () => {
  it("only the paid status is ever labelled Paid", () => {
    for (const s of PAYMENT_STATUSES) {
      if (s === "paid") continue;
      expect(statusText(s).label, s).not.toMatch(/\bpaid\b/i);
      const meaning = statusText(s).meaning.replace(/nothing was paid/gi, "");
      expect(meaning, s).not.toMatch(/\bpaid\b/i);
    }
    expect(statusText("totally_new").label).not.toBe("Paid");
  });
  it("failed, rejected, cancelled and expired are told apart", () => {
    const labels = ["failed", "rejected", "cancelled", "expired", "outcome_unknown"].map(
      (s) => statusText(s).label,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("a batch shows the reference of each bill", () => {
  it("lists bill, supplier, masked IBAN, reference and amount", async () => {
    mockFetch({
      "GET /api/auth/me": () => ({ body: APPROVER }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/payments": () => ({ body: { items: [], nextCursor: null } }),
      "GET /api/payment-batches": () => ({
        body: { items: [batch({ status: "pending_approval" })], nextCursor: null },
      }),
      "GET /api/payment-batches/5": () => ({
        body: { batch: batch({ status: "pending_approval" }), events: [] },
      }),
      "GET /api/bank/accounts": () => ({ body: accounts() }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const t = await screen.findByRole("table", { name: "Payment batches" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    await user.click(within(t).getByRole("button", { name: "2 bills" }));
    const dlg = await screen.findByRole("dialog");
    const items = within(dlg).getByRole("table", { name: "Bills in this batch" });
    expect(within(items).getByRole("columnheader", { name: "Reference" })).toBeTruthy();
    expect(within(items).getAllByText("Invoice BILL-77")).toHaveLength(2);
  });
});

// ---- settings -----------------------------------------------------------------------------------

describe("Settings, Payments sends only what this person changed", () => {
  function settings(over: Record<string, H>) {
    return mockFetch({
      "GET /api/auth/me": () => ({ body: ADMIN }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/users": () => ({ body: { users: [], invites: [] } }),
      ...over,
    });
  }

  it("after somebody else changed a ceiling, saving my edit does not set theirs back", async () => {
    const first = paymentsSettings();
    const theirs = paymentsSettings({
      settings: { ...first.settings, maxDailyMinor: first.settings.maxDailyMinor - 100 },
    });
    let stored = first;
    let patches = 0;
    const calls = settings({
      "GET /api/settings/payments": () => ({ body: stored }),
      "PATCH /api/settings/payments": () => {
        patches += 1;
        if (patches === 1) {
          stored = theirs; // somebody else saved in between
          return { status: 409, body: { error: "conflict" } };
        }
        return { body: stored };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    const limit = await screen.findByLabelText(/Four-eyes limit/);
    await user.clear(limit);
    await user.type(limit, "1000");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Somebody else changed these settings/)).toBeTruthy();
    expect((screen.getByLabelText(/Four-eyes limit/) as HTMLInputElement).value).toBe("1000");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH")[1]?.body).toEqual({
      fourEyesLimitMinor: 100000,
    });
  });

  it("opens the typed phrase when the server says the change loosens a control", async () => {
    const calls = settings({
      "GET /api/settings/payments": () => ({ body: paymentsSettings() }),
      "PATCH /api/settings/payments": (c) =>
        (c.body as { confirm?: string }).confirm === PAYMENTS_LOOSEN_PHRASE
          ? { body: paymentsSettings() }
          : {
              status: 400,
              body: { error: "confirmation_required", loosened: ["maxDailyMinor"] },
            },
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    const limit = await screen.findByLabelText(/Four-eyes limit/);
    await user.clear(limit);
    await user.type(limit, "1000");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const dlg = await screen.findByRole("dialog");
    expect(norm(dlg.textContent)).toContain("You are loosening daily ceiling.");
    expect(screen.queryByText(/The confirmation text does not match/)).toBeNull();
    await user.type(
      within(dlg).getByLabelText(new RegExp(PAYMENTS_LOOSEN_PHRASE)),
      PAYMENTS_LOOSEN_PHRASE,
    );
    await user.click(within(dlg).getByRole("button", { name: "Loosen controls" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH")[1]?.body).toEqual({
      fourEyesLimitMinor: 100000,
      confirm: PAYMENTS_LOOSEN_PHRASE,
    });
  });

  it("the switch-off button is absent while payments are off (nothing to switch)", async () => {
    settings({ "GET /api/settings/payments": () => ({ body: paymentsSettings() }) });
    renderApp("/settings/payments");
    await screen.findByLabelText(/Four-eyes limit/);
    expect(screen.queryByRole("button", { name: "Switch payments off" })).toBeNull();
    // Switching ON exists (F9c) but is disabled while something still stops payments.
    const on = screen.getByRole("button", { name: "Switch payments on" }) as HTMLButtonElement;
    expect(on.disabled).toBe(true);
  });
});

describe("request bodies are never masked", () => {
  it("the bank-details confirmation sends the IBAN-looking fingerprint exactly", async () => {
    const calls = mockFetch({
      "GET /api/auth/me": () => ({ body: APPROVER }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/bills": () => ({ body: listResponse([B1]) }),
      "GET /api/payments/ibans/7": () => ({
        body: { iban: ibanStatus({ ibanFingerprint: IBANISH_HASH }) },
      }),
      "POST /api/payments/ibans/verify": () => ({
        body: { iban: ibanStatus({ state: "verified_new", ibanFingerprint: IBANISH_HASH }) },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const t = await screen.findByRole("table", { name: "Payables" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    await user.click(within(t).getByRole("button", { name: /Bank details/ }));
    const dlg = await screen.findByRole("dialog");
    await user.type(await within(dlg).findByLabelText("Last four characters"), "4300");
    await user.click(within(dlg).getByRole("button", { name: "Confirm these bank details" }));
    await waitFor(() => expect(posts(calls, "/api/payments/ibans/verify")).toHaveLength(1));
    expect(posts(calls, "/api/payments/ibans/verify")[0]?.body).toEqual({
      relationId: 7,
      fingerprint: IBANISH_HASH,
      lastFour: "4300",
    });
  });
});
