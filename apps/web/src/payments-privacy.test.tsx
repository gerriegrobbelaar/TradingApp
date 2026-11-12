import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADMIN, mockFetch, renderApp } from "./test-utils";
import { ONE_DIVISION, listResponse, row } from "./test-fixtures";
import { accounts } from "./test-fixtures-bank";
import { stats } from "./test-fixtures-matching";
import { APPROVER, event, ibanStatus, payment } from "./test-fixtures-payments";

const FULL = "NL91ABNA0417164300";
const LIKE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;

describe("no full IBAN reaches the page", () => {
  it("masks IBANs typed or sent into any text field of a payment", async () => {
    const p = payment({
      status: "failed",
      supplierName: `Acme ${FULL}`,
      reference: `Invoice ${FULL}`,
      invoiceNumber: `X ${FULL}`,
      sourceAccountName: `Main ${FULL}`,
      statusReason: `bank_failed ${FULL}`,
      decision: {
        decision: "approved",
        by: "appr@camelthorncapital.com",
        at: "2026-11-11T11:00:00.000Z",
        note: `pay ${FULL}`,
      },
    });
    mockFetch({
      "GET /api/auth/me": () => ({ body: ADMIN }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/bank/accounts": () => ({ body: accounts() }),
      "GET /api/matching/stats": () => ({ body: stats() }),
      "GET /api/payments": () => ({ body: { items: [p], nextCursor: null } }),
      "GET /api/payment-batches": () => ({ body: { items: [], nextCursor: null } }),
      "GET /api/payments/11": () => ({
        body: {
          payment: p,
          events: [event({ actor: `x ${FULL}`, code: `provider_rejected:${FULL}` })],
        },
      }),
    });
    const user = userEvent.setup();
    renderApp("/treasury/bank?tab=payments");
    const t = await screen.findByRole("table", { name: "Payments" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    await user.click(within(t).getAllByRole("button")[0] as HTMLElement);
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByText("History");
    for (const root of [document.body]) {
      expect(root.innerHTML).not.toContain(FULL);
      expect(root.textContent ?? "").not.toMatch(LIKE);
    }
    expect(window.location.href).not.toContain(FULL);
  });

  it("masks a full IBAN in the bank details sheet too", async () => {
    mockFetch({
      "GET /api/auth/me": () => ({ body: APPROVER }),
      "GET /api/divisions": () => ({ body: ONE_DIVISION }),
      "GET /api/bills": () => ({
        body: listResponse([
          row({ id: 1, kind: "bill", relation: { id: 7, name: "Acme Supplies BV" } }),
        ]),
      }),
      "GET /api/payments/ibans/7": () => ({
        body: { iban: ibanStatus({ name: `Acme ${FULL}`, ibanMasked: FULL }) },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/payables");
    const t = await screen.findByRole("table", { name: "Payables" });
    await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
    await user.click(within(t).getByRole("button", { name: /Bank details of/ }));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByText(/Bank account/);
    await waitFor(() => expect(dlg.textContent).toContain("State"));
    expect(document.body.innerHTML).not.toContain(FULL);
    expect(document.body.textContent ?? "").not.toMatch(LIKE);
  });
});
