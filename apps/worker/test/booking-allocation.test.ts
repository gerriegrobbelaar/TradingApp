/**
 * Allocation settlement (task M7c, ADR 0043; fixes the double count noted in ADR 0042): the
 * allocation of a match booked in Exact keeps counting against the item's open balance only until
 * the item was re-read from Exact AFTER the booking. The database trigger, the assembly, the review
 * flags and the invariants all use the same rule.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { assembleItems } from "../src/matching/assemble";
import { checkMatchingInvariants } from "../src/matching/invariants";
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

/** The match reached matched_in_exact at BOOKED_AT (through the legal states). */
async function book(matchId: number): Promise<void> {
  expect(await claimMatchForBooking(db, matchId, "booking")).toBe(true);
  await db
    .prepare("UPDATE matches SET exact_state = 'matched_in_exact', booked_at = ?2 WHERE id = ?1")
    .bind(matchId, BOOKED_AT)
    .run();
}

/** The sync wrote the item: Exact's open balance and the stamp of the read that started at `at`. */
async function sync(itemId: number, openMinor: number, at: string): Promise<void> {
  await db
    .prepare("UPDATE open_items SET open_minor = ?2, synced_at = ?3 WHERE id = ?1")
    .bind(itemId, openMinor, at)
    .run();
}

const available = async (itemId: number): Promise<number> => {
  const item = (await assembleItems(db, w.divisionId)).find((i) => i.id === itemId);
  return item === undefined ? 0 : Number(item.openMinor);
};

describe("no double count after the item was re-read from Exact", () => {
  it("steps: open, booked and not yet re-read (still counts), re-read (Exact's balance counts instead)", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    await sync(item, 10_000, BEFORE);
    const a = await match(item, 4_000);
    expect(a.ok).toBe(true);
    expect(await available(item)).toBe(6_000);

    // Booked, but the item has not been read again: A's 4,000 still counts.
    await book(a.id);
    expect(await available(item)).toBe(6_000);
    expect((await match(item, 6_001)).code).toBe("alloc_exceeds_open");

    // A sync that STARTED before the booking (synced_at earlier) says nothing: still counts.
    await sync(item, 10_000, BEFORE);
    expect(await available(item)).toBe(6_000);
    // ... and a stamp equal to the booking time is not "after" it either.
    await sync(item, 10_000, BOOKED_AT);
    expect(await available(item)).toBe(6_000);

    // The item was read after the booking: Exact's open balance (6,000) already has the 4,000.
    await sync(item, 6_000, AFTER);
    expect(await available(item)).toBe(6_000);
    const b = await match(item, 6_000);
    expect(b).toMatchObject({ ok: true });
    expect(await available(item)).toBe(0);
    expect((await match(item, 1)).code).toBe("alloc_exceeds_open");
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("without the settlement rule the second match would have been refused: the trigger says yes only after the re-read", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    await sync(item, 10_000, BEFORE);
    const a = await match(item, 4_000);
    await book(a.id);
    await sync(item, 6_000, AFTER);
    // 4,000 (booked, re-read) + 6,000 would exceed the 6,000 Exact now shows if it still counted.
    expect((await match(item, 6_000)).ok).toBe(true);
  });

  it("there is no window in which the item can be allocated twice (every step, same total)", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    await sync(item, 10_000, BEFORE);
    const a = await match(item, 10_000);
    expect((await match(item, 1)).code).toBe("alloc_exceeds_open"); // claimed by a live match
    const claimed = await claimMatchForBooking(db, a.id, "booking");
    expect(claimed).toBe(true);
    expect((await match(item, 1)).code).toBe("alloc_exceeds_open"); // while booking
    await db
      .prepare("UPDATE matches SET exact_state = 'bank_entry_created' WHERE id = ?1")
      .bind(a.id)
      .run();
    expect((await match(item, 1)).code).toBe("alloc_exceeds_open"); // bank entry created
    await db
      .prepare("UPDATE matches SET exact_state = 'matched_in_exact', booked_at = ?2 WHERE id = ?1")
      .bind(a.id, BOOKED_AT)
      .run();
    expect((await match(item, 1)).code).toBe("alloc_exceeds_open"); // booked, not re-read
    // Re-read: Exact closed the item (fully matched): it cannot be matched at all.
    await db
      .prepare(
        "UPDATE open_items SET open_minor = 0, status = 'closed', synced_at = ?2 WHERE id = ?1",
      )
      .bind(item, AFTER)
      .run();
    expect((await match(item, 1)).code).toBe("item_not_matchable");
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("a match in a failed, unknown or manual state keeps counting (nothing settles it)", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    await sync(item, 10_000, BEFORE);
    const a = await match(item, 4_000);
    await claimMatchForBooking(db, a.id, "booking");
    for (const state of ["outcome_unknown", "manual_required"]) {
      await db.prepare("UPDATE matches SET exact_state = ?2 WHERE id = ?1").bind(a.id, state).run();
      await sync(item, 6_000, AFTER); // even a later read does not release it
      expect(await available(item), state).toBe(2_000);
      expect((await match(item, 2_001)).code, state).toBe("alloc_exceeds_open");
    }
  });
});

describe("review flags and invariants use the same rule", () => {
  it("a not yet booked match is not flagged over_allocated because of a booked one Exact already counted", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    await sync(item, 10_000, BEFORE);
    const a = await match(item, 4_000);
    const c = await match(item, 6_000);
    expect(c.ok).toBe(true);
    await book(a.id);
    // Not re-read yet: 4,000 + 6,000 = 10,000 <= 10,000.
    expect(await flagMatchesForReview(db, AFTER)).toBe(0);
    // Re-read: Exact shows 6,000 open (A's 4,000 is in it); C's 6,000 fits exactly.
    await sync(item, 6_000, AFTER);
    expect(await flagMatchesForReview(db, AFTER)).toBe(0);
    expect(await checkMatchingInvariants(db)).toEqual([]);
    // Exact's balance falls further (paid elsewhere): now C IS over-allocated, and flagged.
    await sync(item, 5_000, "2026-07-15T14:00:00.000Z");
    expect(await flagMatchesForReview(db, "2026-07-15T14:00:00.000Z")).toBe(1);
    const row = await db
      .prepare("SELECT review_reason FROM matches WHERE id = ?1")
      .bind(c.id)
      .first<{ review_reason: string | null }>();
    expect(row?.review_reason).toBe("over_allocated");
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("the invariant check catches an over-allocation the rule does not excuse", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    await sync(item, 10_000, BEFORE);
    await match(item, 4_000);
    await match(item, 6_000);
    // Exact's balance falls without the flag run: an unflagged over-allocation is reported.
    await sync(item, 5_000, AFTER);
    expect((await checkMatchingInvariants(db)).map((v) => v.code)).toContain(
      "item_over_allocated_unflagged",
    );
  });

  it("matched_in_exact without booked_at is refused by the database and reported by the check", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 1_000 });
    const a = await match(item, 1_000);
    await claimMatchForBooking(db, a.id, "booking");
    await expect(
      db
        .prepare("UPDATE matches SET exact_state = 'matched_in_exact' WHERE id = ?1")
        .bind(a.id)
        .run(),
    ).rejects.toThrow(/bad_match_row/);
  });
});

describe("legal transitions only", () => {
  it("refuses illegal exact_state moves and any move of an undone match", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 1_000 });
    const a = await match(item, 1_000);
    const set = (state: string) =>
      db.prepare("UPDATE matches SET exact_state = ?2 WHERE id = ?1").bind(a.id, state).run();
    await expect(set("matched_in_exact")).rejects.toThrow(/bad_transition|bad_match_row/);
    await expect(set("bank_entry_created")).rejects.toThrow(/bad_transition/);
    await expect(set("booked")).rejects.toThrow(/bad_transition/);
    await claimMatchForBooking(db, a.id, "booking");
    await expect(set("not_booked")).rejects.toThrow(/bad_transition/);
    await set("booking_failed");
    await expect(set("bank_entry_created")).rejects.toThrow(/bad_transition/);
    await set("booking");
    await set("manual_required");
    await expect(set("booking")).rejects.toThrow(/bad_transition/);
  });

  it("booked_at is written once", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 1_000 });
    const a = await match(item, 1_000);
    await book(a.id);
    await expect(
      db
        .prepare("UPDATE matches SET booked_at = '2030-01-01T00:00:00.000Z' WHERE id = ?1")
        .bind(a.id)
        .run(),
    ).rejects.toThrow(/immutable/);
  });
});
