import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0007 rebuilds sync_state (entity renamed bank_accounts -> relation_ibans, CHECK on
 * entity dropped) and adds columns and a table. This runs it on a database that already holds
 * sync state, relations and open items (as a deployed Phase 2 database would) and checks that
 * nothing is lost and the foreign keys still hold.
 */
describe("migration 0007 on a populated database", () => {
  it("renames the IBAN entity, keeps every sync_state row, and sets the new defaults", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0007"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (5, 'exact', 'exact', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (9, 5, 123, 'First')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (10, 5, 124, 'Second')",
      ),
      // A second connection whose divisions were inserted with higher ids, in another order.
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (6, 'exact', 'exact-2', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (12, 6, 100, 'B first')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (13, 6, 50, 'B second')",
      ),
      mdb.prepare(
        "INSERT INTO relations (id, division_id, exact_id, name, iban, updated_at) VALUES (1, 9, 'r1', 'Supplier', 'NL91ABNA0417164300', '2026-01-01T00:00:00Z')",
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, amount_minor, open_minor, status, synced_at)
         VALUES (1, 9, 'item-1', 'invoice', 'EUR', 100, 100, 'open', '2026-01-01T00:00:00Z')`,
      ),
      mdb.prepare(
        `INSERT INTO sync_state (division_id, entity, cursor, mode, last_status, last_completed_at, rows_seen,
           calls_used, cycle_seq, cycle_started_at, pass_cycle, pass_token, pass_rows, pass_total, done_cycle,
           retry_count, retry_day)
         VALUES (9, 'bank_accounts', '0', 'full', 'ok', '2026-01-02T01:00:00Z', 40, 3, NULL, NULL, 7, 'tok', 5, 50, 7, 1, '2026-01-02')`,
      ),
      mdb.prepare(
        `INSERT INTO sync_state (division_id, entity, cursor, mode, last_status, last_full_completed_at, rows_seen, calls_used,
           cycle_seq, cycle_started_at)
         VALUES (9, 'run', '0', 'full', 'ok', '2026-01-02T01:00:00Z', 10, 7, 7, '2026-01-02T00:00:00Z')`,
      ),
      mdb.prepare(
        "INSERT INTO sync_state (division_id, entity, cursor, mode, last_status, rows_seen) VALUES (10, 'relations', '12345678901234567890', 'full', 'partial', 3)",
      ),
      mdb.prepare(
        "INSERT INTO sync_locks (division_id, holder, expires_at, run_seq) VALUES (9, 'h', '2026-01-01T00:00:00Z', 4)",
      ),
    ]);

    const objects = async (type: string) =>
      (
        await mdb
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = ?1 ORDER BY name")
          .bind(type)
          .all<{ name: string; sql: string }>()
      ).results;
    const triggersBefore = await objects("trigger");

    await applyD1Migrations(mdb, all);

    // Every trigger survives unchanged (audit log append-only, open item status rules).
    expect(await objects("trigger")).toEqual(triggersBefore);
    expect(triggersBefore.map((t) => t.name)).toEqual(
      expect.arrayContaining(["audit_log_no_update", "audit_log_no_delete"]),
    );
    // The audit log is still append-only after the migration.
    await mdb
      .prepare(
        "INSERT INTO audit_log (actor_email, action, entity) VALUES ('system', 'test.after_0007', 'test')",
      )
      .run();
    await expect(mdb.prepare("DELETE FROM audit_log").run()).rejects.toThrow();

    const rows = await mdb
      .prepare(
        `SELECT division_id, entity, cursor, mode, last_status, last_completed_at, last_full_completed_at,
                rows_seen, calls_used, cycle_seq, cycle_started_at, pass_cycle, pass_token, pass_rows,
                pass_total, done_cycle, retry_count, retry_day
         FROM sync_state ORDER BY division_id, entity`,
      )
      .all();
    expect(rows.results).toEqual([
      {
        division_id: 9,
        entity: "relation_ibans",
        cursor: "0",
        mode: "full",
        last_status: "ok",
        last_completed_at: "2026-01-02T01:00:00Z",
        last_full_completed_at: null,
        rows_seen: 40,
        calls_used: 3,
        cycle_seq: null,
        cycle_started_at: null,
        pass_cycle: 7,
        pass_token: "tok",
        pass_rows: 5,
        pass_total: 50,
        done_cycle: 7,
        retry_count: 1,
        retry_day: "2026-01-02",
      },
      {
        division_id: 9,
        entity: "run",
        cursor: "0",
        mode: "full",
        last_status: "ok",
        last_completed_at: null,
        last_full_completed_at: "2026-01-02T01:00:00Z",
        rows_seen: 10,
        calls_used: 7,
        cycle_seq: 7,
        cycle_started_at: "2026-01-02T00:00:00Z",
        pass_cycle: null,
        pass_token: null,
        pass_rows: 0,
        pass_total: null,
        done_cycle: null,
        retry_count: 0,
        retry_day: null,
      },
      {
        division_id: 10,
        entity: "relations",
        cursor: "12345678901234567890",
        mode: "full",
        last_status: "partial",
        last_completed_at: null,
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
    ]);

    // Constraints that stay: one row per (division, entity), a valid cursor, a known parent.
    await expect(
      mdb.prepare("INSERT INTO sync_state (division_id, entity) VALUES (9, 'run')").run(),
    ).rejects.toThrow();
    await expect(
      mdb
        .prepare("INSERT INTO sync_state (division_id, entity, cursor) VALUES (10, 'run', '12x')")
        .run(),
    ).rejects.toThrow();
    await expect(
      mdb.prepare("INSERT INTO sync_state (division_id, entity) VALUES (999, 'run')").run(),
    ).rejects.toThrow();
    // The CHECK on entity is gone (validated in code: SYNC_ENTITIES).
    await mdb.prepare("INSERT INTO sync_state (division_id, entity) VALUES (10, 'anything')").run();

    // Only the first division of a connection (the /Me one) stays enabled; nothing else lost.
    expect(
      (
        await mdb
          .prepare(
            "SELECT id, sync_enabled, base_currency, base_currency_read_at FROM divisions ORDER BY id",
          )
          .all()
      ).results,
    ).toEqual([
      { id: 9, sync_enabled: 1, base_currency: "EUR", base_currency_read_at: null },
      { id: 10, sync_enabled: 0, base_currency: "EUR", base_currency_read_at: null },
      // Per connection: the lowest id (the division the connect callback inserted first).
      { id: 12, sync_enabled: 1, base_currency: "EUR", base_currency_read_at: null },
      { id: 13, sync_enabled: 0, base_currency: "EUR", base_currency_read_at: null },
    ]);
    expect(
      await mdb.prepare("SELECT exact_identity FROM connections WHERE id = 5").first(),
    ).toEqual({ exact_identity: null });
    expect(await mdb.prepare("SELECT source FROM open_items WHERE id = 1").first()).toEqual({
      source: null,
    });
    expect(
      await mdb
        .prepare("SELECT iban, iban_added_at, iban_changed_at FROM relations WHERE id = 1")
        .first(),
    ).toEqual({ iban: "NL91ABNA0417164300", iban_added_at: null, iban_changed_at: null });
    expect(
      (await mdb.prepare("SELECT run_seq FROM sync_locks WHERE division_id = 9").first())?.[
        "run_seq"
      ],
    ).toBe(4);
    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    // open_items.source accepts only list / sync.
    await mdb.prepare("UPDATE open_items SET source = 'list' WHERE id = 1").run();
    await expect(
      mdb.prepare("UPDATE open_items SET source = 'other' WHERE id = 1").run(),
    ).rejects.toThrow();

    // relation_bank_accounts: unique per relation and IBAN, normalised IBANs only, cascades.
    const ins = (iban: string) =>
      mdb
        .prepare(
          `INSERT INTO relation_bank_accounts (division_id, relation_id, iban, first_seen_at, last_seen_at)
           VALUES (9, 1, ?1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .bind(iban)
        .run();
    await ins("NL91ABNA0417164300");
    await expect(ins("NL91ABNA0417164300")).rejects.toThrow();
    await expect(ins("nl91abna0417164300")).rejects.toThrow();
    await expect(ins("NL91 ABNA 0417 1643 00")).rejects.toThrow();
    await expect(ins("NL91")).rejects.toThrow();
    await expect(
      mdb
        .prepare(
          `INSERT INTO relation_bank_accounts (division_id, relation_id, iban, first_seen_at, last_seen_at)
           VALUES (9, 999, 'DE89370400440532013000', 'x', 'x')`,
        )
        .run(),
    ).rejects.toThrow();
    await mdb.prepare("DELETE FROM relations WHERE id = 1").run();
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM relation_bank_accounts").first())?.["n"],
    ).toBe(0);
  });
});
