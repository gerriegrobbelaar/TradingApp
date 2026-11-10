/** Idempotency keys: claim before any external write, complete with the stored result. */
export type ClaimResult =
  { status: "claimed" } | { status: "duplicate"; state: "pending" | "completed"; result: unknown };

export async function claimIdempotencyKey(
  db: D1Database,
  key: string,
  scope: string,
): Promise<ClaimResult> {
  const inserted = await db
    .prepare(
      "INSERT INTO idempotency_keys (key, scope) VALUES (?1, ?2) ON CONFLICT (key) DO NOTHING",
    )
    .bind(key, scope)
    .run();
  if (inserted.meta.changes === 1) return { status: "claimed" };

  const row = await db
    .prepare("SELECT status, result_json FROM idempotency_keys WHERE key = ?1")
    .bind(key)
    .first<{ status: "pending" | "completed"; result_json: string | null }>();
  return {
    status: "duplicate",
    state: row?.status ?? "pending",
    result: row?.result_json ? JSON.parse(row.result_json) : null,
  };
}

export async function completeIdempotencyKey(
  db: D1Database,
  key: string,
  result: unknown,
): Promise<void> {
  await db
    .prepare(
      `UPDATE idempotency_keys
       SET status = 'completed', result_json = ?2, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE key = ?1`,
    )
    .bind(key, JSON.stringify(result ?? null))
    .run();
}
