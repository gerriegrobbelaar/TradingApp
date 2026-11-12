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

/**
 * Test setup only: empties email_log. Migration 0027 refuses to delete a row younger than 365 days
 * (`email_log_keep_recent`), so a reset lifts that one trigger inside the same batch and puts it
 * back unchanged.
 */
export async function emailLogWipeStatements(db: D1Database): Promise<D1PreparedStatement[]> {
  const row = await db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'email_log_keep_recent'",
    )
    .first<{ sql: string }>();
  const wipe = db.prepare("DELETE FROM email_log");
  if (row === null) return [wipe];
  return [db.prepare("DROP TRIGGER email_log_keep_recent"), wipe, db.prepare(row.sql)];
}

const PAYMENT_DELETE_GUARDS = [
  "payment_events_guard_delete",
  "payment_claims_guard_delete",
  "payment_approvals_guard_delete",
  "payments_guard_no_delete",
  "payment_batches_guard_no_delete",
  "supplier_iban_verifications_guard_delete",
  "payment_payees_guard_delete",
  "payment_bank_links_guard_delete",
] as const;

/**
 * Test setup only: empties the payment tables (migration 0028). The app never deletes their rows
 * (`*_guard_delete` / `*_guard_no_delete`), so a reset lifts those triggers inside the same batch
 * (one transaction: a failed batch restores them) and puts them back unchanged. Children first.
 */
export async function paymentsWipeStatements(db: D1Database): Promise<D1PreparedStatement[]> {
  const saved: string[] = [];
  for (const name of PAYMENT_DELETE_GUARDS) {
    const row = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1")
      .bind(name)
      .first<{ sql: string }>();
    if (row === null) return [];
    saved.push(row.sql);
  }
  return [
    ...PAYMENT_DELETE_GUARDS.map((n) => db.prepare(`DROP TRIGGER ${n}`)),
    db.prepare("DELETE FROM payment_bank_links"),
    db.prepare("DELETE FROM payment_reconcile"),
    db.prepare("DELETE FROM payment_payees"),
    db.prepare("DELETE FROM payment_events"),
    db.prepare("DELETE FROM payment_claims"),
    db.prepare("DELETE FROM payment_approvals"),
    db.prepare("DELETE FROM payments"),
    db.prepare("DELETE FROM payment_batches"),
    db.prepare("DELETE FROM supplier_iban_verifications"),
    ...saved.map((sql) => db.prepare(sql)),
  ];
}
