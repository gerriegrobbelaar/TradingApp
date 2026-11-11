import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0019 adds fx_rate_conflicts and copies the existing `fx.rate_conflict` audit rows into
 * it as unresolved. It runs on a database that already holds rates and audit rows.
 */
describe("migration 0019 on a populated database", () => {
  it("keeps every rate, backfills conflicts from the audit log, enforces the table rules", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0019"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    const audit = (id: string | null, after: string | null, at: string) =>
      mdb
        .prepare(
          `INSERT INTO audit_log (at, actor_email, action, entity, entity_id, after_json)
           VALUES (?1, 'system', 'fx.rate_conflict', 'fx_rate', ?2, ?3)`,
        )
        .bind(at, id, after);
    await mdb.batch([
      mdb.prepare(
        "INSERT INTO fx_rates (currency, rate_date, rate) VALUES ('USD', '2026-10-30', '1.1650'), ('JPY', '2026-10-30', '170.25')",
      ),
      audit("USD@2026-10-30", '{"stored":"1.165","ecb":"1.17"}', "2026-11-02T16:00:00.000Z"),
      // the same ECB value audited twice (stored changed in between): one row, oldest time
      audit("USD@2026-10-30", '{"stored":"1.2","ecb":"1.17"}', "2026-11-05T16:00:00.000Z"),
      audit("JPY@2026-10-30", '{"stored":"170.25","ecb":"171"}', "2026-11-03T16:00:00.000Z"),
      // rows that are not usable are ignored
      audit(null, '{"stored":"1","ecb":"2"}', "2026-11-03T16:00:00.000Z"),
      audit("usd@2026-10-30", '{"stored":"1","ecb":"2"}', "2026-11-03T16:00:00.000Z"),
      audit("GBP@2026-10-30", '{"stored":"1"}', "2026-11-03T16:00:00.000Z"),
      audit("GBP@2026-10-30", null, "2026-11-03T16:00:00.000Z"),
    ]);
    const rates = (await mdb.prepare("SELECT * FROM fx_rates ORDER BY currency").all()).results;

    await applyD1Migrations(mdb, all);

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await mdb.prepare("SELECT * FROM fx_rates ORDER BY currency").all()).results).toEqual(
      rates,
    );
    const rows = (
      await mdb
        .prepare(
          `SELECT currency, rate_date, stored_rate, ecb_rate, first_seen_at, resolved_at,
                  resolved_by, resolution
           FROM fx_rate_conflicts ORDER BY currency`,
        )
        .all()
    ).results;
    expect(rows).toEqual([
      {
        currency: "JPY",
        rate_date: "2026-10-30",
        stored_rate: "170.25",
        ecb_rate: "171",
        first_seen_at: "2026-11-03T16:00:00.000Z",
        resolved_at: null,
        resolved_by: null,
        resolution: null,
      },
      {
        currency: "USD",
        rate_date: "2026-10-30",
        stored_rate: "1.165",
        ecb_rate: "1.17",
        first_seen_at: "2026-11-02T16:00:00.000Z",
        resolved_at: null,
        resolved_by: null,
        resolution: null,
      },
    ]);

    // table rules: unique per (currency, date, ECB value); resolution columns move together
    await expect(
      mdb
        .prepare(
          `INSERT INTO fx_rate_conflicts (currency, rate_date, stored_rate, ecb_rate)
           VALUES ('USD', '2026-10-30', '1.1', '1.17')`,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      mdb
        .prepare(
          `INSERT INTO fx_rate_conflicts (currency, rate_date, stored_rate, ecb_rate, resolved_at)
           VALUES ('USD', '2026-10-31', '1.1', '1.17', '2026-11-06T10:00:00.000Z')`,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      mdb
        .prepare(
          `INSERT INTO fx_rate_conflicts (currency, rate_date, stored_rate, ecb_rate, resolved_at,
             resolved_by, resolution)
           VALUES ('USD', '2026-10-31', '1.1', '1.18', '2026-11-06T10:00:00.000Z', 'a@b.c', 'maybe')`,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      mdb
        .prepare(
          `INSERT INTO fx_rate_conflicts (currency, rate_date, stored_rate, ecb_rate)
           VALUES ('usd', '2026-10-31', '1.1', '1.18')`,
        )
        .run(),
    ).rejects.toThrow();
  });
});
