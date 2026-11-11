import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migrations 0020 (open_items.dc_source, ADR 0038) and 0021 (fx_import_state backfill columns,
 * ADR 0036 addendum) on a populated database: every stored booked amount came from the sync read
 * before 0020, so it is marked 'sync'; nothing else moves.
 */
describe("migrations 0020 and 0021 on a populated database", () => {
  it("marks existing booked amounts as read by the sync, keeps every row, adds the columns", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0020"));
    expect(idx).toBeGreaterThan(0);
    expect(all[idx + 1]?.name.startsWith("0021")).toBe(true);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare("INSERT INTO connections (id, kind, name) VALUES (3, 'exact', 'exact')"),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (1, 3, 123, 'BV')",
      ),
      mdb.prepare(
        `INSERT INTO open_items (division_id, exact_id, kind, currency, stored_minor, open_minor,
           synced_at, open_dc_minor, dc_currency, rate)
         VALUES (1, 'a', 'invoice', 'USD', 100000, 100000, '2026-11-01T00:00:00Z', 92000, 'EUR', '0.92'),
                (1, 'b', 'invoice', 'USD', 100000, 40000, '2026-11-01T00:00:00Z', NULL, NULL, '0.92'),
                (1, 'c', 'bill', 'EUR', 5000, 5000, '2026-11-01T00:00:00Z', 5000, 'EUR', NULL)`,
      ),
      mdb.prepare(
        "UPDATE fx_import_state SET last_status = 'ok', newest_rate_date = '2026-11-10' WHERE id = 1",
      ),
    ]);
    const before = (
      await mdb.prepare("SELECT * FROM open_items ORDER BY exact_id").all<Record<string, unknown>>()
    ).results;

    await applyD1Migrations(mdb, all);

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const after = (
      await mdb.prepare("SELECT * FROM open_items ORDER BY exact_id").all<Record<string, unknown>>()
    ).results;
    expect(after.map(({ dc_source, ...rest }) => ({ rest, dc_source }))).toEqual(
      before.map((rest, i) => ({ rest, dc_source: ["sync", null, "sync"][i] })),
    );
    await expect(
      mdb.prepare("UPDATE open_items SET dc_source = 'guess' WHERE exact_id = 'a'").run(),
    ).rejects.toThrow();

    expect(
      await mdb
        .prepare(
          "SELECT last_status, newest_rate_date, backfill_target, backfill_cursor FROM fx_import_state",
        )
        .first(),
    ).toEqual({
      last_status: "ok",
      newest_rate_date: "2026-11-10",
      backfill_target: null,
      backfill_cursor: null,
    });
  });
});
