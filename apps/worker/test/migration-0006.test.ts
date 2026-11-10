import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0006 only adds columns (sync_state, open_items.missed_cycles). This runs it on a database that already holds
 * sync state, locks and open items (as a deployed Phase 2 database would) and checks that nothing
 * is lost, the defaults are right and the foreign keys still hold.
 */
describe("migration 0006 on a database with existing sync state", () => {
  it("keeps every row and gives the new columns safe defaults", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0006"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (5, 'exact', 'exact', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (9, 5, 123, 'BV')",
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, amount_minor, open_minor, status, synced_at, last_seen_sync_id)
         VALUES (1, 9, 'item-1', 'invoice', 'EUR', 12345, 12345, 'open', '2026-01-01T00:00:00Z', 4)`,
      ),
      mdb.prepare(
        `INSERT INTO sync_state (division_id, entity, cursor, mode, last_status, last_full_completed_at, rows_seen, calls_used)
         VALUES (9, 'run', '0', 'full', 'ok', '2026-01-02T01:00:00Z', 10, 7)`,
      ),
      mdb.prepare(
        `INSERT INTO sync_state (division_id, entity, cursor, mode, last_status, rows_seen)
         VALUES (9, 'relations', '12345678901234567890', 'full', 'partial', 3)`,
      ),
      mdb.prepare(
        "INSERT INTO sync_locks (division_id, holder, expires_at, run_seq) VALUES (9, 'h', '2026-01-01T00:00:00Z', 4)",
      ),
    ]);

    await applyD1Migrations(mdb, all);

    const rows = await mdb
      .prepare(
        `SELECT entity, cursor, mode, last_status, last_full_completed_at, rows_seen, calls_used,
                cycle_seq, cycle_started_at, pass_cycle, pass_token, pass_rows, pass_total,
                done_cycle, retry_count, retry_day
         FROM sync_state ORDER BY entity`,
      )
      .all();
    expect(rows.results).toEqual([
      {
        entity: "relations",
        cursor: "12345678901234567890",
        mode: "full",
        last_status: "partial",
        last_full_completed_at: null,
        rows_seen: 3,
        calls_used: 0,
        cycle_seq: null,
        cycle_started_at: null,
        pass_cycle: null,
        pass_token: null,
        pass_rows: 0,
        pass_total: null,
        done_cycle: null,
        retry_count: 0,
        retry_day: null,
      },
      {
        entity: "run",
        cursor: "0",
        mode: "full",
        last_status: "ok",
        last_full_completed_at: "2026-01-02T01:00:00Z",
        rows_seen: 10,
        calls_used: 7,
        cycle_seq: null,
        cycle_started_at: null,
        pass_cycle: null,
        pass_token: null,
        pass_rows: 0,
        pass_total: null,
        done_cycle: null,
        retry_count: 0,
        retry_day: null,
      },
    ]);

    // Other tables are untouched and the foreign keys still hold.
    expect(
      (await mdb.prepare("SELECT run_seq FROM sync_locks WHERE division_id = 9").first())?.[
        "run_seq"
      ],
    ).toBe(4);
    expect(
      await mdb
        .prepare(
          "SELECT last_seen_sync_id, missed_cycles, status, open_minor FROM open_items WHERE id = 1",
        )
        .first(),
    ).toEqual({ last_seen_sync_id: 4, missed_cycles: 0, status: "open", open_minor: 12345 });
    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    // The new columns are writable.
    await mdb
      .prepare(
        `UPDATE sync_state SET cycle_seq = 5, cycle_started_at = '2026-01-03T00:00:00Z', pass_token = 'tok',
           pass_rows = 60, pass_total = 5000, pass_cycle = 5, done_cycle = 5, retry_count = 2, retry_day = '2026-01-03'
         WHERE division_id = 9 AND entity = 'run'`,
      )
      .run();
    await mdb.prepare("UPDATE open_items SET missed_cycles = 1 WHERE id = 1").run();
    // The open/closed triggers of 0005 still apply to the altered table.
    await expect(
      mdb.prepare("UPDATE open_items SET status = 'paid' WHERE id = 1").run(),
    ).rejects.toThrow();
  });
});
