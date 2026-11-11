import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { redactOldOutboxPayloads } from "../src/matching/housekeeping";
import { checkMatchingInvariants } from "../src/matching/invariants";
import { SETTLEMENT_PREDICATE, staleSettlements } from "../src/matching/settlement";
import { claimMatchForBooking } from "../src/matching/store";

/**
 * Migration 0025 (settlement baseline, outbox retention; review U2) on a database populated under
 * 0023/0024: a booked match (only possible on a test division before 0025), an unbooked one and a
 * finished outbox row. Their allocations get a NULL baseline (unknown: keeps counting), the claim
 * sets it, the redaction works on the old row, and nothing else changes.
 */
describe("migration 0025 on a populated database", () => {
  it("NULL baselines keep counting, the claim sets them, foreign keys hold", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0025"));
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
         VALUES (1, 2, 1, 't1', 'completed', 400, 'EUR', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'unmatched'),
                (2, 2, 1, 't2', 'completed', 300, 'EUR', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'unmatched')`,
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, stored_minor, open_minor, synced_at)
         VALUES (1, 1, 'i1', 'invoice', 'EUR', 1000, 1000, '2026-07-01T00:00:00Z'),
                (2, 1, 'i2', 'invoice', 'EUR', 700, 700, '2026-07-01T00:00:00Z')`,
      ),
      mdb.prepare(
        `INSERT INTO matches (id, bank_transaction_id, division_id, source, amount_minor, currency, created_by)
         VALUES (1, 1, 1, 'manual', 400, 'EUR', 'a@b.com'), (2, 2, 1, 'manual', 300, 'EUR', 'a@b.com')`,
      ),
      mdb.prepare(
        `INSERT INTO match_allocations (match_id, open_item_id, allocated_minor, currency)
         VALUES (1, 1, 400, 'EUR'), (2, 2, 300, 'EUR')`,
      ),
      mdb.prepare("UPDATE bank_transactions SET match_status = 'matched'"),
      // Match 1 booked under the old rule (test division), its outbox row finished long ago.
      mdb.prepare("UPDATE matches SET exact_state = 'booking' WHERE id = 1"),
      mdb
        .prepare(
          `INSERT INTO exact_write_outbox (match_id, division_id, kind, idempotency_key, payload_json,
           payload_hash, status, created_at, updated_at)
         VALUES (1, 1, 'matchset', ?1, '{"v":1,"stage":"built","input":{"bankEntryNumber":77,"name":"Jan"}}',
                 ?2, 'pending', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
        )
        .bind("k".repeat(64), "h".repeat(64)),
      mdb.prepare(
        "UPDATE exact_write_outbox SET status = 'verified', updated_at = '2025-01-02T00:00:00.000Z'",
      ),
      mdb.prepare(
        "UPDATE matches SET exact_state = 'matched_in_exact', booked_at = '2026-07-02T00:00:00.000Z' WHERE id = 1",
      ),
      // Re-read after the booking, balance unchanged (lagging): under 0023 this RELEASED match 1.
      mdb.prepare("UPDATE open_items SET synced_at = '2026-07-03T00:00:00.000Z' WHERE id = 1"),
    ]);
    const counting = async (item: number): Promise<number> =>
      (
        await mdb
          .prepare(
            `SELECT COALESCE(SUM(a.allocated_minor), 0) AS n FROM match_allocations a
               JOIN matches m ON m.id = a.match_id JOIN open_items oi ON oi.id = a.open_item_id
             WHERE a.open_item_id = ?1 AND ${SETTLEMENT_PREDICATE}`,
          )
          .bind(item)
          .first<{ n: number }>()
      )?.n ?? -1;
    const before = (
      await mdb.prepare("SELECT * FROM matches ORDER BY id").all<Record<string, unknown>>()
    ).results;

    await applyD1Migrations(mdb, all);

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (await mdb.prepare("SELECT * FROM matches ORDER BY id").all<Record<string, unknown>>())
        .results,
    ).toEqual(before);
    expect(
      (
        await mdb
          .prepare("SELECT match_id, open_before_minor FROM match_allocations ORDER BY id")
          .all()
      ).results,
    ).toEqual([
      { match_id: 1, open_before_minor: null },
      { match_id: 2, open_before_minor: null },
    ]);
    // The booked allocation with an unknown baseline keeps counting (the lagging read no longer
    // frees it) and is reported stale after 48 hours.
    expect(await counting(1)).toBe(400);
    expect(await staleSettlements(mdb, "2026-07-10T00:00:00.000Z")).toBe(1);
    expect(await checkMatchingInvariants(mdb)).toEqual([]);
    // The unbooked one gets its baseline from the claim (a bare claim, no outbox row: test only).
    expect(await claimMatchForBooking(mdb, 2, "booking")).toBe(true);
    expect(
      await mdb
        .prepare("SELECT open_before_minor AS v FROM match_allocations WHERE match_id = 2")
        .first(),
    ).toEqual({ v: 700 });
    // The old finished outbox row can be redacted; its bank entry number survives.
    expect(await redactOldOutboxPayloads(mdb, Date.parse("2026-11-11T00:00:00.000Z"))).toBe(1);
    expect(
      await mdb.prepare("SELECT payload_json AS p, status FROM exact_write_outbox").first(),
    ).toEqual({
      p: '{"v":1,"stage":"redacted","input":{"bankEntryNumber":77}}',
      status: "verified",
    });
  });
});
