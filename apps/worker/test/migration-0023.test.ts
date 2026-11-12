import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkMatchingInvariants } from "../src/matching/invariants";

/**
 * Migration 0023 (booking outbox, ADR 0044) on a populated database: the matches and allocations
 * written under 0022 are untouched, the new columns start empty, the outbox and the guards work.
 */
describe("migration 0023 on a populated database", () => {
  it("keeps every row, adds columns, the outbox and the guards", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0023"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (1, 'exact', 'exact', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (2, 'revolut', 'revolut', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name, sync_enabled) VALUES (1, 1, 123, 'BV', 1)",
      ),
      mdb.prepare(
        "INSERT INTO bank_accounts (id, connection_id, external_id, name, currency) VALUES (1, 2, 'a', 'EUR', 'EUR')",
      ),
      mdb.prepare(
        `INSERT INTO bank_account_exact_map (bank_account_id, division_id, journal_code, bank_gl_account_code,
           created_by, updated_by) VALUES (1, 1, '90', '1210', 'a', 'a')`,
      ),
      mdb.prepare(
        `INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, state, amount_minor, currency,
           booked_at, created_at, match_status)
         VALUES (1, 2, 1, 't1', 'completed', 1000, 'EUR', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'unmatched'),
                (2, 2, 1, 't2', 'completed', 700, 'EUR', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'unmatched')`,
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, stored_minor, open_minor, synced_at)
         VALUES (1, 1, 'i1', 'invoice', 'EUR', 1000, 1000, '2026-07-01T00:00:00Z'),
                (2, 1, 'i2', 'invoice', 'EUR', 700, 700, '2026-07-01T00:00:00Z')`,
      ),
      mdb.prepare(
        `INSERT INTO matches (id, bank_transaction_id, division_id, source, amount_minor, currency, created_by)
         VALUES (1, 1, 1, 'manual', 1000, 'EUR', 'a@b.com')`,
      ),
      mdb.prepare(
        "INSERT INTO match_allocations (match_id, open_item_id, allocated_minor, currency) VALUES (1, 1, 1000, 'EUR')",
      ),
      mdb.prepare("UPDATE bank_transactions SET match_status = 'matched' WHERE id = 1"),
      mdb.prepare("INSERT INTO settings (key, value_json) VALUES ('keep.me', '1')"),
    ]);
    const before = (
      await mdb.prepare("SELECT * FROM matches ORDER BY id").all<Record<string, unknown>>()
    ).results;

    await applyD1Migrations(mdb, all.slice(idx, idx + 1)); // this migration only (later ones have their own test)

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const after = (
      await mdb.prepare("SELECT * FROM matches ORDER BY id").all<Record<string, unknown>>()
    ).results;
    expect(after).toHaveLength(1);
    const { booked_at, exact_note, ...rest } = after[0] ?? {};
    expect([booked_at, exact_note]).toEqual([null, null]);
    expect(rest).toEqual(before[0]);
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM match_allocations").first<{ n: number }>())?.n,
    ).toBe(1);
    expect(
      (await mdb.prepare("SELECT value_json FROM settings WHERE key = 'keep.me'").first())?.[
        "value_json"
      ],
    ).toBe("1");
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM exact_write_outbox").first<{ n: number }>())?.n,
    ).toBe(0);

    const mapCols = (
      await mdb.prepare("PRAGMA table_info(bank_account_exact_map)").all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(mapCols).toEqual(
      expect.arrayContaining(["receivable_gl_account_code", "payable_gl_account_code"]),
    );

    // The outbox only takes rows of a claimed live match, once per (match, kind), with a unique key.
    const insert = (matchId: number, kind: string, key: string): Promise<unknown> =>
      mdb
        .prepare(
          `INSERT INTO exact_write_outbox (match_id, division_id, kind, idempotency_key, payload_json, payload_hash,
             created_at, updated_at) VALUES (?1, 1, ?2, ?3, '{}', ?4, 'x', 'x')`,
        )
        .bind(matchId, kind, key, "h".repeat(64))
        .run();
    const key = (c: string): string => c.repeat(64);
    await expect(insert(1, "bank_entry", key("a"))).rejects.toThrow(/not_claimed/);
    await mdb.prepare("UPDATE matches SET exact_state = 'booking' WHERE id = 1").run();
    await insert(1, "bank_entry", key("a"));
    await expect(insert(1, "bank_entry", key("b"))).rejects.toThrow(/UNIQUE/);
    await expect(insert(1, "matchset", key("a"))).rejects.toThrow(/UNIQUE/);
    await expect(insert(1, "anything", key("c"))).rejects.toThrow(/CHECK/);
    await insert(1, "matchset", key("c"));
    // A finished row never changes again.
    await mdb
      .prepare(
        "UPDATE exact_write_outbox SET status = 'verified' WHERE match_id = 1 AND kind = 'matchset'",
      )
      .run();
    await expect(
      mdb
        .prepare(
          "UPDATE exact_write_outbox SET status = 'pending' WHERE match_id = 1 AND kind = 'matchset'",
        )
        .run(),
    ).rejects.toThrow(/terminal/);
    await expect(
      mdb
        .prepare(
          "UPDATE exact_write_outbox SET status = 'bogus' WHERE match_id = 1 AND kind = 'bank_entry'",
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
    // The invariant checks read the CURRENT schema (0025 added match_allocations.open_before_minor):
    // apply the later migrations, then the migrated data must still be consistent.
    await applyD1Migrations(mdb, all.slice(idx + 1));
    expect(await checkMatchingInvariants(mdb)).toEqual([]);
  });
});
