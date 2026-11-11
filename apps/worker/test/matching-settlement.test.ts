/**
 * Settlement rule v2 (phase 7 final-review S5, ADR 0042 addendum) and outbox payload retention
 * (N3, ADR 0011). A booked allocation is RELEASED only when the re-read item proves the payment;
 * a lagging read keeps counting; the trigger and the TypeScript use ONE predicate text.
 */
import { describe, expect, it, beforeEach } from "vitest";
import migration0025 from "../migrations/0025_settlement_baseline.sql?raw";
import { assembleItems } from "../src/matching/assemble";
import {
  OUTBOX_REDACT_BATCH,
  REDACTED_PAYLOAD,
  redactOldOutboxPayloads,
} from "../src/matching/housekeeping";
import { checkMatchingInvariants } from "../src/matching/invariants";
import {
  allocCounts,
  recordOpenBefore,
  SETTLEMENT_PREDICATE,
  staleSettlements,
} from "../src/matching/settlement";
import { applyMatch, claimMatchForBooking, flagMatchesForReview } from "../src/matching/store";
import { addItem, addTx, db, resetWorld, type World } from "./matching-helpers";

let w: World;
beforeEach(async () => {
  w = await resetWorld();
});

const BOOKED_AT = "2026-07-15T12:00:00.000Z";
const BEFORE = "2026-07-15T11:00:00.000Z";
const AFTER = "2026-07-15T13:00:00.000Z";

async function match(
  itemId: number,
  amount: number,
): Promise<{ ok: boolean; id: number; code?: string }> {
  const txId = await addTx({
    accountId: w.accountId,
    connectionId: w.revolutConnectionId,
    amountMinor: amount,
  });
  const r = await applyMatch(db, {
    txId,
    divisionId: w.divisionId,
    txAmountMinor: amount,
    currency: "EUR",
    source: "manual",
    ledgerAccountCode: null,
    score: null,
    rule: null,
    note: null,
    actor: "fin@camelthorncapital.com",
    allocations: [{ openItemId: itemId, allocatedMinor: amount, remainingAfter: null }],
    nowIso: "2026-07-15T10:00:00.000Z",
  });
  return r.ok ? { ok: true, id: r.matchId } : { ok: false, id: 0, code: r.code };
}

async function book(matchId: number, at = BOOKED_AT): Promise<void> {
  expect(await claimMatchForBooking(db, matchId, "booking")).toBe(true);
  await db
    .prepare("UPDATE matches SET exact_state = 'matched_in_exact', booked_at = ?2 WHERE id = ?1")
    .bind(matchId, at)
    .run();
}

async function sync(itemId: number, openMinor: number, at: string, status = "open"): Promise<void> {
  await db
    .prepare("UPDATE open_items SET open_minor = ?2, synced_at = ?3, status = ?4 WHERE id = ?1")
    .bind(itemId, openMinor, at, status)
    .run();
}

const available = async (itemId: number): Promise<number> => {
  const item = (await assembleItems(db, w.divisionId)).find((i) => i.id === itemId);
  return item === undefined ? 0 : Number(item.openMinor);
};

/** Item of 10,000 with a booked match of 4,000 (baseline recorded at creation). */
async function booked(): Promise<{ item: number; matchId: number }> {
  const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
  await sync(item, 10_000, BEFORE);
  const a = await match(item, 4_000);
  expect(a.ok).toBe(true);
  await book(a.id);
  return { item, matchId: a.id };
}

describe("release only when the re-read item proves the payment", () => {
  it("a read that lags the MatchSet (item reappears fully open) keeps counting: no duplicate allocation", async () => {
    const { item } = await booked();
    await sync(item, 10_000, AFTER);
    expect(await available(item)).toBe(6_000);
    expect((await match(item, 6_001)).code).toBe("alloc_exceeds_open");
    expect((await match(item, 10_000)).code).toBe("alloc_exceeds_open");
    expect((await match(item, 6_000)).ok).toBe(true);
  });

  it("a partial decrease (less than the allocation) keeps counting", async () => {
    const { item } = await booked();
    await sync(item, 8_000, AFTER); // fell by 2,000 < 4,000
    expect(await available(item)).toBe(4_000);
    expect((await match(item, 4_001)).code).toBe("alloc_exceeds_open");
    await sync(item, 6_001, AFTER); // fell by 3,999: one short
    expect(await available(item)).toBe(2_001);
  });

  it("a decrease of at least the allocation releases it", async () => {
    const { item } = await booked();
    await sync(item, 6_000, AFTER); // exactly the allocation
    expect(await available(item)).toBe(6_000);
    await sync(item, 5_000, AFTER); // more than the allocation (paid elsewhere too)
    expect(await available(item)).toBe(5_000);
    expect((await match(item, 5_000)).ok).toBe(true);
  });

  it("a closed item releases (and cannot be matched at all)", async () => {
    const { item } = await booked();
    await sync(item, 0, AFTER, "closed");
    expect(await available(item)).toBe(0);
    expect((await match(item, 1)).code).toBe("item_not_matchable");
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("an item with no open balance but still 'open' releases too", async () => {
    const { item } = await booked();
    await sync(item, 0, AFTER);
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("not re-read after the booking (stamp before or equal): keeps counting whatever the balance", async () => {
    const { item } = await booked();
    await sync(item, 6_000, BEFORE);
    expect(await available(item)).toBe(2_000);
    await sync(item, 6_000, BOOKED_AT);
    expect(await available(item)).toBe(2_000);
  });

  it("an unknown baseline (NULL) keeps counting even after a full decrease", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    await sync(item, 10_000, BEFORE);
    const a = await match(item, 4_000);
    await db
      .prepare("UPDATE match_allocations SET open_before_minor = NULL WHERE match_id = ?1")
      .bind(a.id)
      .run();
    await book(a.id);
    await sync(item, 6_000, AFTER);
    expect(await available(item)).toBe(2_000);
    await sync(item, 0, AFTER, "closed"); // closed releases regardless of the baseline
    expect(await available(item)).toBe(0);
  });

  it("the review flags and the invariants use the same rule", async () => {
    const { item } = await booked();
    const c = await match(item, 6_000);
    expect(c.ok).toBe(true);
    // Lagging read: A (4,000) still counts, C (6,000) fits: nothing flagged.
    await sync(item, 10_000, AFTER);
    expect(await flagMatchesForReview(db, AFTER)).toBe(0);
    expect(await checkMatchingInvariants(db)).toEqual([]);
    // A partial decrease (8,000): A still counts, 4,000 + 6,000 > 8,000, C is flagged.
    await sync(item, 8_000, AFTER);
    expect(await flagMatchesForReview(db, AFTER)).toBe(1);
    // Released (6,000 = A's allocation): only C counts, 6,000 fits.
    const { item: item2 } = await booked();
    const c2 = await match(item2, 6_000);
    await sync(item2, 6_000, AFTER);
    expect(await flagMatchesForReview(db, AFTER)).toBe(0);
    expect(c2.ok).toBe(true);
  });

  it("mutation check: without the decrease condition the lagging read would release the allocation", async () => {
    const { item } = await booked();
    await sync(item, 10_000, AFTER);
    const mutated = SETTLEMENT_PREDICATE.replace(
      " AND a.open_before_minor IS NOT NULL AND (oi.status <> 'open' OR oi.open_minor = 0 OR ABS(a.open_before_minor) - ABS(oi.open_minor) >= a.allocated_minor)",
      "",
    );
    expect(mutated).not.toBe(SETTLEMENT_PREDICATE);
    const sum = async (pred: string): Promise<number> =>
      (
        await db
          .prepare(
            `SELECT COALESCE(SUM(a.allocated_minor), 0) AS n FROM match_allocations a
               JOIN matches m ON m.id = a.match_id JOIN open_items oi ON oi.id = a.open_item_id
             WHERE a.open_item_id = ?1 AND ${pred}`,
          )
          .bind(item)
          .first<{ n: number }>()
      )?.n ?? -1;
    expect(await sum(SETTLEMENT_PREDICATE)).toBe(4_000); // real rule: still counts
    expect(await sum(mutated)).toBe(0); // old rule: released, a duplicate could be allocated
  });
});

describe("open_before_minor", () => {
  it("is written when a match is created, and can be refreshed by recordOpenBefore before the claim", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const a = await match(item, 4_000);
    const base = (): Promise<unknown> =>
      db
        .prepare("SELECT open_before_minor AS v FROM match_allocations WHERE match_id = ?1")
        .bind(a.id)
        .first();
    expect(await base()).toEqual({ v: 10_000 });
    await sync(item, 9_000, BEFORE);
    expect(await recordOpenBefore(db, a.id)).toBe(1);
    expect(await base()).toEqual({ v: 9_000 });
    expect(await recordOpenBefore(db, 999_999)).toBe(0);
  });

  it("is locked once the match left not_booked", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const a = await match(item, 4_000);
    expect(await claimMatchForBooking(db, a.id, "booking")).toBe(true);
    await expect(recordOpenBefore(db, a.id)).rejects.toThrow(/immutable/);
  });

  it("the other allocation fields stay immutable", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const a = await match(item, 4_000);
    for (const set of ["allocated_minor = 1", "open_item_id = 1", "currency = 'USD'"]) {
      await expect(
        db.prepare(`UPDATE match_allocations SET ${set} WHERE match_id = ?1`).bind(a.id).run(),
      ).rejects.toThrow(/immutable/);
    }
  });
});

describe("one predicate: TypeScript, triggers and migration", () => {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

  it("allocCounts rewrites only the aliases", () => {
    expect(allocCounts("m", "oi", "a")).toBe(SETTLEMENT_PREDICATE);
    expect(allocCounts("m", "oi")).toBe(SETTLEMENT_PREDICATE);
    const other = allocCounts("m2", "oi", "a2");
    expect(other).toContain("m2.exact_state = 'matched_in_exact'");
    expect(other).toContain("a2.open_before_minor IS NOT NULL");
    expect(other).toContain("ABS(oi.open_minor)");
    expect(other).not.toMatch(/\bm\./);
    expect(() => allocCounts("m; DROP TABLE x", "oi")).toThrow(RangeError);
  });

  it("the live over-allocation trigger contains the predicate text exactly", async () => {
    const row = await db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'match_allocations_guard'",
      )
      .first<{ sql: string }>();
    expect(norm(row?.sql ?? "")).toContain(norm(SETTLEMENT_PREDICATE));
  });

  it("the migration file contains the predicate text exactly", () => {
    expect(norm(migration0025)).toContain(norm(SETTLEMENT_PREDICATE));
  });

  it("the trigger, not only the TypeScript, enforces the rule (lag, partial, release)", async () => {
    const { item } = await booked();
    await sync(item, 10_000, AFTER);
    expect((await match(item, 6_001)).code).toBe("alloc_exceeds_open");
    await sync(item, 6_000, AFTER);
    expect((await match(item, 6_000)).ok).toBe(true);
  });
});

describe("staleSettlements", () => {
  const NOW = Date.parse("2026-07-20T12:00:00.000Z");
  const nowIso = new Date(NOW).toISOString();
  const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

  it("counts counting allocations booked more than 48 hours ago, never auto-releases", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    await sync(item, 10_000, BEFORE);
    const a = await match(item, 4_000);
    await book(a.id, hoursAgo(48));
    // Exactly 48 hours is not older than 48 hours.
    expect(await staleSettlements(db, nowIso)).toBe(0);
    expect(await staleSettlements(db, new Date(NOW + 1).toISOString())).toBe(1);
    // Item re-read (stamp after booking) but still fully open: counted, stale.
    await sync(item, 10_000, hoursAgo(1));
    expect(await staleSettlements(db, new Date(NOW + 1).toISOString())).toBe(1);
    expect(await available(item)).toBe(6_000);
    // Exact shows the payment: released, no longer stale.
    await sync(item, 6_000, hoursAgo(1));
    expect(await staleSettlements(db, new Date(NOW + 1).toISOString())).toBe(0);
  });

  it("ignores recent bookings, unbooked and undone matches", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const a = await match(item, 4_000);
    expect(await staleSettlements(db, nowIso)).toBe(0); // not booked
    await book(a.id, hoursAgo(47));
    expect(await staleSettlements(db, nowIso)).toBe(0); // recent
    const item2 = await addItem({ divisionId: w.divisionId, openMinor: 500 });
    const b = await match(item2, 500);
    await db
      .prepare("UPDATE matches SET undone_at = ?2, undone_by = 'x' WHERE id = ?1")
      .bind(b.id, BEFORE)
      .run();
    expect(await staleSettlements(db, nowIso)).toBe(0);
  });

  it("an allocation with an unknown baseline stays stale", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const a = await match(item, 4_000);
    await db
      .prepare("UPDATE match_allocations SET open_before_minor = NULL WHERE match_id = ?1")
      .bind(a.id)
      .run();
    await book(a.id, hoursAgo(72));
    await sync(item, 6_000, hoursAgo(1));
    expect(await staleSettlements(db, nowIso)).toBe(1);
  });
});

describe("outbox payload retention (N3)", () => {
  const NOW = Date.parse("2026-07-20T12:00:00.000Z");
  const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();
  let n = 0;

  /** An outbox row for a freshly claimed match, then moved to `status` at `updatedAt`. */
  async function outbox(status: string, updatedAt: string, kind = "matchset"): Promise<number> {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 100 });
    const m = await match(item, 100);
    expect(await claimMatchForBooking(db, m.id, "booking")).toBe(true);
    const key = `${"k".repeat(60)}${String(++n).padStart(4, "0")}`;
    const r = await db
      .prepare(
        `INSERT INTO exact_write_outbox (match_id, division_id, kind, idempotency_key, payload_json,
           payload_hash, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, '{"v":1,"stage":"plan","name":"Jan de Vries"}', ?5, 'pending', ?6, ?6)`,
      )
      .bind(m.id, w.divisionId, kind, key, "h".repeat(64), updatedAt)
      .run();
    const id = r.meta.last_row_id;
    if (status !== "pending") {
      await db
        .prepare("UPDATE exact_write_outbox SET status = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(id, status, updatedAt)
        .run();
    }
    return id;
  }
  const payload = async (id: number): Promise<string> =>
    (
      await db
        .prepare("SELECT payload_json AS p FROM exact_write_outbox WHERE id = ?1")
        .bind(id)
        .first<{ p: string }>()
    )?.p ?? "";

  it("redacts terminal rows older than 400 days, keeps the row, status, hash and updated_at", async () => {
    const old = await outbox("verified", daysAgo(401));
    const oldGiven = await outbox("given_up", daysAgo(500));
    const oldManual = await outbox("resolved_manually", daysAgo(401));
    const edge = await outbox("verified", daysAgo(400));
    const young = await outbox("verified", daysAgo(399));
    const pending = await outbox("pending", daysAgo(900));
    const failed = await outbox("failed", daysAgo(900));
    const unknown = await outbox("outcome_unknown", daysAgo(900));
    expect(await redactOldOutboxPayloads(db, NOW)).toBe(3);
    for (const id of [old, oldGiven, oldManual]) expect(await payload(id)).toBe(REDACTED_PAYLOAD);
    for (const id of [edge, young, pending, failed, unknown]) {
      expect(await payload(id)).toContain("Jan de Vries");
    }
    expect(
      await db
        .prepare("SELECT status, payload_hash, updated_at FROM exact_write_outbox WHERE id = ?1")
        .bind(old)
        .first(),
    ).toEqual({ status: "verified", payload_hash: "h".repeat(64), updated_at: daysAgo(401) });
    // Second run: nothing left to do.
    expect(await redactOldOutboxPayloads(db, NOW)).toBe(0);
    expect(REDACTED_PAYLOAD).toBe('{"v":1,"stage":"redacted"}');
  });

  it("is bounded: at most the batch size per run, the rest on the next run", async () => {
    expect(OUTBOX_REDACT_BATCH).toBe(200);
    for (let i = 0; i < 5; i++) await outbox("verified", daysAgo(450 + i));
    expect(await redactOldOutboxPayloads(db, NOW, 2)).toBe(2);
    expect(await redactOldOutboxPayloads(db, NOW, 2)).toBe(2);
    expect(await redactOldOutboxPayloads(db, NOW, 2)).toBe(1);
    expect(await redactOldOutboxPayloads(db, NOW, 2)).toBe(0);
  });

  it("the trigger allows only that one change to a finished row", async () => {
    const id = await outbox("verified", daysAgo(401));
    const fail = (set: string): Promise<unknown> =>
      db.prepare(`UPDATE exact_write_outbox SET ${set} WHERE id = ?1`).bind(id).run();
    await expect(fail(`payload_json = '{"v":1,"stage":"none"}'`)).rejects.toThrow(/terminal/);
    await expect(fail(`status = 'pending'`)).rejects.toThrow(/terminal/);
    await expect(
      fail(`payload_json = '{"v":1,"stage":"redacted"}', status = 'given_up'`),
    ).rejects.toThrow(/terminal/);
    await expect(
      fail(`payload_json = '{"v":1,"stage":"redacted"}', updated_at = '2030-01-01T00:00:00.000Z'`),
    ).rejects.toThrow(/terminal/);
    await expect(fail(`payload_hash = '${"z".repeat(64)}'`)).rejects.toThrow(/terminal/);
    // The allowed change works, and cannot be repeated or undone.
    await fail(`payload_json = '{"v":1,"stage":"redacted"}'`);
    await expect(fail(`payload_json = '{"v":1,"stage":"redacted"}'`)).rejects.toThrow(/terminal/);
    await expect(fail(`payload_json = '{"v":1,"stage":"plan"}'`)).rejects.toThrow(/terminal/);
  });

  it("the trigger still locks identity columns of an unfinished row", async () => {
    const id = await outbox("pending", daysAgo(1));
    await expect(
      db.prepare("UPDATE exact_write_outbox SET kind = 'bank_entry' WHERE id = ?1").bind(id).run(),
    ).rejects.toThrow(/terminal/);
    // A pending row's payload is updated by the executor as before.
    await db
      .prepare(
        `UPDATE exact_write_outbox SET payload_json = '{"v":1,"stage":"built"}' WHERE id = ?1`,
      )
      .bind(id)
      .run();
  });
});
