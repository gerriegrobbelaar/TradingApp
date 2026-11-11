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
      mdb.prepare(
        `INSERT INTO bank_accounts (id, connection_id, division_id, external_id, name, currency)
         VALUES (3, 6, 9, 'acc-1', 'Main', 'EUR')`,
      ),
      mdb.prepare(
        `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, state,
           amount_minor, currency, booked_at)
         VALUES (6, 3, 'tx-1', 'completed', -1250, 'EUR', '2026-01-01T00:00:00.000Z')`,
      ),
    ]);
    const columns = async () =>
      (
        await mdb
          .prepare(
            "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('connections')",
          )
          .all<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
          }>()
      ).results;
    const colsBefore = await columns();
    const seqBefore = await mdb
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'connections'")
      .first<{ seq: number }>();
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
    // every child of connections keeps its rows (no cascade fired on the drop)
    for (const t of ["bank_accounts", "bank_transactions"]) {
      expect(
        (await mdb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n,
        t,
      ).toBe(1);
    }
    // same columns in the same order with the same types and keys; only the one default moved
    const colsAfter = await columns();
    expect(colsAfter.map((c) => c.name)).toEqual(colsBefore.map((c) => c.name));
    expect(colsAfter.map((c) => c.name)).toContain("exact_identity");
    for (const [i, c] of colsAfter.entries()) {
      const b = colsBefore[i];
      expect({ ...c, dflt_value: null }, c.name).toEqual({ ...b, dflt_value: null });
      if (c.name === "creates_bank_entries") {
        expect(b?.dflt_value).toBe("1");
        expect(c.dflt_value).toBe("0");
      } else {
        expect(c.dflt_value, c.name).toBe(b?.dflt_value ?? null);
      }
    }
    // no copy table left behind; no index or trigger was lost (there were none but the unique key)
    expect(
      await mdb
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'connections_0012%'")
        .first(),
    ).toBeNull();
    expect(
      (
        await mdb
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE tbl_name = 'connections' AND type IN ('index', 'trigger') ORDER BY name",
          )
          .all<{ type: string; name: string }>()
      ).results.map((r) => r.type),
    ).toEqual(["index"]);
    // AUTOINCREMENT carries on from the highest kept id
    expect(seqBefore?.seq).toBe(6);

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
