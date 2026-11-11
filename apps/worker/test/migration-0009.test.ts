import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildListQuery } from "../src/read/queries";

/**
 * Migration 0009 adds the list indexes and the `search_text` column. On a database that already
 * holds open items (as a deployed Phase 3 database would) it must keep every row and the status
 * triggers, leave `search_text` NULL for the read API to fill, and the list query must use the new
 * expression index straight away.
 */
describe("migration 0009 on a populated database", () => {
  it("keeps rows and triggers, adds the indexes, leaves search text to be filled", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0009"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (5, 'exact', 'exact', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (9, 5, 123, 'First')",
      ),
      ...Array.from({ length: 300 }, (_, i) =>
        mdb
          .prepare(
            `INSERT INTO open_items (division_id, exact_id, kind, currency, amount_minor, open_minor,
               status, synced_at, due_date, invoice_number)
             VALUES (9, ?1, ?2, 'EUR', ?3, ?3, ?4, '2026-01-01T00:00:00Z', ?5, ?6)`,
          )
          .bind(
            `item-${i}`,
            i % 3 === 0 ? "bill" : "invoice",
            i * 7 - 50,
            i % 5 === 0 ? "closed" : "open",
            i % 11 === 0 ? null : `2026-0${(i % 9) + 1}-1${i % 10}`,
            `INV-${i}`,
          ),
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
    const before = (
      await mdb
        .prepare("SELECT id, kind, status, open_minor, due_date FROM open_items ORDER BY id")
        .all()
    ).results;

    // Up to 0022: the matching rebuild (0022) has its own test and replaces match_* tables and triggers.
    await applyD1Migrations(
      mdb,
      all.filter((m) => m.name < "0022"),
    );

    expect(await objects("trigger")).toEqual(triggersBefore);
    const after = (
      await mdb
        .prepare("SELECT id, kind, status, open_minor, due_date FROM open_items ORDER BY id")
        .all()
    ).results;
    expect(after).toEqual(before);
    const pending = await mdb
      .prepare("SELECT COUNT(*) AS n FROM open_items WHERE search_text IS NULL")
      .first<{ n: number }>();
    expect(pending?.n).toBe(300);
    const names = (await objects("index")).map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "idx_open_items_list",
        "idx_open_items_list_all",
        "idx_open_items_relation",
        "idx_open_items_search_pending",
      ]),
    );
    // The status rules still hold.
    await expect(
      mdb.prepare("UPDATE open_items SET status = 'paid' WHERE id = 1").run(),
    ).rejects.toThrow();

    const q = buildListQuery(
      {
        divisionId: 9,
        kind: "invoice",
        status: "open",
        asOf: "2026-06-30",
        overdue: false,
        currency: null,
        relationId: null,
        dueBefore: null,
        dueAfter: null,
        noDueDate: false,
        search: [],
      },
      "asc",
      null,
      1000,
    );
    const plan = (
      await mdb
        .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
        .bind(...q.binds)
        .all<{ detail: string }>()
    ).results
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_open_items_list\b/);
    const rows = (
      await mdb
        .prepare(q.sql)
        .bind(...q.binds)
        .all<{ id: number }>()
    ).results;
    const want = (
      await mdb
        .prepare(
          `SELECT id FROM open_items WHERE division_id = 9 AND kind = 'invoice' AND status = 'open'
           ORDER BY COALESCE(due_date, '9999-12-31'), id`,
        )
        .all<{ id: number }>()
    ).results;
    expect(rows.map((r) => r.id)).toEqual(want.map((r) => r.id));
    expect(rows.length).toBeGreaterThan(100);
  });
});
