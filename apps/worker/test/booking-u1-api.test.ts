/**
 * Phase 7 final review fixes in the booking API (task U1, ADR 0044 "Final review"): the limits
 * (watermark, allow-list, per-run cap), the enabling matrix with the new blockers, the verification
 * checklist (S7), the preview dry run (S8), the mode flip (B2d), undo and retry of an unsent claim
 * (B1), booked_manually (N7), booking health in the matching stats (S10, N6), the opening balance.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOKING_VERIFY_CHECKS,
  type BookingPreviewResponse,
  type BookingResolveResponse,
  type BookingSettingsResponse,
  type MatchDetailResponse,
  type MatchStatsResponse,
  type MatchUndoResponse,
} from "@camelthorn/core";
import { BOOKING_PROTOCOL_VERSION } from "../src/booking/protocol";
import {
  setPreviewTransportForTests,
  PREVIEW_PLACEHOLDER_ENTRY_NUMBER,
} from "../src/booking/preview";
import { ENABLE_PHRASE, VERIFY_PHRASE } from "../src/booking/settings";
import { checkMatchingInvariants } from "../src/matching/invariants";
import { FakeExact } from "./booking-fake-exact";
import {
  bookingWorld,
  matchRow,
  NOW,
  outbox,
  runBooking,
  seedBookable,
  setBooking,
  type BookingWorld,
} from "./booking-helpers";
import { addSession, addUser, authed, call, db, resetDb } from "./helpers";
import { auditRows } from "./sync-helpers";

type Role = "admin" | "finance" | "approver" | "viewer";
const tokens = {} as Record<Role | "staleAdmin", string>;
let w: BookingWorld;
let fake: FakeExact;

beforeEach(async () => {
  await resetDb();
  w = await bookingWorld({ creates: true, enabled: false, verified: false });
  fake = new FakeExact();
  fake.closing.set("90", 100_000);
  setPreviewTransportForTests(() => fake.transport);
  for (const role of ["admin", "finance", "approver", "viewer"] as const) {
    tokens[role] = await addSession(await addUser(`${role}@camelthorncapital.com`, [role]));
  }
  tokens.staleAdmin = await addSession(await addUser("stale@camelthorncapital.com", ["admin"]), {
    lastAuthAgoMs: 20 * 60_000,
  });
});
afterEach(() => {
  setPreviewTransportForTests(undefined);
});

async function send<T = Record<string, unknown>>(
  role: Role | "staleAdmin",
  method: string,
  path: string,
  json?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await authed(path, tokens[role], { method, ...(json !== undefined ? { json } : {}) });
  return { status: res.status, body: (await res.json()) as T };
}
const settings = () => send<BookingSettingsResponse>("viewer", "GET", "/api/booking/settings");
const err = (r: { body: unknown }): unknown => (r.body as { error?: unknown }).error;
const put = (role: Role | "staleAdmin", body: Record<string, unknown>) =>
  send(role, "PUT", "/api/booking/settings", body);
const verify = (over: Record<string, unknown> = {}, role: Role | "staleAdmin" = "admin") =>
  send(role, "POST", "/api/booking/verify", {
    note: "Created one bank entry and one MatchSet on the test division and checked both in Exact.",
    confirm: VERIFY_PHRASE,
    checks: [...BOOKING_VERIFY_CHECKS],
    ...over,
  });
const enable = (role: Role | "staleAdmin" = "admin") =>
  put(role, { enabled: true, confirm: ENABLE_PHRASE });
const rawSetting = async (key: string): Promise<string | null> =>
  (
    await db
      .prepare("SELECT value_json FROM settings WHERE key = ?1")
      .bind(key)
      .first<{ value_json: string }>()
  )?.value_json ?? null;

describe("S7: the verification needs EVERY check, ticked", () => {
  it("refuses a missing, partial, extended or duplicated list and a wrong type (400 checks_incomplete)", async () => {
    const all = [...BOOKING_VERIFY_CHECKS];
    const bad: unknown[] = [
      undefined,
      null,
      "all",
      [],
      all.slice(1),
      all.slice(0, -1),
      [...all, "something_else"],
      [...all.slice(0, -1), "unknown_check"],
      [...all, all[0]],
      [...all.slice(1), all[1]],
      all.map((c) => c.toUpperCase()),
      [{}, ...all.slice(1)],
    ];
    for (const checks of bad) {
      const r = await verify({ checks });
      expect([r.status, err(r)], JSON.stringify(checks)).toEqual([400, "checks_incomplete"]);
    }
    expect((await settings()).body.verified).toBeNull();
    expect(await auditRows("booking.verified")).toHaveLength(0);
  });

  it("accepts the full set in any order, stores the codes and the booking mode in the mark", async () => {
    const shuffled = [...BOOKING_VERIFY_CHECKS].reverse();
    const r = await verify({ checks: shuffled });
    expect(r.status).toBe(200);
    const s = (await settings()).body;
    expect(s.verified).toMatchObject({
      checks: [...BOOKING_VERIFY_CHECKS],
      createsBankEntries: true,
      protocolVersion: BOOKING_PROTOCOL_VERSION,
    });
    expect((await auditRows("booking.verified")).at(-1)?.after_json).toContain(
      "preview_matches_manual_payload",
    );
  });

  it("the phrase and the note keep their rules; a mode that was never decided cannot be verified", async () => {
    expect(err(await verify({ confirm: "yes" }))).toBe("confirmation_required");
    expect(err(await verify({ note: "short" }))).toBe("bad_note");
    await db
      .prepare("UPDATE connections SET bank_entries_decided_at = NULL WHERE kind = 'revolut'")
      .run();
    const r = await verify();
    expect([r.status, err(r)]).toEqual([409, "bank_entries_undecided"]);
  });

  it("a mark without the checks or the mode (an older mark) does not count: not_verified", async () => {
    await db
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES ('exact.booking_verified', ?1)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .bind(
        JSON.stringify({
          at: "2026-07-01T00:00:00.000Z",
          by: "x@camelthorncapital.com",
          note: "old mark without checks",
          protocolVersion: BOOKING_PROTOCOL_VERSION,
        }),
      )
      .run();
    expect((await settings()).body.verified).toBeNull();
    expect((await settings()).body.blockers).toContain("not_verified");
  });
});

describe("B2b/B2c: the limits (watermark, allow-list, per-run cap)", () => {
  it("only an admin; narrowing needs no fresh sign-in, widening does", async () => {
    for (const role of ["finance", "approver", "viewer"] as const) {
      expect((await put(role, { maxPerRun: 2 })).status).toBe(403);
    }
    // 10 -> 3 is narrowing (the test helper starts at 10)
    expect((await put("staleAdmin", { maxPerRun: 3 })).status).toBe(200);
    expect((await settings()).body.maxPerRun).toBe(3);
    // 3 -> 4 widens
    const r = await put("staleAdmin", { maxPerRun: 4 });
    expect([r.status, err(r)]).toEqual([401, "step_up_required"]);
    expect((await put("admin", { maxPerRun: 4 })).status).toBe(200);
    expect((await settings()).body.maxPerRun).toBe(4);
    // dropping a division is narrowing, adding one widens, an earlier watermark widens
    expect((await put("staleAdmin", { divisions: [] })).status).toBe(200);
    expect(err(await put("staleAdmin", { divisions: [w.divisionId] }))).toBe("step_up_required");
    expect((await put("admin", { divisions: [w.divisionId] })).status).toBe(200);
    expect(err(await put("staleAdmin", { bookingFrom: "2025-01-01T00:00:00Z" }))).toBe(
      "step_up_required",
    );
    expect((await put("staleAdmin", { bookingFrom: "2026-03-01T00:00:00Z" })).status).toBe(200);
  });

  it("validates every field; the watermark may be at most one day in the future", async () => {
    const now = Date.now();
    const day = 24 * 3600_000;
    expect(err(await put("admin", { maxPerRun: 0 }))).toBe("bad_max_per_run");
    expect(err(await put("admin", { maxPerRun: 11 }))).toBe("bad_max_per_run");
    expect(err(await put("admin", { maxPerRun: 1.5 }))).toBe("bad_max_per_run");
    expect(err(await put("admin", { maxPerRun: "3" }))).toBe("bad_max_per_run");
    expect(err(await put("admin", { divisions: "1" }))).toBe("bad_divisions");
    expect(err(await put("admin", { divisions: [0] }))).toBe("bad_divisions");
    expect(err(await put("admin", { divisions: [1.5] }))).toBe("bad_divisions");
    const unknown = await put("admin", { divisions: [w.divisionId + 5000] });
    expect([unknown.status, err(unknown)]).toEqual([422, "unknown_division"]);
    expect(err(await put("admin", { bookingFrom: "not a date" }))).toBe("bad_booking_from");
    expect(err(await put("admin", { bookingFrom: 5 }))).toBe("bad_booking_from");
    expect(err(await put("admin", { bookingFrom: new Date(now + 2 * day).toISOString() }))).toBe(
      "booking_from_in_future",
    );
    expect(
      (await put("admin", { bookingFrom: new Date(now + day / 2).toISOString() })).status,
    ).toBe(200);
    // nothing to change, or the two shapes mixed
    expect(err(await put("admin", {}))).toBe("bad_request");
    expect(err(await put("admin", { enabled: false, maxPerRun: 2 }))).toBe("bad_request");
    expect(err(await put("admin", { maxPerRun: 2, confirm: ENABLE_PHRASE }))).toBe("bad_request");
  });

  it("every change is audited with before and after", async () => {
    await put("admin", { maxPerRun: 2, note: "canary" });
    const a = (await auditRows("booking.limits_changed")).at(-1);
    expect(a?.actor_email).toBe("admin@camelthorncapital.com");
    expect(a?.before_json).toContain('"maxPerRun":10');
    expect(a?.after_json).toContain('"maxPerRun":2');
  });

  it("GET shows the backlog: matches older than the watermark (all of them before booking was ever on)", async () => {
    await db.prepare("DELETE FROM settings WHERE key = 'exact.booking_from'").run();
    await seedBookable(w, fake);
    await seedBookable(w, fake);
    const s1 = (await settings()).body;
    expect([s1.bookingFrom, s1.backlogCount]).toEqual([null, 2]);
    await put("admin", { bookingFrom: "2026-07-15T08:30:00.000Z" });
    // both matches were created at 08:00
    expect((await settings()).body.backlogCount).toBe(2);
    await put("admin", { bookingFrom: "2026-07-15T07:30:00.000Z" });
    expect((await settings()).body.backlogCount).toBe(0);
  });
});

describe("B2: enabling sets the watermark and needs an allowed division", () => {
  it("enabling sets booking_from to NOW, again on every re-enable; the audit row has the backlog", async () => {
    await seedBookable(w, fake);
    expect((await verify()).status).toBe(200);
    const before = Date.now();
    const r = await enable();
    expect(r.status).toBe(200);
    const s = r.body as unknown as BookingSettingsResponse;
    expect(Date.parse(s.bookingFrom ?? "")).toBeGreaterThanOrEqual(before - 1000);
    expect(s.backlogCount).toBe(1); // the match made before the switch-on is backlog
    const a = (await auditRows("booking.enabled")).at(-1);
    expect(a?.after_json).toContain('"backlogCount":1');
    expect(a?.after_json).toContain("bookingFrom");
    // off and on again: the watermark moves again
    await put("admin", { enabled: false });
    await db
      .prepare(
        "UPDATE settings SET value_json = '\"2026-01-01T00:00:00.000Z\"' WHERE key = 'exact.booking_from'",
      )
      .run();
    await verify();
    await enable();
    expect(
      Date.parse(JSON.parse((await rawSetting("exact.booking_from")) ?? '""') as string),
    ).toBeGreaterThan(Date.parse("2026-07-01T00:00:00Z"));
  });

  it("an empty allow-list is a blocker (no_division_allowed) and enabling is refused", async () => {
    await verify();
    await put("admin", { divisions: [] });
    const r = await enable();
    expect([r.status, err(r)]).toEqual([409, "blocked"]);
    expect((r.body as unknown as { blockers: string[] }).blockers).toEqual(["no_division_allowed"]);
    expect((await settings()).body.enabled).toBe(false);
  });

  it("a verification made under the other booking mode is a blocker (mode_changed)", async () => {
    await verify();
    await db
      .prepare("UPDATE connections SET creates_bank_entries = 0 WHERE kind = 'revolut'")
      .run();
    const s = (await settings()).body;
    expect(s.blockers).toEqual(["mode_changed", "writes_disabled"]);
    const r = await enable();
    expect([r.status, err(r)]).toEqual([409, "blocked"]);
  });

  it("a missing control account or an unmapped journal blocks ENABLING (not the running job)", async () => {
    await seedBookable(w, fake);
    await verify();
    await db.prepare("UPDATE bank_account_exact_map SET payable_gl_account_code = NULL").run();
    expect((await settings()).body.blockers).not.toContain("control_accounts_missing"); // an invoice needs the receivable one
    await db.prepare("UPDATE bank_account_exact_map SET receivable_gl_account_code = NULL").run();
    expect((await settings()).body.blockers).toContain("control_accounts_missing");
    const r = await enable();
    expect([r.status, err(r)]).toEqual([409, "blocked"]);
    expect((r.body as unknown as { blockers: string[] }).blockers).toEqual([
      "control_accounts_missing",
    ]);
  });

  it("the write itself re-checks the allow-list and the mode (a change between read and write cannot slip through)", async () => {
    await verify();
    const handler = enable();
    await put("admin", { divisions: [] });
    const r = await handler;
    const s = (await settings()).body;
    if (r.status === 200) expect(s.divisions?.length).toBeGreaterThan(0);
    else expect(s.enabled).toBe(false);
  });
});

describe("B2d: a change of who creates the bank entries switches booking off", () => {
  const patchMode = (role: Role | "staleAdmin", createsBankEntries: boolean) =>
    send(role, "PATCH", "/api/connections/revolut/settings", { createsBankEntries });

  it("while enabled: booking goes OFF in the same batch (audited) and the verification is cleared", async () => {
    await setBooking(true, true);
    const r = await patchMode("admin", false);
    expect(r.status).toBe(200);
    const s = (await settings()).body;
    expect(s.enabled).toBe(false);
    expect(s.verified).toBeNull();
    expect(s.blockers).toContain("not_verified");
    expect(await rawSetting("exact.booking_verified")).toBeNull();
    const a = (await auditRows("booking.disabled")).at(-1);
    expect(a?.actor_email).toBe("admin@camelthorncapital.com");
    expect(a?.after_json).toContain("booking_mode_changed");
    expect((await auditRows("connection.revolut_settings_changed")).length).toBeGreaterThan(0);
  });

  it("a stale sign-in changes nothing, booking stays on", async () => {
    await setBooking(true, true);
    const r = await patchMode("staleAdmin", false);
    expect(r.status).toBe(401);
    const s = (await settings()).body;
    expect(s.enabled).toBe(true);
    expect(s.verified).not.toBeNull();
  });

  it("setting the same mode again changes nothing", async () => {
    await setBooking(true, true);
    await patchMode("admin", true);
    expect((await settings()).body.enabled).toBe(true);
  });

  it("while booking is off the verification stays, but is no longer valid (mode_changed)", async () => {
    await setBooking(false, true);
    await patchMode("admin", false);
    const s = (await settings()).body;
    expect(s.verified).not.toBeNull();
    expect(s.blockers).toContain("mode_changed");
  });
});

describe("S8: the preview is a dry run", () => {
  const preview = (role: Role | "staleAdmin", matchIds: unknown) =>
    send<BookingPreviewResponse>(role, "POST", "/api/booking/preview", { matchIds });

  it("is admin only with a fresh sign-in, and validates its input", async () => {
    const s = await seedBookable(w, fake);
    for (const role of ["finance", "approver", "viewer"] as const) {
      expect((await preview(role, [s.matchId])).status).toBe(403);
    }
    const stale = await preview("staleAdmin", [s.matchId]);
    expect([stale.status, err(stale)]).toEqual([401, "step_up_required"]);
    for (const bad of [undefined, [], "1", [0], [1.5], [1, 2, 3, 4], [-1], [{}]]) {
      const r = await preview("admin", bad);
      expect([r.status, err(r)], JSON.stringify(bad)).toEqual([400, "bad_match_ids"]);
    }
    expect(fake.calls).toHaveLength(0);
    // CSRF: the router refuses a state-changing request without the custom header.
    const res = await call("/api/booking/preview", {
      method: "POST",
      headers: { cookie: `__Host-session=${tokens.admin}`, "content-type": "application/json" },
      body: JSON.stringify({ matchIds: [s.matchId] }),
    });
    expect(res.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it("returns the REAL bodies, and they are exactly what the executor then posts", async () => {
    const s = await seedBookable(w, fake);
    const p = await preview("admin", [s.matchId]);
    expect(p.status).toBe(200);
    const item = p.body.items[0]!;
    expect(item).toMatchObject({
      matchId: s.matchId,
      mode: "matched",
      wouldDefer: null,
      matchSetBankLinePlaceholder: true,
      reads: {
        probeHits: 0,
        closingBalanceMinor: 100_000,
        openingBalanceSource: "exact",
        preflight: "open_as_expected",
        readError: null,
      },
    });
    expect(item.bankEntryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(item.matchSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(item.bankEntryBody).toContain('"OpeningBalanceFC":1000');
    // Nothing was written or stored: no POST, no outbox row, no state change, no idempotency key.
    expect(fake.posts()).toHaveLength(0);
    expect(await outbox()).toEqual([]);
    expect((await matchRow(s.matchId)).exact_state).toBe("not_booked");
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope LIKE 'exact.write.%'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    // Reads only, as the preview job at user priority.
    for (const c of fake.calls) {
      expect([c.method, c.jobId, c.priority]).toEqual(["GET", "exact-booking-preview", "user"]);
    }

    // Now book it for real and compare byte for byte.
    await setBooking(true, true);
    await runBooking(fake);
    expect(fake.entries[0]?.body).toBe(item.bankEntryBody);
    const posted = fake.posts("matchset")[0]?.body ?? "";
    const entryNumber = fake.entries[0]?.entryNumber ?? 0;
    expect(posted).toBe(
      (item.matchSetXml ?? "").replace(
        `<EntryNumber>${PREVIEW_PLACEHOLDER_ENTRY_NUMBER}</EntryNumber>`,
        `<EntryNumber>${entryNumber}</EntryNumber>`,
      ),
    );
  });

  it("never writes even when booking is enabled, and only one audit row with ids and hashes", async () => {
    await setBooking(true, true);
    const s = await seedBookable(w, fake);
    const audited = (await auditRows("booking.preview")).length;
    const p = await preview("admin", [s.matchId, s.matchId]); // duplicates collapse
    expect(p.body.items).toHaveLength(1);
    expect(fake.posts()).toHaveLength(0);
    expect(await outbox()).toEqual([]);
    expect(await auditRows("booking.preview")).toHaveLength(audited + 1);
    const a = (await auditRows("booking.preview")).at(-1);
    expect(a?.actor_email).toBe("admin@camelthorncapital.com");
    expect(a?.after_json).toContain(p.body.items[0]?.bankEntryHash ?? "?");
    // hashes and ids only: no body, no text from the bank
    expect(a?.after_json).not.toMatch(/OpeningBalanceFC|<MatchSet>|Acme/);
  });

  it("says why it would not book: a configuration gap, a fee, items settled in Exact", async () => {
    const gap = await seedBookable(w, fake);
    await db.prepare("UPDATE bank_account_exact_map SET receivable_gl_account_code = NULL").run();
    const a = (await preview("admin", [gap.matchId])).body.items[0]!;
    expect(a.wouldDefer).toEqual({ code: "control_account_unknown" });
    expect(a.bankEntryBody).toBeNull();
    await db.prepare("UPDATE bank_account_exact_map SET receivable_gl_account_code = '1300'").run();

    await db
      .prepare("UPDATE bank_transactions SET fee_minor = 25 WHERE id = ?1")
      .bind(gap.txId)
      .run();
    expect((await preview("admin", [gap.matchId])).body.items[0]?.wouldDefer).toEqual({
      code: "fee_not_supported_v1",
    });
    await db
      .prepare("UPDATE bank_transactions SET fee_minor = NULL WHERE id = ?1")
      .bind(gap.txId)
      .run();

    fake.items[0]!.paid = true;
    const settled = (await preview("admin", [gap.matchId])).body.items[0]!;
    expect(settled.reads.preflight).toBe("already_settled");
    expect(settled.wouldDefer).toEqual({ code: "preflight_already_settled" });
    expect(fake.posts()).toHaveLength(0);
  });

  it("an empty journal: the admin's opening balance is used and named, else bank_balance_unknown", async () => {
    fake.closing.clear();
    const s = await seedBookable(w, fake);
    expect((await preview("admin", [s.matchId])).body.items[0]).toMatchObject({
      wouldDefer: { code: "bank_balance_unknown" },
      bankEntryBody: null,
    });
    await db.prepare("UPDATE bank_account_exact_map SET opening_balance_minor = 50000").run();
    const p = (await preview("admin", [s.matchId])).body.items[0]!;
    expect(p.reads.openingBalanceSource).toBe("admin_opening_balance");
    expect(p.bankEntryBody).toContain('"OpeningBalanceFC":500');
  });

  it("a match that cannot be previewed gets a code, not an error", async () => {
    const r = await preview("admin", [999_999]);
    expect(r.body.items[0]).toMatchObject({ mode: null, wouldDefer: { code: "match_not_found" } });
  });

  it("a read that fails is reported, nothing is guessed", async () => {
    const s = await seedBookable(w, fake);
    fake.hook = () => {
      throw new Error("boom");
    };
    const r = (await preview("admin", [s.matchId])).body.items[0]!;
    expect(r.reads.readError).toBe("read_failed");
    expect(r.bankEntryBody).toBeNull();
  });
});

describe("B1: undo and retry of a claim that never reached Exact", () => {
  async function claimedNone(): Promise<{ matchId: number; txId: number; rowId: number }> {
    await setBooking(true, true);
    const s = await seedBookable(w, fake, { amountMinor: 5_000, openMinor: 9_000 });
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0]!;
    expect(row.status).toBe("manual_required");
    return { matchId: s.matchId, txId: s.txId, rowId: row.id };
  }

  it("the match DTO says it can be undone, and Undo works: rows gone, line unmatched, audited", async () => {
    const c = await claimedNone();
    const d = await send<MatchDetailResponse>(
      "finance",
      "GET",
      `/api/matching/transactions/${c.txId}`,
    );
    expect(d.body.match).toMatchObject({ exactState: "manual_required", undoAvailable: true });
    const r = await send<MatchUndoResponse>(
      "finance",
      "POST",
      `/api/matching/matches/${c.matchId}/undo`,
      {
        reason: "wrong invoice",
      },
    );
    expect(r.status).toBe(200);
    expect(r.body.match.status).toBe("undone");
    expect(await outbox(c.matchId)).toEqual([]);
    const tx = await db
      .prepare("SELECT match_status FROM bank_transactions WHERE id = ?1")
      .bind(c.txId)
      .first<{ match_status: string }>();
    expect(tx?.match_status).toBe("unmatched");
    expect((await auditRows("match.undo")).at(-1)?.after_json).toContain("unsentClaim");
    expect(await checkMatchingInvariants(db)).toEqual([]);
    // twice is a 409, like any undone match
    expect(
      (
        await send("finance", "POST", `/api/matching/matches/${c.matchId}/undo`, {
          reason: "again",
        })
      ).status,
    ).toBe(409);
  });

  it("a claim that held a real payload is still never undone (409 already_booked_in_exact)", async () => {
    await setBooking(true, true);
    const s = await seedBookable(w, fake);
    fake.items[0]!.paid = true; // the bank entry row ends manual_required with a built payload
    await runBooking(fake);
    const d = await send<MatchDetailResponse>(
      "finance",
      "GET",
      `/api/matching/transactions/${s.txId}`,
    );
    expect(d.body.match?.undoAvailable).toBe(false);
    const r = await send("finance", "POST", `/api/matching/matches/${s.matchId}/undo`, {
      reason: "x",
    });
    expect([r.status, err(r)]).toEqual([409, "already_booked_in_exact"]);
    expect((await matchRow(s.matchId)).exact_state).toBe("manual_required");
  });

  it("retry brings it back to not_booked; the next run claims it again (it is still a v1 rule)", async () => {
    const c = await claimedNone();
    const r = await send<BookingResolveResponse>(
      "admin",
      "POST",
      `/api/booking/outbox/${c.rowId}/resolve`,
      {
        resolution: "retry",
        note: "Fixed the mapping",
      },
    );
    expect([r.status, r.body.released]).toEqual([200, true]);
    expect(await matchRow(c.matchId)).toMatchObject({
      exact_state: "not_booked",
      exact_note: null,
    });
    await runBooking(fake, { now: NOW + 60_000 });
    expect((await outbox(c.matchId))[0]?.status).toBe("manual_required");
  });

  it("a deferred match shows its code on the DTO, and can be undone like any unbooked match", async () => {
    await setBooking(true, true);
    await db.prepare("UPDATE bank_account_exact_map SET receivable_gl_account_code = NULL").run();
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    const d = await send<MatchDetailResponse>(
      "finance",
      "GET",
      `/api/matching/transactions/${s.txId}`,
    );
    expect(d.body.match).toMatchObject({
      bookingDeferredCode: "control_account_unknown",
      undoAvailable: true,
      exactState: "not_booked",
    });
    expect(
      (await send("finance", "POST", `/api/matching/matches/${s.matchId}/undo`, { reason: "x" }))
        .status,
    ).toBe(200);
  });
});

describe("N7: booked_manually is told apart from an app booking", () => {
  it("sets bookedManually, a distinct note and audit action; an app booking does not", async () => {
    await setBooking(true, true);
    const manual = await seedBookable(w, fake, { amountMinor: 5_000, openMinor: 9_000 });
    const app = await seedBookable(w, fake, { amountMinor: 2_000 });
    await runBooking(fake);
    const row = (await outbox(manual.matchId))[0]!;
    const r = await send<BookingResolveResponse>(
      "admin",
      "POST",
      `/api/booking/outbox/${row.id}/resolve`,
      {
        resolution: "booked_manually",
        note: "Matched by hand in Exact",
      },
    );
    expect(r.status).toBe(200);
    expect(r.body.item.bookedManually).toBe(true);
    expect(await matchRow(manual.matchId)).toMatchObject({
      exact_state: "matched_in_exact",
      exact_note: "booked_manually",
    });
    const flag = async (id: number): Promise<number> =>
      (
        await db
          .prepare("SELECT manually_booked AS m FROM matches WHERE id = ?1")
          .bind(id)
          .first<{ m: number }>()
      )?.m ?? -1;
    expect([await flag(manual.matchId), await flag(app.matchId)]).toEqual([1, 0]);
    expect((await auditRows("booking.booked_manually")).at(-1)?.actor_email).toBe(
      "admin@camelthorncapital.com",
    );
    const dm = await send<MatchDetailResponse>(
      "finance",
      "GET",
      `/api/matching/transactions/${manual.txId}`,
    );
    const da = await send<MatchDetailResponse>(
      "finance",
      "GET",
      `/api/matching/transactions/${app.txId}`,
    );
    expect([dm.body.match?.bookedManually, da.body.match?.bookedManually]).toEqual([true, false]);
    const list = await send<{ items: { matchId: number; bookedManually?: boolean }[] }>(
      "viewer",
      "GET",
      "/api/booking/outbox",
    );
    expect(list.body.items.find((i) => i.matchId === manual.matchId)?.bookedManually).toBe(true);
    expect(list.body.items.find((i) => i.matchId === app.matchId)?.bookedManually).toBe(false);
  });

  it("a retry keeps the last error code and records who resolved it", async () => {
    await setBooking(true, true);
    fake.modes.bank_entry = ["lost"];
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0]!;
    expect(row.last_error_code).toBe("network");
    const r = await send("admin", "POST", `/api/booking/outbox/${row.id}/resolve`, {
      resolution: "retry",
      note: "Looked in Exact",
    });
    expect(r.status).toBe(200);
    const after = await db
      .prepare(
        "SELECT last_error_code AS c, admin_resolved_by AS b, admin_resolved_at AS a FROM exact_write_outbox WHERE id = ?1",
      )
      .bind(row.id)
      .first<{ c: string; b: string; a: string }>();
    expect(after?.c).toBe("network");
    expect(after?.b).toBe("admin@camelthorncapital.com");
    expect(after?.a).toBeTruthy();
  });
});

describe("S10, N6: booking health in GET /api/matching/stats", () => {
  it("counts what needs a person, a booked match whose line later conflicts or reverts, deferrals", async () => {
    await setBooking(true, true);
    // booked, then its bank line gets a state conflict
    const booked = await seedBookable(w, fake, { amountMinor: 1_000 });
    await runBooking(fake);
    expect((await matchRow(booked.matchId)).exact_state).toBe("matched_in_exact");
    await db
      .prepare("UPDATE bank_transactions SET state_conflict = 1 WHERE id = ?1")
      .bind(booked.txId)
      .run();
    // booked, then reverted
    const rev = await seedBookable(w, fake, { amountMinor: 1_100 });
    await runBooking(fake, { now: NOW + 600_000 });
    await db
      .prepare("UPDATE bank_transactions SET state = 'reverted' WHERE id = ?1")
      .bind(rev.txId)
      .run();
    // unknown outcome
    fake.modes.bank_entry = ["lost"];
    await seedBookable(w, fake, { amountMinor: 1_200 });
    await runBooking(fake, { now: NOW + 1_200_000 });
    // manual (a part payment, stage none)
    await seedBookable(w, fake, { amountMinor: 500, openMinor: 900 });
    await runBooking(fake, { now: NOW + 1_800_000 });
    // deferred
    await db.prepare("UPDATE bank_account_exact_map SET payable_gl_account_code = NULL").run();
    await seedBookable(w, fake, { kind: "bill", amountMinor: 700 });
    await runBooking(fake, { now: NOW + 2_400_000 });
    const st = await send<MatchStatsResponse>("viewer", "GET", "/api/matching/stats");
    expect(st.body.booking).toEqual({
      manualRequired: 1,
      outcomeUnknown: 1,
      waitingForBankLine: 0,
      deferred: 1,
      bookedLineConflict: 1,
      bookedLineReverted: 1,
      alreadyMatchedInExact: 0,
      bookedManually: 0,
    });
  });
});

describe("B1: the opening balance on the account map", () => {
  const putMap = (role: Role | "staleAdmin", over: Record<string, unknown>) =>
    send(role, "PUT", "/api/matching/account-map", {
      bankAccountId: w.accountId,
      divisionId: w.divisionId,
      journalCode: "90",
      bankGlAccountCode: "1210",
      ...over,
    });
  const mapRow = async (): Promise<number | null> =>
    (
      await db
        .prepare(
          "SELECT opening_balance_minor AS o FROM bank_account_exact_map WHERE bank_account_id = ?1",
        )
        .bind(w.accountId)
        .first<{ o: number | null }>()
    )?.o ?? null;

  it("needs the fresh sign-in like the rest of the map; integer minor units; null clears; absent keeps", async () => {
    expect((await putMap("staleAdmin", { openingBalanceMinor: 500 })).status).toBe(401);
    expect((await putMap("finance", { openingBalanceMinor: 500 })).status).toBe(403);
    for (const bad of [1.5, "10", Number.MAX_SAFE_INTEGER * 2, {}]) {
      expect(err(await putMap("admin", { openingBalanceMinor: bad }))).toBe("bad_opening_balance");
    }
    const ok = await putMap("admin", { openingBalanceMinor: -12_345 });
    expect(ok.status).toBe(200);
    expect(await mapRow()).toBe(-12_345);
    expect(
      (
        ok.body as { accounts: { bankAccountId: number; openingBalanceMinor: number | null }[] }
      ).accounts.find((a) => a.bankAccountId === w.accountId)?.openingBalanceMinor,
    ).toBe(-12_345);
    await putMap("admin", {}); // absent keeps
    expect(await mapRow()).toBe(-12_345);
    await putMap("admin", { openingBalanceMinor: null });
    expect(await mapRow()).toBeNull();
    expect((await auditRows("matching.account_map_changed")).at(-1)?.after_json).toContain(
      "opening_balance_minor",
    );
  });
});
