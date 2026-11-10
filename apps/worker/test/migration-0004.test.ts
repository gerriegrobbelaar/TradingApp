import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0004 rebuilds `connections` (SQLite cannot alter a CHECK). This runs it against a
 * database that already has rows in `connections` and in the tables that reference it, the way a
 * deployed Phase 1 database would, and checks nothing is lost and every reference still holds.
 */
describe("migration 0004 on a database with existing rows", () => {
  it("keeps connections, ids and child rows, and foreign keys still hold", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0004"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status, token_ref, expires_at, creates_bank_entries, created_at) VALUES (3, 'exact', 'exact', 'active', 'ref', '2026-01-01T00:00:00Z', 1, '2025-12-01T00:00:00Z')",
      ),
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status, creates_bank_entries) VALUES (7, 'revolut', 'main', 'disabled', 0)",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (1, 3, 123, 'BV')",
      ),
      mdb.prepare(
        "INSERT INTO bank_accounts (id, connection_id, external_id, name, currency) VALUES (1, 7, 'a', 'EUR', 'EUR')",
      ),
      mdb.prepare(
        "INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, state, amount_minor, currency, booked_at) VALUES (1, 7, 1, 'tx1', 'completed', 1250, 'EUR', '2026-01-01T00:00:00Z')",
      ),
    ]);

    await applyD1Migrations(mdb, all);

    const conns = await mdb
      .prepare(
        "SELECT id, kind, name, status, token_ref, expires_at, creates_bank_entries, created_at, region_host, access_token_enc FROM connections ORDER BY id",
      )
      .all();
    expect(conns.results).toEqual([
      {
        id: 3,
        kind: "exact",
        name: "exact",
        status: "active",
        token_ref: "ref",
        expires_at: "2026-01-01T00:00:00Z",
        creates_bank_entries: 1,
        created_at: "2025-12-01T00:00:00Z",
        region_host: "start.exactonline.nl",
        access_token_enc: null,
      },
      {
        id: 7,
        kind: "revolut",
        name: "main",
        status: "disabled",
        token_ref: null,
        expires_at: null,
        creates_bank_entries: 0,
        created_at: expect.any(String) as string,
        region_host: "start.exactonline.nl",
        access_token_enc: null,
      },
    ]);

    // Children still there and their references resolve.
    expect(await mdb.prepare("SELECT COUNT(*) AS n FROM divisions").first("n")).toBe(1);
    expect(await mdb.prepare("SELECT COUNT(*) AS n FROM bank_transactions").first("n")).toBe(1);
    const fk = await mdb.prepare("PRAGMA foreign_key_check").all();
    expect(fk.results).toEqual([]);
    // Child tables now reference the rebuilt table (by name), not a dropped one.
    const ddl = await mdb
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name IN ('divisions','bank_accounts','bank_transactions')",
      )
      .all<{ sql: string }>();
    for (const r of ddl.results) {
      expect(r.sql).toContain("REFERENCES connections");
      expect(r.sql).not.toContain("connections_new");
    }

    // New constraints work: needs_reauth allowed, unknown status refused, (kind,name) unique.
    await mdb.prepare("UPDATE connections SET status = 'needs_reauth' WHERE id = 3").run();
    await expect(
      mdb.prepare("UPDATE connections SET status = 'bogus' WHERE id = 3").run(),
    ).rejects.toThrow();
    await expect(
      mdb.prepare("INSERT INTO connections (kind, name) VALUES ('exact', 'exact')").run(),
    ).rejects.toThrow();
    // A child row pointing at a missing connection is still refused.
    await expect(
      mdb
        .prepare("INSERT INTO divisions (connection_id, exact_division, name) VALUES (999, 1, 'x')")
        .run(),
    ).rejects.toThrow();
    // AUTOINCREMENT continues after the highest kept id.
    const r = await mdb
      .prepare("INSERT INTO connections (kind, name) VALUES ('revolut', 'b')")
      .run();
    expect(r.meta.last_row_id).toBeGreaterThan(7);
  });
});
