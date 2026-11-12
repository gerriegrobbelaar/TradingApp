/**
 * Send to bank (F9c, ADR 0054). The click on the confirmation is the only way a request reaches the
 * bank from the web, so: finance only, a fresh sign-in, one call per decision, success only when the
 * server says so, a sentence for every refusal, and no Send button after an answer we could not read.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import { norm } from "./test-norm";
import { ONE_DIVISION } from "./test-fixtures";
import { accounts } from "./test-fixtures-bank";
import { stats } from "./test-fixtures-matching";
import { APPROVER, FINANCE, FINANCE_STALE, batch, event, payment } from "./test-fixtures-payments";
import type { Me } from "./api";
import type { BatchDto, PaymentDto } from "@camelthorn/core";
import {
  SEND_NEXT_TEXT,
  SEND_RESULT_TEXT,
  SEND_TEXT,
  SEND_UNSURE_TEXT,
} from "./lib/payment-send-labels";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
type H = (c: Call) => { status?: number; body?: unknown };

const READY = (over: Partial<PaymentDto> = {}) =>
  payment({
    status: "ready",
    approvalsRequired: ["above_limit"],
    decision: {
      decision: "approved",
      by: APPROVER.email,
      at: "2026-11-11T11:00:00.000Z",
      note: null,
    },
    ...over,
  });

function base(me: Me, current: PaymentDto | BatchDto, over: Record<string, H> = {}) {
  const isBatch = current.kind === "batch";
  return mockFetch({
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/divisions": () => ({ body: ONE_DIVISION }),
    "GET /api/bank/accounts": () => ({ body: accounts() }),
    "GET /api/matching/stats": () => ({ body: stats() }),
    "GET /api/payments": () => ({ body: { items: isBatch ? [] : [current], nextCursor: null } }),
    "GET /api/payment-batches": () => ({
      body: { items: isBatch ? [current] : [], nextCursor: null },
    }),
    "GET /api/payments/11": () => ({ body: { payment: current, events: [event()] } }),
    "GET /api/payment-batches/5": () => ({ body: { batch: current, events: [event()] } }),
    ...over,
  });
}
const submits = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && /\/submit$/.test(c.url));

async function openRow(user: ReturnType<typeof userEvent.setup>, name = "BILL-77") {
  const t = await screen.findByRole("table", {
    name: name === "BILL-77" ? "Payments" : "Payment batches",
  });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  await user.click(within(t).getByRole("button", { name }));
  return screen.findByRole("dialog");
}
const PATH = "/treasury/bank?tab=payments";

describe("who sees Send to bank", () => {
  it("finance sees it on an approved request", async () => {
    base(FINANCE, READY());
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    expect(within(dlg).getByRole("button", { name: "Send to bank" })).toBeTruthy();
    expect(within(dlg).getAllByText("Approved, not sent yet").length).toBeGreaterThan(0);
    expect(norm(dlg.textContent)).not.toContain("Confirmed and queued");
  });

  for (const [who, me] of [
    ["an approver", APPROVER],
    ["an administrator without the finance role", ADMIN],
    ["a viewer", VIEWER],
  ] as const) {
    it(`${who} does not`, async () => {
      base(me, READY());
      const user = userEvent.setup();
      renderApp(PATH);
      const dlg = await openRow(user);
      expect(within(dlg).getAllByText("Approved, not sent yet").length).toBeGreaterThan(0);
      expect(within(dlg).queryByRole("button", { name: /send/i })).toBeNull();
    });
  }

  it("is not offered for any other status", async () => {
    for (const status of [
      "draft",
      "pending_approval",
      "submitted",
      "paid",
      "outcome_unknown",
    ] as const) {
      base(FINANCE, payment({ status, settlement: "awaiting_match" }));
      const user = userEvent.setup();
      const { unmount } = renderApp(PATH);
      const dlg = await openRow(user);
      expect(within(dlg).queryByRole("button", { name: "Send to bank" }), status).toBeNull();
      unmount();
    }
  });
});

describe("the confirmation", () => {
  it("restates what will be sent and what happens next, for drafts", async () => {
    const calls = base(FINANCE, READY());
    const user = userEvent.setup();
    const { container } = renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    const sec = within(dlg).getByRole("region", { name: "Send to the bank" });
    const text = norm(sec.textContent);
    expect(text).toContain("Acme Supplies BV");
    expect(text).toContain("NL91****4300");
    expect(text).toContain("€ 1.234,56");
    expect(text).toContain("Invoice BILL-77");
    expect(text).toContain("Draft in the Revolut app");
    expect(text).toContain(
      "A draft is created in Revolut. You must approve it in the Revolut app. Nothing is paid until you do.",
    );
    expect(text).not.toContain("The bank pays immediately.");
    expect(document.activeElement?.textContent).toBe("Send to the bank");
    expect(submits(calls)).toHaveLength(0);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says the bank pays immediately in pay mode", async () => {
    base(FINANCE, READY({ mode: "pay" }));
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    const sec = within(dlg).getByRole("region", { name: "Send to the bank" });
    expect(sec.textContent).toContain("The bank pays immediately.");
    expect(sec.textContent).toContain("One-click pay");
    expect(sec.textContent).not.toContain("approve it in the Revolut app");
    expect(SEND_NEXT_TEXT.pay).toBe("The bank pays immediately.");
  });

  it("Back closes it without a call and returns the focus", async () => {
    const calls = base(FINANCE, READY());
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    await user.click(within(dlg).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Send to bank"));
    expect(submits(calls)).toHaveLength(0);
  });

  it("needs a fresh sign-in: the button is off and the sign-in button shows", async () => {
    const calls = base(FINANCE_STALE, READY());
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    expect(within(dlg).getByRole("button", { name: "Sign in again" })).toBeTruthy();
    const go = within(dlg).getByRole("button", { name: "Create the draft in Revolut" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    expect(submits(calls)).toHaveLength(0);
  });
});

describe("sending", () => {
  it("one call even on a double click; success only because the server said submitted", async () => {
    let current = READY();
    const calls = base(FINANCE, current, {
      "GET /api/payments/11": () => ({ body: { payment: current, events: [event()] } }),
      "POST /api/payments/11/submit": () => {
        current = payment({ ...current, status: "submitted", providerId: null });
        return {
          body: { result: { to: "submitted", code: "accepted" }, payment: current },
        };
      },
    });
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    const go = within(dlg).getByRole("button", { name: "Create the draft in Revolut" });
    await user.dblClick(go);
    await within(dlg).findByTestId("send-result");
    expect(submits(calls)).toHaveLength(1);
    expect(submits(calls)[0]?.url).toBe("/api/payments/11/submit");
    const text = norm(dlg.textContent);
    expect(text).toContain(SEND_RESULT_TEXT.submitted_drafts);
    expect(within(dlg).getAllByText("Waiting for approval in Revolut").length).toBeGreaterThan(0);
    expect(text).toContain("Open the Revolut app and approve it there");
    expect(
      within(dlg).queryByRole("button", { name: /send to bank|create the draft/i }),
    ).toBeNull();
    expect(within(dlg).queryByText("Paid")).toBeNull();
  });

  it("a pay-mode send that was handled says the bank has it, and still not Paid", async () => {
    let current = READY({ mode: "pay" });
    base(FINANCE, current, {
      "GET /api/payments/11": () => ({ body: { payment: current, events: [] } }),
      "POST /api/payments/11/submit": () => {
        current = payment({ ...current, status: "submitted" });
        return { body: { result: { to: "submitted", code: "accepted" }, payment: current } };
      },
    });
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    await user.click(within(dlg).getByRole("button", { name: "Pay now" }));
    await within(dlg).findByText(SEND_RESULT_TEXT.submitted_pay);
    expect(within(dlg).queryByText("Paid")).toBeNull();
    expect(within(dlg).getAllByText("Paying").length).toBeGreaterThan(0);
  });

  it("an unknown outcome is not success, and the Send button is gone", async () => {
    let current = READY();
    base(FINANCE, current, {
      "GET /api/payments/11": () => ({ body: { payment: current, events: [] } }),
      "POST /api/payments/11/submit": () => {
        current = payment({ ...current, status: "outcome_unknown" });
        return {
          body: { result: { to: "outcome_unknown", code: "outcome_unknown" }, payment: current },
        };
      },
    });
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    await user.click(within(dlg).getByRole("button", { name: "Create the draft in Revolut" }));
    await within(dlg).findByText(SEND_RESULT_TEXT.outcome_unknown);
    const text = norm(dlg.textContent);
    expect(text).toContain("Do not send it again");
    expect(text).not.toContain("Waiting for approval in Revolut");
    expect(text).not.toContain("was created in Revolut");
    expect(
      within(dlg).queryByRole("button", { name: /send to bank|create the draft/i }),
    ).toBeNull();
    expect(within(dlg).getAllByText("Not confirmed").length).toBeGreaterThan(0);
  });

  it("a bank refusal is reported as one, with its reason, and nothing good", async () => {
    let current = READY();
    base(FINANCE, current, {
      "GET /api/payments/11": () => ({ body: { payment: current, events: [] } }),
      "POST /api/payments/11/submit": () => {
        current = payment({
          ...current,
          status: "rejected",
          statusReason: "provider_rejected:prior_attempt_live",
        });
        return {
          body: {
            result: { to: "rejected", code: "provider_rejected:prior_attempt_live" },
            payment: current,
          },
        };
      },
    });
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    await user.click(within(dlg).getByRole("button", { name: "Create the draft in Revolut" }));
    const note = await within(dlg).findByTestId("send-result");
    expect(note.textContent).toContain("The bank did not take this request. Nothing was paid.");
    expect(note.textContent).toContain("do not pay again");
    expect(note.className).toContain("warn");
    expect(norm(dlg.textContent)).not.toContain("was created in Revolut");
  });

  it("a 200 the screen cannot read is not success", async () => {
    const current = READY();
    base(FINANCE, current, {
      "POST /api/payments/11/submit": () => ({
        body: { result: { to: "wonderful" }, payment: current },
      }),
    });
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    await user.click(within(dlg).getByRole("button", { name: "Create the draft in Revolut" }));
    await within(dlg).findByText(SEND_UNSURE_TEXT);
    expect(
      within(dlg).queryByRole("button", { name: /send to bank|create the draft/i }),
    ).toBeNull();
  });

  it("a batch goes to the batch route", async () => {
    let current = batch({
      status: "ready",
      approvalsRequired: ["batch_total_above_limit"],
    });
    const calls = base(FINANCE, current, {
      "GET /api/payment-batches/5": () => ({ body: { batch: current, events: [] } }),
      "POST /api/payment-batches/5/submit": () => {
        current = batch({ ...current, status: "submitted" });
        return { body: { result: { to: "submitted", code: "accepted" }, batch: current } };
      },
    });
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user, "2 bills");
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    const sec = within(dlg).getByRole("region", { name: "Send to the bank" });
    expect(sec.textContent).toContain("Beta GmbH");
    expect(sec.textContent).toContain("NL91****4300");
    await user.click(within(dlg).getByRole("button", { name: "Create the draft in Revolut" }));
    await within(dlg).findByText(SEND_RESULT_TEXT.submitted_drafts);
    expect(submits(calls)[0]?.url).toBe("/api/payment-batches/5/submit");
  });
});

describe("refusals and failures", () => {
  const CODES: [string, number][] = [
    ["busy", 409],
    ["payment_lease", 409],
    ["prior_attempt_live", 409],
    ["prior_attempt_unchecked", 409],
    ["pay_mode_not_verified", 409],
    ["submitter_unavailable", 409],
    ["requester_inactive", 409],
    ["controls_changed", 409],
    ["iban_binding_broken", 409],
    ["counterparty_account_ambiguous", 409],
    ["payments_disabled", 409],
    ["already_claimed", 409],
    ["not_ready", 409],
    ["expired", 409],
    ["precheck:invoice_not_approved", 409],
  ];
  for (const [code, status] of CODES) {
    it(`${code}: its own sentence, nothing sent, and a later try is allowed`, async () => {
      const calls = base(FINANCE, READY(), {
        "POST /api/payments/11/submit": () => ({ status, body: { error: code } }),
      });
      const user = userEvent.setup();
      renderApp(PATH);
      const dlg = await openRow(user);
      await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
      await user.click(within(dlg).getByRole("button", { name: "Create the draft in Revolut" }));
      const alert = await within(dlg).findByRole("alert");
      const text = norm(alert.textContent);
      expect(text).not.toMatch(/[a-z]+_[a-z_]+/);
      expect(text.length).toBeGreaterThan(30);
      if (!code.startsWith("prior_attempt") && code !== "counterparty_account_ambiguous") {
        expect(text.toLowerCase()).toMatch(
          /not sent|nothing was sent|not waiting to be sent|already sending|expired/,
        );
      }
      expect(submits(calls)).toHaveLength(1);
      // Refused before anything was claimed: the button is still there for a later try.
      expect(within(dlg).getByRole("button", { name: "Send to bank" })).toBeTruthy();
    });
  }

  it("a refusal code this version does not know gets the fixed sentence, not the server's text", async () => {
    base(FINANCE, READY(), {
      "POST /api/payments/11/submit": () => ({ status: 409, body: { error: "brand_new_refusal" } }),
    });
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    await user.click(within(dlg).getByRole("button", { name: "Create the draft in Revolut" }));
    const alert = await within(dlg).findByRole("alert");
    expect(alert.textContent).toBe(
      "This request was not sent. Reload the page and look at its status before you try again.",
    );
  });

  it("a server error is NOT promised to be a refusal: do not send again, and no Send button", async () => {
    const calls = base(FINANCE, READY(), {
      "POST /api/payments/11/submit": () => ({ status: 500, body: { error: "internal" } }),
    });
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    await user.click(within(dlg).getByRole("button", { name: "Create the draft in Revolut" }));
    await within(dlg).findByText(SEND_UNSURE_TEXT);
    expect(norm(dlg.textContent).toLowerCase()).not.toContain("nothing was sent");
    expect(
      within(dlg).queryByRole("button", { name: /send to bank|create the draft/i }),
    ).toBeNull();
    expect(submits(calls)).toHaveLength(1);
  });

  it("no answer at all (network): same, never a second call", async () => {
    let n = 0;
    const calls = base(FINANCE, READY());
    // Replace fetch for the submit only: the page's own reads keep working.
    const real = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (/\/submit$/.test(url)) {
        n++;
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return real(url, init);
    }) as typeof fetch;
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    await user.click(within(dlg).getByRole("button", { name: "Create the draft in Revolut" }));
    await within(dlg).findByText(SEND_UNSURE_TEXT);
    expect(n).toBe(1);
    expect(
      within(dlg).queryByRole("button", { name: /send to bank|create the draft/i }),
    ).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("the server's 401 for a missing fresh sign-in shows the sign-in button and sends nothing", async () => {
    base(FINANCE, READY(), {
      "POST /api/payments/11/submit": () => ({ status: 401, body: { error: "step_up_required" } }),
    });
    const user = userEvent.setup();
    renderApp(PATH);
    const dlg = await openRow(user);
    await user.click(within(dlg).getByRole("button", { name: "Send to bank" }));
    await user.click(within(dlg).getByRole("button", { name: "Create the draft in Revolut" }));
    await within(dlg).findByRole("button", { name: "Sign in again" });
    expect(within(dlg).getByRole("button", { name: "Create the draft in Revolut" })).toBeTruthy();
  });

  it("every sentence in the send map is plain: sentence case, no raw codes, no exclamation marks", () => {
    for (const s of Object.values(SEND_TEXT)) {
      expect(s).not.toContain("!");
      expect(s).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(s).toMatch(/^[A-Z].*\.$/);
    }
  });
});
