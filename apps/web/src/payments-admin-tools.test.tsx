/**
 * Settings, Payments admin tools (F9c, ADR 0054): enable, verification record, draft expiry,
 * unknown outcomes (resolve-not-sent) and Preview payment. Admin only, step-up and typed phrases,
 * no full IBAN anywhere, nothing kept in the browser.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import {
  PAYMENTS_ENABLE_PHRASE,
  PAYMENTS_RESOLVE_PHRASE,
  PAYMENTS_VERIFY_CHECKS,
  PAYMENTS_VERIFY_PHRASE,
  PAYMENTS_VERIFY_RUNBOOK,
} from "@camelthorn/core";
import { ADMIN, mockFetch, renderApp, type Call } from "./test-utils";
import { norm } from "./test-norm";
import { ONE_DIVISION } from "./test-fixtures";
import { FINANCE, batch, payment, paymentsSettings } from "./test-fixtures-payments";
import type { Me } from "./api";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
type H = (c: Call) => { status?: number; body?: unknown };
const FULL_IBAN = "NL91ABNA0417164300";

function page(over: Record<string, H> = {}, me: Me = ADMIN) {
  return mockFetch({
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/divisions": () => ({ body: ONE_DIVISION }),
    "GET /api/users": () => ({ body: { users: [], invites: [] } }),
    "GET /api/payments": () => ({ body: { items: [], nextCursor: null } }),
    "GET /api/payment-batches": () => ({ body: { items: [], nextCursor: null } }),
    ...over,
  });
}
const posts = (calls: Call[], method: string, url: string) =>
  calls.filter((c) => c.method === method && c.url === url);
const ready = () =>
  paymentsSettings({
    verified: {
      at: "2026-11-10T10:00:00.000Z",
      by: ADMIN.email,
      note: "tested on the sandbox",
      protocolVersion: "f".repeat(64),
      checks: [...PAYMENTS_VERIFY_CHECKS],
    },
    blockers: ["payments_disabled"],
    draftExpiryDays: 5,
    verifyRunbook: PAYMENTS_VERIFY_RUNBOOK as never,
  });

describe("switching payments on", () => {
  it("is off while something still stops payments, and says why", async () => {
    page({ "GET /api/settings/payments": () => ({ body: paymentsSettings() }) });
    renderApp("/settings/payments");
    const on = (await screen.findByRole("button", {
      name: "Switch payments on",
    })) as HTMLButtonElement;
    expect(on.disabled).toBe(true);
    expect(
      screen.getByText(/The payment path has not been verified on the Revolut sandbox/),
    ).toBeTruthy();
  });

  it("with no blockers it asks for the typed phrase and the server's answer decides", async () => {
    let enabled = false;
    const calls = page({
      "GET /api/settings/payments": () => ({ body: { ...ready(), enabled } }),
      "PUT /api/settings/payments/switch": () => {
        enabled = true;
        return { body: { ...ready(), enabled } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await user.click(await screen.findByRole("button", { name: "Switch payments on" }));
    const dlg = await screen.findByRole("dialog");
    expect(norm(dlg.textContent)).toContain("Real money can leave the company");
    const go = within(dlg).getByRole("button", { name: "Switch payments on" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.type(within(dlg).getByLabelText(/Type “ENABLE PAYMENTS”/), "enable payments");
    expect(go.disabled).toBe(true);
    await user.clear(within(dlg).getByLabelText(/Type “ENABLE PAYMENTS”/));
    await user.type(within(dlg).getByLabelText(/Type “ENABLE PAYMENTS”/), PAYMENTS_ENABLE_PHRASE);
    await user.click(go);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(calls, "PUT", "/api/settings/payments/switch")[0]?.body).toEqual({
      enabled: true,
      confirm: PAYMENTS_ENABLE_PHRASE,
    });
    expect(await screen.findByRole("button", { name: "Switch payments off" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch payments on" })).toBeNull();
  });

  it("a refusal with blockers is worded, including pay_mode_not_verified", async () => {
    page({
      "GET /api/settings/payments": () => ({ body: ready() }),
      "PUT /api/settings/payments/switch": () => ({
        status: 409,
        body: { error: "blocked", blockers: ["pay_mode_not_verified", "no_approver"] },
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await user.click(await screen.findByRole("button", { name: "Switch payments on" }));
    const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByLabelText(/Type “ENABLE PAYMENTS”/), PAYMENTS_ENABLE_PHRASE);
    await user.click(within(dlg).getByRole("button", { name: "Switch payments on" }));
    const alert = await within(dlg).findByRole("alert");
    expect(alert.textContent).toContain(
      "One-click pay is chosen but its sandbox check is not done",
    );
    expect(alert.textContent).toContain("No active user has the approver role");
    expect(alert.textContent).not.toContain("pay_mode_not_verified");
  });

  it("an old sign-in shows the sign-in button and changes nothing", async () => {
    page({
      "GET /api/settings/payments": () => ({ body: ready() }),
      "PUT /api/settings/payments/switch": () => ({
        status: 401,
        body: { error: "step_up_required" },
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await user.click(await screen.findByRole("button", { name: "Switch payments on" }));
    const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByLabelText(/Type “ENABLE PAYMENTS”/), PAYMENTS_ENABLE_PHRASE);
    await user.click(within(dlg).getByRole("button", { name: "Switch payments on" }));
    expect(await within(dlg).findByRole("button", { name: "Sign in again" })).toBeTruthy();
  });
});

describe("recording the verification", () => {
  it("renders every check the API lists (a new one too), needs all, the note and the phrase, and stores nothing in the browser", async () => {
    const extra = "brand_new_check";
    const calls = page({
      "GET /api/settings/payments": () => ({
        body: paymentsSettings({
          verifyChecks: [...PAYMENTS_VERIFY_CHECKS, extra],
          verifyRunbook: PAYMENTS_VERIFY_RUNBOOK as never,
        }),
      }),
      "POST /api/settings/payments/verify": () => ({ body: ready() }),
    });
    const before = [localStorage.length, sessionStorage.length];
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await user.click(await screen.findByRole("button", { name: "Record the verification" }));
    const dlg = await screen.findByRole("dialog");
    const boxes = within(dlg).getAllByRole("checkbox");
    expect(boxes).toHaveLength(PAYMENTS_VERIFY_CHECKS.length + 1);
    expect(within(dlg).getByText("A check this screen does not know yet.")).toBeTruthy();
    // the runbook text from the answer
    expect(norm(dlg.textContent)).toContain(PAYMENTS_VERIFY_RUNBOOK.revolut_plan_known.title);
    expect(within(dlg).getAllByText("Steps for this check").length).toBeGreaterThan(5);
    const go = within(dlg).getByRole("button", {
      name: "Record the verification",
    }) as HTMLButtonElement;
    await user.type(within(dlg).getByLabelText(/What you tested/), "Sandbox run of 12 November");
    await user.type(
      within(dlg).getByLabelText(/Type “I VERIFIED THE PAYMENT PATH ON THE REVOLUT SANDBOX”/),
      PAYMENTS_VERIFY_PHRASE,
    );
    expect(go.disabled).toBe(true); // nothing ticked yet
    for (const b of boxes.slice(0, -1)) await user.click(b);
    expect(go.disabled).toBe(true); // one missing
    expect(within(dlg).getByTestId("verify-progress").textContent).toContain(
      `${PAYMENTS_VERIFY_CHECKS.length} of ${PAYMENTS_VERIFY_CHECKS.length + 1} ticked`,
    );
    await user.click(boxes[boxes.length - 1] as HTMLElement);
    expect(go.disabled).toBe(false);
    await user.click(go);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const body = posts(calls, "POST", "/api/settings/payments/verify")[0]?.body as {
      checks: string[];
      confirm: string;
      note: string;
    };
    expect(body.confirm).toBe(PAYMENTS_VERIFY_PHRASE);
    expect(body.checks).toEqual([...PAYMENTS_VERIFY_CHECKS, extra]);
    expect(body.note).toBe("Sandbox run of 12 November");
    expect([localStorage.length, sessionStorage.length]).toEqual(before);
  });

  it("a short note keeps the button off", async () => {
    page({ "GET /api/settings/payments": () => ({ body: paymentsSettings() }) });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await user.click(await screen.findByRole("button", { name: "Record the verification" }));
    const dlg = await screen.findByRole("dialog");
    for (const b of within(dlg).getAllByRole("checkbox")) await user.click(b);
    await user.type(
      within(dlg).getByLabelText(/Type “I VERIFIED THE PAYMENT PATH ON THE REVOLUT SANDBOX”/),
      PAYMENTS_VERIFY_PHRASE,
    );
    await user.type(within(dlg).getByLabelText(/What you tested/), "short");
    expect(
      (within(dlg).getByRole("button", { name: "Record the verification" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(within(dlg).getByText("Write at least 10 characters.")).toBeTruthy();
  });
});

describe("draft expiry", () => {
  it("saves whole days from 1 to 30 and refuses anything else before sending", async () => {
    let days = 5;
    const calls = page({
      "GET /api/settings/payments": () => ({ body: { ...ready(), draftExpiryDays: days } }),
      "PUT /api/settings/payments/draft-expiry": (c) => {
        days = (c.body as { days: number }).days;
        return { body: { ...ready(), draftExpiryDays: days } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    const input = await screen.findByLabelText(/Days until an unapproved draft expires/);
    const save = screen.getByRole("button", { name: "Save draft expiry" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // unchanged
    for (const bad of ["0", "31", "2.5", "abc", ""]) {
      await user.clear(input);
      if (bad !== "") await user.type(input, bad);
      expect(save.disabled, bad).toBe(true);
    }
    await user.clear(input);
    await user.type(input, "7");
    await user.click(save);
    await waitFor(() =>
      expect(posts(calls, "PUT", "/api/settings/payments/draft-expiry")).toHaveLength(1),
    );
    expect(posts(calls, "PUT", "/api/settings/payments/draft-expiry")[0]?.body).toEqual({
      days: 7,
    });
    await screen.findByText(/within 7 days/);
  });
});

describe("unknown outcomes", () => {
  const unknown = () =>
    payment({
      status: "outcome_unknown",
      updatedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    });

  it("lists them with their age and explains the fresh lookup", async () => {
    page({
      "GET /api/settings/payments": () => ({ body: ready() }),
      "GET /api/payments": () => ({ body: { items: [unknown()], nextCursor: null } }),
      "GET /api/payment-batches": () => ({
        body: { items: [batch({ status: "outcome_unknown" })], nextCursor: null },
      }),
    });
    renderApp("/settings/payments");
    const list = await screen.findByRole("list", { name: "Requests with an unknown outcome" });
    const text = norm(list.textContent);
    expect(text).toContain("Acme Supplies BV");
    expect(text).toContain("for 2 bills");
    expect(text).toMatch(/Became unknown 4\d min ago/);
    const card = list.closest("section, div") as HTMLElement;
    expect(norm(document.body.textContent)).toContain(
      "at least 15 minutes after it became unknown",
    );
    expect(norm(document.body.textContent)).toContain("in the last 30 minutes");
    expect(card).toBeTruthy();
  });

  it("marks one as not sent only with the typed phrase, then reloads the list", async () => {
    let items = [unknown()];
    const calls = page({
      "GET /api/settings/payments": () => ({ body: ready() }),
      "GET /api/payments": () => ({ body: { items, nextCursor: null } }),
      "POST /api/payments/11/resolve-not-sent": () => {
        items = [];
        return { body: { payment: payment({ status: "rejected" }) } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await user.click(
      await screen.findByRole("button", { name: /Mark as not sent, Acme Supplies BV/ }),
    );
    const dlg = await screen.findByRole("dialog");
    const go = within(dlg).getByRole("button", { name: "Mark as not sent" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.type(
      within(dlg).getByLabelText(/Type “MARK PAYMENT AS NOT SENT”/),
      PAYMENTS_RESOLVE_PHRASE,
    );
    await user.click(go);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(calls, "POST", "/api/payments/11/resolve-not-sent")[0]?.body).toEqual({
      confirm: PAYMENTS_RESOLVE_PHRASE,
    });
    await screen.findByText("0 requests are waiting on an unknown outcome.");
  });

  it("a lookup that is not fresh enough is explained, and the request stays in the list", async () => {
    page({
      "GET /api/settings/payments": () => ({ body: ready() }),
      "GET /api/payments": () => ({ body: { items: [unknown()], nextCursor: null } }),
      "POST /api/payments/11/resolve-not-sent": () => ({
        status: 409,
        body: { error: "lookup_not_fresh" },
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await user.click(await screen.findByRole("button", { name: /as not sent/ }));
    const dlg = await screen.findByRole("dialog");
    await user.type(
      within(dlg).getByLabelText(/Type “MARK PAYMENT AS NOT SENT”/),
      PAYMENTS_RESOLVE_PHRASE,
    );
    await user.click(within(dlg).getByRole("button", { name: "Mark as not sent" }));
    const alert = await within(dlg).findByRole("alert");
    expect(alert.textContent).toContain("Revolut was not asked recently enough");
    expect(alert.textContent).not.toContain("lookup_not_fresh");
  });
});

describe("Preview payment", () => {
  const result = {
    ok: true,
    mode: "drafts",
    requestId: "5d0f2c0a-0000-4000-8000-000000000011",
    calls: [
      {
        step: "counterparty",
        method: "POST",
        path: "/counterparty",
        // a bug on the server that leaks a full IBAN must still not reach the page
        body: `{"name":"Acme Supplies BV","iban":"${FULL_IBAN}"}`,
        sha256: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
        gateAccepts: true,
        usesPlaceholderPayee: false,
      },
      {
        step: "draft",
        method: "POST",
        path: "/payment-drafts",
        body: '{"title":"CF-5d0f2c0a-000","payments":[{"amount":1234.56}]}',
        sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
        gateAccepts: true,
        usesPlaceholderPayee: true,
      },
    ],
  };

  it("sends kind and id, shows steps and full hashes, and never a full IBAN", async () => {
    const calls = page({
      "GET /api/settings/payments": () => ({ body: ready() }),
      "POST /api/payments/preview": () => ({ body: result }),
    });
    const user = userEvent.setup();
    const { container } = renderApp("/settings/payments");
    const id = await screen.findByLabelText("Request number");
    const go = screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.type(id, "0");
    expect(go.disabled).toBe(true);
    await user.clear(id);
    await user.type(id, "11");
    await user.click(go);
    const out = await screen.findByTestId("preview-result");
    expect(posts(calls, "POST", "/api/payments/preview")[0]?.body).toEqual({
      kind: "payment",
      id: 11,
    });
    const text = norm(out.textContent);
    expect(text).toContain("Create the payee");
    expect(text).toContain("Create the draft");
    expect(text).toContain("ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12");
    expect(text).toContain("0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0");
    expect(text).toContain("Payee does not exist yet");
    expect(text).toContain("No call was made to the bank.");
    expect(document.body.textContent).not.toContain(FULL_IBAN);
    expect(container.innerHTML).not.toContain(FULL_IBAN);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("a batch is previewed by its own kind; a step without a hash says so", async () => {
    const calls = page({
      "GET /api/settings/payments": () => ({ body: ready() }),
      "POST /api/payments/preview": () => ({
        body: { ...result, calls: [{ ...result.calls[1], sha256: null }] },
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await user.click(await screen.findByLabelText("A batch"));
    await user.type(screen.getByLabelText("Request number"), "5");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText("No hash is shown for this step.");
    expect(posts(calls, "POST", "/api/payments/preview")[0]?.body).toEqual({
      kind: "batch",
      id: 5,
    });
  });

  it("refusals are worded; a stale sign-in shows the sign-in button", async () => {
    let n = 0;
    page({
      "GET /api/settings/payments": () => ({ body: ready() }),
      "POST /api/payments/preview": () => {
        n += 1;
        return n === 1
          ? { status: 409, body: { error: "iban_binding_broken" } }
          : { status: 401, body: { error: "step_up_required" } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings/payments");
    await user.type(await screen.findByLabelText("Request number"), "11");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "no longer matches the one an approver confirmed",
    );
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("button", { name: "Sign in again" })).toBeTruthy();
  });
});

describe("only an administrator gets the tools", () => {
  it("a finance user has no Payments tab in Settings, and so none of the tools", async () => {
    page({ "GET /api/settings/payments": () => ({ body: ready() }) }, FINANCE);
    renderApp("/settings/payments");
    await screen.findByRole("heading", { name: /Settings/i });
    expect(screen.queryByRole("button", { name: "Payments", pressed: false })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch payments on" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.queryByLabelText("Request number")).toBeNull();
  });
});
