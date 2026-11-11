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
    // Rates exist on TARGET working days only; retries stop with the 17:30 window.
    scheduleRules: { workingDaysOnly: true },
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
    // Creates a journal in Exact: only admins, with a fresh sign-in. A late run is still the same
    // month (the period comes from the slot), so the limit is generous.
    runRoles: ["admin"],
    stepUp: true,
    maxLatenessMs: 12 * HOUR,
  },
};

export const handlerFor = (key: string): HandlerDef | undefined =>
  Object.prototype.hasOwnProperty.call(HANDLERS, key) ? HANDLERS[key] : undefined;

/** True when "Run now" and scheduled runs would actually do something. */
export const isImplemented = (key: string): boolean => handlerFor(key)?.run !== undefined;
