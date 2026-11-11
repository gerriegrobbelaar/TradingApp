/**
 * The booking executor (task M7c, ADR 0044) against a state-holding fake of Exact: the happy paths
 * (this app creates the bank entries, and Revolut's feed does), idempotency, lost answers, rejected
 * posts, read-back outcomes, manual cases, the fail-closed switch, leases and races.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ExactApiError } from "@camelthorn/exact";
import { checkMatchingInvariants } from "../src/matching/invariants";
import { transition } from "../src/booking/outbox";
import { claimMatchForBooking, undoMatch } from "../src/matching/store";
import { FakeExact } from "./booking-fake-exact";
import {
  ADMIN_RETRY_SQL,
  bookingWorld,
  countingDb,
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
import { auditRows } from "./sync-helpers";

let w: BookingWorld;
let fake: FakeExact;

beforeEach(async () => {
  fake = new FakeExact();
  fake.closing.set("90", 100_000);
  w = await bookingWorld({ creates: true });
});

const statuses = async (matchId: number): Promise<[string, string][]> =>
  (await outbox(matchId)).map((r) => [r.kind, r.status]);

describe("happy path, this app creates the bank entries", () => {
  it("a receivable match: probe, bank entry, MatchSet, read-back, booked", async () => {
    const s = await seedBookable(w, fake);
    const r = await runBooking(fake);
    expect(r.status).toBe("ok");
    expect(await statuses(s.matchId)).toEqual([
      ["bank_entry", "verified"],
      ["matchset", "verified"],
    ]);
    const m = await matchRow(s.matchId);
    expect(m.exact_state).toBe("matched_in_exact");
    expect(m.booked_at).toBe(new Date(NOW).toISOString());
    // Exactly one bank entry and one MatchSet were created, in the right order.
    expect(fake.entries).toHaveLength(1);
    expect(fake.matchSets).toHaveLength(1);
    const bank = fake.entries[0];
    expect(bank?.opening).toBe(100_000);
    expect(fake.closing.get("90")).toBe(100_000 + 12_345);
    const posts = fake.posts().map((p) => p.api);
    expect(posts).toEqual(["rest", "xml"]);
    expect(fake.matchSets[0]?.lines.map((l) => l.amountMinor).sort((a, b) => a - b)).toEqual([
      -12_345, 12_345,
    ]);
    expect(fake.items[0]?.paid).toBe(true);
    // The write calls carry the booking job id at job priority.
    for (const p of fake.posts()) {
      expect([p.jobId, p.priority]).toEqual(["exact-booking", "job"]);
    }
    expect(await checkMatchingInvariants(db)).toEqual([]);
    // Result: counts and codes only.
    expect(r.summary).toMatchObject({ claimed: 2, verified: 1 });
  });

  it("a bill paid out: the bank line is positive in the MatchSet, the bill negative", async () => {
    const s = await seedBookable(w, fake, { kind: "bill", amountMinor: 5_000 });
    await runBooking(fake);
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
    expect(fake.entries[0]).toBeDefined();
    const amounts = fake.matchSets[0]?.lines.map((l) => l.amountMinor).sort((a, b) => a - b);
    expect(amounts).toEqual([-5_000, 5_000]);
  });

  it("a ledger match books a bank entry line only, no MatchSet", async () => {
    const s = await seedLedger(w, { amountMinor: -250 });
    await runBooking(fake);
    expect(await statuses(s.matchId)).toEqual([["bank_entry", "verified"]]);
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
    expect(fake.posts().map((p) => p.api)).toEqual(["rest"]);
    expect(fake.matchSets).toHaveLength(0);
    expect(fake.lines[0]?.amountMinor).toBe(-250);
  });

  it("the second run finds nothing to do: exactly one POST of each kind in total", async () => {
    await seedBookable(w, fake);
    await runBooking(fake);
    const before = fake.calls.length;
    const again = await runBooking(fake);
    expect(again.status).toBe("ok");
    expect(fake.calls.length).toBe(before);
    expect(fake.posts("bank_entry")).toHaveLength(1);
    expect(fake.posts("matchset")).toHaveLength(1);
  });

  it("a probe that finds the line already in Exact reuses it (no second bank entry)", async () => {
    const s = await seedBookable(w, fake);
    fake.addFeedLine({ journal: "90", amountMinor: 12_345, yourRef: s.txExternalId });
    await runBooking(fake);
    expect(fake.posts("bank_entry")).toHaveLength(0);
    expect(fake.posts("matchset")).toHaveLength(1);
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });

  it("books at most one bank entry per journal in flight and keeps the balance chain", async () => {
    const a = await seedBookable(w, fake, { amountMinor: 1_000 });
    const b = await seedBookable(w, fake, { amountMinor: 2_000 });
    await runBooking(fake);
    expect(fake.entries.map((e) => e.opening)).toEqual([100_000, 101_000]);
    expect(fake.closing.get("90")).toBe(103_000);
    expect((await matchRow(a.matchId)).exact_state).toBe("matched_in_exact");
    expect((await matchRow(b.matchId)).exact_state).toBe("matched_in_exact");
  });

  it("does not book a match younger than the undo window, nor a flagged one", async () => {
    const young = await seedBookable(w, fake, { createdAt: new Date(NOW - 60_000).toISOString() });
    const flagged = await seedBookable(w, fake);
    await db
      .prepare(
        "UPDATE matches SET review_reason = 'item_closed', review_flagged_at = '2026-07-15T09:00:00.000Z' WHERE id = ?1",
      )
      .bind(flagged.matchId)
      .run();
    await runBooking(fake);
    expect(fake.calls).toHaveLength(0);
    expect((await matchRow(young.matchId)).exact_state).toBe("not_booked");
    expect((await matchRow(flagged.matchId)).exact_state).toBe("not_booked");
  });
});

describe("happy path, Revolut's own Exact feed creates the bank line", () => {
  beforeEach(async () => {
    w = await bookingWorld({ creates: false });
  });

  it("never creates a bank entry: it finds the line and matches it", async () => {
    const s = await seedBookable(w, fake);
    fake.addFeedLine({ journal: "90", amountMinor: 12_345, yourRef: null });
    const r = await runBooking(fake);
    expect(r.status).toBe("ok");
    expect(fake.posts("bank_entry")).toHaveLength(0);
    expect(fake.posts("matchset")).toHaveLength(1);
    expect(await statuses(s.matchId)).toEqual([["matchset", "verified"]]);
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });

  it("no line yet: waiting_for_bank_line, retried every run, manual after 48 hours", async () => {
    const s = await seedBookable(w, fake);
    const r1 = await runBooking(fake);
    expect(r1.status).toBe("ok");
    expect(await statuses(s.matchId)).toEqual([["matchset", "waiting_for_bank_line"]]);
    expect((await matchRow(s.matchId)).exact_state).toBe("booking");
    expect(fake.posts()).toHaveLength(0);
    // The line shows up: the next run books it.
    fake.addFeedLine({ journal: "90", amountMinor: 12_345 });
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(await statuses(s.matchId)).toEqual([["matchset", "verified"]]);
  });

  it("gives up waiting after 48 hours: manual_required bank_line_not_found", async () => {
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    await runBooking(fake, { now: NOW + 49 * 3600_000 });
    expect(await statuses(s.matchId)).toEqual([["matchset", "manual_required"]]);
    expect((await outbox(s.matchId))[0]?.last_error_code).toBe("bank_line_not_found");
    expect((await matchRow(s.matchId)).exact_state).toBe("manual_required");
  });

  it("two identical payments and one line in Exact: ambiguous, a person decides", async () => {
    const a = await seedBookable(w, fake, { amountMinor: 7_700 });
    await seedBookable(w, fake, { amountMinor: 7_700 });
    fake.addFeedLine({ journal: "90", amountMinor: 7_700 });
    await runBooking(fake);
    expect((await outbox(a.matchId))[0]?.last_error_code).toBe("bank_line_ambiguous");
    expect((await matchRow(a.matchId)).exact_state).toBe("manual_required");
    expect(fake.posts()).toHaveLength(0);
  });

  it("a ledger match is manual when the feed owns the bank line", async () => {
    const s = await seedLedger(w);
    await runBooking(fake);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      kind: "bank_entry",
      status: "manual_required",
      last_error_code: "ledger_booking_with_feed_manual",
    });
    expect(fake.posts()).toHaveLength(0);
  });
});

describe("a lost answer and an unclear outcome", () => {
  it("lost after the POST: outcome_unknown, the next run does NOT re-post, admin retry probes and finds it", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["lost"];
    const r = await runBooking(fake);
    expect(r.status).toBe("partial");
    expect(r.code).toBe("attention_needed");
    expect(await statuses(s.matchId)).toEqual([["bank_entry", "outcome_unknown"]]);
    expect((await matchRow(s.matchId)).exact_state).toBe("outcome_unknown");
    expect(fake.entries).toHaveLength(1); // the fake did create it
    // The next run leaves it alone.
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts("bank_entry")).toHaveLength(1);
    expect((await outbox(s.matchId))[0]?.status).toBe("outcome_unknown");
    // An admin retry (needs_probe) lets the next run probe first: it finds the line, no duplicate.
    await db
      .prepare(
        `UPDATE exact_write_outbox SET status = 'pending', ${ADMIN_RETRY_SQL} WHERE match_id = ?1 AND kind = 'bank_entry'`,
      )
      .bind(s.matchId)
      .run();
    await db
      .prepare("UPDATE matches SET exact_state = 'booking' WHERE id = ?1")
      .bind(s.matchId)
      .run();
    await runBooking(fake, { now: NOW + 20 * 60_000 });
    expect(fake.entries).toHaveLength(1);
    expect(fake.posts("bank_entry")).toHaveLength(1);
    expect(await statuses(s.matchId)).toEqual([
      ["bank_entry", "verified"],
      ["matchset", "verified"],
    ]);
  });

  it("a timeout where nothing was created is also outcome_unknown (never an automatic re-POST)", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["timeout_not_performed"];
    await runBooking(fake);
    expect((await outbox(s.matchId))[0]?.status).toBe("outcome_unknown");
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    await runBooking(fake, { now: NOW + 20 * 60_000 });
    expect(fake.posts("bank_entry")).toHaveLength(1);
    expect(fake.entries).toHaveLength(0);
  });

  it("a 500 is outcome_unknown, and it blocks the next entry of that journal", async () => {
    const a = await seedBookable(w, fake);
    fake.modes.bank_entry = ["http500"];
    await runBooking(fake);
    expect((await outbox(a.matchId))[0]).toMatchObject({
      status: "outcome_unknown",
      last_error_code: "exact_http_500",
    });
    // The opening balance of the next entry depends on this one: the journal waits for a person.
    const b = await seedBookable(w, fake, { amountMinor: 900 });
    const r = await runBooking(fake, { now: NOW + 60_000 });
    expect(r.summary).toMatchObject({ deferred: 1 });
    expect((await matchRow(b.matchId)).exact_state).toBe("not_booked");
    expect(fake.posts("bank_entry")).toHaveLength(1);
  });

  it("an unreadable 200 is outcome_unknown (something may have been booked)", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["html"];
    await runBooking(fake);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "outcome_unknown",
      last_error_code: "bank_entry_bad_response",
    });
    expect(fake.entries).toHaveLength(1);
  });

  it("a 401 after the token refresh is outcome_unknown, never re-sent", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["auth401"];
    await runBooking(fake);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "outcome_unknown",
      last_error_code: "auth_retry_refused",
    });
    expect(fake.posts("bank_entry")).toHaveLength(1);
  });

  it("accepted but not visible yet: sent_unverified, never a second POST, verified once it shows", async () => {
    const s = await seedBookable(w, fake);
    fake.hideLines = true;
    await runBooking(fake);
    expect(await statuses(s.matchId)).toEqual([["bank_entry", "sent_unverified"]]);
    expect((await outbox(s.matchId))[0]?.exact_ref).not.toBeNull();
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts("bank_entry")).toHaveLength(1);
    expect((await outbox(s.matchId))[0]?.status).toBe("sent_unverified");
    fake.hideLines = false;
    await runBooking(fake, { now: NOW + 20 * 60_000 });
    expect(fake.posts("bank_entry")).toHaveLength(1);
    expect(await statuses(s.matchId)).toEqual([
      ["bank_entry", "verified"],
      ["matchset", "verified"],
    ]);
  });

  it("still not visible after hours: outcome_unknown (a person looks), never a re-POST", async () => {
    const s = await seedBookable(w, fake);
    fake.hideLines = true;
    await runBooking(fake);
    await runBooking(fake, { now: NOW + 7 * 3600_000 });
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "outcome_unknown",
      last_error_code: "not_visible_after_post",
    });
    expect(fake.posts("bank_entry")).toHaveLength(1);
  });

  it("a 429 on the POST goes back to pending with needs_probe (nothing was created)", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["rate_limited"];
    await runBooking(fake);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "pending",
      needs_probe: 1,
      last_error_code: "rate_limited",
    });
    await runBooking(fake, { now: NOW + 30 * 60_000 });
    expect(fake.entries).toHaveLength(1);
    expect(fake.posts("bank_entry")).toHaveLength(2); // the first was refused with 429
  });

  it("an executor that died mid-POST (stale sending) becomes outcome_unknown, not a re-POST", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["lost"];
    await runBooking(fake);
    await withoutTriggers(["outbox_guard_status", "matches_guard_exact_state"], async () => {
      await db
        .prepare(
          `UPDATE exact_write_outbox SET status = 'sending', lease_expires_at = '2026-07-15T09:00:00.000Z',
             claimed_at = '2026-07-15T08:50:00.000Z' WHERE match_id = ?1`,
        )
        .bind(s.matchId)
        .run();
      await db
        .prepare("UPDATE matches SET exact_state = 'booking' WHERE id = ?1")
        .bind(s.matchId)
        .run();
    });
    await runBooking(fake);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "outcome_unknown",
      last_error_code: "stale_sending",
    });
    expect(fake.posts("bank_entry")).toHaveLength(1);
  });
});

/** What an admin `retry` does (booking/routes.ts): row back to pending with needs_probe, match to booking. */
async function adminRetry(matchId: number, kind: "bank_entry" | "matchset"): Promise<void> {
  const row = (await outbox(matchId)).find((r) => r.kind === kind)!;
  const m = await matchRow(matchId);
  const ok = await transition(db, {
    rowId: row.id,
    matchId,
    from: [row.status as "outcome_unknown"],
    to: "pending",
    token: null,
    nowIso: new Date(NOW).toISOString(),
    needsProbe: true,
    nextAttemptAt: null,
    adminResolved: { by: "admin@camelthorncapital.com", at: new Date(NOW).toISOString() },
    ...(m.exact_state === "outcome_unknown" || m.exact_state === "booking_failed"
      ? { match: { from: m.exact_state, to: "booking", note: null } }
      : {}),
    actor: "gerrie.grobbelaar@camelthorncapital.com",
    action: "booking.retry",
    audit: { resolution: "retry" },
  });
  expect(ok).toBe(true);
}

describe("never a second bank entry, even when the probe is wrong (A13) or the journal moved (A12)", () => {
  it("a lost POST the probe cannot see: the admin retry still does not post again (balance moved)", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["lost"];
    fake.hideLines = true; // A13 false: the probe never finds our line
    await runBooking(fake);
    expect((await outbox(s.matchId))[0]?.status).toBe("outcome_unknown");
    await adminRetry(s.matchId, "bank_entry");
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts("bank_entry")).toHaveLength(1);
    expect(fake.entries).toHaveLength(1);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "manual_required",
      last_error_code: "bank_balance_changed",
    });
    expect((await matchRow(s.matchId)).exact_state).toBe("manual_required");
  });

  it("someone booked in the journal while our row waited: manual, no POST", async () => {
    const s = await seedBookable(w, fake);
    // budget 2: balance read and probe, then the POST is refused by the run budget (not sent)
    await runBooking(fake, { budget: 2 });
    expect(await statuses(s.matchId)).toEqual([["bank_entry", "pending"]]);
    fake.closing.set("90", 100_500); // another entry in Exact
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts("bank_entry")).toHaveLength(0);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "manual_required",
      last_error_code: "bank_balance_changed",
    });
  });

  it("an unchanged journal: the waiting row is posted on the next run with the stored balance", async () => {
    const s = await seedBookable(w, fake);
    await runBooking(fake, { budget: 2 });
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts("bank_entry")).toHaveLength(1);
    expect(fake.entries[0]?.opening).toBe(100_000);
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });

  it("the bank line was reverted after the claim: manual bank_line_changed, nothing sent", async () => {
    const s = await seedBookable(w, fake);
    await runBooking(fake, { budget: 2 });
    await db
      .prepare("UPDATE bank_transactions SET state = 'reverted' WHERE id = ?1")
      .bind(s.txId)
      .run();
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "manual_required",
      last_error_code: "bank_line_changed",
    });
  });

  it.each([
    ["http500_after_commit", "exact_http_500"],
    ["auth401_after_commit", "auth_retry_refused"],
    ["raw401_after_commit", "auth_after_send"],
  ] as const)(
    "%s: outcome_unknown, never re-sent; the retry finds the entry",
    async (mode, code) => {
      const s = await seedBookable(w, fake);
      fake.modes.bank_entry = [mode];
      await runBooking(fake);
      expect((await outbox(s.matchId))[0]).toMatchObject({
        status: "outcome_unknown",
        last_error_code: code,
      });
      await runBooking(fake, { now: NOW + 10 * 60_000 });
      expect(fake.posts("bank_entry")).toHaveLength(1);
      await adminRetry(s.matchId, "bank_entry");
      await runBooking(fake, { now: NOW + 20 * 60_000 });
      expect(fake.posts("bank_entry")).toHaveLength(1);
      expect(fake.entries).toHaveLength(1);
      expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
    },
  );

  it("two lines with our YourRef: probe_ambiguous, never a POST", async () => {
    const s = await seedBookable(w, fake);
    fake.addFeedLine({ journal: "90", amountMinor: 12_345, yourRef: s.txExternalId });
    fake.addFeedLine({ journal: "90", amountMinor: 12_345, yourRef: s.txExternalId });
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "manual_required",
      last_error_code: "probe_ambiguous",
    });
  });

  it("a probe that fails is never read as 'not found': the row waits, no POST", async () => {
    const s = await seedBookable(w, fake);
    fake.hook = (req) => {
      if (req.method === "GET" && req.path === "/financialtransaction/BankEntryLines") {
        throw new ExactApiError(500, "probe failed");
      }
    };
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect(await statuses(s.matchId)).toEqual([["bank_entry", "pending"]]);
    fake.hook = null;
  });

  it("an admin resolution while the executor probes: the executor's POST never happens", async () => {
    const s = await seedBookable(w, fake);
    fake.hook = (req) => {
      if (req.method === "GET" && req.path === "/financialtransaction/BankEntryLines") {
        fake.hook = null;
        // the resolve route's transition (no lease token), done while the probe is on the wire
        void (async () => {
          const row = (await outbox(s.matchId))[0]!;
          await transition(db, {
            rowId: row.id,
            matchId: s.matchId,
            from: ["pending"],
            to: "resolved_manually",
            token: null,
            nowIso: new Date(NOW).toISOString(),
            match: {
              from: "booking",
              to: "matched_in_exact",
              note: null,
              bookedAt: new Date(NOW).toISOString(),
            },
            actor: "gerrie.grobbelaar@camelthorncapital.com",
            action: "booking.booked_manually",
            audit: {},
          });
        })();
      }
    };
    const original = fake.transport;
    fake.transport = async (req) => {
      const res = await original(req);
      // give the resolution time to land before the executor continues
      await new Promise((r) => setTimeout(r, 20));
      return res;
    };
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]?.status).toBe("resolved_manually");
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });
});

describe("rejections", () => {
  it("a 400 is failed, with no retry loop (only an admin can retry it)", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["reject400"];
    const r = await runBooking(fake);
    expect(r.status).toBe("partial");
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "failed",
      last_error_code: "exact_rejected_400",
    });
    expect((await matchRow(s.matchId)).exact_state).toBe("booking_failed");
    for (let i = 1; i <= 4; i++) await runBooking(fake, { now: NOW + i * 3 * 3600_000 });
    expect(fake.posts("bank_entry")).toHaveLength(1);
  });
});

describe("the MatchSet and its read-back", () => {
  it("explicitly refused and not applied: failed, retried after the backoff with the same payload", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["refused"];
    const r = await runBooking(fake);
    expect(r.status).toBe("partial");
    expect(await statuses(s.matchId)).toEqual([
      ["bank_entry", "verified"],
      ["matchset", "failed"],
    ]);
    expect((await matchRow(s.matchId)).exact_state).toBe("booking_failed");
    const first = fake.posts("matchset")[0]?.body;
    // Not yet due: nothing happens.
    await runBooking(fake, { now: NOW + 60_000 });
    expect(fake.posts("matchset")).toHaveLength(1);
    // After the backoff the same document is posted again (read back first) and now applies.
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts("matchset")).toHaveLength(2);
    expect(fake.posts("matchset")[1]?.body).toBe(first);
    expect(await statuses(s.matchId)).toEqual([
      ["bank_entry", "verified"],
      ["matchset", "verified"],
    ]);
    expect(fake.entries).toHaveLength(1);
  });

  it("gives up retrying after three explicit refusals", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["refused", "refused", "refused"];
    await runBooking(fake);
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    await runBooking(fake, { now: NOW + 60 * 60_000 });
    expect(fake.posts("matchset")).toHaveLength(3);
    const row = (await outbox(s.matchId)).find((r) => r.kind === "matchset");
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
    await runBooking(fake, { now: NOW + 10 * 3600_000 });
    expect(fake.posts("matchset")).toHaveLength(3);
  });

  it("answered success but nothing applied: never re-posted, waits, then outcome_unknown", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["ok_unapplied"];
    await runBooking(fake);
    expect((await outbox(s.matchId)).find((r) => r.kind === "matchset")).toMatchObject({
      status: "sent_unverified",
      last_error_code: "matchset_accepted",
    });
    await runBooking(fake, { now: NOW + 3600_000 });
    expect(fake.posts("matchset")).toHaveLength(1);
    await runBooking(fake, { now: NOW + 7 * 3600_000 });
    expect((await outbox(s.matchId)).find((r) => r.kind === "matchset")).toMatchObject({
      status: "outcome_unknown",
      last_error_code: "not_visible_after_post",
    });
    await runBooking(fake, { now: NOW + 30 * 3600_000 });
    expect(fake.posts("matchset")).toHaveLength(1);
    expect((await matchRow(s.matchId)).exact_state).toBe("outcome_unknown");
  });

  it("an unreadable MatchSet answer with nothing applied is outcome_unknown at once", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["html"];
    // html in the fake applies the MatchSet; make it a lost one instead: nothing applied.
    const original = fake.transport;
    fake.transport = async (req) => {
      if (req.method === "POST" && req.api === "xml") {
        fake.calls.push(req);
        return { status: 200, headers: {}, body: "<html>login</html>" };
      }
      return original(req);
    };
    await runBooking(fake);
    expect((await outbox(s.matchId)).find((r) => r.kind === "matchset")).toMatchObject({
      status: "outcome_unknown",
      last_error_code: "matchset_answer_unreadable",
    });
    await runBooking(fake, { now: NOW + 30 * 3600_000 });
    expect(fake.posts("matchset")).toHaveLength(1);
  });

  it("a 500 on the MatchSet is outcome_unknown, never re-posted by itself", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["http500"];
    await runBooking(fake);
    expect((await outbox(s.matchId)).find((r) => r.kind === "matchset")).toMatchObject({
      status: "outcome_unknown",
    });
    await runBooking(fake, { now: NOW + 30 * 3600_000 });
    expect(fake.posts("matchset")).toHaveLength(1);
  });

  it("a read-back that cannot be judged (item vanished) is outcome_unknown, never a success", async () => {
    const s = await seedBookable(w, fake);
    // Exact answers success, and afterwards the item row is found by neither read.
    const original = fake.transport;
    fake.transport = async (req) => {
      const res = await original(req);
      if (req.method === "POST" && req.api === "xml") fake.items.length = 0;
      return res;
    };
    await runBooking(fake);
    expect((await outbox(s.matchId)).find((r) => r.kind === "matchset")).toMatchObject({
      status: "outcome_unknown",
      last_error_code: "readback_inconclusive",
    });
    expect((await matchRow(s.matchId)).exact_state).toBe("outcome_unknown");
  });

  it("the invoice is already settled in Exact (stale D1): NOTHING is sent, never matched_in_exact (B2a)", async () => {
    const s = await seedBookable(w, fake);
    fake.items[0]!.paid = true;
    await runBooking(fake);
    // Not even the bank entry: the items are read BEFORE the first write.
    expect(fake.posts()).toHaveLength(0);
    expect(await statuses(s.matchId)).toEqual([["bank_entry", "manual_required"]]);
    expect((await outbox(s.matchId))[0]?.last_error_code).toBe("already_settled_in_exact");
    expect(await matchRow(s.matchId)).toMatchObject({
      exact_state: "manual_required",
      exact_note: "already_settled_in_exact",
      booked_at: null,
    });
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("an item whose open amount moved is not touched: manual_required items_changed, nothing sent", async () => {
    const s = await seedBookable(w, fake);
    fake.items[0]!.openMinor = 5_000;
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      kind: "bank_entry",
      status: "manual_required",
      last_error_code: "items_changed",
    });
    expect((await matchRow(s.matchId)).exact_state).toBe("manual_required");
  });

  it("an item Exact does not show at all: preflight_inconclusive, nothing sent", async () => {
    const s = await seedBookable(w, fake);
    fake.items.length = 0;
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]?.last_error_code).toBe("preflight_inconclusive");
  });

  it("a failed preflight read waits: no POST, the row stays pending", async () => {
    const s = await seedBookable(w, fake);
    fake.hook = (req) => {
      if (req.method === "GET" && req.path === "/cashflow/Receivables") {
        throw new ExactApiError(503, "down", "gate_unavailable");
      }
    };
    await runBooking(fake);
    expect(fake.posts()).toHaveLength(0);
    expect(await statuses(s.matchId)).toEqual([["bank_entry", "pending"]]);
    fake.hook = null;
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });
});

describe("what a person must do by hand in v1", () => {
  const codeOf = async (matchId: number): Promise<string | null> =>
    (await outbox(matchId))[0]?.last_error_code ?? null;
  const deferredOf = async (matchId: number): Promise<string | null> =>
    (
      await db
        .prepare("SELECT booking_deferred_code AS c FROM matches WHERE id = ?1")
        .bind(matchId)
        .first<{ c: string | null }>()
    )?.c ?? null;

  it("a part payment: manual_required part_payment_not_supported_v1, nothing sent", async () => {
    const s = await seedBookable(w, fake, {
      amountMinor: 5_000,
      openMinor: 12_000,
      allocMinor: 5_000,
    });
    await runBooking(fake);
    expect(await codeOf(s.matchId)).toBe("part_payment_not_supported_v1");
    expect((await matchRow(s.matchId)).exact_state).toBe("manual_required");
    expect(fake.calls).toHaveLength(0);
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("a surplus (more money than the invoice): the builder's partial_match code", async () => {
    const s = await seedBookable(w, fake, {
      amountMinor: 15_000,
      openMinor: 12_000,
      allocMinor: 12_000,
    });
    await runBooking(fake);
    expect(await codeOf(s.matchId)).toBe("partial_match_not_supported_v1");
    expect(fake.calls).toHaveLength(0);
  });

  it("a foreign currency match is manual (fx_not_supported_v1)", async () => {
    await db
      .prepare("UPDATE divisions SET base_currency = 'USD' WHERE id = ?1")
      .bind(w.divisionId)
      .run();
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    expect(await codeOf(s.matchId)).toBe("fx_not_supported_v1");
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ["no control account", "control_account_unknown"],
    ["no entry number", "item_entry_number_unknown"],
    ["no relation code", "relation_code_unknown"],
  ])("%s: deferred %s, NOT claimed (B1)", async (what, code) => {
    let seed: () => ReturnType<typeof seedBookable>;
    if (what === "no control account") {
      await db.prepare("UPDATE bank_account_exact_map SET receivable_gl_account_code = NULL").run();
      seed = () => seedBookable(w, fake);
    } else if (what === "no entry number") {
      seed = () => seedBookable(w, fake, { entryNumber: null });
    } else {
      seed = () =>
        seedBookable(w, fake, {
          relation: { guid: "b0000000-0000-4000-8000-000000000001", code: null },
        });
    }
    const s = await seed();
    const r = await runBooking(fake);
    // Not claimed: no outbox row, the match stays not_booked with the code (Undo still works).
    expect(await outbox(s.matchId)).toEqual([]);
    expect(await matchRow(s.matchId)).toMatchObject({ exact_state: "not_booked" });
    expect(await deferredOf(s.matchId)).toBe(code);
    expect(r.summary).toMatchObject({ deferred: 1, deferrals: [{ matchId: s.matchId, code }] });
    expect(fake.calls).toHaveLength(0);
  });

  it("a ledger account Exact does not know: deferred ledger_account_unknown", async () => {
    const s = await seedLedger(w, { withGl: false });
    await runBooking(fake);
    expect(await outbox(s.matchId)).toEqual([]);
    expect(await deferredOf(s.matchId)).toBe("ledger_account_unknown");
  });

  it("an empty journal and no opening balance: deferred bank_balance_unknown, nothing sent", async () => {
    fake.closing.clear();
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    expect(await outbox(s.matchId)).toEqual([]);
    expect(await deferredOf(s.matchId)).toBe("bank_balance_unknown");
    expect(fake.posts()).toHaveLength(0);
  });

  it("a failed read of the balance defers the match without claiming it", async () => {
    const s = await seedBookable(w, fake);
    fake.failReads = new ExactApiError(503, "down", "gate_unavailable");
    const r = await runBooking(fake);
    expect(r.status).toBe("ok");
    expect((await matchRow(s.matchId)).exact_state).toBe("not_booked");
    expect(await outbox()).toHaveLength(0);
    fake.failReads = null;
    await runBooking(fake, { now: NOW + 600_000 });
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });
});

describe("fail closed", () => {
  it("does nothing, and says why, while booking is off or not verified", async () => {
    const s = await seedBookable(w, fake);
    await setBooking(false);
    const r1 = await runBooking(fake);
    expect([r1.status, r1.code]).toEqual(["skipped", "booking_disabled"]);
    await setBooking(true, false);
    const r2 = await runBooking(fake);
    expect([r2.status, r2.code]).toEqual(["skipped", "booking_disabled"]);
    expect(fake.calls).toHaveLength(0);
    expect((await matchRow(s.matchId)).exact_state).toBe("not_booked");
  });

  it("the switch turned off mid-run: no further POST, rows stay pending, nothing is lost", async () => {
    const a = await seedBookable(w, fake, { amountMinor: 1_000 });
    // After the first probe the admin switches booking off.
    const original = fake.transport;
    let disabled = false;
    fake.transport = async (req) => {
      const res = await original(req);
      if (
        !disabled &&
        req.method === "GET" &&
        req.path === "/financialtransaction/BankEntryLines"
      ) {
        disabled = true;
        await db
          .prepare("UPDATE settings SET value_json = 'false' WHERE key = 'exact.booking_enabled'")
          .run();
      }
      return res;
    };
    const r = await runBooking(fake);
    expect(r.status).toBe("partial");
    expect(r.code).toBe("writes_disabled");
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(a.matchId))[0]).toMatchObject({ status: "pending", attempts: 0 });
    // Switched on again: it carries on where it stopped.
    await setBooking(true);
    fake.transport = original;
    await runBooking(fake, { now: NOW + 600_000 });
    expect((await matchRow(a.matchId)).exact_state).toBe("matched_in_exact");
  });

  const preconditions: [string, () => Promise<void>][] = [
    ["switch off", () => setBooking(false, true)],
    ["never verified", () => setBooking(true, false)],
    ["verified an older protocol", () => setBooking(true, "a".repeat(64))],
    [
      "verification unreadable",
      async () => {
        await db
          .prepare(
            "UPDATE settings SET value_json = '{\"protocolVersion\":1}' WHERE key = 'exact.booking_verified'",
          )
          .run();
      },
    ],
    [
      "switch is the string true",
      async () => {
        await db
          .prepare(`UPDATE settings SET value_json = '"true"' WHERE key = 'exact.booking_enabled'`)
          .run();
      },
    ],
    [
      "Revolut undecided",
      async () => {
        await db
          .prepare("UPDATE connections SET bank_entries_decided_at = NULL WHERE kind = 'revolut'")
          .run();
      },
    ],
    [
      "Exact connection not active",
      async () => {
        await db
          .prepare("UPDATE connections SET status = 'needs_reauth' WHERE kind = 'exact'")
          .run();
      },
    ],
  ];

  it.each(preconditions)(
    "refused before any call when one precondition is missing: %s",
    async (_n, breakIt) => {
      const s = await seedBookable(w, fake);
      await breakIt();
      const r = await runBooking(fake);
      expect([r.status, r.code]).toEqual(["skipped", "booking_disabled"]);
      expect(fake.calls).toHaveLength(0);
      expect((await matchRow(s.matchId)).exact_state).toBe("not_booked");
    },
  );

  it.each(preconditions)(
    "a precondition lost mid-run (between probe and POST) stops the POST: %s",
    async (_n, breakIt) => {
      const s = await seedBookable(w, fake);
      const original = fake.transport;
      let broken = false;
      fake.transport = async (req) => {
        const res = await original(req);
        if (
          !broken &&
          req.method === "GET" &&
          req.path === "/financialtransaction/BankEntryLines"
        ) {
          broken = true;
          await breakIt();
        }
        return res;
      };
      const r = await runBooking(fake);
      expect([r.status, r.code]).toEqual(["partial", "writes_disabled"]);
      expect(fake.posts()).toHaveLength(0);
      expect((await outbox(s.matchId))[0]).toMatchObject({ status: "pending", attempts: 0 });
    },
  );

  it("a protocol version change invalidates the verification: the run is skipped", async () => {
    await seedBookable(w, fake);
    await setBooking(true, "f".repeat(64));
    const r = await runBooking(fake);
    expect([r.status, r.code]).toEqual(["skipped", "booking_disabled"]);
    expect(r.summary).toMatchObject({ blockers: ["protocol_changed"] });
  });

  it("the daily call cap stops the job (persisted call ledger, rolling 25 hours)", async () => {
    const s = await seedBookable(w, fake);
    await db.prepare("DELETE FROM booking_call_ledger").run();
    // 400 calls 24 hours ago (inside the 25-hour window), whatever job_runs says
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
         INSERT INTO booking_call_ledger (at, run_id) SELECT ?1, 99 FROM n`,
      )
      .bind(new Date(NOW - 24 * 3600_000).toISOString())
      .run();
    const r = await runBooking(fake);
    expect([r.status, r.code]).toEqual(["skipped", "daily_cap_reached"]);
    expect(fake.calls).toHaveLength(0);
    expect((await matchRow(s.matchId)).exact_state).toBe("not_booked");
    // after the window has passed the job books again
    const later = await runBooking(fake, { now: NOW + 2 * 3600_000 });
    expect(later.status).toBe("ok");
    expect(fake.posts("bank_entry")).toHaveLength(1);
    await db.prepare("DELETE FROM booking_call_ledger").run();
  });

  it("the cap is counted per call before the call: a run that reaches it stops mid-way, nothing half-sent", async () => {
    const s = await seedBookable(w, fake);
    await db.prepare("DELETE FROM booking_call_ledger").run();
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 398)
         INSERT INTO booking_call_ledger (at, run_id) SELECT ?1, 99 FROM n`,
      )
      .bind(new Date(NOW - 3600_000).toISOString())
      .run();
    const r = await runBooking(fake);
    // the run's budget is cut to what is left today (2); the ledger refuses a third call anyway
    expect([r.status, r.code]).toEqual(["partial", "call_budget"]);
    // two calls left: the balance read and the probe; the POST is refused before it is made
    expect(fake.calls).toHaveLength(2);
    expect(fake.posts()).toHaveLength(0);
    expect(await statuses(s.matchId)).toEqual([["bank_entry", "pending"]]);
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM booking_call_ledger")
      .first<{ n: number }>();
    expect(n?.n).toBe(400);
    await db.prepare("DELETE FROM booking_call_ledger").run();
  });

  it("two overlapping runs can never exceed the cap together", async () => {
    for (let i = 0; i < 4; i++) await seedBookable(w, fake);
    await db.prepare("DELETE FROM booking_call_ledger").run();
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 395)
         INSERT INTO booking_call_ledger (at, run_id) SELECT ?1, 99 FROM n`,
      )
      .bind(new Date(NOW - 3600_000).toISOString())
      .run();
    await Promise.all([runBooking(fake), runBooking(fake)]);
    expect(fake.calls.length).toBeLessThanOrEqual(5);
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM booking_call_ledger")
      .first<{ n: number }>();
    expect(n?.n).toBe(400);
    await db.prepare("DELETE FROM booking_call_ledger").run();
  });

  it("the call budget per run is respected", async () => {
    await seedBookable(w, fake);
    const r = await runBooking(fake, { budget: 2 });
    expect(r.status).toBe("partial");
    expect(r.callsUsed).toBeLessThanOrEqual(2);
    expect(fake.calls.length).toBeLessThanOrEqual(2);
    expect(fake.posts()).toHaveLength(0);
  });
});

describe("races", () => {
  it("undo versus the booking claim: exactly one wins, in either order", async () => {
    for (let i = 0; i < 4; i++) {
      w = await bookingWorld({ creates: true });
      fake = new FakeExact();
      fake.closing.set("90", 100_000);
      const s = await seedBookable(w, fake);
      const [undo, run] = await Promise.all(
        i % 2 === 0
          ? [
              undoMatch(db, s.matchId, "fin@x", "race", new Date(NOW).toISOString()),
              runBooking(fake),
            ]
          : [
              runBooking(fake),
              undoMatch(db, s.matchId, "fin@x", "race", new Date(NOW).toISOString()),
            ],
      ).then(
        (r) => (i % 2 === 0 ? r : [r[1], r[0]]) as [Awaited<ReturnType<typeof undoMatch>>, unknown],
      );
      void run;
      const m = await matchRow(s.matchId);
      const undone = await db
        .prepare("SELECT undone_at FROM matches WHERE id = ?1")
        .bind(s.matchId)
        .first<{ undone_at: string | null }>();
      if ((undo as { kind: string }).kind === "undone") {
        expect(undone?.undone_at).not.toBeNull();
        expect(m.exact_state).toBe("not_booked");
        expect(await outbox(s.matchId)).toEqual([]);
        expect(fake.posts()).toHaveLength(0);
      } else {
        expect(undone?.undone_at).toBeNull();
        expect(m.exact_state).not.toBe("not_booked");
      }
      expect(await checkMatchingInvariants(db)).toEqual([]);
    }
  });

  it("two executor runs at once: one of them owns each row (lease), one POST of each kind", async () => {
    await seedBookable(w, fake);
    const [a, b] = await Promise.all([runBooking(fake), runBooking(fake)]);
    expect([a.status, b.status].every((s) => s === "ok" || s === "partial")).toBe(true);
    expect(fake.posts("bank_entry")).toHaveLength(1);
    expect(fake.posts("matchset")).toHaveLength(1);
    expect(fake.entries).toHaveLength(1);
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("a claim cannot be taken twice", async () => {
    const s = await seedBookable(w, fake);
    expect(await claimMatchForBooking(db, s.matchId, "booking")).toBe(true);
    expect(await claimMatchForBooking(db, s.matchId, "booking")).toBe(false);
  });
});

describe("transitions are atomic", () => {
  it("a transition from the wrong state changes nothing: no row update, no audit row, no match move", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["lost"];
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0];
    const before = await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    const ok = await transition(db, {
      rowId: row?.id ?? 0,
      matchId: s.matchId,
      from: ["pending"], // it is outcome_unknown
      to: "verified",
      token: null,
      nowIso: new Date(NOW).toISOString(),
      match: {
        from: "outcome_unknown",
        to: "matched_in_exact",
        note: null,
        bookedAt: new Date(NOW).toISOString(),
      },
      actor: "system",
      action: "booking.matched",
      audit: {},
    });
    expect(ok).toBe(false);
    const after = await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect((await outbox(s.matchId))[0]?.status).toBe("outcome_unknown");
    expect((await matchRow(s.matchId)).exact_state).toBe("outcome_unknown");
  });

  it("the row moves but the match is not where expected: the WHOLE batch rolls back", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["lost"];
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0]!;
    const before = await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    const ok = await transition(db, {
      rowId: row.id,
      matchId: s.matchId,
      from: ["outcome_unknown"], // the row IS here
      to: "pending",
      token: null,
      nowIso: new Date(NOW).toISOString(),
      needsProbe: true,
      adminResolved: { by: "admin@camelthorncapital.com", at: new Date(NOW).toISOString() },
      // ...but the match is outcome_unknown, not booking_failed
      match: { from: "booking_failed", to: "booking", note: null },
      actor: "system",
      action: "booking.retry",
      audit: {},
    });
    expect(ok).toBe(false);
    const after = await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "outcome_unknown",
      needs_probe: 1,
    });
    expect((await matchRow(s.matchId)).exact_state).toBe("outcome_unknown");
  });

  it("a stale lease token cannot write: a zombie executor never overwrites the owner", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.bank_entry = ["lost"];
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0];
    await db
      .prepare(
        `UPDATE exact_write_outbox SET status = 'pending', ${ADMIN_RETRY_SQL}, claimed_at = 'owner', lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?1`,
      )
      .bind(row?.id ?? 0)
      .run();
    const ok = await transition(db, {
      rowId: row?.id ?? 0,
      matchId: s.matchId,
      from: ["pending"],
      to: "failed",
      token: "zombie",
      nowIso: new Date(NOW).toISOString(),
      actor: "system",
      action: "booking.failed",
      audit: {},
    });
    expect(ok).toBe(false);
    expect((await outbox(s.matchId))[0]?.status).toBe("pending");
  });
});

describe("audit and data hygiene", () => {
  it("every transition is audited by `system`, atomically with the state change", async () => {
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    const rows = await db
      .prepare(
        `SELECT actor_email, action FROM audit_log
         WHERE action LIKE 'booking.%'
           AND ((entity = 'match' AND entity_id = ?1)
             OR (entity = 'exact_write_outbox'
                 AND entity_id IN (SELECT CAST(id AS TEXT) FROM exact_write_outbox WHERE match_id = ?2)))
         ORDER BY id`,
      )
      .bind(String(s.matchId), s.matchId)
      .all<{ actor_email: string; action: string }>();
    const actions = rows.results.map((r) => r.action);
    expect(actions).toEqual([
      "booking.claimed",
      "booking.sending",
      "booking.sent_unverified",
      "booking.bank_entry_verified",
      "booking.sending",
      "booking.sent_unverified",
      "booking.matched",
    ]);
    expect(rows.results.every((r) => r.actor_email === "system")).toBe(true);
    // Audit rows carry codes and counts only.
    const sample = await auditRows("booking.sending");
    expect(sample.length).toBeGreaterThan(0);
    for (const a of sample) expect(a.after_json).not.toMatch(/Journal|BankEntryLines|<eExact/);
  });

  it("no IBAN, token or bank text beyond the sanitised description is stored in the outbox", async () => {
    const s = await seedBookable(w, fake);
    await db
      .prepare(
        "UPDATE bank_transactions SET reference = 'Invoice 5 pay NL91 ABNA 0417 1643 00 thanks', counterparty_iban = 'NL91ABNA0417164300' WHERE id = ?1",
      )
      .bind(s.txId)
      .run();
    await runBooking(fake);
    const rows = await db
      .prepare("SELECT payload_json FROM exact_write_outbox")
      .all<{ payload_json: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results) {
      expect(r.payload_json).not.toMatch(/NL91\s?ABNA\s?0417\s?1643\s?00/i);
      expect(r.payload_json).not.toMatch(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/);
      expect(r.payload_json).not.toMatch(/token|secret|bearer/i);
    }
    const all = JSON.stringify(fake.calls.map((c) => c.body ?? ""));
    expect(all).not.toMatch(/NL91ABNA0417164300/);
  });

  it("the job result holds counts and codes only", async () => {
    await seedBookable(w, fake);
    const r = await runBooking(fake);
    for (const [k, v] of Object.entries(r.summary)) {
      expect(typeof v === "number" || Array.isArray(v), k).toBe(true);
    }
    expect(JSON.stringify(r).length).toBeLessThan(500);
  });

  it("D1 operations grow linearly with the matches, with a fixed cost per match", async () => {
    await seedBookable(w, fake);
    const one = countingDb();
    await runBooking(fake, { db: one.db });
    const perMatch = one.ops();
    expect(perMatch).toBeLessThan(60);
    // Four more matches (and plenty of unrelated rows) cost four times as much, not more.
    w = await bookingWorld({ creates: true });
    fake = new FakeExact();
    fake.closing.set("90", 100_000);
    for (let i = 0; i < 4; i++) await seedBookable(w, fake, { amountMinor: 1_000 + i });
    const four = countingDb();
    await runBooking(fake, { db: four.db });
    expect(four.ops()).toBeLessThan(4 * perMatch + 15);
  });

  it("the Exact calls per match are bounded as well (budget 30 per run)", async () => {
    await seedBookable(w, fake);
    const r = await runBooking(fake);
    expect(r.callsUsed).toBeLessThanOrEqual(12);
  });
});
