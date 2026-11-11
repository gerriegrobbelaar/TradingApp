/**
 * The booking API (task M7c, ADR 0044): the fail-closed switch with every precondition, the
 * verification mark, the outbox list, the admin resolutions, undo after booking.
 */
import type {
  BookingOutboxResponse,
  BookingResolveResponse,
  BookingSettingsResponse,
  BookingStatus,
} from "@camelthorn/core";
import { BOOKING_PROTOCOL_VERSION } from "../src/booking/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { BOOKING_ENABLE_PHRASE, BOOKING_VERIFY_PHRASE } from "@camelthorn/core";
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
import { addSession, addUser, authed, db, resetDb } from "./helpers";
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
  for (const role of ["admin", "finance", "approver", "viewer"] as const) {
    tokens[role] = await addSession(await addUser(`${role}@camelthorncapital.com`, [role]));
  }
  tokens.staleAdmin = await addSession(await addUser("stale@camelthorncapital.com", ["admin"]), {
    lastAuthAgoMs: 20 * 60_000,
  });
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

const verify = (role: Role | "staleAdmin" = "admin", over: Record<string, unknown> = {}) =>
  send(role, "POST", "/api/booking/verify", {
    note: "Created one bank entry and one MatchSet on the test division and checked both in Exact.",
    confirm: VERIFY_PHRASE,
    ...over,
  });
const enable = (role: Role | "staleAdmin" = "admin", over: Record<string, unknown> = {}) =>
  send(role, "PUT", "/api/booking/settings", { enabled: true, confirm: ENABLE_PHRASE, ...over });

describe("typed phrases: exactly the shared constants (core confirm-phrases.ts)", () => {
  it("are the agreed values, case-sensitive and never trimmed", async () => {
    expect(BOOKING_ENABLE_PHRASE).toBe("ENABLE EXACT BOOKING");
    expect(BOOKING_VERIFY_PHRASE).toBe("I VERIFIED THE EXACT WRITE PATH ON A TEST DIVISION");
    expect(VERIFY_PHRASE).toBe(BOOKING_VERIFY_PHRASE);
    expect(ENABLE_PHRASE).toBe(BOOKING_ENABLE_PHRASE);
    for (const confirm of [
      ` ${BOOKING_VERIFY_PHRASE}`,
      `${BOOKING_VERIFY_PHRASE} `,
      BOOKING_VERIFY_PHRASE.toLowerCase(),
      BOOKING_ENABLE_PHRASE,
      ["x"],
    ]) {
      expect(err(await verify("admin", { confirm }))).toBe("confirmation_required");
    }
    for (const confirm of [`${BOOKING_ENABLE_PHRASE} `, BOOKING_ENABLE_PHRASE.toLowerCase(), 1]) {
      expect(err(await enable("admin", { confirm }))).toBe("confirmation_required");
    }
  });
});

describe("GET /api/booking/settings", () => {
  it("is readable by every signed-in role and says why booking cannot run", async () => {
    for (const role of ["admin", "finance", "approver", "viewer"] as const) {
      const r = await send<BookingSettingsResponse>(role, "GET", "/api/booking/settings");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        enabled: false,
        verified: null,
        protocolVersion: BOOKING_PROTOCOL_VERSION,
        protocolChanged: false,
        createsBankEntries: true,
        blockers: ["not_verified", "writes_disabled"],
      });
    }
    const anon = await authed("/api/booking/settings", "nope");
    expect(anon.status).toBe(401);
  });

  it("lists every blocker: undecided bank entries, no Exact connection", async () => {
    await db
      .prepare("UPDATE connections SET bank_entries_decided_at = NULL WHERE kind = 'revolut'")
      .run();
    await db.prepare("UPDATE connections SET status = 'needs_reauth' WHERE kind = 'exact'").run();
    const r = await settings();
    expect(r.body.createsBankEntries).toBeNull();
    expect(r.body.blockers).toEqual([
      "not_verified",
      "bank_entries_undecided",
      "no_exact_connection",
      "writes_disabled",
    ]);
  });
});

describe("POST /api/booking/verify", () => {
  it("is admin only, needs a fresh sign-in, the phrase and a real note", async () => {
    for (const role of ["finance", "approver", "viewer"] as const) {
      expect((await verify(role)).status).toBe(403);
    }
    const stale = await verify("staleAdmin");
    expect([stale.status, err(stale)]).toEqual([401, "step_up_required"]);
    expect(err(await verify("admin", { confirm: "yes" }))).toBe("confirmation_required");
    expect(err(await verify("admin", { note: "ok" }))).toBe("bad_note");
    expect(err(await verify("admin", { note: undefined }))).toBe("bad_note");
    expect(err(await verify("admin", { extra: 1 }))).toBe("bad_request");
    expect((await settings()).body.verified).toBeNull();
  });

  it("stores who, when, the note and the CURRENT protocol version, audited", async () => {
    const r = await verify();
    expect(r.status).toBe(200);
    const s = (await settings()).body;
    expect(s.verified).toMatchObject({
      by: "admin@camelthorncapital.com",
      protocolVersion: BOOKING_PROTOCOL_VERSION,
    });
    expect(s.verified?.note).toContain("test division");
    expect(s.blockers).toEqual(["writes_disabled"]);
    const rows = await auditRows("booking.verified");
    expect(rows.at(-1)?.actor_email).toBe("admin@camelthorncapital.com");
    expect(rows.at(-1)?.after_json).toContain(BOOKING_PROTOCOL_VERSION);
  });

  it("an IBAN typed into the note is masked in the settings and the audit log", async () => {
    const r = await verify("admin", {
      note: "Checked on the test division with account NL91 ABNA 0417 1643 00 in Exact",
    });
    expect(r.status).toBe(200);
    expect((await settings()).body.verified?.note).toContain("NL91****4300");
    const raw = await db
      .prepare("SELECT value_json FROM settings WHERE key = 'exact.booking_verified'")
      .first<{ value_json: string }>();
    expect(raw?.value_json).not.toMatch(/0417 1643|ABNA/);
    expect((await auditRows("booking.verified")).at(-1)?.after_json).not.toMatch(/0417 1643|ABNA/);
  });

  it("a new verification leaves booking OFF: switching it on is always its own, typed decision", async () => {
    await setBooking(true, true);
    expect((await settings()).body.enabled).toBe(true);
    await verify();
    expect((await settings()).body.enabled).toBe(false);
  });
});

describe("PUT /api/booking/settings: enabling needs everything", () => {
  it("only admins; a fresh sign-in; the typed phrase", async () => {
    await setBooking(false, true);
    for (const role of ["finance", "approver", "viewer"] as const) {
      expect((await enable(role)).status).toBe(403);
    }
    const stale = await enable("staleAdmin");
    expect([stale.status, err(stale)]).toEqual([401, "step_up_required"]);
    expect(err(await enable("admin", { confirm: "enable exact booking" }))).toBe(
      "confirmation_required",
    );
    expect(err(await enable("admin", { confirm: undefined }))).toBe("confirmation_required");
    expect(err(await send("admin", "PUT", "/api/booking/settings", { enabled: "yes" }))).toBe(
      "bad_request",
    );
    expect(
      err(await send("admin", "PUT", "/api/booking/settings", { enabled: true, extra: 1 })),
    ).toBe("bad_request");
    expect((await settings()).body.enabled).toBe(false);
  });

  it.each([
    ["never verified", async () => undefined, ["not_verified"]],
    [
      "verified an older protocol",
      async () => setBooking(false, "d".repeat(64)),
      ["protocol_changed"],
    ],
    [
      "the Revolut connection has not decided about bank entries",
      async () => {
        await setBooking(false, true);
        await db
          .prepare("UPDATE connections SET bank_entries_decided_at = NULL WHERE kind = 'revolut'")
          .run();
      },
      ["bank_entries_undecided"],
    ],
    [
      "no active Exact connection",
      async () => {
        await setBooking(false, true);
        await db.prepare("UPDATE connections SET status = 'disabled' WHERE kind = 'exact'").run();
      },
      ["no_exact_connection"],
    ],
    [
      "several at once",
      async () => {
        await db
          .prepare("UPDATE connections SET bank_entries_decided_at = NULL WHERE kind = 'revolut'")
          .run();
      },
      ["not_verified", "bank_entries_undecided"],
    ],
  ])("refused (409 blocked) when %s", async (_name, arrange, blockers) => {
    await arrange();
    const r = await enable();
    expect([r.status, err(r)]).toEqual([409, "blocked"]);
    expect((r.body as { blockers: string[] }).blockers).toEqual(blockers);
    expect((await settings()).body.enabled).toBe(false);
    expect(await auditRows("booking.enabled")).toHaveLength(0);
  });

  it("works when every precondition holds, and is audited with the admin's email", async () => {
    await verify();
    const r = await enable("admin", { note: "Go live for the March close" });
    expect(r.status).toBe(200);
    expect((r.body as unknown as BookingSettingsResponse).enabled).toBe(true);
    expect((r.body as unknown as BookingSettingsResponse).blockers).toEqual([]);
    const a = (await auditRows("booking.enabled")).at(-1);
    expect(a?.actor_email).toBe("admin@camelthorncapital.com");
    expect(a?.after_json).toContain("March close");
  });

  it("the preconditions are part of the write itself: a verification replaced meanwhile cannot slip through", async () => {
    await verify();
    // The read says fine; then the verification mark becomes stale before the write.
    const handler = enable();
    await setBooking(false, "c".repeat(64));
    const r = await handler;
    // Either order is safe: the write never enables with a stale mark.
    const s = (await settings()).body;
    if (r.status === 200) expect(s.protocolChanged).toBe(false);
    else expect(s.enabled).toBe(false);
  });
});

describe("PUT /api/booking/settings: disabling", () => {
  it("is the safe direction: an admin with a STALE sign-in and no phrase may switch it off, audited", async () => {
    await setBooking(true, true);
    const r = await send<BookingSettingsResponse>("staleAdmin", "PUT", "/api/booking/settings", {
      enabled: false,
      confirm: "",
    });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
    const a = (await auditRows("booking.disabled")).at(-1);
    expect(a?.actor_email).toBe("stale@camelthorncapital.com");
    expect(a?.before_json).toContain('"enabled":true');
    for (const role of ["finance", "approver", "viewer"] as const) {
      expect(
        (await send(role, "PUT", "/api/booking/settings", { enabled: false, confirm: "" })).status,
      ).toBe(403);
    }
  });
});

describe("GET /api/booking/outbox", () => {
  async function seedStates(): Promise<{ booked: number; unknown: number; manual: number }> {
    await setBooking(true, true);
    const a = await seedBookable(w, fake, { invoiceNumber: "INV-1" });
    await runBooking(fake);
    fake.modes.bank_entry = ["lost"];
    const b = await seedBookable(w, fake, { invoiceNumber: "INV-2", amountMinor: 2_000 });
    await runBooking(fake, { now: NOW + 60_000 });
    const c = await seedBookable(w, fake, {
      invoiceNumber: "INV-3",
      amountMinor: 5_000,
      openMinor: 9_000,
    });
    await runBooking(fake, { now: NOW + 120_000 });
    return { booked: a.matchId, unknown: b.matchId, manual: c.matchId };
  }

  it("lists the rows in the fixed shape with counts per status and labels", async () => {
    const ids = await seedStates();
    const r = await send<BookingOutboxResponse>("viewer", "GET", "/api/booking/outbox");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["countsByStatus", "items", "nextCursor", "total"]);
    expect(Object.keys(r.body.countsByStatus).sort()).toEqual(
      [
        "pending",
        "sending",
        "sent_unverified",
        "verified",
        "failed",
        "outcome_unknown",
        "manual_required",
        "waiting_for_bank_line",
        "resolved_manually",
        "given_up",
      ].sort(),
    );
    expect(r.body.countsByStatus).toMatchObject({
      verified: 2,
      outcome_unknown: 1,
      manual_required: 1,
    });
    expect(r.body.total).toBe(4);
    const item = r.body.items.find((i) => i.matchId === ids.manual);
    expect(item).toMatchObject({
      kind: "bank_entry",
      status: "manual_required",
      lastErrorCode: "part_payment_not_supported_v1",
      attempts: 0,
      exactRef: null,
      amountMinor: 5_000,
      currency: "EUR",
      itemLabels: ["INV-3"],
    });
    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        "amountMinor",
        "attempts",
        "counterpartyName",
        "createdAt",
        "currency",
        "exactRef",
        "id",
        "itemLabels",
        "kind",
        "lastErrorCode",
        "matchId",
        "status",
        "transactionId",
        "updatedAt",
      ].sort(),
    );
    expect(r.body.items.map((i) => i.id)).toEqual(
      [...r.body.items.map((i) => i.id)].sort((a, b) => b - a),
    );
    // No IBAN anywhere in the answer.
    expect(JSON.stringify(r.body)).not.toMatch(/[A-Z]{2}\d{2}[A-Z0-9]{11,30}/);
  });

  it("filters by status, pages with an opaque cursor and validates its input", async () => {
    await seedStates();
    const verified = await send<BookingOutboxResponse>(
      "approver",
      "GET",
      "/api/booking/outbox?status=verified",
    );
    expect(verified.body.items.every((i) => i.status === "verified")).toBe(true);
    expect(verified.body.total).toBe(2);
    const p1 = await send<BookingOutboxResponse>("viewer", "GET", "/api/booking/outbox?limit=2");
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await send<BookingOutboxResponse>(
      "viewer",
      "GET",
      `/api/booking/outbox?limit=2&cursor=${p1.body.nextCursor}`,
    );
    expect(p2.body.items).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();
    const seen = [...p1.body.items, ...p2.body.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(4);
    for (const bad of ["status=nope", "limit=0", "limit=x", "cursor=abc", "cursor=-1"]) {
      expect((await send("viewer", "GET", `/api/booking/outbox?${bad}`)).status, bad).toBe(400);
    }
  });
});

describe("POST /api/booking/outbox/:id/resolve", () => {
  const resolve = (
    role: Role | "staleAdmin",
    id: number,
    resolution: string,
    note = "Checked in Exact",
  ) =>
    send<BookingResolveResponse>(role, "POST", `/api/booking/outbox/${id}/resolve`, {
      resolution,
      note,
    });

  async function unknownBankEntry(): Promise<{ matchId: number; rowId: number }> {
    await setBooking(true, true);
    fake.modes.bank_entry = ["lost"];
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0];
    expect(row?.status).toBe("outcome_unknown");
    return { matchId: s.matchId, rowId: row?.id ?? 0 };
  }

  it("only admins with a fresh sign-in; validates resolution and note; unknown id is 404", async () => {
    const { rowId } = await unknownBankEntry();
    for (const role of ["finance", "approver", "viewer"] as const) {
      expect((await resolve(role, rowId, "retry")).status).toBe(403);
    }
    const stale = await resolve("staleAdmin", rowId, "retry");
    expect([stale.status, err(stale)]).toEqual([401, "step_up_required"]);
    expect(err(await resolve("admin", rowId, "explode"))).toBe("bad_resolution");
    expect(err(await resolve("admin", rowId, "retry", "x"))).toBe("bad_note");
    expect((await resolve("admin", 987654, "retry")).status).toBe(404);
    expect((await outbox())[0]?.status).toBe("outcome_unknown");
  });

  it("retry: back to pending with needs_probe; the next run probes, finds the line and never posts twice", async () => {
    const { matchId, rowId } = await unknownBankEntry();
    const r = await resolve("admin", rowId, "retry", "Looked in Exact: nothing there yet");
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ id: rowId, status: "pending" });
    expect((await outbox(matchId))[0]).toMatchObject({ status: "pending", needs_probe: 1 });
    expect((await matchRow(matchId)).exact_state).toBe("booking");
    expect((await auditRows("booking.retry")).at(-1)?.actor_email).toBe(
      "admin@camelthorncapital.com",
    );
    await runBooking(fake, { now: NOW + 600_000 });
    expect(fake.posts("bank_entry")).toHaveLength(1); // the probe found the lost entry
    expect((await matchRow(matchId)).exact_state).toBe("matched_in_exact");
    expect(await checkMatchingInvariants(db)).toEqual([]);
    // A finished row cannot be resolved again.
    expect((await resolve("admin", rowId, "retry")).status).toBe(409);
  });

  it("retry is refused for rows that cannot be retried (manual plan failure, finished rows)", async () => {
    await setBooking(true, true);
    const s = await seedBookable(w, fake, { amountMinor: 5_000, openMinor: 9_000 });
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0];
    expect(row?.status).toBe("manual_required");
    const r = await resolve("admin", row?.id ?? 0, "retry");
    expect([r.status, err(r)]).toEqual([409, "not_retryable"]);
  });

  it("booked_manually: the row is resolved_manually, the match matched_in_exact with booked_at, audited", async () => {
    await setBooking(true, true);
    const s = await seedBookable(w, fake, { amountMinor: 5_000, openMinor: 9_000 });
    await runBooking(fake);
    const row = (await outbox(s.matchId))[0];
    const r = await resolve("admin", row?.id ?? 0, "booked_manually", "Matched by hand in Exact");
    expect(r.status).toBe(200);
    expect(r.body.item.status).toBe("resolved_manually");
    const m = await matchRow(s.matchId);
    expect(m.exact_state).toBe("matched_in_exact");
    expect(m.booked_at).not.toBeNull();
    const a = (await auditRows("booking.booked_manually")).at(-1);
    expect(a?.actor_email).toBe("admin@camelthorncapital.com");
    expect(a?.after_json).toContain("Matched by hand in Exact");
    expect(await checkMatchingInvariants(db)).toEqual([]);
  });

  it("give_up: the row is given_up and the match stays manual_required", async () => {
    const { matchId, rowId } = await unknownBankEntry();
    const r = await resolve("admin", rowId, "give_up", "Booked outside this app");
    expect(r.status).toBe(200);
    expect(r.body.item.status).toBe("given_up");
    expect((await matchRow(matchId)).exact_state).toBe("manual_required");
    expect((await resolve("admin", rowId, "give_up")).status).toBe(409);
    await runBooking(fake, { now: NOW + 600_000 });
    expect(fake.posts("bank_entry")).toHaveLength(1);
  });

  it("a row whose POST is in flight (live lease) cannot be resolved", async () => {
    const { rowId } = await unknownBankEntry();
    await db
      .prepare(
        "UPDATE exact_write_outbox SET status = 'sending', lease_expires_at = '2099-01-01T00:00:00.000Z', claimed_at = 'x' WHERE id = ?1",
      )
      .bind(rowId)
      .run();
    const r = await resolve("admin", rowId, "give_up");
    expect([r.status, err(r)]).toEqual([409, "in_flight"]);
  });
});

describe("resolve never races a write on the wire", () => {
  it("a decision on one row is refused while another row of the same match is sending", async () => {
    await setBooking(true, true);
    fake.modes.bank_entry = ["lost"];
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    const bank = (await outbox(s.matchId))[0]!;
    // (the insert guard wants a claimed match: booking, then back to outcome_unknown)
    await db
      .prepare("UPDATE matches SET exact_state = 'booking' WHERE id = ?1")
      .bind(s.matchId)
      .run();
    await db
      .prepare(
        `INSERT INTO exact_write_outbox (match_id, division_id, kind, idempotency_key, payload_json,
           payload_hash, status, claimed_at, lease_expires_at, created_at, updated_at)
         VALUES (?1, ?2, 'matchset', ?3, '{}', ?3, 'sending', 'x', '2099-01-01T00:00:00.000Z', 'x', 'x')`,
      )
      .bind(s.matchId, w.divisionId, "b".repeat(64))
      .run();
    await db
      .prepare("UPDATE matches SET exact_state = 'outcome_unknown' WHERE id = ?1")
      .bind(s.matchId)
      .run();
    for (const resolution of ["retry", "give_up", "booked_manually"]) {
      const r = await send("admin", "POST", `/api/booking/outbox/${bank.id}/resolve`, {
        resolution,
        note: "Checked in Exact",
      });
      expect([r.status, err(r)]).toEqual([409, "in_flight"]);
    }
    expect((await outbox(s.matchId)).map((r) => r.status)).toEqual(["outcome_unknown", "sending"]);
  });
});

describe("account map control accounts: who may change them", () => {
  it("needs an admin with a fresh sign-in", async () => {
    const body = {
      bankAccountId: w.accountId,
      divisionId: w.divisionId,
      journalCode: "90",
      bankGlAccountCode: "1210",
      receivableGlAccountCode: "9999",
    };
    for (const role of ["finance", "approver", "viewer"] as const) {
      expect((await send(role, "PUT", "/api/matching/account-map", body)).status).toBe(403);
    }
    const stale = await send("staleAdmin", "PUT", "/api/matching/account-map", body);
    expect([stale.status, err(stale)]).toEqual([401, "step_up_required"]);
    const row = await db
      .prepare(
        "SELECT receivable_gl_account_code AS c FROM bank_account_exact_map WHERE bank_account_id = ?1",
      )
      .bind(w.accountId)
      .first<{ c: string | null }>();
    expect(row?.c).toBe("1300");
    for (const bad of ["", " 1300", "13 00", "1300;", "x".repeat(21), 1300]) {
      const r = await send("admin", "PUT", "/api/matching/account-map", {
        ...body,
        receivableGlAccountCode: bad,
      });
      expect(r.status).toBe(400);
    }
  });
});

describe("undo of a booked match", () => {
  it("stays refused: reversal_required_in_exact once booked, booking_in_progress before", async () => {
    await setBooking(true, true);
    const s = await seedBookable(w, fake);
    await runBooking(fake);
    const booked = await send("finance", "POST", `/api/matching/matches/${s.matchId}/undo`, {
      reason: "oops",
    });
    expect([booked.status, err(booked), (booked.body as { detail?: string }).detail]).toEqual([
      409,
      "already_booked_in_exact",
      "reversal_required_in_exact",
    ]);
    fake.modes.bank_entry = ["lost"];
    const t = await seedBookable(w, fake, { amountMinor: 700 });
    await runBooking(fake, { now: NOW + 60_000 });
    const inflight = await send("finance", "POST", `/api/matching/matches/${t.matchId}/undo`, {
      reason: "oops",
    });
    expect([inflight.status, (inflight.body as { detail?: string }).detail]).toEqual([
      409,
      "booking_in_progress",
    ]);
    const states: BookingStatus[] = (await outbox()).map((r) => r.status as BookingStatus);
    expect(states).toContain("outcome_unknown");
  });
});

describe("account map control accounts", () => {
  it("are stored, returned and kept when a later PUT leaves them out", async () => {
    const acc = w.accountId;
    const put = (body: Record<string, unknown>) =>
      send<{
        accounts: {
          receivableGlAccountCode?: string | null;
          payableGlAccountCode?: string | null;
        }[];
      }>("admin", "PUT", "/api/matching/account-map", {
        bankAccountId: acc,
        divisionId: w.divisionId,
        journalCode: "90",
        bankGlAccountCode: "1210",
        ...body,
      });
    const a = await put({ receivableGlAccountCode: "1350", payableGlAccountCode: "1650" });
    expect(a.status).toBe(200);
    expect(a.body.accounts[0]).toMatchObject({
      receivableGlAccountCode: "1350",
      payableGlAccountCode: "1650",
    });
    const b = await put({});
    expect(b.body.accounts[0]).toMatchObject({
      receivableGlAccountCode: "1350",
      payableGlAccountCode: "1650",
    });
    const c = await put({ payableGlAccountCode: null });
    expect(c.body.accounts[0]).toMatchObject({
      receivableGlAccountCode: "1350",
      payableGlAccountCode: null,
    });
    expect((await put({ receivableGlAccountCode: "bad code!" })).status).toBe(400);
  });
});
