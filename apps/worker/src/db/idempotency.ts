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

/** Scopes whose keys are short-lived by nature and may be purged. Payment scopes never are. */
const PURGEABLE_SCOPE_PREFIX = "auth.";

/**
 * Single-use token claim for ephemeral scopes (the sign-in round trip). One batch (one D1
 * transaction): an atomic INSERT ... ON CONFLICT DO NOTHING stored as already completed, plus
 * a bounded purge of this scope's expired keys. Returns true only for the one caller that
 * claimed the key. Refuses any scope outside "auth." so a payment key can never be purged.
 */
export async function claimOnceAndPurge(
  db: D1Database,
  key: string,
  scope: string,
  opts: { nowMs: number; retentionMs: number; purgeLimit: number },
): Promise<boolean> {
  assertKey(scope, key);
  if (!scope.startsWith(PURGEABLE_SCOPE_PREFIX)) {
    throw new Error(`scope ${scope} is not purgeable; use claimIdempotencyKey`);
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
