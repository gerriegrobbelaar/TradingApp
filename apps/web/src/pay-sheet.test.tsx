import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import { norm } from "./test-norm";
import { ONE_DIVISION, listResponse, row } from "./test-fixtures";
import { accounts } from "./test-fixtures-bank";
import {
  APPROVER,
  FINANCE,
  FINANCE_STALE,
  batch,
  payment,
  paymentsSettings,
} from "./test-fixtures-payments";
import type { Me } from "./api";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

const B1 = row({
  id: 1,
  kind: "bill",
  invoiceNumber: "BILL-77",
  relation: { id: 7, name: "Acme Supplies BV" },
  openMinor: 123456,
});
const B2 = row({
  id: 2,
  kind: "bill",
  invoiceNumber: "BILL-78",
  relation: { id: 8, name: "Beta GmbH" },
  openMinor: 20050,
});
const B3 = row({
  id: 3,
  kind: "bill",
  invoiceNumber: "BILL-79",
  relation: { id: 9, name: "Dollar Inc" },
  currency: "USD",
  openMinor: 5000,
});
const PAID_ELSEWHERE = row({
  id: 4,
  kind: "bill",
  invoiceNumber: "BILL-80",
  possiblyPaid: true,
  openMinor: 100,
});

const on = paymentsSettings({ enabled: true, blockers: [] });

function base(
  me: Me,
  extra: Record<string, (c: Call) => { status?: number; body?: unknown }> = {},
) {
  return mockFetch({
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/divisions": () => ({ body: ONE_DIVISION }),
    "GET /api/bills": () => ({ body: listResponse([B1, B2, B3, PAID_ELSEWHERE]) }),
    "GET /api/bank/accounts": () => ({ body: accounts() }),
    "GET /api/settings/payments": () => ({ body: on }),
    ...extra,
  });
}

async function loaded() {
  const t = await screen.findByRole("table", { name: "Payables" });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  return t;
}
const posts = (calls: Call[], path: string) =>
  calls.filter((c) => c.method === "POST" && c.url === path);

async function openPay(user: ReturnType<typeof userEvent.setup>, name = /^Pay BILL-77/) {
  const t = await loaded();
  await user.click(within(t).getByRole("button", { name }));
  return screen.findByRole("dialog");
}

describe("roles on the Payables table", () => {
  it("a viewer sees no Pay, no tick boxes and no bank details", async () => {
    base(VIEWER);
    renderApp("/purchases/payables");
    const t = await loaded();
    expect(within(t).queryByRole("button", { name: /^Pay / })).toBeNull();
    expect(within(t).queryByRole("checkbox")).toBeNull();
    expect(within(t).queryByRole("button", { name: /Bank details/ })).toBeNull();
  });

  it("an approver sees bank details but cannot request a payment", async () => {
    base(APPROVER);
    renderApp("/purchases/payables");
    const t = await loaded();
    expect(within(t).queryByRole("button", { name: /^Pay / })).toBeNull();
    expect(within(t).getAllByRole("button", { name: /Bank details/ }).length).toBeGreaterThan(0);
  });

  it("finance sees Pay on payable bills and a note instead on a possibly paid one", async () => {
    base(FINANCE);
    renderApp("/purchases/payables");
    const t = await loaded();
    expect(within(t).getByRole("button", { name: /^Pay BILL-77, €\s1\.234,56/ })).toBeTruthy();
    expect(within(t).queryByRole("button", { name: /^Pay BILL-80/ })).toBeNull();
    expect(within(t).getByText("Check first")).toBeTruthy();
  });
});

describe("the Pay sheet when payments are switched off", () => {
  it("says so plainly and cannot create anything", async () => {
    const calls = base(FINANCE, {
      "GET /api/settings/payments": () => ({ body: paymentsSettings() }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await openPay(user);
    const note = await within(dlg).findByTestId("payments-disabled");
    expect(note.textContent).toContain("Payments are switched off, so nothing can be paid");
    const review = within(dlg).getByRole("button", { name: "Review payment" });
    expect((review as HTMLButtonElement).disabled).toBe(true);
    expect(within(dlg).queryByRole("radio")).toBeNull();
    expect(posts(calls, "/api/payments")).toHaveLength(0);
  });

  it("shows the server's payments_disabled block in plain words when the switch flipped meanwhile", async () => {
    const calls = base(FINANCE, {
      "POST /api/payments": () => ({
        status: 422,
        body: { error: "blocked", blocks: ["payments_disabled"], warnings: [] },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await openPay(user);
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
    expect(await within(dlg).findByText(/Payments are switched off/)).toBeTruthy();
    expect(posts(calls, "/api/payments")).toHaveLength(1);
  });
});

describe("blocks are plain sentences", () => {
  it("renders what is wrong and what to do per code, and a generic sentence for an unknown code", async () => {
    base(FINANCE, {
      "POST /api/payments": () => ({
        status: 422,
        body: {
          error: "blocked",
          blocks: ["invoice_not_approved", "iban_unverified", "some_future_code"],
          warnings: [],
        },
      }),
      "GET /api/payments/ibans/7": () => ({
        body: { iban: { ...paymentsIban(), state: "unverified" } },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await openPay(user);
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
    const alert = await within(dlg).findByText("This payment cannot be requested yet.");
    const box = alert.closest("[role='alert']") as HTMLElement;
    const items = within(box).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(box.textContent).toContain("This bill is not approved in Exact.");
    expect(box.textContent).toContain("Ask an approver to confirm the bank account");
    expect(box.textContent).toContain("This payment cannot be requested right now.");
    for (const li of items) expect((li.textContent ?? "").trim().length).toBeGreaterThan(20);
    expect(box.textContent).not.toContain("some_future_code");
    expect(box.textContent).not.toContain("invoice_not_approved");
    expect(await within(dlg).findByTestId("iban-hint")).toBeTruthy();
  });
});

function paymentsIban() {
  return {
    relationId: 7,
    name: "Acme Supplies BV",
    isSupplier: true,
    ibanMasked: "NL91****4300",
    ibanFingerprint: "c".repeat(64),
    state: "unverified",
    verifiedBy: null,
    verifiedAt: null,
    readAt: null,
  };
}

describe("a single payment, from request to result", () => {
  function flow(over: { me?: Me; created?: ReturnType<typeof payment>; confirmed?: unknown } = {}) {
    const created = over.created ?? payment({ approvalsRequired: ["above_limit"] });
    let current = created;
    const calls = base(over.me ?? FINANCE, {
      "POST /api/payments": () => ({
        status: 201,
        body: { payment: created, replayed: false, warnings: ["balance_stale"] },
      }),
      "POST /api/payments/11/confirm": () => {
        current =
          (over.confirmed as ReturnType<typeof payment> | undefined) ??
          payment({ status: "pending_approval", approvalsRequired: ["above_limit"] });
        return { body: { payment: current } };
      },
      "GET /api/payments/11": () => ({ body: { payment: current, events: [] } }),
    });
    return calls;
  }

  async function review(user: ReturnType<typeof userEvent.setup>) {
    const dlg = await openPay(user);
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
    await within(dlg).findByTestId("pay-phrase");
    return dlg;
  }

  it("shows everything §4.3 asks for before anything is confirmed", async () => {
    const calls = flow();
    const user = userEvent.setup();
    const { container } = renderApp("/purchases/payables");
    const dlg = await review(user);
    const create = posts(calls, "/api/payments")[0];
    expect(create?.body).toMatchObject({ openItemId: 1, sourceAccountId: 1 });
    expect((create?.body as { clientKey: string }).clientKey).toMatch(/^ui-/);
    const text = norm(dlg.textContent);
    expect(text).toContain("Acme Supplies BV");
    expect(text).toContain("NL91****4300");
    expect(text).toContain("Verified by an approver");
    expect(text).toContain("€ 1.234,56");
    expect(text).toContain("Invoice BILL-77");
    expect(text).toContain("Main EUR");
    expect(text).toMatch(/Last known balance € 12\.345,67, read /);
    expect(text).toContain("The amount is above the four-eyes limit.");
    expect(text).toContain("The balance of the source account was read some time ago.");
    expect(text).toContain("Nothing is sent to the bank until an approver has approved it.");
    // the full IBAN never appears: last four only next to a mask
    expect(dlg.textContent).not.toMatch(/NL\d{2}[A-Z]{4}\d{10}/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows the phrase as text, leaves the field empty and compares exactly", async () => {
    const calls = flow();
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await review(user);
    expect(within(dlg).getByTestId("pay-phrase").textContent).toBe("PAY 1234.56 EUR TO 4300");
    const input = within(dlg).getByLabelText("Confirmation text") as HTMLInputElement;
    expect(input.value).toBe("");
    const confirm = within(dlg).getByRole("button", { name: "Confirm and ask for approval" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    for (const wrong of [
      "pay 1234.56 EUR TO 4300",
      "PAY 1234.56 EUR TO 4300 ",
      " PAY 1234.56 EUR TO 4300",
      "PAY 1234.56 EUR TO 4301",
      "PAY 1234,56 EUR TO 4300",
    ]) {
      await user.clear(input);
      await user.click(input);
      await user.paste(wrong);
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
    }
    await user.clear(input);
    await user.click(input);
    await user.paste("PAY 1234.56 EUR TO 4300"); // pasting is allowed
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    expect(posts(calls, "/api/payments/11/confirm")).toHaveLength(0);
  });

  it("sends the typed text once even on a double click and shows Waiting for approval", async () => {
    const calls = flow();
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await review(user);
    await user.type(within(dlg).getByLabelText("Confirmation text"), "PAY 1234.56 EUR TO 4300");
    const confirm = within(dlg).getByRole("button", { name: "Confirm and ask for approval" });
    await user.dblClick(confirm);
    await within(dlg).findByText(
      "A second person must approve this before it can be sent. Nothing has been sent.",
    );
    expect(posts(calls, "/api/payments/11/confirm")).toHaveLength(1);
    expect(posts(calls, "/api/payments/11/confirm")[0]?.body).toEqual({
      confirm: "PAY 1234.56 EUR TO 4300",
    });
    expect(within(dlg).getAllByText("Waiting for approval").length).toBeGreaterThan(0);
    expect(within(dlg).queryByText("Paid")).toBeNull();
  });

  it("never shows Paid because of the request alone: only when the server says paid", async () => {
    const calls = flow({
      created: payment(),
      confirmed: payment({ status: "ready", confirmedAt: "2026-11-11T10:05:00.000Z" }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await review(user);
    await user.type(within(dlg).getByLabelText("Confirmation text"), "PAY 1234.56 EUR TO 4300");
    await user.click(within(dlg).getByRole("button", { name: "Confirm payment" }));
    await within(dlg).findByText("Confirmed and queued. It has not been sent to the bank yet.");
    expect(within(dlg).queryByText("Paid")).toBeNull();
    expect(within(dlg).getAllByText("Paying").length).toBeGreaterThan(0);
    expect(norm(dlg.textContent)).toContain("waits as a draft in the Revolut app");
    // the server now reports paid
    calls.length = 0;
    mockFetch({
      "GET /api/auth/me": () => ({ body: FINANCE }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/payments/11": () => ({
        body: { payment: payment({ status: "paid" }), events: [] },
      }),
    });
    await user.click(within(dlg).getByRole("button", { name: "Check status again" }));
    await within(dlg).findByText("The bank confirmed the payment.");
    expect(within(dlg).getAllByText("Paid").length).toBeGreaterThan(0);
  });

  it("explains a failed payment with its reason", async () => {
    flow({
      created: payment(),
      confirmed: payment({ status: "failed", statusReason: "bank_failed" }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await review(user);
    await user.type(within(dlg).getByLabelText("Confirmation text"), "PAY 1234.56 EUR TO 4300");
    await user.click(within(dlg).getByRole("button", { name: "Confirm payment" }));
    await within(dlg).findByText("The bank did not make this payment.");
    expect(within(dlg).getByText("The bank reported that the payment failed.")).toBeTruthy();
  });

  it("refuses to go on when the server's phrase differs from the amount on screen", async () => {
    flow({ created: payment({ confirmPhrase: "PAY 1.00 EUR TO 4300" }) });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await openPay(user);
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
    await within(dlg).findByText(/does not match the amount shown here/);
    expect(within(dlg).queryByLabelText("Confirmation text")).toBeNull();
  });

  it("asks for a fresh sign-in first when the sign-in is old, and handles the server's 401", async () => {
    flow({ me: FINANCE_STALE });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await review(user);
    expect(within(dlg).getByRole("button", { name: "Sign in again" })).toBeTruthy();
    await user.type(within(dlg).getByLabelText("Confirmation text"), "PAY 1234.56 EUR TO 4300");
    expect(
      (
        within(dlg).getByRole("button", {
          name: "Confirm and ask for approval",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows the step-up button when the server answers step_up_required", async () => {
    base(FINANCE, {
      "POST /api/payments": () => ({
        status: 201,
        body: { payment: payment(), replayed: false, warnings: [] },
      }),
      "POST /api/payments/11/confirm": () => ({ status: 401, body: { error: "step_up_required" } }),
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
    expect(await within(dlg).findByRole("button", { name: "Sign in again" })).toBeTruthy();
  });

  it("cancelling is final and says so; there is no undo", async () => {
    const calls = flow();
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const dlg = await review(user);
    expect(within(dlg).getByText(/Cancelling is final and cannot be undone/)).toBeTruthy();
    calls.push();
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
  });
});

describe("keyboard and focus", () => {
  it("returns focus to the Pay button when the sheet closes with Escape", async () => {
    base(FINANCE);
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const t = await loaded();
    const pay = within(t).getByRole("button", { name: /^Pay BILL-77/ });
    await user.click(pay);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(pay);
  });

  it("asks before throwing away a half-typed confirmation", async () => {
    base(FINANCE, {
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
    await user.type(await within(dlg).findByLabelText("Confirmation text"), "PAY");
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("alertdialog", { name: /Discard what you typed/ })).toBeTruthy();
  });
});

describe("a batch", () => {
  it("selects bills of one currency, shows the total and a per-bill list, and posts one batch", async () => {
    const created = batch({ approvalsRequired: ["batch_total_above_limit"] });
    const calls = base(FINANCE, {
      "POST /api/payment-batches": () => ({
        status: 201,
        body: { batch: created, replayed: false },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const t = await loaded();
    await user.click(within(t).getByRole("checkbox", { name: "Select BILL-77 to pay" }));
    await user.click(within(t).getByRole("checkbox", { name: "Select BILL-78 to pay" }));
    // another currency cannot join
    expect(
      (within(t).getByRole("checkbox", { name: "Select BILL-79 to pay" }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    const bar = screen.getByRole("region", { name: "Selected bills" });
    expect(norm(bar.textContent)).toContain("2 bills selected, total € 1.435,06");
    await user.click(within(bar).getByRole("button", { name: "Pay selected bills" }));
    const dlg = await screen.findByRole("dialog");
    expect(norm(dlg.textContent)).toContain("€ 1.435,06 over 2 bills");
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
    await within(dlg).findByTestId("pay-phrase");
    expect(posts(calls, "/api/payment-batches")[0]?.body).toMatchObject({
      sourceAccountId: 1,
      items: [{ openItemId: 1 }, { openItemId: 2 }],
    });
    expect(within(dlg).getByTestId("pay-phrase").textContent).toBe(
      "PAY BATCH 2 INVOICES 300.50 EUR",
    );
    const rows = within(
      within(dlg).getByRole("table", { name: "Bills in this batch" }),
    ).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(norm(dlg.textContent)).toContain("The total of the batch is above the four-eyes limit.");
  });

  it("names the bill that blocks a batch", async () => {
    base(FINANCE, {
      "POST /api/payment-batches": () => ({
        status: 422,
        body: {
          error: "blocked",
          blocks: ["batch_item_blocked"],
          itemBlocks: [{ openItemId: 2, blocks: ["iban_missing"] }],
        },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const t = await loaded();
    await user.click(within(t).getByRole("checkbox", { name: "Select BILL-77 to pay" }));
    await user.click(within(t).getByRole("checkbox", { name: "Select BILL-78 to pay" }));
    await user.click(screen.getByRole("button", { name: "Pay selected bills" }));
    const dlg = await screen.findByRole("dialog");
    await user.click(await within(dlg).findByRole("radio", { name: /Main EUR/ }));
    await user.click(within(dlg).getByRole("button", { name: "Review payment" }));
    expect(
      await within(dlg).findByText(/At least one bill in the batch cannot be paid yet/),
    ).toBeTruthy();
    expect(within(within(dlg).getByRole("alert")).getByText("BILL-78")).toBeTruthy();
    expect(within(dlg).getByText(/The supplier has no bank account in Exact/)).toBeTruthy();
  });
});
