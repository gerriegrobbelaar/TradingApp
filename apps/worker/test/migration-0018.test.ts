import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0018 adds fx_import_state and an index on fx_rates. It runs on a database that already
 * holds rates (and an audit row), as a deployed database would, and checks nothing else moved.
 */
describe("migration 0018 on a populated database", () => {
  it("keeps every rate, adds the single state row and the date index", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0018"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO fx_rates (currency, rate_date, rate, source, fetched_at) VALUES ('USD', '2026-11-09', '1.0900', 'ECB', '2026-11-09T15:20:00.000Z')",
      ),
      mdb.prepare(
        "INSERT INTO fx_rates (currency, rate_date, rate) VALUES ('USD', '2026-11-10', '1.1650'), ('JPY', '2026-11-10', '170.25')",
      ),
      mdb.prepare(
        "INSERT INTO audit_log (actor_email, action, entity) VALUES ('system', 'job.seed_defaults', 'job')",
      ),
    ]);
    const before = (await mdb.prepare("SELECT * FROM fx_rates ORDER BY currency, rate_date").all())
      .results;
    expect(before).toHaveLength(3);

    await applyD1Migrations(mdb, all);

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (await mdb.prepare("SELECT * FROM fx_rates ORDER BY currency, rate_date").all()).results,
    ).toEqual(before);
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())?.n,
    ).toBe(1);

    const state = await mdb.prepare("SELECT * FROM fx_import_state").all();
    expect(state.results).toEqual([
      {
        id: 1,
        last_attempt_at: null,
        last_success_at: null,
        last_status: null,
        last_error_code: null,
        newest_rate_date: null,
        rows_inserted: 0,
      },
    ]);
    // A second row is refused (single-row table).
    await expect(
      mdb.prepare("INSERT INTO fx_import_state (id) VALUES (2)").run(),
    ).rejects.toThrow();

    const indexes = (
      await mdb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'fx_rates'")
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(indexes).toContain("idx_fx_rates_date");

    // The 0003 constraints still hold: lowercase currency, a float-looking rate and a duplicate.
    for (const [c, d, r] of [
      ["usd", "2026-11-11", "1.1"],
      ["USD", "2026-11-11", "1e3"],
      ["USD", "2026-11-10", "9.9"],
    ] as const) {
      await expect(
        mdb
          .prepare("INSERT INTO fx_rates (currency, rate_date, rate) VALUES (?1, ?2, ?3)")
          .bind(c, d, r)
          .run(),
      ).rejects.toThrow();
    }
  });
});
