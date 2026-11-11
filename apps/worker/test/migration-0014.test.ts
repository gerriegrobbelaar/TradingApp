import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0014 adds revolut_sync_state, bank_transactions.description and a keyset index. It is
 * additive; this runs it on a database that already holds Revolut rows (0013 applied), as a
 * deployed Phase 5 database would.
 */
describe("migration 0014 on a populated database", () => {
  it("keeps every row, adds the new objects and enforces the state table's checks", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0014"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status, creates_bank_entries) VALUES (6, 'revolut', 'revolut', 'active', 1)",
      ),
      mdb.prepare(
        "INSERT INTO bank_accounts (id, connection_id, external_id, name, currency) VALUES (1, 6, 'acc-1', 'Main', 'EUR')",
      ),
      mdb.prepare(
        `INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, leg_id, state,
           amount_minor, currency, booked_at, created_at)
         VALUES (1, 6, 1, 'tx-1', 'l-1', 'completed', 12345, 'EUR', '2026-01-02T10:00:00.000Z',
                 '2026-01-02T10:00:00.000Z'),
                (2, 6, 1, 'tx-1', 'l-2', 'completed', -12345, 'EUR', '2026-01-02T10:00:00.000Z',
                 '2026-01-02T10:00:00.000Z')`,
      ),
      mdb
        .prepare(
          `INSERT INTO webhook_events (id, connection_id, event_hash, event_type, external_id, status)
         VALUES (1, 6, ?1, 'TransactionCreated', 'tx-1', 'processed')`,
        )
        .bind("a".repeat(64)),
    ]);

    await applyD1Migrations(mdb, all);

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const tx = (
      await mdb
        .prepare(
          "SELECT id, leg_id, amount_minor, state, is_final, description FROM bank_transactions ORDER BY id",
        )
        .all()
    ).results;
    expect(tx).toEqual([
      {
        id: 1,
        leg_id: "l-1",
        amount_minor: 12345,
        state: "completed",
        is_final: 1,
        description: null,
      },
      {
        id: 2,
        leg_id: "l-2",
        amount_minor: -12345,
        state: "completed",
        is_final: 1,
        description: null,
      },
    ]);
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM webhook_events").first<{ n: number }>())?.n,
    ).toBe(1);

    const index = await mdb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_bank_tx_created'",
      )
      .first();
    expect(index).toBeTruthy();

    await mdb
      .prepare(
        "INSERT INTO revolut_sync_state (connection_id, entity, requested_days) VALUES (6, 'backfill', 90)",
      )
      .run();
    const bad = async (sql: string): Promise<boolean> =>
      mdb
        .prepare(sql)
        .run()
        .then(
          () => false,
          () => true,
        );
    expect(
      await bad("INSERT INTO revolut_sync_state (connection_id, entity) VALUES (6, 'other')"),
    ).toBe(true);
    expect(
      await bad("INSERT INTO revolut_sync_state (connection_id, entity) VALUES (6, 'backfill')"),
    ).toBe(true);
    expect(
      await bad(
        "INSERT INTO revolut_sync_state (connection_id, entity, requested_days) VALUES (6, 'accounts', 0)",
      ),
    ).toBe(true);
    expect(
      await bad(
        "INSERT INTO revolut_sync_state (connection_id, entity, last_status) VALUES (6, 'accounts', 'weird')",
      ),
    ).toBe(true);
    expect(
      await bad("INSERT INTO revolut_sync_state (connection_id, entity) VALUES (999, 'accounts')"),
    ).toBe(true);
  });
});
