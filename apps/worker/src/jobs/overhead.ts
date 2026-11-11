/**
 * Subrequests the RUNNER itself spends in the same invocation as a handler (review S7). The
 * Workers limit counts every fetch, D1 call and Durable Object call of one invocation, so the
 * Exact sync meter is pre-charged with this before it starts. Assumed limit: 1,000 subrequests per
 * invocation on the paid plan, to be verified on the account (ADR 0021).
 */
export const HEARTBEAT_MS = 30_000;
/** Before the handler: load the run (D1), claim it (D1), acquire the JobLock (Durable Object). */
export const SUBREQUESTS_BEFORE_RUN = 3;
/** One beat = lock.heartbeat (Durable Object) + the heartbeat UPDATE (D1). */
export const SUBREQUESTS_PER_HEARTBEAT = 2;
/** After the handler: the lock release, the finish batch (one D1 call) and the retry enqueue. */
export const SUBREQUESTS_AFTER_RUN = 3;

/**
 * Worst case runner subrequests around a handler that may keep working for `windowMs` after it
 * started: the calls before it, a beat every HEARTBEAT_MS of the window (rounded up, plus one for
 * a beat that fires while the finish is under way), and the calls after it. Counted once: the
 * caller passes the handler's own window (its deadline minus its start), no extra grace.
 */
export function runnerOverhead(windowMs: number): number {
  const beats = Math.ceil(Math.max(windowMs, 0) / HEARTBEAT_MS) + 1;
  return SUBREQUESTS_BEFORE_RUN + beats * SUBREQUESTS_PER_HEARTBEAT + SUBREQUESTS_AFTER_RUN;
}
