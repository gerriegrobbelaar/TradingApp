import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0005 adds columns to `open_items` (which reminders and match suggestions reference with
 * ON DELETE CASCADE) instead of rebuilding it. This runs it on a database that already holds
 * open items and their children, the way a deployed Phase 1 database would, and checks nothing is
 * lost, the new objects work and the status guard holds.
 */
describe("migration 0005 on a database with existing rows", () => {
  it("keeps open_items and the rows that cascade from them, and adds the sync tables", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0005"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (5, 'exact', 'exact', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (6, 'revolut', 'main', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (9, 5, 123, 'BV')",
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, amount_minor, open_minor, status, synced_at)
         VALUES (1, 9, 'item-1', 'invoice', 'EUR', 12345, 12345, 'open', '2026-01-01T00:00:00Z')`,
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, amount_minor, open_minor, status, synced_at)
         VALUES (2, 9, 'item-2', 'bill', 'JPY', 1500, 0, 'closed', '2026-01-01T00:00:00Z')`,
      ),
      mdb.prepare(
        "INSERT INTO reminders (id, open_item_id, step, due_on) VALUES (1, 1, 'copy', '2026-02-01')",
      ),
      mdb.prepare(
        "INSERT INTO bank_accounts (id, connection_id, external_id, name, currency) VALUES (1, 6, 'a', 'EUR', 'EUR')",
      ),
      mdb.prepare(
        `INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, state, amount_minor, currency, booked_at)
         VALUES (1, 6, 1, 'tx1', 'completed', 12345, 'EUR', '2026-01-02T00:00:00Z')`,
      ),
      mdb.prepare(
        "INSERT INTO match_suggestions (id, bank_transaction_id, open_item_id, score, reason) VALUES (1, 1, 1, 97, 'number')",
      ),
      mdb.prepare(
        `INSERT INTO payments (id, open_item_id, amount_minor, currency, beneficiary_iban, request_id, created_by)
         VALUES (1, 2, 1500, 'JPY', 'NL91ABNA0417164300', 'req-1', 'a@b.nl')`,
      ),
    ]);

    await applyD1Migrations(mdb, all);

    const rows = await mdb
      .prepare(
        `SELECT id, exact_id, kind, currency, amount_minor, open_minor, status, entry_number, closed_at,
                last_seen_sync_id FROM open_items ORDER BY id`,
      )
      .all();
    expect(rows.results).toEqual([
      {
        id: 1,
        exact_id: "item-1",
        kind: "invoice",
        currency: "EUR",
        amount_minor: 12345,
        open_minor: 12345,
        status: "open",
        entry_number: null,
        closed_at: null,
        last_seen_sync_id: null,
      },
      {
        id: 2,
        exact_id: "item-2",
        kind: "bill",
        currency: "JPY",
        amount_minor: 1500,
        open_minor: 0,
        status: "closed",
        entry_number: null,
        closed_at: null,
        last_seen_sync_id: null,
      },
    ]);
    // children that would have been wiped by a drop-and-recreate of open_items
    for (const t of ["reminders", "match_suggestions", "payments"]) {
      const r = await mdb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
      expect(r?.n, t).toBe(1);
    }
    const fk = await mdb.prepare("PRAGMA foreign_key_check").all();
    expect(fk.results).toEqual([]);

    // status guard: only open or closed, on insert and on update
    await expect(
      mdb
        .prepare(
          `INSERT INTO open_items (division_id, exact_id, kind, currency, amount_minor, open_minor, status, synced_at)
           VALUES (9, 'x', 'invoice', 'EUR', 1, 1, 'weird', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).rejects.toThrow(/open or closed/);
    await expect(
      mdb.prepare("UPDATE open_items SET status = 'paid' WHERE id = 1").run(),
    ).rejects.toThrow(/open or closed/);
    await mdb.prepare("UPDATE open_items SET status = 'closed' WHERE id = 1").run();

    // new tables work, with their constraints
    await mdb
      .prepare(
        "INSERT INTO relations (division_id, exact_id, name, updated_at) VALUES (9, 'r1', 'Acme', '2026-01-01T00:00:00Z')",
      )
      .run();
    await expect(
      mdb
        .prepare(
          "INSERT INTO relations (division_id, exact_id, name, updated_at) VALUES (9, 'r1', 'Dup', '2026-01-01T00:00:00Z')",
        )
        .run(),
    ).rejects.toThrow();
    await mdb
      .prepare(
        "INSERT INTO sync_state (division_id, entity, cursor) VALUES (9, 'run', '18446744073709551615')",
      )
      .run();
    await expect(
      mdb
        .prepare(
          "INSERT INTO sync_state (division_id, entity, cursor) VALUES (9, 'relations', '12x')",
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      mdb.prepare("INSERT INTO sync_state (division_id, entity) VALUES (9, 'run')").run(),
    ).rejects.toThrow();
    await expect(
      mdb.prepare("INSERT INTO sync_state (division_id, entity) VALUES (9, 'nonsense')").run(),
    ).rejects.toThrow();
  });
});
