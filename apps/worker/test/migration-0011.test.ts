import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0011 adds the purchase_entries table. On a database that already holds divisions,
 * sync state, open items and ledger rows (as a deployed Phase 4 database would) it must keep every
 * row, leave the foreign keys intact and enforce its own constraints.
 */
describe("migration 0011 on a populated database", () => {
  it("keeps existing rows, adds the table and enforces its keys", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0011"));
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
      mdb.prepare(
        `INSERT INTO sync_state (division_id, entity, cursor, mode, last_status, rows_seen,
           pass_seq, pass_started_at, unavailable_until)
         VALUES (9, 'gl_budgets', '0', 'full', 'ok', 40, 3, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
      ),
      mdb.prepare(
        `INSERT INTO gl_accounts (division_id, exact_id, name, updated_at)
         VALUES (9, 'a1', 'Bank', '2026-01-01T00:00:00Z')`,
      ),
      ...Array.from({ length: 50 }, (_, i) =>
        mdb
          .prepare(
            `INSERT INTO open_items (division_id, exact_id, kind, currency, amount_minor, open_minor,
               status, synced_at) VALUES (9, ?1, 'bill', 'EUR', ?2, ?2, 'open', '2026-01-01T00:00:00Z')`,
          )
          .bind(`item-${i}`, i * 11),
      ),
    ]);
    const snapshot = async (): Promise<unknown> =>
      (
        await mdb
          .prepare(
            `SELECT 'oi' AS t, exact_id AS k, open_minor AS v FROM open_items
             UNION ALL SELECT 'ss', entity, pass_seq FROM sync_state
             UNION ALL SELECT 'gl', exact_id, id FROM gl_accounts
             UNION ALL SELECT 'dv', name, id FROM divisions ORDER BY 1, 2`,
          )
          .all()
      ).results;
    const before = await snapshot();

    await applyD1Migrations(mdb, all);

    expect(await snapshot()).toEqual(before);
    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM purchase_entries").first<{ n: number }>())?.n,
    ).toBe(0);
    const indexes = (
      await mdb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_purchase_%'",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(indexes.sort()).toEqual([
      "idx_purchase_entries_list",
      "idx_purchase_entries_list_all",
      "idx_purchase_entries_relation",
    ]);

    const entry = (exact: string, over: Record<string, string> = {}, division = 9): string => {
      const v = { currency: "'EUR'", status: "'pending_approval'", ...over };
      return `INSERT INTO purchase_entries (division_id, exact_id, currency, amount_minor, status,
        ${over["extraCol"] ? "has_pdf," : ""} synced_at)
        VALUES (${division}, '${exact}', ${v.currency}, 12150, ${v.status},
        ${over["extraCol"] ? `${over["extraCol"]},` : ""} '2026-01-01T00:00:00Z')`;
    };
    await mdb.prepare(entry("e1")).run();
    await expect(mdb.prepare(entry("e1")).run()).rejects.toThrow(); // unique (division, exact id)
    await mdb.prepare(entry("e1", {}, 10)).run(); // another division may reuse it
    await expect(mdb.prepare(entry("e2", {}, 404)).run()).rejects.toThrow(); // foreign key to divisions
    await expect(mdb.prepare(entry("e3", { currency: "'eur'" })).run()).rejects.toThrow();
    await expect(mdb.prepare(entry("e4", { status: "'approvedish'" })).run()).rejects.toThrow();
    await expect(mdb.prepare(entry("e5", { extraCol: "2" })).run()).rejects.toThrow(); // has_pdf 0, 1 or NULL
    // 'approved' without a raw status code cannot be stored, and the default is 'unknown'
    await expect(mdb.prepare(entry("e6", { status: "'approved'" })).run()).rejects.toThrow();
    await mdb
      .prepare(
        `INSERT INTO purchase_entries (division_id, exact_id, currency, amount_minor, status_code,
           synced_at) VALUES (9, 'e7', 'EUR', 1, 50, '2026-01-01T00:00:00Z')`,
      )
      .run();
    expect(
      await mdb
        .prepare("SELECT status FROM purchase_entries WHERE exact_id = 'e7'")
        .first("status"),
    ).toBe("unknown");
    await mdb.prepare("DELETE FROM purchase_entries WHERE exact_id = 'e7'").run();
    const saved = await mdb
      .prepare(
        "SELECT amount_minor, has_pdf, missed_cycles, status_code FROM purchase_entries WHERE division_id = 9",
      )
      .first();
    expect(saved).toEqual({
      amount_minor: 12150,
      has_pdf: null,
      missed_cycles: 0,
      status_code: null,
    });
    // a division cannot be deleted while it has purchase entries
    await expect(mdb.prepare("DELETE FROM divisions WHERE id = 9").run()).rejects.toThrow();
  });
});
