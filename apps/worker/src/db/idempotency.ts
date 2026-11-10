/**
 * Idempotency keys (CLAUDE.md 5): claim before any external write, complete with the stored
 * result. The claim is a single INSERT ... ON CONFLICT DO NOTHING, so two concurrent callers
 * can never both get "claimed".
 *
 * A "duplicate" with state "pending" means an earlier attempt claimed the key but did not
 * record a result (in flight, or crashed mid-call). Callers must then reconcile with the
 * provider using the same key (e.g. look up the Revolut request_id) and never mint a new key.
 */
export type ClaimResult =
  { status: "claimed" } | { status: "duplicate"; state: "pending" | "completed"; result: unknown };

function assertKey(scope: string, key: string): void {
  if (scope.trim() === "" || key.trim() === "") {
    throw new Error("idempotency scope and key must be non-empty");
  }
}

export async function claimIdempotencyKey(
  db: D1Database,
  key: string,
  scope: string,
): Promise<ClaimResult> {
  assertKey(scope, key);
  const inserted = await db
    .prepare(
      "INSERT INTO idempotency_keys (scope, key) VALUES (?1, ?2) ON CONFLICT (scope, key) DO NOTHING",
    )
    .bind(scope, key)
    .run();
  if (inserted.meta.changes === 1) return { status: "claimed" };

  const row = await db
    .prepare("SELECT status, result_json FROM idempotency_keys WHERE scope = ?1 AND key = ?2")
    .bind(scope, key)
    .first<{ status: "pending" | "completed"; result_json: string | null }>();
  if (!row) throw new Error("idempotency key vanished after conflict");
  return {
    status: "duplicate",
    state: row.status,
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
  };
}

/** Records the result of a claimed key. Throws if the key was never claimed or is already done. */
export async function completeIdempotencyKey(
  db: D1Database,
  key: string,
  scope: string,
  result: unknown,
): Promise<void> {
  assertKey(scope, key);
  const updated = await db
    .prepare(
      `UPDATE idempotency_keys
       SET status = 'completed', result_json = ?3, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE scope = ?1 AND key = ?2 AND status = 'pending'`,
    )
    .bind(scope, key, JSON.stringify(result ?? null))
    .run();
  if (updated.meta.changes !== 1) {
    throw new Error("idempotency key not pending (never claimed or already completed)");
  }
}

/**
 * Scopes whose keys are short-lived by nature and may be purged: an exact allow-list, not a
 * prefix, so no look-alike scope name can opt in. Payment and booking scopes never appear here.
 */
const PURGEABLE_SCOPES: ReadonlySet<string> = new Set(["auth.flow", "exact.flow"]);
/**
 * Floor for retention. Purging a key while the token it guards is still usable would re-open
 * replay, so callers may not go below this (the sign-in flow cookie lives 10 minutes).
 */
const MIN_RETENTION_MS = 3600 * 1000;

/**
 * Single-use token claim for ephemeral scopes (the sign-in round trip). One batch (one D1
 * transaction): an atomic INSERT ... ON CONFLICT DO NOTHING stored as already completed, plus
 * a bounded purge of this scope's expired keys. Returns true only for the one caller that
 * claimed the key. Refuses any scope not in PURGEABLE_SCOPES so a payment key can never be
 * purged, and a retention shorter than MIN_RETENTION_MS.
 */
export async function claimOnceAndPurge(
  db: D1Database,
  key: string,
  scope: string,
  opts: { nowMs: number; retentionMs: number; purgeLimit: number },
): Promise<boolean> {
  assertKey(scope, key);
  if (!PURGEABLE_SCOPES.has(scope)) {
    throw new Error(`scope ${scope} is not purgeable; use claimIdempotencyKey`);
  }
  if (!Number.isFinite(opts.nowMs) || !(opts.retentionMs >= MIN_RETENTION_MS)) {
    throw new Error("claimOnceAndPurge: retention below the minimum");
  }
  if (!Number.isInteger(opts.purgeLimit) || opts.purgeLimit < 1 || opts.purgeLimit > 1000) {
    throw new Error("claimOnceAndPurge: purgeLimit must be an integer 1-1000");
  }
  const [claim] = await db.batch([
    db
      .prepare(
        `INSERT INTO idempotency_keys (scope, key, status, completed_at)
         VALUES (?1, ?2, 'completed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT (scope, key) DO NOTHING`,
      )
      .bind(scope, key),
    db
      .prepare(
        `DELETE FROM idempotency_keys WHERE rowid IN (
           SELECT rowid FROM idempotency_keys
           WHERE scope = ?1 AND created_at < ?2 LIMIT ?3)`,
      )
      .bind(scope, new Date(opts.nowMs - opts.retentionMs).toISOString(), opts.purgeLimit),
  ]);
  return claim?.meta.changes === 1;
}
