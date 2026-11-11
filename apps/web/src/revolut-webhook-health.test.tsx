import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type * as api from "./api";
import { formatAgo } from "./lib/format";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const ME_OK = (me: api.Me) => ({ "GET /api/auth/me": () => ({ body: me }) });

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const row = (webhook: api.RevolutWebhookHealth | null, extra: Partial<api.RevolutSettings> = {}) =>
  ({
    kind: "revolut",
    name: "revolut",
    status: "active",
    expiresAt: null,
    refreshExpiresAt: null,
    lastError: null,
    connectedBy: "gerrie@camelthorncapital.com",
    connectedAt: null,
    divisions: [],
    revolut: {
      environment: "production",
      createsBankEntries: false,
      paymentsMode: "drafts",
      webhookRegistered: webhook?.registered ?? false,
      webhook,
      ...extra,
    },
  }) satisfies api.ConnectionRow;

const list = (r: api.ConnectionRow) => ({
  "GET /api/connections": () => ({
    body: { exactConfigured: true, revolutConfigured: true, connections: [r] },
  }),
});
const card = () => {
  const c = screen.getByRole("heading", { name: "Revolut Business" }).parentElement?.parentElement;
  if (!c) throw new Error("no Revolut card");
  return within(c);
};
const open = async () => {
  renderApp("/settings/connections");
  await screen.findByRole("region", { name: "Webhook" });
};

describe("formatAgo", () => {
  const now = Date.parse("2026-11-11T10:00:00Z");
  it.each([
    ["2026-11-11T09:59:30Z", "just now"],
    ["2026-11-11T09:57:00Z", "3 min ago"],
    ["2026-11-11T07:00:00Z", "3 h ago"],
    ["2026-11-08T10:00:00Z", "3 days ago"],
    ["2026-11-11T10:05:00Z", "just now"],
    ["nonsense", "—"],
  ])("%s -> %s", (iso, text) => {
    expect(formatAgo(iso, now)).toBe(text);
  });
  it("is a dash without a value", () => {
    expect(formatAgo(null, now)).toBe("—");
  });
});

describe("Revolut card: webhook channel health", () => {
  it("shows when the last verified delivery arrived", async () => {
    const h = { registered: true, lastVerifiedAt: ago(3 * 60_000 + 5000), rejectedLast24h: 0 };
    mockFetch({ ...ME_OK(ADMIN), ...list(row(h, { webhookSecretReadable: true })) });
    await open();
    expect(card().getByText("Last delivery 3 min ago")).toBeTruthy();
    expect(card().queryByText(/rejected in the last 24 h/)).toBeNull();
    expect(card().queryByRole("button", { name: /Register webhook/ })).toBeNull();
  });

  it("says when no verified delivery has arrived yet", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(row({ registered: true, lastVerifiedAt: null, rejectedLast24h: 0 })),
    });
    await open();
    expect(card().getByText("No verified delivery yet")).toBeTruthy();
  });

  it("shows the number of rejected deliveries in the last 24 hours", async () => {
    mockFetch({
      ...ME_OK(VIEWER),
      ...list(row({ registered: true, lastVerifiedAt: ago(60_000), rejectedLast24h: 12 })),
    });
    await open();
    expect(card().getByText("12 rejected in the last 24 h")).toBeTruthy();
    // read-only roles see the health but no register action
    expect(card().queryByRole("button", { name: /Register webhook/ })).toBeNull();
  });

  it("tells an admin the secret cannot be read and offers to register again", async () => {
    const calls = mockFetch({
      ...ME_OK(ADMIN),
      ...list(
        row(
          { registered: true, lastVerifiedAt: null, rejectedLast24h: 4, secretReadable: false },
          { webhookSecretReadable: false },
        ),
      ),
      "POST /api/connections/revolut/webhook/register": () => ({
        body: { ok: true, status: "registered" },
      }),
    });
    const user = userEvent.setup();
    await open();
    expect(
      card().getByText("The webhook signing secret cannot be read. Register the webhook again."),
    ).toBeTruthy();
    await user.click(card().getByRole("button", { name: "Register webhook again" }));
    const post = calls.find((c) => c.method === "POST" && c.url.includes("webhook/register"));
    expect(post?.body).toEqual({ replace: true });
    expect(post?.headers["X-Requested-With"]).toBe("camelthorn");
    expect(await screen.findByText("Webhook registered.")).toBeTruthy();
  });

  it("does not show the unreadable message to a non-admin", async () => {
    mockFetch({
      ...ME_OK(VIEWER),
      ...list(row({ registered: true, lastVerifiedAt: null, rejectedLast24h: 0 })),
    });
    await open();
    expect(card().queryByText(/cannot be read/)).toBeNull();
  });

  it("offers to register a missing webhook (no replace)", async () => {
    const calls = mockFetch({
      ...ME_OK(ADMIN),
      ...list(row({ registered: false, lastVerifiedAt: null, rejectedLast24h: 0 })),
      "POST /api/connections/revolut/webhook/register": () => ({
        body: { ok: true, status: "registered" },
      }),
    });
    const user = userEvent.setup();
    await open();
    expect(card().getByText(/The webhook is not registered/)).toBeTruthy();
    await user.click(card().getByRole("button", { name: "Register webhook" }));
    expect(
      calls.find((c) => c.method === "POST" && c.url.includes("webhook/register"))?.body,
    ).toEqual({
      replace: false,
    });
  });

  it("a registration that needs a fresh sign-in opens the step-up sheet", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(row({ registered: false, lastVerifiedAt: null, rejectedLast24h: 0 })),
      "POST /api/connections/revolut/webhook/register": () => ({
        status: 401,
        body: { error: "step_up_required" },
      }),
    });
    const user = userEvent.setup();
    await open();
    await user.click(card().getByRole("button", { name: "Register webhook" }));
    expect(await screen.findByRole("dialog", { name: "Confirm it's you" })).toBeTruthy();
  });

  it("has no accessibility violations in the health states", async () => {
    const states: api.RevolutWebhookHealth[] = [
      { registered: true, lastVerifiedAt: ago(180_000), rejectedLast24h: 0 },
      { registered: true, lastVerifiedAt: null, rejectedLast24h: 7, secretReadable: false },
      { registered: false, lastVerifiedAt: null, rejectedLast24h: 0 },
    ];
    for (const h of states) {
      mockFetch({ ...ME_OK(ADMIN), ...list(row(h)) });
      const { unmount } = renderApp("/settings/connections");
      await screen.findByRole("region", { name: "Webhook" });
      expect(await axe(document.body)).toHaveNoViolations();
      unmount();
    }
  });
});
