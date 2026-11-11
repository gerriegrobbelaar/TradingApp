import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";
import { ONE_DIVISION, approval, approvals } from "./test-fixtures";

const base = (me = VIEWER) => ({
  "GET /api/auth/me": () => ({ body: me }),
  "GET /api/divisions": () => ({ body: ONE_DIVISION }),
});
const LATE = approval({ id: 1, entryNumber: "2001", ageDays: 5 });
const NOTICE =
  "Approval status mapping is not verified against Exact yet. Do not rely on these statuses for payments.";
const CODES = {
  division: { id: 1, name: "Alpha BV" },
  table: [],
  mappingVerified: null,
  codes: [
    {
      statusCode: 5,
      storedStatus: "pending_approval",
      mappedStatus: "pending_approval",
      count: 3,
      lastSeenAt: "x",
    },
    {
      statusCode: 20,
      storedStatus: "unknown",
      mappedStatus: "unknown",
      count: 7,
      lastSeenAt: "x",
    },
  ],
};

async function loaded() {
  const t = await screen.findByRole("table", { name: "Approvals" });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
}

describe("mapping not verified (review S2)", () => {
  it("shows a notice to everyone while unverified, without a verify action for non-admins", async () => {
    mockFetch({
      ...base(),
      "GET /api/approvals": () => ({ body: approvals([LATE], { mappingVerified: false }) }),
    });
    renderApp("/purchases/approvals");
    await loaded();
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /verify/i })).toBeNull();
  });

  it("shows no notice once verified", async () => {
    mockFetch({ ...base(), "GET /api/approvals": () => ({ body: approvals([LATE]) }) });
    renderApp("/purchases/approvals");
    await loaded();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("lets an admin check the raw codes and confirm, then reloads", async () => {
    let verified = false;
    const calls = mockFetch({
      ...base(ADMIN),
      "GET /api/approvals": () => ({ body: approvals([LATE], { mappingVerified: verified }) }),
      "GET /api/approvals/status-codes": () => ({ body: CODES }),
      "PUT /api/approvals/mapping-verified": () => {
        verified = true;
        return { body: {} };
      },
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals");
    await loaded();
    await user.click(screen.getByRole("button", { name: /Check and verify the mapping/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("20")).toBeTruthy();
    expect(within(dialog).getByText("7")).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: /Confirm the mapping is verified/ }),
    );
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({
      confirmation: "I verified the approval status mapping against Exact",
      adrRef: "ADR 0025",
    });
  });

  it("offers a new sign-in when the server asks for one", async () => {
    mockFetch({
      ...base(ADMIN),
      "GET /api/approvals": () => ({ body: approvals([LATE], { mappingVerified: false }) }),
      "GET /api/approvals/status-codes": () => ({ body: CODES }),
      "PUT /api/approvals/mapping-verified": () => ({
        status: 401,
        body: { error: "step_up_required" },
      }),
    });
    const user = userEvent.setup();
    renderApp("/purchases/approvals");
    await loaded();
    await user.click(screen.getByRole("button", { name: /Check and verify the mapping/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: /Confirm the mapping/ }));
    expect(await within(dialog).findByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });
});
