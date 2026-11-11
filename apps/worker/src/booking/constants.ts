/**
 * The booking executor's limits and timings (task M7c, ADR 0044). Kept apart from the executor so
 * they can be part of BOOKING_PROTOCOL_VERSION (booking/protocol.ts) without an import cycle.
 */
/** Upper bound of matches a run may START (the admin's `exact.booking_max_per_run` is 1 to this). */
export const MAX_MATCHES_PER_RUN = 10;
/** Candidates a run looks at (deferred ones included), so a deferred match cannot starve the rest. */
export const MAX_CANDIDATES_SCANNED = 25;
/** A match deferred for a reason read from Exact is looked at again after this long, not every run. */
export const DEFER_RECHECK_MS = 30 * 60_000;
export const MAX_CALLS_PER_RUN = 30;
/**
 * Calls this job may spend in any rolling 25 hours (all administrations together). 25, not 24: the
 * longest Amsterdam day (the end of summer time) has 25 hours, so no calendar day can see more. The
 * schedule projection uses the same number (HandlerDef.dailyExactCallCap).
 */
export const DAILY_BOOKING_CALL_CAP = 400;
export const DAILY_CAP_WINDOW_MS = 25 * 3600_000;
/** A match must be at least this old before it is booked: the window in which Undo is easy. */
export const BOOKING_DELAY_MS = 10 * 60_000;
/** Attempts of a MatchSet that Exact answered with an explicit error and did not apply. */
export const MAX_AUTO_RETRIES = 3;
export const RETRY_BACKOFF_MS: readonly number[] = [5 * 60_000, 30 * 60_000, 2 * 3600_000];
/** Revolut's own Exact feed gets this long to create the bank line (creates_bank_entries = 0). */
export const WAIT_FOR_LINE_MS = 48 * 3600_000;
/** An answer we accepted but could not verify for this long becomes `outcome_unknown`. */
export const UNVERIFIED_MAX_MS = 6 * 3600_000;
