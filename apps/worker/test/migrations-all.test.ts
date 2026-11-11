import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkMatchingInvariants } from "../src/matching/invariants";
import { flagMatchesForReview } from "../src/matching/store";
import pinned from "./fixtures/trigger-hashes.json";

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Every migration, end to end, on a database populated at the Phase 1 schema (0001..0003): the
 * later rebuilds (0013 bank_transactions, 0022 matches and suggestions, ...) are exercised against
 * data written by earlier phases, not only against an empty schema. New migrations are covered
 * automatically (the test applies `all`).
 */
describe("all migrations on a database populated at the first schema", () => {
  it("keeps the rows, foreign keys hold, and the matching tables are consistent", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0004"));
    expect(idx).toBe(3);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare("INSERT INTO settings (key, value_json) VALUES ('keep.me', '\"x\"')"),
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (1, 'exact', 'nl', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (2, 'revolut', 'rev', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (1, 1, 100, 'BV')",
      ),
      mdb.prepare(
        `INSERT INTO bank_accounts (id, connection_id, division_id, external_id, name, iban, currency)
         VALUES (1, 2, 1, 'acc', 'Main', 'NL02ABNA0123456789', 'EUR')`,
      ),
      mdb.prepare(
        `INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, state, amount_minor,
           currency, reference, booked_at, created_at, match_status)
         VALUES (1, 2, 1, 't1', 'completed', 1000, 'EUR', 'INV 1', '2026-01-02T10:00:00.000Z',
                 '2026-01-02T10:00:00.000Z', 'matched'),
                (2, 2, 1, 't2', 'pending', -250, 'EUR', NULL, '2026-01-03T10:00:00.000Z',
                 '2026-01-03T10:00:00.000Z', 'unmatched'),
                (3, 2, 1, 't3', 'completed', 300, 'EUR', NULL, '2026-01-04T10:00:00.000Z',
                 '2026-01-04T10:00:00.000Z', 'matched')`,
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, invoice_number, currency, amount_minor,
           open_minor, synced_at)
         VALUES (1, 1, 'i1', 'invoice', '1', 'EUR', 1000, 1000, '2026-01-01T00:00:00.000Z'),
                (2, 1, 'i2', 'invoice', '2', 'EUR', 500, 200, '2026-01-01T00:00:00.000Z')`,
      ),
      // tx 1: a live match to item 1. tx 3: a live match of 300 to item 2 whose open balance is
      // now 200 (paid elsewhere meanwhile): converted, then flagged over_allocated by the first run.
      mdb.prepare(
        `INSERT INTO matches (id, bank_transaction_id, open_item_id, amount_minor, currency, mode, matched_by)
         VALUES (1, 1, 1, 1000, 'EUR', 'manual', 'a@b.com'),
                (2, 3, 2, 300, 'EUR', 'manual', 'a@b.com')`,
      ),
      mdb.prepare(
        "INSERT INTO match_suggestions (bank_transaction_id, open_item_id, score, reason) VALUES (2, 1, 50, 'x')",
      ),
    ]);

    await applyD1Migrations(mdb, all);

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (
        await mdb
          .prepare(
            "SELECT id, amount_minor, state, match_status FROM bank_transactions ORDER BY id",
          )
          .all()
      ).results,
    ).toEqual([
      { id: 1, amount_minor: 1000, state: "completed", match_status: "matched" },
      { id: 2, amount_minor: -250, state: "pending", match_status: "unmatched" },
      { id: 3, amount_minor: 300, state: "completed", match_status: "matched" },
    ]);
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM open_items").first<{ n: number }>())?.n,
    ).toBe(2);
    expect(
      (await mdb.prepare("SELECT value_json FROM settings WHERE key = 'keep.me'").first())?.[
        "value_json"
      ],
    ).toBe('"x"');
    expect(
      (
        await mdb
          .prepare("SELECT id, source, status FROM matches ORDER BY id")
          .all<Record<string, unknown>>()
      ).results,
    ).toEqual([
      { id: 1, source: "manual", status: "live" },
      { id: 2, source: "manual", status: "live" },
    ]);

    // Before the first run the over-allocation is reported; the run flags it and the data is
    // consistent (a flagged match is never booked; a person undoes it).
    expect((await checkMatchingInvariants(mdb)).map((v) => v.code)).toEqual([
      "item_over_allocated_unflagged",
    ]);
    expect(await flagMatchesForReview(mdb, "2026-07-01T00:00:00.000Z")).toBe(1);
    expect(await mdb.prepare("SELECT review_reason FROM matches WHERE id = 2").first()).toEqual({
      review_reason: "over_allocated",
    });
    expect(await checkMatchingInvariants(mdb)).toEqual([]);

    // Every trigger exists on the migrated database, exactly these and with exactly these bodies
    // (review N5): a migration that drops or weakens a trigger changes the list or a hash and must
    // update test/fixtures/trigger-hashes.json deliberately (`pnpm run triggers:update`).
    const rows = (
      await mdb
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all<{ name: string; sql: string }>()
    ).results;
    const actual: Record<string, string> = {};
    for (const r of rows) actual[r.name] = await sha256(r.sql.replace(/\s+/g, " ").trim());
    const how =
      "Triggers differ from test/fixtures/trigger-hashes.json. If the change is deliberate, run " +
      "`pnpm --filter @camelthorn/worker run triggers:update` and review the diff (a trigger that " +
      "disappears or gets weaker must be intended).";
    expect(Object.keys(actual).sort(), how).toEqual(Object.keys(pinned.triggers).sort());
    expect(actual, how).toEqual(pinned.triggers);
    // 0024: the new columns exist and start empty on migrated data.
    const cols = async (table: string): Promise<string[]> =>
      (await mdb.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map(
        (c) => c.name,
      );
    expect(await cols("matches")).toEqual(
      expect.arrayContaining([
        "booking_deferred_code",
        "booking_deferred_at",
        "manually_booked",
        "op_nonce",
      ]),
    );
    expect(await cols("exact_write_outbox")).toEqual(
      expect.arrayContaining(["creates_bank_entries", "admin_resolved_by", "admin_resolved_at"]),
    );
    expect(await cols("bank_account_exact_map")).toContain("opening_balance_minor");
    expect(
      await mdb
        .prepare(
          "SELECT 1 FROM matches WHERE booking_deferred_code IS NOT NULL OR manually_booked <> 0",
        )
        .first(),
    ).toBeNull();

    // 0023 on migrated data: the old matches are not booked, nothing is in the outbox, booking is
    // off (no settings row), and the new columns and the call ledger exist.
    expect(
      (
        await mdb
          .prepare("SELECT id, exact_state, booked_at, exact_note FROM matches ORDER BY id")
          .all()
      ).results,
    ).toEqual([
      { id: 1, exact_state: "not_booked", booked_at: null, exact_note: null },
      { id: 2, exact_state: "not_booked", booked_at: null, exact_note: null },
    ]);
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM exact_write_outbox").first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      await mdb.prepare("SELECT 1 FROM settings WHERE key LIKE 'exact.booking_%'").first(),
    ).toBeNull();
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM booking_call_ledger").first<{ n: number }>())
        ?.n,
    ).toBe(0);
    const outboxCols = (
      await mdb.prepare("PRAGMA table_info(exact_write_outbox)").all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(outboxCols).toEqual(
      expect.arrayContaining(["op_nonce", "needs_probe", "lease_expires_at"]),
    );
    // the illegal move is refused on the migrated database too
    await expect(
      mdb.prepare("UPDATE matches SET exact_state = 'matched_in_exact' WHERE id = 1").run(),
    ).rejects.toThrow(/match_err:bad_transition/);
  });
});
