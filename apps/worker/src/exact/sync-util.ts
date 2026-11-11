/**
 * Small pieces shared by the Exact sync (sync.ts) and the ledger sync (ledger-sync.ts): the
 * subrequest meter, batched D1 writes and the lease guard. Moved out of sync.ts so the two can use
 * them without importing each other. sync.ts re-exports the public ones, so existing imports of
 * `newMeter`, `SubrequestMeter` and the SUBREQUEST_* constants keep working.
 */

/**
 * Subrequests one Worker invocation may make (each gate RPC and each D1 call counts). 1,000 is
 * the long-standing Workers Paid per-invocation limit; it is the conservative figure until the
 * account's actual limit is checked (ADR 0017). The run stops as `partial` (`subrequest_limit`)
 * while SUBREQUEST_RESERVE remain, which is enough for the final batch, endJob and the release.
 */
export const SUBREQUEST_LIMIT = 1000;
export const SUBREQUEST_RESERVE = 25;

/** Shared by all runs of one invocation (the scheduler syncs several divisions in one). */
export interface SubrequestMeter {
  used: number;
  limit: number;
}
export const newMeter = (limit = SUBREQUEST_LIMIT): SubrequestMeter => ({ used: 0, limit });

export const BATCH_LIMIT = 100;

/** A clean stop between Exact calls: deadline or subrequest limit. Ends the run as partial. */
export class SyncStop extends Error {
  constructor(readonly code: "time_limit" | "subrequest_limit") {
    super(code);
    this.name = "SyncStop";
  }
}

/** Counts one subrequest, refusing it when only the reserve would be left. */
export function spend(meter: SubrequestMeter): void {
  if (meter.used + 1 + SUBREQUEST_RESERVE > meter.limit) throw new SyncStop("subrequest_limit");
  meter.used += 1;
}

export async function runBatches(
  db: D1Database,
  meter: SubrequestMeter,
  units: D1PreparedStatement[][],
): Promise<void> {
  // Units (for example change + its audit row) are never split across batches.
  let cur: D1PreparedStatement[] = [];
  for (const unit of units) {
    if (cur.length > 0 && cur.length + unit.length > BATCH_LIMIT) {
      spend(meter);
      await db.batch(cur);
      cur = [];
    }
    cur.push(...unit);
  }
  if (cur.length > 0) {
    spend(meter);
    await db.batch(cur);
  }
}

/** The run that wrote a statement still holds the division's lease (?1 = division_id). */
export const leaseHeld = (holderParam: string, seqParam: string): string =>
  `EXISTS (SELECT 1 FROM sync_locks WHERE division_id = ?1 AND holder = ${holderParam}
           AND run_seq = ${seqParam})`;

/** Identifies the run for the lease guard. */
export interface Lease {
  holder: string;
  runSeq: number;
}

/**
 * A complete FULL read closes every open item it did not see. If that would be more than
 * max(CLOSE_GUARD_MIN, CLOSE_GUARD_FRACTION of what we hold), it is far more likely a fault (wrong
 * division, filter, licence, unstable paging) than a genuine mass change: nothing is closed and
 * the entity ends `error` / `close_guard` until an admin runs a full sync with `allowLargeClose`.
 * The same guard protects the ledger tables (ledger-sync.ts).
 */
export const CLOSE_GUARD_MIN = 5;
export const CLOSE_GUARD_FRACTION = 0.2;

/** True when closing `stale` of `open` rows is allowed without the admin override. */
export const closeAllowed = (stale: number, open: number): boolean =>
  stale <= Math.max(CLOSE_GUARD_MIN, open * CLOSE_GUARD_FRACTION);
