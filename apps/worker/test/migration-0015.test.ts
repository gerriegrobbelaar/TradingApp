import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0015 adds the matching-data columns to bank_transactions, the quarantine and
 * counterparty tables and the bank-details bookkeeping on bank_accounts. It is additive; this runs
 * it on a database that already holds Revolut rows (0014 applied), as a deployed Phase 5 database.
 */
describe("migration 0015 on a populated database", () => {
  it("keeps every row, backfills the details status, and enforces the new checks", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0015"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status, creates_bank_entries) VALUES (7, 'revolut', 'revolut', 'active', 1)",
      ),
      mdb.prepare(
        `INSERT INTO bank_accounts (id, connection_id, external_id, name, currency, iban, bic, created_at, updated_at)
         VALUES (1, 7, 'a-iban', 'With IBAN', 'EUR', 'GB33REVO00996912345678', 'REVOGB21', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
                (2, 7, 'a-none', 'No IBAN', 'USD', NULL, '', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
                (3, 7, 'a-new', 'Never looked up', 'GBP', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z')`,
      ),
      mdb.prepare(
        `INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, leg_id, state,
           amount_minor, currency, booked_at, created_at, match_status)
         VALUES (1, 7, 1, 'tx-1', 'l-1', 'completed', 12345, 'EUR', '2026-01-02T10:00:00.000Z',
                 '2026-01-02T10:00:00.000Z', 'matched')`,
      ),
      mdb.prepare(
        `INSERT INTO revolut_sync_state (connection_id, entity, cursor, window_from, window_days,
           walk_started_at, requested_days, initial)
         VALUES (7, 'backfill', '{"toIso":"2026-01-05T00:00:00.000Z","seen":[]}',
                 '2025-10-01T00:00:00.000Z', 90, '2026-01-05T00:00:00.000Z', 90, 1)`,
      ),
    ]);

    await applyD1Migrations(mdb, all);

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      await mdb
        .prepare(
          `SELECT amount_minor, match_status, fee_minor, balance_minor, counterparty_ref, card_last4,
                  skipped_legs, state_conflict FROM bank_transactions WHERE id = 1`,
        )
        .first(),
    ).toEqual({
      amount_minor: 12345,
      match_status: "matched",
      fee_minor: null,
      balance_minor: null,
      counterparty_ref: null,
      card_last4: null,
      skipped_legs: 0,
      state_conflict: 0,
    });
    expect(
      (
        await mdb
          .prepare(
            "SELECT id, details_status, details_attempts, details_checked_at FROM bank_accounts ORDER BY id",
          )
          .all()
      ).results,
    ).toEqual([
      { id: 1, details_status: "ok", details_attempts: 1, details_checked_at: null },
      {
        id: 2,
        details_status: "error",
        details_attempts: 1,
        details_checked_at: "2026-01-03T00:00:00.000Z",
      },
      { id: 3, details_status: null, details_attempts: 0, details_checked_at: null },
    ]);

    // Checks: the card keeps four digits only, flags are 0/1, statuses are known.
    const bad = async (sql: string): Promise<void> => {
      await expect(mdb.prepare(sql).run()).rejects.toThrow();
    };
    await bad("UPDATE bank_transactions SET card_last4 = '123456******7890' WHERE id = 1");
    await bad("UPDATE bank_transactions SET card_last4 = 'abcd' WHERE id = 1");
    await bad("UPDATE bank_transactions SET state_conflict = 2 WHERE id = 1");
    await bad("UPDATE bank_transactions SET skipped_legs = -1 WHERE id = 1");
    await bad("UPDATE bank_accounts SET details_status = 'maybe' WHERE id = 1");
    await mdb.prepare("UPDATE bank_transactions SET card_last4 = '7890' WHERE id = 1").run();

    // Quarantine: unique per connection and external id, bounded flags.
    const ins = (id: string) =>
      mdb
        .prepare(
          `INSERT INTO revolut_quarantine (connection_id, external_id, code, first_seen_at, last_seen_at)
           VALUES (7, ?1, 'bad_shape', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .bind(id)
        .run();
    await ins("q-1");
    await expect(ins("q-1")).rejects.toThrow();
    await bad("UPDATE revolut_quarantine SET gave_up = 2");

    // Counterparty cache: unique per connection and ref, known statuses.
    const cp = (ref: string, status: string) =>
      mdb
        .prepare(
          `INSERT INTO revolut_counterparties (connection_id, counterparty_ref, status, fetched_at, checked_at)
           VALUES (7, ?1, ?2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .bind(ref, status)
        .run();
    await cp("cp-1", "ok");
    await expect(cp("cp-1", "ok")).rejects.toThrow();
    await expect(cp("cp-2", "weird")).rejects.toThrow();
    await bad("UPDATE revolut_counterparties SET attempts = -1");

    // The IBAN source flag defaults to 0 (a stored IBAN came from Revolut) and is 0/1 only.
    expect(
      await mdb
        .prepare("SELECT counterparty_iban_cached AS c FROM bank_transactions WHERE id = 1")
        .first(),
    ).toEqual({ c: 0 });
    await bad("UPDATE bank_transactions SET counterparty_iban_cached = 2 WHERE id = 1");

    // A sync state row stored before the migration keeps its walk and has no pending replacement.
    expect(
      await mdb
        .prepare(
          "SELECT cursor, window_from, requested_days, pending_replacement FROM revolut_sync_state WHERE connection_id = 7 AND entity = 'backfill'",
        )
        .first(),
    ).toEqual({
      cursor: '{"toIso":"2026-01-05T00:00:00.000Z","seen":[]}',
      window_from: "2025-10-01T00:00:00.000Z",
      requested_days: 90,
      pending_replacement: null,
    });

    // The new indexes exist (the conflict list and the quarantine prune use them).
    const indexes = (
      await mdb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    for (const name of [
      "idx_bank_tx_conflict",
      "idx_bank_tx_cp_ref",
      "idx_revolut_cp_fetched",
      "idx_revolut_quarantine_seen",
    ]) {
      expect(indexes).toContain(name);
    }
  });
});
