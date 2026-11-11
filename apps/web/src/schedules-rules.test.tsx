import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JobView, JobsResponse, Me } from "./api";
import { rulesText } from "./components/ScheduleEditor";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";

const ME_OK = (me: Me) => ({ "GET /api/auth/me": () => ({ body: me }) });
const FINANCE: Me = { ...VIEWER, email: "f@camelthorncapital.com", roles: ["finance"] };

const job = (over: Partial<JobView> = {}): JobView => ({
  id: 1,
  name: "revolut.sync",
  title: "Revolut balances and transactions",
  description: "Reads balances.",
  implemented: true,
  phase: null,
  usesExact: false,
  schedule: { kind: "cron", expr: "*/10 * * * *" },
  scheduleText: "Every 10 minutes",
  enabled: true,
  exactBudget: 0,
  runRoles: ["admin", "finance"],
  stepUpToRun: false,
  maxLatenessMinutes: 30,
  scheduleRules: { minIntervalMinutes: 5, allowedIntervalMinutes: [5, 15], workingDaysOnly: false },
  defaultEnabled: false,
  rev: "rev-1",
  nextRunAt: new Date(Date.now() + 600_000).toISOString(),
  running: false,
  lastRun: null,
  ...over,
});

const resp = (jobs: JobView[]): JobsResponse => ({
  scheduler: {
    queueConfigured: true,
    lastTickAt: new Date().toISOString(),
    now: new Date().toISOString(),
  },
  maxExactBudget: 1000,
  maxProjectedExactCallsPerDay: 3000,
  jobs,
});
const list = (body: JobsResponse) => ({ "GET /api/jobs": () => ({ body }) });

describe("Schedules: handler rules in the editor", () => {
  it("rulesText says what the job allows", () => {
    expect(rulesText({ allowedIntervalMinutes: [5, 15] })).toBe(
      "It must run every 5 to 15 minutes, all day.",
    );
    expect(rulesText({ minIntervalMinutes: 60 })).toBe("It cannot run more often than every hour.");
    expect(rulesText(undefined)).toBe("It cannot run more often than every 5 minutes.");
    expect(rulesText({ workingDaysOnly: true })).toContain("working days only");
  });

  it("refuses an every-minute or out-of-range schedule live, and re-enables Save when it is fine", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(resp([job()])) });
    const user = userEvent.setup();
    renderApp("/settings/schedules");
    await user.click(
      await screen.findByRole("button", {
        name: "Edit schedule of Revolut balances and transactions",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("It must run every 5 to 15 minutes, all day.")).toBeTruthy();
    const save = within(dialog).getByRole("button", { name: "Save schedule" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await user.selectOptions(within(dialog).getByLabelText("When it runs"), "custom");
    const expr = within(dialog).getByLabelText("Cron expression");
    await user.clear(expr);
    await user.type(expr, "* * * * *");
    expect(
      await within(dialog).findByText(/cannot run more often than every 5 minutes/),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);

    await user.clear(expr);
    await user.type(expr, "*/20 * * * *");
    expect(
      await within(dialog).findByText(/must run every 5 to 15 minutes, all day\. This schedule/),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);

    await user.clear(expr);
    await user.type(expr, "*/15 * * * *");
    expect(save.disabled).toBe(false);
  });

  it("shows the server's sentence when it refuses a schedule", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(
        resp([
          job({
            scheduleRules: {
              minIntervalMinutes: 5,
              allowedIntervalMinutes: null,
              workingDaysOnly: false,
            },
          }),
        ]),
      ),
      "PATCH /api/jobs/1": () => ({
        status: 400,
        body: {
          error: "schedule_not_allowed",
          message: "This job cannot run more often than every 30 minutes.",
        },
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings/schedules");
    await user.click(
      await screen.findByRole("button", {
        name: "Edit schedule of Revolut balances and transactions",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save schedule" }));
    expect(
      await within(dialog).findByText("This job cannot run more often than every 30 minutes."),
    ).toBeTruthy();
  });
});

describe("Schedules: switched-off default jobs and run permissions", () => {
  const waiting = job({
    id: 7,
    name: "exact.full_sync",
    title: "Full sync from Exact",
    usesExact: true,
    exactBudget: 240,
    enabled: false,
    nextRunAt: null,
    disabledReason: "awaiting_live_verification",
    scheduleRules: { minIntervalMinutes: 60, allowedIntervalMinutes: null, workingDaysOnly: false },
  });

  it("tells an admin to switch it on after the first live connection checks", async () => {
    mockFetch({ ...ME_OK(ADMIN), ...list(resp([waiting])) });
    renderApp("/settings/schedules");
    expect(
      await screen.findByText("Switch on after the first live connection checks."),
    ).toBeTruthy();
  });

  it("does not show that hint to a non-admin", async () => {
    mockFetch({ ...ME_OK(FINANCE), ...list(resp([waiting])) });
    renderApp("/settings/schedules");
    await screen.findByText("Full sync from Exact");
    expect(screen.queryByText("Switch on after the first live connection checks.")).toBeNull();
  });

  it("hides Run now when the job's runRoles do not include the user", async () => {
    mockFetch({
      ...ME_OK(FINANCE),
      ...list(resp([job({ runRoles: ["admin"] }), job({ id: 2, name: "x", title: "Open job" })])),
    });
    renderApp("/settings/schedules");
    await screen.findByText("Open job");
    expect(
      screen.queryByRole("button", { name: "Run Revolut balances and transactions now" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Run Open job now" })).toBeTruthy();
  });
});

describe("Schedules: Run now that needs a fresh sign-in (reviewer addition)", () => {
  it("offers a sign-in instead of a dead-end toast", async () => {
    mockFetch({
      ...ME_OK(ADMIN),
      ...list(resp([job({ stepUpToRun: true })])),
      "POST /api/jobs/1/run": () => ({ status: 401, body: { error: "step_up_required" } }),
    });
    const user = userEvent.setup();
    renderApp("/settings/schedules");
    await user.click(
      await screen.findByRole("button", { name: "Run Revolut balances and transactions now" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Running Revolut balances and transactions by hand needs a/),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Sign in again" })).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the new run codes in words", async () => {
    const { codeText } = await import("./pages/Schedules");
    expect(codeText("too_late")).toBe("Started too long after its time, so it was skipped");
    expect(codeText("lock_lost")).toBe("Lost its lock while running");
    expect(codeText("administration_failed")).toBe("An administration did not sync today");
  });
});
