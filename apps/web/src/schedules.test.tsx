import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { JobRunView, JobView, JobsResponse, Me } from "./api";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const ME_OK = (me: Me) => ({ "GET /api/auth/me": () => ({ body: me }) });
const FINANCE: Me = { ...VIEWER, email: "f@camelthorncapital.com", roles: ["finance"] };

const run = (over: Partial<JobRunView> = {}): JobRunView => ({
  id: 1,
  status: "ok",
  trigger: "schedule",
  attempt: 1,
  requestedBy: "system",
  scheduledFor: new Date(Date.now() - 3_600_000).toISOString(),
  queuedAt: new Date(Date.now() - 3_600_000).toISOString(),
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  finishedAt: new Date(Date.now() - 3_000_000).toISOString(),
  errorCode: null,
  callsUsed: 0,
  summary: null,
  ...over,
});

const job = (over: Partial<JobView> = {}): JobView => ({
  id: 1,
  name: "exact.full_sync",
  title: "Full sync from Exact",
  description: "Copies relations and open items.",
  implemented: true,
  phase: null,
  usesExact: true,
  schedule: { kind: "cron", expr: "0 2 * * *" },
  scheduleText: "Every day at 02:00",
  enabled: true,
  exactBudget: 240,
  rev: "rev-1",
  nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  running: false,
  lastRun: run({ id: 10 }),
  ...over,
});

const later = (id: number, title: string): JobView =>
  job({
    id,
    name: `later.${id}`,
    title,
    implemented: false,
    phase: "Phase 5",
    usesExact: false,
    exactBudget: 0,
    enabled: false,
    nextRunAt: null,
    lastRun: null,
    scheduleText: "Every 10 minutes",
    schedule: { kind: "cron", expr: "*/10 * * * *" },
  });

const resp = (jobs: JobView[], over: Partial<JobsResponse["scheduler"]> = {}): JobsResponse => ({
  scheduler: {
    queueConfigured: true,
    lastTickAt: new Date().toISOString(),
    now: new Date().toISOString(),
    ...over,
  },
  maxExactBudget: 1000,
  jobs,
});

const JOBS = resp([
  job(),
  job({
    id: 2,
    name: "exact.incremental_sync",
    title: "Incremental sync from Exact",
    exactBudget: 40,
    scheduleText: "Every hour",
    schedule: { kind: "cron", expr: "30 * * * *" },
    lastRun: run({ id: 20, status: "partial", errorCode: "rate_limited" }),
  }),
  later(3, "Revolut balances and transactions"),
]);

const list = (body: JobsResponse) => ({ "GET /api/jobs": () => ({ body }) });

describe("Settings, Schedules", () => {
  it("shows a skeleton, then every job with its schedule, chip and next run", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(JOBS) });
    renderApp("/settings/schedules");
    expect(await screen.findByRole("status", { name: "Loading schedules" })).toBeTruthy();
    expect(await screen.findByText("Full sync from Exact")).toBeTruthy();
    expect(screen.getByText("Every day at 02:00")).toBeTruthy();
    expect(screen.getByText("240 Exact calls per run and administration")).toBeTruthy();
    expect(screen.getByText("OK")).toBeTruthy();
    expect(screen.getByText("Partly done")).toBeTruthy();
    expect(screen.getByText("Exact was busy")).toBeTruthy();
    // Phases that are not built say so, and their Run now is off.
    expect(screen.getByText("Not built yet")).toBeTruthy();
    const runLater = screen.getByRole("button", {
      name: "Run Revolut balances and transactions now",
    }) as HTMLButtonElement;
    expect(runLater.disabled).toBe(true);
    expect(screen.getByText("Not built yet (Phase 5)")).toBeTruthy();
    expect(screen.getAllByText(/^Ran /).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Updated /)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("maps failed and skipped runs to Failed and Skipped chips", async () => {
    const body = resp([
      job({ lastRun: run({ status: "error", errorCode: "needs_reauth" }) }),
      job({
        id: 2,
        name: "b",
        title: "B job",
        lastRun: run({ id: 2, status: "skipped", errorCode: "already_running" }),
      }),
      job({
        id: 3,
        name: "c",
        title: "C job",
        lastRun: run({ id: 3, status: "running" }),
        running: true,
      }),
    ]);
    mockFetch({ ...ME_OK(ADMIN), ...list(body) });
    renderApp("/settings/schedules");
    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(screen.getByText("Skipped")).toBeTruthy();
    expect(screen.getAllByText("Already running").length).toBeGreaterThan(0);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Exact needs to be re-authorised")).toBeTruthy();
  });

  it("warns when the queue is missing or the cron trigger has not ticked", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(resp([job()], { queueConfigured: false, lastTickAt: null })),
    });
    const first = renderApp("/settings/schedules");
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toContain("job queue is not set up");
    expect(alerts.map((a) => a.textContent).join(" ")).toContain("has not run yet");
    first.unmount();

    // The Worker stores the stamp at most every 4 minutes: 7 minutes is still fine.
    const recent = new Date(Date.now() - 7 * 60_000).toISOString();
    mockFetch({ ...ME_OK(ADMIN), ...list(resp([job()], { lastTickAt: recent })) });
    const second = renderApp("/settings/schedules");
    await screen.findByText("Full sync from Exact");
    expect(screen.queryByRole("alert")).toBeNull();
    second.unmount();

    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    mockFetch({ ...ME_OK(ADMIN), ...list(resp([job()], { lastTickAt: old })) });
    renderApp("/settings/schedules");
    expect((await screen.findByRole("alert")).textContent).toContain("last ran 20 min ago");
  });

  it("shows an error when the list cannot be loaded", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      "GET /api/jobs": () => ({ status: 500, body: { error: "internal_error" } }),
    });
    renderApp("/settings/schedules");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load the schedules",
    );
  });

  describe("roles", () => {
    it("viewers see everything read-only: no switch, no Run now, no Edit", async () => {
      mockFetch({ ...ME_OK(VIEWER), ...list(JOBS) });
      renderApp("/settings/schedules");
      await screen.findByText("Full sync from Exact");
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByRole("button", { name: /Run .* now/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Edit schedule/ })).toBeNull();
      expect(screen.getByRole("button", { name: "History of Full sync from Exact" })).toBeTruthy();
      expect(screen.getByText(/You can see them but not change them/)).toBeTruthy();
    });

    it("finance can Run now but not edit or switch", async () => {
      mockFetch({ ...ME_OK(FINANCE), ...list(JOBS) });
      renderApp("/settings/schedules");
      await screen.findByText("Full sync from Exact");
      expect(screen.getByRole("button", { name: "Run Full sync from Exact now" })).toBeTruthy();
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByRole("button", { name: /Edit schedule/ })).toBeNull();
    });

    it("admins get the switch, Run now and Edit", async () => {
      mockFetch({ ...ME_OK(ADMIN), ...list(JOBS) });
      renderApp("/settings/schedules");
      await screen.findByText("Full sync from Exact");
      expect(screen.getAllByRole("switch")).toHaveLength(3);
      expect(
        screen.getByRole("button", { name: "Edit schedule of Full sync from Exact" }),
      ).toBeTruthy();
    });
  });

  describe("switching and running", () => {
    it("the switch sends enabled and says what happened", async () => {
      const calls = mockFetch({
        ...ME_OK(ADMIN),
        ...list(JOBS),
        "PATCH /api/jobs/1": () => ({ body: { id: 1, changed: true } }),
      });
      const user = userEvent.setup();
      renderApp("/settings/schedules");
      await screen.findByText("Full sync from Exact");
      await user.click(screen.getByRole("switch", { name: "Full sync from Exact on" }));
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toEqual({ enabled: false, rev: "rev-1" });
      expect(patch?.headers["X-Requested-With"]).toBe("camelthorn");
      expect(await screen.findByText("Switched off Full sync from Exact.")).toBeTruthy();
    });

    it("a switch flipped on a stale page is refused (409) and says so, then reloads", async () => {
      const calls = mockFetch({
        ...ME_OK(ADMIN),
        ...list(JOBS),
        "PATCH /api/jobs/1": () => ({ status: 409, body: { error: "conflict" } }),
      });
      const user = userEvent.setup();
      renderApp("/settings/schedules");
      await screen.findByText("Full sync from Exact");
      const before = calls.filter((c) => c.method === "GET" && c.url === "/api/jobs").length;
      await user.click(screen.getByRole("switch", { name: "Full sync from Exact on" }));
      expect(
        await screen.findByText(
          "Someone else changed Full sync from Exact first. Check the current values and try again.",
        ),
      ).toBeTruthy();
      expect(calls.filter((c) => c.method === "GET" && c.url === "/api/jobs").length).toBe(
        before + 1,
      );
    });

    it("Run now starts a run, confirms, and holds the button for the cooldown", async () => {
      const calls = mockFetch({
        ...ME_OK(FINANCE),
        ...list(JOBS),
        "POST /api/jobs/1/run": () => ({ status: 202, body: { runId: 5, status: "queued" } }),
      });
      const user = userEvent.setup();
      renderApp("/settings/schedules");
      await screen.findByText("Full sync from Exact");
      const btn = screen.getByRole("button", { name: "Run Full sync from Exact now" });
      await user.click(btn);
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/jobs/1/run")).toBe(true);
      expect(await screen.findByText("Started Full sync from Exact.")).toBeTruthy();
      await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
      expect(screen.getByText(/s until it can run again/)).toBeTruthy();
    });

    it("explains a 409 and a 429 in words", async () => {
      let answer: { status: number; body: unknown } = {
        status: 409,
        body: { error: "already_running" },
      };
      mockFetch({
        ...ME_OK(ADMIN),
        ...list(JOBS),
        "POST /api/jobs/1/run": () => answer,
      });
      const user = userEvent.setup();
      renderApp("/settings/schedules");
      await screen.findByText("Full sync from Exact");
      await user.click(screen.getByRole("button", { name: "Run Full sync from Exact now" }));
      expect(await screen.findByText("Full sync from Exact is already running.")).toBeTruthy();
      answer = { status: 429, body: { error: "cooldown", retryAfterSeconds: 12 } };
      await user.click(screen.getByRole("button", { name: "Run Full sync from Exact now" }));
      expect(
        await screen.findByText("Wait 12 seconds before running Full sync from Exact again."),
      ).toBeTruthy();
    });
  });

  describe("history", () => {
    it("opens the last runs in a sheet with status, trigger and duration", async () => {
      const calls = mockFetch({
        ...ME_OK(VIEWER),
        ...list(JOBS),
        "GET /api/jobs/1/runs?limit=20": () => ({
          body: {
            jobId: 1,
            runs: [
              run({
                id: 3,
                status: "partial",
                errorCode: "budget_exhausted",
                attempt: 2,
                trigger: "retry",
                callsUsed: 240,
              }),
              run({ id: 2, trigger: "manual", requestedBy: "gerrie@camelthorncapital.com" }),
              run({ id: 1, status: "skipped", errorCode: "not_implemented" }),
            ],
          },
        }),
      });
      const user = userEvent.setup();
      renderApp("/settings/schedules");
      await screen.findByText("Full sync from Exact");
      await user.click(screen.getByRole("button", { name: "History of Full sync from Exact" }));
      const dialog = await screen.findByRole("dialog", { name: "History of Full sync from Exact" });
      expect(calls.some((c) => c.url === "/api/jobs/1/runs?limit=20")).toBe(true);
      expect(await within(dialog).findByText("Used its Exact call budget")).toBeTruthy();
      expect(within(dialog).getByText("Attempt 2")).toBeTruthy();
      expect(within(dialog).getByText("240 Exact calls")).toBeTruthy();
      expect(within(dialog).getByText("gerrie@camelthorncapital.com")).toBeTruthy();
      expect(within(dialog).getByText("Not built yet")).toBeTruthy();
      expect(await axe(dialog)).toHaveNoViolations();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("says so when there are no runs, and when loading fails", async () => {
      mockFetch({
        ...ME_OK(VIEWER),
        ...list(JOBS),
        "GET /api/jobs/1/runs?limit=20": () => ({ body: { jobId: 1, runs: [] } }),
        "GET /api/jobs/2/runs?limit=20": () => ({ status: 500, body: { error: "internal_error" } }),
      });
      const user = userEvent.setup();
      renderApp("/settings/schedules");
      await screen.findByText("Full sync from Exact");
      await user.click(screen.getByRole("button", { name: "History of Full sync from Exact" }));
      expect(await screen.findByText("This job has not run yet.")).toBeTruthy();
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
      await user.click(
        screen.getByRole("button", { name: "History of Incremental sync from Exact" }),
      );
      expect((await screen.findAllByRole("alert")).map((a) => a.textContent).join(" ")).toContain(
        "Could not load the history",
      );
    });
  });

  describe("schedule editor", () => {
    async function openEditor(
      extra: Record<string, () => { status?: number; body?: unknown }> = {},
    ) {
      const calls = mockFetch({ ...ME_OK(ADMIN), ...list(JOBS), ...extra });
      const user = userEvent.setup();
      renderApp("/settings/schedules");
      await screen.findByText("Full sync from Exact");
      await user.click(
        screen.getByRole("button", { name: "Edit schedule of Full sync from Exact" }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Schedule of Full sync from Exact",
      });
      return { calls, user, dialog };
    }

    it("starts from the current schedule and previews the next three runs in Amsterdam time", async () => {
      const { dialog } = await openEditor();
      const preset = within(dialog).getByLabelText("When it runs") as HTMLSelectElement;
      expect(preset.value).toBe("daily");
      expect((within(dialog).getByLabelText("Time (Amsterdam)") as HTMLInputElement).value).toBe(
        "02:00",
      );
      const times = dialog.querySelectorAll(".fires time");
      expect(times).toHaveLength(3);
      for (const t of Array.from(times)) expect(t.textContent).toMatch(/02:00$/);
      expect(
        (within(dialog).getByLabelText(/Exact calls per administration/) as HTMLInputElement).value,
      ).toBe("240");
      expect(await axe(dialog)).toHaveNoViolations();
    });

    it("validates a custom cron live and keeps Save off until it is valid", async () => {
      const { dialog, user } = await openEditor();
      await user.selectOptions(within(dialog).getByLabelText("When it runs"), "custom");
      const input = within(dialog).getByLabelText("Cron expression") as HTMLInputElement;
      await user.clear(input);
      await user.type(input, "61 * * * *");
      // The sentence comes from packages/core validateSchedule.
      expect(within(dialog).getByRole("alert").textContent).toBe(
        "This schedule is not valid. Invalid minute field: 61.",
      );
      expect(
        (within(dialog).getByRole("button", { name: "Save schedule" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(dialog.querySelectorAll(".fires time")).toHaveLength(0);
      await user.clear(input);
      await user.type(input, "15 16 * * *");
      expect(within(dialog).queryByRole("alert")).toBeNull();
      const times = Array.from(dialog.querySelectorAll(".fires time"));
      expect(times).toHaveLength(3);
      expect(times[0]?.textContent).toMatch(/16:15$/);
      expect(
        (within(dialog).getByRole("button", { name: "Save schedule" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    it("working days only skips weekends in the preview; last working day is an option", async () => {
      const { dialog, user } = await openEditor();
      await user.selectOptions(within(dialog).getByLabelText("When it runs"), "custom");
      const input = within(dialog).getByLabelText("Cron expression");
      await user.clear(input);
      await user.type(input, "0 9 * * *");
      await user.click(within(dialog).getByRole("checkbox", { name: /Working days only/ }));
      for (const t of Array.from(dialog.querySelectorAll(".fires time"))) {
        expect(t.textContent).not.toMatch(/^(Sat|Sun)/);
      }
      await user.selectOptions(within(dialog).getByLabelText("When it runs"), "lastWorking");
      expect(within(dialog).getByLabelText("Time (Amsterdam)")).toBeTruthy();
      expect(dialog.querySelectorAll(".fires time").length).toBeGreaterThan(0);
    });

    it("saves the new schedule and budget, then confirms and reloads", async () => {
      let reloads = 0;
      const { calls, user, dialog } = await openEditor({
        "PATCH /api/jobs/1": () => ({ body: { id: 1, changed: true } }),
      });
      void reloads;
      await user.selectOptions(within(dialog).getByLabelText("When it runs"), "working");
      fireEvent.change(within(dialog).getByLabelText("Time (Amsterdam)"), {
        target: { value: "03:30" },
      });
      const budget = within(dialog).getByLabelText(/Exact calls per administration/);
      await user.clear(budget);
      await user.type(budget, "300");
      await user.click(within(dialog).getByRole("button", { name: "Save schedule" }));
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toEqual({
        rev: "rev-1",
        schedule: { kind: "cron", expr: "30 3 * * *", workingDaysOnly: true },
        exactBudget: 300,
      });
      expect(await screen.findByText("Saved the schedule of Full sync from Exact.")).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      reloads = calls.filter((c) => c.url === "/api/jobs" && c.method === "GET").length;
      expect(reloads).toBeGreaterThanOrEqual(2);
    });

    it("rejects a budget above the cap before sending, and shows a server refusal", async () => {
      const { calls, user, dialog } = await openEditor({
        "PATCH /api/jobs/1": () => ({
          status: 400,
          body: { error: "schedule_invalid", message: "Schedule never fires within 5 years" },
        }),
      });
      const budget = within(dialog).getByLabelText(/Exact calls per administration/);
      await user.clear(budget);
      await user.type(budget, "1001");
      expect(within(dialog).getByText("Enter a whole number from 1 to 1,000.")).toBeTruthy();
      expect(
        (within(dialog).getByRole("button", { name: "Save schedule" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      await user.clear(budget);
      await user.type(budget, "1000");
      await user.click(within(dialog).getByRole("button", { name: "Save schedule" }));
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
      expect((await within(dialog).findByRole("alert")).textContent).toBe(
        "This schedule is not valid. Schedule never fires within 5 years.",
      );
    });

    it("has no budget field for a job that does not use Exact", async () => {
      const body = resp([later(3, "Revolut balances and transactions")]);
      mockFetch({ ...ME_OK(ADMIN), ...list(body) });
      const user = userEvent.setup();
      renderApp("/settings/schedules");
      await user.click(
        await screen.findByRole("button", {
          name: "Edit schedule of Revolut balances and transactions",
        }),
      );
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByLabelText(/Exact calls/)).toBeNull();
      expect((within(dialog).getByLabelText("When it runs") as HTMLSelectElement).value).toBe(
        "every10",
      );
    });
  });

  it("has no accessibility violations, with and without a warning", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list({ ...JOBS, scheduler: { ...JOBS.scheduler, queueConfigured: false } }),
    });
    const { container } = renderApp("/settings/schedules");
    await screen.findByText("Full sync from Exact");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is reachable from the Settings tabs by keyboard", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(JOBS) });
    renderApp("/settings/appearance");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Schedules" }));
    expect(await screen.findByText("Full sync from Exact")).toBeTruthy();
  });
});
