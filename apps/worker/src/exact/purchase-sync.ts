/**
 * Purchase-entry sync (Phase 4, task K4, ADR 0025): the approval status of purchase entries, for
 * the Approvals screen and Phase 9's pre-check "invoice approved in Exact". One entity,
 * `purchase_entries`, read in two ways:
 *
 *  FULL (nightly cycle, after the ledger entities)
 *    A resumable pass over the entries of the last 120 days plus everything still waiting for
 *    approval (filter in the client, `purchaseEntryFilterExpr`), ordered by Modified. The saved
 *    `$skiptoken`, the pass start (`pass_started_at`, which fixes the window for the whole pass)
 *    and the progress are written in the same D1 batch as the rows of each chunk, guarded by the
 *    sync lease, so a stop anywhere (budget, rate limit, deadline) loses nothing. Only a COMPLETE
 *    read removes rows: those in the read's scope that the pass did not see get a strike and are
 *    deleted after two complete reads in a row (one if the pass ran in a single run, or with
 *    `allowLargeClose`); the close guard of the open items applies (max(5, 20 %) at once); an
 *    answer without any row while we hold some changes nothing. Rows outside the scope (older than
 *    the window and not pending) are never removed: they just stop being refreshed.
 *
 *  INCREMENTAL (hourly, before the relations)
 *    Only entries modified since a cursor (`sync_state.cursor`, epoch milliseconds of the last
 *    Modified read; the column only holds digits), `Modified ge cursor` so ties are read again.
 *    The cursor starts when the first complete full read ends (pass start minus a safety margin)
 *    and only moves forward after the rows up to it are written. Before that the hourly run does
 *    nothing for this entity (`available` stays false). Cheap: usually one page. At most
 *    INCREMENTAL_MAX_CHUNKS chunks per run so a backlog (an import) cannot eat the hour's budget;
 *    the rest follows next hour (the result is `skipped`/`incremental_cap`, which leaves
 *    last_completed_at alone: the entity is not claimed to be current).
 *
 * The resource may not exist (module, licence) or a name may be wrong: when the first page of a
 * pass answers 400, 403 or 404 (not our own gate's 400s) the entity is marked unavailable for a
 * day (`sync_state.unavailable_until`, `last_error` = purchase_entries_unavailable_<status>) and
 * the API answers `available: false`. A manual full sync with `restart` tries again at once.
 *
 * All Exact names, the filter, `$orderby=Modified` and the Status mapping are UNVERIFIED (ADR 0025).
 */
import { ExactApiError } from "@camelthorn/exact";
import type { ExactClient, ListChunk, PurchaseEntry } from "@camelthorn/exact";
import {
  amsterdamDate,
  amsterdamParts,
  approvalStatusFromCode,
  pendingStatusCodes,
  purchaseWindowStart,
  searchText,
} from "@camelthorn/core";
import type { EntityResult, SyncMode } from "./sync";
import { GATE_REJECT_CODES } from "./ledger-sync";
import { type Lease, type SubrequestMeter, closeAllowed, leaseHeld, runBatches } from "./sync-util";

export const PURCHASE_ENTITY = "purchase_entries" as const;

/** How long the entity is left alone after Exact refused the resource. */
export const PURCHASE_UNAVAILABLE_MS = 24 * 60 * 60 * 1000;
export const PURCHASE_UNAVAILABLE_STATUSES: readonly number[] = [400, 403, 404];
/** Chunks (of `chunkPages` pages) an INCREMENTAL run may read: 2 x 5 = 10 of the hour's 40 calls. */
export const INCREMENTAL_MAX_CHUNKS = 2;
const MAX_CHUNKS = 200;
/** The cursor starts this far before the pass that created it (clock skew, rows written meanwhile). */
export const CURSOR_MARGIN_MS = 10 * 60 * 1000;

/** The part of sync_state the entity reads. */
export interface PurchaseStateRow {
  cursor: string;
  pass_cycle: number | null;
  pass_token: string | null;
  pass_rows: number;
  unavailable_until: string | null;
  pass_seq: number | null;
  pass_started_at: string | null;
}

export interface PurchaseCtx {
  db: D1Database;
  client: ExactClient;
  division: { id: number };
  mode: SyncMode;
  restart: boolean;
  runSeq: number;
  lease: Lease;
  cycle: number | null;
  startedAt: string;
  nowIso: () => string;
  nowMs: () => number;
  chunkPages: number;
  state: Map<string, PurchaseStateRow>;
  pastDeadline: () => boolean;
  progress: number;
  pass: { read: number; total: number | null } | null;
  meter: SubrequestMeter;
  allowLargeClose: boolean;
}

const clip = (v: string | null, n: number): string | null => (v === null ? null : v.slice(0, n));

function entryStmt(ctx: PurchaseCtx, e: PurchaseEntry, nowIso: string): D1PreparedStatement {
  const status = approvalStatusFromCode(e.statusCode);
  const dc = e.amountDc;
  return ctx.db
    .prepare(
      `INSERT INTO purchase_entries (division_id, exact_id, entry_number, relation_id,
         relation_name, currency, amount_minor, amount_dc_minor, dc_currency, entry_date, due_date,
         status_code, status, submitted_at, modified_at, has_pdf, search_text, synced_at,
         last_seen_sync_id, missed_cycles)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
         ?19, 0)
       ON CONFLICT (division_id, exact_id) DO UPDATE SET
         entry_number = excluded.entry_number, relation_id = excluded.relation_id,
         relation_name = excluded.relation_name, currency = excluded.currency,
         amount_minor = excluded.amount_minor, amount_dc_minor = excluded.amount_dc_minor,
         dc_currency = excluded.dc_currency, entry_date = excluded.entry_date,
         due_date = excluded.due_date, status_code = excluded.status_code,
         status = excluded.status, submitted_at = excluded.submitted_at,
         modified_at = excluded.modified_at, has_pdf = excluded.has_pdf,
         search_text = excluded.search_text, synced_at = excluded.synced_at,
         last_seen_sync_id = excluded.last_seen_sync_id, missed_cycles = 0
       WHERE excluded.last_seen_sync_id >= COALESCE(purchase_entries.last_seen_sync_id, 0)`,
    )
    .bind(
      ctx.division.id,
      e.id,
      e.entryNumber,
      e.supplierId,
      clip(e.supplierName, 200),
      e.amount.currency,
      e.amount.minor,
      dc === null ? null : dc.minor,
      dc === null ? null : dc.currency,
      amsterdamDate(e.entryDate),
      amsterdamDate(e.dueDate),
      e.statusCode,
      status,
      e.created,
      e.modified,
      e.hasDocument === null ? null : e.hasDocument ? 1 : 0,
      searchText([e.entryNumber, e.supplierName]),
      nowIso,
      ctx.runSeq,
    );
}

/** Saves a resumable FULL pass (same batch as the rows it covers); only while the lease is held. */
function passStmt(
  ctx: PurchaseCtx,
  token: string | null,
  rows: number,
  pass: { seq: number; startedAt: string },
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO sync_state (division_id, entity, mode, last_started_at, last_status,
         pass_cycle, pass_token, pass_rows, pass_total, pass_seq, pass_started_at)
       SELECT ?1, '${PURCHASE_ENTITY}', 'full', ?2, 'partial', ?3, ?4, ?5, NULL, ?8, ?9
       WHERE ${leaseHeld("?6", "?7")}
       ON CONFLICT (division_id, entity) DO UPDATE SET
         pass_cycle = excluded.pass_cycle, pass_token = excluded.pass_token,
         pass_rows = excluded.pass_rows, pass_total = NULL, pass_seq = excluded.pass_seq,
         pass_started_at = excluded.pass_started_at
       WHERE ${leaseHeld("?6", "?7")}`,
    )
    .bind(
      ctx.division.id,
      ctx.startedAt,
      ctx.cycle,
      token,
      rows,
      ctx.lease.holder,
      ctx.lease.runSeq,
      pass.seq,
      pass.startedAt,
    );
}

/** Moves the incremental cursor forward (never back), under the lease. */
function cursorStmt(ctx: PurchaseCtx, cursorMs: number): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO sync_state (division_id, entity, cursor, mode, last_started_at, last_status)
       SELECT ?1, '${PURCHASE_ENTITY}', ?2, 'incremental', ?3, 'partial'
       WHERE ${leaseHeld("?4", "?5")}
       ON CONFLICT (division_id, entity) DO UPDATE SET
         cursor = CASE WHEN CAST(excluded.cursor AS INTEGER) > CAST(sync_state.cursor AS INTEGER)
                       THEN excluded.cursor ELSE sync_state.cursor END
       WHERE ${leaseHeld("?4", "?5")}`,
    )
    .bind(ctx.division.id, String(cursorMs), ctx.startedAt, ctx.lease.holder, ctx.lease.runSeq);
}

/** Largest Modified (ms) of a chunk, or null unless the chunk is in ascending order (fail-safe). */
function chunkCursor(items: readonly PurchaseEntry[]): number | null {
  let prev = -Infinity;
  for (const it of items) {
    if (it.modified === null) return null;
    const t = Date.parse(it.modified);
    if (Number.isNaN(t) || t < prev) return null;
    prev = t;
  }
  return prev === -Infinity ? null : prev;
}

async function markUnavailable(ctx: PurchaseCtx, e: unknown): Promise<string | null> {
  // Only Exact's own refusal counts: a 5xx, a network failure or our gate rejecting the request
  // is an ordinary failure and must not hide the approvals for a day.
  if (
    !(e instanceof ExactApiError) ||
    !PURCHASE_UNAVAILABLE_STATUSES.includes(e.status) ||
    (e.code !== undefined && GATE_REJECT_CODES.has(e.code))
  ) {
    return null;
  }
  const code = `purchase_entries_unavailable_${e.status}`;
  await runBatches(ctx.db, ctx.meter, [
    [
      ctx.db
        .prepare(
          `INSERT INTO sync_state (division_id, entity, mode, last_started_at, last_error,
             unavailable_until)
           SELECT ?1, '${PURCHASE_ENTITY}', ?7, ?2, ?3, ?4 WHERE ${leaseHeld("?5", "?6")}
           ON CONFLICT (division_id, entity) DO UPDATE SET
             last_error = excluded.last_error, unavailable_until = excluded.unavailable_until,
             pass_token = NULL, pass_rows = 0
           WHERE ${leaseHeld("?5", "?6")}`,
        )
        .bind(
          ctx.division.id,
          ctx.startedAt,
          code,
          new Date(ctx.nowMs() + PURCHASE_UNAVAILABLE_MS).toISOString(),
          ctx.lease.holder,
          ctx.lease.runSeq,
          ctx.mode,
        ),
    ],
  ]);
  return code;
}

// ---------------------------------------------------------------------------------------------

export async function syncPurchaseEntries(ctx: PurchaseCtx): Promise<EntityResult> {
  const st = ctx.state.get(PURCHASE_ENTITY);
  const full = ctx.mode === "full";
  const nowMs = ctx.nowMs();
  if (!ctx.restart && st?.unavailable_until != null && Date.parse(st.unavailable_until) > nowMs) {
    return {
      status: "skipped",
      rows: 0,
      calls: 0,
      error: "purchase_entries_unavailable",
      cycleDone: full,
    };
  }
  return full ? syncFull(ctx, st) : syncIncremental(ctx, st);
}

async function syncFull(ctx: PurchaseCtx, st: PurchaseStateRow | undefined): Promise<EntityResult> {
  const cycle = ctx.cycle as number;
  const resuming =
    !ctx.restart &&
    st?.pass_cycle === cycle &&
    st.pass_seq != null &&
    st.pass_started_at != null &&
    !Number.isNaN(Date.parse(st.pass_started_at)) &&
    st.pass_token !== null &&
    st.pass_token !== "";
  const pass = resuming
    ? {
        seq: st?.pass_seq as number,
        startedAt: st?.pass_started_at as string,
        token: st?.pass_token as string,
        readBefore: st?.pass_rows ?? 0,
      }
    : { seq: ctx.runSeq, startedAt: ctx.startedAt, token: null as string | null, readBefore: 0 };
  // The window is fixed by the pass start, so a saved $skiptoken is always used with the filter
  // it was issued for.
  const windowDate = purchaseWindowStart(amsterdamParts(Date.parse(pass.startedAt)).date);
  const fromIso = `${windowDate}T00:00:00.000Z`;
  const filter = {
    kind: "window" as const,
    fromIso,
    pendingStatusCodes: pendingStatusCodes(),
  };

  let token = pass.token;
  let readTotal = pass.readBefore;
  let rows = 0;
  ctx.pass = { read: readTotal, total: null };
  const nowIso = ctx.nowIso();
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    if (ctx.pastDeadline()) {
      return { status: "partial", rows, calls: 0, error: "time_limit", progress: ctx.pass };
    }
    let page: ListChunk<PurchaseEntry>;
    try {
      page = await ctx.client.listPurchaseEntriesChunk(token, {
        filter,
        maxPages: ctx.chunkPages,
      });
    } catch (e) {
      if (token === null && chunk === 0) {
        const code = await markUnavailable(ctx, e);
        if (code !== null) {
          return { status: "skipped", rows: 0, calls: 0, error: code, cycleDone: true };
        }
      }
      throw e;
    }
    readTotal += page.items.length;
    const units: D1PreparedStatement[][] = page.items.map((it) => [entryStmt(ctx, it, nowIso)]);
    units.push([passStmt(ctx, page.nextToken, readTotal, pass)]);
    await runBatches(ctx.db, ctx.meter, units);
    rows += page.items.length;
    ctx.progress = rows;
    ctx.pass = { read: readTotal, total: null };
    if (page.error !== undefined) throw page.error;
    if (page.complete) {
      return finishFull(ctx, {
        readTotal,
        singleRun: !resuming,
        seq: pass.seq,
        startedAt: pass.startedAt,
        windowDate,
        fromIso,
        rows,
      });
    }
    token = page.nextToken;
  }
  return { status: "partial", rows, calls: 0, error: "chunk_limit", progress: ctx.pass };
}

async function finishFull(
  ctx: PurchaseCtx,
  p: {
    readTotal: number;
    singleRun: boolean;
    seq: number;
    startedAt: string;
    windowDate: string;
    fromIso: string;
    rows: number;
  },
): Promise<EntityResult> {
  // Rows the read WOULD have returned: the same three conditions as the filter. Only those can be
  // judged "gone from Exact"; the rest simply stopped being refreshed.
  const scope = `division_id = ?1 AND (entry_date >= ?2 OR modified_at >= ?3 OR status = 'pending_approval')`;
  ctx.meter.used += 1;
  const counts = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS held,
              COALESCE(SUM(CASE WHEN COALESCE(last_seen_sync_id, 0) < ?4 THEN 1 ELSE 0 END), 0)
                AS stale
       FROM purchase_entries WHERE ${scope}`,
    )
    .bind(ctx.division.id, p.windowDate, p.fromIso, p.seq)
    .first<{ held: number; stale: number }>();
  const held = counts?.held ?? 0;
  const stale = counts?.stale ?? 0;
  const done = (error?: string): EntityResult => ({
    status: "ok",
    rows: p.rows,
    calls: 0,
    cycleDone: true,
    ...(error !== undefined ? { error } : {}),
  });
  // Nothing at all while we hold rows is far more likely a fault (filter, licence) than "every
  // entry was deleted": change nothing and do not start the incremental cursor.
  if (p.readTotal === 0 && held > 0) return done("empty_answer_ignored");
  if (stale > 0 && !ctx.allowLargeClose && !closeAllowed(stale, held)) {
    return {
      status: "error",
      rows: p.rows,
      calls: 0,
      error: "close_guard",
      cycleDone: false,
    };
  }
  const need = p.singleRun || ctx.allowLargeClose ? 1 : 2;
  const startMs = Date.parse(p.startedAt);
  const cursorMs = Math.max(0, startMs - CURSOR_MARGIN_MS);
  const strike = ctx.db
    .prepare(
      `UPDATE purchase_entries SET missed_cycles = missed_cycles + 1
       WHERE ${scope} AND COALESCE(last_seen_sync_id, 0) < ?4 AND ${leaseHeld("?5", "?6")}`,
    )
    .bind(ctx.division.id, p.windowDate, p.fromIso, p.seq, ctx.lease.holder, ctx.lease.runSeq);
  const prune = ctx.db
    .prepare(
      `DELETE FROM purchase_entries
       WHERE ${scope} AND COALESCE(last_seen_sync_id, 0) < ?4 AND missed_cycles >= ?7
         AND ${leaseHeld("?5", "?6")}`,
    )
    .bind(
      ctx.division.id,
      p.windowDate,
      p.fromIso,
      p.seq,
      ctx.lease.holder,
      ctx.lease.runSeq,
      need,
    );
  // The incremental cursor starts here (or restarts after an explicit `restart`); an existing one
  // is kept: the hourly reads have kept it continuous since the first complete pass.
  const cursor = ctx.db
    .prepare(
      `UPDATE sync_state SET
         cursor = CASE WHEN ?2 = 1 OR cursor = '0' THEN ?3 ELSE cursor END,
         unavailable_until = NULL
       WHERE division_id = ?1 AND entity = '${PURCHASE_ENTITY}' AND ${leaseHeld("?4", "?5")}`,
    )
    .bind(
      ctx.division.id,
      ctx.restart ? 1 : 0,
      String(cursorMs),
      ctx.lease.holder,
      ctx.lease.runSeq,
    );
  await runBatches(ctx.db, ctx.meter, [[strike, prune, cursor]]);
  return done();
}

async function syncIncremental(
  ctx: PurchaseCtx,
  st: PurchaseStateRow | undefined,
): Promise<EntityResult> {
  const cursorMs = st === undefined ? 0 : Number(st.cursor);
  if (!Number.isSafeInteger(cursorMs) || cursorMs <= 0) {
    // No complete full read yet: nothing to continue from. Left to the nightly pass.
    return { status: "skipped", rows: 0, calls: 0, error: "no_cursor" };
  }
  // The filter stays the same for the whole run: a $skiptoken is only valid with the filter that
  // issued it. The saved cursor moves on after every chunk, for the next run.
  const sinceIso = new Date(cursorMs).toISOString();
  let token: string | null = null;
  let rows = 0;
  const nowIso = ctx.nowIso();
  for (let chunk = 0; chunk < INCREMENTAL_MAX_CHUNKS; chunk++) {
    if (ctx.pastDeadline()) {
      return { status: "partial", rows, calls: 0, error: "time_limit" };
    }
    let page: ListChunk<PurchaseEntry>;
    try {
      page = await ctx.client.listPurchaseEntriesChunk(token, {
        filter: { kind: "modified", sinceIso },
        maxPages: ctx.chunkPages,
      });
    } catch (e) {
      if (token === null && chunk === 0) {
        const code = await markUnavailable(ctx, e);
        if (code !== null) return { status: "skipped", rows: 0, calls: 0, error: code };
      }
      throw e;
    }
    const units: D1PreparedStatement[][] = page.items.map((it) => [entryStmt(ctx, it, nowIso)]);
    const advance = chunkCursor(page.items);
    // Without a $skiptoken to continue in this run, the next run restarts from the cursor; with
    // one, the cursor is only the safe floor (every row up to it is written).
    if (advance !== null) units.push([cursorStmt(ctx, advance)]);
    await runBatches(ctx.db, ctx.meter, units);
    rows += page.items.length;
    ctx.progress = rows;
    ctx.pass = { read: rows, total: null };
    if (page.error !== undefined) throw page.error;
    if (page.complete) return { status: "ok", rows, calls: 0 };
    token = page.nextToken;
  }
  // Backlog: the cursor is saved, the rest follows next hour. Not "ok": freshness must not claim
  // the entity is current.
  return { status: "skipped", rows, calls: 0, error: "incremental_cap" };
}
