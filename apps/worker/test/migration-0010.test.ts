import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0010 adds the ledger tables and one nullable sync_state column. On a database that
 * already holds divisions, sync state and open items (as a deployed Phase 3/4 database would) it
 * must keep every row, leave the foreign keys intact and enforce its own constraints.
 */
describe("migration 0010 on a populated database", () => {
  it("keeps existing rows, adds the ledger tables and enforces their keys", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0010"));
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
        `INSERT INTO sync_state (division_id, entity, cursor, mode, last_status, last_completed_at,
           rows_seen, pass_cycle, pass_token, done_cycle)
         VALUES (9, 'receivables', '0', 'full', 'ok', '2026-01-02T01:00:00Z', 40, 7, 'tok', 7)`,
      ),
      mdb.prepare(
        `INSERT INTO sync_state (division_id, entity, cursor, mode, last_status, retry_count)
         VALUES (9, 'run', '0', 'full', 'ok', 2)`,
      ),
      ...Array.from({ length: 50 }, (_, i) =>
        mdb
          .prepare(
            `INSERT INTO open_items (division_id, exact_id, kind, currency, amount_minor, open_minor,
               status, synced_at) VALUES (9, ?1, 'invoice', 'EUR', ?2, ?2, 'open', '2026-01-01T00:00:00Z')`,
          )
          .bind(`item-${i}`, i * 11),
      ),
    ]);
    const snapshot = async (): Promise<unknown> =>
      (
        await mdb
          .prepare(
            `SELECT 'oi' AS t, exact_id AS k, open_minor AS v FROM open_items
             UNION ALL SELECT 'ss', entity, retry_count FROM sync_state
             UNION ALL SELECT 'dv', name, id FROM divisions ORDER BY 1, 2`,
          )
          .all()
      ).results;
    const before = await snapshot();

    await applyD1Migrations(mdb, all);

    expect(await snapshot()).toEqual(before);
    const st = await mdb
      .prepare(
        "SELECT pass_token, done_cycle, unavailable_until FROM sync_state WHERE entity = 'receivables'",
      )
      .first();
    expect(st).toEqual({ pass_token: "tok", done_cycle: 7, unavailable_until: null });
    const tables = (
      await mdb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gl_%' ORDER BY name",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(tables).toEqual(["gl_accounts", "gl_balances", "gl_budgets", "gl_sync_years"]);
    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const indexes = (
      await mdb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_gl_%'")
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(indexes.sort()).toEqual([
      "idx_gl_accounts_code",
      "idx_gl_balances_year",
      "idx_gl_budgets_year",
    ]);

    // Keys, checks and foreign keys of the new tables.
    const account = (exact: string, over = ""): string =>
      `INSERT INTO gl_accounts (division_id, exact_id, code, name, ${over ? "balance_type," : ""} updated_at)
       VALUES (9, '${exact}', '1000', 'Bank', ${over ? `'${over}',` : ""} '2026-01-01T00:00:00Z')`;
    await mdb.prepare(account("a1")).run();
    await expect(mdb.prepare(account("a1")).run()).rejects.toThrow(); // unique (division, exact id)
    await mdb.prepare(account("a1").replace("(9,", "(10,")).run(); // another division may reuse it
    await expect(mdb.prepare(account("a2", "X")).run()).rejects.toThrow(); // 'B' or 'W' only
    await expect(mdb.prepare(account("a3").replace("(9,", "(404,")).run()).rejects.toThrow(); // foreign key to divisions
    const bal = (period: number, dimension = ""): string =>
      `INSERT INTO gl_balances (division_id, gl_account_exact_id, year, period, dimension, amount_minor,
         currency, updated_at) VALUES (9, 'a1', 2026, ${period}, '${dimension}', -150, 'EUR', '2026-01-01T00:00:00Z')`;
    await mdb.prepare(bal(1)).run();
    await expect(mdb.prepare(bal(1)).run()).rejects.toThrow(); // unique per period and dimension
    await mdb.prepare(bal(1, "20|CC1")).run();
    await expect(mdb.prepare(bal(100)).run()).rejects.toThrow(); // period 0..99
    await expect(mdb.prepare(bal(2).replace("'EUR'", "'eur'")).run()).rejects.toThrow(); // upper-case ISO code
    const saved = await mdb
      .prepare("SELECT amount_minor FROM gl_balances WHERE period = 1 AND dimension = ''")
      .first();
    expect(saved).toEqual({ amount_minor: -150 });
    await mdb
      .prepare(
        `INSERT INTO gl_budgets (division_id, gl_account_exact_id, year, period, scenario, amount_minor,
           currency, updated_at) VALUES (9, 'a1', 2026, 1, '', 500, 'EUR', '2026-01-01T00:00:00Z')`,
      )
      .run();
    await expect(
      mdb
        .prepare(
          `INSERT INTO gl_budgets (division_id, gl_account_exact_id, year, period, scenario, amount_minor,
             currency, updated_at) VALUES (9, 'a1', 2026, 1, '', 600, 'EUR', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).rejects.toThrow();
  });
});
