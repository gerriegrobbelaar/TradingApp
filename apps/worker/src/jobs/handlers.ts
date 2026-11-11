/**
 * Handler registry: the code behind each job's `handler` key. Jobs of phases that are not built
 * yet are registered WITHOUT a `run`: the runner records them as `skipped` with code
 * `not_implemented` (never an error, never a silent success), and "Run now" is refused for them.
 */
import { ECB_MAX_ATTEMPTS, ECB_MAX_LATENESS_MS, runEcbImport } from "../fx/ecb-import";
import { loadRevolutConfig } from "../revolut/config";
import { runRevolutBackfill, runRevolutSync } from "../revolut/sync";
import { FULL_SYNC_MAX_ATTEMPTS, runExactSync } from "./exact-handlers";
import type { HandlerDef, JobContext, HandlerResult } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;

const later = (phase: string) => ({ phase, maxAttempts: 1 });

/**
 * Revolut is optional as a whole (review S5): a deployment without the Revolut settings skips the
 * Revolut jobs with `revolut_not_configured` (names of the missing settings only) instead of
 * touching the connection, the gate or the network.
 */
export function whenRevolutConfigured(
  run: (ctx: JobContext) => Promise<HandlerResult>,
): (ctx: JobContext) => Promise<HandlerResult> {
  return async (ctx) => {
    let origin = "";
    try {
      origin = new URL(ctx.env.OAUTH_REDIRECT_URI).origin;
    } catch {
      // The app origin is unknown: the Revolut settings cannot be valid either.
    }
    const cfg = loadRevolutConfig(ctx.env, origin);
    if (!cfg.ok) {
      return {
        status: "skipped",
        code: "revolut_not_configured",
        summary: { missing: cfg.missing },
      };
    }
    return run(ctx);
  };
}

/**
 * Schedule limits, lateness and who may run each job by hand. See the handler contract in
 * types.ts. Lateness is how long after its slot a scheduled run may still start.
 */

export const HANDLERS: Record<string, HandlerDef> = {
  "revolut.sync": {
    title: "Revolut balances and transactions",
    description:
      "Reads balances and polls new transactions from Revolut Business (the webhook is the fast path; this catches what it missed).",
    usesExact: false,
    phase: null,
    // The next slot is the retry: 10 minutes later.
    maxAttempts: 1,
    // CLAUDE.md 4.1: every 10 minutes, configurable 5 to 15.
    scheduleRules: { allowedIntervalMinutes: [5, 15] },
    maxLatenessMs: 30 * MIN,
    run: whenRevolutConfigured(runRevolutSync),
  },
  "revolut.backfill": {
    title: "Revolut backfill",
    description:
      "Walks the last 35 days of Revolut transactions, stores what is missing and counts it (a missed webhook). Also used once for the 90-day initial backfill after a connection is confirmed.",
    usesExact: false,
    phase: null,
    // A walk that stops partway continues after a pause; two minutes apart, at most 6 attempts.
    maxAttempts: 6,
    // A daily job: never more often than every 12 hours (a daily cron is 23 h on the spring day).
    scheduleRules: { minIntervalMinutes: 12 * 60 },
    maxLatenessMs: 6 * HOUR,
    run: whenRevolutConfigured(runRevolutBackfill),
  },
  "exact.bank_balances": {
    title: "Bank balances from Exact",
    description:
      "Reads the ING and Rabobank balances that Exact imported. Planned for the data-quality phase (Phase 8): the rule 'Exact balance differs from bank balance' needs it.",
    usesExact: true,
    ...later("Phase 8, Data quality"),
    // The Exact bank feed is daily; faster polling only wastes budget.
    scheduleRules: { minIntervalMinutes: 30 },
    maxLatenessMs: 2 * HOUR,
  },
  "ecb.fx_import": {
    title: "ECB exchange rates",
    description:
      "Imports the daily ECB reference rates (public, read-only, no credentials) on TARGET working days at 16:15; retries every 10 minutes until 17:30 if they are late. On by default on new installs. The rates are for information only.",
    usesExact: false,
    phase: null,
    // 16:15 plus seven retries ten minutes apart reaches 17:25.
    maxAttempts: ECB_MAX_ATTEMPTS,
    // Rates exist on TARGET working days only and are published once a day. Retries carry the
    // 16:15 slot, so 75 minutes of lateness ends them at 17:30 (16:15 + 75 min), whatever the
    // attempt number; the handler ends the last attempt that fits as rate_not_published.
    scheduleRules: { workingDaysOnly: true, minIntervalMinutes: 60 },
    maxLatenessMs: ECB_MAX_LATENESS_MS,
    run: runEcbImport,
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
      "Copies relations and bank accounts, open receivables and payables, purchase-entry approval status and the ledger (accounts, balances, budgets) from Exact, and closes items Exact no longer lists. Continues by itself if it stops partway.",
    usesExact: true,
    phase: null,
    maxAttempts: FULL_SYNC_MAX_ATTEMPTS,
    scheduleRules: { minIntervalMinutes: 60 },
    maxLatenessMs: 6 * HOUR,
    run: (ctx) => runExactSync("full", ctx),
  },
  "exact.incremental_sync": {
    title: "Incremental sync from Exact",
    description:
      "Refreshes administrations, relations and approval status of purchase entries. Open items and the ledger are left to the nightly full sync.",
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
