/**
 * Phase 7 final review fixes in the booking executor (task U1, ADR 0044 "Final review"): B1 (a
 * match that cannot be planned is deferred, never stuck), B2 (items read BEFORE the first write,
 * watermark, division allow-list, one match per run, mode bound to the row), S2 (fees), N2, N7.
 * Against the state-holding fake Exact of the M7c tests.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ExactApiError } from "@camelthorn/exact";
import { blockersOf, bookingMayRun, loadBookingState } from "../src/booking/settings";
import { SETTING_DIVISIONS, SETTING_FROM, SETTING_MAX_PER_RUN } from "../src/booking/settings";
import { transition } from "../src/booking/outbox";
import { checkMatchingInvariants } from "../src/matching/invariants";
import { undoMatch } from "../src/matching/store";
import { FakeExact } from "./booking-fake-exact";
import {
  bookingWorld,
  db,
  matchRow,
  NOW,
  outbox,
  runBooking,
  seedBookable,
  seedLedger,
  setBooking,
  withoutTriggers,
  type BookingWorld,
} from "./booking-helpers";
import { setSetting } from "./matching-helpers";
import { auditRows } from "./sync-helpers";

let w: BookingWorld;
let fake: FakeExact;

beforeEach(async () => {
  fake = new FakeExact();
  fake.closing.set("90", 100_000);
  w = await bookingWorld({ creates: true });
});

const deferredOf = async (matchId: number): Promise<{ code: string | null; at: string | null }> => {
  const r = await db
    .prepare(
      "SELECT booking_deferred_code AS code, booking_deferred_at AS at FROM matches WHERE id = ?1",
    )
    .bind(matchId)
    .first<{ code: string | null; at: string | null }>();
  return r ?? { code: null, at: null };
};
const iso = (ms: number): string => new Date(ms).toISOString();
const getsOf = (path: string): number =>
  fake.calls.filter((c) => c.method === "GET" && c.path === path).length;

describe("B1: configuration and missing data defer the match, they never claim it", () => {
  it("a missing control account: no outbox row, a code on the match, audited once, Undo works", async () => {
    await db.prepare("UPDATE bank_account_exact_map SET receivable_gl_account_code = NULL").run();
    const s = await seedBookable(w, fake);
    const r1 = await runBooking(fake);
    const r2 = await runBooking(fake, { now: NOW + 5 * 60_000 });
    expect(r1.summary).toMatchObject({
      deferred: 1,
      claimed: 0,
      deferrals: [{ matchId: s.matchId, code: "control_account_unknown" }],
    });
    expect(r2.status).toBe("ok");
    // Never an outbox row, never stage 'none'.
    expect(await outbox(s.matchId)).toEqual([]);
    expect(await matchRow(s.matchId)).toMatchObject({ exact_state: "not_booked" });
    expect((await deferredOf(s.matchId)).code).toBe("control_account_unknown");
    // The code is audited when it appears, not every run.
    expect(await auditRows("booking.deferred")).toHaveLength(1);
    // The settings say what is missing, but do not stop the job (a person fixes the account).
    const state = await loadBookingState(db);
    expect(blockersOf(state)).toContain("control_accounts_missing");
    expect(bookingMayRun(state)).toBe(true);
    // Undo works: the match was never claimed.
    const u = await undoMatch(
      db,
      s.matchId,
      "fin@camelthorncapital.com",
      "wrong invoice",
      iso(NOW),
    );
    expect(u.kind).toBe("undone");
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("once the data is there the next run books it and the code is cleared", async () => {
    await db.prepare("UPDATE bank_account_exact_map SET receivable_gl_account_code = NULL").run();
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    expect((await deferredOf(s.matchId)).code).toBe("control_account_unknown");
    await db.prepare("UPDATE bank_account_exact_map SET receivable_gl_account_code = '1300'").run();
    await runBooking(fake, { now: NOW + 5 * 60_000 });
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
    expect(await deferredOf(s.matchId)).toEqual({ code: null, at: null });
    expect(blockersOf(await loadBookingState(db))).not.toContain("control_accounts_missing");
  });

  it("a deferred match does not starve a bookable one behind it", async () => {
    await db.prepare("UPDATE bank_account_exact_map SET receivable_gl_account_code = NULL").run();
    const stuck = await seedBookable(w, fake);
    await db.prepare("UPDATE bank_account_exact_map SET payable_gl_account_code = '1600'").run();
    const ok = await seedBookable(w, fake, { kind: "bill", amountMinor: 3_000 });
    await setSetting(SETTING_MAX_PER_RUN, 1);
    await runBooking(fake);
    expect((await matchRow(ok.matchId)).exact_state).toBe("matched_in_exact");
    expect((await deferredOf(stuck.matchId)).code).toBe("control_account_unknown");
  });

  it("an account map row that is gone shows as journal_unmapped and the job keeps running", async () => {
    const s = await seedBookable(w, fake);
    await withoutTriggers(["bank_account_map_guard_delete"], async () => {
      await db.prepare("DELETE FROM bank_account_exact_map").run();
    });
    const state = await loadBookingState(db);
    expect(blockersOf(state)).toContain("journal_unmapped");
    expect(bookingMayRun(state)).toBe(true);
    const r = await runBooking(fake);
    expect(r.status).toBe("ok");
    expect(fake.calls).toHaveLength(0);
    expect((await matchRow(s.matchId)).exact_state).toBe("not_booked");
  });

  it.each([
    ["relation without a code", "relation_code_unknown"],
    ["item without an entry number", "item_entry_number_unknown"],
    ["a ledger account Exact does not know", "ledger_account_unknown"],
  ])("%s: deferred as %s, never claimed", async (what, code) => {
    let matchId: number;
    if (what.startsWith("relation")) {
      matchId = (
        await seedBookable(w, fake, {
          relation: { guid: "b0000000-0000-4000-8000-000000000009", code: null },
        })
      ).matchId;
    } else if (what.startsWith("item")) {
      matchId = (await seedBookable(w, fake, { entryNumber: null })).matchId;
    } else {
      matchId = (await seedLedger(w, { withGl: false })).matchId;
    }
    await runBooking(fake);
    expect(await outbox(matchId)).toEqual([]);
    expect((await deferredOf(matchId)).code).toBe(code);
    expect((await matchRow(matchId)).exact_state).toBe("not_booked");
  });

  it("a rule of v1 (a part payment) is still claimed as manual_required, but can be undone or retried", async () => {
    const s = await seedBookable(w, fake, { amountMinor: 5_000, openMinor: 9_000 });
    await runBooking(fake);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      kind: "bank_entry",
      status: "manual_required",
      last_error_code: "part_payment_not_supported_v1",
    });
    const u = await undoMatch(db, s.matchId, "fin@camelthorncapital.com", "x", iso(NOW));
    // The plain undo still says "claimed": the route calls undoUnsentClaim next (booking-u1-api).
    expect(u.kind).toBe("already_booked_in_exact");
  });
});

describe("B1: the first entry in an empty journal", () => {
  beforeEach(() => {
    fake.closing.clear();
  });

  it("without an opening balance the match waits: deferred bank_balance_unknown, nothing sent", async () => {
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect(await outbox(s.matchId)).toEqual([]);
    expect((await deferredOf(s.matchId)).code).toBe("bank_balance_unknown");
  });

  it("the balance of a deferred match is not re-read every run (30 minute re-check)", async () => {
    await seedBookable(w, fake);
    await runBooking(fake);
    const reads = getsOf("/financialtransaction/BankEntries");
    expect(reads).toBe(1);
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(getsOf("/financialtransaction/BankEntries")).toBe(reads);
    await runBooking(fake, { now: NOW + 40 * 60_000 });
    expect(getsOf("/financialtransaction/BankEntries")).toBe(reads + 1);
  });

  it("the admin's opening balance is used for the FIRST entry only", async () => {
    await db.prepare("UPDATE bank_account_exact_map SET opening_balance_minor = 50000").run();
    const a = await seedBookable(w, fake, { amountMinor: 1_000 });
    const b = await seedBookable(w, fake, { amountMinor: 2_000 });
    await runBooking(fake);
    expect((await matchRow(a.matchId)).exact_state).toBe("matched_in_exact");
    expect((await matchRow(b.matchId)).exact_state).toBe("matched_in_exact");
    // The second entry opens with the closing balance Exact now reports, not with the admin's figure.
    expect(fake.entries.map((e) => e.opening)).toEqual([50_000, 51_000]);
  });

  it("a row built on the admin's balance is refused when the journal got an entry meanwhile", async () => {
    await db.prepare("UPDATE bank_account_exact_map SET opening_balance_minor = 50000").run();
    const s = await seedBookable(w, fake);
    await runBooking(fake, { budget: 2 }); // balance read and probe, then the budget stops it
    expect(await outbox(s.matchId)).toMatchObject([{ kind: "bank_entry", status: "pending" }]);
    fake.closing.set("90", 70_000); // somebody booked in the journal
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "manual_required",
      last_error_code: "bank_balance_changed",
    });
  });

  it("the same row is posted when the journal is still empty", async () => {
    await db.prepare("UPDATE bank_account_exact_map SET opening_balance_minor = 50000").run();
    const s = await seedBookable(w, fake);
    await runBooking(fake, { budget: 2 });
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.entries[0]?.opening).toBe(50_000);
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });
});

describe("B2a: the items are read BEFORE the first write", () => {
  it("settled in Exact already (stale D1): not one POST, never matched_in_exact", async () => {
    const s = await seedBookable(w, fake);
    fake.items[0]!.paid = true;
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect(fake.entries).toHaveLength(0);
    expect(await matchRow(s.matchId)).toMatchObject({
      exact_state: "manual_required",
      exact_note: "already_settled_in_exact",
      booked_at: null,
    });
  });

  it("the open amount differs from the stored one: items_changed, nothing sent", async () => {
    const s = await seedBookable(w, fake);
    fake.items[0]!.openMinor = 1_000;
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]?.last_error_code).toBe("items_changed");
  });

  it("an item that cannot be read as expected: preflight_inconclusive, nothing sent", async () => {
    const s = await seedBookable(w, fake);
    fake.items.length = 0;
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]?.last_error_code).toBe("preflight_inconclusive");
  });

  it("in feed mode (Revolut's feed owns the bank line) closed items send nothing either", async () => {
    w = await bookingWorld({ creates: false });
    const s = await seedBookable(w, fake);
    fake.addFeedLine({ journal: "90", amountMinor: 12_345, yourRef: s.txExternalId });
    fake.items[0]!.paid = true;
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect(await matchRow(s.matchId)).toMatchObject({
      exact_state: "manual_required",
      exact_note: "already_settled_in_exact",
    });
  });

  it("in feed mode an open amount that moved ends items_changed, nothing sent", async () => {
    w = await bookingWorld({ creates: false });
    const s = await seedBookable(w, fake);
    fake.addFeedLine({ journal: "90", amountMinor: 12_345, yourRef: s.txExternalId });
    fake.items[0]!.openMinor = 1_000;
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]?.last_error_code).toBe("items_changed");
  });

  it("after an explicit refusal, items closed by somebody else are NOT 'ours': manual, not booked", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["refused"];
    await runBooking(fake);
    const row = (await outbox(s.matchId)).find((r) => r.kind === "matchset")!;
    expect(row.status).toBe("failed");
    fake.items[0]!.paid = true; // somebody settled the invoice meanwhile
    // a person retries (probe first)
    const m = await matchRow(s.matchId);
    expect(
      await transition(db, {
        rowId: row.id,
        matchId: s.matchId,
        from: ["failed"],
        to: "pending",
        token: null,
        nowIso: iso(NOW),
        needsProbe: true,
        nextAttemptAt: null,
        adminResolved: { by: "admin@camelthorncapital.com", at: iso(NOW) },
        match: { from: m.exact_state, to: "booking", note: null },
        actor: "admin@camelthorncapital.com",
        action: "booking.retry",
        audit: {},
      }),
    ).toBe(true);
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts("matchset")).toHaveLength(1);
    expect((await matchRow(s.matchId)).exact_state).toBe("manual_required");
    expect((await matchRow(s.matchId)).exact_note).toBe("already_settled_in_exact");
  });

  it("after a LOST answer, closed items are ours: verified by the read-back, booked", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["lost"]; // performed, answer lost
    await runBooking(fake);
    const row = (await outbox(s.matchId)).find((r) => r.kind === "matchset")!;
    expect(row.status).toBe("outcome_unknown");
    const m = await matchRow(s.matchId);
    await transition(db, {
      rowId: row.id,
      matchId: s.matchId,
      from: ["outcome_unknown"],
      to: "pending",
      token: null,
      nowIso: iso(NOW),
      needsProbe: true,
      nextAttemptAt: null,
      adminResolved: { by: "admin@camelthorncapital.com", at: iso(NOW) },
      match: { from: m.exact_state, to: "booking", note: null },
      actor: "admin@camelthorncapital.com",
      action: "booking.retry",
      audit: {},
    });
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts("matchset")).toHaveLength(1); // never posted again
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });
});

describe("B2b: the booking watermark", () => {
  it("only matches created at or after exact.booking_from are booked", async () => {
    await setSetting(SETTING_FROM, "2026-07-15T08:30:00.000Z");
    const before = await seedBookable(w, fake, { createdAt: "2026-07-15T08:00:00.000Z" });
    const after = await seedBookable(w, fake, { createdAt: "2026-07-15T08:45:00.000Z" });
    await runBooking(fake);
    expect((await matchRow(before.matchId)).exact_state).toBe("not_booked");
    expect(await outbox(before.matchId)).toEqual([]);
    expect((await matchRow(after.matchId)).exact_state).toBe("matched_in_exact");
    // The older one is never picked up later either.
    await runBooking(fake, { now: NOW + 3600_000 });
    expect((await matchRow(before.matchId)).exact_state).toBe("not_booked");
  });

  it("no watermark at all means nothing is eligible (fail closed)", async () => {
    await db.prepare("DELETE FROM settings WHERE key = ?1").bind(SETTING_FROM).run();
    const s = await seedBookable(w, fake);
    const r = await runBooking(fake);
    expect(r.status).toBe("ok");
    expect(fake.calls).toHaveLength(0);
    expect((await matchRow(s.matchId)).exact_state).toBe("not_booked");
  });
});

describe("B2c: canary and division allow-list", () => {
  it("at most `maxPerRun` matches are STARTED per run (default 1)", async () => {
    await db.prepare("DELETE FROM settings WHERE key = ?1").bind(SETTING_MAX_PER_RUN).run();
    const a = await seedBookable(w, fake, { amountMinor: 1_000 });
    const b = await seedBookable(w, fake, { amountMinor: 2_000 });
    const c = await seedBookable(w, fake, { amountMinor: 3_000 });
    const r1 = await runBooking(fake);
    expect(r1.summary).toMatchObject({ started: 1 });
    const states = async (): Promise<string[]> =>
      Promise.all([a, b, c].map(async (m) => (await matchRow(m.matchId)).exact_state));
    expect(await states()).toEqual(["matched_in_exact", "not_booked", "not_booked"]);
    await runBooking(fake, { now: NOW + 600_000 });
    expect(await states()).toEqual(["matched_in_exact", "matched_in_exact", "not_booked"]);
    await setSetting(SETTING_MAX_PER_RUN, 5);
    await runBooking(fake, { now: NOW + 1_200_000 });
    expect(await states()).toEqual(["matched_in_exact", "matched_in_exact", "matched_in_exact"]);
  });

  it("an empty allow-list stops the run before any call", async () => {
    await setSetting(SETTING_DIVISIONS, []);
    const s = await seedBookable(w, fake);
    const r = await runBooking(fake);
    expect([r.status, r.code]).toEqual(["skipped", "booking_disabled"]);
    expect(r.summary).toMatchObject({ blockers: expect.arrayContaining(["no_division_allowed"]) });
    expect(fake.calls).toHaveLength(0);
    expect((await matchRow(s.matchId)).exact_state).toBe("not_booked");
  });

  it("a division that is not on the list is not booked, one that is, is", async () => {
    const s = await seedBookable(w, fake);
    await setSetting(SETTING_DIVISIONS, [w.divisionId + 999]);
    await runBooking(fake);
    expect(fake.calls).toHaveLength(0);
    await setSetting(SETTING_DIVISIONS, [w.divisionId]);
    await runBooking(fake, { now: NOW + 600_000 });
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });

  it("taking the division off the list mid-run stops the POST", async () => {
    const s = await seedBookable(w, fake);
    const original = fake.transport;
    let done = false;
    fake.transport = async (req) => {
      const res = await original(req);
      if (!done && req.method === "GET" && req.path === "/financialtransaction/BankEntryLines") {
        done = true;
        await setSetting(SETTING_DIVISIONS, [w.divisionId + 999]);
      }
      return res;
    };
    const r = await runBooking(fake);
    expect(r.code).toBe("writes_disabled");
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("B2d, N2: the booking mode is bound to the row and to the bank line's own connection", () => {
  it("the row stores the mode it was claimed under", async () => {
    const s = await seedBookable(w, fake);
    await runBooking(fake, { budget: 2 });
    const row = await db
      .prepare("SELECT creates_bank_entries AS c FROM exact_write_outbox WHERE match_id = ?1")
      .bind(s.matchId)
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
  });

  it("a row claimed under another mode never posts, even when booking is verified again", async () => {
    const s = await seedBookable(w, fake);
    await runBooking(fake, { budget: 2 }); // claimed, nothing sent
    // The admin changes who creates the bank entries and verifies and enables again.
    await db
      .prepare("UPDATE connections SET creates_bank_entries = 0 WHERE kind = 'revolut'")
      .run();
    await setBooking(true, true);
    await runBooking(fake, { now: NOW + 600_000 });
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "manual_required",
      last_error_code: "mode_changed",
    });
  });

  it("a verification made under the other mode is a blocker (mode_changed) and stops the run", async () => {
    await seedBookable(w, fake);
    await setBooking(true, true, { mode: false }); // verified in feed mode, the connection says bank entries
    const state = await loadBookingState(db);
    expect(blockersOf(state)).toContain("mode_changed");
    const r = await runBooking(fake);
    expect([r.status, r.code]).toEqual(["skipped", "booking_disabled"]);
    expect(fake.calls).toHaveLength(0);
  });

  it("a bank line on a Revolut connection with another mode is deferred (mode_mismatch)", async () => {
    const s = await seedBookable(w, fake);
    await db
      .prepare(
        `INSERT INTO connections (kind, name, status, creates_bank_entries, bank_entries_decided_at)
         VALUES ('revolut', 'second', 'active', 0, '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    const other = await db
      .prepare("SELECT id FROM connections WHERE name = 'second'")
      .first<{ id: number }>();
    await db
      .prepare("UPDATE bank_transactions SET connection_id = ?2 WHERE id = ?1")
      .bind(s.txId, other?.id ?? 0)
      .run();
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect((await deferredOf(s.matchId)).code).toBe("mode_mismatch");
    expect((await matchRow(s.matchId)).exact_state).toBe("not_booked");
  });
});

describe("S2: Revolut fees", () => {
  it("a line with a fee is deferred while this app creates the bank entry", async () => {
    const s = await seedBookable(w, fake);
    await db
      .prepare("UPDATE bank_transactions SET fee_minor = 50 WHERE id = ?1")
      .bind(s.txId)
      .run();
    await runBooking(fake);
    expect(fake.calls).toHaveLength(0);
    expect(await outbox(s.matchId)).toEqual([]);
    expect((await deferredOf(s.matchId)).code).toBe("fee_not_supported_v1");
  });

  it("a zero fee is no fee, and a fee does not matter when Revolut's feed owns the line", async () => {
    const a = await seedBookable(w, fake);
    await db.prepare("UPDATE bank_transactions SET fee_minor = 0 WHERE id = ?1").bind(a.txId).run();
    await runBooking(fake);
    expect((await matchRow(a.matchId)).exact_state).toBe("matched_in_exact");

    w = await bookingWorld({ creates: false });
    const f = new FakeExact();
    f.closing.set("90", 100_000);
    const b = await seedBookable(w, f);
    await db
      .prepare("UPDATE bank_transactions SET fee_minor = 50 WHERE id = ?1")
      .bind(b.txId)
      .run();
    f.addFeedLine({ journal: "90", amountMinor: 12_345, yourRef: b.txExternalId });
    await runBooking(f);
    expect((await matchRow(b.matchId)).exact_state).toBe("matched_in_exact");
  });
});

describe("a failed read never claims or defers wrongly", () => {
  it("a failed balance read leaves the match alone (no code, no row)", async () => {
    const s = await seedBookable(w, fake);
    fake.failReads = new ExactApiError(503, "down", "gate_unavailable");
    await runBooking(fake);
    expect(await outbox(s.matchId)).toEqual([]);
    expect((await deferredOf(s.matchId)).code).toBeNull();
  });
});
