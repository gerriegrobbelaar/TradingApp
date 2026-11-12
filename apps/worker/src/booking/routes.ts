/**
 * Booking API (task M7c, ADR 0044).
 *
 *  GET  /api/booking/settings               any role   the fail-closed switch, the verification, blockers
 *  PUT  /api/booking/settings               admin      {enabled, confirm, note?}. Enabling: fresh sign-in,
 *                                                      BOOKING_ENABLE_PHRASE (core) and every
 *                                                      precondition. Disabling: no step-up, audited.
 *  POST /api/booking/verify                 admin, step-up   {note, confirm}: the write path was verified
 *                                                      on a TEST division (stores the protocol version).
 *                                                      Also switches booking OFF: enabling is always explicit.
 *  GET  /api/booking/outbox                 any role   ?status=&limit=&cursor=
 *  POST /api/booking/preview                admin, step-up   {matchIds: 1..3}: a dry run, reads only
 *  POST /api/booking/outbox/:id/resolve     admin, step-up   {resolution, note}
 *
 * Every write is audited in the same batch (ADR 0013). Nothing here calls Exact.
 */
import {
  type BookingOutboxItemDto,
  type BookingOutboxResponse,
  type BookingPreviewResponse,
  type BookingResolveResponse,
  type BookingSettingsResponse,
  type BookingStatus,
} from "@camelthorn/core";
import { BOOKING_VERIFY_CHECKS, maskIbans, phraseMatches } from "@camelthorn/core";
import { BOOKING_PROTOCOL_VERSION } from "./protocol";
import { isStepUpFresh } from "../auth/session";
import { auditStatement } from "../db/audit";
import { safeText } from "../matching/dto";
import { ANY_ROLE, BadRequest, guarded } from "../read/routes";
import { json, type Ctx, type Router } from "../router";
import {
  GUARD,
  loadRow,
  OUTBOX_STATUSES,
  TERMINAL_STATUSES,
  transition,
  type OutboxRow,
  type OutboxStatus,
} from "./outbox";
import { parseDoc } from "./plan";
import { PREVIEW_MAX_MATCHES, runPreview } from "./preview";
import { retryUnsentClaim } from "./unsent";
import {
  blockersOf,
  BOOKING_FROM_MAX_FUTURE_MS,
  ENABLE_PHRASE,
  loadBookingState,
  MAX_MAX_PER_RUN,
  sameChecks,
  SETTING_DIVISIONS,
  SETTING_ENABLED,
  SETTING_FROM,
  SETTING_MAX_PER_RUN,
  SETTING_VERIFIED,
  VERIFY_PHRASE,
} from "./settings";

const ADMIN = { roles: ["admin"] } as const;
const ADMIN_STEP_UP = { roles: ["admin"], stepUp: true } as const;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 404 | 409 | 422 = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

type Handler = (ctx: Ctx) => Promise<Response>;

const safely =
  (fn: Handler): Handler =>
  async (ctx) => {
    try {
      return await guarded(fn)(ctx);
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.code, ...err.extra }, err.status);
      throw err;
    }
  };

const actor = (ctx: Ctx): string => {
  if (!ctx.session) throw new BadRequest("unauthenticated");
  return ctx.session.email;
};

async function readBody(ctx: Ctx, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const len = Number(ctx.request.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > 10_000) throw new ApiError("bad_request");
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    throw new ApiError("bad_request");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("bad_request");
  }
  const rec = body as Record<string, unknown>;
  if (Object.keys(rec).some((k) => !allowed.includes(k))) throw new ApiError("bad_request");
  return rec;
}

/**
 * A written note: trimmed, no control characters, `min`..`max` characters. It is stored in settings
 * and the audit log, so an IBAN typed into it is masked (CLAUDE.md 5).
 */
function note(v: unknown, min: number, max: number, code: string): string {
  if (typeof v !== "string") throw new ApiError(code);
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
  if (t.length < min || t.length > max) throw new ApiError(code);
  return maskIbans(t);
}

// ---- settings -------------------------------------------------------------------------------------

/** Live, not-booked matches older than the watermark (all of them while booking was never enabled). */
async function backlogCountOf(db: D1Database, bookingFrom: string | null): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM matches
       WHERE undone_at IS NULL AND exact_state = 'not_booked' AND (?1 IS NULL OR created_at < ?1)`,
    )
    .bind(bookingFrom)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function settingsResponse(
  db: D1Database,
  proposedFrom: string | null = null,
): Promise<BookingSettingsResponse> {
  const s = await loadBookingState(db);
  const proposed =
    proposedFrom === null
      ? {}
      : {
          proposed: {
            bookingFrom: proposedFrom,
            backlogCount: await backlogCountOf(db, proposedFrom),
            reopenedCount: await reopenedCountOf(db, s.bookingFrom, proposedFrom),
          },
        };
  return {
    ...proposed,
    enabled: s.enabled,
    verified: s.verified,
    protocolVersion: s.protocolVersion,
    protocolChanged: s.protocolChanged,
    createsBankEntries: s.createsBankEntries,
    blockers: blockersOf(s),
    bookingFrom: s.bookingFrom,
    backlogCount: await backlogCountOf(db, s.bookingFrom),
    // Enabling sets the watermark to now: every live not-booked match stays behind (U3).
    backlogIfEnabledNow: await backlogCountOf(db, null),
    divisions: s.divisions,
    maxPerRun: s.maxPerRun,
  };
}

/**
 * `?bookingFrom=<ISO>` adds `proposed`: the backlog and the number of matches an admin would make
 * bookable by moving the watermark there (shown BEFORE the change is made).
 */
async function getSettingsHandler(ctx: Ctx): Promise<Response> {
  const raw = ctx.url.searchParams.get("bookingFrom");
  const proposed = raw === null ? null : parseBookingFrom(raw, ctx.nowMs);
  return json(await settingsResponse(ctx.env.DB, proposed));
}

const UPSERT_SETTING = `INSERT INTO settings (key, value_json, updated_by) VALUES (?1, ?2, ?3)
  ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

const MAX_DIVISIONS = 20;

interface ParsedLimits {
  stmts: D1PreparedStatement[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Anything that lets MORE be written to Exact (needs a fresh sign-in). */
  widening: boolean;
  /** The allow-list after the change (null = unchanged). */
  divisions: number[] | null;
  /** Matches that become bookable by an earlier watermark (audited). */
  reopenedCount: number;
}

/** Live, not-booked matches eligible under `proposed` but not under `current` (null = never on). */
async function reopenedCountOf(
  db: D1Database,
  current: string | null,
  proposed: string,
): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM matches
       WHERE undone_at IS NULL AND exact_state = 'not_booked'
         AND created_at >= ?1 AND (?2 IS NULL OR created_at < ?2)`,
    )
    .bind(proposed, current)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** A watermark from the body: ISO, after 2000, at most a day ahead of now. */
function parseBookingFrom(raw: unknown, nowMs: number): string {
  if (typeof raw !== "string" || raw.length > 40) throw new ApiError("bad_booking_from");
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms < Date.parse("2000-01-01T00:00:00Z")) {
    throw new ApiError("bad_booking_from");
  }
  if (ms > nowMs + BOOKING_FROM_MAX_FUTURE_MS) throw new ApiError("booking_from_in_future");
  return new Date(ms).toISOString();
}

/** The limits of booking (U1, review B2b/c): the watermark, the allow-list and the per-run cap. */
async function parseLimits(
  ctx: Ctx,
  b: Record<string, unknown>,
  who: string,
  before: Awaited<ReturnType<typeof loadBookingState>>,
  withWatermark: boolean,
): Promise<ParsedLimits> {
  const db = ctx.env.DB;
  const out: ParsedLimits = {
    stmts: [],
    before: {},
    after: {},
    widening: false,
    divisions: null,
    reopenedCount: 0,
  };
  if (withWatermark && b["bookingFrom"] !== undefined) {
    const next = parseBookingFrom(b["bookingFrom"], ctx.nowMs);
    // Moving the watermark LATER only narrows what is booked; anything else widens it.
    if (before.bookingFrom === null || next < before.bookingFrom) out.widening = true;
    out.reopenedCount = await reopenedCountOf(db, before.bookingFrom, next);
    out.before["bookingFrom"] = before.bookingFrom;
    out.after["bookingFrom"] = next;
    out.after["reopenedCount"] = out.reopenedCount;
    out.stmts.push(db.prepare(UPSERT_SETTING).bind(SETTING_FROM, JSON.stringify(next), who));
  }
  if (b["divisions"] !== undefined) {
    const raw = b["divisions"];
    if (
      !Array.isArray(raw) ||
      raw.length > MAX_DIVISIONS ||
      !raw.every((x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 1)
    ) {
      throw new ApiError("bad_divisions");
    }
    const ids = [...new Set(raw as number[])].sort((a, c) => a - c);
    if (ids.length > 0) {
      const marks = ids.map((_, i) => `?${i + 1}`).join(", ");
      const known = (
        await db
          .prepare(
            `SELECT d.id FROM divisions d JOIN connections c ON c.id = d.connection_id
             WHERE c.kind = 'exact' AND d.id IN (${marks})`,
          )
          .bind(...ids)
          .all<{ id: number }>()
      ).results;
      if (known.length !== ids.length) throw new ApiError("unknown_division", 422);
    }
    if (ids.some((id) => !before.divisions.includes(id))) out.widening = true;
    out.divisions = ids;
    out.before["divisions"] = before.divisions;
    out.after["divisions"] = ids;
    out.stmts.push(db.prepare(UPSERT_SETTING).bind(SETTING_DIVISIONS, JSON.stringify(ids), who));
  }
  if (b["maxPerRun"] !== undefined) {
    const raw = b["maxPerRun"];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_MAX_PER_RUN) {
      throw new ApiError("bad_max_per_run");
    }
    if (raw > before.maxPerRun) out.widening = true;
    out.before["maxPerRun"] = before.maxPerRun;
    out.after["maxPerRun"] = raw;
    out.stmts.push(db.prepare(UPSERT_SETTING).bind(SETTING_MAX_PER_RUN, JSON.stringify(raw), who));
  }
  return out;
}

const limitsAudit = (
  db: D1Database,
  who: string,
  l: ParsedLimits,
  why: string | null,
): D1PreparedStatement =>
  auditStatement(db, {
    actorEmail: who,
    action: "booking.limits_changed",
    entity: "settings",
    entityId: "exact.booking_limits",
    before: l.before,
    after: { ...l.after, ...(why !== null ? { note: why } : {}) },
  });

async function putLimits(
  ctx: Ctx,
  b: Record<string, unknown>,
  who: string,
  why: string | null,
): Promise<Response> {
  const db = ctx.env.DB;
  const before = await loadBookingState(db);
  const l = await parseLimits(ctx, b, who, before, true);
  if (l.stmts.length === 0) throw new ApiError("bad_request");
  // Widening what may be written to Exact needs a fresh sign-in; narrowing is the safe direction.
  if (l.widening && (!ctx.session || !isStepUpFresh(ctx.session, ctx.nowMs))) {
    return json({ error: "step_up_required" }, 401);
  }
  await db.batch([...l.stmts, limitsAudit(db, who, l, why)]);
  return json(await settingsResponse(db));
}

async function putSettingsHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const who = actor(ctx);
  const b = await readBody(ctx, [
    "enabled",
    "confirm",
    "note",
    "bookingFrom",
    "divisions",
    "maxPerRun",
  ]);
  const why = b["note"] === undefined ? null : note(b["note"], 1, 200, "bad_note");
  const hasLimits =
    b["bookingFrom"] !== undefined || b["divisions"] !== undefined || b["maxPerRun"] !== undefined;
  if (b["enabled"] === undefined) {
    // Limits only. A phrase here would mean the caller expects a switch: refuse the mixed shape.
    if (!hasLimits || b["confirm"] !== undefined) throw new ApiError("bad_request");
    return putLimits(ctx, b, who, why);
  }
  if (typeof b["enabled"] !== "boolean") throw new ApiError("bad_request");
  // Switching OFF takes nothing else: the safe direction stays one simple shape.
  if (b["enabled"] === false && hasLimits) throw new ApiError("bad_request");

  if (b["enabled"] === false) {
    // The safe direction: admin only (route), no step-up, no phrase. Audited when it changes.
    const was = (await loadBookingState(db)).enabled;
    await db.batch([
      db.prepare(UPSERT_SETTING).bind(SETTING_ENABLED, "false", who),
      auditStatement(db, {
        actorEmail: who,
        action: "booking.disabled",
        entity: "settings",
        entityId: SETTING_ENABLED,
        before: { enabled: was },
        after: { enabled: false, ...(why !== null ? { note: why } : {}) },
      }),
    ]);
    return json(await settingsResponse(db));
  }

  // Enabling: fresh sign-in, the typed phrase and every precondition.
  if (!ctx.session || !isStepUpFresh(ctx.session, ctx.nowMs)) {
    return json({ error: "step_up_required" }, 401);
  }
  if (typeof b["confirm"] !== "string" || !phraseMatches(b["confirm"], ENABLE_PHRASE))
    throw new ApiError("confirmation_required");
  const before = await loadBookingState(db);
  // The enable dialog (U3) sends the allow-list and the per-run cap with the switch: applied in the
  // same batch, before the switch (whose own conditions then see them), with their own audit row.
  // The watermark is NOW on every enable (review B2b): a `bookingFrom` sent along may only move it
  // LATER (at most a day ahead), never earlier; an earlier one is the limits call with its own rules.
  const limits = await parseLimits(ctx, b, who, before, false);
  const nowFrom = new Date(ctx.nowMs).toISOString();
  const asked =
    b["bookingFrom"] === undefined ? null : parseBookingFrom(b["bookingFrom"], ctx.nowMs);
  const from = asked !== null && asked > nowFrom ? asked : nowFrom;
  const proposed = limits.divisions === null ? before : { ...before, divisions: limits.divisions };
  const blockers = blockersOf(proposed).filter((x) => x !== "writes_disabled");
  if (blockers.length > 0) throw new ApiError("blocked", 409, { blockers });
  const backlog = await backlogCountOf(db, from);
  // The conditions are repeated in the write itself, so a change between the read and the write
  // (a connection disabled, a verification replaced, a mode flipped, the allow-list emptied) cannot
  // slip through.
  const pre = limits.stmts.length > 0 ? [...limits.stmts, limitsAudit(db, who, limits, why)] : [];
  const out = await db.batch([
    ...pre,
    db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_by)
         SELECT ?1, 'true', ?2
         WHERE EXISTS (SELECT 1 FROM settings WHERE key = ?3 AND json_extract(value_json, '$.protocolVersion') = ?4
                         AND json_extract(value_json, '$.createsBankEntries') =
                             (SELECT creates_bank_entries FROM connections WHERE kind = 'revolut' ORDER BY id LIMIT 1))
           AND EXISTS (SELECT 1 FROM settings WHERE key = ?5 AND json_valid(value_json)
                         AND json_array_length(value_json) > 0)
           AND EXISTS (SELECT 1 FROM connections WHERE kind = 'exact' AND status = 'active')
           AND EXISTS (SELECT 1 FROM connections WHERE kind = 'revolut' AND bank_entries_decided_at IS NOT NULL)
         ON CONFLICT (key) DO UPDATE SET value_json = 'true', updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .bind(SETTING_ENABLED, who, SETTING_VERIFIED, BOOKING_PROTOCOL_VERSION, SETTING_DIVISIONS),
    auditStatement(
      db,
      {
        actorEmail: who,
        action: "booking.enabled",
        entity: "settings",
        entityId: SETTING_ENABLED,
        before: { enabled: before.enabled, bookingFrom: before.bookingFrom },
        after: {
          enabled: true,
          protocolVersion: BOOKING_PROTOCOL_VERSION,
          createsBankEntries: before.createsBankEntries,
          bookingFrom: from,
          divisions: limits.divisions ?? before.divisions,
          maxPerRun: (limits.after["maxPerRun"] as number | undefined) ?? before.maxPerRun,
          backlogCount: backlog,
          ...(why !== null ? { note: why } : {}),
        },
      },
      { sql: GUARD, binds: [] },
    ),
    // Only when the switch really went on: the watermark moves to now.
    db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_by) SELECT ?1, ?2, ?3 WHERE ${GUARD}
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .bind(SETTING_FROM, JSON.stringify(from), who),
  ]);
  if ((out[pre.length]?.meta.changes ?? 0) < 1) {
    const now = await loadBookingState(db);
    throw new ApiError("blocked", 409, {
      blockers: blockersOf(now).filter((x) => x !== "writes_disabled"),
    });
  }
  return json(await settingsResponse(db));
}

async function verifyHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const who = actor(ctx);
  const b = await readBody(ctx, ["note", "confirm", "checks"]);
  if (typeof b["confirm"] !== "string" || !phraseMatches(b["confirm"], VERIFY_PHRASE))
    throw new ApiError("confirmation_required");
  // Every check ticked: exactly the list of core, nothing missing, nothing extra, no duplicates (S7).
  if (!Array.isArray(b["checks"]) || !sameChecks(b["checks"])) {
    throw new ApiError("checks_incomplete");
  }
  const text = note(b["note"], 10, 500, "bad_note");
  const before = await loadBookingState(db);
  // A verification belongs to one booking mode: without a decision there is nothing to verify.
  if (before.createsBankEntries === null) throw new ApiError("bank_entries_undecided", 409);
  const mark = {
    at: new Date(ctx.nowMs).toISOString(),
    by: who,
    note: text,
    protocolVersion: BOOKING_PROTOCOL_VERSION,
    checks: [...BOOKING_VERIFY_CHECKS],
    createsBankEntries: before.createsBankEntries,
  };
  await db.batch([
    db.prepare(UPSERT_SETTING).bind(SETTING_VERIFIED, JSON.stringify(mark), who),
    // A new verification always leaves booking OFF: switching it on is a separate, typed decision.
    db.prepare(UPSERT_SETTING).bind(SETTING_ENABLED, "false", who),
    auditStatement(db, {
      actorEmail: who,
      action: "booking.verified",
      entity: "settings",
      entityId: SETTING_VERIFIED,
      before: {
        verifiedAt: before.verified?.at ?? null,
        protocolVersion: before.verified?.protocolVersion ?? null,
        enabled: before.enabled,
      },
      after: {
        protocolVersion: BOOKING_PROTOCOL_VERSION,
        note: text,
        enabled: false,
        checks: mark.checks,
        createsBankEntries: mark.createsBankEntries,
      },
    }),
  ]);
  return json(await settingsResponse(db));
}

// ---- outbox ---------------------------------------------------------------------------------------

interface ListRow {
  id: number;
  match_id: number;
  kind: "bank_entry" | "matchset";
  status: BookingStatus;
  attempts: number;
  last_error_code: string | null;
  exact_ref: string | null;
  created_at: string;
  updated_at: string;
  tx_id: number;
  amount_minor: number;
  currency: string;
  counterparty_name: string | null;
  ledger_account_code: string | null;
  manually_booked: number;
}

const LIST_SELECT = `SELECT o.id, o.match_id, o.kind, o.status, o.attempts, o.last_error_code, o.exact_ref,
    o.created_at, o.updated_at, t.id AS tx_id, m.amount_minor, m.currency, t.counterparty_name,
    m.ledger_account_code, m.manually_booked
  FROM exact_write_outbox o
    JOIN matches m ON m.id = o.match_id
    JOIN bank_transactions t ON t.id = m.bank_transaction_id`;

async function toDtos(db: D1Database, rows: ListRow[]): Promise<BookingOutboxItemDto[]> {
  const labels = new Map<number, string[]>();
  if (rows.length > 0) {
    const ids = [...new Set(rows.map((r) => r.match_id))];
    const marks = ids.map((_, i) => `?${i + 1}`).join(", ");
    const items = (
      await db
        .prepare(
          `SELECT a.match_id, oi.id, oi.invoice_number FROM match_allocations a
             JOIN open_items oi ON oi.id = a.open_item_id
           WHERE a.match_id IN (${marks}) ORDER BY a.match_id, oi.id`,
        )
        .bind(...ids)
        .all<{ match_id: number; id: number; invoice_number: string | null }>()
    ).results;
    for (const i of items) {
      const list = labels.get(i.match_id) ?? [];
      list.push(safeText(i.invoice_number, 40) ?? `Item ${i.id}`);
      labels.set(i.match_id, list);
    }
  }
  return rows.map((r) => ({
    bookedManually: r.manually_booked === 1,
    id: r.id,
    matchId: r.match_id,
    kind: r.kind,
    status: r.status,
    attempts: r.attempts,
    lastErrorCode: r.last_error_code,
    exactRef: r.exact_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    transactionId: r.tx_id,
    amountMinor: r.amount_minor,
    currency: r.currency,
    counterpartyName: safeText(r.counterparty_name, 80),
    itemLabels:
      r.ledger_account_code !== null
        ? [`Ledger ${safeText(r.ledger_account_code, 20) ?? ""}`.trim()]
        : (labels.get(r.match_id) ?? []),
  }));
}

async function listHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const q = ctx.url.searchParams;
  const status = q.get("status");
  if (status !== null && !(OUTBOX_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequest("bad_status");
  }
  const limitRaw = q.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    if (!/^[1-9]\d{0,3}$/.test(limitRaw)) throw new BadRequest("bad_limit");
    limit = Math.min(MAX_LIMIT, Number(limitRaw));
  }
  const cursorRaw = q.get("cursor");
  if (cursorRaw !== null && !/^[1-9]\d{0,12}$/.test(cursorRaw)) throw new BadRequest("bad_cursor");
  const cursor = cursorRaw === null ? null : Number(cursorRaw);

  const [page, counts] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `${LIST_SELECT} WHERE (?1 IS NULL OR o.status = ?1) AND (?2 IS NULL OR o.id < ?2)
         ORDER BY o.id DESC LIMIT ?3`,
      )
      .bind(status, cursor, limit + 1),
    db.prepare("SELECT status, COUNT(*) AS n FROM exact_write_outbox GROUP BY status"),
  ]);
  const rows = (page?.results ?? []) as unknown as ListRow[];
  const more = rows.length > limit;
  const shown = more ? rows.slice(0, limit) : rows;
  const countsByStatus = Object.fromEntries(OUTBOX_STATUSES.map((s) => [s, 0])) as Record<
    BookingStatus,
    number
  >;
  for (const c of counts?.results ?? []) {
    const s = String(c["status"]) as BookingStatus;
    if (s in countsByStatus) countsByStatus[s] = Number(c["n"]);
  }
  const total =
    status === null
      ? Object.values(countsByStatus).reduce((a, b) => a + b, 0)
      : countsByStatus[status as BookingStatus];
  const out: BookingOutboxResponse = {
    items: await toDtos(db, shown),
    nextCursor: more ? String(shown[shown.length - 1]?.id ?? "") : null,
    total,
    countsByStatus,
  };
  return json(out);
}

// ---- resolve --------------------------------------------------------------------------------------

const RETRYABLE: readonly OutboxStatus[] = ["failed", "outcome_unknown", "waiting_for_bank_line"];
const OPEN: readonly OutboxStatus[] = OUTBOX_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));

async function resolveHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const who = actor(ctx);
  const raw = ctx.params["id"] ?? "";
  if (!/^[1-9]\d{0,12}$/.test(raw)) throw new ApiError("not_found", 404);
  const id = Number(raw);
  const b = await readBody(ctx, ["resolution", "note"]);
  const resolution = b["resolution"];
  if (resolution !== "booked_manually" && resolution !== "retry" && resolution !== "give_up") {
    throw new ApiError("bad_resolution");
  }
  const text = note(b["note"], 3, 200, "bad_note");
  const row: OutboxRow | null = await loadRow(db, id);
  if (row === null) throw new ApiError("not_found", 404);
  const match = await db
    .prepare("SELECT exact_state, undone_at FROM matches WHERE id = ?1")
    .bind(row.match_id)
    .first<{ exact_state: string; undone_at: string | null }>();
  if (match === null || match.undone_at !== null) throw new ApiError("not_found", 404);
  const nowIso = new Date(ctx.nowMs).toISOString();

  if (!OPEN.includes(row.status)) throw new ApiError("not_resolvable", 409);
  if (row.status === "sending" && (row.lease_expires_at ?? "") >= nowIso) {
    throw new ApiError("in_flight", 409);
  }
  // A decision covers the whole match: never while another of its writes may be on the wire.
  const sibling = await db
    .prepare(
      `SELECT 1 AS x FROM exact_write_outbox WHERE match_id = ?1 AND id <> ?2 AND status = 'sending'
         AND (lease_expires_at IS NULL OR lease_expires_at >= ?3) LIMIT 1`,
    )
    .bind(row.match_id, id, nowIso)
    .first();
  if (sibling !== null) throw new ApiError("in_flight", 409);

  let applied: boolean;
  if (resolution === "retry" && row.status === "manual_required") {
    // A claimed match that never reached Exact (stage 'none', nothing sent): back to the review
    // queue, the next run plans it again (or defers it with a code). Anything else is not retryable.
    const none = parseDoc(row.payload_json, row.payload_hash)?.stage === "none";
    if (!none) throw new ApiError("not_retryable", 409);
    const snapshot = await rowDto(db, row);
    const r = await retryUnsentClaim(db, row.match_id, who, text);
    if (r.kind !== "done") throw new ApiError("not_retryable", 409);
    const out: BookingResolveResponse = { item: snapshot, released: true };
    return json(out);
  }
  if (resolution === "retry") {
    if (!RETRYABLE.includes(row.status)) throw new ApiError("not_retryable", 409);
    const doc = parseDoc(row.payload_json, row.payload_hash);
    if (doc === null || doc.stage === "none") throw new ApiError("not_retryable", 409);
    // The executor probes Exact before any POST of this row (needs_probe); a retry never posts blind.
    const resetsMatch =
      match.exact_state === "booking_failed" || match.exact_state === "outcome_unknown";
    applied = await transition(db, {
      rowId: id,
      matchId: row.match_id,
      from: [row.status],
      to: "pending",
      token: null,
      nowIso,
      // The last error code stays: the executor needs it to judge a later read-back (B2a).
      needsProbe: true,
      nextAttemptAt: null,
      adminResolved: { by: who, at: nowIso },
      ...(resetsMatch ? { match: { from: match.exact_state, to: "booking", note: null } } : {}),
      actor: who,
      action: "booking.retry",
      audit: { resolution, note: text, previousStatus: row.status },
    });
  } else {
    const done = resolution === "booked_manually";
    const toStatus: OutboxStatus = done ? "resolved_manually" : "given_up";
    const toMatch = done ? "matched_in_exact" : "manual_required";
    const moves = match.exact_state !== toMatch;
    applied = await transition(db, {
      rowId: id,
      matchId: row.match_id,
      from: [row.status],
      to: toStatus,
      token: null,
      nowIso,
      needsProbe: false,
      nextAttemptAt: null,
      ...(moves
        ? {
            match: {
              from: match.exact_state,
              to: toMatch,
              note: done ? "booked_manually" : "given_up",
              ...(done ? { bookedAt: nowIso, manuallyBooked: true } : {}),
            },
          }
        : {}),
      actor: who,
      action: done ? "booking.booked_manually" : "booking.given_up",
      audit: { resolution, note: text, previousStatus: row.status },
      // The decision covers the whole match: its other open rows end the same way.
      after: (d) => [
        d
          .prepare(
            `UPDATE exact_write_outbox SET status = ?3, updated_at = ?4, claimed_at = NULL, lease_expires_at = NULL
             WHERE match_id = ?1 AND id <> ?2 AND status NOT IN ('verified', 'resolved_manually', 'given_up')
               AND NOT (status = 'sending' AND (lease_expires_at IS NULL OR lease_expires_at >= ?4))
               AND ${GUARD}`,
          )
          .bind(row.match_id, id, toStatus, nowIso),
      ],
    });
  }
  if (!applied) throw new ApiError("changed_meanwhile", 409);
  const fresh = await db.prepare(`${LIST_SELECT} WHERE o.id = ?1`).bind(id).first<ListRow>();
  const [item] = fresh === null ? [] : await toDtos(db, [fresh]);
  if (item === undefined) throw new ApiError("not_found", 404);
  const out: BookingResolveResponse = { item };
  return json(out);
}

/** The DTO of a row as it was before it was removed (the response of a released claim). */
async function rowDto(db: D1Database, row: OutboxRow): Promise<BookingOutboxItemDto> {
  const fresh = await db.prepare(`${LIST_SELECT} WHERE o.id = ?1`).bind(row.id).first<ListRow>();
  const [item] = fresh === null ? [] : await toDtos(db, [fresh]);
  if (item === undefined) throw new ApiError("not_found", 404);
  return item;
}

// ---- registration ---------------------------------------------------------------------------------

async function previewHandler(ctx: Ctx): Promise<Response> {
  const who = actor(ctx);
  const b = await readBody(ctx, ["matchIds"]);
  const raw = b["matchIds"];
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > PREVIEW_MAX_MATCHES ||
    !raw.every((x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 1)
  ) {
    throw new ApiError("bad_match_ids");
  }
  const ids = [...new Set(raw as number[])];
  const out: BookingPreviewResponse = await runPreview(ctx.env, ctx.env.DB, ids, who, ctx.nowMs);
  return json(out);
}

export function registerBookingRoutes(router: Router): void {
  router.add("GET", "/api/booking/settings", ANY_ROLE, safely(getSettingsHandler));
  // Disabling needs only an admin; enabling checks the fresh sign-in itself (same answer as the router).
  router.add("PUT", "/api/booking/settings", ADMIN, safely(putSettingsHandler));
  router.add("POST", "/api/booking/verify", ADMIN_STEP_UP, safely(verifyHandler));
  // A dry run: reads only (job id exact-booking-preview), never needs the switch, writes one audit row.
  router.add("POST", "/api/booking/preview", ADMIN_STEP_UP, safely(previewHandler));
  router.add("GET", "/api/booking/outbox", ANY_ROLE, safely(listHandler));
  router.add("POST", "/api/booking/outbox/:id/resolve", ADMIN_STEP_UP, safely(resolveHandler));
}
