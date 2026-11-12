/**
 * Review of U1 (booking path): independent probes of the fixes, written by the reviewer.
 *
 *  - Somebody else's settlement is never taken for ours: after an unclear post of ours, closed
 *    items count as booked only when OUR bank line is closed as well (A15c), in the run that retries
 *    and in a later run that looks at a `sent_unverified` row.
 *  - The admin's opening balance changed after the claim: nothing is posted.
 *  - The database refuses to erase what says something MAY be in Exact (attempts, exact_ref, the
 *    stage 'none' payload), to delete a sent row (which would let a booked match go back to
 *    not_booked), and to call an outcome_unknown row verified.
 *  - Enabling with the shape the enable dialog sends (divisions, per-run cap, watermark together),
 *    and the backlog for a PROPOSED watermark.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BOOKING_VERIFY_CHECKS, type BookingSettingsResponse } from "@camelthorn/core";
import { transition } from "../src/booking/outbox";
import { ENABLE_PHRASE, VERIFY_PHRASE } from "../src/booking/settings";
import { FakeExact } from "./booking-fake-exact";
import {
  bookingWorld,
  matchRow,
  NOW,
  outbox,
  runBooking,
  seedBookable,
  withoutTriggers,
  type BookingWorld,
} from "./booking-helpers";
import { addSession, addUser, authed, db, resetDb } from "./helpers";
import { auditRows } from "./sync-helpers";

const iso = (ms: number): string => new Date(ms).toISOString();
const run = (sql: string, ...binds: unknown[]): Promise<D1Result> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run();

let w: BookingWorld;
let fake: FakeExact;

/** A person's retry of a row (what the resolve route does), straight through `transition`. */
async function adminRetry(matchId: number, kind: "bank_entry" | "matchset"): Promise<void> {
  const row = (await outbox(matchId)).find((r) => r.kind === kind)!;
  const m = await matchRow(matchId);
  const ok = await transition(db, {
    rowId: row.id,
    matchId,
    from: [row.status as "outcome_unknown"],
    to: "pending",
    token: null,
    nowIso: iso(NOW),
    needsProbe: true,
    nextAttemptAt: null,
    adminResolved: { by: "admin@camelthorncapital.com", at: iso(NOW) },
    ...(m.exact_state === "outcome_unknown" || m.exact_state === "booking_failed"
      ? { match: { from: m.exact_state, to: "booking", note: null } }
      : {}),
    actor: "admin@camelthorncapital.com",
    action: "booking.retry",
    audit: {},
  });
  expect(ok).toBe(true);
}

describe("review: closed items are ours only when our bank line is closed too", () => {
  beforeEach(async () => {
    fake = new FakeExact();
    fake.closing.set("90", 100_000);
    w = await bookingWorld({ creates: true });
  });

  it("our MatchSet never arrived, somebody else settled the invoice: manual, NEVER matched_in_exact", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["timeout_not_performed"]; // classified 'network': it may have landed
    await runBooking(fake);
    expect((await outbox(s.matchId)).find((r) => r.kind === "matchset")).toMatchObject({
      status: "outcome_unknown",
      attempts: 1,
      last_error_code: "network",
    });
    expect(fake.matchSets).toHaveLength(0);
    // Somebody settles the invoice in Exact with another payment; our bank line stays open.
    fake.items.find((i) => i.openMinor > 0)!.paid = true;
    await adminRetry(s.matchId, "matchset");
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts("matchset")).toHaveLength(1); // never posted again
    expect(await matchRow(s.matchId)).toMatchObject({
      exact_state: "manual_required",
      exact_note: "already_settled_in_exact",
      booked_at: null,
    });
  });

  it("our MatchSet did arrive (answer lost): both the items and our bank line are closed, booked", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["lost"];
    await runBooking(fake);
    await adminRetry(s.matchId, "matchset");
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts("matchset")).toHaveLength(1);
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
    const a = (await auditRows("booking.matched")).at(-1);
    expect(a?.after_json).toContain("verified_by_readback");
  });

  it("a LATER run's look at an accepted but invisible MatchSet: somebody else's settlement is not ours", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["ok_unapplied"]; // Exact said yes, nothing visible
    await runBooking(fake);
    expect((await outbox(s.matchId)).find((r) => r.kind === "matchset")?.status).toBe(
      "sent_unverified",
    );
    fake.items.find((i) => i.openMinor > 0)!.paid = true; // the invoice only
    await runBooking(fake, { now: NOW + 20 * 60_000 });
    expect(await matchRow(s.matchId)).toMatchObject({
      exact_state: "manual_required",
      exact_note: "already_settled_in_exact",
    });
  });

  it("a LATER run sees the accepted MatchSet applied (items and bank line closed): booked", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["ok_unapplied"];
    await runBooking(fake);
    for (const i of fake.items) i.paid = true; // Exact applied it late
    await runBooking(fake, { now: NOW + 20 * 60_000 });
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });

  it("feed mode: a feed line that is not on the relation can never prove the match ours", async () => {
    w = await bookingWorld({ creates: false });
    const s = await seedBookable(w, fake);
    fake.addFeedLine({ journal: "90", amountMinor: 12_345, yourRef: s.txExternalId });
    fake.modes.matchset = ["lost"];
    await runBooking(fake);
    await adminRetry(s.matchId, "matchset");
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(await matchRow(s.matchId)).toMatchObject({
      exact_state: "manual_required",
      exact_note: "bank_line_readback_inconclusive",
    });
  });

  it("feed mode with the feed line on the relation: the lost answer is verified by the read-back", async () => {
    w = await bookingWorld({ creates: false });
    const s = await seedBookable(w, fake);
    const rel = fake.items[0]!.account;
    fake.addFeedLine({ journal: "90", amountMinor: 12_345, yourRef: s.txExternalId, account: rel });
    fake.modes.matchset = ["lost"];
    await runBooking(fake);
    await adminRetry(s.matchId, "matchset");
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect((await matchRow(s.matchId)).exact_state).toBe("matched_in_exact");
  });

  it("the admin corrects the opening balance after the claim: the row built on the old one never posts", async () => {
    fake.closing.clear();
    await db.prepare("UPDATE bank_account_exact_map SET opening_balance_minor = 50000").run();
    const s = await seedBookable(w, fake);
    await runBooking(fake, { budget: 2 });
    expect(await outbox(s.matchId)).toMatchObject([{ kind: "bank_entry", status: "pending" }]);
    await db.prepare("UPDATE bank_account_exact_map SET opening_balance_minor = 51000").run();
    await runBooking(fake, { now: NOW + 10 * 60_000 });
    expect(fake.posts()).toHaveLength(0);
    expect((await outbox(s.matchId))[0]).toMatchObject({
      status: "manual_required",
      last_error_code: "bank_balance_changed",
    });
  });
});

describe("review: the database never erases what says something MAY be in Exact", () => {
  beforeEach(async () => {
    fake = new FakeExact();
    fake.closing.set("90", 100_000);
    w = await bookingWorld({ creates: true });
  });

  it("a sent row cannot be deleted, so a booked match can never go back to not_booked", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["lost"];
    await runBooking(fake);
    expect((await matchRow(s.matchId)).exact_state).toBe("outcome_unknown");
    await expect(
      run("DELETE FROM exact_write_outbox WHERE match_id = ?1", s.matchId),
    ).rejects.toThrow(/booking_err:not_deletable/);
    await expect(
      run("UPDATE matches SET exact_state = 'not_booked' WHERE id = ?1", s.matchId),
    ).rejects.toThrow(/match_err:bad_transition/);
    await expect(
      run("UPDATE matches SET undone_at = 'x', undone_by = 'x' WHERE id = ?1", s.matchId),
    ).rejects.toThrow(/match_err:bad_transition/);
  });

  it("forging an unsent claim fails: attempts, exact_ref and the payload stage are kept", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["lost"];
    await runBooking(fake);
    const ms = (await outbox(s.matchId)).find((r) => r.kind === "matchset")!;
    const be = (await outbox(s.matchId)).find((r) => r.kind === "bank_entry")!;
    await expect(
      run("UPDATE exact_write_outbox SET attempts = 0 WHERE id = ?1", ms.id),
    ).rejects.toThrow(/booking_err:sent_facts/);
    await expect(
      run(
        `UPDATE exact_write_outbox SET payload_json = '{"v":1,"stage":"none","reason":"x"}' WHERE id = ?1`,
        ms.id,
      ),
    ).rejects.toThrow(/booking_err:sent_facts/);
    // the verified bank entry row is final: nothing about it changes
    await expect(
      run("UPDATE exact_write_outbox SET exact_ref = NULL WHERE id = ?1", be.id),
    ).rejects.toThrow(/booking_err:/);
  });

  it("exact_ref, once known, is never cleared on an open row either", async () => {
    w = await bookingWorld({ creates: false });
    const s = await seedBookable(w, fake);
    fake.addFeedLine({ journal: "90", amountMinor: 12_345, yourRef: s.txExternalId });
    fake.modes.matchset = ["timeout_not_performed"];
    await runBooking(fake);
    const ms = (await outbox(s.matchId))[0]!;
    expect(ms.exact_ref).not.toBeNull();
    await expect(
      run("UPDATE exact_write_outbox SET exact_ref = NULL WHERE id = ?1", ms.id),
    ).rejects.toThrow(/booking_err:sent_facts/);
  });

  it("an outcome_unknown row is never 'verified' by the app (only a person decides)", async () => {
    const s = await seedBookable(w, fake);
    fake.modes.matchset = ["lost"];
    await runBooking(fake);
    const ms = (await outbox(s.matchId)).find((r) => r.kind === "matchset")!;
    expect(ms.status).toBe("outcome_unknown");
    for (const to of ["verified", "manual_required", "sending", "sent_unverified"]) {
      await expect(
        run("UPDATE exact_write_outbox SET status = ?2 WHERE id = ?1", ms.id, to),
      ).rejects.toThrow(/booking_err:bad_transition/);
    }
  });

  it("a stage 'none' row in a status other than manual_required makes the claim not undoable", async () => {
    const s = await seedBookable(w, fake, { amountMinor: 5_000, openMinor: 9_000 }); // part payment
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0]!;
    expect(row.status).toBe("manual_required");
    for (const status of ["sending", "sent_unverified", "outcome_unknown"]) {
      await withoutTriggers(["outbox_guard_status"], () =>
        run("UPDATE exact_write_outbox SET status = ?2 WHERE id = ?1", row.id, status),
      );
      await expect(
        run("UPDATE matches SET undone_at = 'x', undone_by = 'x' WHERE id = ?1", s.matchId),
      ).rejects.toThrow(/match_err:bad_transition/);
      await expect(run("DELETE FROM exact_write_outbox WHERE id = ?1", row.id)).rejects.toThrow(
        /booking_err:not_deletable/,
      );
    }
  });

  it("the unsent stage 'none' row can still be removed by Undo, and a finished one can still be redacted", async () => {
    const s = await seedBookable(w, fake, { amountMinor: 5_000, openMinor: 9_000 });
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0]!;
    // given up by a person: terminal; the retention job may still redact the payload (migration 0025)
    await run("UPDATE exact_write_outbox SET status = 'given_up' WHERE id = ?1", row.id);
    await run(
      `UPDATE exact_write_outbox SET payload_json = json_object('v', 1, 'stage', 'redacted', 'input',
         json_object('bankEntryNumber', json_extract(payload_json, '$.input.bankEntryNumber'))) WHERE id = ?1`,
      row.id,
    );
    const s2 = await seedBookable(w, fake, { amountMinor: 4_000, openMinor: 9_000 });
    await runBooking(fake, { now: NOW + 60_000 });
    const r2 = (await outbox(s2.matchId))[0]!;
    await run("DELETE FROM exact_write_outbox WHERE id = ?1", r2.id);
  });
});

describe("review: the enable dialog's shape and the proposed watermark", () => {
  let admin: string;
  let stale: string;
  beforeEach(async () => {
    await resetDb();
    fake = new FakeExact();
    w = await bookingWorld({ creates: true, enabled: false, verified: false });
    admin = await addSession(await addUser("admin@camelthorncapital.com", ["admin"]));
    stale = await addSession(await addUser("stale@camelthorncapital.com", ["admin"]), {
      lastAuthAgoMs: 20 * 60_000,
    });
  });
  const send = async (
    token: string,
    method: string,
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await authed(path, token, { method, ...(json !== undefined ? { json } : {}) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const verify = () =>
    send(admin, "POST", "/api/booking/verify", {
      note: "Created one bank entry and one MatchSet on the test division and checked both.",
      confirm: VERIFY_PHRASE,
      checks: [...BOOKING_VERIFY_CHECKS],
    });

  it("enables with divisions, per-run cap and a watermark in one call; the watermark is never earlier than now", async () => {
    await send(admin, "PUT", "/api/booking/settings", { divisions: [] });
    expect((await verify()).status).toBe(200);
    const before = Date.now();
    const r = await send(admin, "PUT", "/api/booking/settings", {
      enabled: true,
      confirm: ENABLE_PHRASE,
      divisions: [w.divisionId],
      maxPerRun: 3,
      bookingFrom: "2026-01-01T00:00:00.000Z", // the dialog's clock, minutes old at most: never earlier
    });
    expect(r.status).toBe(200);
    const s = r.body as unknown as BookingSettingsResponse;
    expect(s.enabled).toBe(true);
    expect(s.divisions).toEqual([w.divisionId]);
    expect(s.maxPerRun).toBe(3);
    expect(Date.parse(s.bookingFrom ?? "")).toBeGreaterThanOrEqual(before - 1000);
    expect(await auditRows("booking.limits_changed")).toHaveLength(2);
    expect((await auditRows("booking.enabled")).at(-1)?.after_json).toContain('"maxPerRun":3');
  });

  it("a watermark sent with the switch may move it later (at most a day), not further", async () => {
    await verify();
    const later = new Date(Date.now() + 3600_000).toISOString();
    const r = await send(admin, "PUT", "/api/booking/settings", {
      enabled: true,
      confirm: ENABLE_PHRASE,
      bookingFrom: later,
    });
    expect((r.body as unknown as BookingSettingsResponse).bookingFrom).toBe(later);
    await verify();
    const far = await send(admin, "PUT", "/api/booking/settings", {
      enabled: true,
      confirm: ENABLE_PHRASE,
      bookingFrom: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    expect([far.status, far.body["error"]]).toEqual([400, "booking_from_in_future"]);
  });

  it("without a fresh sign-in nothing is written, the allow-list included; switching off takes no limits", async () => {
    await send(admin, "PUT", "/api/booking/settings", { divisions: [] });
    await verify();
    const r = await send(stale, "PUT", "/api/booking/settings", {
      enabled: true,
      confirm: ENABLE_PHRASE,
      divisions: [w.divisionId],
    });
    expect(r.status).toBe(401);
    const s = (await send(admin, "GET", "/api/booking/settings"))
      .body as unknown as BookingSettingsResponse;
    expect([s.enabled, s.divisions]).toEqual([false, []]);
    const off = await send(admin, "PUT", "/api/booking/settings", {
      enabled: false,
      divisions: [w.divisionId],
    });
    expect([off.status, off.body["error"]]).toEqual([400, "bad_request"]);
  });

  it("a wrong phrase writes no limits either", async () => {
    await send(admin, "PUT", "/api/booking/settings", { divisions: [] });
    await verify();
    const r = await send(admin, "PUT", "/api/booking/settings", {
      enabled: true,
      confirm: "enable",
      divisions: [w.divisionId],
    });
    expect(r.status).toBe(400);
    const s = (await send(admin, "GET", "/api/booking/settings"))
      .body as unknown as BookingSettingsResponse;
    expect(s.divisions).toEqual([]);
  });

  it("GET ?bookingFrom= shows what a lower watermark would re-open, before the change is made", async () => {
    await run("DELETE FROM settings WHERE key = 'exact.booking_from'");
    await seedBookable(w, fake, { createdAt: "2026-07-10T08:00:00.000Z" });
    await seedBookable(w, fake, { createdAt: "2026-07-12T08:00:00.000Z" });
    await seedBookable(w, fake, { createdAt: "2026-07-14T08:00:00.000Z" });
    await run(
      `INSERT INTO settings (key, value_json, updated_by) VALUES ('exact.booking_from', '"2026-07-13T00:00:00.000Z"', 't')`,
    );
    const r = await send(
      admin,
      "GET",
      "/api/booking/settings?bookingFrom=2026-07-11T00:00:00.000Z",
    );
    const s = r.body as unknown as BookingSettingsResponse;
    expect(s.backlogCount).toBe(2);
    expect(s.proposed).toEqual({
      bookingFrom: "2026-07-11T00:00:00.000Z",
      backlogCount: 1,
      reopenedCount: 1,
    });
    // the change itself still needs a fresh sign-in and records the re-opened count
    const put = { bookingFrom: "2026-07-11T00:00:00.000Z" };
    expect((await send(stale, "PUT", "/api/booking/settings", put)).status).toBe(401);
    expect((await send(admin, "PUT", "/api/booking/settings", put)).status).toBe(200);
    expect((await auditRows("booking.limits_changed")).at(-1)?.after_json).toContain(
      '"reopenedCount":1',
    );
    const bad = await send(admin, "GET", "/api/booking/settings?bookingFrom=yesterday");
    expect([bad.status, bad.body["error"]]).toEqual([400, "bad_booking_from"]);
  });
});
