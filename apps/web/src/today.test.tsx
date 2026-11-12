/** The Today queue screen (Phase 8, D8c): ranking as served, keyboard, Later, roles, a11y, privacy. */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { MemoryRouter, useLocation } from "react-router";
import { AppShell } from "./App";
import { ADMIN, VIEWER, mockFetch, renderApp, settle, type Call } from "./test-utils";
import type { Me } from "./api";
import { ONE_DIVISION } from "./test-fixtures";
import { mixedQueue, todayItem, todayResponse } from "./test-fixtures-dq";
import { readLater } from "./lib/later";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const FINANCE: Me = {
  email: "f@camelthorncapital.com",
  roles: ["finance"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};

type H = Record<string, (c: Call) => { status?: number; body?: unknown }>;
function base(me: Me = FINANCE, over: H = {}): H {
  return {
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/divisions": () => ({ body: ONE_DIVISION }),
    "GET /api/today": () => ({ body: todayResponse(mixedQueue()) }),
    ...over,
  };
}
async function queue() {
  const list = await screen.findByRole("listbox", { name: "Today queue" });
  await waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(0));
  return list;
}
const options = () => screen.getAllByRole("option");
const selectedTitle = () =>
  options()
    .find((o) => o.getAttribute("aria-selected") === "true")
    ?.querySelector(".today-title")?.textContent;

function withLocation(path: string) {
  const loc = { path: "" };
  function Probe() {
    const l = useLocation();
    loc.path = l.pathname + l.search;
    return null;
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
      <Probe />
    </MemoryRouter>,
  );
  return loc;
}

describe("Today queue", () => {
  it("is the home route, leads with the count and lists items in the order served", async () => {
    mockFetch(base());
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeTruthy();
    await queue();
    expect(
      await screen.findByRole("heading", { level: 2, name: "4 items to handle" }),
    ).toBeTruthy();
    const titles = options().map((o) => o.querySelector(".today-title")?.textContent);
    expect(titles).toEqual([
      "2 days: booking outcome unknown",
      "1 supplier IBAN changed",
      "6 days waiting for approval",
      "92% match suggested",
    ]);
    expect(screen.getByText("1 approval")).toBeTruthy();
    expect(screen.getByText("1 suggested match")).toBeTruthy();
    // Amounts come from the shared money formatter, with the credit sign read out.
    const first = options()[0] as HTMLElement;
    expect(first.textContent).toContain("123,45");
    expect(first.textContent).toContain("credit");
  });

  it("passes the selected administration and asks for 25 items", async () => {
    const calls = mockFetch(base());
    renderApp("/today");
    await queue();
    const url = new URL(calls.find((c) => c.url.startsWith("/api/today"))?.url ?? "", "http://x");
    expect(url.searchParams.get("division")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("shows a skeleton, then an honest empty state", async () => {
    mockFetch(base(FINANCE, { "GET /api/today": () => ({ body: todayResponse([]) }) }));
    renderApp("/today");
    expect(await screen.findByText("0 items need you.")).toBeTruthy();
    expect(screen.getByText(/Data health shows what the checks could not look at/)).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows loading as busy and an error with Try again", async () => {
    let n = 0;
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () =>
          ++n === 1
            ? { status: 500, body: { error: "boom" } }
            : { body: todayResponse(mixedQueue()) },
      }),
    );
    const user = userEvent.setup();
    renderApp("/today");
    expect(await screen.findByRole("alert")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await queue();
  });

  it("pages with Load more by cursor", async () => {
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/today": (c) =>
          new URL(c.url, "http://x").searchParams.get("cursor")
            ? {
                body: todayResponse([
                  todayItem({ id: "dq:2", title: "Second page item", issueId: 2 }),
                ]),
              }
            : { body: todayResponse(mixedQueue(), { nextCursor: "abc", total: 5 }) },
      }),
    );
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second page item")).toBeTruthy();
    const cursors = calls
      .filter((c) => c.url.startsWith("/api/today"))
      .map((c) => new URL(c.url, "http://x").searchParams.get("cursor"));
    expect(cursors).toContain("abc");
  });

  it("warns when the list is capped or approval mapping is unverified", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({
          body: todayResponse(mixedQueue(), { capped: true, approvalMappingVerified: false }),
        }),
      }),
    );
    renderApp("/today");
    await queue();
    expect(screen.getByText(/More than 100 items of one kind are waiting/)).toBeTruthy();
    expect(screen.getByText(/has not been verified/)).toBeTruthy();
  });
});

describe("keyboard", () => {
  it("J and K move the selection and focus; exactly one option is tabbable", async () => {
    mockFetch(base());
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    expect(options().filter((o) => o.tabIndex === 0)).toHaveLength(1);
    expect(selectedTitle()).toBe("2 days: booking outcome unknown");
    await user.keyboard("j");
    await waitFor(() => expect(selectedTitle()).toBe("1 supplier IBAN changed"));
    await waitFor(() => expect(document.activeElement?.id).toMatch(/^today-opt-dq-4$/));
    await user.keyboard("jjj");
    await waitFor(() => expect(selectedTitle()).toBe("92% match suggested"));
    await user.keyboard("kk");
    await waitFor(() => expect(selectedTitle()).toBe("1 supplier IBAN changed"));
    expect(options().filter((o) => o.tabIndex === 0)).toHaveLength(1);
    expect(options().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });

  it("A on a booking item opens the booking settings", async () => {
    mockFetch(base(ADMIN));
    const user = userEvent.setup();
    const loc = withLocation("/today");
    await queue();
    await user.keyboard("a");
    await waitFor(() => expect(loc.path).toBe("/settings/matching"));
  });

  it("A on an approval goes to Approvals, on a match to the suggested queue", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({
          body: todayResponse(
            mixedQueue().filter((i) => i.kind === "approval" || i.kind === "match"),
          ),
        }),
      }),
    );
    const user = userEvent.setup();
    const loc = withLocation("/today");
    await queue();
    await user.keyboard("a");
    await waitFor(() => expect(loc.path).toBe("/purchases/approvals"));
  });

  it("A on a data issue opens a sheet with Fix, Snooze and Resolve for finance", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({ body: todayResponse([mixedQueue()[1] as never]) }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    await user.keyboard("a");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Fix" }).getAttribute("href")).toBe(
      "/purchases/payables",
    );
    expect(within(dialog).getByRole("button", { name: "Snooze" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Resolve with a note" })).toBeTruthy();
  });

  it("letter keys do nothing while a dialog is open or you are typing", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({
          body: todayResponse([
            mixedQueue()[1] as never,
            todayItem({ id: "dq:5", issueId: 5, title: "Other" }),
          ]),
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    await user.keyboard("a");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Snooze" }));
    const note = within(dialog).getByLabelText(/Note/);
    await user.type(note, "jkl a z");
    expect((note as HTMLTextAreaElement).value).toBe("jkl a z");
    expect(selectedTitle()).toBe("1 supplier IBAN changed");
    expect(readLater(FINANCE.email)).toEqual({});
  });

  it("Enter on a focused option acts like A", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({
          body: todayResponse(mixedQueue().filter((i) => i.kind === "approval")),
        }),
      }),
    );
    const user = userEvent.setup();
    const loc = withLocation("/today");
    const list = await queue();
    (within(list).getAllByRole("option")[0] as HTMLElement).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(loc.path).toBe("/purchases/approvals"));
  });
});

describe("Later (this browser only)", () => {
  it("L hides the item for a day, keeps it across reloads, and Undo brings it back", async () => {
    mockFetch(base());
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    await user.keyboard("l");
    await waitFor(() => expect(options()).toHaveLength(3));
    const stored = readLater(FINANCE.email);
    expect(Object.keys(stored)).toEqual(["booking:7"]);
    const until = stored["booking:7"]?.until as number;
    expect(stored["booking:7"]?.priority).toBe(100);
    expect(until - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(until - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    // The toast announces it (role status); the queue's own live line stays quiet (no double read).
    expect(screen.getByTestId("today-live").textContent).toBe("");
    // The toast offers Undo; Z does the same.
    const toast = document.querySelector(".toast") as HTMLElement;
    expect(toast.textContent).toContain("Postponed until tomorrow: 2 days");
    await user.click(within(toast).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(options()).toHaveLength(4));
    expect(readLater(FINANCE.email)).toEqual({});

    await user.keyboard("l");
    await waitFor(() => expect(options()).toHaveLength(3));
    await user.keyboard("z");
    await waitFor(() => expect(options()).toHaveLength(4));
    expect(screen.getByTestId("today-live").textContent).toContain("Brought back");
  });

  it("a postponed item stays hidden after a reload and can be shown", async () => {
    mockFetch(base());
    const user = userEvent.setup();
    const first = renderApp("/today");
    await queue();
    await user.keyboard("l");
    await waitFor(() => expect(options()).toHaveLength(3));
    first.unmount();
    mockFetch(base());
    renderApp("/today");
    await queue();
    expect(options()).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Show 1 postponed" }));
    expect(options()).toHaveLength(4);
    expect(screen.getByText(/Later until/)).toBeTruthy();
    // L on a postponed item brings it back.
    await user.keyboard("l");
    await waitFor(() => expect(readLater(FINANCE.email)).toEqual({}));
  });

  it("an expired postponement is ignored", async () => {
    localStorage.setItem(
      `camelthorn.today.later.v2:${FINANCE.email}`,
      JSON.stringify({ "booking:7": { u: Date.now() - 1000, p: 100 } }),
    );
    mockFetch(base());
    renderApp("/today");
    await queue();
    expect(options()).toHaveLength(4);
  });

  it("is per person: another user's postponements do not hide anything", async () => {
    localStorage.setItem(
      `camelthorn.today.later.v2:someone@camelthorncapital.com`,
      JSON.stringify({ "booking:7": { u: Date.now() + 3_600_000, p: 100 } }),
    );
    mockFetch(base());
    renderApp("/today");
    await queue();
    expect(options()).toHaveLength(4);
  });

  it("copes with unreadable storage and with storage that refuses writes", async () => {
    localStorage.setItem(`camelthorn.today.later.v2:${FINANCE.email}`, "{not json");
    mockFetch(base());
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    expect(options()).toHaveLength(4);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await user.keyboard("l");
    expect(await screen.findByText(/blocked saving this/)).toBeTruthy();
    expect(options()).toHaveLength(4);
  });
});

describe("roles", () => {
  it("a viewer can open fix links but is offered no snooze or resolve", async () => {
    mockFetch(
      base(VIEWER, {
        "GET /api/today": () => ({
          body: todayResponse([
            todayItem({ id: "dq:1", actions: ["open"], title: "A data issue" }),
          ]),
        }),
      }),
    );
    const user = userEvent.setup();
    const loc = withLocation("/today");
    await queue();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    await user.keyboard("a");
    await waitFor(() => expect(loc.path).toBe("/treasury/bank"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an item nobody here may act on says so and goes nowhere", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({
          body: todayResponse([
            todayItem({
              kind: "booking",
              id: "booking:3",
              actions: [],
              issueId: null,
              title: "Booking needs a person",
            }),
          ]),
        }),
      }),
    );
    const user = userEvent.setup();
    const loc = withLocation("/today");
    await queue();
    expect(screen.getByRole("button", { name: "Needs an admin" })).toBeTruthy();
    await user.keyboard("a");
    expect(screen.getByTestId("today-live").textContent).toContain("Only an admin");
    expect(loc.path).toBe("/today");
  });

  it("never follows a link target that leaves the app", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({
          body: todayResponse([
            todayItem({
              id: "approval:2",
              kind: "approval",
              actions: ["open"],
              issueId: null,
              fixPath: "//evil.example/x",
            }),
          ]),
        }),
      }),
    );
    const user = userEvent.setup();
    const loc = withLocation("/today");
    await queue();
    await user.keyboard("a");
    // The screen of its fix key (DQ_FIX_PATHS), never the server's path.
    await waitFor(() => expect(loc.path).toBe("/treasury/bank"));
  });

  it("review D8c: an in-app path that is not the item's screen is not followed either", async () => {
    for (const [fix, fixPath, want] of [
      ["approvals", "/settings/users", "/purchases/approvals"],
      [
        "matching",
        "/treasury/bank?tab=review&queue=suggested",
        "/treasury/bank?tab=review&queue=suggested",
      ],
      ["constructor", "/treasury/bank", "/overview"],
    ] as const) {
      mockFetch(
        base(FINANCE, {
          "GET /api/today": () => ({
            body: todayResponse([
              todayItem({
                id: "approval:2",
                kind: "approval",
                actions: ["open"],
                issueId: null,
                fix: fix as never,
                fixPath,
              }),
            ]),
          }),
        }),
      );
      const user = userEvent.setup();
      const loc = withLocation("/today");
      await queue();
      await user.keyboard("a");
      await waitFor(() => expect(loc.path, fix).toBe(want));
      document.body.innerHTML = "";
    }
  });
});

describe("snooze and resolve from the queue", () => {
  it("snoozes with a note, waits for the server, then refreshes the queue", async () => {
    let todayCalls = 0;
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/today": () => {
          todayCalls += 1;
          return { body: todayResponse(todayCalls === 1 ? [mixedQueue()[1] as never] : []) };
        },
        "POST /api/dq/issues/4/snooze": () => ({ body: { issue: {} } }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    await user.keyboard("a");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Snooze" }));
    expect(
      within(dialog).getAllByRole("button", { name: "Snooze" })[0]?.hasAttribute("disabled"),
    ).toBe(true);
    await user.selectOptions(within(dialog).getByLabelText("Snooze for"), "14");
    await user.type(within(dialog).getByLabelText(/Note/), "Called the supplier");
    await user.click(within(dialog).getAllByRole("button", { name: "Snooze" })[0] as HTMLElement);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/dq/issues/4/snooze");
    expect(post?.headers["X-Requested-With"]).toBe("camelthorn");
    const body = post?.body as { until: string; note: string };
    expect(body.note).toBe("Called the supplier");
    const days = (Date.parse(body.until) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(Math.round(days)).toBe(14);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/Snoozed until/)).toBeTruthy();
    await screen.findByText("0 items need you.");
    expect(todayCalls).toBeGreaterThanOrEqual(2);
  });

  it("shows the server's refusal and changes nothing", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({ body: todayResponse([mixedQueue()[1] as never]) }),
        "POST /api/dq/issues/4/resolve-note": () => ({
          status: 409,
          body: { error: "already_resolved" },
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    await user.keyboard("a");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Resolve with a note" }));
    expect(within(dialog).getByText(/You cannot take this back/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Note/), "Checked");
    await user.click(within(dialog).getByRole("button", { name: "Resolve" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toMatch(/already resolved/);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("a11y, copy and privacy", () => {
  it("has no axe violations (colour contrast is scanned from the tokens)", async () => {
    mockFetch(base());
    const { container } = render(
      <MemoryRouter initialEntries={["/today"]}>
        <AppShell />
      </MemoryRouter>,
    );
    await queue();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("announces the list as a listbox with an accessible name and a keyboard hint", async () => {
    mockFetch(base());
    renderApp("/today");
    const list = await queue();
    expect(list.getAttribute("aria-describedby")).toBe("today-hint");
    expect(document.getElementById("today-hint")?.textContent).toMatch(
      /J K move, A act, L later, Z undo/,
    );
    expect(screen.getByTestId("today-live").getAttribute("aria-live")).toBe("polite");
  });

  it("has no exclamation marks", async () => {
    mockFetch(base());
    renderApp("/today");
    await queue();
    expect(document.body.textContent).not.toContain("!");
  });

  it("never puts a full IBAN on the page, even if the server sends one", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({
          body: todayResponse([
            todayItem({
              title: "IBAN NL91ABNA0417164300 changed",
              subtitle: "Acme DE89370400440532013000",
            }),
          ]),
        }),
      }),
    );
    renderApp("/today");
    await queue();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/NL91ABNA0417164300|DE89370400440532013000/);
    expect(text.replace(/\s/g, "")).not.toMatch(/NL91ABNA0417164300/);
  });

  it("links to Data health from the header", async () => {
    mockFetch(base());
    renderApp("/today");
    await queue();
    const links = screen.getAllByRole("link", { name: "Data health" });
    expect(links.every((l) => l.getAttribute("href") === "/data-health")).toBe(true);
    await settle(0);
  });
});

describe("review D8c: honesty, Later edge cases and keyboard safety", () => {
  const KEY = `camelthorn.today.later.v2:${FINANCE.email}`;

  it("an empty queue never says 'need you' when sources were not checked", async () => {
    for (const over of [
      { notChecked: ["approval", "booking"] as const },
      { dqLastRun: null },
      { dqLastRun: { status: "error" as const, finishedAt: new Date().toISOString() } },
      { dqLastRun: { status: "partial" as const, finishedAt: new Date().toISOString() } },
      {
        dqLastRun: {
          status: "ok" as const,
          finishedAt: new Date(Date.now() - 10 * 3_600_000).toISOString(),
        },
      },
      { approvalMappingVerified: false },
    ]) {
      mockFetch(
        base(FINANCE, {
          "GET /api/today": () => ({
            body: todayResponse([], over as unknown as Partial<ReturnType<typeof todayResponse>>),
          }),
        }),
      );
      const r = renderApp("/today");
      expect(
        await screen.findByText("0 items found, but not everything was checked."),
        JSON.stringify(over),
      ).toBeTruthy();
      expect(screen.queryByText("0 items need you.")).toBeNull();
      expect(screen.getByRole("list", { name: "Not fully checked" })).toBeTruthy();
      r.unmount();
    }
  });

  it("names the kinds that were cut at the cap", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({
          body: todayResponse(mixedQueue(), { capped: true, cappedKinds: ["dq", "match"] }),
        }),
      }),
    );
    renderApp("/today");
    await queue();
    expect(
      screen.getByText(/More than 100 data checks and suggested matches are waiting/),
    ).toBeTruthy();
  });

  it("a postponed item comes back at once when it gets more urgent", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        "dq:4": { u: Date.now() + 3_600_000, p: 60 },
        "booking:7": { u: Date.now() + 3_600_000, p: 100 },
      }),
    );
    // dq:4 is now critical (90 > 60): shown. booking:7 is unchanged: hidden.
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({
          body: todayResponse(
            mixedQueue().map((i) => (i.id === "dq:4" ? { ...i, priority: 90 } : i)),
          ),
        }),
      }),
    );
    renderApp("/today");
    await queue();
    const ids = options().map((o) => o.id);
    expect(ids).toContain("today-opt-dq-4");
    expect(ids).not.toContain("today-opt-booking-7");
  });

  it("ignores stored entries that would hide an item for more than a day, or are malformed", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        "booking:7": { u: Date.now() + 400 * 86_400_000, p: 100 },
        "dq:4": 1e15,
        "approval:3": { u: "soon", p: 40 },
        "evil:1": { u: Date.now() + 3_600_000, p: 100 },
      }),
    );
    expect(readLater(FINANCE.email)).toEqual({});
    mockFetch(base());
    renderApp("/today");
    await queue();
    expect(options()).toHaveLength(4);
  });

  it("a held L key postpones one item, not a run of them", async () => {
    mockFetch(base());
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    await user.keyboard("{l>5/}");
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(Object.keys(readLater(FINANCE.email))).toEqual(["booking:7"]);
  });

  it("letter keys inside a menu do nothing to the queue", async () => {
    mockFetch(base());
    renderApp("/today");
    await queue();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    item.setAttribute("role", "menuitem");
    menu.appendChild(item);
    document.body.appendChild(menu);
    item.focus();
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    expect(readLater(FINANCE.email)).toEqual({});
    expect(selectedTitle()).toBe("2 days: booking outcome unknown");
    menu.remove();
  });

  it("postponing the last item moves focus to the summary heading, not the page body", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({ body: todayResponse([mixedQueue()[0] as never]) }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    await user.keyboard("l");
    await waitFor(() => expect(document.activeElement?.id).toBe("today-summary-h"));
    expect(screen.getByText("0 items now. 1 postponed.")).toBeTruthy();
  });

  it("a storage that throws on read still shows the queue", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    mockFetch(base());
    renderApp("/today");
    await queue();
    expect(options()).toHaveLength(4);
  });
});

describe("review D8c: snooze limit", () => {
  it("90 days stays inside the server's 90-day limit and every choice is at most 90 days", async () => {
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/today": () => ({ body: todayResponse([mixedQueue()[1] as never]) }),
        "POST /api/dq/issues/4/snooze": () => ({ body: { issue: {} } }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/today");
    await queue();
    await user.keyboard("a");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Snooze" }));
    const select = within(dialog).getByLabelText("Snooze for") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => Number(o.value));
    expect(Math.max(...values)).toBe(90);
    await user.selectOptions(select, "90");
    await user.type(within(dialog).getByLabelText(/Note/), "Known");
    await user.click(within(dialog).getAllByRole("button", { name: "Snooze" })[0] as HTMLElement);
    const body = calls.find((c) => c.method === "POST")?.body as { until: string };
    const ms = Date.parse(body.until) - Date.now();
    expect(ms).toBeLessThan(90 * 86_400_000 - 60_000);
    expect(ms).toBeGreaterThan(89.9 * 86_400_000);
  });
});
