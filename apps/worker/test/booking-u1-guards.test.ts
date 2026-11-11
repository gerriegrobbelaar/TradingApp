/**
 * Phase 7 final review fixes, the database layer and the pure rules (task U1): the status
 * transition guard of the outbox and the flagged-match guard (S9, migration 0024), the batch guard
 * (N4), the preflight verdicts (B2a), the settings parsing and the blocker split.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ReadBackVerdict } from "@camelthorn/exact";
import { isOutOfStep, OUTBOX_STATUSES, transition, type OutboxStatus } from "../src/booking/outbox";
import { ourPostMayHaveLanded, preflightFromVerdict } from "../src/booking/preflight";
import {
  blockersOf,
  bookingMayRun,
  loadBookingState,
  runBlockersOf,
  sameChecks,
  SETTING_DIVISIONS,
  SETTING_FROM,
  SETTING_MAX_PER_RUN,
} from "../src/booking/settings";
import { BOOKING_VERIFY_CHECKS } from "@camelthorn/core";
import { FakeExact } from "./booking-fake-exact";
import {
  ADMIN_RETRY_SQL,
  bookingWorld,
  db,
  matchRow,
  NOW,
  outbox,
  runBooking,
  seedBookable,
  setBooking,
  withoutTriggers,
  type BookingWorld,
} from "./booking-helpers";

let w: BookingWorld;
let fake: FakeExact;

beforeEach(async () => {
  fake = new FakeExact();
  fake.closing.set("90", 100_000);
  w = await bookingWorld({ creates: true });
});

const run = (sql: string, ...binds: (string | number | null)[]): Promise<unknown> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run();

describe("S9a: a flagged match is never claimed for booking (database level)", () => {
  async function flagged(): Promise<number> {
    const s = await seedBookable(w, fake);
    await run(
      "UPDATE matches SET review_reason = 'item_closed', review_flagged_at = '2026-07-15T09:00:00.000Z' WHERE id = ?1",
      s.matchId,
    );
    return s.matchId;
  }

  it("not_booked -> booking is refused while review_reason is set, even by plain SQL", async () => {
    const id = await flagged();
    await expect(
      run("UPDATE matches SET exact_state = 'booking' WHERE id = ?1", id),
    ).rejects.toThrow(/match_err:bad_transition/);
    expect((await matchRow(id)).exact_state).toBe("not_booked");
  });

  it("the same move works for an unflagged match (the guard is not just 'never')", async () => {
    const s = await seedBookable(w, fake);
    await run("UPDATE matches SET exact_state = 'booking' WHERE id = ?1", s.matchId);
    expect((await matchRow(s.matchId)).exact_state).toBe("booking");
  });

  it("the executor leaves a flagged match alone (its own filter), and so does the claim statement", async () => {
    const id = await flagged();
    await runBooking(fake);
    expect(fake.calls).toHaveLength(0);
    expect(await outbox(id)).toEqual([]);
  });
});

describe("B1/N7: the match columns of migration 0024 are guarded", () => {
  it("a match goes back to not_booked only when nothing of it is left in the outbox", async () => {
    const s = await seedBookable(w, fake, { amountMinor: 5_000, openMinor: 9_000 });
    await runBooking(fake); // a v1 rule: claimed manual_required with a stage 'none' row
    expect((await matchRow(s.matchId)).exact_state).toBe("manual_required");
    await expect(
      run("UPDATE matches SET exact_state = 'not_booked' WHERE id = ?1", s.matchId),
    ).rejects.toThrow(/match_err:bad_transition/);
    await run("DELETE FROM exact_write_outbox WHERE match_id = ?1", s.matchId);
    await run("UPDATE matches SET exact_state = 'not_booked' WHERE id = ?1", s.matchId);
    expect((await matchRow(s.matchId)).exact_state).toBe("not_booked");
  });

  it("no other state goes back to not_booked", async () => {
    const s = await seedBookable(w, fake);
    await run("UPDATE matches SET exact_state = 'booking' WHERE id = ?1", s.matchId);
    await expect(
      run("UPDATE matches SET exact_state = 'not_booked' WHERE id = ?1", s.matchId),
    ).rejects.toThrow(/bad_transition/);
  });

  it("manually_booked is 1 only together with matched_in_exact, and never goes back", async () => {
    const s = await seedBookable(w, fake);
    await expect(
      run("UPDATE matches SET manually_booked = 1 WHERE id = ?1", s.matchId),
    ).rejects.toThrow(/match_err:bad_match_row/);
    await run("UPDATE matches SET exact_state = 'booking' WHERE id = ?1", s.matchId);
    await run(
      "UPDATE matches SET exact_state = 'matched_in_exact', booked_at = '2026-07-15T10:00:00.000Z', manually_booked = 1 WHERE id = ?1",
      s.matchId,
    );
    await expect(
      run("UPDATE matches SET manually_booked = 0 WHERE id = ?1", s.matchId),
    ).rejects.toThrow(/match_err:bad_match_row/);
  });

  it("a claim with a real (built) payload is never undone, by SQL either", async () => {
    const s = await seedBookable(w, fake);
    fake.items[0]!.paid = true;
    await runBooking(fake); // the row ends manual_required, payload stage 'built'
    await expect(
      run("UPDATE matches SET undone_at = 'x', undone_by = 'y' WHERE id = ?1", s.matchId),
    ).rejects.toThrow(/bad_transition/);
  });
});

describe("S9b: the status transitions of an outbox row", () => {
  /** Every allowed move, written down independently of the migration. */
  const ALLOWED: Record<OutboxStatus, readonly OutboxStatus[]> = {
    pending: [
      "sending",
      "manual_required",
      "waiting_for_bank_line",
      "verified",
      "resolved_manually",
      "given_up",
    ],
    waiting_for_bank_line: [
      "pending",
      "manual_required",
      "verified",
      "resolved_manually",
      "given_up",
    ],
    sending: [
      "pending",
      "sent_unverified",
      "failed",
      "outcome_unknown",
      "manual_required",
      "verified",
      "resolved_manually",
      "given_up",
    ],
    sent_unverified: [
      "verified",
      "outcome_unknown",
      "failed",
      "manual_required",
      "resolved_manually",
      "given_up",
    ],
    failed: ["sending", "pending", "verified", "manual_required", "resolved_manually", "given_up"],
    // A person decides an unknown outcome (U1 review): nothing in the app may call it verified.
    outcome_unknown: ["pending", "resolved_manually", "given_up"],
    manual_required: ["resolved_manually", "given_up"],
    verified: [],
    resolved_manually: [],
    given_up: [],
  };

  /** A claimed match with one row, forced into `status` (the guards are lifted only for the setup). */
  async function rowIn(status: OutboxStatus): Promise<number> {
    const s = await seedBookable(w, fake);
    await run("UPDATE matches SET exact_state = 'booking' WHERE id = ?1", s.matchId);
    await run(
      `INSERT INTO exact_write_outbox (match_id, division_id, kind, idempotency_key, payload_json, payload_hash,
         created_at, updated_at) VALUES (?1, ?2, 'bank_entry', ?3, '{}', ?3, 'x', 'x')`,
      s.matchId,
      w.divisionId,
      `${s.matchId}`.padStart(64, "f"),
    );
    if (status !== "pending") {
      await withoutTriggers(["outbox_guard_status"], async () => {
        await run(
          "UPDATE exact_write_outbox SET status = ?2 WHERE match_id = ?1",
          s.matchId,
          status,
        );
      });
    }
    return s.matchId;
  }

  it("the whole matrix: every status to every status, with the admin retry columns present", async () => {
    for (const from of OUTBOX_STATUSES) {
      for (const to of OUTBOX_STATUSES) {
        if (from === to) continue;
        const matchId = await rowIn(from);
        // needs_probe and the admin columns are set in the same UPDATE, so only the table decides
        const attempt = run(
          `UPDATE exact_write_outbox SET status = ?2, ${ADMIN_RETRY_SQL} WHERE match_id = ?1`,
          matchId,
          to,
        );
        if (ALLOWED[from].includes(to)) await attempt;
        else
          await expect(attempt, `${from} -> ${to}`).rejects.toThrow(
            /booking_err:(bad_transition|terminal)/,
          );
        const now = await outbox(matchId);
        expect(now[0]?.status, `${from} -> ${to}`).toBe(ALLOWED[from].includes(to) ? to : from);
      }
    }
  });

  it("a row leaves outcome_unknown or failed for pending ONLY by an admin retry", async () => {
    for (const from of ["outcome_unknown", "failed"] as const) {
      const id = await rowIn(from);
      const set = (extra: string): Promise<unknown> =>
        run(`UPDATE exact_write_outbox SET status = 'pending', ${extra} WHERE match_id = ?1`, id);
      // nothing, only the probe flag, only the admin columns: all refused
      await expect(set("needs_probe = 0")).rejects.toThrow(/booking_err:admin_only/);
      await expect(set("needs_probe = 1")).rejects.toThrow(/booking_err:admin_only/);
      await expect(
        set("needs_probe = 0, admin_resolved_by = 'a@b.c', admin_resolved_at = 'x'"),
      ).rejects.toThrow(/booking_err:admin_only/);
      await expect(set("needs_probe = 1, admin_resolved_by = 'a@b.c'")).rejects.toThrow(
        /booking_err:admin_only/,
      );
      expect((await outbox(id))[0]?.status).toBe(from);
      await set(ADMIN_RETRY_SQL);
      expect((await outbox(id))[0]).toMatchObject({ status: "pending", needs_probe: 1 });
    }
  });

  it("the executor's own moves out of 'sending' and 'waiting' to pending need no admin", async () => {
    // not sent: the attempt is given back
    const id = await rowIn("sending");
    await run("UPDATE exact_write_outbox SET attempts = 1 WHERE match_id = ?1", id);
    await run(
      "UPDATE exact_write_outbox SET status = 'pending', attempts = 0 WHERE match_id = ?1",
      id,
    );
    // 429: the attempt counts, a probe comes first
    const id3 = await rowIn("sending");
    await run(
      "UPDATE exact_write_outbox SET status = 'pending', needs_probe = 1 WHERE match_id = ?1",
      id3,
    );
    const id2 = await rowIn("waiting_for_bank_line");
    await run("UPDATE exact_write_outbox SET status = 'pending' WHERE match_id = ?1", id2);
  });

  it("sending -> pending with neither the attempt given back nor a probe is refused", async () => {
    const id = await rowIn("sending");
    await run("UPDATE exact_write_outbox SET attempts = 1 WHERE match_id = ?1", id);
    await expect(
      run("UPDATE exact_write_outbox SET status = 'pending' WHERE match_id = ?1", id),
    ).rejects.toThrow(/booking_err:sent_facts/);
    expect((await outbox(id))[0]?.status).toBe("sending");
  });

  it("a finished row never changes, whatever the column", async () => {
    const id = await rowIn("verified");
    await expect(
      run("UPDATE exact_write_outbox SET attempts = 5 WHERE match_id = ?1", id),
    ).rejects.toThrow(/booking_err:terminal/);
  });
});

describe("N4: the batch guard is a code, not text matching", () => {
  it("the trigger raises batch_guard:match_out_of_step, which isOutOfStep recognises", async () => {
    let caught: unknown;
    try {
      await run("INSERT INTO batch_guard (code) VALUES ('match_out_of_step')");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message) + String((caught as Error).cause)).toMatch(
      /batch_guard:match_out_of_step/,
    );
    expect(isOutOfStep(caught)).toBe(true);
  });

  it("another code in the table is refused too, but is NOT 'out of step'", async () => {
    let caught: unknown;
    try {
      await run("INSERT INTO batch_guard (code) VALUES ('something')");
    } catch (e) {
      caught = e;
    }
    expect(String((caught as Error).message)).toMatch(/batch_guard:refused/);
    expect(isOutOfStep(caught)).toBe(false);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM batch_guard").first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it("the old text ('malformed JSON') means nothing any more; messages and causes are both read", () => {
    expect(isOutOfStep(new Error("D1_ERROR: malformed JSON"))).toBe(false);
    expect(
      isOutOfStep(new Error("D1_ERROR: batch_guard:match_out_of_step: SQLITE_CONSTRAINT")),
    ).toBe(true);
    expect(
      isOutOfStep(new Error("outer", { cause: new Error("batch_guard:match_out_of_step") })),
    ).toBe(true);
    expect(isOutOfStep("batch_guard:match_out_of_step")).toBe(true);
    expect(isOutOfStep(null)).toBe(false);
    expect(isOutOfStep(new Error("batch_guard:refused"))).toBe(false);
  });

  it("a transition that loses the race returns false; any other database error is thrown, not swallowed", async () => {
    fake.modes.bank_entry = ["lost"];
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0]!;
    const base = {
      rowId: row.id,
      matchId: s.matchId,
      from: ["outcome_unknown"] as OutboxStatus[],
      to: "pending" as OutboxStatus,
      token: null,
      nowIso: new Date(NOW).toISOString(),
      needsProbe: true,
      adminResolved: { by: "admin@camelthorncapital.com", at: new Date(NOW).toISOString() },
      actor: "system",
      action: "booking.retry",
      audit: {},
    };
    // lost race: the match is not where the transition thinks (batch_guard fires, nothing changes)
    expect(
      await transition(db, {
        ...base,
        match: { from: "booking_failed", to: "booking", note: null },
      }),
    ).toBe(false);
    expect((await outbox(s.matchId))[0]?.status).toBe("outcome_unknown");
    expect((await matchRow(s.matchId)).exact_state).toBe("outcome_unknown");
    // an illegal move is a real error: the trigger's code, thrown
    await expect(
      transition(db, { ...base, match: { from: "outcome_unknown", to: "not_booked", note: null } }),
    ).rejects.toThrow(/bad_transition/);
    expect((await outbox(s.matchId))[0]?.status).toBe("outcome_unknown");
    // and the legal one applies, with the nonce on both rows
    expect(
      await transition(db, {
        ...base,
        match: { from: "outcome_unknown", to: "booking", note: null },
      }),
    ).toBe(true);
    const nonces = await db
      .prepare(
        "SELECT o.op_nonce AS a, m.op_nonce AS b FROM exact_write_outbox o JOIN matches m ON m.id = o.match_id WHERE o.id = ?1",
      )
      .bind(row.id)
      .first<{ a: string; b: string }>();
    expect(nonces?.a).toBeTruthy();
    expect(nonces?.a).toBe(nonces?.b);
  });
});

describe("B2a: the preflight verdicts", () => {
  const cases: [string, ReadBackVerdict, string][] = [
    ["nothing changed", { outcome: "not_applied" }, "open_as_expected"],
    ["every item closed", { outcome: "verified" }, "already_settled"],
    [
      "some closed, some open",
      { outcome: "inconclusive", problems: [{ index: -1, reason: "partially_applied" }] },
      "already_settled",
    ],
    [
      "an open amount that moved",
      { outcome: "inconclusive", problems: [{ index: 0, reason: "unexpected_open_amount" }] },
      "changed",
    ],
    [
      "a missing item",
      { outcome: "inconclusive", problems: [{ index: 0, reason: "missing" }] },
      "inconclusive",
    ],
    [
      "an ambiguous item",
      { outcome: "inconclusive", problems: [{ index: 0, reason: "ambiguous" }] },
      "inconclusive",
    ],
    [
      "a currency mismatch",
      { outcome: "inconclusive", problems: [{ index: 0, reason: "currency_mismatch" }] },
      "inconclusive",
    ],
    ["nothing to judge", { outcome: "inconclusive", problems: [] }, "inconclusive"],
  ];
  it.each(cases)("%s", (_n, verdict, expected) => {
    expect(preflightFromVerdict(verdict)).toBe(expected);
  });

  it("only an unclear OWN post can make closed items 'ours'", () => {
    expect(ourPostMayHaveLanded(0, "network")).toBe(false); // never sent
    expect(ourPostMayHaveLanded(1, null)).toBe(false);
    expect(ourPostMayHaveLanded(1, "matchset_refused")).toBe(false);
    expect(ourPostMayHaveLanded(1, "matchset_not_applied")).toBe(false);
    expect(ourPostMayHaveLanded(1, "exact_rejected_400")).toBe(false);
    expect(ourPostMayHaveLanded(1, "bank_balance_changed")).toBe(false);
    for (const code of [
      "network",
      "stale_sending",
      "matchset_answer_unreadable",
      "exact_http_502",
      "auth_after_send",
    ]) {
      expect(ourPostMayHaveLanded(1, code), code).toBe(true);
    }
  });
});

describe("settings: parsing fails closed, and the blockers split into 'stops the run' and 'stops enabling'", () => {
  it("garbage settings read as: no division, one match per run, no watermark", async () => {
    await run("UPDATE settings SET value_json = ?2 WHERE key = ?1", SETTING_DIVISIONS, '["1"]');
    await run("UPDATE settings SET value_json = ?2 WHERE key = ?1", SETTING_MAX_PER_RUN, "99");
    await run("UPDATE settings SET value_json = ?2 WHERE key = ?1", SETTING_FROM, '"not a date"');
    const s = await loadBookingState(db);
    expect([s.divisions, s.maxPerRun, s.bookingFrom]).toEqual([[], 1, null]);
    expect(blockersOf(s)).toContain("no_division_allowed");
    expect(bookingMayRun(s)).toBe(false);
    for (const bad of ["{}", "[1,", "null", "[1.5]", "[0]", "[-3]", "5"]) {
      await run("UPDATE settings SET value_json = ?2 WHERE key = ?1", SETTING_DIVISIONS, bad);
      expect((await loadBookingState(db)).divisions, bad).toEqual([]);
    }
    for (const bad of ["0", "1.5", "true", '"3"', "11", "-1"]) {
      await run("UPDATE settings SET value_json = ?2 WHERE key = ?1", SETTING_MAX_PER_RUN, bad);
      expect((await loadBookingState(db)).maxPerRun, bad).toBe(1);
    }
    await run("UPDATE settings SET value_json = ?2 WHERE key = ?1", SETTING_DIVISIONS, "[3, 1, 3]");
    expect((await loadBookingState(db)).divisions).toEqual([1, 3]);
  });

  it("control_accounts_missing and journal_unmapped never stop a run; the others do", async () => {
    const s = await loadBookingState(db);
    expect(bookingMayRun(s)).toBe(true);
    const gaps = { ...s, controlAccountsMissing: true, journalUnmapped: true };
    expect(blockersOf(gaps)).toEqual(["control_accounts_missing", "journal_unmapped"]);
    expect(runBlockersOf(gaps)).toEqual([]);
    expect(bookingMayRun(gaps)).toBe(true);
    const stops: [string, Partial<typeof s>][] = [
      ["no_division_allowed", { divisions: [] }],
      ["mode_changed", { modeChanged: true }],
      ["bank_entries_undecided", { createsBankEntries: null }],
      ["no_exact_connection", { exactActive: false }],
      ["writes_disabled", { enabled: false }],
      ["not_verified", { verified: null }],
    ];
    for (const [code, over] of stops) {
      const t = { ...s, ...over };
      expect(blockersOf(t), code).toContain(code);
      expect(bookingMayRun(t), code).toBe(false);
    }
  });

  it("sameChecks wants every code, once, and nothing else", () => {
    const all = [...BOOKING_VERIFY_CHECKS];
    expect(sameChecks(all)).toBe(true);
    expect(sameChecks([...all].reverse())).toBe(true);
    expect(sameChecks(all.slice(1))).toBe(false);
    expect(sameChecks([...all, "x"])).toBe(false);
    expect(sameChecks([...all.slice(1), all[1]])).toBe(false);
    expect(sameChecks([])).toBe(false);
  });

  it("the helper's verification really is complete (a regression guard for the fixtures)", async () => {
    await setBooking(true, true);
    expect((await loadBookingState(db)).verified?.checks).toEqual([...BOOKING_VERIFY_CHECKS]);
  });
});
