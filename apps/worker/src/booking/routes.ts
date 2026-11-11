/**
 * Booking API (task M7c, ADR 0043).
 *
 *  GET  /api/booking/settings               any role   the fail-closed switch, the verification, blockers
 *  PUT  /api/booking/settings               admin      {enabled, confirm, note?}. Enabling: fresh sign-in,
 *                                                      the phrase ENABLE EXACT BOOKING and every
 *                                                      precondition. Disabling: no step-up, audited.
 *  POST /api/booking/verify                 admin, step-up   {note, confirm}: the write path was verified
 *                                                      on a TEST division (stores the protocol version).
 *                                                      Also switches booking OFF: enabling is always explicit.
 *  GET  /api/booking/outbox                 any role   ?status=&limit=&cursor=
 *  POST /api/booking/outbox/:id/resolve     admin, step-up   {resolution, note}
 *
 * Every write is audited in the same batch (ADR 0013). Nothing here calls Exact.
 */
import {
  type BookingOutboxItemDto,
  type BookingOutboxResponse,
  type BookingResolveResponse,
  type BookingSettingsResponse,
  type BookingStatus,
} from "@camelthorn/core";
import { BOOKING_PROTOCOL_VERSION } from "@camelthorn/exact";
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
import {
  blockersOf,
  ENABLE_PHRASE,
  loadBookingState,
  SETTING_ENABLED,
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
    readonly status: 400 | 401 | 404 | 409 = 400,
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

/** A written note: trimmed, no control characters, `min`..`max` characters. */
function note(v: unknown, min: number, max: number, code: string): string {
  if (typeof v !== "string") throw new ApiError(code);
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
  if (t.length < min || t.length > max) throw new ApiError(code);
  return t;
}

// ---- settings -------------------------------------------------------------------------------------

async function settingsResponse(db: D1Database): Promise<BookingSettingsResponse> {
  const s = await loadBookingState(db);
  return {
    enabled: s.enabled,
    verified: s.verified,
    protocolVersion: s.protocolVersion,
    protocolChanged: s.protocolChanged,
    createsBankEntries: s.createsBankEntries,
    blockers: blockersOf(s),
  };
}

async function getSettingsHandler(ctx: Ctx): Promise<Response> {
  return json(await settingsResponse(ctx.env.DB));
}

const UPSERT_SETTING = `INSERT INTO settings (key, value_json, updated_by) VALUES (?1, ?2, ?3)
  ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

async function putSettingsHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const who = actor(ctx);
  const b = await readBody(ctx, ["enabled", "confirm", "note"]);
  if (typeof b["enabled"] !== "boolean") throw new ApiError("bad_request");
  const why = b["note"] === undefined ? null : note(b["note"], 1, 200, "bad_note");

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
  if (b["confirm"] !== ENABLE_PHRASE) throw new ApiError("confirmation_required");
  const before = await loadBookingState(db);
  const blockers = blockersOf(before).filter((x) => x !== "writes_disabled");
  if (blockers.length > 0) throw new ApiError("blocked", 409, { blockers });
  // The conditions are repeated in the write itself, so a change between the read and the write
  // (a connection disabled, a verification replaced) cannot slip through.
  const out = await db.batch([
    db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_by)
         SELECT ?1, 'true', ?2
         WHERE EXISTS (SELECT 1 FROM settings WHERE key = ?3 AND json_extract(value_json, '$.protocolVersion') = ?4)
           AND EXISTS (SELECT 1 FROM connections WHERE kind = 'exact' AND status = 'active')
           AND EXISTS (SELECT 1 FROM connections WHERE kind = 'revolut' AND bank_entries_decided_at IS NOT NULL)
         ON CONFLICT (key) DO UPDATE SET value_json = 'true', updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .bind(SETTING_ENABLED, who, SETTING_VERIFIED, BOOKING_PROTOCOL_VERSION),
    auditStatement(
      db,
      {
        actorEmail: who,
        action: "booking.enabled",
        entity: "settings",
        entityId: SETTING_ENABLED,
        before: { enabled: before.enabled },
        after: {
          enabled: true,
          protocolVersion: BOOKING_PROTOCOL_VERSION,
          createsBankEntries: before.createsBankEntries,
          ...(why !== null ? { note: why } : {}),
        },
      },
      { sql: GUARD, binds: [] },
    ),
  ]);
  if ((out[0]?.meta.changes ?? 0) !== 1) {
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
  const b = await readBody(ctx, ["note", "confirm"]);
  if (b["confirm"] !== VERIFY_PHRASE) throw new ApiError("confirmation_required");
  const text = note(b["note"], 10, 500, "bad_note");
  const before = await loadBookingState(db);
  const mark = {
    at: new Date(ctx.nowMs).toISOString(),
    by: who,
    note: text,
    protocolVersion: BOOKING_PROTOCOL_VERSION,
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
      after: { protocolVersion: BOOKING_PROTOCOL_VERSION, note: text, enabled: false },
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
}

const LIST_SELECT = `SELECT o.id, o.match_id, o.kind, o.status, o.attempts, o.last_error_code, o.exact_ref,
    o.created_at, o.updated_at, t.id AS tx_id, m.amount_minor, m.currency, t.counterparty_name,
    m.ledger_account_code
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

  let applied: boolean;
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
      errorCode: null,
      needsProbe: true,
      nextAttemptAt: null,
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
              note: done ? null : "given_up",
              ...(done ? { bookedAt: nowIso } : {}),
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

// ---- registration ---------------------------------------------------------------------------------

export function registerBookingRoutes(router: Router): void {
  router.add("GET", "/api/booking/settings", ANY_ROLE, safely(getSettingsHandler));
  // Disabling needs only an admin; enabling checks the fresh sign-in itself (same answer as the router).
  router.add("PUT", "/api/booking/settings", ADMIN, safely(putSettingsHandler));
  router.add("POST", "/api/booking/verify", ADMIN_STEP_UP, safely(verifyHandler));
  router.add("GET", "/api/booking/outbox", ANY_ROLE, safely(listHandler));
  router.add("POST", "/api/booking/outbox/:id/resolve", ADMIN_STEP_UP, safely(resolveHandler));
}
