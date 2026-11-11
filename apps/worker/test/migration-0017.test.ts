import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0017 renames open_items.amount_minor to stored_minor in place (review S10). This runs
 * it on a database that already holds open items with children (match suggestions, matches,
 * payments), as a deployed database would, and checks that nothing else moved.
 */
describe("migration 0017 on a populated database", () => {
  it("renames only open_items.amount_minor, keeps rows, children, indexes and triggers", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0017"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    const indexesBefore = (
      await mdb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'open_items' ORDER BY name",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    const triggersBefore = (
      await mdb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'open_items' ORDER BY name",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(indexesBefore).toContain("idx_open_items_status");
    expect(triggersBefore).toEqual(["open_items_status_insert", "open_items_status_update"]);

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status, creates_bank_entries) VALUES (5, 'exact', 'exact', 'active', 0)",
      ),
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status, creates_bank_entries) VALUES (6, 'revolut', 'revolut', 'active', 1)",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (9, 5, 123, 'BV')",
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, amount_minor, open_minor,
           original_minor, status, synced_at)
         VALUES (1, 9, 'item-1', 'invoice', 'EUR', 12345, 4000, 12345, 'open', '2026-01-01T00:00:00Z'),
                (2, 9, 'item-2', 'bill', 'USD', 700, 700, NULL, 'open', '2026-01-01T00:00:00Z')`,
      ),
      mdb.prepare(
        "INSERT INTO bank_accounts (id, connection_id, external_id, name, currency) VALUES (1, 6, 'acc-1', 'Main', 'EUR')",
      ),
      mdb.prepare(
        `INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, leg_id, state,
           amount_minor, currency, booked_at)
         VALUES (1, 6, 1, 'tx-1', 'l-1', 'completed', 4000, 'EUR', '2026-01-02T10:00:00.000Z')`,
      ),
      mdb.prepare(
        "INSERT INTO match_suggestions (bank_transaction_id, open_item_id, score, reason) VALUES (1, 1, 90, 'amount')",
      ),
      mdb.prepare(
        `INSERT INTO matches (bank_transaction_id, open_item_id, amount_minor, currency, mode, matched_by)
         VALUES (1, 1, 4000, 'EUR', 'manual', 'a@b.com')`,
      ),
    ]);

    await applyD1Migrations(mdb, all);

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    // Values and neighbouring columns are untouched.
    expect(
      (
        await mdb
          .prepare(
            "SELECT id, stored_minor, open_minor, original_minor, status FROM open_items ORDER BY id",
          )
          .all()
      ).results,
    ).toEqual([
      { id: 1, stored_minor: 12345, open_minor: 4000, original_minor: 12345, status: "open" },
      { id: 2, stored_minor: 700, open_minor: 700, original_minor: null, status: "open" },
    ]);

    // The old name is gone from open_items, and only from open_items.
    const oldName = await mdb
      .prepare("SELECT amount_minor FROM open_items")
      .run()
      .then(
        () => false,
        () => true,
      );
    expect(oldName).toBe(true);
    for (const table of ["bank_transactions", "matches", "payments", "purchase_entries"]) {
      const cols = (
        await mdb.prepare(`PRAGMA table_info('${table}')`).all<{ name: string }>()
      ).results.map((c) => c.name);
      expect(cols, table).toContain("amount_minor");
      expect(cols, table).not.toContain("stored_minor");
    }
    expect(
      await mdb.prepare("SELECT amount_minor FROM bank_transactions WHERE id = 1").first(),
    ).toEqual({ amount_minor: 4000 });

    // Children survived (no cascade ran), indexes and triggers are the same objects.
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM match_suggestions").first<{ n: number }>())?.n,
    ).toBe(1);
    expect((await mdb.prepare("SELECT COUNT(*) AS n FROM matches").first<{ n: number }>())?.n).toBe(
      1,
    );
    const indexesAfter = (
      await mdb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'open_items' ORDER BY name",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(indexesAfter).toEqual(indexesBefore);
    const triggersAfter = (
      await mdb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'open_items' ORDER BY name",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(triggersAfter).toEqual(triggersBefore);

    // No schema object that mentions open_items still names the old column (SQLite rewrote the
    // table, index, trigger and view definitions), and the table definition names the new one.
    const objects = (
      await mdb
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql LIKE '%open_items%'")
        .all<{ type: string; name: string; sql: string }>()
    ).results;
    const table = objects.find((o) => o.type === "table" && o.name === "open_items");
    expect(table?.sql).toMatch(/\bstored_minor\b/);
    expect(table?.sql).not.toMatch(/\bamount_minor\b/);
    for (const o of objects) {
      if (o.type === "table" && o.name !== "open_items") continue; // other tables keep theirs
      expect(o.sql, `${o.type} ${o.name}`).not.toMatch(/\bamount_minor\b/);
    }
    // The other tables' amount_minor definitions are untouched.
    const bt = await mdb
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bank_transactions'")
      .first<{ sql: string }>();
    expect(bt?.sql).toMatch(/\bamount_minor\b/);

    // The status trigger still fires and the new column still works in writes and upserts.
    const bad = await mdb
      .prepare(
        `INSERT INTO open_items (division_id, exact_id, kind, currency, stored_minor, open_minor, status, synced_at)
         VALUES (9, 'item-3', 'bill', 'EUR', 1, 1, 'weird', '2026-01-01T00:00:00Z')`,
      )
      .run()
      .then(
        () => false,
        () => true,
      );
    expect(bad).toBe(true);
    await mdb
      .prepare(
        `INSERT INTO open_items (division_id, exact_id, kind, currency, stored_minor, open_minor, status, synced_at)
         VALUES (9, 'item-1', 'invoice', 'EUR', 1, 1, 'open', '2026-01-01T00:00:00Z')
         ON CONFLICT (division_id, exact_id) DO UPDATE SET stored_minor = excluded.stored_minor`,
      )
      .run();
    expect(await mdb.prepare("SELECT stored_minor FROM open_items WHERE id = 1").first()).toEqual({
      stored_minor: 1,
    });
  });
});
