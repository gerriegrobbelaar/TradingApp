import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { undoUnsentClaim, retryUnsentClaim } from "../src/booking/unsent";
import { checkMatchingInvariants } from "../src/matching/invariants";

/**
 * Migration 0024 (booking guards, task U1) on a populated database written under 0023: every row
 * survives, the new columns start empty, and a match that was stuck before (claimed
 * `manual_required` with a stage 'none' row and nothing sent) can now be undone or retried, while a
 * claim with a real payload never can.
 */
describe("migration 0024 on a populated database", () => {
  it("keeps every row, adds the columns, frees stuck claims and still refuses real ones", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0024"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    const none = JSON.stringify({ v: 1, stage: "none", reason: "part_payment_not_supported_v1" });
    const built = JSON.stringify({ v: 1, stage: "built", kind: "bank_entry" });
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
                (2, 2, 1, 't2', 'completed', 700, 'EUR', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'unmatched'),
                (3, 2, 1, 't3', 'completed', 300, 'EUR', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'unmatched')`,
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, stored_minor, open_minor, synced_at)
         VALUES (1, 1, 'i1', 'invoice', 'EUR', 1000, 1000, '2026-07-01T00:00:00Z'),
                (2, 1, 'i2', 'invoice', 'EUR', 700, 700, '2026-07-01T00:00:00Z'),
                (3, 1, 'i3', 'invoice', 'EUR', 300, 300, '2026-07-01T00:00:00Z')`,
      ),
      mdb.prepare(
        `INSERT INTO matches (id, bank_transaction_id, division_id, source, amount_minor, currency, created_by)
         VALUES (1, 1, 1, 'manual', 1000, 'EUR', 'a@b.com'), (2, 2, 1, 'manual', 700, 'EUR', 'a@b.com'),
                (3, 3, 1, 'manual', 300, 'EUR', 'a@b.com')`,
      ),
      mdb.prepare(
        `INSERT INTO match_allocations (match_id, open_item_id, allocated_minor, currency)
         VALUES (1, 1, 1000, 'EUR'), (2, 2, 700, 'EUR'), (3, 3, 300, 'EUR')`,
      ),
      mdb.prepare("UPDATE bank_transactions SET match_status = 'matched'"),
      // match 1: stuck after a plan failure (stage none, nothing sent)
      mdb.prepare("UPDATE matches SET exact_state = 'manual_required' WHERE id IN (1, 2)"),
      mdb
        .prepare(
          `INSERT INTO exact_write_outbox (match_id, division_id, kind, idempotency_key, payload_json, payload_hash,
           status, last_error_code, created_at, updated_at)
         VALUES (1, 1, 'bank_entry', ?1, ?2, ?3, 'manual_required', 'part_payment_not_supported_v1', 'x', 'x')`,
        )
        .bind("a".repeat(64), none, "h".repeat(64)),
      // match 2: manual_required but with a real built payload (a person must look in Exact)
      mdb
        .prepare(
          `INSERT INTO exact_write_outbox (match_id, division_id, kind, idempotency_key, payload_json, payload_hash,
           status, last_error_code, created_at, updated_at)
         VALUES (2, 1, 'bank_entry', ?1, ?2, ?3, 'manual_required', 'bank_balance_changed', 'x', 'x')`,
        )
        .bind("b".repeat(64), built, "h".repeat(64)),
      mdb.prepare("INSERT INTO settings (key, value_json) VALUES ('keep.me', '1')"),
    ]);
    const before = (
      await mdb
        .prepare("SELECT id, exact_state FROM matches ORDER BY id")
        .all<Record<string, unknown>>()
    ).results;

    await applyD1Migrations(mdb, all.slice(idx, idx + 1));

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (
        await mdb
          .prepare("SELECT id, exact_state FROM matches ORDER BY id")
          .all<Record<string, unknown>>()
      ).results,
    ).toEqual(before);
    expect(
      await mdb
        .prepare(
          "SELECT 1 FROM matches WHERE booking_deferred_code IS NOT NULL OR manually_booked <> 0 OR op_nonce IS NOT NULL",
        )
        .first(),
    ).toBeNull();
    expect(
      (await mdb.prepare("SELECT value_json FROM settings WHERE key = 'keep.me'").first())?.[
        "value_json"
      ],
    ).toBe("1");
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM exact_write_outbox").first<{ n: number }>())?.n,
    ).toBe(2);

    // The database refuses to undo a claim with a real payload, even with plain SQL.
    await expect(
      mdb.prepare("UPDATE matches SET undone_at = 'x', undone_by = 'y' WHERE id = 2").run(),
    ).rejects.toThrow(/bad_transition/);
    // The stuck claim can be retried (rows deleted, back to not_booked) ...
    expect(await retryUnsentClaim(mdb, 1, "admin@camelthorncapital.com", "fixed")).toEqual({
      kind: "done",
    });
    expect(
      (await mdb.prepare("SELECT exact_state FROM matches WHERE id = 1").first())?.["exact_state"],
    ).toBe("not_booked");
    expect(
      (
        await mdb
          .prepare("SELECT COUNT(*) AS n FROM exact_write_outbox WHERE match_id = 1")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    // ... and the real claim is refused by the application as well.
    expect(await retryUnsentClaim(mdb, 2, "admin@camelthorncapital.com", "x")).toEqual({
      kind: "not_unsent",
    });
    expect(
      await undoUnsentClaim(mdb, 2, "admin@camelthorncapital.com", "x", "2026-07-15T10:00:00.000Z"),
    ).toEqual({
      kind: "not_unsent",
    });
    // A second stuck claim is undone through the unsent path.
    await mdb.batch([
      mdb.prepare("UPDATE matches SET exact_state = 'manual_required' WHERE id = 3"),
      mdb
        .prepare(
          `INSERT INTO exact_write_outbox (match_id, division_id, kind, idempotency_key, payload_json, payload_hash,
             status, created_at, updated_at) VALUES (3, 1, 'bank_entry', ?1, ?2, ?3, 'manual_required', 'x', 'x')`,
        )
        .bind("c".repeat(64), none, "h".repeat(64)),
    ]);
    expect(
      await undoUnsentClaim(
        mdb,
        3,
        "fin@camelthorncapital.com",
        "wrong invoice",
        "2026-07-15T10:00:00.000Z",
      ),
    ).toEqual({ kind: "done" });
    expect(
      (await mdb.prepare("SELECT match_status FROM bank_transactions WHERE id = 3").first())?.[
        "match_status"
      ],
    ).toBe("unmatched");
    // Match 2 stays a (correct) invariant finding: manual_required, its row was never sent but a person decides.
    expect((await checkMatchingInvariants(mdb)).map((v) => v.code)).not.toContain(
      "outbox_of_undone_match",
    );
  });
});
