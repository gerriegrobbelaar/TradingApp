/** The Data health screen (Phase 8, D8c): honest rule states, filters, Fix links, actions, rule settings. */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { MemoryRouter, useLocation } from "react-router";
import { DQ_FIX_PATHS, DQ_LOOSEN_PHRASE } from "@camelthorn/core";
import { AppShell } from "./App";
import { ADMIN, VIEWER, mockFetch, renderApp, type Call } from "./test-utils";
import * as api from "./api";
import type { Me } from "./api";
import { ONE_DIVISION } from "./test-fixtures";
import { ISO, dqIssue, dqIssues, dqRules, dqSummary } from "./test-fixtures-dq";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const FINANCE: Me = {
  email: "f@camelthorncapital.com",
  roles: ["finance"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};
const params = (c: Call | undefined) => new URL(c?.url ?? "", "http://x").searchParams;
const of = (calls: Call[], path: string, method = "GET") =>
  calls.filter((c) => c.method === method && c.url.split("?")[0] === path);

type H = Record<string, (c: Call) => { status?: number; body?: unknown }>;
function base(me: Me = FINANCE, over: H = {}): H {
  return {
    "GET /api/auth/me": () => ({ body: me }),
    "GET /api/divisions": () => ({ body: ONE_DIVISION }),
    "GET /api/dq/summary": () => ({ body: dqSummary() }),
    "GET /api/dq/issues": () => ({
      body: dqIssues([
        dqIssue(),
        dqIssue({
          id: 2,
          severity: "critical",
          message: "1 supplier IBAN changed",
          subject: "Acme B.V.",
          area: "payables",
          ruleId: "payables.supplier_iban_changed",
          fix: "payables",
          fixPath: "/purchases/payables",
        }),
      ]),
    }),
    "GET /api/dq/rules": () => ({ body: dqRules() }),
    ...over,
  };
}
async function loaded(o: { emptyIssues?: boolean } = {}) {
  await screen.findByRole("heading", { level: 1, name: "Data health" });
  const issues = o.emptyIssues
    ? (screen.getByRole("heading", { name: "Issues" }) as HTMLElement)
    : await screen.findByRole("table", { name: "Issues" });
  if (!o.emptyIssues) await waitFor(() => expect(issues.querySelector(".sk-row")).toBeNull());
  const rules = await screen.findByRole("table", { name: "Checks" });
  await waitFor(() => expect(rules.querySelector(".sk-row")).toBeNull());
  return { issues, rules };
}
const ruleRow = (rules: HTMLElement, title: string) =>
  within(rules)
    .getAllByRole("row")
    .find((r) => r.textContent?.includes(title)) as HTMLElement;

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

describe("summary", () => {
  it("shows open counts by severity, snoozed, and checks that could not run", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/dq/summary": () => ({
          body: dqSummary(
            {},
            {
              "receivables.bounced_emails": {
                status: "not_available",
                reason: "email_log_empty_until_phase_10",
              },
              "ledger.suspense_not_zero": {
                status: "not_configured",
                reason: "no_suspense_accounts_configured",
              },
            },
          ),
        }),
      }),
    );
    renderApp("/data-health");
    await loaded();
    const tiles = screen.getByRole("list", { name: "Open issues by severity" });
    expect(within(tiles).getByText("Critical issue open")).toBeTruthy();
    expect(within(tiles).getByText("Warning issue open")).toBeTruthy();
    expect(within(tiles).getByText("Info issues open")).toBeTruthy();
    expect(within(tiles).getByText("Snoozed")).toBeTruthy();
    expect(within(tiles).getByText(/Checks that could not run/)).toBeTruthy();
    // 2 snoozed and 2 checks that could not run.
    expect(within(tiles).getAllByText("2", { selector: ".kpi" })).toHaveLength(2);
  });

  it("shows when the checks last ran and calls out an old run", async () => {
    const old = dqSummary();
    old.lastRun = {
      ...(old.lastRun as NonNullable<typeof old.lastRun>),
      finishedAt: ISO(5 * 3_600_000),
    };
    mockFetch(base(FINANCE, { "GET /api/dq/summary": () => ({ body: old }) }));
    renderApp("/data-health");
    await loaded();
    expect(screen.getByText(/Updated/)).toBeTruthy();
    expect(screen.getByText("Out of date")).toBeTruthy();
  });

  it("says plainly that no check has run yet and does not call that fine", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/dq/summary": () => ({
          body: dqSummary(
            { lastRun: null, open: { info: 0, warning: 0, critical: 0 }, snoozed: 0 },
            Object.fromEntries(
              dqSummary().rules.map((r) => [
                r.ruleId,
                { status: "never_run", evaluatedAt: null, checked: 0 },
              ]),
            ),
          ),
        }),
        "GET /api/dq/issues": () => ({ body: dqIssues([]) }),
      }),
    );
    renderApp("/data-health");
    const { rules } = await loaded({ emptyIssues: true });
    expect(screen.getByText("No check has run yet")).toBeTruthy();
    expect(await screen.findByText("No issues, but no check has run yet.")).toBeTruthy();
    expect(within(rules).queryByText("Checked, no issues")).toBeNull();
    expect(within(rules).getAllByText("Not run yet").length).toBeGreaterThan(5);
  });

  it("flags a partial last run", async () => {
    const s = dqSummary();
    s.lastRun = { ...(s.lastRun as NonNullable<typeof s.lastRun>), status: "partial" };
    mockFetch(base(FINANCE, { "GET /api/dq/summary": () => ({ body: s }) }));
    renderApp("/data-health");
    await loaded();
    expect(screen.getByText("Last run was partial")).toBeTruthy();
  });

  it("shows an error with Try again, and a skeleton while loading", async () => {
    let n = 0;
    mockFetch(
      base(FINANCE, {
        "GET /api/dq/summary": () =>
          ++n === 1 ? { status: 500, body: { error: "boom" } } : { body: dqSummary() },
      }),
    );
    const user = userEvent.setup();
    renderApp("/data-health");
    const alert = await screen.findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await loaded();
  });
});

describe("checks list tells the truth", () => {
  it("never shows a check that could not run as fine, and says why", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/dq/summary": () => ({
          body: dqSummary(
            {},
            {
              "receivables.bounced_emails": {
                status: "not_available",
                reason: "email_log_empty_until_phase_10",
              },
              "master.vat_code_country": { status: "not_available", reason: "vat_code_not_synced" },
              "ledger.suspense_not_zero": {
                status: "not_configured",
                reason: "no_suspense_accounts_configured",
              },
              "fx.rate_stale": { status: "error", reason: "evaluator_failed" },
              "bank.duplicate_lines": {
                status: "disabled",
                reason: "rule_disabled",
                enabled: false,
              },
              "bank.unmatched_old": { status: "issues", openIssues: 3 },
              "payables.missing_pdf": { status: "not_available", reason: "some_future_code" },
              "fx.rate_conflicts": { status: "not_available", reason: "fx_not_loaded" },
            },
          ),
        }),
      }),
    );
    renderApp("/data-health");
    const { rules } = await loaded();
    const row = (title: string) => ruleRow(rules, title);
    const bounced = dqSummary().rules.find((r) => r.ruleId === "receivables.bounced_emails")
      ?.title as string;
    expect(row(bounced).textContent).toContain("Not available");
    expect(row(bounced).textContent).toContain("Email delivery is not tracked yet");
    expect(row(bounced).textContent).not.toContain("Checked, no issues");
    expect(row(bounced).querySelector(".chip.ok")).toBeNull();

    const vat = dqSummary().rules.find((r) => r.ruleId === "master.vat_code_country")
      ?.title as string;
    expect(row(vat).textContent).toContain("VAT codes are not read from Exact yet");

    const susp = dqSummary().rules.find((r) => r.ruleId === "ledger.suspense_not_zero")
      ?.title as string;
    expect(row(susp).textContent).toContain("Not set up");
    expect(row(susp).textContent).toContain("No suspense account is chosen yet");

    const rate = dqSummary().rules.find((r) => r.ruleId === "fx.rate_stale")?.title as string;
    expect(row(rate).textContent).toContain("Check failed");
    const dup = dqSummary().rules.find((r) => r.ruleId === "bank.duplicate_lines")?.title as string;
    expect(row(dup).textContent).toContain("Switched off");
    expect(row(dup).textContent).toContain("An administrator switched this check off");
    const old = dqSummary().rules.find((r) => r.ruleId === "bank.unmatched_old")?.title as string;
    expect(row(old).textContent).toContain("3 issues open");

    // An unknown reason code is shown plainly, not hidden.
    const pdf = dqSummary().rules.find((r) => r.ruleId === "payables.missing_pdf")?.title as string;
    expect(row(pdf).textContent).toContain("Reason: some future code.");
    const conflicts = dqSummary().rules.find((r) => r.ruleId === "fx.rate_conflicts")
      ?.title as string;
    expect(row(conflicts).textContent).toContain("could not be read in the last run");

    // Only the genuinely checked rules are green.
    const greens = [...rules.querySelectorAll(".chip.ok")].map((c) => c.textContent);
    expect(greens.length).toBeGreaterThan(0);
    expect(new Set(greens)).toEqual(new Set(["Checked, no issues"]));
  });
});

describe("issues", () => {
  it("lists issues with Fix links taken from the fix-path table, without opening the sheet", async () => {
    mockFetch(base());
    const user = userEvent.setup();
    const loc = withLocation("/data-health");
    const { issues } = await loaded();
    expect(within(issues).getByText(/1 supplier IBAN changed/)).toBeTruthy();
    const links = within(issues).getAllByRole("link", { name: /^Fix/ });
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      DQ_FIX_PATHS.bank,
      DQ_FIX_PATHS.payables,
    ]);
    await user.click(links[1] as HTMLElement);
    await waitFor(() => expect(loc.path).toBe("/purchases/payables"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores a fix path the server sends and uses its own table", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/dq/issues": () => ({
          body: dqIssues([dqIssue({ fix: "ledger", fixPath: "https://evil.example/x" })]),
        }),
      }),
    );
    renderApp("/data-health");
    const { issues } = await loaded();
    expect(within(issues).getByRole("link", { name: /^Fix/ }).getAttribute("href")).toBe(
      DQ_FIX_PATHS.ledger,
    );
  });

  it("filters by severity tile, status, area and clears them; the address holds the filters", async () => {
    const calls = mockFetch(base());
    const user = userEvent.setup();
    renderApp("/data-health");
    await loaded();
    expect(params(of(calls, "/api/dq/issues")[0]).get("status")).toBe("open");
    await user.click(screen.getByRole("button", { name: /Critical issue open/ }));
    await waitFor(() =>
      expect(params(of(calls, "/api/dq/issues").at(-1)).get("severity")).toBe("critical"),
    );
    expect(
      screen.getByRole("button", { name: /Critical issue open/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.selectOptions(screen.getByLabelText("Area"), "bank");
    await waitFor(() =>
      expect(params(of(calls, "/api/dq/issues").at(-1)).get("area")).toBe("bank"),
    );
    await user.click(
      within(screen.getByRole("group", { name: "Issue status" })).getByRole("button", {
        name: "Snoozed",
      }),
    );
    await waitFor(() =>
      expect(params(of(calls, "/api/dq/issues").at(-1)).get("status")).toBe("snoozed"),
    );
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      const p = params(of(calls, "/api/dq/issues").at(-1));
      expect([p.get("status"), p.get("severity"), p.get("area")]).toEqual(["open", null, null]);
    });
    // Every issues request was for the chosen administration.
    expect(of(calls, "/api/dq/issues").every((c) => params(c).get("division") === "1")).toBe(true);
  });

  it("drops an invalid filter from the address instead of sending it", async () => {
    const calls = mockFetch(base());
    renderApp("/data-health?status=bogus&severity=nope&area=zzz");
    await loaded();
    for (const c of of(calls, "/api/dq/issues")) {
      expect([params(c).get("status"), params(c).get("severity"), params(c).get("area")]).toEqual([
        "open",
        null,
        null,
      ]);
    }
  });

  it("pages with Load more", async () => {
    const calls = mockFetch(
      base(FINANCE, {
        "GET /api/dq/issues": (c) =>
          params(c).get("cursor")
            ? { body: dqIssues([dqIssue({ id: 9, message: "Second page issue" })]) }
            : { body: dqIssues([dqIssue()], "1:1") },
      }),
    );
    const user = userEvent.setup();
    renderApp("/data-health");
    await loaded();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText(/Second page issue/)).toBeTruthy();
    expect(of(calls, "/api/dq/issues").some((c) => params(c).get("cursor") === "1:1")).toBe(true);
  });

  it("explains an empty filtered list", async () => {
    mockFetch(base(FINANCE, { "GET /api/dq/issues": () => ({ body: dqIssues([]) }) }));
    renderApp("/data-health");
    await loaded({ emptyIssues: true });
    expect(await screen.findByText("0 open issues.")).toBeTruthy();
    expect(screen.getByText(/a check that could not run is not a pass/)).toBeTruthy();
  });
});

describe("acting on an issue", () => {
  it("finance snoozes with a note; the list and summary are re-read and a toast says what happens", async () => {
    const calls = mockFetch(
      base(FINANCE, {
        "POST /api/dq/issues/1/snooze": () => ({ body: { issue: dqIssue({ status: "snoozed" }) } }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/data-health");
    const { issues } = await loaded();
    await user.click(within(issues).getByRole("button", { name: /1 bank line is older/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Snooze" }));
    expect(within(dialog).getByText(/You cannot take a snooze back/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Note/), "Waiting for the bank");
    await user.selectOptions(within(dialog).getByLabelText("Snooze for"), "30");
    const before = of(calls, "/api/dq/summary").length;
    await user.click(within(dialog).getAllByRole("button", { name: "Snooze" })[0] as HTMLElement);
    const post = of(calls, "/api/dq/issues/1/snooze", "POST")[0];
    expect(post?.headers["X-Requested-With"]).toBe("camelthorn");
    const body = post?.body as { until: string; note: string };
    expect(body.note).toBe("Waiting for the bank");
    const days = (Date.parse(body.until) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(Math.round(days)).toBe(30);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/Snoozed until .* It comes back then/)).toBeTruthy();
    await waitFor(() => expect(of(calls, "/api/dq/summary").length).toBeGreaterThan(before));
  });

  it("resolve needs a note, warns it can be reopened and cannot be undone", async () => {
    const calls = mockFetch(
      base(FINANCE, {
        "POST /api/dq/issues/1/resolve-note": () => ({
          body: { issue: dqIssue({ status: "resolved" }) },
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/data-health");
    const { issues } = await loaded();
    await user.click(within(issues).getByRole("button", { name: /1 bank line is older/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Resolve with a note" }));
    const go = within(dialog).getByRole("button", { name: "Resolve" });
    expect(go.hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByText(/next check, the issue is reopened/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Note/), "Matched by hand");
    await user.click(go);
    await waitFor(() => expect(of(calls, "/api/dq/issues/1/resolve-note", "POST")).toHaveLength(1));
    expect(of(calls, "/api/dq/issues/1/resolve-note", "POST")[0]?.body).toEqual({
      note: "Matched by hand",
    });
    expect(await screen.findByText(/the next check reopens it/)).toBeTruthy();
  });

  it("a viewer sees the issue and the Fix link but no actions", async () => {
    mockFetch(base(VIEWER));
    const user = userEvent.setup();
    renderApp("/data-health");
    const { issues } = await loaded();
    await user.click(within(issues).getByRole("button", { name: /1 bank line is older/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Fix" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Snooze" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Resolve/ })).toBeNull();
  });

  it("a snoozed issue shows its end and no actions", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/dq/issues": () => ({
          body: dqIssues([
            dqIssue({ status: "snoozed", snoozedUntil: ISO(-3 * 86_400_000), snoozeNote: "Known" }),
          ]),
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/data-health?status=snoozed");
    const { issues } = await loaded();
    expect(within(issues).getByText(/Snoozed until/)).toBeTruthy();
    await user.click(within(issues).getByRole("button", { name: /1 bank line is older/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Snooze" })).toBeNull();
    expect(within(dialog).getByText("Known")).toBeTruthy();
  });

  it("shows the server's refusal in the sheet", async () => {
    mockFetch(
      base(FINANCE, {
        "POST /api/dq/issues/1/snooze": () => ({ status: 409, body: { error: "not_open" } }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/data-health");
    const { issues } = await loaded();
    await user.click(within(issues).getByRole("button", { name: /1 bank line is older/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Snooze" }));
    await user.type(within(dialog).getByLabelText(/Note/), "x");
    await user.click(within(dialog).getAllByRole("button", { name: "Snooze" })[0] as HTMLElement);
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/no longer open/);
  });
});

describe("rule settings (admin)", () => {
  const crit = "payables.supplier_iban_changed";
  const warnRule = "bank.unmatched_old";
  const title = (id: string) => dqSummary().rules.find((r) => r.ruleId === id)?.title as string;

  it("only admins get Settings buttons, and only admins load the rule list", async () => {
    const calls = mockFetch(base(FINANCE));
    renderApp("/data-health");
    const { rules } = await loaded();
    expect(within(rules).queryByRole("button", { name: /^Settings for/ })).toBeNull();
    expect(of(calls, "/api/dq/rules")).toHaveLength(0);
  });

  it("opens a rule, changes the threshold within its range and sends the revision", async () => {
    const calls = mockFetch(
      base(ADMIN, {
        "GET /api/dq/rules": () => ({ body: dqRules({ [warnRule]: { rev: "r1" } }) }),
        "PATCH /api/dq/rules/bank.unmatched_old": () => ({ body: { rule: dqRules().rules[0] } }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/data-health");
    const { rules } = await loaded();
    await waitFor(() =>
      expect(
        within(rules)
          .getByRole("button", { name: `Settings for ${title(warnRule)}` })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    await user.click(
      within(rules).getByRole("button", { name: `Settings for ${title(warnRule)}` }),
    );
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);
    const thr = within(dialog).getByLabelText(/Threshold/);
    await user.clear(thr);
    await user.type(thr, "99999999");
    expect(save.hasAttribute("disabled")).toBe(true);
    await user.clear(thr);
    await user.type(thr, "7");
    expect(save.hasAttribute("disabled")).toBe(false);
    await user.click(save);
    const patch = of(calls, "/api/dq/rules/bank.unmatched_old", "PATCH")[0];
    expect(patch?.body).toEqual({ rev: "r1", threshold: 7 });
    expect(patch?.headers["X-Requested-With"]).toBe("camelthorn");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/Rule settings saved/)).toBeTruthy();
  });

  it("switching off a warning rule needs no phrase", async () => {
    const calls = mockFetch(
      base(ADMIN, {
        "PATCH /api/dq/rules/bank.unmatched_old": () => ({ body: { rule: dqRules().rules[0] } }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/data-health");
    const { rules } = await loaded();
    await waitFor(() =>
      expect(
        within(rules)
          .getByRole("button", { name: `Settings for ${title(warnRule)}` })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    await user.click(
      within(rules).getByRole("button", { name: `Settings for ${title(warnRule)}` }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("switch"));
    expect(within(dialog).queryByText(/Type “/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(of(calls, "/api/dq/rules/bank.unmatched_old", "PATCH")).toHaveLength(1),
    );
    expect(of(calls, "/api/dq/rules/bank.unmatched_old", "PATCH")[0]?.body).toEqual({
      rev: null,
      enabled: false,
    });
  });

  it("loosening a critical rule needs the phrase typed exactly", async () => {
    const calls = mockFetch(
      base(ADMIN, {
        "PATCH /api/dq/rules/payables.supplier_iban_changed": () => ({
          body: { rule: dqRules().rules[0] },
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/data-health");
    const { rules } = await loaded();
    await waitFor(() =>
      expect(
        within(rules)
          .getByRole("button", { name: `Settings for ${title(crit)}` })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    await user.click(within(rules).getByRole("button", { name: `Settings for ${title(crit)}` }));
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save" });
    // A tighter change (longer look-back) needs no phrase.
    const thr = within(dialog).getByLabelText(/Threshold/);
    await user.clear(thr);
    await user.type(thr, "60");
    expect(within(dialog).queryByText(/Type “/)).toBeNull();
    expect(save.hasAttribute("disabled")).toBe(false);
    // Looser (shorter look-back for this rule) and switching off need the phrase.
    await user.clear(thr);
    await user.type(thr, "10");
    const phrase = within(dialog).getByLabelText(`Type “${DQ_LOOSEN_PHRASE}” to confirm`);
    expect(save.hasAttribute("disabled")).toBe(true);
    await user.type(phrase, DQ_LOOSEN_PHRASE.toLowerCase());
    expect(save.hasAttribute("disabled")).toBe(true);
    await user.clear(phrase);
    await user.type(phrase, DQ_LOOSEN_PHRASE);
    expect(save.hasAttribute("disabled")).toBe(false);
    await user.click(save);
    await waitFor(() => expect(of(calls, `/api/dq/rules/${crit}`, "PATCH")).toHaveLength(1));
    expect(of(calls, `/api/dq/rules/${crit}`, "PATCH")[0]?.body).toEqual({
      rev: null,
      threshold: 10,
      confirm: DQ_LOOSEN_PHRASE,
    });
  });

  it("lowering a critical rule's severity or switching it off asks for the phrase", async () => {
    mockFetch(base(ADMIN));
    const user = userEvent.setup();
    renderApp("/data-health");
    const { rules } = await loaded();
    await waitFor(() =>
      expect(
        within(rules)
          .getByRole("button", { name: `Settings for ${title(crit)}` })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    await user.click(within(rules).getByRole("button", { name: `Settings for ${title(crit)}` }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("switch"));
    expect(within(dialog).getByLabelText(/Type “/)).toBeTruthy();
    await user.click(within(dialog).getByRole("switch"));
    expect(within(dialog).queryByLabelText(/Type “/)).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText("Severity"), "warning");
    expect(within(dialog).getByLabelText(/Type “/)).toBeTruthy();
  });

  it("shows the phrase field when the server asks for it, and the sign-in prompt for step-up", async () => {
    let n = 0;
    mockFetch(
      base(ADMIN, {
        "PATCH /api/dq/rules/bank.unmatched_old": () => {
          n += 1;
          return n === 1
            ? { status: 422, body: { error: "confirmation_required" } }
            : { status: 401, body: { error: "step_up_required" } };
        },
      }),
    );
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderApp("/data-health");
    const { rules } = await loaded();
    await waitFor(() =>
      expect(
        within(rules)
          .getByRole("button", { name: `Settings for ${title(warnRule)}` })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    await user.click(
      within(rules).getByRole("button", { name: `Settings for ${title(warnRule)}` }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("switch"));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const phrase = await within(dialog).findByLabelText(/Type “/);
    await user.type(phrase, DQ_LOOSEN_PHRASE);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await user.click(await within(dialog).findByRole("button", { name: "Sign in again" }));
    expect(assign).toHaveBeenCalled();
  });
});

describe("a11y, copy, privacy and reachability", () => {
  it("has no axe violations", async () => {
    mockFetch(base(ADMIN));
    const { container } = render(
      <MemoryRouter initialEntries={["/data-health"]}>
        <AppShell />
      </MemoryRouter>,
    );
    await loaded();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no exclamation marks and no full IBAN even if the server sends one", async () => {
    mockFetch(
      base(FINANCE, {
        "GET /api/dq/issues": () => ({
          body: dqIssues([
            dqIssue({
              message: "IBAN NL91ABNA0417164300 changed",
              subject: "DE89 3704 0044 0532 0130 00",
            }),
          ]),
        }),
      }),
    );
    renderApp("/data-health");
    await loaded();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("!");
    expect(text.replace(/\s/g, "")).not.toMatch(/0417164300|0532013000/);
  });

  it("is linked from the footer and not a menu entry", async () => {
    mockFetch(base());
    renderApp("/data-health");
    await loaded();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: "Data health" })).toBeNull();
    expect(
      within(screen.getByRole("contentinfo"))
        .getByRole("link", { name: "Data health" })
        .getAttribute("href"),
    ).toBe("/data-health");
  });

  it("keyboard: J and K move through the issues and Enter opens the sheet", async () => {
    mockFetch(base());
    const user = userEvent.setup();
    renderApp("/data-health");
    await loaded();
    await user.keyboard("j");
    await waitFor(() => expect(document.activeElement?.textContent).toContain("1 bank line"));
    await user.keyboard("j");
    await waitFor(() => expect(document.activeElement?.textContent).toContain("supplier IBAN"));
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
