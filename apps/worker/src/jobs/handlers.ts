/**
 * Handler registry: the code behind each job's `handler` key. Jobs of phases that are not built
 * yet are registered WITHOUT a `run`: the runner records them as `skipped` with code
 * `not_implemented` (never an error, never a silent success), and "Run now" is refused for them.
 */
import { FULL_SYNC_MAX_ATTEMPTS, runExactSync } from "./exact-handlers";
import type { HandlerDef } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;

const later = (phase: string) => ({ phase, maxAttempts: 1 });

/**
 * Schedule limits, lateness and who may run each job by hand. See the handler contract in
 * types.ts. Lateness is how long after its slot a scheduled run may still start.
 */

export const HANDLERS: Record<string, HandlerDef> = {
  "revolut.sync": {
    title: "Revolut balances and transactions",
    description: "Reads balances and transactions from Revolut Business.",
    usesExact: false,
    ...later("Phase 5, Revolut connection"),
    // CLAUDE.md 4.1: every 10 minutes, configurable 5 to 15.
    scheduleRules: { allowedIntervalMinutes: [5, 15] },
    maxLatenessMs: 30 * MIN,
  },
  "exact.bank_balances": {
    title: "Bank balances from Exact",
    description: "Reads the ING and Rabobank balances that Exact imported.",
    usesExact: true,
    ...later("Phase 5, Revolut connection"),
    // The Exact bank feed is daily; faster polling only wastes budget.
    scheduleRules: { minIntervalMinutes: 30 },
    maxLatenessMs: 2 * HOUR,
  },
  "ecb.fx_import": {
    title: "ECB exchange rates",
    description: "Imports the daily ECB reference rates; retries until 17:30 if they are late.",
    usesExact: false,
    phase: "Phase 6, ECB FX",
    // 16:15 plus seven retries ten minutes apart reaches 17:25.
    maxAttempts: 8,
    // Rates exist on TARGET working days only and are published once a day. Retries carry the
    // 16:15 slot, so 75 minutes of lateness ends them at 17:30 (16:15 + 75 min), whatever the
    // attempt number; an attempt that would start after 17:30 is recorded too_late.
    scheduleRules: { workingDaysOnly: true, minIntervalMinutes: 60 },
    maxLatenessMs: 75 * MIN,
  },
  "dq.checks": {
    title: "Data quality checks",
    description: "Runs the data quality rules and raises alerts.",
    usesExact: false,
    ...later("Phase 8, Data quality"),
    scheduleRules: { minIntervalMinutes: 15 },
    maxLatenessMs: 2 * HOUR,
  },
  "reminders.send": {
    title: "Payment reminders",
    description: "Sends the invoice copies and reminders that are due.",
    usesExact: false,
    ...later("Phase 10, Reminders"),
    // Sends e-mail to customers: a fresh sign-in is needed to start it by hand.
    stepUp: true,
    scheduleRules: { minIntervalMinutes: 60 },
    maxLatenessMs: 6 * HOUR,
  },
  "exact.full_sync": {
    title: "Full sync from Exact",
    description:
      "Copies relations, open receivables and open payables from Exact, and closes items Exact no longer lists. Continues by itself if it stops partway.",
    usesExact: true,
    phase: null,
    maxAttempts: FULL_SYNC_MAX_ATTEMPTS,
    scheduleRules: { minIntervalMinutes: 60 },
    maxLatenessMs: 6 * HOUR,
    run: (ctx) => runExactSync("full", ctx),
  },
  "exact.incremental_sync": {
    title: "Incremental sync from Exact",
    description: "Refreshes administrations and relations. Open items are left to the full sync.",
    usesExact: true,
    phase: null,
    maxAttempts: 1,
    scheduleRules: { minIntervalMinutes: 15 },
    maxLatenessMs: 45 * MIN,
    run: (ctx) => runExactSync("incremental", ctx),
  },
  "fx.revaluation": {
    title: "FX revaluation (draft journal)",
    description: "Revalues open foreign-currency items at the month-end ECB rate as a draft.",
    usesExact: true,
    ...later("Phase 12, Monthly FX revaluation"),
    // Creates a journal in Exact: only admins, with a fresh sign-in. No lateness limit: the month
    // to revalue comes from the slot (period.ts scheduledMonth), and a catch-up run claims the
    // LATEST missed month-end (core dueSlot), so a run that starts days late (an outage over the
    // month-end) still books the month that just ended, as a draft, once (idempotency key per
    // month). A limit would silently skip that month until the next month-end.
    runRoles: ["admin"],
    stepUp: true,
    // A monthly job: never more often than every 12 hours (a whole day cannot be the minimum: the
    // spring daylight saving day is 23 hours, so a daily cron would be refused).
    scheduleRules: { minIntervalMinutes: 12 * 60 },
  },
};

export const handlerFor = (key: string): HandlerDef | undefined =>
  Object.prototype.hasOwnProperty.call(HANDLERS, key) ? HANDLERS[key] : undefined;

/** True when "Run now" and scheduled runs would actually do something. */
export const isImplemented = (key: string): boolean => handlerFor(key)?.run !== undefined;
