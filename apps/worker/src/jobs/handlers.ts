/**
 * Handler registry: the code behind each job's `handler` key. Jobs of phases that are not built
 * yet are registered WITHOUT a `run`: the runner records them as `skipped` with code
 * `not_implemented` (never an error, never a silent success), and "Run now" is refused for them.
 */
import { FULL_SYNC_MAX_ATTEMPTS, runExactSync } from "./exact-handlers";
import type { HandlerDef } from "./types";

const later = (phase: string) => ({ phase, maxAttempts: 1 });

export const HANDLERS: Record<string, HandlerDef> = {
  "revolut.sync": {
    title: "Revolut balances and transactions",
    description: "Reads balances and transactions from Revolut Business.",
    usesExact: false,
    ...later("Phase 5, Revolut connection"),
  },
  "exact.bank_balances": {
    title: "Bank balances from Exact",
    description: "Reads the ING and Rabobank balances that Exact imported.",
    usesExact: true,
    ...later("Phase 5, Revolut connection"),
  },
  "ecb.fx_import": {
    title: "ECB exchange rates",
    description: "Imports the daily ECB reference rates; retries until 17:30 if they are late.",
    usesExact: false,
    phase: "Phase 6, ECB FX",
    // 16:15 plus seven retries ten minutes apart reaches 17:25.
    maxAttempts: 8,
  },
  "dq.checks": {
    title: "Data quality checks",
    description: "Runs the data quality rules and raises alerts.",
    usesExact: false,
    ...later("Phase 8, Data quality"),
  },
  "reminders.send": {
    title: "Payment reminders",
    description: "Sends the invoice copies and reminders that are due.",
    usesExact: false,
    ...later("Phase 10, Reminders"),
  },
  "exact.full_sync": {
    title: "Full sync from Exact",
    description:
      "Copies relations, open receivables and open payables from Exact, and closes items Exact no longer lists. Continues by itself if it stops partway.",
    usesExact: true,
    phase: null,
    maxAttempts: FULL_SYNC_MAX_ATTEMPTS,
    run: (ctx) => runExactSync("full", ctx),
  },
  "exact.incremental_sync": {
    title: "Incremental sync from Exact",
    description: "Refreshes administrations and relations. Open items are left to the full sync.",
    usesExact: true,
    phase: null,
    maxAttempts: 1,
    run: (ctx) => runExactSync("incremental", ctx),
  },
  "fx.revaluation": {
    title: "FX revaluation (draft journal)",
    description: "Revalues open foreign-currency items at the month-end ECB rate as a draft.",
    usesExact: true,
    ...later("Phase 12, Monthly FX revaluation"),
  },
};

export const handlerFor = (key: string): HandlerDef | undefined =>
  Object.prototype.hasOwnProperty.call(HANDLERS, key) ? HANDLERS[key] : undefined;

/** True when "Run now" and scheduled runs would actually do something. */
export const isImplemented = (key: string): boolean => handlerFor(key)?.run !== undefined;
