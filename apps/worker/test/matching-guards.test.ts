/**
 * Adversarial review of the matching data model (M7b review, ADR 0042): every database guard is
 * attacked with direct SQL, writers are interleaved (job, person, ignore, undo, Exact sync, Revolut
 * ingest, the future booking claim) and after each scenario `checkMatchingInvariants` must hold.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { amsterdamDay, assembleTransactions, toMatchTx } from "../src/matching/assemble";
import { checkMatchingInvariants } from "../src/matching/invariants";
import { autoInputGap, dropFalseClaim, openItemsFreshness, runMatching } from "../src/matching/run";
import {
  applyMatch,
  claimMatchForBooking,
  flagMatchesForReview,
  ignoreTransaction,
  undoMatch,
  type ApplyMatchInput,
} from "../src/matching/store";
import { seedDefaultJobs } from "../src/jobs/defaults";
import {
  addItem,
  addRelation,
  addTx,
  CUSTOMER_IBAN,
  db,
  enableAuto,
  jobContext,
  liveMatches,
  markOpenItemsSynced,
  NOW,
  resetWorld,
  SETTING_AUTO,
  setSetting,
  SUPPLIER_IBAN,
  txStatus,
  type World,
} from "./matching-helpers";
import { addDivision, auditRows } from "./sync-helpers";

let w: World;
beforeEach(async () => {
  w = await resetWorld();
});

const tx = (o: Partial<Parameters<typeof addTx>[0]> & { amountMinor: number }) =>
  addTx({ accountId: w.accountId, connectionId: w.revolutConnectionId, ...o });

const input = (
  txId: number,
  allocations: [number, number][],
  amount: number,
  over: Partial<ApplyMatchInput> = {},
): ApplyMatchInput => ({
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
  allocations: allocations.map(([openItemId, allocatedMinor]) => ({
    openItemId,
    allocatedMinor,
    remainingAfter: null,
  })),
  nowIso: new Date(NOW).toISOString(),
  ...over,
});

const count = async (sql: string): Promise<number> =>
  (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;

/** `synthetic`: invariant codes a test that claims a match WITHOUT the outbox (store.claimMatchForBooking) expects. */
async function consistent(synthetic: string[] = []): Promise<void> {
  expect((await checkMatchingInvariants(db)).filter((v) => !synthetic.includes(v.code))).toEqual(
    [],
  );
}

/** A perfect receivable payment (rule 1 + IBAN) that the engine decides automatically. */
async function perfect(amount = 12_345): Promise<{ itemId: number; txId: number }> {
  const rel = await addRelation({ divisionId: w.divisionId, ibans: [CUSTOMER_IBAN] });
  const itemId = await addItem({
    divisionId: w.divisionId,
    invoiceNumber: "INV-2026-0042",
    openMinor: amount,
    relationExactId: rel.exactId,
  });
  const txId = await tx({
    amountMinor: amount,
    reference: "Payment INV-2026-0042",
    counterpartyIban: CUSTOMER_IBAN,
    counterpartyName: "Acme B.V.",
  });
  return { itemId, txId };
}

/** A D1 handle that runs `hook` once, right before its first batch (a writer that read, then stalls). */
function stallingDb(hook: () => Promise<unknown>): D1Database {
  let done = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await hook();
          }
          return target.batch(stmts);
        };
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** A D1 handle that counts executed reads/writes (all, first, run, raw) and batches. */
function countingDb(): { db: D1Database; reads: () => number; batches: () => number } {
  let reads = 0;
  let batches = 0;
  const wrapStmt = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, prop) {
        const v = Reflect.get(target, prop) as unknown;
        if (prop === "bind") {
          return (...a: unknown[]) =>
            wrapStmt((target.bind as (...x: unknown[]) => D1PreparedStatement)(...a));
        }
        if (prop === "all" || prop === "first" || prop === "run" || prop === "raw") {
          return (...a: unknown[]) => {
            reads++;
            return (v as (...x: unknown[]) => unknown).apply(target, a);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrapStmt(target.prepare(sql));
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          batches++;
          return target.batch(stmts);
        };
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: proxy, reads: () => reads, batches: () => batches };
}

const ctxWith = (d: D1Database) => jobContext({ env: { ...env, DB: d } });

// ---- (1) database guards, attacked with direct SQL -------------------------------------------

describe("database guards (direct SQL)", () => {
  const insertMatch = (txId: number, amount: number, extra = "", ledger: string | null = null) =>
    db
      .prepare(
        `INSERT INTO matches (bank_transaction_id, division_id, source, ledger_account_code, amount_minor,
           currency, created_by ${extra ? `, ${extra.split("=")[0]}` : ""})
         VALUES (?1, ?2, ?3, ?4, ?5, 'EUR', 'x' ${extra ? `, ${extra.split("=")[1]}` : ""})`,
      )
      .bind(txId, w.divisionId, ledger === null ? "manual" : "ledger", ledger, amount)
      .run();
  const alloc = (matchId: number, item: number, amount: number, cur = "EUR") =>
    db
      .prepare(
        "INSERT INTO match_allocations (match_id, open_item_id, allocated_minor, currency) VALUES (?1, ?2, ?3, ?4)",
      )
      .bind(matchId, item, amount, cur)
      .run();

  it("over-allocation is refused for an invoice, a bill and a credit note, across matches", async () => {
    const inv = await addItem({ divisionId: w.divisionId, openMinor: 1_000 });
    const bill = await addItem({ divisionId: w.divisionId, kind: "bill", openMinor: 1_000 });
    const credit = await addItem({ divisionId: w.divisionId, openMinor: -1_000 });
    const tIn = await tx({ amountMinor: 1_001 });
    const tOut = await tx({ amountMinor: -1_001 });
    const tOut2 = await tx({ amountMinor: -1_001 });
    const mIn = (await insertMatch(tIn, 1_001)).meta.last_row_id;
    await expect(alloc(mIn, inv, 1_001)).rejects.toThrow(/alloc_exceeds_open/);
    const mOut = (await insertMatch(tOut, 1_001)).meta.last_row_id;
    await expect(alloc(mOut, bill, 1_001)).rejects.toThrow(/alloc_exceeds_open/);
    await alloc(mOut, credit, 600);
    const mOut2 = (await insertMatch(tOut2, 1_001)).meta.last_row_id;
    // 600 already allocated to the credit note by another live match: 401 more passes 1,000.
    await expect(alloc(mOut2, credit, 401)).rejects.toThrow(/alloc_exceeds_open/);
    await alloc(mOut2, credit, 400);
    await expect(alloc(mOut2, bill, 602)).rejects.toThrow(/alloc_exceeds_tx/);
  });

  it("zero or negative allocations and amounts are refused by CHECKs", async () => {
    const inv = await addItem({ divisionId: w.divisionId, openMinor: 1_000 });
    const t = await tx({ amountMinor: 500 });
    const m = (await insertMatch(t, 500)).meta.last_row_id;
    await expect(alloc(m, inv, 0)).rejects.toThrow(/CHECK/);
    await expect(alloc(m, inv, -5)).rejects.toThrow(/CHECK/);
    const t0 = await tx({ amountMinor: 0 });
    await expect(insertMatch(t0, 0)).rejects.toThrow();
  });

  it("one live match per line; an undone match never revives or changes", async () => {
    const t = await tx({ amountMinor: 500 });
    const m = (await insertMatch(t, 500, "", "4500")).meta.last_row_id;
    await expect(insertMatch(t, 500, "", "4500")).rejects.toThrow(/UNIQUE|tx_not_matchable/);
    await db
      .prepare("UPDATE matches SET undone_at = 'a', undone_by = 'x' WHERE id = ?1")
      .bind(m)
      .run();
    await expect(
      db
        .prepare("UPDATE matches SET undone_at = NULL, undone_by = NULL WHERE id = ?1")
        .bind(m)
        .run(),
    ).rejects.toThrow(/cannot_revive/);
    await expect(
      db.prepare("UPDATE matches SET undone_at = 'b' WHERE id = ?1").bind(m).run(),
    ).rejects.toThrow(/cannot_revive/);
    for (const set of [
      "amount_minor = 499",
      "currency = 'USD'",
      "division_id = division_id + 1",
      "bank_transaction_id = bank_transaction_id + 1",
      "source = 'auto'",
      "ledger_account_code = '9999'",
    ]) {
      await expect(
        db.prepare(`UPDATE matches SET ${set} WHERE id = ?1`).bind(m).run(),
        set,
      ).rejects.toThrow(/match_err:(immutable|cannot_revive)|FOREIGN KEY/);
    }
  });

  it("a match cannot be inserted already undone, booked or flagged", async () => {
    const t = await tx({ amountMinor: 500 });
    await expect(insertMatch(t, 500, "exact_state='booked'", "4500")).rejects.toThrow(
      /bad_match_row/,
    );
    await expect(insertMatch(t, 500, "review_reason='over_allocated'", "4500")).rejects.toThrow(
      /bad_match_row|CHECK/,
    );
  });

  it("closed, other-division, other-currency items and wrong directions are refused", async () => {
    const closed = await addItem({ divisionId: w.divisionId, openMinor: 100, status: "closed" });
    const zero = await addItem({ divisionId: w.divisionId, openMinor: 0 });
    const other = await addDivision();
    const foreign = await addItem({ divisionId: other.id, openMinor: 100 });
    const usd = await addItem({ divisionId: w.divisionId, openMinor: 100, currency: "USD" });
    const bill = await addItem({ divisionId: w.divisionId, kind: "bill", openMinor: 100 });
    const custCredit = await addItem({ divisionId: w.divisionId, openMinor: -100 });
    const suppCredit = await addItem({ divisionId: w.divisionId, kind: "bill", openMinor: -100 });
    const inv = await addItem({ divisionId: w.divisionId, openMinor: 100 });
    const tIn = await tx({ amountMinor: 100 });
    const tOut = await tx({ amountMinor: -100 });
    const mIn = (await insertMatch(tIn, 100)).meta.last_row_id;
    const mOut = (await insertMatch(tOut, 100)).meta.last_row_id;
    for (const item of [closed, zero, foreign, usd]) {
      await expect(alloc(mIn, item, 50)).rejects.toThrow(/item_not_matchable/);
    }
    await expect(alloc(mIn, usd, 50, "USD")).rejects.toThrow(/item_not_matchable/);
    // Money in pays invoices and supplier credit notes; money out pays bills and customer credit notes.
    await expect(alloc(mIn, bill, 50)).rejects.toThrow(/direction_mismatch/);
    await expect(alloc(mIn, custCredit, 50)).rejects.toThrow(/direction_mismatch/);
    await expect(alloc(mOut, inv, 50)).rejects.toThrow(/direction_mismatch/);
    await expect(alloc(mOut, suppCredit, 50)).rejects.toThrow(/direction_mismatch/);
    await alloc(mIn, suppCredit, 50);
    await alloc(mIn, inv, 50);
    await alloc(mOut, bill, 50);
    await alloc(mOut, custCredit, 50);
    // Allocations never change once written.
    await expect(
      db.prepare("UPDATE match_allocations SET allocated_minor = 1").run(),
    ).rejects.toThrow(/immutable/);
  });

  it("a ledger match has no allocations; an allocation needs a live match", async () => {
    const inv = await addItem({ divisionId: w.divisionId, openMinor: 100 });
    const t = await tx({ amountMinor: 100 });
    const m = (await insertMatch(t, 100, "", "4500")).meta.last_row_id;
    await expect(alloc(m, inv, 100)).rejects.toThrow(/alloc_on_ledger_match/);
    const t2 = await tx({ amountMinor: 100 });
    const m2 = (await insertMatch(t2, 100)).meta.last_row_id;
    await db
      .prepare("UPDATE matches SET undone_at = 'a', undone_by = 'x' WHERE id = ?1")
      .bind(m2)
      .run();
    await expect(alloc(m2, inv, 100)).rejects.toThrow(/match_not_live/);
  });

  it("a line with a state conflict, or an administration no longer synced, cannot be matched", async () => {
    const t = await tx({ amountMinor: 100, stateConflict: true });
    await expect(insertMatch(t, 100, "", "4500")).rejects.toThrow(/tx_not_matchable/);
    const t2 = await tx({ amountMinor: 100 });
    await db
      .prepare("UPDATE divisions SET sync_enabled = 0 WHERE id = ?1")
      .bind(w.divisionId)
      .run();
    await expect(insertMatch(t2, 100, "", "4500")).rejects.toThrow(/division_inactive/);
    await db
      .prepare("UPDATE divisions SET sync_enabled = 1 WHERE id = ?1")
      .bind(w.divisionId)
      .run();
    await db
      .prepare("UPDATE connections SET status = 'disabled' WHERE id = ?1")
      .bind(w.exactConnectionId)
      .run();
    await expect(insertMatch(t2, 100, "", "4500")).rejects.toThrow(/division_inactive/);
  });

  it("the money of a matched line never changes, and its status follows the match", async () => {
    const inv = await addItem({ divisionId: w.divisionId, openMinor: 100 });
    const t = await tx({ amountMinor: 100 });
    const res = await applyMatch(db, input(t, [[inv, 100]], 100));
    expect(res.ok).toBe(true);
    for (const set of ["amount_minor = 99", "currency = 'USD'"]) {
      await expect(
        db.prepare(`UPDATE bank_transactions SET ${set} WHERE id = ?1`).bind(t).run(),
      ).rejects.toThrow(/tx_frozen/);
    }
    // Same values are fine (the ingest rewrites a frozen row with its stored values).
    await db.prepare("UPDATE bank_transactions SET amount_minor = 100 WHERE id = ?1").bind(t).run();
    for (const status of ["unmatched", "suggested", "ignored"]) {
      await expect(
        db
          .prepare("UPDATE bank_transactions SET match_status = ?2 WHERE id = ?1")
          .bind(t, status)
          .run(),
      ).rejects.toThrow(/status_mismatch/);
    }
    const t2 = await tx({ amountMinor: 5 });
    await expect(
      db
        .prepare("UPDATE bank_transactions SET match_status = 'matched' WHERE id = ?1")
        .bind(t2)
        .run(),
    ).rejects.toThrow(/status_mismatch/);
    // The account mapping cannot move or disappear under the live match.
    const other = await addDivision();
    await expect(
      db
        .prepare("UPDATE bank_account_exact_map SET division_id = ?2 WHERE bank_account_id = ?1")
        .bind(w.accountId, other.id)
        .run(),
    ).rejects.toThrow(/has_live_matches/);
    await expect(
      db
        .prepare("DELETE FROM bank_account_exact_map WHERE bank_account_id = ?1")
        .bind(w.accountId)
        .run(),
    ).rejects.toThrow(/has_live_matches/);
    // Journal and GL account may change (no booking yet).
    await db
      .prepare("UPDATE bank_account_exact_map SET journal_code = '91' WHERE bank_account_id = ?1")
      .bind(w.accountId)
      .run();
    await consistent();
  });

  it("a trigger abort rolls back the WHOLE batch: no match, no audit, no status change", async () => {
    const a = await addItem({ divisionId: w.divisionId, openMinor: 600 });
    const b = await addItem({ divisionId: w.divisionId, openMinor: 300 });
    const t = await tx({ amountMinor: 1_000 });
    const before = (await auditRows("match.manual")).length;
    // The first allocation is fine; the second passes item b's balance -> everything is undone.
    expect(
      await applyMatch(
        db,
        input(
          t,
          [
            [a, 600],
            [b, 400],
          ],
          1_000,
        ),
      ),
    ).toEqual({
      ok: false,
      code: "alloc_exceeds_open",
    });
    expect(await liveMatches()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM matches")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM match_allocations")).toBe(0);
    expect(await txStatus(t)).toBe("unmatched");
    expect((await auditRows("match.manual")).length).toBe(before);
    await consistent();
  });

  it("applyMatch refuses a match without allocations and without a ledger account", async () => {
    const t = await tx({ amountMinor: 100 });
    await expect(applyMatch(db, input(t, [], 100))).rejects.toThrow(RangeError);
    const inv = await addItem({ divisionId: w.divisionId, openMinor: 100 });
    await expect(
      applyMatch(db, input(t, [[inv, 100]], 100, { source: "ledger", ledgerAccountCode: "4500" })),
    ).rejects.toThrow(RangeError);
    expect(await liveMatches()).toBe(0);
  });
});

// ---- (1b) data that changes after matching ---------------------------------------------------

describe("data that changes after matching (needs review)", () => {
  it("Exact reducing the open balance flags over_allocated; closing flags item_closed", async () => {
    const a = await addItem({ divisionId: w.divisionId, openMinor: 1_000 });
    const b = await addItem({ divisionId: w.divisionId, openMinor: 500 });
    const t1 = await tx({ amountMinor: 1_000 });
    const t2 = await tx({ amountMinor: 500 });
    const m1 = await applyMatch(db, input(t1, [[a, 1_000]], 1_000));
    const m2 = await applyMatch(db, input(t2, [[b, 500]], 500));
    expect(m1.ok && m2.ok).toBe(true);
    // The Exact sync: invoice a was part-paid elsewhere, b fully paid and closed.
    await db.prepare("UPDATE open_items SET open_minor = 400 WHERE id = ?1").bind(a).run();
    await db
      .prepare("UPDATE open_items SET open_minor = 0, status = 'closed' WHERE id = ?1")
      .bind(b)
      .run();
    expect((await checkMatchingInvariants(db)).map((v) => v.code).sort()).toEqual([
      "allocation_to_closed_item_unflagged",
      "item_over_allocated_unflagged",
    ]);
    const r = await runMatching(jobContext());
    expect(r.summary["flagged_for_review"]).toBe(2);
    const flags = (await db.prepare("SELECT id, review_reason FROM matches ORDER BY id").all())
      .results;
    expect(flags).toEqual([
      { id: m1.ok ? m1.matchId : 0, review_reason: "over_allocated" },
      { id: m2.ok ? m2.matchId : 0, review_reason: "item_closed" },
    ]);
    await consistent();
    // A second run flags nothing new (sticky, idempotent).
    expect((await runMatching(jobContext())).summary["flagged_for_review"]).toBe(0);
    // A flagged match is never claimed for booking, but can be undone.
    expect(await claimMatchForBooking(db, m1.ok ? m1.matchId : 0, "booking")).toBe(false);
    expect((await undoMatch(db, m1.ok ? m1.matchId : 0, "x@y", "paid elsewhere", "t")).kind).toBe(
      "undone",
    );
    await consistent();
  });

  it("a Revolut state conflict on a matched line flags it (and the ingest kept the money)", async () => {
    const inv = await addItem({ divisionId: w.divisionId, openMinor: 100 });
    const t = await tx({ amountMinor: 100 });
    const m = await applyMatch(db, input(t, [[inv, 100]], 100));
    await db.prepare("UPDATE bank_transactions SET state_conflict = 1 WHERE id = ?1").bind(t).run();
    expect(await flagMatchesForReview(db, "2026-07-15T00:00:00Z")).toBe(1);
    expect(
      await db
        .prepare("SELECT review_reason FROM matches WHERE id = ?1")
        .bind(m.ok ? m.matchId : 0)
        .first(),
    ).toEqual({ review_reason: "tx_state_conflict" });
    await consistent();
  });

  it("a booked match is not flagged (Exact's balance falls because WE booked it)", async () => {
    const inv = await addItem({ divisionId: w.divisionId, openMinor: 100 });
    const t = await tx({ amountMinor: 100 });
    const m = await applyMatch(db, input(t, [[inv, 100]], 100));
    expect(await claimMatchForBooking(db, m.ok ? m.matchId : 0, "booking")).toBe(true);
    await db
      .prepare("UPDATE open_items SET open_minor = 0, status = 'closed' WHERE id = ?1")
      .bind(inv)
      .run();
    expect(await flagMatchesForReview(db, "2026-07-15T00:00:00Z")).toBe(0);
    await consistent(["claimed_without_outbox"]);
  });
});

// ---- (2) races ---------------------------------------------------------------------------------

describe("races (interleavings)", () => {
  it("job auto-match vs manual match vs ignore vs undo on one line: one consistent outcome", async () => {
    for (let round = 0; round < 4; round++) {
      w = await resetWorld();
      const { itemId, txId } = await perfect();
      await enableAuto();
      const results = await Promise.allSettled([
        runMatching(jobContext()),
        applyMatch(db, input(txId, [[itemId, 12_345]], 12_345)),
        ignoreTransaction(db, txId, "other", null, "fin@x", "2026-07-15T10:00:00Z"),
        (async () => {
          const m = await db
            .prepare("SELECT id FROM matches WHERE bank_transaction_id = ?1 AND undone_at IS NULL")
            .bind(txId)
            .first<{ id: number }>();
          return m ? undoMatch(db, m.id, "fin@x", "race", "2026-07-15T10:00:01Z") : null;
        })(),
      ]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const status = await txStatus(txId);
      const live = await liveMatches();
      expect(["matched", "ignored", "unmatched", "suggested"]).toContain(status);
      expect(live).toBe(status === "matched" ? 1 : 0);
      await consistent();
    }
  });

  it("two lines racing for one item through the API path: never more than its balance", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const lines = await Promise.all([1, 2, 3, 4].map(() => tx({ amountMinor: 4_000 })));
    const out = await Promise.all(
      lines.map((t) => applyMatch(db, input(t, [[item, 4_000]], 4_000))),
    );
    expect(out.filter((r) => r.ok)).toHaveLength(2);
    expect(out.filter((r) => !r.ok).every((r) => !r.ok && r.code === "alloc_exceeds_open")).toBe(
      true,
    );
    expect(
      await count(
        "SELECT SUM(a.allocated_minor) AS n FROM match_allocations a JOIN matches m ON m.id = a.match_id WHERE m.undone_at IS NULL",
      ),
    ).toBe(8_000);
    await consistent();
  });

  it("undo racing with the booking claim (M7c contract): exactly one wins", async () => {
    for (let i = 0; i < 6; i++) {
      w = await resetWorld();
      const inv = await addItem({ divisionId: w.divisionId, openMinor: 100 });
      const t = await tx({ amountMinor: 100 });
      const m = await applyMatch(db, input(t, [[inv, 100]], 100));
      const id = m.ok ? m.matchId : 0;
      let undo: Awaited<ReturnType<typeof undoMatch>>;
      let claim: boolean;
      if (i % 2 === 0) {
        [undo, claim] = await Promise.all([
          undoMatch(db, id, "fin@x", "race", "t"),
          claimMatchForBooking(db, id, "booking"),
        ]);
      } else {
        [claim, undo] = await Promise.all([
          claimMatchForBooking(db, id, "booking"),
          undoMatch(db, id, "fin@x", "race", "t"),
        ]);
      }
      expect((undo.kind === "undone") !== claim).toBe(true);
      const row = await db
        .prepare("SELECT exact_state, undone_at FROM matches WHERE id = ?1")
        .bind(id)
        .first<{ exact_state: string; undone_at: string | null }>();
      if (claim) expect(row).toEqual({ exact_state: "booking", undone_at: null });
      else expect(row?.exact_state).toBe("not_booked");
      if (!claim) expect(undo.kind).toBe("undone");
      else expect(undo.kind).toBe("already_booked_in_exact");
      // An undo audit row exists exactly when the undo won.
      expect((await auditRows("match.undo", id)).length).toBe(claim ? 0 : 1);
      await consistent(["claimed_without_outbox"]);
    }
    await expect(claimMatchForBooking(db, 1, "not_booked")).rejects.toThrow(RangeError);
  });

  it("the Exact sync lowering the open balance mid-run: the auto-match is refused, suggestions stay", async () => {
    const { itemId, txId } = await perfect(5_000);
    await enableAuto();
    const d = stallingDb(() =>
      db.prepare("UPDATE open_items SET open_minor = 4_000 WHERE id = ?1").bind(itemId).run(),
    );
    const r = await runMatching(ctxWith(d));
    expect(r.summary).toMatchObject({ auto_matched: 0, skipped_by_reason: { item_changed: 1 } });
    expect(await liveMatches()).toBe(0);
    // The line was not lost: it got its suggestions in the same run.
    expect(await txStatus(txId)).toBe("suggested");
    await consistent();
  });

  it("the Revolut ingest flagging the line mid-run: refused (lost race), nothing half-written", async () => {
    const { txId } = await perfect();
    await enableAuto();
    const d = stallingDb(() =>
      db.prepare("UPDATE bank_transactions SET state_conflict = 1 WHERE id = ?1").bind(txId).run(),
    );
    const r = await runMatching(ctxWith(d));
    expect(r.summary).toMatchObject({ auto_matched: 0, skipped_by_reason: { lost_race: 1 } });
    expect(await liveMatches()).toBe(0);
    await consistent();
  });

  it("the Revolut ingest changing the amount mid-run (line not frozen yet): refused", async () => {
    const { txId } = await perfect();
    await enableAuto();
    const d = stallingDb(() =>
      db
        .prepare("UPDATE bank_transactions SET amount_minor = 12_000 WHERE id = ?1")
        .bind(txId)
        .run(),
    );
    const r = await runMatching(ctxWith(d));
    expect(r.summary["auto_matched"]).toBe(0);
    expect(await liveMatches()).toBe(0);
    await consistent();
  });

  it("a person ignoring the line mid-run: the job's match and suggestions do not overwrite it", async () => {
    const { txId } = await perfect();
    await enableAuto();
    const d = stallingDb(() =>
      ignoreTransaction(db, txId, "not_ours", null, "fin@x", "2026-07-15T10:00:00Z"),
    );
    await runMatching(ctxWith(d));
    expect(await txStatus(txId)).toBe("ignored");
    expect(await liveMatches()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM match_suggestions")).toBe(0);
    await consistent();
  });
});

// ---- (3) auto-match safety ---------------------------------------------------------------------

describe("automatic matching safety", () => {
  it("stays off on a fresh install and on an upgrade of the default jobs (v2 -> v3)", async () => {
    // Upgrade: an install at default-jobs version 2, the admin had switched bank.match... it did not
    // exist yet; matching.auto_enabled is absent.
    await db.prepare("DELETE FROM jobs").run();
    await setSetting("seed.default_jobs", { version: 2 });
    expect(await seedDefaultJobs(db, NOW)).toBe("applied");
    expect(
      await db.prepare("SELECT value_json FROM settings WHERE key = ?1").bind(SETTING_AUTO).first(),
    ).toBeNull();
    await perfect();
    expect((await runMatching(jobContext())).summary).toMatchObject({
      auto_enabled: false,
      auto_matched: 0,
    });
    // An admin disables the job; a later seeding never re-enables it.
    await db.prepare("UPDATE jobs SET enabled = 0 WHERE name = 'bank.match'").run();
    await setSetting("seed.default_jobs", { version: 2 });
    await seedDefaultJobs(db, NOW);
    expect(await db.prepare("SELECT enabled FROM jobs WHERE name = 'bank.match'").first()).toEqual({
      enabled: 0,
    });
    // Anything but a stored JSON true is off.
    for (const v of ["1", '"true"', "null", "{}"]) {
      await db
        .prepare(
          "INSERT INTO settings (key, value_json) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
        )
        .bind(SETTING_AUTO, v)
        .run();
      expect((await runMatching(jobContext())).summary["auto_matched"]).toBe(0);
    }
  });

  it("an incomplete input (no counterparty account type on a transfer) is reviewed, never auto", async () => {
    await enableAuto();
    const rel = await addRelation({ divisionId: w.divisionId, ibans: [CUSTOMER_IBAN] });
    await addItem({
      divisionId: w.divisionId,
      invoiceNumber: "INV-7",
      openMinor: 700,
      relationExactId: rel.exactId,
    });
    const t = await tx({
      amountMinor: 700,
      reference: "INV-7",
      counterpartyIban: CUSTOMER_IBAN,
      accountType: null,
    });
    const r = await runMatching(jobContext());
    expect(r.summary).toMatchObject({
      auto_matched: 0,
      skipped_by_reason: { incomplete_input: 1 },
    });
    expect(await txStatus(t)).toBe("suggested");
    await consistent();
  });

  it("autoInputGap: every missing safety input means review", () => {
    const base = toMatchTx({
      id: 1,
      connection_id: 1,
      bank_account_id: 1,
      amount_minor: 100,
      currency: "EUR",
      completed_at: "2026-07-14T08:00:00Z",
      created_at: "2026-07-14T08:00:00Z",
      booked_at: "2026-07-14T08:00:00Z",
      reference: null,
      description: null,
      counterparty_name: null,
      counterparty_iban: null,
      counterparty_ref: null,
      type: "transfer",
      counterparty_account_type: "external",
      is_final: 1,
      state: "completed",
      request_id: null,
      state_conflict: 0,
      match_status: "unmatched",
      live: 0,
    });
    expect(autoInputGap(base)).toBeNull();
    for (const over of [
      { type: null },
      { counterpartyAccountType: null },
      { counterpartyAccountType: undefined },
      { bookedAt: "" },
      { isFinal: false },
      { state: "pending" },
      { frozen: true },
      { stateConflict: true },
    ]) {
      expect(autoInputGap({ ...base, ...over }), JSON.stringify(over)).toBe("incomplete_input");
    }
    expect(
      autoInputGap({ ...base, type: "card_payment", counterpartyAccountType: null }),
    ).toBeNull();
  });

  it("auto never runs for an administration that is not synced or a disabled Exact connection", async () => {
    await perfect();
    await enableAuto();
    await db.prepare("UPDATE divisions SET sync_enabled = 0").run();
    expect((await runMatching(jobContext())).summary).toMatchObject({
      evaluated: 0,
      auto_matched: 0,
    });
    await db.prepare("UPDATE divisions SET sync_enabled = 1").run();
    await db
      .prepare("UPDATE connections SET status = 'disabled' WHERE id = ?1")
      .bind(w.exactConnectionId)
      .run();
    expect((await runMatching(jobContext())).summary).toMatchObject({
      evaluated: 0,
      auto_matched: 0,
    });
    expect(await liveMatches()).toBe(0);
  });

  it("with auto off, a would-be claim does not block the next line's candidate", async () => {
    const rel = await addRelation({ divisionId: w.divisionId, ibans: [CUSTOMER_IBAN] });
    await addItem({
      divisionId: w.divisionId,
      invoiceNumber: "INV-9",
      openMinor: 900,
      relationExactId: rel.exactId,
    });
    const t1 = await tx({ amountMinor: 900, reference: "INV-9", counterpartyIban: CUSTOMER_IBAN });
    const t2 = await tx({
      amountMinor: 900,
      reference: "INV-9",
      counterpartyIban: CUSTOMER_IBAN,
      createdAt: "2026-07-14T09:00:00.000Z",
    });
    await runMatching(jobContext());
    const blocked = (
      await db
        .prepare(
          "SELECT bank_transaction_id AS t, blocked_json AS b FROM match_suggestions WHERE rank = 1 ORDER BY t",
        )
        .all<{ t: number; b: string }>()
    ).results;
    expect(blocked.map((r) => r.t)).toEqual([t1, t2]);
    expect(blocked.every((r) => !r.b.includes("claimed_by_earlier_transaction"))).toBe(true);
  });

  it("dropFalseClaim keeps a true claim and removes a false one", () => {
    const c = {
      itemId: 5,
      ledgerAccountCode: null,
      score: 99,
      rule: 1 as const,
      kind: "full" as const,
      allocatedMinor: 1n,
      remainingMinor: 0n,
      surplusMinor: 0n,
      reasons: [],
      autoEligible: false,
      blockedReasons: ["claimed_by_earlier_transaction"],
      allocations: [{ itemId: 5, allocatedMinor: 1n }],
    };
    const kept = { ...c, blockedReasons: [...c.blockedReasons] };
    dropFalseClaim(kept, new Set([5]));
    expect(kept.blockedReasons).toEqual(["claimed_by_earlier_transaction"]);
    dropFalseClaim(c, new Set([6]));
    expect([c.blockedReasons, c.autoEligible]).toEqual([[], true]);
  });

  it("a payable to a supplier IBAN added recently is never auto-matched", async () => {
    await enableAuto();
    const rel = await addRelation({
      divisionId: w.divisionId,
      ibans: [SUPPLIER_IBAN],
      ibanAddedAt: "2026-07-01T00:00:00.000Z",
    });
    await addItem({
      divisionId: w.divisionId,
      kind: "bill",
      invoiceNumber: "B-77",
      openMinor: 7_700,
      relationExactId: rel.exactId,
    });
    await tx({ amountMinor: -7_700, reference: "B-77", counterpartyIban: SUPPLIER_IBAN });
    expect((await runMatching(jobContext())).summary["auto_matched"]).toBe(0);
  });
});

// ---- (4) assembly --------------------------------------------------------------------------------

describe("assembly details", () => {
  it("bookedAt is the Amsterdam day, also around midnight and the DST changes", () => {
    expect(amsterdamDay("2026-03-28T23:30:00.000Z")).toBe("2026-03-29"); // CET +1
    expect(amsterdamDay("2026-03-29T21:59:00.000Z")).toBe("2026-03-29"); // CEST +2
    expect(amsterdamDay("2026-03-29T22:00:00.000Z")).toBe("2026-03-30");
    expect(amsterdamDay("2026-10-24T22:30:00.000Z")).toBe("2026-10-25"); // CEST +2
    expect(amsterdamDay("2026-10-25T22:30:00.000Z")).toBe("2026-10-25"); // CET +1
    expect(amsterdamDay(null, "nonsense", "2026-01-01T00:00:00Z")).toBe("2026-01-01");
    expect(amsterdamDay(null)).toBe("");
  });

  it("direction follows the sign; lines older than 120 days and unmapped accounts are left out", async () => {
    const tin = await tx({ amountMinor: 5 });
    const tout = await tx({ amountMinor: -5 });
    await tx({ amountMinor: 5, createdAt: new Date(NOW - 121 * 86_400_000).toISOString() });
    const r = await assembleTransactions(db, [w.accountId], NOW);
    expect(r.txs.map((t) => [t.id, t.direction, t.amountMinor])).toEqual([
      [tin, "in", 5n],
      [tout, "out", 5n],
    ]);
    await db.prepare("DELETE FROM bank_account_exact_map").run();
    expect((await runMatching(jobContext())).summary).toMatchObject({
      mapped_accounts: 0,
      unmapped_accounts: 1,
      evaluated: 0,
    });
  });

  it("the number of D1 queries per run does not grow with the number of lines", async () => {
    await perfect();
    const items: D1PreparedStatement[] = [];
    for (let i = 0; i < 200; i++) {
      items.push(
        db
          .prepare(
            `INSERT INTO open_items (division_id, exact_id, kind, invoice_number, currency, stored_minor, open_minor,
               due_date, status, synced_at) VALUES (?1, ?2, 'invoice', ?3, 'EUR', ?4, ?4, '2026-07-20', 'open', 't')`,
          )
          .bind(w.divisionId, `bulk-${i}`, `B${i}`, 1_000 + i),
      );
    }
    await db.batch(items);
    const addLines = async (n: number, from: number): Promise<void> => {
      const s: D1PreparedStatement[] = [];
      for (let i = 0; i < n; i++) {
        s.push(
          db
            .prepare(
              `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, leg_id, type, state,
                 amount_minor, currency, reference, booked_at, created_at, completed_at, match_status,
                 counterparty_account_type, first_seen_at)
               VALUES (?1, ?2, ?3, '', 'transfer', 'completed', ?4, 'EUR', ?5, ?6, ?6, ?6, 'unmatched', 'external', ?6)`,
            )
            .bind(
              w.revolutConnectionId,
              w.accountId,
              `bulk-tx-${from + i}`,
              1_000 + ((from + i) % 200),
              `B${(from + i) % 200}`,
              "2026-07-10T08:00:00.000Z",
            ),
        );
      }
      for (let i = 0; i < s.length; i += 100) await db.batch(s.slice(i, i + 100));
    };
    await addLines(20, 0);
    const small = countingDb();
    await runMatching(ctxWith(small.db));
    await db.prepare("DELETE FROM match_suggestions").run();
    await db.prepare("UPDATE bank_transactions SET match_status = 'unmatched'").run();
    await addLines(280, 20);
    const big = countingDb();
    const r = await runMatching(ctxWith(big.db));
    expect(r.summary["evaluated"]).toBe(301);
    // Reads: fixed per run plus one hash lookup per 90 lines; writes go in batches of 80.
    expect(big.reads() - small.reads()).toBeLessThanOrEqual(4);
    expect(big.reads()).toBeLessThan(20);
    expect(big.batches()).toBeLessThan(Math.ceil((301 * 8) / 80) + 3);
    await consistent();
  });
});

// ---- (5) manual match: another relation needs a confirmation (route-level) ----------------------

describe("ledger patterns at run time", () => {
  it("a catastrophic regex stored behind the API's back stops the run; a safe one on huge input is fast", async () => {
    await perfect();
    await db
      .prepare(
        "INSERT INTO ledger_patterns (name, ledger_account_code, counterparty_name_regex, created_by, updated_by) VALUES ('evil', '4500', '(x+x+)+y', 't', 't')",
      )
      .run();
    expect(await runMatching(jobContext())).toMatchObject({
      status: "error",
      code: "matching_config_invalid",
    });
    await db.prepare("DELETE FROM ledger_patterns").run();
    await db
      .prepare(
        "INSERT INTO ledger_patterns (name, ledger_account_code, counterparty_name_regex, created_by, updated_by) VALUES ('fees', '4500', 'x+y', 't', 't')",
      )
      .run();
    await tx({ amountMinor: -3, counterpartyName: "x".repeat(10_000), type: "fee" });
    const t0 = Date.now();
    const r = await runMatching(jobContext());
    expect(r.status).toBe("ok");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("run budget", () => {
  it("500 lines against 3,000 open items fit one run, with a bounded number of queries", async () => {
    const items: D1PreparedStatement[] = [];
    for (let i = 0; i < 3_000; i++) {
      items.push(
        db
          .prepare(
            `INSERT INTO open_items (division_id, exact_id, kind, invoice_number, currency, stored_minor, open_minor,
               due_date, status, synced_at) VALUES (?1, ?2, ?3, ?4, 'EUR', ?5, ?5, '2026-07-20', 'open', 't')`,
          )
          .bind(
            w.divisionId,
            `p-${i}`,
            i % 3 === 0 ? "bill" : "invoice",
            `P${i}`,
            10_000 + (i % 700),
          ),
      );
    }
    for (let i = 0; i < items.length; i += 500) await db.batch(items.slice(i, i + 500));
    const lines: D1PreparedStatement[] = [];
    for (let i = 0; i < 520; i++) {
      lines.push(
        db
          .prepare(
            `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, leg_id, type, state,
               amount_minor, currency, reference, booked_at, created_at, completed_at, match_status,
               counterparty_account_type, first_seen_at)
             VALUES (?1, ?2, ?3, '', 'transfer', 'completed', ?4, 'EUR', ?5, ?6, ?6, ?6, 'unmatched', 'external', ?6)`,
          )
          .bind(
            w.revolutConnectionId,
            w.accountId,
            `perf-${i}`,
            (i % 3 === 0 ? -1 : 1) * (10_000 + (i % 700)),
            `P${(i * 7) % 3_000}`,
            new Date(NOW - (i % 50) * 3_600_000).toISOString(),
          ),
      );
    }
    for (let i = 0; i < lines.length; i += 260) await db.batch(lines.slice(i, i + 260));
    await enableAuto();
    const counted = countingDb();
    const t0 = Date.now();
    const r = await runMatching(ctxWith(counted.db));
    const ms = Date.now() - t0;
    expect(r.status).toBe("ok");
    expect(r.summary).toMatchObject({ evaluated: 500, capped: true });
    // Reads: config (3), mappings (2), lines, items, freshness, IBANs, ceil(500/90) hash lookups, review flags.
    expect(counted.reads()).toBeLessThanOrEqual(17);
    expect(ms).toBeLessThan(25_000);
    await consistent();
    // The next run takes the 20 lines that waited (round robin), not the same 500 again.
    const r2 = await runMatching(jobContext());
    expect(r2.summary["evaluated"]).toBe(500);
    const never = await count(
      "SELECT COUNT(*) AS n FROM bank_transactions WHERE match_checked_at IS NULL AND match_status IN ('unmatched','suggested')",
    );
    expect(never).toBe(0);
  }, 120_000);
});

// ---- (5) open-item freshness (phase 7 review S4) -----------------------------------------------

describe("auto-match needs fresh open items", () => {
  const H = 3_600_000;
  const at = (agoMs: number): string => new Date(NOW - agoMs).toISOString();
  const stale = { skipped_by_reason: { open_items_stale: 1 }, auto_matched: 0 };

  it("26 hours exactly is stale, one millisecond younger is fresh", async () => {
    await perfect();
    await enableAuto();
    await markOpenItemsSynced(w.divisionId, at(26 * H));
    expect((await runMatching(jobContext())).summary).toMatchObject(stale);
    expect(await liveMatches()).toBe(0);
    await markOpenItemsSynced(w.divisionId, at(26 * H - 1));
    expect((await runMatching(jobContext())).summary).toMatchObject({ auto_matched: 1 });
    await consistent();
  });

  it("never synced (jobs off): review only, the candidate is still suggested", async () => {
    const { txId } = await perfect();
    await enableAuto();
    await markOpenItemsSynced(w.divisionId, null);
    const r = await runMatching(jobContext());
    expect(r.summary).toMatchObject(stale);
    expect(await txStatus(txId)).toBe("suggested");
    expect(await count("SELECT COUNT(*) AS n FROM match_suggestions")).toBeGreaterThan(0);
  });

  it("a pass that did not complete (last_completed_at missing) does not count", async () => {
    await perfect();
    await enableAuto();
    await db
      .prepare(
        "UPDATE sync_state SET last_completed_at = NULL, last_status = 'partial' WHERE division_id = ?1",
      )
      .bind(w.divisionId)
      .run();
    expect((await runMatching(jobContext())).summary).toMatchObject(stale);
  });

  it("an unreadable stamp is stale", async () => {
    await perfect();
    await enableAuto();
    await markOpenItemsSynced(w.divisionId, "yesterday");
    expect((await runMatching(jobContext())).summary).toMatchObject(stale);
  });

  it("both kinds must be fresh, whatever the candidate settles (competitors and credit notes)", async () => {
    await perfect();
    await enableAuto();
    await markOpenItemsSynced(w.divisionId, at(30 * H), at(H));
    expect((await runMatching(jobContext())).summary).toMatchObject(stale);
    // A stale payables list blocks a receivable too: money in can also settle a supplier credit
    // note the stale list does not show.
    await markOpenItemsSynced(w.divisionId, at(H), at(30 * H));
    expect((await runMatching(jobContext())).summary).toMatchObject(stale);
    await markOpenItemsSynced(w.divisionId, at(H), at(H));
    expect((await runMatching(jobContext())).summary).toMatchObject({ auto_matched: 1 });
  });

  it("freshness reader: per division and per kind", async () => {
    await markOpenItemsSynced(w.divisionId, at(H), at(27 * H));
    expect(await openItemsFreshness(db, w.divisionId, NOW)).toEqual({
      receivable: true,
      payable: false,
    });
    const other = await addDivision();
    expect(await openItemsFreshness(db, other.id, NOW)).toEqual({
      receivable: false,
      payable: false,
    });
  });

  it("autoInputGap pure: missing freshness info means no extra condition, stale kind blocks", () => {
    const base = toMatchTx({
      id: 1,
      connection_id: 1,
      bank_account_id: 1,
      amount_minor: 100,
      currency: "EUR",
      completed_at: "2026-07-14T08:00:00Z",
      created_at: "2026-07-14T08:00:00Z",
      booked_at: "2026-07-14T08:00:00Z",
      reference: null,
      description: null,
      counterparty_name: null,
      counterparty_iban: null,
      counterparty_ref: null,
      type: "transfer",
      counterparty_account_type: "external",
      is_final: 1,
      state: "completed",
      request_id: null,
      state_conflict: 0,
      match_status: "unmatched",
      live: 0,
    });
    const f = { receivable: true, payable: false };
    expect(autoInputGap(base, { kinds: ["receivable"], fresh: f })).toBeNull();
    expect(autoInputGap(base, { kinds: ["payable"], fresh: f })).toBe("open_items_stale");
    expect(autoInputGap(base, { kinds: ["receivable", "payable"], fresh: f })).toBe(
      "open_items_stale",
    );
    expect(autoInputGap(base, { kinds: [], fresh: f })).toBeNull();
  });
});
