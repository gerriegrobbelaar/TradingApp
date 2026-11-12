/**
 * Handler registry: the code behind each job's `handler` key. Jobs of phases that are not built
 * yet are registered WITHOUT a `run`: the runner records them as `skipped` with code
 * `not_implemented` (never an error, never a silent success), and "Run now" is refused for them.
 */
import {
  ECB_MAX_ATTEMPTS,
  ECB_MAX_LATENESS_MS,
  recordEcbTooLate,
  runEcbImport,
} from "../fx/ecb-import";
import { DAILY_BOOKING_CALL_CAP, runBookMatches } from "../booking/executor";
import { runBankBalances } from "../exact/bank-balances";
import { runDigest } from "../dq/digest";
import { runDqChecks } from "../dq/run";
import { runMatching } from "../matching/run";
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
  "bank.match": {
    title: "Bank matching",
    description:
      "Matches completed Revolut transactions to open invoices and bills and writes suggestions for the review queue. Automatic matching stays off until an admin switches it on in Settings; it never writes to Exact (the booking step is separate).",
    usesExact: false,
    phase: null,
    // The next slot is the retry.
    maxAttempts: 1,
    scheduleRules: { minIntervalMinutes: 5 },
    maxLatenessMs: 30 * MIN,
    run: runMatching,
  },
  "exact.bank_balances": {
    title: "Bank balances from Exact",
    description:
      "Reads the balance of each mapped bank ledger account from Exact (one call per account, current reporting year) so the data quality rule 'Exact balance differs from bank balance' has something to compare. Reads only; ships switched off until the first live checks (docs/DEPLOY.md).",
    usesExact: true,
    phase: null,
    // The next slot is the retry.
    maxAttempts: 1,
    // The Exact bank feed is daily; faster polling only wastes budget.
    scheduleRules: { minIntervalMinutes: 30 },
    maxLatenessMs: 2 * HOUR,
    run: runBankBalances,
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
    // attempt number. The handler decides from the slot and the clock (with a queue-delay
    // margin) and ends the last attempt that fits as error / rate_not_published. If the queue is
    // later than the margin anyway, the runner records error / too_late (a failure Phase 8 alerts
    // on, never a quiet skip) and the hook writes it into fx_import_state.
    scheduleRules: { workingDaysOnly: true, minIntervalMinutes: 60 },
    maxLatenessMs: ECB_MAX_LATENESS_MS,
    tooLateIsFailure: true,
    onTooLate: recordEcbTooLate,
    run: runEcbImport,
  },
  "dq.checks": {
    title: "Data quality checks",
    description:
      "Runs the data quality rules on the data already in the database (no call to Exact or Revolut), opens, refreshes and resolves issues, and records which rules could not be evaluated. On by default on new installs.",
    usesExact: false,
    phase: null,
    // The next slot is the retry.
    maxAttempts: 1,
    scheduleRules: { minIntervalMinutes: 15 },
    maxLatenessMs: 2 * HOUR,
    run: (ctx) =>
      runDqChecks(ctx, {
        describeHandler: (h) => ({
          title: handlerFor(h)?.title ?? null,
          implemented: isImplemented(h),
        }),
      }),
  },
  "dq.digest": {
    title: "Data quality digest",
    description:
      "Sends each admin and finance user on the allowed domain one e-mail with the open data quality issues: counts by severity and area, what is new, the oldest issue, the top ten with fix links and the rules that were not evaluated. Sends nothing until the e-mail provider is configured (Settings); it then records 'skipped_not_configured'. One e-mail per person and day, never repeated.",
    usesExact: false,
    phase: null,
    // A refused send (provider said no) is retried after ten minutes; an unclear outcome never is.
    maxAttempts: 3,
    scheduleRules: { minIntervalMinutes: 12 * 60 },
    maxLatenessMs: 4 * HOUR,
    // Sends e-mail: a fresh sign-in is needed to start it by hand.
    stepUp: true,
    run: (ctx) => runDigest(ctx),
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
  "exact.book_matches": {
    title: "Book matches in Exact",
    description:
      "Writes confirmed bank matches to Exact: a bank entry (unless Revolut's own Exact feed creates the line) and then a MatchSet, each verified by reading Exact back. Does nothing until an admin has verified the write path on a test division and switched booking on (Settings). Never posts twice: an unclear answer waits for an admin.",
    usesExact: true,
    dailyExactCallCap: DAILY_BOOKING_CALL_CAP,
    phase: null,
    // The next slot is the retry.
    maxAttempts: 1,
    // Writes to the system of record: admins only, with a fresh sign-in.
    runRoles: ["admin"],
    stepUp: true,
    scheduleRules: { minIntervalMinutes: 5 },
    maxLatenessMs: 30 * MIN,
    run: runBookMatches,
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
