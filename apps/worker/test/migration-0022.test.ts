import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0022 (bank matching data model, ADR 0042) on a populated database: matches and
 * match_suggestions are rebuilt (copy-aside), old rows are converted, nothing else moves, foreign
 * keys hold, and the guards (triggers, partial UNIQUE) work afterwards.
 */
describe("migration 0022 on a populated database", () => {
  it("converts old matches into matches + allocations, drops old suggestions, keeps the rest", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0022"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare("INSERT INTO connections (id, kind, name) VALUES (1, 'exact', 'exact')"),
      mdb.prepare("INSERT INTO connections (id, kind, name) VALUES (2, 'revolut', 'revolut')"),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (1, 1, 123, 'BV')",
      ),
      mdb.prepare(
        "INSERT INTO bank_accounts (id, connection_id, external_id, name, currency) VALUES (1, 2, 'a', 'EUR', 'EUR')",
      ),
      mdb.prepare(
        `INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, state, amount_minor,
           currency, booked_at, created_at, match_status)
         VALUES (1, 2, 1, 't1', 'completed', 1000, 'EUR', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'matched'),
                (2, 2, 1, 't2', 'completed', -500, 'EUR', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'matched'),
                (3, 2, 1, 't3', 'completed', 700, 'EUR', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'unmatched'),
                (4, 2, 1, 't4', 'completed', 100, 'EUR', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'unmatched')`,
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, stored_minor, open_minor, synced_at)
         VALUES (1, 1, 'i1', 'invoice', 'EUR', 1000, 1000, '2026-07-01T00:00:00Z'),
                (2, 1, 'i2', 'invoice', 'EUR', 700, 700, '2026-07-01T00:00:00Z')`,
      ),
      // tx 1: one live match to item 1. tx 2: ledger match (no item; its division comes from the
      // account, which has none) -> not carried over. tx 3: a live and a later live row (duplicate)
      // plus an undone one.
      mdb.prepare(
        `INSERT INTO matches (id, bank_transaction_id, open_item_id, ledger_account, amount_minor, currency,
           mode, score, matched_by, matched_at)
         VALUES (1, 1, 1, NULL, 1000, 'EUR', 'auto', 99, 'system', '2026-07-02T00:00:00Z'),
                (2, 2, NULL, '4500', -500, 'EUR', 'manual', NULL, 'a@b.com', '2026-07-02T00:00:00Z'),
                (3, 3, 2, NULL, 700, 'EUR', 'manual', NULL, 'a@b.com', '2026-07-02T00:00:00Z'),
                (4, 3, 1, NULL, 700, 'EUR', 'manual', NULL, 'b@b.com', '2026-07-03T00:00:00Z')`,
      ),
      mdb.prepare(
        `INSERT INTO matches (id, bank_transaction_id, open_item_id, amount_minor, currency, mode, matched_by,
           matched_at, undone_at, undone_by)
         VALUES (5, 4, 2, 100, 'EUR', 'manual', 'a@b.com', '2026-07-02T00:00:00Z', '2026-07-03T00:00:00Z', 'a@b.com')`,
      ),
      mdb.prepare(
        "INSERT INTO match_suggestions (bank_transaction_id, open_item_id, score, reason) VALUES (4, 2, 60, 'amount')",
      ),
      mdb.prepare("INSERT INTO settings (key, value_json) VALUES ('keep.me', '1')"),
    ]);
    const txBefore = (
      await mdb
        .prepare("SELECT * FROM bank_transactions ORDER BY id")
        .all<Record<string, unknown>>()
    ).results;

    await applyD1Migrations(
      mdb,
      all.filter((m) => m.name <= "0022_matching.sql"),
    );

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const txAfter = (
      await mdb
        .prepare("SELECT * FROM bank_transactions ORDER BY id")
        .all<Record<string, unknown>>()
    ).results;
    const strip = (r: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(r).filter(
          ([k]) =>
            ![
              "ignored_reason",
              "ignored_note",
              "ignored_by",
              "ignored_at",
              "match_checked_at",
            ].includes(k),
        ),
      );
    expect(txAfter.map(strip)).toEqual(txBefore);
    expect(
      txAfter.every((r) => r["ignored_reason"] === null && r["match_checked_at"] === null),
    ).toBe(true);

    const matches = (
      await mdb
        .prepare(
          `SELECT id, bank_transaction_id AS tx, division_id AS div, source, ledger_account_code AS ledger,
                  amount_minor AS amount, score, created_by AS by, status, undone_by, exact_state
           FROM matches ORDER BY id`,
        )
        .all<Record<string, unknown>>()
    ).results;
    expect(matches).toEqual([
      {
        id: 1,
        tx: 1,
        div: 1,
        source: "auto",
        ledger: null,
        amount: 1000,
        score: 99,
        by: "system",
        status: "live",
        undone_by: null,
        exact_state: "not_booked",
      },
      // Row 2 had no resolvable division: not carried over. Row 4 duplicated the live row 3 for
      // the same bank line: kept, marked undone.
      {
        id: 3,
        tx: 3,
        div: 1,
        source: "manual",
        ledger: null,
        amount: 700,
        score: null,
        by: "a@b.com",
        status: "live",
        undone_by: null,
        exact_state: "not_booked",
      },
      {
        id: 4,
        tx: 3,
        div: 1,
        source: "manual",
        ledger: null,
        amount: 700,
        score: null,
        by: "b@b.com",
        status: "undone",
        undone_by: "b@b.com",
        exact_state: "not_booked",
      },
      {
        id: 5,
        tx: 4,
        div: 1,
        source: "manual",
        ledger: null,
        amount: 100,
        score: null,
        by: "a@b.com",
        status: "undone",
        undone_by: "a@b.com",
        exact_state: "not_booked",
      },
    ]);
    const allocs = (
      await mdb
        .prepare(
          "SELECT match_id, open_item_id, allocated_minor, currency FROM match_allocations ORDER BY match_id",
        )
        .all()
    ).results;
    expect(allocs).toEqual([
      { match_id: 1, open_item_id: 1, allocated_minor: 1000, currency: "EUR" },
      { match_id: 3, open_item_id: 2, allocated_minor: 700, currency: "EUR" },
      { match_id: 4, open_item_id: 1, allocated_minor: 700, currency: "EUR" },
      { match_id: 5, open_item_id: 2, allocated_minor: 100, currency: "EUR" },
    ]);
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM match_suggestions").first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (await mdb.prepare("SELECT value_json FROM settings WHERE key = 'keep.me'").first())?.[
        "value_json"
      ],
    ).toBe("1");

    // The ingest's liveness test keeps working: undone_at IS NULL.
    expect(
      (
        await mdb
          .prepare("SELECT COUNT(*) AS n FROM matches WHERE undone_at IS NULL")
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
    // New AUTOINCREMENT ids continue after the highest converted id.
    await mdb
      .prepare(
        "INSERT INTO bank_account_exact_map (bank_account_id, division_id, journal_code, bank_gl_account_code, created_by, updated_by) VALUES (1, 1, '90', '1210', 'a', 'a')",
      )
      .run();
    const ins = await mdb
      .prepare(
        `INSERT INTO matches (bank_transaction_id, division_id, source, ledger_account_code, amount_minor, currency, created_by)
         VALUES (4, 1, 'ledger', '4500', 100, 'EUR', 'a@b.com')`,
      )
      .run();
    expect(ins.meta.last_row_id).toBeGreaterThan(5);
  });
});

describe("migration 0022 objects and guards", () => {
  const db = env.DB;

  it("has the new tables, columns, indexes and triggers", async () => {
    const names = async (type: string): Promise<string[]> =>
      (
        await db
          .prepare("SELECT name FROM sqlite_master WHERE type = ?1")
          .bind(type)
          .all<{ name: string }>()
      ).results.map((r) => r.name);
    expect(await names("table")).toEqual(
      expect.arrayContaining(["match_allocations", "bank_account_exact_map", "ledger_patterns"]),
    );
    expect(await names("index")).toEqual(
      expect.arrayContaining([
        "idx_matches_live_tx",
        "idx_match_alloc_item",
        "idx_bank_tx_match_queue",
      ]),
    );
    expect(await names("trigger")).toEqual(
      expect.arrayContaining([
        "matches_guard_insert",
        "matches_guard_update",
        "match_allocations_guard",
      ]),
    );
    const cols = (
      await db.prepare("PRAGMA table_info(bank_transactions)").all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "ignored_reason",
        "ignored_note",
        "ignored_by",
        "ignored_at",
        "match_checked_at",
      ]),
    );
  });

  it("the plan for live allocations per open item uses the index", async () => {
    const plan = (
      await db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT SUM(a.allocated_minor) FROM match_allocations a
             JOIN matches m ON m.id = a.match_id WHERE a.open_item_id = 1 AND m.undone_at IS NULL`,
        )
        .all<{ detail: string }>()
    ).results
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).toContain("idx_match_alloc_item");
  });
});
