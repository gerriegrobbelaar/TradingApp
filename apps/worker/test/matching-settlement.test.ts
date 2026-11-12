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
import { withoutTriggers } from "./booking-helpers";

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

/**
 * A pre-0025 allocation: its baseline is NULL even though the match was claimed (the claim trigger
 * sets it now, and the column is locked afterwards, so the test lifts the lock for one UPDATE).
 */
async function forceNullBaseline(matchId: number): Promise<void> {
  const name = "match_allocations_guard_open_before";
  const row = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1")
    .bind(name)
    .first<{ sql: string }>();
  if (!row) throw new Error("trigger missing");
  await db.prepare(`DROP TRIGGER ${name}`).run();
  try {
    await db
      .prepare("UPDATE match_allocations SET open_before_minor = NULL WHERE match_id = ?1")
      .bind(matchId)
      .run();
  } finally {
    await db.prepare(row.sql).run();
  }
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
    await book(a.id);
    await forceNullBaseline(a.id);
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

  it("mutation check: the 0023 rule (re-read only) would release on a lagging read", async () => {
    const { item } = await booked();
    await sync(item, 10_000, AFTER);
    const old0023 =
      "m.undone_at IS NULL AND NOT (m.exact_state = 'matched_in_exact' AND m.booked_at IS NOT NULL AND m.booked_at < oi.synced_at)";
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(4_000); // real rule: still counts
    expect(await countingSum(item, old0023)).toBe(0); // old rule: released, a duplicate could be allocated
  });
});

/** Sum of the allocations on `item` that count under `pred` (aliases m, a, oi). */
async function countingSum(item: number, pred: string): Promise<number> {
  return (
    (
      await db
        .prepare(
          `SELECT COALESCE(SUM(a.allocated_minor), 0) AS n FROM match_allocations a
             JOIN matches m ON m.id = a.match_id JOIN open_items oi ON oi.id = a.open_item_id
           WHERE a.open_item_id = ?1 AND ${pred}`,
        )
        .bind(item)
        .first<{ n: number }>()
    )?.n ?? -1
  );
}

/** The per-allocation rule (builder's first version): each allocation compared alone. */
const PER_ALLOCATION =
  "m.undone_at IS NULL AND NOT (m.exact_state = 'matched_in_exact' AND m.booked_at IS NOT NULL AND m.booked_at < oi.synced_at AND a.open_before_minor IS NOT NULL AND (oi.status <> 'open' OR oi.open_minor = 0 OR ABS(a.open_before_minor) - ABS(oi.open_minor) >= a.allocated_minor))";

describe("several booked allocations on one item (aggregate rule)", () => {
  /** Item of 300 with two matches A and B of 100, both booked; returns their ids. */
  async function twoBooked(
    bookA = BOOKED_AT,
    bookB = "2026-07-15T12:30:00.000Z",
  ): Promise<{ item: number; a: number; b: number }> {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 300 });
    await sync(item, 300, BEFORE);
    const a = await match(item, 100);
    const b = await match(item, 100);
    expect(a.ok && b.ok).toBe(true);
    await book(a.id, bookA);
    await book(b.id, bookB);
    return { item, a: a.id, b: b.id };
  }

  it("worst case: one re-read shows only ONE MatchSet; only one allocation is released", async () => {
    const { item } = await twoBooked();
    await sync(item, 200, AFTER); // fell by 100: A or B is in Exact, not both
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(100);
    expect(await available(item)).toBe(100); // 200 - 100 still pending = what is truly free
    // The trigger agrees: 100 fits, 101 does not.
    expect((await match(item, 101)).code).toBe("alloc_exceeds_open");
    expect((await match(item, 100)).ok).toBe(true);
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("mutation check: compared one by one, both would be released and 100 allocated twice", async () => {
    const { item } = await twoBooked();
    await sync(item, 200, AFTER);
    expect(await countingSum(item, PER_ALLOCATION)).toBe(0);
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(100);
  });

  it("both MatchSets visible: both released", async () => {
    const { item } = await twoBooked();
    await sync(item, 100, AFTER);
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(0);
    expect(await available(item)).toBe(100);
  });

  it("lagging read for both: both count", async () => {
    const { item } = await twoBooked();
    await sync(item, 300, AFTER);
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(200);
    expect(await available(item)).toBe(100);
  });

  it("same booked_at: the allocation id breaks the tie (exactly one released)", async () => {
    const { item, a } = await twoBooked(BOOKED_AT, BOOKED_AT);
    await sync(item, 200, AFTER);
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(100);
    const released = await db
      .prepare(
        `SELECT a.match_id AS id FROM match_allocations a JOIN matches m ON m.id = a.match_id
           JOIN open_items oi ON oi.id = a.open_item_id
         WHERE a.open_item_id = ?1 AND NOT (${SETTLEMENT_PREDICATE})`,
      )
      .bind(item)
      .all<{ id: number }>();
    expect(released.results.map((r) => r.id)).toEqual([a]);
  });

  it("sequential part payments: a later baseline excludes the earlier, already visible allocation", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 300 });
    await sync(item, 300, BEFORE);
    const a = await match(item, 100);
    await book(a.id, BOOKED_AT);
    await sync(item, 200, AFTER); // A visible, released
    expect(await available(item)).toBe(200);
    const b = await match(item, 100); // baseline 200 (recorded at creation and at the claim)
    await book(b.id, "2026-07-15T14:00:00.000Z");
    const later = "2026-07-15T15:00:00.000Z";
    await sync(item, 200, later); // B lags
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(100);
    expect(await available(item)).toBe(100);
    await sync(item, 100, later); // B visible
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(0);
    expect(await available(item)).toBe(100);
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("an undone or not yet booked allocation does not take part in the sum", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 300 });
    await sync(item, 300, BEFORE);
    const a = await match(item, 100);
    const pending = await match(item, 100); // stays not_booked: counts in full
    await book(a.id);
    await sync(item, 200, AFTER);
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(100); // pending only
    expect(pending.ok).toBe(true);
  });

  it("a balance that ROSE after the booking (credit note reversed, correction) keeps counting", async () => {
    const { item } = await booked(); // 10,000, A = 4,000
    await sync(item, 12_000, AFTER); // A visible (6,000) but +6,000 correction
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(4_000);
    expect(await available(item)).toBe(8_000); // conservative: 4,000 less than truly free
  });

  it("credit notes (negative balances) compare magnitudes", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: -500 }); // customer credit note
    await sync(item, -500, BEFORE);
    const txId = await addTx({
      accountId: w.accountId,
      connectionId: w.revolutConnectionId,
      amountMinor: -200,
    });
    const r = await applyMatch(db, {
      txId,
      divisionId: w.divisionId,
      txAmountMinor: 200,
      currency: "EUR",
      source: "manual",
      ledgerAccountCode: null,
      score: null,
      rule: null,
      note: null,
      actor: "fin@camelthorncapital.com",
      allocations: [{ openItemId: item, allocatedMinor: 200, remainingAfter: null }],
      nowIso: "2026-07-15T10:00:00.000Z",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await book(r.matchId);
    await sync(item, -500, AFTER);
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(200);
    await sync(item, -300, AFTER);
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(0);
  });
});

/**
 * The whole state table: every combination of the inputs the predicate reads, against an
 * independent TypeScript model of the rule (one allocation per item, so the sum is the allocation).
 */
describe("state table: one booked or unbooked allocation", () => {
  const states = ["not_booked", "booking", "matched_in_exact"] as const;
  const syncs = [
    ["before", BEFORE],
    ["equal", BOOKED_AT],
    ["after", AFTER],
  ] as const;
  const balances = [10_000, 8_000, 6_001, 6_000, 5_000, 12_000, 0] as const;
  const closedFlags = [false, true] as const;
  const baselines = ["known", "null"] as const;

  const model = (o: {
    state: (typeof states)[number];
    synced: (typeof syncs)[number][0];
    open: number;
    closed: boolean;
    baseline: (typeof baselines)[number];
  }): boolean => {
    const released =
      o.state === "matched_in_exact" &&
      o.synced === "after" &&
      o.baseline === "known" &&
      (o.closed || o.open === 0 || 10_000 - Math.abs(o.open) >= 4_000);
    return !released; // counts
  };

  it("matches the model in all 252 states", async () => {
    let checked = 0;
    for (const state of states) {
      for (const baseline of baselines) {
        const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
        await sync(item, 10_000, BEFORE);
        const a = await match(item, 4_000);
        if (state !== "not_booked") {
          expect(await claimMatchForBooking(db, a.id, "booking")).toBe(true);
        }
        if (state === "matched_in_exact") {
          await db
            .prepare(
              "UPDATE matches SET exact_state = 'matched_in_exact', booked_at = ?2 WHERE id = ?1",
            )
            .bind(a.id, BOOKED_AT)
            .run();
        }
        if (baseline === "null") await forceNullBaseline(a.id);
        for (const [synced, at] of syncs) {
          for (const open of balances) {
            for (const closed of closedFlags) {
              await sync(item, open, at, closed ? "closed" : "open");
              const counts = (await countingSum(item, SETTLEMENT_PREDICATE)) === 4_000;
              const want = model({ state, synced, open, closed, baseline });
              expect(counts, JSON.stringify({ state, baseline, synced, open, closed })).toBe(want);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBe(3 * 2 * 3 * 7 * 2);
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

  it("is locked once the match left not_booked: recordOpenBefore after the claim throws", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const a = await match(item, 4_000);
    expect(await claimMatchForBooking(db, a.id, "booking")).toBe(true);
    await expect(recordOpenBefore(db, a.id)).rejects.toThrow(/immutable/);
    await expect(
      db
        .prepare("UPDATE match_allocations SET open_before_minor = 1 WHERE match_id = ?1")
        .bind(a.id)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it("the claim itself records the baseline (no booking path can forget it)", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const item2 = await addItem({ divisionId: w.divisionId, openMinor: 3_000 });
    const txId = await addTx({
      accountId: w.accountId,
      connectionId: w.revolutConnectionId,
      amountMinor: 5_000,
    });
    const r = await applyMatch(db, {
      txId,
      divisionId: w.divisionId,
      txAmountMinor: 5_000,
      currency: "EUR",
      source: "manual",
      ledgerAccountCode: null,
      score: null,
      rule: null,
      note: null,
      actor: "fin@camelthorncapital.com",
      allocations: [
        { openItemId: item, allocatedMinor: 4_000, remainingAfter: null },
        { openItemId: item2, allocatedMinor: 1_000, remainingAfter: null },
      ],
      nowIso: "2026-07-15T10:00:00.000Z",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Paid elsewhere in the meantime (Exact read): 10,000 -> 7,000 and 3,000 -> 2,500.
    await sync(item, 7_000, BEFORE);
    await sync(item2, 2_500, BEFORE);
    // Two allocations: D1 counts the trigger rows too, the claim still reports one winner.
    expect(await claimMatchForBooking(db, r.matchId, "booking")).toBe(true);
    expect(await claimMatchForBooking(db, r.matchId, "booking")).toBe(false);
    const rows = await db
      .prepare(
        "SELECT open_item_id AS i, open_before_minor AS v FROM match_allocations WHERE match_id = ?1 ORDER BY id",
      )
      .bind(r.matchId)
      .all<{ i: number; v: number }>();
    expect(rows.results).toEqual([
      { i: item, v: 7_000 },
      { i: item2, v: 2_500 },
    ]);
    // Without the refresh the stale 10,000 baseline would let a lagging read (7,000, i.e. only
    // the outside payment) release the allocation: with it, the allocation keeps counting.
    await db
      .prepare("UPDATE matches SET exact_state = 'matched_in_exact', booked_at = ?2 WHERE id = ?1")
      .bind(r.matchId, BOOKED_AT)
      .run();
    await sync(item, 7_000, AFTER);
    expect(await countingSum(item, SETTLEMENT_PREDICATE)).toBe(4_000);
  });

  it("a refused claim (undone match) leaves the baseline alone", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const a = await match(item, 4_000);
    await db
      .prepare("UPDATE matches SET undone_at = ?2, undone_by = 'x' WHERE id = ?1")
      .bind(a.id, BEFORE)
      .run();
    await sync(item, 1_000, BEFORE);
    expect(await claimMatchForBooking(db, a.id, "booking")).toBe(false);
    expect(
      await db
        .prepare("SELECT open_before_minor AS v FROM match_allocations WHERE match_id = ?1")
        .bind(a.id)
        .first(),
    ).toEqual({ v: 10_000 });
  });

  it("the other allocation fields stay immutable", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const a = await match(item, 4_000);
    for (const set of [
      "allocated_minor = 1",
      "open_item_id = 1",
      "currency = 'USD'",
      "id = id + 1000",
      "match_id = match_id",
      "remaining_minor_after = 5",
    ]) {
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

  it("no other copy of the rule in src: open_before_minor and the re-read test live in settlement.ts", () => {
    const files = import.meta.glob("../src/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const offenders: string[] = [];
    for (const [name, text] of Object.entries(files) as [string, string][]) {
      if (name.endsWith("/matching/settlement.ts")) continue;
      // store.ts writes the baseline at creation (INSERT), nothing else may read or write it.
      const uses = [...text.matchAll(/open_before_minor/g)].length;
      if (uses > 0 && !(name.endsWith("/matching/store.ts") && uses === 1)) {
        offenders.push(`${name}: open_before_minor x${uses}`);
      }
      if (/booked_at\s*<\s*\w+\.synced_at|synced_at\s*>\s*\w+\.booked_at/.test(text)) {
        offenders.push(`${name}: its own re-read test`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the migration has exactly one copy of the predicate (the over-allocation check)", () => {
    const n = norm(migration0025).split(norm(SETTLEMENT_PREDICATE)).length - 1;
    expect(n).toBe(1);
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
    await book(a.id, hoursAgo(72));
    await forceNullBaseline(a.id);
    await sync(item, 6_000, hoursAgo(1));
    expect(await staleSettlements(db, nowIso)).toBe(1);
  });
});

describe("outbox payload retention (N3)", () => {
  const NOW = Date.parse("2026-07-20T12:00:00.000Z");
  const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();
  let n = 0;

  /** An outbox row for a freshly claimed match, then moved to `status` at `updatedAt`. */
  async function outbox(
    status: string,
    updatedAt: string,
    kind = "matchset",
    payloadJson = '{"v":1,"stage":"plan","name":"Jan de Vries"}',
  ): Promise<number> {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 100 });
    const m = await match(item, 100);
    expect(await claimMatchForBooking(db, m.id, "booking")).toBe(true);
    const key = `${"k".repeat(60)}${String(++n).padStart(4, "0")}`;
    const r = await db
      .prepare(
        `INSERT INTO exact_write_outbox (match_id, division_id, kind, idempotency_key, payload_json,
           payload_hash, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?7, ?5, 'pending', ?6, ?6)`,
      )
      .bind(m.id, w.divisionId, kind, key, "h".repeat(64), updatedAt, payloadJson)
      .run();
    const id = r.meta.last_row_id;
    if (status !== "pending") {
      // Setup only: forced into the status (migration 0024's transition guard is lifted for it).
      await withoutTriggers(["outbox_guard_status"], () =>
        db
          .prepare("UPDATE exact_write_outbox SET status = ?2, updated_at = ?3 WHERE id = ?1")
          .bind(id, status, updatedAt)
          .run(),
      );
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
    expect(REDACTED_PAYLOAD).toBe('{"v":1,"stage":"redacted","input":{"bankEntryNumber":null}}');
  });

  it("keeps only the bank entry number, which the executor's 'bank line in use' check reads", async () => {
    const id = await outbox(
      "verified",
      daysAgo(401),
      "matchset",
      '{"v":1,"stage":"built","input":{"bankEntryNumber":4711,"accountName":"Jan de Vries"},"builtHash":"x"}',
    );
    expect(await redactOldOutboxPayloads(db, NOW)).toBe(1);
    const p = await payload(id);
    expect(p).toBe('{"v":1,"stage":"redacted","input":{"bankEntryNumber":4711}}');
    expect(p).not.toContain("Jan");
    // The same query text as booking/executor.ts ("Another MatchSet of ours must not already use
    // this bank line") still finds the old row.
    const used = await db
      .prepare(
        `SELECT 1 AS x FROM exact_write_outbox
         WHERE kind = 'matchset' AND division_id = ?1 AND match_id <> ?2
           AND json_extract(payload_json, '$.input.bankEntryNumber') = ?3 AND status <> 'given_up' LIMIT 1`,
      )
      .bind(w.divisionId, 0, 4711)
      .first();
    expect(used).toEqual({ x: 1 });
  });

  it("costs one statement per run, and the tick runs it only in the housekeeping minute", async () => {
    let statements = 0;
    const spy = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === "prepare") {
          return (sql: string) => {
            statements++;
            return target.prepare(sql);
          };
        }
        const v: unknown = Reflect.get(target, prop, recv);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    expect(await redactOldOutboxPayloads(spy, NOW)).toBe(0);
    expect(statements).toBe(1);
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
    const R = `'${REDACTED_PAYLOAD}'`;
    // Several guards may refuse first (0024 adds the status table and the sent facts).
    const REFUSED = /booking_err:(terminal|bad_transition|sent_facts)/;
    await expect(fail(`payload_json = '{"v":1,"stage":"none"}'`)).rejects.toThrow(REFUSED);
    // The OLD fixed placeholder, or the redacted form with anything else kept, is refused.
    await expect(fail(`payload_json = '{"v":1,"stage":"redacted"}'`)).rejects.toThrow(REFUSED);
    await expect(
      fail(
        `payload_json = '{"v":1,"stage":"redacted","input":{"bankEntryNumber":null},"name":"Jan"}'`,
      ),
    ).rejects.toThrow(REFUSED);
    await expect(
      fail(`payload_json = '{"v":1,"stage":"redacted","input":{"bankEntryNumber":99}}'`),
    ).rejects.toThrow(REFUSED);
    await expect(fail(`status = 'pending'`)).rejects.toThrow(REFUSED);
    for (const other of [
      "status = 'given_up'",
      "updated_at = '2030-01-01T00:00:00.000Z'",
      "attempts = attempts + 1",
      "last_error_code = 'x'",
      "exact_ref = 'x'",
      "needs_probe = 1",
      "next_attempt_at = 'x'",
      "claimed_at = 'x'",
      "lease_expires_at = 'x'",
      "op_nonce = 'x'",
      "journal_code = 'BNK'",
      "created_at = 'x'",
      `payload_hash = '${"z".repeat(64)}'`,
      "id = id + 1000",
      // columns of migration 0024
      "creates_bank_entries = 1",
      "admin_resolved_by = 'a@b.c'",
      "admin_resolved_at = 'x'",
    ]) {
      await expect(fail(`payload_json = ${R}, ${other}`), other).rejects.toThrow(REFUSED);
    }
    await expect(fail(`payload_hash = '${"z".repeat(64)}'`)).rejects.toThrow(REFUSED);
    // The allowed change works, and cannot be repeated or undone.
    await fail(`payload_json = ${R}`);
    await expect(fail(`payload_json = ${R}`)).rejects.toThrow(REFUSED);
    await expect(fail(`payload_json = '{"v":1,"stage":"plan"}'`)).rejects.toThrow(REFUSED);
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
