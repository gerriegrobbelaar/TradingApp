/** Payment approvals, IBAN confirmation, Treasury payments list and Settings, Payments (P9c). */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import { norm } from "./test-norm";
import { ONE_DIVISION, approvals, approval, listResponse, row } from "./test-fixtures";
import { accounts } from "./test-fixtures-bank";
import { stats } from "./test-fixtures-matching";
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
import { PAYMENTS_LOOSEN_PHRASE } from "@camelthorn/core";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
type H = (c: Call) => { status?: number; body?: unknown };
const posts = (calls: Call[], path: string) =>
  calls.filter((c) => c.method === "POST" && c.url === path);
const HASH = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";

// ---- approvals --------------------------------------------------------------------------------

function approvalsBase(
  me: Me,
  pending = payment({ status: "pending_approval", approvalsRequired: ["above_limit"] }),
  over: Record<string, H> = {},
) {
  let current = pending;
  const calls = mockFetch({
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/divisions": () => ({ body: ONE_DIVISION }),
    "GET /api/payments": () => ({ body: { items: [current], nextCursor: null } }),
    "GET /api/payment-batches": () => ({ body: { items: [], nextCursor: null } }),
    "GET /api/payments/11": () => ({ body: { payment: current, events: [event()] } }),
    "GET /api/bank/accounts": () => ({ body: accounts() }),
    "POST /api/payments/11/approve": () => {
      current = payment({
        ...current,
        status: "ready",
        decision: {
          decision: "approved",
          by: me.email,
          at: "2026-11-11T11:00:00.000Z",
          note: null,
        },
      });
      return { body: { payment: current } };
    },
    ...over,
  });
  return calls;
}
async function openFirst(user: ReturnType<typeof userEvent.setup>) {
  const t = await screen.findByRole("table", { name: "Payments" });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  await user.click(within(t).getByRole("button", { name: "BILL-77" }));
  return screen.findByRole("dialog");
}

describe("Approvals keeps the Exact bills and adds payments", () => {
  it("opens on the Exact bill approvals, untouched, with a Payments tab beside it", async () => {
    const calls = mockFetch({
      "GET /api/auth/me": () => ({ body: APPROVER }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/approvals": () => ({ body: approvals([approval()]) }),
    });
    renderApp("/purchases/approvals");
    const t = await screen.findByRole("table", { name: "Approvals" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    expect(screen.getByRole("button", { name: "Bills in Exact", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Payments", pressed: false })).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith("/api/payments"))).toBe(false);
  });
});

describe("approving a payment", () => {
  it("shows exactly what will be paid with the short hash and sends the hash back", async () => {
    const calls = approvalsBase(APPROVER);
    const user = userEvent.setup();
    const { container } = renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    const text = norm(dlg.textContent);
    expect(text).toContain("Acme Supplies BV");
    expect(text).toContain("NL91****4300");
    expect(text).toContain("€ 1.234,56");
    expect(text).toContain("Invoice BILL-77");
    expect(text).toContain("Main EUR");
    expect(text).toContain("ab12cd34ef56");
    expect(text).not.toContain(HASH);
    expect(text).toContain("The amount is above the four-eyes limit.");
    expect(await axe(container)).toHaveNoViolations();
    await user.click(within(dlg).getByRole("button", { name: "Approve payment" }));
    await within(dlg).findByText(/Approved by appr@camelthorncapital.com/);
    expect(posts(calls, "/api/payments/11/approve")[0]?.body).toEqual({ payloadHash: HASH });
    expect(within(dlg).queryByRole("button", { name: "Approve payment" })).toBeNull();
  });

  it("turning down needs a reason", async () => {
    let stored = payment({ status: "pending_approval", approvalsRequired: ["above_limit"] });
    const calls = approvalsBase(APPROVER, undefined, {
      "GET /api/payments/11": () => ({ body: { payment: stored, events: [] } }),
      "POST /api/payments/11/reject": () => {
        stored = payment({ status: "rejected", statusReason: "approver_rejected" });
        return { body: { payment: stored } };
      },
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    await user.click(within(dlg).getByRole("button", { name: "Turn down" }));
    const go = within(dlg).getByRole("button", { name: "Turn down payment" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.type(within(dlg).getByLabelText("Reason for turning this down"), "ab");
    expect(go.disabled).toBe(true);
    await user.type(within(dlg).getByLabelText("Reason for turning this down"), "c");
    expect(go.disabled).toBe(false);
    await user.click(go);
    await within(dlg).findByText("It was turned down, so nothing was paid.");
    expect(posts(calls, "/api/payments/11/reject")[0]?.body).toEqual({
      payloadHash: HASH,
      note: "abc",
    });
  });

  it("offers no buttons on one's own request", async () => {
    approvalsBase(APPROVER, payment({ status: "pending_approval", requestedBy: APPROVER.email }));
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    expect(
      within(dlg).getByText("You requested this payment, so someone else must approve it."),
    ).toBeTruthy();
    expect(within(dlg).queryByRole("button", { name: "Approve payment" })).toBeNull();
    expect(within(dlg).queryByRole("button", { name: "Turn down" })).toBeNull();
  });

  it("explains the server's refusal when it still says no", async () => {
    approvalsBase(APPROVER, undefined, {
      "POST /api/payments/11/approve": () => ({ status: 403, body: { error: "self_approval" } }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    await user.click(within(dlg).getByRole("button", { name: "Approve payment" }));
    expect(
      await within(dlg).findByText("You requested this payment, so someone else must approve it."),
    ).toBeTruthy();
  });

  it("says the payment changed and reads it again when the hash no longer matches", async () => {
    let reads = 0;
    const calls = approvalsBase(APPROVER, undefined, {
      "POST /api/payments/11/approve": () => ({ status: 409, body: { error: "payload_changed" } }),
      "GET /api/payments/11": () => {
        reads += 1;
        return {
          body: {
            payment: payment({
              status: "pending_approval",
              amountMinor: 123457,
              payloadHash: "f".repeat(64),
              approvalsRequired: ["above_limit"],
            }),
            events: [],
          },
        };
      },
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    const before = reads;
    await user.click(within(dlg).getByRole("button", { name: "Approve payment" }));
    expect(await within(dlg).findByText(/The payment changed after you opened it/)).toBeTruthy();
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await within(dlg).findByText("ffffffffffff", { exact: false });
    expect(posts(calls, "/api/payments/11/approve")).toHaveLength(1);
  });

  it("shows an expired request as expired, with nothing to approve", async () => {
    approvalsBase(APPROVER, payment({ status: "expired", statusReason: "expired" }));
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    expect(within(dlg).getAllByText("Expired").length).toBeGreaterThan(0);
    expect(within(dlg).queryByRole("button", { name: "Approve payment" })).toBeNull();
  });

  it("does not offer approving when the request is older than its 24 hours", async () => {
    approvalsBase(
      APPROVER,
      payment({ status: "pending_approval", expiresAt: "2020-01-01T00:00:00.000Z" }),
    );
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    expect(await within(dlg).findByText(/can no longer be approved/)).toBeTruthy();
    expect(within(dlg).queryByRole("button", { name: "Approve payment" })).toBeNull();
  });

  it("asks for a fresh sign-in when the sign-in is old", async () => {
    approvalsBase({ ...APPROVER, stepUpFresh: false });
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    expect(within(dlg).getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(
      (within(dlg).getByRole("button", { name: "Approve payment" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("lets others read but not decide", async () => {
    approvalsBase(FINANCE);
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const dlg = await openFirst(user);
    expect(
      within(dlg).getByText("Only an approver can approve or turn down this payment."),
    ).toBeTruthy();
    expect(within(dlg).queryByRole("button", { name: "Approve payment" })).toBeNull();
  });

  it("lists a waiting batch with its bills", async () => {
    mockFetch({
      "GET /api/auth/me": () => ({ body: APPROVER }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/payments": () => ({ body: { items: [], nextCursor: null } }),
      "GET /api/payment-batches": () => ({
        body: {
          items: [
            batch({ status: "pending_approval", approvalsRequired: ["batch_total_above_limit"] }),
          ],
          nextCursor: null,
        },
      }),
      "GET /api/payment-batches/5": () => ({
        body: {
          batch: batch({
            status: "pending_approval",
            approvalsRequired: ["batch_total_above_limit"],
          }),
          events: [],
        },
      }),
      "GET /api/bank/accounts": () => ({ body: accounts() }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals?tab=payments");
    const t = await screen.findByRole("table", { name: "Payment batches" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    await user.click(within(t).getByRole("button", { name: "2 bills" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("table", { name: "Bills in this batch" })).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: "Approve payment" })).toBeTruthy();
  });
});

// ---- bank details -----------------------------------------------------------------------------

describe("confirming a supplier's bank details", () => {
  function ibanBase(me: Me, over: Record<string, H> = {}) {
    return mockFetch({
      "GET /api/auth/me": () => ({ body: me }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/bills": () => ({
        body: listResponse([
          row({
            id: 1,
            kind: "bill",
            invoiceNumber: "BILL-77",
            relation: { id: 7, name: "Acme Supplies BV" },
          }),
        ]),
      }),
      "GET /api/payments/ibans/7": () => ({ body: { iban: ibanStatus() } }),
      ...over,
    });
  }
  async function open(user: ReturnType<typeof userEvent.setup>) {
    const t = await screen.findByRole("table", { name: "Payables" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    await user.click(within(t).getByRole("button", { name: /Bank details of Acme/ }));
    return screen.findByRole("dialog");
  }

  it("needs the last four characters and sends the fingerprint", async () => {
    const calls = ibanBase(APPROVER, {
      "POST /api/payments/ibans/verify": () => ({
        body: {
          iban: ibanStatus({
            state: "verified_new",
            verifiedBy: APPROVER.email,
            verifiedAt: "2026-11-11T11:00:00.000Z",
          }),
        },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await open(user);
    await within(dlg).findByText("NL91****4300");
    expect(norm(dlg.textContent)).toContain("NL91****4300");
    expect(dlg.textContent).not.toMatch(/NL\d{2}[A-Z]{4}\d{10}/);
    const go = within(dlg).getByRole("button", {
      name: "Confirm these bank details",
    }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.type(within(dlg).getByLabelText("Last four characters"), "4300");
    await user.click(go);
    await within(dlg).findByText(/An approver confirmed this bank account/);
    expect(posts(calls, "/api/payments/ibans/verify")[0]?.body).toEqual({
      relationId: 7,
      fingerprint: "c".repeat(64),
      lastFour: "4300",
    });
    expect(within(dlg).getByRole("button", { name: "Take the confirmation back" })).toBeTruthy();
  });

  it("shows a changed account as changed and lets an approver take a confirmation back", async () => {
    const calls = ibanBase(APPROVER, {
      "GET /api/payments/ibans/7": () => ({
        body: {
          iban: ibanStatus({
            state: "verified_established",
            verifiedBy: "x@camelthorncapital.com",
            verifiedAt: "2026-10-01T00:00:00.000Z",
          }),
        },
      }),
      "POST /api/payments/ibans/revoke": () => ({
        body: { iban: ibanStatus({ state: "unverified" }) },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await open(user);
    await user.click(within(dlg).getByRole("button", { name: "Take the confirmation back" }));
    await user.click(within(dlg).getByRole("button", { name: "Take it back" }));
    await within(dlg).findByText(/No approver has confirmed this bank account yet/);
    expect(posts(calls, "/api/payments/ibans/revoke")[0]?.body).toEqual({ relationId: 7 });
  });

  it("finance can read it but is told to ask an approver", async () => {
    ibanBase(FINANCE);
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await open(user);
    expect(within(dlg).getByText("Ask an approver to confirm these bank details.")).toBeTruthy();
    expect(within(dlg).queryByLabelText("Last four characters")).toBeNull();
  });
});

// ---- Treasury, Bank, Payments -----------------------------------------------------------------

describe("Treasury, Bank, Payments", () => {
  function bankBase(
    me: Me,
    items = [payment({ status: "outcome_unknown" })],
    over: Record<string, H> = {},
  ) {
    return mockFetch({
      "GET /api/auth/me": () => ({ body: me }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/bank/accounts": () => ({ body: accounts() }),
      "GET /api/matching/stats": () => ({ body: stats() }),
      "GET /api/payments": () => ({ body: { items, nextCursor: null } }),
      "GET /api/payment-batches": () => ({ body: { items: [], nextCursor: null } }),
      ...over,
    });
  }
  async function listOpen(user: ReturnType<typeof userEvent.setup>) {
    const t = await screen.findByRole("table", { name: "Payments" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    await user.click(within(t).getByRole("button", { name: "BILL-77" }));
    return screen.findByRole("dialog");
  }

  it("lists payments with their status and an Updated stamp", async () => {
    bankBase(VIEWER, [
      payment({ status: "paid" }),
      payment({ id: 12, invoiceNumber: "BILL-90", status: "failed" }),
    ]);
    renderApp("/treasury/bank?tab=payments");
    const t = await screen.findByRole("table", { name: "Payments" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    expect(within(t).getByText("Paid")).toBeTruthy();
    expect(within(t).getByText("Failed")).toBeTruthy();
    expect(screen.getAllByText(/Updated /).length).toBeGreaterThan(0);
  });

  it("says plainly that an unconfirmed payment must not be paid again", async () => {
    bankBase(VIEWER, undefined, {
      "GET /api/payments/11": () => ({
        body: { payment: payment({ status: "outcome_unknown" }), events: [] },
      }),
    });
    const user = userEvent.setup();
    renderApp("/treasury/bank?tab=payments");
    const dlg = await (async () => {
      const t = await screen.findByRole("table", { name: "Payments" });
      await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
      await user.click(within(t).getByRole("button", { name: "BILL-77" }));
      return screen.findByRole("dialog");
    })();
    await within(dlg).findByText(
      "We could not confirm whether the bank received this payment. Do not pay again. An administrator can check it.",
    );
    expect(within(dlg).queryByRole("button", { name: /Cancel/ })).toBeNull();
  });

  it("shows the history from the event log", async () => {
    bankBase(VIEWER, undefined, {
      "GET /api/payments/11": () => ({
        body: {
          payment: payment({ status: "ready" }),
          events: [
            event(),
            event({
              fromStatus: "draft",
              toStatus: "ready",
              code: "confirmed",
              at: "2026-11-11T10:05:00.000Z",
            }),
          ],
        },
      }),
    });
    const user = userEvent.setup();
    renderApp("/treasury/bank?tab=payments");
    const dlg = await listOpen(user);
    const tl = within(dlg).getByRole("list", { name: "History" });
    expect(within(tl).getAllByRole("listitem")).toHaveLength(2);
    expect(tl.textContent).toContain("Prepared");
    expect(tl.textContent).toContain("Confirmed");
  });

  it("lets the requester cancel, says it is final and offers no undo", async () => {
    const calls = bankBase(FINANCE, [payment({ status: "pending_approval" })], {
      "GET /api/payments/11": () => ({
        body: { payment: payment({ status: "pending_approval" }), events: [] },
      }),
      "POST /api/payments/11/cancel": () => ({
        body: { payment: payment({ status: "cancelled" }) },
      }),
    });
    const user = userEvent.setup();
    renderApp("/treasury/bank?tab=payments");
    const dlg = await listOpen(user);
    expect(within(dlg).getByText(/Cancelling is final and cannot be undone/)).toBeTruthy();
    await user.click(within(dlg).getByRole("button", { name: "Cancel this request" }));
    await user.click(within(dlg).getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(posts(calls, "/api/payments/11/cancel")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
  });

  it("does not show cancel to somebody else's finance colleague who is not the requester or admin", async () => {
    bankBase(APPROVER, [payment({ status: "pending_approval" })], {
      "GET /api/payments/11": () => ({
        body: { payment: payment({ status: "pending_approval" }), events: [] },
      }),
    });
    const user = userEvent.setup();
    renderApp("/treasury/bank?tab=payments");
    const dlg = await listOpen(user);
    expect(within(dlg).queryByRole("button", { name: "Cancel this request" })).toBeNull();
  });

  it("an admin can cancel another person's request", async () => {
    bankBase(ADMIN, [payment({ status: "pending_approval" })], {
      "GET /api/payments/11": () => ({
        body: { payment: payment({ status: "pending_approval" }), events: [] },
      }),
    });
    const user = userEvent.setup();
    renderApp("/treasury/bank?tab=payments");
    const dlg = await listOpen(user);
    expect(within(dlg).getByRole("button", { name: "Cancel this request" })).toBeTruthy();
  });

  it("filters to my requests", async () => {
    const calls = bankBase(FINANCE, []);
    const user = userEvent.setup();
    renderApp("/treasury/bank?tab=payments");
    await screen.findByText("0 payments are open.");
    await user.click(screen.getByRole("checkbox", { name: "Only my requests" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith("/api/payments") && c.url.includes("mine=1"))).toBe(
        true,
      ),
    );
  });
});

// ---- Settings, Payments -----------------------------------------------------------------------

describe("Settings, Payments", () => {
  function settingsBase(data = paymentsSettings(), over: Record<string, H> = {}) {
    return mockFetch({
      "GET /api/auth/me": () => ({ body: ADMIN }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/settings/payments": () => ({ body: data }),
      "GET /api/users": () => ({
        body: {
          users: [
            {
              id: 3,
              email: "appr@camelthorncapital.com",
              roles: ["approver"],
              disabled: false,
              lastLoginAt: null,
            },
            {
              id: 4,
              email: "gone@camelthorncapital.com",
              roles: ["approver"],
              disabled: true,
              lastLoginAt: null,
            },
          ],
          invites: [],
        },
      }),
      ...over,
    });
  }

  it("shows the switch, what stops it, the checklist, placeholders and what is not available", async () => {
    settingsBase();
    const { container } = renderApp("/settings/payments");
    await screen.findByRole("heading", { name: "Controls" });
    expect(screen.getByText("Off")).toBeTruthy();
    expect(
      screen.getByText("The payment path has not been verified on the Revolut sandbox yet."),
    ).toBeTruthy();
    expect(
      screen.getByText("The part that talks to the bank is not built or not available yet."),
    ).toBeTruthy();
    expect(screen.getAllByText("Not done")).toHaveLength(13);
    expect(screen.getAllByText("Placeholder")).toHaveLength(2);
    expect(screen.getAllByText("Not available yet.").length).toBeGreaterThan(0);
    expect(await screen.findByText("appr@camelthorncapital.com")).toBeTruthy();
    expect(screen.queryByText("gone@camelthorncapital.com")).toBeNull();
    expect((screen.getByLabelText(/Four-eyes limit/) as HTMLInputElement).value).toBe("2500.00");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is not a tab for anyone but an admin", async () => {
    mockFetch({
      "GET /api/auth/me": () => ({ body: FINANCE }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
    });
    renderApp("/settings/payments");
    await screen.findByRole("heading", { name: "Settings" });
    expect(screen.queryByRole("button", { name: "Payments" })).toBeNull();
  });

  it("handles a 403 on the settings read honestly", async () => {
    settingsBase(undefined, {
      "GET /api/settings/payments": () => ({ status: 403, body: { error: "forbidden" } }),
    });
    renderApp("/settings/payments");
    expect(await screen.findByText("You do not have access to payment settings.")).toBeTruthy();
  });

  it("saves a tighter control at once, without a phrase", async () => {
    const calls = settingsBase(undefined, {
      "PATCH /api/settings/payments": () => ({
        body: paymentsSettings({
          settings: { ...paymentsSettings().settings, fourEyesLimitMinor: 100000 },
        }),
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    const limit = await screen.findByLabelText(/Four-eyes limit/);
    await user.clear(limit);
    await user.type(limit, "1000,00");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ fourEyesLimitMinor: 100000 });
  });

  it("a loosening needs the typed phrase and sends it", async () => {
    const calls = settingsBase(undefined, {
      "PATCH /api/settings/payments": () => ({ body: paymentsSettings() }),
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    const limit = await screen.findByLabelText(/Four-eyes limit/);
    await user.clear(limit);
    await user.type(limit, "3000");
    expect(screen.getByText(/This loosens four-eyes limit/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const dlg = await screen.findByRole("dialog");
    const go = within(dlg).getByRole("button", { name: "Loosen controls" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    await user.type(
      within(dlg).getByLabelText(new RegExp(PAYMENTS_LOOSEN_PHRASE)),
      PAYMENTS_LOOSEN_PHRASE,
    );
    await user.click(go);
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      fourEyesLimitMinor: 300000,
      confirm: PAYMENTS_LOOSEN_PHRASE,
    });
  });

  it("asks for a fresh sign-in when the server wants one", async () => {
    settingsBase(undefined, {
      "PATCH /api/settings/payments": () => ({
        status: 401,
        body: { error: "step_up_required", loosened: ["fourEyesLimitMinor"] },
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    const limit = await screen.findByLabelText(/Four-eyes limit/);
    await user.clear(limit);
    await user.type(limit, "3000");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const dlg = await screen.findByRole("dialog");
    await user.type(
      within(dlg).getByLabelText(new RegExp(PAYMENTS_LOOSEN_PHRASE)),
      PAYMENTS_LOOSEN_PHRASE,
    );
    await user.click(within(dlg).getByRole("button", { name: "Loosen controls" }));
    expect(await within(dlg).findByRole("button", { name: "Sign in again" })).toBeTruthy();
  });

  it("explains a conflict and reads the settings again", async () => {
    let reads = 0;
    settingsBase(undefined, {
      "GET /api/settings/payments": () => {
        reads += 1;
        return { body: paymentsSettings() };
      },
      "PATCH /api/settings/payments": () => ({ status: 409, body: { error: "conflict" } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    const limit = await screen.findByLabelText(/Four-eyes limit/);
    await user.clear(limit);
    await user.type(limit, "1000");
    const before = reads;
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Somebody else changed this at the same moment/)).toBeTruthy();
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it("refuses one-click pay when the plan is not Company, before asking the server", async () => {
    const calls = settingsBase();
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await screen.findByLabelText(/Four-eyes limit/);
    await user.click(screen.getByRole("button", { name: "One-click pay" }));
    expect(screen.getAllByText(/One-click pay needs the Company plan/).length).toBeGreaterThan(0);
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("shows a verification that is done, and switches off with a question first", async () => {
    const calls = settingsBase(
      paymentsSettings({
        enabled: true,
        blockers: [],
        verified: {
          at: "2026-11-01T09:00:00.000Z",
          by: "gerrie@camelthorncapital.com",
          note: "Done on the sandbox",
          protocolVersion: "f".repeat(64),
          checks: paymentsSettings().verifyChecks,
        },
      }),
      { "PUT /api/settings/payments/switch": () => ({ body: paymentsSettings() }) },
    );
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await screen.findByText(/Verified by gerrie@camelthorncapital.com/);
    expect(screen.getAllByText("Done")).toHaveLength(13);
    await user.click(screen.getByRole("button", { name: "Switch payments off" }));
    await user.click(screen.getByRole("button", { name: "Switch off" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: false });
  });
});
