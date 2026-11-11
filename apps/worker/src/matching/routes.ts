/**
 * Matching API (Phase 7, M7b, ADR 0042). Shapes: packages/core api-types (Match*).
 *
 *  GET  /api/matching/queue                  any role   lines needing review, with top candidates
 *  GET  /api/matching/auto                   any role   recent automatic matches (Undo available?)
 *  GET  /api/matching/stats                  any role   counts and the oldest open line
 *  GET  /api/matching/transactions/:id       any role   one line with every candidate
 *  POST /api/matching/matches                finance, admin   manual match (invoices or ledger)
 *  POST /api/matching/matches/:id/undo       finance, admin   while Exact has not booked it
 *  POST /api/matching/transactions/:id/ignore | unignore   finance, admin
 *  POST /api/matching/transactions/:id/clear-conflict      admin, step-up, note required
 *  POST /api/matching/auto/disable           admin (no step-up: the safe direction, audited)
 *  GET/PUT /api/matching/config              admin (PUT: step-up; switching auto on needs a typed phrase)
 *  GET/PUT /api/matching/account-map         admin (PUT: step-up)
 *  GET/POST/PUT/DELETE /api/matching/patterns[/:id]   admin (writes: step-up)
 *
 * Every write is audited in the same batch (ADR 0013). Nothing here calls Exact or Revolut.
 * Money in requests is integer minor units. Responses never contain a full IBAN.
 */
import {
  compileSafeRegex,
  likePatterns,
  maskIban,
  normalizeIban,
  validateMatchConfig,
  type MatchAccountMapDto,
  type MatchAccountMapResponse,
  type MatchAutoResponse,
  type MatchConfigResponse,
  type MatchCreateResponse,
  type MatchDetailResponse,
  type MatchDto,
  type MatchIgnoreReason,
  type MatchIgnoreResponse,
  type MatchPatternDto,
  type MatchPatternsResponse,
  type MatchQueueResponse,
  type MatchStatsResponse,
  type MatchTunablesDto,
  type MatchUndoResponse,
} from "@camelthorn/core";
import { auditStatement, LAST_INSERT_ID } from "../db/audit";
import { decodeTxCursor, encodeTxCursor } from "../read/bank-routes";
import { ANY_ROLE, BadRequest, guarded, positiveIntParam } from "../read/routes";
import { clearStateConflict } from "../revolut/conflicts";
import { json, type Ctx, type Router } from "../router";
import { loadMappings } from "./assemble";
import {
  AUTO_CONFIRM_PHRASE,
  buildMatchConfig,
  DEFAULT_TUNABLES,
  loadMatchingSettings,
  parseTunables,
  PATTERN_COLUMNS,
  SETTING_AUTO,
  SETTING_CONFIG,
  SETTING_ENABLED,
  toLedgerPattern,
  type Tunables,
} from "./config";
import { loadMatches, loadSuggestions, safeText, toTxDto, TX_SELECT, type TxSqlRow } from "./dto";
import {
  allocCounts,
  applyMatch,
  ignoreTransaction,
  matchErrorCode,
  undoMatch,
  unignoreTransaction,
  type MatchErrCode,
} from "./store";

const FINANCE = { roles: ["finance", "admin"] } as const;
const ADMIN = { roles: ["admin"] } as const;
const ADMIN_STEP_UP = { roles: ["admin"], stepUp: true } as const;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_ALLOCATIONS = 20;
const MAX_PATTERNS = 100;
const LEDGER_CODE = /^[0-9A-Za-z.-]{1,20}$/;
const JOURNAL_CODE = /^[0-9A-Za-z._-]{1,10}$/;

/** An error with its own status and fixed code (never a message from data). */
class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422 = 400,
    /** A second fixed code that says more (for example reversal_required_in_exact). */
    readonly detail?: string,
  ) {
    super(code);
  }
}

type Handler = (ctx: Ctx) => Promise<Response>;

/** Maps ApiError and BadRequest to JSON; anything else is a real error (500 by the router). */
const safely =
  (fn: Handler): Handler =>
  async (ctx) => {
    try {
      return await guarded(fn)(ctx);
    } catch (err) {
      if (err instanceof ApiError) {
        return json(
          err.detail === undefined ? { error: err.code } : { error: err.code, detail: err.detail },
          err.status,
        );
      }
      throw err;
    }
  };

const email = (ctx: Ctx): string => {
  if (!ctx.session) throw new BadRequest("unauthenticated");
  return ctx.session.email;
};

async function readBody(ctx: Ctx, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const len = Number(ctx.request.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > 20_000) throw new ApiError("bad_request");
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

function idParam(ctx: Ctx): number {
  const raw = ctx.params["id"] ?? "";
  if (!/^[1-9]\d{0,12}$/.test(raw)) throw new ApiError("not_found", 404);
  return Number(raw);
}

/** Free text from a person: trimmed, no control characters, 1..max characters. */
function textField(v: unknown, max: number, required: boolean, code: string): string | null {
  if (v === undefined || v === null) {
    if (required) throw new ApiError(code);
    return null;
  }
  if (typeof v !== "string") throw new ApiError(code);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(v)) {
    throw new ApiError(code);
  }
  const t = v.trim();
  if (t.length === 0) {
    if (required) throw new ApiError(code);
    return null;
  }
  if (t.length > max) throw new ApiError(code);
  return t;
}

function limitParam(ctx: Ctx): number {
  const raw = ctx.url.searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const n = positiveIntParam(raw, "limit");
  if (n === null || n > MAX_LIMIT) throw new BadRequest("bad_limit");
  return n;
}

function cursorParam(ctx: Ctx): { createdAt: string; id: number } | null {
  const raw = ctx.url.searchParams.get("cursor");
  if (raw === null) return null;
  const c = decodeTxCursor(raw);
  if (c === null) throw new BadRequest("bad_cursor");
  return c;
}

// ---- reads --------------------------------------------------------------------------------------

const TOP_CANDIDATES = 3;
const FINAL = "t.is_final = 1 AND t.state = 'completed'";

async function queueHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const q = ctx.url.searchParams;
  const status = q.get("status") ?? "review";
  const where: string[] = [FINAL];
  const binds: (string | number)[] = [];
  const bind = (v: string | number): string => {
    binds.push(v);
    return `?${binds.length}`;
  };
  if (status === "review") where.push("t.match_status IN ('unmatched', 'suggested')");
  else if (status === "suggested") where.push("t.match_status = 'suggested'");
  else if (status === "ignored") where.push("t.match_status = 'ignored'");
  else if (status !== "all") throw new BadRequest("bad_status");
  const account = positiveIntParam(q.get("account"), "account");
  if (account !== null) where.push(`t.bank_account_id = ${bind(account)}`);
  const text = (q.get("q") ?? "").trim();
  if (text.length > 100) throw new BadRequest("bad_q");
  let patterns: string[];
  try {
    patterns = likePatterns(text);
  } catch {
    throw new BadRequest("bad_q");
  }
  for (const p of patterns) {
    where.push(
      `lower(COALESCE(t.reference, '') || char(10) || COALESCE(t.description, '') || char(10) ||
             COALESCE(t.counterparty_name, '')) LIKE ${bind(p)} ESCAPE '\\'`,
    );
  }
  const limit = limitParam(ctx);
  const cursor = cursorParam(ctx);
  const baseWhere = where.join(" AND ");
  const baseBinds = [...binds];
  if (cursor) {
    const a = bind(cursor.createdAt);
    const b = bind(cursor.id);
    where.push(`(t.created_at < ${a} OR (t.created_at = ${a} AND t.id < ${b}))`);
  }
  const rows = (
    await db
      .prepare(
        `${TX_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit + 1}`,
      )
      .bind(...binds)
      .all<TxSqlRow>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeTxCursor({ createdAt: last.created_at, id: last.id })
      : null;
  const total =
    (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM bank_transactions t WHERE ${baseWhere}`)
        .bind(...baseBinds)
        .first<{ n: number }>()
    )?.n ?? 0;
  const sugg = await loadSuggestions(
    db,
    page.map((r) => r.id),
  );
  const settings = await loadMatchingSettings(db);
  const body: MatchQueueResponse = {
    items: page.map((r) => ({
      transaction: toTxDto(r),
      candidates: (sugg.get(r.id) ?? []).slice(0, TOP_CANDIDATES),
    })),
    nextCursor,
    total,
    autoEnabled: settings.autoEnabled,
  };
  return json(body);
}

async function autoHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const limit = limitParam(ctx);
  const cursor = cursorParam(ctx);
  const rows = (
    await db
      .prepare(
        `SELECT m.id, m.created_at, m.bank_transaction_id FROM matches m
         WHERE m.source = 'auto'
           AND (?1 IS NULL OR m.created_at < ?1 OR (m.created_at = ?1 AND m.id < ?2))
         ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit + 1}`,
      )
      .bind(cursor?.createdAt ?? null, cursor?.id ?? 0)
      .all<{ id: number; created_at: string; bank_transaction_id: number }>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const matches = await loadMatches(
    db,
    page.map((r) => r.id),
  );
  const txIds = [...new Set(page.map((r) => r.bank_transaction_id))];
  const txRows = new Map<number, TxSqlRow>();
  if (txIds.length > 0) {
    const got = (
      await db
        .prepare(`${TX_SELECT} WHERE t.id IN (${txIds.map((_, i) => `?${i + 1}`).join(", ")})`)
        .bind(...txIds)
        .all<TxSqlRow>()
    ).results;
    for (const r of got) txRows.set(r.id, r);
  }
  const items: MatchAutoResponse["items"] = [];
  for (const r of page) {
    const match = matches.get(r.id);
    const tx = txRows.get(r.bank_transaction_id);
    if (match && tx) items.push({ match, transaction: toTxDto(tx) });
  }
  const body: MatchAutoResponse = {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeTxCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
  return json(body);
}

async function loadLiveMatchId(db: D1Database, txId: number): Promise<number | null> {
  const r = await db
    .prepare("SELECT id FROM matches WHERE bank_transaction_id = ?1 AND undone_at IS NULL")
    .bind(txId)
    .first<{ id: number }>();
  return r?.id ?? null;
}

async function loadTx(db: D1Database, id: number): Promise<TxSqlRow | null> {
  return db.prepare(`${TX_SELECT} WHERE t.id = ?1`).bind(id).first<TxSqlRow>();
}

async function detailHandler(ctx: Ctx): Promise<Response> {
  const id = idParam(ctx);
  const db = ctx.env.DB;
  const tx = await loadTx(db, id);
  if (!tx) throw new ApiError("not_found", 404);
  const matchId = await loadLiveMatchId(db, id);
  const body: MatchDetailResponse = {
    transaction: toTxDto(tx),
    candidates: (await loadSuggestions(db, [id])).get(id) ?? [],
    match: matchId === null ? null : ((await loadMatches(db, [matchId])).get(matchId) ?? null),
  };
  return json(body);
}

async function statsHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const counts = (
    await db
      .prepare(
        `SELECT t.match_status AS s, COUNT(*) AS n FROM bank_transactions t
         WHERE ${FINAL} GROUP BY t.match_status`,
      )
      .all<{ s: string; n: number }>()
  ).results;
  const n = (s: string): number => counts.find((c) => c.s === s)?.n ?? 0;
  const fiveDaysAgo = new Date(ctx.nowMs - 5 * 86_400_000).toISOString();
  const open = await db
    .prepare(
      `SELECT MIN(t.created_at) AS oldest,
              COALESCE(SUM(CASE WHEN t.created_at < ?1 THEN 1 ELSE 0 END), 0) AS over5
       FROM bank_transactions t
       WHERE ${FINAL} AND t.match_status IN ('unmatched', 'suggested')`,
    )
    .bind(fiveDaysAgo)
    .first<{ oldest: string | null; over5: number }>();
  const auto = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN source = 'auto' THEN 1 ELSE 0 END), 0) AS n,
              COALESCE(SUM(CASE WHEN review_reason IS NOT NULL THEN 1 ELSE 0 END), 0) AS review
       FROM matches WHERE undone_at IS NULL`,
    )
    .first<{ n: number; review: number }>();
  const settings = await loadMatchingSettings(db);
  const { unmappedAccounts } = await loadMappings(db);
  const oldest = open?.oldest ?? null;
  const oldestMs = oldest === null ? NaN : Date.parse(oldest);
  const body: MatchStatsResponse = {
    unmatched: n("unmatched"),
    suggested: n("suggested"),
    matched: n("matched"),
    ignored: n("ignored"),
    oldestUnmatchedAt: oldest,
    oldestUnmatchedDays: Number.isFinite(oldestMs)
      ? Math.max(0, Math.floor((ctx.nowMs - oldestMs) / 86_400_000))
      : null,
    unmatchedOverFiveDays: open?.over5 ?? 0,
    liveAutoMatches: auto?.n ?? 0,
    matchesNeedingReview: auto?.review ?? 0,
    enabled: settings.enabled,
    autoEnabled: settings.autoEnabled,
    unmappedAccounts,
  };
  return json(body);
}

// ---- manual match -------------------------------------------------------------------------------

const ERR_TO_API: Record<MatchErrCode, [string, 409 | 422]> = {
  tx_not_matchable: ["already_matched", 409],
  division_mismatch: ["account_not_mapped", 422],
  division_inactive: ["division_inactive", 422],
  bad_match_row: ["bad_request", 422],
  match_not_live: ["already_matched", 409],
  alloc_on_ledger_match: ["allocations_or_ledger", 422],
  item_not_matchable: ["item_changed", 409],
  direction_mismatch: ["direction_mismatch", 422],
  alloc_exceeds_open: ["item_changed", 409],
  alloc_exceeds_tx: ["allocation_sum_mismatch", 422],
  cannot_revive: ["already_matched", 409],
  immutable: ["already_matched", 409],
  tx_frozen: ["already_matched", 409],
  status_mismatch: ["already_matched", 409],
  has_live_matches: ["has_live_matches", 409],
  bad_transition: ["already_booked_in_exact", 409],
};

interface ManualTxRow {
  id: number;
  amount_minor: number;
  currency: string;
  is_final: number;
  state: string;
  match_status: string;
  state_conflict: number;
  counterparty_iban: string | null;
  division_id: number | null;
  division_active: number | null;
}

async function createMatchHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const actor = email(ctx);
  const b = await readBody(ctx, [
    "transactionId",
    "allocations",
    "ledgerAccountCode",
    "note",
    "confirmDifferentRelation",
  ]);
  const confirmOther = b["confirmDifferentRelation"];
  if (confirmOther !== undefined && typeof confirmOther !== "boolean") {
    throw new ApiError("bad_confirm");
  }
  const txId = b["transactionId"];
  if (typeof txId !== "number" || !Number.isSafeInteger(txId) || txId < 1) {
    throw new ApiError("bad_transaction");
  }
  const note = textField(b["note"], 200, false, "bad_note");
  const hasAlloc = b["allocations"] !== undefined;
  const hasLedger = b["ledgerAccountCode"] !== undefined;
  if (hasAlloc === hasLedger) throw new ApiError("allocations_or_ledger");

  const tx = await db
    .prepare(
      `SELECT t.id, t.amount_minor, t.currency, t.is_final, t.state, t.match_status, t.state_conflict,
              t.counterparty_iban, m.division_id,
              (SELECT 1 FROM divisions d JOIN connections c ON c.id = d.connection_id
                WHERE d.id = m.division_id AND d.sync_enabled = 1 AND c.status <> 'disabled') AS division_active
       FROM bank_transactions t
       LEFT JOIN bank_account_exact_map m ON m.bank_account_id = t.bank_account_id
       WHERE t.id = ?1`,
    )
    .bind(txId)
    .first<ManualTxRow>();
  if (!tx) throw new ApiError("not_found", 404);
  if (tx.is_final !== 1 || tx.state !== "completed") throw new ApiError("tx_not_final", 422);
  if (tx.match_status === "matched") throw new ApiError("already_matched", 409);
  if (tx.match_status === "ignored") throw new ApiError("tx_ignored", 409);
  if (tx.state_conflict === 1) throw new ApiError("tx_state_conflict", 409);
  if (tx.division_id === null) throw new ApiError("account_not_mapped", 422);
  if (tx.division_active !== 1) throw new ApiError("division_inactive", 422);
  const amount = Math.abs(tx.amount_minor);
  if (amount === 0) throw new ApiError("tx_not_matchable", 422);
  const txDirection = tx.amount_minor >= 0 ? "in" : "out";

  let ledger: string | null = null;
  let differentRelation = false;
  const allocations: {
    openItemId: number;
    allocatedMinor: number;
    remainingAfter: number | null;
  }[] = [];
  if (hasLedger) {
    const code = b["ledgerAccountCode"];
    if (typeof code !== "string" || !LEDGER_CODE.test(code))
      throw new ApiError("bad_ledger_account");
    ledger = code;
  } else {
    const list = b["allocations"];
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ALLOCATIONS) {
      throw new ApiError("bad_allocations");
    }
    const seen = new Set<number>();
    const wanted: { id: number; amount: number }[] = [];
    for (const raw of list) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ApiError("bad_allocations");
      }
      const o = raw as Record<string, unknown>;
      if (Object.keys(o).some((k) => k !== "openItemId" && k !== "allocatedMinor")) {
        throw new ApiError("bad_allocations");
      }
      const id = o["openItemId"];
      const a = o["allocatedMinor"];
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
        throw new ApiError("bad_allocations");
      if (typeof a !== "number" || !Number.isSafeInteger(a) || a < 1)
        throw new ApiError("bad_allocations");
      if (seen.has(id)) throw new ApiError("duplicate_item", 422);
      seen.add(id);
      wanted.push({ id, amount: a });
    }
    const marks = wanted.map((_, i) => `?${i + 1}`).join(", ");
    const items = (
      await db
        .prepare(
          `SELECT oi.id, oi.division_id, oi.currency, oi.open_minor, oi.kind, oi.status,
                  (SELECT r.id FROM relations r WHERE r.division_id = oi.division_id
                     AND r.exact_id = oi.relation_id) AS rel_id,
                  COALESCE((SELECT SUM(a.allocated_minor) FROM match_allocations a
                              JOIN matches m ON m.id = a.match_id
                             WHERE a.open_item_id = oi.id AND ${allocCounts("m", "oi")}), 0) AS allocated
           FROM open_items oi WHERE oi.id IN (${marks})`,
        )
        .bind(...wanted.map((w) => w.id))
        .all<{
          id: number;
          division_id: number;
          currency: string;
          open_minor: number;
          kind: "invoice" | "bill";
          status: string;
          rel_id: number | null;
          allocated: number;
        }>()
    ).results;
    const byId = new Map(items.map((i) => [i.id, i]));
    let sum = 0;
    for (const w of wanted) {
      const it = byId.get(w.id);
      if (!it) throw new ApiError("item_not_found", 422);
      if (it.division_id !== tx.division_id) throw new ApiError("item_wrong_division", 422);
      if (it.status !== "open" || it.open_minor === 0) throw new ApiError("item_closed", 422);
      if (it.currency !== tx.currency) throw new ApiError("currency_mismatch", 422);
      const settles = (it.kind === "invoice") === it.open_minor > 0 ? "in" : "out";
      if (settles !== txDirection) throw new ApiError("direction_mismatch", 422);
      const free = Math.abs(it.open_minor) - it.allocated;
      if (w.amount > free) throw new ApiError("allocation_exceeds_open", 422);
      sum += w.amount;
      const sign = it.open_minor < 0 ? -1 : 1;
      allocations.push({
        openItemId: w.id,
        allocatedMinor: w.amount,
        remainingAfter: it.open_minor - sign * (it.allocated + w.amount),
      });
    }
    if (sum !== amount) throw new ApiError("allocation_sum_mismatch", 422);

    // The relations the bank line's IBAN belongs to in this administration (active IBANs only). An
    // item of ANOTHER relation is allowed (a parent company pays for a subsidiary) but must be
    // confirmed explicitly; an unknown IBAN gives no signal either way.
    const iban = tx.counterparty_iban === null ? "" : normalizeIban(tx.counterparty_iban);
    if (iban !== "") {
      const owners = new Set(
        (
          await db
            .prepare(
              `SELECT relation_id AS id FROM relation_bank_accounts
               WHERE division_id = ?1 AND iban = ?2 AND removed_at IS NULL
               UNION SELECT id FROM relations WHERE division_id = ?1 AND iban = ?2`,
            )
            .bind(tx.division_id, iban)
            .all<{ id: number }>()
        ).results.map((r) => r.id),
      );
      const other =
        owners.size > 0 && items.some((it) => it.rel_id === null || !owners.has(it.rel_id));
      if (other) {
        if (confirmOther !== true) throw new ApiError("different_relation", 409);
        differentRelation = true;
      }
    }
  }

  const res = await applyMatch(db, {
    txId,
    divisionId: tx.division_id,
    txAmountMinor: amount,
    currency: tx.currency,
    source: ledger !== null ? "ledger" : "manual",
    ledgerAccountCode: ledger,
    score: null,
    rule: null,
    note,
    actor,
    allocations,
    nowIso: new Date(ctx.nowMs).toISOString(),
    differentRelationConfirmed: differentRelation,
  });
  if (!res.ok) {
    const [code, status] = ERR_TO_API[res.code];
    throw new ApiError(code, status);
  }
  const match = (await loadMatches(db, [res.matchId])).get(res.matchId) as MatchDto;
  const out: MatchCreateResponse = { match };
  return json(out, 201);
}

async function undoHandler(ctx: Ctx): Promise<Response> {
  const id = idParam(ctx);
  const b = await readBody(ctx, ["reason"]);
  const reason = textField(b["reason"], 200, true, "bad_reason") as string;
  const res = await undoMatch(
    ctx.env.DB,
    id,
    email(ctx),
    reason,
    new Date(ctx.nowMs).toISOString(),
  );
  switch (res.kind) {
    case "not_found":
      throw new ApiError("not_found", 404);
    case "already_undone":
      throw new ApiError("already_undone", 409);
    case "already_booked_in_exact":
      throw new ApiError(
        "already_booked_in_exact",
        409,
        res.exactState === "matched_in_exact"
          ? "reversal_required_in_exact"
          : "booking_in_progress",
      );
    case "undone": {
      const match = (await loadMatches(ctx.env.DB, [id])).get(id) as MatchDto;
      const out: MatchUndoResponse = { match };
      return json(out);
    }
  }
}

async function txResponse(db: D1Database, id: number): Promise<Response> {
  const tx = await loadTx(db, id);
  if (!tx) throw new ApiError("not_found", 404);
  const out: MatchIgnoreResponse = { transaction: toTxDto(tx) };
  return json(out);
}

const IGNORE_REASONS: readonly MatchIgnoreReason[] = ["internal_transfer", "not_ours", "other"];

async function ignoreHandler(ctx: Ctx): Promise<Response> {
  const id = idParam(ctx);
  const b = await readBody(ctx, ["reason", "note"]);
  const reason = b["reason"];
  if (typeof reason !== "string" || !(IGNORE_REASONS as readonly string[]).includes(reason)) {
    throw new ApiError("bad_reason");
  }
  const note = textField(b["note"], 200, false, "bad_note");
  const db = ctx.env.DB;
  const tx = await loadTx(db, id);
  if (!tx) throw new ApiError("not_found", 404);
  const done = await ignoreTransaction(
    db,
    id,
    reason as MatchIgnoreReason,
    note,
    email(ctx),
    new Date(ctx.nowMs).toISOString(),
  );
  if (!done) {
    const now = await loadTx(db, id);
    if (now?.match_status === "matched") throw new ApiError("already_matched", 409);
    if (now?.match_status === "ignored") throw new ApiError("already_ignored", 409);
    throw new ApiError("not_ignorable", 409);
  }
  return txResponse(db, id);
}

async function unignoreHandler(ctx: Ctx): Promise<Response> {
  const id = idParam(ctx);
  const db = ctx.env.DB;
  if (!(await loadTx(db, id))) throw new ApiError("not_found", 404);
  if (!(await unignoreTransaction(db, id, email(ctx)))) throw new ApiError("not_ignored", 409);
  return txResponse(db, id);
}

/**
 * A state conflict means Revolut contradicted a final (possibly matched) line after the fact.
 * Clearing it re-enables matching of that line, so it is an admin decision with a fresh sign-in and
 * a written note (audited). A matched line keeps its review flag until the match is undone.
 */
async function clearConflictHandler(ctx: Ctx): Promise<Response> {
  const id = idParam(ctx);
  const b = await readBody(ctx, ["note"]);
  const note = textField(b["note"], 200, true, "bad_note") as string;
  const db = ctx.env.DB;
  if (!(await loadTx(db, id))) throw new ApiError("not_found", 404);
  if (!(await clearStateConflict(db, id, email(ctx), note))) throw new ApiError("no_conflict", 409);
  return txResponse(db, id);
}

/** Switching automatic matching OFF: admin, no step-up and no phrase (the safe direction), audited. */
async function disableAutoHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const actor = email(ctx);
  // No body is needed; anything sent is ignored.
  const cur = await loadMatchingSettings(db);
  if (cur.autoEnabled) {
    const nowIso = new Date(ctx.nowMs).toISOString();
    await db.batch([
      db
        .prepare(
          `INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES (?1, 'false', ?2, ?3)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .bind(SETTING_AUTO, actor, nowIso),
      auditStatement(db, {
        actorEmail: actor,
        action: "matching.auto_changed",
        entity: "setting",
        entityId: SETTING_AUTO,
        before: true,
        after: false,
      }),
    ]);
  }
  return json(await configResponse(db));
}

// ---- config -------------------------------------------------------------------------------------

const toTunablesDto = (t: Tunables): MatchTunablesDto => ({ ...t });

async function configResponse(db: D1Database): Promise<MatchConfigResponse> {
  const s = await loadMatchingSettings(db);
  return {
    enabled: s.enabled,
    autoEnabled: s.autoEnabled,
    config: toTunablesDto(s.tunables ?? DEFAULT_TUNABLES),
    defaults: toTunablesDto(DEFAULT_TUNABLES),
    configErrors: s.configErrors,
    updatedAt: s.configUpdatedAt,
    updatedBy: s.configUpdatedBy,
    autoConfirmPhrase: AUTO_CONFIRM_PHRASE,
  };
}

async function getConfigHandler(ctx: Ctx): Promise<Response> {
  return json(await configResponse(ctx.env.DB));
}

async function putConfigHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const actor = email(ctx);
  const b = await readBody(ctx, ["enabled", "autoEnabled", "config", "confirm"]);
  const cur = await loadMatchingSettings(db);
  const nowIso = new Date(ctx.nowMs).toISOString();
  const statements: D1PreparedStatement[] = [];
  const upsert = (key: string, value: unknown, before: unknown, action: string): void => {
    statements.push(
      db
        .prepare(
          `INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .bind(key, JSON.stringify(value), actor, nowIso),
      auditStatement(db, {
        actorEmail: actor,
        action,
        entity: "setting",
        entityId: key,
        before,
        after: value,
      }),
    );
  };

  if (b["enabled"] !== undefined) {
    if (typeof b["enabled"] !== "boolean") throw new ApiError("bad_enabled");
    if (b["enabled"] !== cur.enabled) {
      upsert(SETTING_ENABLED, b["enabled"], cur.enabled, "matching.enabled_changed");
    }
  }
  if (b["autoEnabled"] !== undefined) {
    if (typeof b["autoEnabled"] !== "boolean") throw new ApiError("bad_auto_enabled");
    if (b["autoEnabled"] !== cur.autoEnabled) {
      if (b["autoEnabled"]) {
        if (b["confirm"] !== AUTO_CONFIRM_PHRASE) throw new ApiError("confirmation_required", 422);
        if (cur.tunables === null) throw new ApiError("config_invalid", 422);
      }
      upsert(SETTING_AUTO, b["autoEnabled"], cur.autoEnabled, "matching.auto_changed");
    }
  }
  if (b["config"] !== undefined) {
    const parsed = parseTunables(b["config"], cur.tunables ?? DEFAULT_TUNABLES);
    if (!parsed.ok) return json({ error: "bad_config", problems: parsed.errors.slice(0, 10) }, 422);
    upsert(SETTING_CONFIG, parsed.value, cur.tunables, "matching.config_changed");
  }
  if (statements.length > 0) await db.batch(statements);
  return json(await configResponse(db));
}

// ---- account map --------------------------------------------------------------------------------

interface MapSqlRow {
  id: number;
  name: string;
  iban: string | null;
  currency: string;
  division_id: number | null;
  division_name: string | null;
  journal_code: string | null;
  bank_gl_account_code: string | null;
  receivable_gl_account_code: string | null;
  payable_gl_account_code: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

async function visibleDivisions(db: D1Database): Promise<{ id: number; name: string }[]> {
  return (
    await db
      .prepare(
        `SELECT d.id, d.name FROM divisions d JOIN connections c ON c.id = d.connection_id
         WHERE c.kind = 'exact' AND c.status <> 'disabled' AND d.sync_enabled = 1
         ORDER BY d.name COLLATE NOCASE, d.id`,
      )
      .all<{ id: number; name: string }>()
  ).results;
}

async function accountMapResponse(db: D1Database): Promise<MatchAccountMapResponse> {
  const rows = (
    await db
      .prepare(
        `SELECT ba.id, ba.name, ba.iban, ba.currency, m.division_id, d.name AS division_name,
                m.journal_code, m.bank_gl_account_code, m.receivable_gl_account_code,
                m.payable_gl_account_code, m.updated_at, m.updated_by
         FROM bank_accounts ba
           JOIN connections c ON c.id = ba.connection_id AND c.kind = 'revolut'
           LEFT JOIN bank_account_exact_map m ON m.bank_account_id = ba.id
           LEFT JOIN divisions d ON d.id = m.division_id
         WHERE ba.is_active = 1
         ORDER BY ba.currency, ba.name COLLATE NOCASE, ba.id`,
      )
      .all<MapSqlRow>()
  ).results;
  const accounts: MatchAccountMapDto[] = rows.map((r) => ({
    bankAccountId: r.id,
    accountName: safeText(r.name, 80) ?? "",
    ibanMasked: r.iban === null ? null : maskIban(r.iban),
    currency: r.currency,
    divisionId: r.division_id,
    divisionName: safeText(r.division_name, 120),
    journalCode: r.journal_code,
    bankGlAccountCode: r.bank_gl_account_code,
    receivableGlAccountCode: r.receivable_gl_account_code,
    payableGlAccountCode: r.payable_gl_account_code,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
  return { accounts, divisions: await visibleDivisions(db) };
}

async function getMapHandler(ctx: Ctx): Promise<Response> {
  return json(await accountMapResponse(ctx.env.DB));
}

async function putMapHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const actor = email(ctx);
  const b = await readBody(ctx, [
    "bankAccountId",
    "divisionId",
    "journalCode",
    "bankGlAccountCode",
    "receivableGlAccountCode",
    "payableGlAccountCode",
  ]);
  const accountId = b["bankAccountId"];
  if (typeof accountId !== "number" || !Number.isSafeInteger(accountId) || accountId < 1) {
    throw new ApiError("bad_account");
  }
  const account = await db
    .prepare(
      `SELECT ba.id FROM bank_accounts ba JOIN connections c ON c.id = ba.connection_id
       WHERE ba.id = ?1 AND c.kind = 'revolut'`,
    )
    .bind(accountId)
    .first<{ id: number }>();
  if (!account) throw new ApiError("unknown_account", 404);
  const before = await db
    .prepare(
      "SELECT division_id, journal_code, bank_gl_account_code FROM bank_account_exact_map WHERE bank_account_id = ?1",
    )
    .bind(accountId)
    .first<{ division_id: number; journal_code: string; bank_gl_account_code: string }>();
  const nowIso = new Date(ctx.nowMs).toISOString();
  const divisionId = b["divisionId"];

  // Changing or removing the administration of an account that has live matches would leave those
  // matches pointing at the wrong administration: undo them first.
  const liveFor = async (): Promise<boolean> =>
    (await db
      .prepare(
        `SELECT 1 AS x FROM matches m JOIN bank_transactions t ON t.id = m.bank_transaction_id
         WHERE t.bank_account_id = ?1 AND m.undone_at IS NULL LIMIT 1`,
      )
      .bind(accountId)
      .first()) !== null;

  // The database refuses a division change or removal under live matches (migration 0022), also
  // when a match lands between the check above and the write.
  const guardedBatch = async (stmts: D1PreparedStatement[]): Promise<void> => {
    try {
      await db.batch(stmts);
    } catch (e) {
      if (matchErrorCode(e) === "has_live_matches") throw new ApiError("has_live_matches", 409);
      throw e;
    }
  };

  if (divisionId === null) {
    if (!before) return json(await accountMapResponse(db));
    if (await liveFor()) throw new ApiError("has_live_matches", 409);
    await guardedBatch([
      auditStatement(db, {
        actorEmail: actor,
        action: "matching.account_map_removed",
        entity: "bank_account",
        entityId: accountId,
        before,
      }),
      db.prepare("DELETE FROM bank_account_exact_map WHERE bank_account_id = ?1").bind(accountId),
    ]);
    return json(await accountMapResponse(db));
  }
  if (typeof divisionId !== "number" || !Number.isSafeInteger(divisionId) || divisionId < 1) {
    throw new ApiError("bad_division");
  }
  const division = (await visibleDivisions(db)).find((d) => d.id === divisionId);
  if (!division) throw new ApiError("unknown_division", 422);
  const journal = b["journalCode"];
  const gl = b["bankGlAccountCode"];
  if (typeof journal !== "string" || !JOURNAL_CODE.test(journal))
    throw new ApiError("bad_journal_code");
  if (typeof gl !== "string" || !LEDGER_CODE.test(gl)) throw new ApiError("bad_gl_account");
  if (before && before.division_id !== divisionId && (await liveFor())) {
    throw new ApiError("has_live_matches", 409);
  }
  // Control accounts (M7c): optional; absent keeps the stored value, null clears it.
  const control = (key: string): { provided: 0 | 1; value: string | null } => {
    if (!(key in b)) return { provided: 0, value: null };
    const v = b[key];
    if (v === null) return { provided: 1, value: null };
    if (typeof v !== "string" || !LEDGER_CODE.test(v)) throw new ApiError("bad_gl_account");
    return { provided: 1, value: v };
  };
  const receivable = control("receivableGlAccountCode");
  const payable = control("payableGlAccountCode");
  const after = {
    division_id: divisionId,
    journal_code: journal,
    bank_gl_account_code: gl,
    ...(receivable.provided === 1 ? { receivable_gl_account_code: receivable.value } : {}),
    ...(payable.provided === 1 ? { payable_gl_account_code: payable.value } : {}),
  };
  await guardedBatch([
    auditStatement(db, {
      actorEmail: actor,
      action: before ? "matching.account_map_changed" : "matching.account_map_set",
      entity: "bank_account",
      entityId: accountId,
      before: before ?? null,
      after,
    }),
    db
      .prepare(
        `INSERT INTO bank_account_exact_map
           (bank_account_id, division_id, journal_code, bank_gl_account_code, created_by, created_at,
            updated_by, updated_at, receivable_gl_account_code, payable_gl_account_code)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, ?6, ?7, ?9)
         ON CONFLICT (bank_account_id) DO UPDATE SET division_id = excluded.division_id,
           journal_code = excluded.journal_code, bank_gl_account_code = excluded.bank_gl_account_code,
           receivable_gl_account_code = CASE WHEN ?8 = 1 THEN excluded.receivable_gl_account_code
                                             ELSE bank_account_exact_map.receivable_gl_account_code END,
           payable_gl_account_code = CASE WHEN ?10 = 1 THEN excluded.payable_gl_account_code
                                          ELSE bank_account_exact_map.payable_gl_account_code END,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(
        accountId,
        divisionId,
        journal,
        gl,
        actor,
        nowIso,
        receivable.value,
        receivable.provided,
        payable.value,
        payable.provided,
      ),
  ]);
  return json(await accountMapResponse(db));
}

// ---- patterns -----------------------------------------------------------------------------------

interface PatternSqlRow {
  id: number;
  name: string;
  ledger_account_code: string;
  counterparty_name_regex: string | null;
  reference_regex: string | null;
  type: string | null;
  direction: "in" | "out" | null;
  max_amount_minor: number | null;
  enabled: number;
  created_by: string;
  updated_at: string;
}

const PATTERN_SELECT = `SELECT ${PATTERN_COLUMNS}, created_by, updated_at FROM ledger_patterns`;

const toPatternDto = (r: PatternSqlRow): MatchPatternDto => ({
  id: r.id,
  name: safeText(r.name, 80) ?? "",
  ledgerAccountCode: r.ledger_account_code,
  counterpartyNameRegex: r.counterparty_name_regex,
  referenceRegex: r.reference_regex,
  type: r.type,
  direction: r.direction,
  maxAmountMinor: r.max_amount_minor,
  enabled: r.enabled === 1,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
});

interface PatternInput {
  name: string;
  ledgerAccountCode: string;
  counterpartyNameRegex: string | null;
  referenceRegex: string | null;
  type: string | null;
  direction: "in" | "out" | null;
  maxAmountMinor: number | null;
  enabled: boolean;
}

const PATTERN_KEYS = [
  "name",
  "ledgerAccountCode",
  "counterpartyNameRegex",
  "referenceRegex",
  "type",
  "direction",
  "maxAmountMinor",
  "enabled",
] as const;

function parsePattern(b: Record<string, unknown>): PatternInput {
  const name = textField(b["name"], 80, true, "bad_name") as string;
  const code = b["ledgerAccountCode"];
  if (typeof code !== "string" || !LEDGER_CODE.test(code)) throw new ApiError("bad_ledger_account");
  const regex = (v: unknown, field: string): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new ApiError(field);
    return v;
  };
  const type = b["type"];
  if (
    type !== undefined &&
    type !== null &&
    (typeof type !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(type))
  ) {
    throw new ApiError("bad_type");
  }
  const direction = b["direction"];
  if (direction !== undefined && direction !== null && direction !== "in" && direction !== "out") {
    throw new ApiError("bad_direction");
  }
  const max = b["maxAmountMinor"];
  if (
    max !== undefined &&
    max !== null &&
    (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1)
  ) {
    throw new ApiError("bad_max_amount");
  }
  const enabled = b["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") throw new ApiError("bad_enabled");
  const input: PatternInput = {
    name,
    ledgerAccountCode: code,
    counterpartyNameRegex: regex(b["counterpartyNameRegex"], "bad_name_regex"),
    referenceRegex: regex(b["referenceRegex"], "bad_reference_regex"),
    type: (type as string | null | undefined) ?? null,
    direction: (direction as "in" | "out" | null | undefined) ?? null,
    maxAmountMinor: (max as number | null | undefined) ?? null,
    enabled: enabled ?? true,
  };
  // The same validator the engine runs before every matching run, plus a real compile.
  const probe = toLedgerPattern({
    id: 0,
    name: input.name,
    ledger_account_code: input.ledgerAccountCode,
    counterparty_name_regex: input.counterpartyNameRegex,
    reference_regex: input.referenceRegex,
    type: input.type,
    direction: input.direction,
    max_amount_minor: input.maxAmountMinor,
    enabled: 1,
  });
  const problems = validateMatchConfig(buildMatchConfig(DEFAULT_TUNABLES, [probe], []));
  if (problems.length > 0) throw new ApiError("pattern_not_allowed", 422);
  for (const src of [input.counterpartyNameRegex, input.referenceRegex]) {
    if (src !== null && compileSafeRegex(src) === null)
      throw new ApiError("pattern_not_allowed", 422);
  }
  return input;
}

async function listPatternsHandler(ctx: Ctx): Promise<Response> {
  const rows = (await ctx.env.DB.prepare(`${PATTERN_SELECT} ORDER BY id`).all<PatternSqlRow>())
    .results;
  const body: MatchPatternsResponse = { patterns: rows.map(toPatternDto) };
  return json(body);
}

async function createPatternHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const actor = email(ctx);
  const input = parsePattern(await readBody(ctx, PATTERN_KEYS));
  const count =
    (await db.prepare("SELECT COUNT(*) AS n FROM ledger_patterns").first<{ n: number }>())?.n ?? 0;
  if (count >= MAX_PATTERNS) throw new ApiError("too_many_patterns", 422);
  const nowIso = new Date(ctx.nowMs).toISOString();
  const out = await db.batch([
    db
      .prepare(
        `INSERT INTO ledger_patterns (name, ledger_account_code, counterparty_name_regex, reference_regex,
           type, direction, max_amount_minor, enabled, created_by, created_at, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9, ?10)`,
      )
      .bind(
        input.name,
        input.ledgerAccountCode,
        input.counterpartyNameRegex,
        input.referenceRegex,
        input.type,
        input.direction,
        input.maxAmountMinor,
        input.enabled ? 1 : 0,
        actor,
        nowIso,
      ),
    auditStatement(db, {
      actorEmail: actor,
      action: "matching.pattern_created",
      entity: "ledger_pattern",
      entityId: LAST_INSERT_ID,
      after: input,
    }),
  ]);
  const id = out[0]?.meta.last_row_id as number;
  const row = (await db
    .prepare(`${PATTERN_SELECT} WHERE id = ?1`)
    .bind(id)
    .first<PatternSqlRow>()) as PatternSqlRow;
  return json({ pattern: toPatternDto(row) }, 201);
}

async function updatePatternHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const actor = email(ctx);
  const id = idParam(ctx);
  const input = parsePattern(await readBody(ctx, PATTERN_KEYS));
  const before = await db
    .prepare(`${PATTERN_SELECT} WHERE id = ?1`)
    .bind(id)
    .first<PatternSqlRow>();
  if (!before) throw new ApiError("not_found", 404);
  await db.batch([
    auditStatement(db, {
      actorEmail: actor,
      action: "matching.pattern_updated",
      entity: "ledger_pattern",
      entityId: id,
      before: toPatternDto(before),
      after: input,
    }),
    db
      .prepare(
        `UPDATE ledger_patterns SET name = ?2, ledger_account_code = ?3, counterparty_name_regex = ?4,
           reference_regex = ?5, type = ?6, direction = ?7, max_amount_minor = ?8, enabled = ?9,
           updated_by = ?10, updated_at = ?11 WHERE id = ?1`,
      )
      .bind(
        id,
        input.name,
        input.ledgerAccountCode,
        input.counterpartyNameRegex,
        input.referenceRegex,
        input.type,
        input.direction,
        input.maxAmountMinor,
        input.enabled ? 1 : 0,
        actor,
        new Date(ctx.nowMs).toISOString(),
      ),
  ]);
  const row = (await db
    .prepare(`${PATTERN_SELECT} WHERE id = ?1`)
    .bind(id)
    .first<PatternSqlRow>()) as PatternSqlRow;
  return json({ pattern: toPatternDto(row) });
}

async function deletePatternHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const id = idParam(ctx);
  const before = await db
    .prepare(`${PATTERN_SELECT} WHERE id = ?1`)
    .bind(id)
    .first<PatternSqlRow>();
  if (!before) throw new ApiError("not_found", 404);
  await db.batch([
    auditStatement(db, {
      actorEmail: email(ctx),
      action: "matching.pattern_deleted",
      entity: "ledger_pattern",
      entityId: id,
      before: toPatternDto(before),
    }),
    db.prepare("DELETE FROM ledger_patterns WHERE id = ?1").bind(id),
  ]);
  return json({ deleted: true });
}

// ---- registration -------------------------------------------------------------------------------

export function registerMatchingRoutes(router: Router): void {
  router.add("GET", "/api/matching/queue", ANY_ROLE, safely(queueHandler));
  router.add("GET", "/api/matching/auto", ANY_ROLE, safely(autoHandler));
  router.add("GET", "/api/matching/stats", ANY_ROLE, safely(statsHandler));
  router.add("GET", "/api/matching/transactions/:id", ANY_ROLE, safely(detailHandler));
  router.add("POST", "/api/matching/matches", FINANCE, safely(createMatchHandler));
  router.add("POST", "/api/matching/matches/:id/undo", FINANCE, safely(undoHandler));
  router.add("POST", "/api/matching/transactions/:id/ignore", FINANCE, safely(ignoreHandler));
  router.add("POST", "/api/matching/transactions/:id/unignore", FINANCE, safely(unignoreHandler));
  router.add(
    "POST",
    "/api/matching/transactions/:id/clear-conflict",
    ADMIN_STEP_UP,
    safely(clearConflictHandler),
  );
  router.add("POST", "/api/matching/auto/disable", ADMIN, safely(disableAutoHandler));
  router.add("GET", "/api/matching/config", ADMIN, safely(getConfigHandler));
  router.add("PUT", "/api/matching/config", ADMIN_STEP_UP, safely(putConfigHandler));
  router.add("GET", "/api/matching/account-map", ADMIN, safely(getMapHandler));
  router.add("PUT", "/api/matching/account-map", ADMIN_STEP_UP, safely(putMapHandler));
  router.add("GET", "/api/matching/patterns", ADMIN, safely(listPatternsHandler));
  router.add("POST", "/api/matching/patterns", ADMIN_STEP_UP, safely(createPatternHandler));
  router.add("PUT", "/api/matching/patterns/:id", ADMIN_STEP_UP, safely(updatePatternHandler));
  router.add("DELETE", "/api/matching/patterns/:id", ADMIN_STEP_UP, safely(deletePatternHandler));
}
