import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Migration 0028 rebuilds `payments` and `payment_batches` (an unused skeleton since 0003). It must
 * REFUSE to run, and drop nothing, if either table holds a row: a populated payments table is never
 * dropped silently.
 */
describe("migration 0028 on a database with a legacy payments row", () => {
  it("fails closed with a row, succeeds without one, and leaves the generic approvals table alone", async () => {
    const mdb = env.MIGRATE_DB;
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name.startsWith("0028"));
    expect(idx).toBeGreaterThan(20);
    await applyD1Migrations(mdb, all.slice(0, idx));
    await mdb.batch([
      mdb.prepare(
        "INSERT INTO connections (id, kind, name, status) VALUES (5, 'exact', 'exact', 'active')",
      ),
      mdb.prepare(
        "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (9, 5, 1, 'BV')",
      ),
      mdb.prepare(
        `INSERT INTO open_items (id, division_id, exact_id, kind, currency, stored_minor, open_minor, status, synced_at)
         VALUES (1, 9, 'b1', 'bill', 'EUR', 1000, 1000, 'open', '2026-01-01T00:00:00Z')`,
      ),
      mdb.prepare(
        `INSERT INTO payments (id, open_item_id, amount_minor, currency, beneficiary_iban, request_id, created_by)
         VALUES (1, 1, 1000, 'EUR', 'NL91ABNA0417164300', 'old-request', 'a@b.nl')`,
      ),
    ]);
    await expect(applyD1Migrations(mdb, all)).rejects.toThrow();
    // nothing was dropped
    const old = await mdb.prepare("SELECT request_id FROM payments").all<{ request_id: string }>();
    expect(old.results).toEqual([{ request_id: "old-request" }]);

    await mdb.prepare("DELETE FROM payments").run();
    await applyD1Migrations(mdb, all);
    const cols = (
      await mdb.prepare("PRAGMA table_info(payments)").all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(cols).toContain("payload_hash");
    expect(cols).toContain("iban_fingerprint");
    for (const t of [
      "payment_batches",
      "payment_approvals",
      "supplier_iban_verifications",
      "payment_events",
      "payment_claims",
      "approvals",
    ]) {
      const r = await mdb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1")
        .bind(t)
        .first();
      expect(r, t).not.toBeNull();
    }
    const fk = await mdb.prepare("PRAGMA foreign_key_check").all();
    expect(fk.results).toEqual([]);
    // the guard scratch table is gone
    expect(
      await mdb.prepare("SELECT name FROM sqlite_master WHERE name = 'p9a_guard'").first(),
    ).toBeNull();
  });
});
