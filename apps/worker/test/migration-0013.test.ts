import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0013 rebuilds bank_transactions (leg-aware unique key, 'unknown' state, ingestion
 * metadata) together with its two children, adds Revolut columns to connections and
 * bank_accounts, and creates webhook_events. This runs it on a database that already holds rows
 * in all of them, as a deployed Phase 4 database would.
 */
describe("migration 0013 on a populated database", () => {
  it("keeps rows and children, enforces leg uniqueness, and adds the new objects", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0013"));
    expect(idx).toBeGreaterThan(0);
    await applyD1Migrations(mdb, all.slice(0, idx));

    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status, creates_bank_entries) VALUES (5, 'exact', 'exact', 'active', 0)",
      ),
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status, creates_bank_entries) VALUES (6, 'revolut', 'revolut', 'pending', 1)",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (9, 5, 123, 'BV')",
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, amount_minor, open_minor, status, synced_at)
         VALUES (1, 9, 'item-1', 'invoice', 'EUR', 12345, 12345, 'open', '2026-01-01T00:00:00Z')`,
      ),
      mdb.prepare(
        "INSERT INTO bank_accounts (id, connection_id, external_id, name, currency, iban) VALUES (1, 6, 'acc-1', 'Main', 'EUR', 'NL91ABNA0417164300')",
      ),
      mdb.prepare(
        `INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, state,
           amount_minor, currency, counterparty_name, counterparty_iban, reference, booked_at,
           exact_entry_id, match_status, created_at)
         VALUES (1, 6, 1, 'tx-1', 'completed', 12345, 'EUR', 'Acme', 'NL02ABNA0123456789', 'INV-1',
           '2026-01-02T10:00:00.000Z', 'E-1', 'matched', '2026-01-02T11:00:00.000Z')`,
      ),
      mdb.prepare(
        `INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, state,
           amount_minor, currency, booked_at)
         VALUES (2, 6, 1, 'tx-2', 'pending', -500, 'EUR', '2026-01-03T00:00:00.000Z')`,
      ),
      mdb.prepare(
        "INSERT INTO match_suggestions (id, bank_transaction_id, open_item_id, score, reason) VALUES (1, 1, 1, 97, 'number')",
      ),
      mdb.prepare(
        `INSERT INTO matches (id, bank_transaction_id, open_item_id, amount_minor, currency, mode, score,
           matched_by) VALUES (1, 1, 1, 12345, 'EUR', 'auto', 97, 'system')`,
      ),
    ]);
    const seqBefore = await mdb
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'bank_transactions'")
      .first<{ seq: number }>();

    await applyD1Migrations(mdb, all);

    expect((await mdb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const tx = (
      await mdb
        .prepare(
          `SELECT id, connection_id, bank_account_id, external_id, leg_id, state, is_final,
             amount_minor, currency, counterparty_name, counterparty_iban, reference, booked_at,
             created_at, first_seen_at, source, exact_entry_id, match_status, request_id, type
           FROM bank_transactions ORDER BY id`,
        )
        .all()
    ).results;
    expect(tx).toEqual([
      {
        id: 1,
        connection_id: 6,
        bank_account_id: 1,
        external_id: "tx-1",
        leg_id: "",
        state: "completed",
        is_final: 1,
        amount_minor: 12345,
        currency: "EUR",
        counterparty_name: "Acme",
        counterparty_iban: "NL02ABNA0123456789",
        reference: "INV-1",
        booked_at: "2026-01-02T10:00:00.000Z",
        created_at: "2026-01-02T10:00:00.000Z",
        first_seen_at: "2026-01-02T11:00:00.000Z",
        source: "poll",
        exact_entry_id: "E-1",
        match_status: "matched",
        request_id: null,
        type: null,
      },
      expect.objectContaining({ id: 2, state: "pending", is_final: 0, amount_minor: -500 }),
    ]);
    // children kept their rows and still point at the rebuilt parent
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM match_suggestions").first<{ n: number }>())?.n,
    ).toBe(1);
    expect((await mdb.prepare("SELECT COUNT(*) AS n FROM matches").first<{ n: number }>())?.n).toBe(
      1,
    );
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM bank_accounts").first<{ n: number }>())?.n,
    ).toBe(1);
    expect(
      await mdb.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_0013_copy'").first(),
    ).toBeNull();
    expect(seqBefore?.seq).toBe(2);
    // The live-match unique index and the lookup indexes survived/were created.
    const indexes = (
      await mdb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    for (const n of [
      "idx_matches_live",
      "idx_matches_tx",
      "idx_matches_item",
      "idx_suggestions_tx",
      "idx_bank_tx_account_date",
      "idx_bank_tx_match",
      "idx_bank_tx_conn_state",
      "idx_bank_tx_cp_iban",
      "idx_webhook_events_status",
    ]) {
      expect(indexes, n).toContain(n);
    }
    await expect(
      mdb
        .prepare(
          "INSERT INTO matches (bank_transaction_id, open_item_id, amount_minor, currency, mode, matched_by) VALUES (1, 1, 1, 'EUR', 'manual', 'a')",
        )
        .run(),
    ).rejects.toThrow();

    // --- leg uniqueness (review S11) ---
    const insertLeg = (ext: string, leg: string) =>
      mdb
        .prepare(
          `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, leg_id, state,
             amount_minor, currency, booked_at, source)
           VALUES (6, 1, ?1, ?2, 'completed', 100, 'EUR', '2026-02-01T00:00:00Z', 'webhook')`,
        )
        .bind(ext, leg)
        .run();
    await insertLeg("transfer-1", "leg-a");
    await insertLeg("transfer-1", "leg-b"); // the other leg of the same transfer
    await expect(insertLeg("transfer-1", "leg-a")).rejects.toThrow(); // duplicate (id, leg)
    await insertLeg("transfer-2", "");
    await expect(insertLeg("transfer-2", "")).rejects.toThrow();
    expect(
      (
        await mdb
          .prepare("SELECT COUNT(*) AS n FROM bank_transactions WHERE external_id = 'transfer-1'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);

    // state: unknown is allowed, an invented state is not; source is checked; is_final is derived.
    await mdb
      .prepare(
        `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, state, amount_minor,
           currency, booked_at) VALUES (6, 1, 'u-1', 'unknown', 1, 'EUR', '2026-02-01T00:00:00Z')`,
      )
      .run();
    expect(
      (
        await mdb
          .prepare("SELECT is_final AS f FROM bank_transactions WHERE external_id = 'u-1'")
          .first<{ f: number }>()
      )?.f,
    ).toBe(0);
    for (const bad of ["state", "source"]) {
      await expect(
        mdb
          .prepare(
            `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, state, source,
               amount_minor, currency, booked_at)
             VALUES (6, 1, 'bad-${bad}', ?1, ?2, 1, 'EUR', '2026-02-01T00:00:00Z')`,
          )
          .bind(bad === "state" ? "settled" : "completed", bad === "source" ? "cron" : "poll")
          .run(),
      ).rejects.toThrow();
    }
    // a generated column cannot be written
    await expect(
      mdb
        .prepare(
          `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, state, is_final,
             amount_minor, currency, booked_at)
           VALUES (6, 1, 'g-1', 'pending', 1, 1, 'EUR', '2026-02-01T00:00:00Z')`,
        )
        .run(),
    ).rejects.toThrow();
    // cascade from the rebuilt parent still reaches the suggestions
    await mdb.prepare("DELETE FROM matches").run();
    await mdb.prepare("DELETE FROM bank_transactions WHERE id = 1").run();
    expect(
      (await mdb.prepare("SELECT COUNT(*) AS n FROM match_suggestions").first<{ n: number }>())?.n,
    ).toBe(0);

    // --- connections ---
    const conn = await mdb
      .prepare(
        `SELECT creates_bank_entries AS c, payments_mode AS p, revolut_environment AS e,
           bank_entries_decided_at AS d, webhook_id AS w FROM connections WHERE id = 6`,
      )
      .first();
    expect(conn).toEqual({ c: 1, p: "drafts", e: null, d: null, w: null });
    await expect(
      mdb.prepare("UPDATE connections SET payments_mode = 'auto' WHERE id = 6").run(),
    ).rejects.toThrow();
    await expect(
      mdb.prepare("UPDATE connections SET revolut_environment = 'live' WHERE id = 6").run(),
    ).rejects.toThrow();
    await mdb.prepare("UPDATE connections SET revolut_environment = 'sandbox' WHERE id = 6").run();

    // --- bank_accounts ---
    const acc = await mdb
      .prepare("SELECT is_active AS a, bic, state, iban FROM bank_accounts WHERE id = 1")
      .first();
    expect(acc).toEqual({ a: 1, bic: null, state: null, iban: "NL91ABNA0417164300" });
    await expect(
      mdb.prepare("UPDATE bank_accounts SET is_active = 2 WHERE id = 1").run(),
    ).rejects.toThrow();

    // --- webhook_events ---
    const hash = "a".repeat(64);
    const ins = (h: string) =>
      mdb
        .prepare(
          "INSERT INTO webhook_events (connection_id, event_hash, event_type, external_id) VALUES (6, ?1, 'TransactionCreated', 'tx-9')",
        )
        .bind(h)
        .run();
    await ins(hash);
    await expect(ins(hash)).rejects.toThrow();
    await expect(ins("short")).rejects.toThrow();
    expect(
      (await mdb.prepare("SELECT status FROM webhook_events").first<{ status: string }>())?.status,
    ).toBe("queued");
  });

  it("applies cleanly to an empty database", async () => {
    // The shared test database already has every migration applied by the setup file.
    const cols = (
      await env.DB.prepare("SELECT name FROM pragma_table_xinfo('bank_transactions')").all<{
        name: string;
      }>()
    ).results.map((c) => c.name);
    for (const c of [
      "leg_id",
      "is_final",
      "request_id",
      "first_seen_at",
      "source",
      "completed_at",
    ]) {
      expect(cols).toContain(c);
    }
  });
});
