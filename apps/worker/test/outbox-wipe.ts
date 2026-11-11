/**
 * Test setup only: empties exact_write_outbox. Migration 0024 refuses to delete any outbox row
 * that may have reached Exact (`outbox_guard_delete`), so a reset lifts that one trigger inside the
 * same batch (one transaction: a failed batch restores it) and puts it back unchanged.
 */
export async function outboxWipeStatements(db: D1Database): Promise<D1PreparedStatement[]> {
  const row = await db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'outbox_guard_delete'",
    )
    .first<{ sql: string }>();
  const wipe = db.prepare("DELETE FROM exact_write_outbox");
  if (row === null) return [wipe];
  return [db.prepare("DROP TRIGGER outbox_guard_delete"), wipe, db.prepare(row.sql)];
}
