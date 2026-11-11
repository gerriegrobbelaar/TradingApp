/**
 * Subrequests the RUNNER itself spends around a handler (review S7). The Workers limit counts
 * every fetch, D1 call and Durable Object call of one invocation, so the Exact sync meter is
 * pre-charged with this before it starts. Assumed limit: 1,000 subrequests per invocation on the
 * paid plan, to be verified on the account (ADR 0021).
 */
export const HEARTBEAT_MS = 30_000;
/** One beat = lock.heartbeat (Durable Object) + the heartbeat UPDATE (D1). */
export const SUBREQUESTS_PER_HEARTBEAT = 2;
/** The finish batch, the lock release and the job-level end-of-run write (endJob). */
export const SUBREQUESTS_AFTER_RUN = 3;

/**
 * Worst case runner subrequests for a handler that may keep working for `windowMs`: a beat every
 * HEARTBEAT_MS for the whole window (rounded up, plus one for the beat that races the end), then
 * the finish batch, the release and endJob.
 */
export function runnerOverhead(windowMs: number): number {
  const beats = Math.ceil(Math.max(windowMs, 0) / HEARTBEAT_MS) + 1;
  return beats * SUBREQUESTS_PER_HEARTBEAT + SUBREQUESTS_AFTER_RUN;
}
