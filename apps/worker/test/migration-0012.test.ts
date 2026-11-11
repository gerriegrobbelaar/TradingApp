import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0012 rebuilds `connections` so that creates_bank_entries defaults to 0 for new rows
 * (review S11). On a populated database every connection keeps every column, and the tables that
 * reference connections keep their rows and foreign keys.
 */
describe("migration 0012 on a populated database", () => {
  it("keeps existing values, children and keys; new rows default to 0", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0012"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        `INSERT INTO connections (id, kind, name, status, creates_bank_entries, access_token_enc,
           refresh_token_enc, region_host, connected_by, exact_identity, last_error)
         VALUES (5, 'exact', 'exact', 'active', 1, 'v1.k.iv.ct', 'v1.k.iv.rt', 'start.exactonline.be',
           'a@b.c', 'cust-1', 'x')`,
      ),
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status, creates_bank_entries) VALUES (6, 'revolut', 'rev', 'pending', 0)",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (9, 5, 123, 'First')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (10, 5, 124, 'Second')",
      ),
    ]);
    const snapshot = async (): Promise<unknown> =>
      (
        await mdb
          .prepare(
            `SELECT id, kind, name, status, creates_bank_entries, access_token_enc, refresh_token_enc,
               region_host, connected_by, exact_identity, last_error, created_at
             FROM connections ORDER BY id`,
          )
          .all()
      ).results;
    const before = await snapshot();

    await applyD1Migrations(mdb, all);

    expect(await snapshot()).toEqual(before);
    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM divisions").first<{ n: number }>())?.n,
    ).toBe(2);

    // A new row without the column gets 0; the CHECK still holds.
    await mdb.prepare("INSERT INTO connections (kind, name) VALUES ('revolut', 'rev2')").run();
    expect(
      (
        await mdb
          .prepare("SELECT creates_bank_entries AS v FROM connections WHERE name = 'rev2'")
          .first<{ v: number }>()
      )?.v,
    ).toBe(0);
    await expect(
      mdb
        .prepare(
          "INSERT INTO connections (kind, name, creates_bank_entries) VALUES ('exact', 'z', 2)",
        )
        .run(),
    ).rejects.toThrow();
    // The unique key and the kind check survived the rebuild.
    await expect(
      mdb.prepare("INSERT INTO connections (kind, name) VALUES ('exact', 'exact')").run(),
    ).rejects.toThrow();
    // Children still reference the rebuilt table.
    await expect(
      mdb
        .prepare(
          "INSERT INTO divisions (connection_id, exact_division, name) VALUES (999, 1, 'orphan')",
        )
        .run(),
    ).rejects.toThrow();
  });
});
