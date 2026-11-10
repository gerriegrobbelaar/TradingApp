/**
 * Exact -> D1 sync for one division (Phase 2, task E3). See ADR 0017 for the assumptions.
 *
 * Entities, in order: divisions, relations (accounts via the Timestamp sync endpoint), bank_accounts
 * (IBANs of those relations), receivables, payables.
 *
 *  - Everything goes through the division's ExactGate with priority 'job' and a call budget
 *    (startJob ... endJob in a finally).
 *  - FULL mode reads open receivables/payables completely and, only after that read finished and
 *    was written, closes the items it did not see (rows carry last_seen_sync_id). A partial or
 *    failed read never closes anything. Relations restart from Timestamp 0 unless a previous FULL
 *    pass is half done, in which case it resumes from its saved cursor.
 *  - INCREMENTAL mode continues every entity from its saved Timestamp cursor and never closes by
 *    absence (it only sees changes). A zero open amount closes the item.
 *  - Budget, rate limit, time limit: save progress, finish as 'partial', the next run resumes.
 *    Auth failure: record 'needs_reauth' and stop (no retry loop).
 *  - One audit row per run, written in the same D1 batch as the final state (ADR 0013). IBAN
 *    changes get their own audit row (masked) because the four-eyes check reads them.
 *  - Re-runnable: rows are upserted on (division_id, exact_id). Two runs for one division never
 *    overlap (sync_locks lease).
 */
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  createExactClient,
  type ExactAccount,
  type ExactClient,
  type ExactTransport,
  type OpenItem,
} from "@camelthorn/exact";
import { auditStatement } from "../db/audit";
import type { Env } from "../env";
import { createGateTransport, gateName } from "./gate-transport";
import { amsterdamDate } from "./local-time";

export type SyncMode = "full" | "incremental";
export type RunStatus = "ok" | "partial" | "error" | "needs_reauth";
export type EntityName = "divisions" | "relations" | "bank_accounts" | "receivables" | "payables";
export const ENTITIES: readonly EntityName[] = [
  "divisions",
  "relations",
  "bank_accounts",
  "receivables",
  "payables",
];

export const DEFAULT_SYNC_BUDGET = 300;
/** Pages read per chunk of a cursor-based read; progress is saved after every chunk. */
export const DEFAULT_CHUNK_PAGES = 5;
const MAX_CHUNKS = 200;
const BATCH_LIMIT = 100;
const LEASE_MS = 15 * 60 * 1000;

export interface DivisionRef {
  /** divisions.id */
  id: number;
  connectionId: number;
  /** The Exact division number. */
  exactDivision: number;
}

export interface SyncOptions {
  jobId: string;
  mode: SyncMode;
  /** Exact calls this run may spend (gate job budget). */
  budget?: number;
  /** Audit actor: the user's email for manual runs, `system` otherwise. */
  actor?: string;
  chunkPages?: number;
  /** Epoch ms after which the run stops between steps and finishes as partial. */
  deadlineMs?: number;
}

export interface JobGate {
  startJob(jobId: string, budget?: number): Promise<unknown>;
  endJob(jobId: string): Promise<{ used: number }>;
}

/** Test seams. Production uses the division's ExactGate for everything. */
export interface SyncDeps {
  gate?: JobGate;
  transport?: ExactTransport;
  now?: () => number;
}

export interface EntityResult {
  status: RunStatus | "skipped";
  rows: number;
  calls: number;
  error?: string;
  /** True when a FULL read of the whole entity finished and was written. */
  completeRead?: boolean;
  /** Closed by this run (full mode only). */
  closed?: number;
}

export interface SyncSummary {
  status: RunStatus | "locked";
  mode: SyncMode;
  divisionId: number;
  runSeq: number | null;
  callsUsed: number;
  startedAt: string;
  finishedAt: string;
  entities: Record<EntityName, EntityResult>;
}

// ---------------------------------------------------------------------------------------------

interface StateRow {
  entity: string;
  cursor: string;
  mode: SyncMode | null;
  last_status: string | null;
  last_completed_at: string | null;
}

type Failure = { kind: "stop" | "continue"; status: RunStatus; code: string };

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,60}$/;
const safeCode = (c: string | undefined, fallback: string): string =>
  c !== undefined && SAFE_CODE.test(c) ? c : fallback;

function classify(e: unknown): Failure {
  if (e instanceof ExactBudgetExhaustedError) {
    return { kind: "stop", status: "partial", code: "budget_exhausted" };
  }
  if (e instanceof ExactRateLimitedError) {
    return { kind: "stop", status: "partial", code: "rate_limited" };
  }
  if (e instanceof ExactAuthError) {
    return { kind: "stop", status: "needs_reauth", code: safeCode(e.message, "auth_failed") };
  }
  if (e instanceof ExactApiError) {
    return { kind: "continue", status: "error", code: safeCode(e.code, `http_${e.status}`) };
  }
  // A D1 or programming error. Name only: messages can carry row data.
  console.error("exact sync failed", e instanceof Error ? e.name : "unknown");
  return { kind: "stop", status: "error", code: "internal_error" };
}

const iso = (ms: number): string => new Date(ms).toISOString();

async function runBatches(db: D1Database, units: D1PreparedStatement[][]): Promise<void> {
  // Units (for example change + its audit row) are never split across batches.
  let cur: D1PreparedStatement[] = [];
  for (const unit of units) {
    if (cur.length > 0 && cur.length + unit.length > BATCH_LIMIT) {
      await db.batch(cur);
      cur = [];
    }
    cur.push(...unit);
  }
  if (cur.length > 0) await db.batch(cur);
}

function defaultGate(env: Env, exactDivision: number): JobGate {
  const stub = env.EXACT_GATE.get(env.EXACT_GATE.idFromName(gateName(exactDivision)));
  return {
    startJob: (id, budget) => stub.startJob(id, budget),
    endJob: (id) => stub.endJob(id),
  };
}

// ---------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------

const cursorStmt = (
  db: D1Database,
  divisionId: number,
  entity: EntityName,
  cursor: string,
  mode: SyncMode,
  status: "partial" | "ok",
  startedAt: string,
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO sync_state (division_id, entity, cursor, mode, last_started_at, last_status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (division_id, entity) DO UPDATE SET
         cursor = excluded.cursor, mode = excluded.mode, last_status = excluded.last_status,
         last_started_at = excluded.last_started_at`,
    )
    .bind(divisionId, entity, cursor, mode, startedAt, status);

function relationStmt(
  db: D1Database,
  divisionId: number,
  a: ExactAccount,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO relations (division_id, exact_id, code, name, is_supplier, is_customer, email,
         vat_number, country, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (division_id, exact_id) DO UPDATE SET
         code = excluded.code, name = excluded.name, is_supplier = excluded.is_supplier,
         is_customer = excluded.is_customer, email = excluded.email,
         vat_number = excluded.vat_number, country = excluded.country,
         updated_at = excluded.updated_at`,
    )
    .bind(
      divisionId,
      a.id.toLowerCase(),
      a.code,
      a.name,
      a.isSupplier ? 1 : 0,
      a.isSales ? 1 : 0,
      a.email,
      a.vatNumber,
      a.country,
      nowIso,
    );
}

function openItemStmt(
  db: D1Database,
  divisionId: number,
  item: OpenItem,
  runSeq: number,
  nowIso: string,
): D1PreparedStatement {
  const closed = item.amount.minor === 0;
  return db
    .prepare(
      `INSERT INTO open_items (division_id, exact_id, kind, relation_id, relation_name,
         invoice_number, reference, currency, amount_minor, open_minor, invoice_date, due_date,
         status, closed_at, synced_at, entry_number, last_seen_sync_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT (division_id, exact_id) DO UPDATE SET
         kind = excluded.kind, relation_id = excluded.relation_id,
         relation_name = excluded.relation_name, invoice_number = excluded.invoice_number,
         reference = excluded.reference, currency = excluded.currency,
         amount_minor = excluded.amount_minor, open_minor = excluded.open_minor,
         invoice_date = excluded.invoice_date, due_date = excluded.due_date,
         status = excluded.status,
         closed_at = CASE WHEN excluded.status = 'closed'
                          THEN COALESCE(open_items.closed_at, excluded.closed_at) ELSE NULL END,
         synced_at = excluded.synced_at, entry_number = excluded.entry_number,
         last_seen_sync_id = excluded.last_seen_sync_id`,
    )
    .bind(
      divisionId,
      item.id.toLowerCase(),
      item.kind === "receivable" ? "invoice" : "bill",
      item.accountId.toLowerCase(),
      item.accountName,
      item.invoiceNumber === null ? null : String(item.invoiceNumber),
      item.description,
      item.amount.currency,
      item.amount.minor,
      amsterdamDate(item.invoiceDate),
      amsterdamDate(item.dueDate),
      closed ? "closed" : "open",
      closed ? nowIso : null,
      nowIso,
      item.entryNumber,
      runSeq,
    );
}

function stateStmt(
  db: D1Database,
  divisionId: number,
  entity: EntityName | "run",
  mode: SyncMode,
  startedAt: string,
  finishedAt: string,
  status: RunStatus | "running",
  error: string | null,
  rows: number,
  calls: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sync_state (division_id, entity, mode, last_started_at, last_finished_at,
         last_completed_at, last_full_completed_at, last_status, last_error, rows_seen, calls_used)
       VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?6 = 'ok' THEN ?5 ELSE NULL END,
         CASE WHEN ?6 = 'ok' AND ?3 = 'full' THEN ?5 ELSE NULL END, ?6, ?7, ?8, ?9)
       ON CONFLICT (division_id, entity) DO UPDATE SET
         mode = excluded.mode, last_started_at = excluded.last_started_at,
         last_finished_at = excluded.last_finished_at,
         last_completed_at = CASE WHEN excluded.last_status = 'ok' THEN excluded.last_finished_at
                                  ELSE sync_state.last_completed_at END,
         last_full_completed_at = CASE WHEN excluded.last_status = 'ok' AND excluded.mode = 'full'
                                       THEN excluded.last_finished_at
                                       ELSE sync_state.last_full_completed_at END,
         last_status = excluded.last_status, last_error = excluded.last_error,
         rows_seen = excluded.rows_seen, calls_used = excluded.calls_used`,
    )
    .bind(divisionId, entity, mode, startedAt, finishedAt, status, error, rows, calls);
}

// ---------------------------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------------------------

/**
 * Atomic lease: the upsert only takes over a row whose lease has expired, so of two concurrent
 * callers exactly one gets a row back. Returns the new run sequence number, or null if locked.
 * Chosen over a Durable Object because the sync state is in D1 anyway, the lease expires by
 * itself after a crash and needs no alarm, and one statement is race-free in D1.
 */
export async function acquireSyncLock(
  db: D1Database,
  divisionId: number,
  holder: string,
  nowMs: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO sync_locks (division_id, holder, expires_at, run_seq) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (division_id) DO UPDATE SET
         holder = excluded.holder, expires_at = excluded.expires_at,
         run_seq = sync_locks.run_seq + 1
       WHERE sync_locks.expires_at <= ?4
       RETURNING run_seq`,
    )
    .bind(divisionId, holder, iso(nowMs + LEASE_MS), iso(nowMs))
    .first<{ run_seq: number }>();
  return row?.run_seq ?? null;
}

export async function releaseSyncLock(
  db: D1Database,
  divisionId: number,
  holder: string,
): Promise<void> {
  await db
    .prepare("UPDATE sync_locks SET expires_at = ?3 WHERE division_id = ?1 AND holder = ?2")
    .bind(divisionId, holder, "1970-01-01T00:00:00.000Z")
    .run();
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

const emptyResult = (): EntityResult => ({ status: "skipped", rows: 0, calls: 0 });

export async function syncDivision(
  env: Env,
  division: DivisionRef,
  opts: SyncOptions,
  deps: SyncDeps = {},
): Promise<SyncSummary> {
  const db = env.DB;
  const now = deps.now ?? Date.now;
  const actor = opts.actor ?? "system";
  const chunkPages = opts.chunkPages ?? DEFAULT_CHUNK_PAGES;
  const startedAt = iso(now());
  const entities = Object.fromEntries(ENTITIES.map((e) => [e, emptyResult()])) as Record<
    EntityName,
    EntityResult
  >;
  const holder = crypto.randomUUID();
  const runSeq = await acquireSyncLock(db, division.id, holder, now());
  if (runSeq === null) {
    return {
      status: "locked",
      mode: opts.mode,
      divisionId: division.id,
      runSeq: null,
      callsUsed: 0,
      startedAt,
      finishedAt: startedAt,
      entities,
    };
  }

  let callsUsed = 0;
  try {
    const gate = deps.gate ?? defaultGate(env, division.exactDivision);
    const baseTransport = deps.transport ?? createGateTransport(env, division.exactDivision);
    let current: EntityName = "divisions";
    const tally = new Map<EntityName, number>();
    const transport: ExactTransport = (req) => {
      tally.set(current, (tally.get(current) ?? 0) + 1);
      return baseTransport(req);
    };
    const client = createExactClient(transport, {
      division: division.exactDivision,
      jobId: opts.jobId,
      priority: "job",
    });

    await stateStmt(db, division.id, "run", opts.mode, startedAt, startedAt, "running", null, 0, 0)
      .run()
      .catch(() => undefined);

    const stateRows = await db
      .prepare(
        "SELECT entity, cursor, mode, last_status, last_completed_at FROM sync_state WHERE division_id = ?1",
      )
      .bind(division.id)
      .all<StateRow>();
    const state = new Map(stateRows.results.map((r) => [r.entity, r]));

    let fatal: Failure | null = null;
    let stopFailure: Failure | null = null;
    let started = false;
    try {
      try {
        await gate.startJob(opts.jobId, opts.budget ?? DEFAULT_SYNC_BUDGET);
        started = true;
      } catch {
        fatal = { kind: "stop", status: "error", code: "gate_unavailable" };
      }

      const ctx: Ctx = {
        db,
        client,
        division,
        mode: opts.mode,
        runSeq,
        startedAt,
        nowIso: () => iso(now()),
        actor,
        chunkPages,
        state,
        deadlineMs: opts.deadlineMs,
        now,
        progress: 0,
      };

      for (const entity of ENTITIES) {
        if (fatal !== null) break;
        current = entity;
        ctx.progress = 0;
        let result: EntityResult;
        let failure: Failure | null = null;
        if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
          failure = { kind: "stop", status: "partial", code: "time_limit" };
          result = { status: "partial", rows: 0, calls: 0, error: failure.code };
        } else {
          try {
            result = await runEntity(ctx, entity);
          } catch (e) {
            failure = classify(e);
            result = { status: failure.status, rows: ctx.progress, calls: 0, error: failure.code };
          }
          const partialCode = result.status === "partial" ? result.error : undefined;
          if (failure === null && partialCode !== undefined) {
            failure = { kind: "stop", status: "partial", code: partialCode };
          }
        }
        result.calls = tally.get(entity) ?? 0;
        entities[entity] = result;
        if (failure?.kind === "stop") {
          stopFailure = failure;
          break;
        }
      }
    } finally {
      if (started) {
        try {
          callsUsed = (await gate.endJob(opts.jobId)).used;
        } catch {
          // The job record is purged by the gate after 24 hours; nothing else to do.
        }
      }
    }

    // Overall status: a fatal start failure, then needs_reauth, then the failure that stopped the
    // run (partial for budget, rate limit or time; error for an internal failure), then any
    // entity error, else ok.
    const results = ENTITIES.map((e) => entities[e]);
    let status: RunStatus = "ok";
    if (fatal !== null) status = fatal.status;
    else if (results.some((r) => r.status === "needs_reauth")) status = "needs_reauth";
    else if (stopFailure !== null) status = stopFailure.status;
    else if (results.some((r) => r.status === "error")) status = "error";
    const runError =
      fatal?.code ??
      results.find((r) => r.status !== "ok" && r.status !== "skipped" && r.error !== undefined)
        ?.error ??
      null;

    const finishedAt = iso(now());
    const rowsTotal = results.reduce((n, r) => n + r.rows, 0);
    const statements: D1PreparedStatement[] = [];
    const closing: EntityName[] = [];
    for (const [entity, kind] of [
      ["receivables", "invoice"],
      ["payables", "bill"],
    ] as const) {
      const r = entities[entity];
      if (opts.mode === "full" && r.status === "ok" && r.completeRead === true) {
        closing.push(entity);
        statements.push(
          db
            .prepare(
              `UPDATE open_items SET status = 'closed', open_minor = 0, closed_at = ?4
               WHERE division_id = ?1 AND kind = ?2 AND status = 'open'
                 AND COALESCE(last_seen_sync_id, -1) <> ?3`,
            )
            .bind(division.id, kind, runSeq, finishedAt),
        );
      }
    }
    for (const entity of ENTITIES) {
      const r = entities[entity];
      if (r.status === "skipped") continue;
      statements.push(
        stateStmt(
          db,
          division.id,
          entity,
          opts.mode,
          startedAt,
          finishedAt,
          r.status,
          r.error ?? null,
          r.rows,
          r.calls,
        ),
      );
    }
    statements.push(
      stateStmt(
        db,
        division.id,
        "run",
        opts.mode,
        startedAt,
        finishedAt,
        status,
        runError,
        rowsTotal,
        callsUsed,
      ),
      auditStatement(db, {
        actorEmail: actor,
        action: "exact.sync",
        entity: "division",
        entityId: division.id,
        after: {
          mode: opts.mode,
          status,
          error: runError,
          callsUsed,
          entities: Object.fromEntries(
            ENTITIES.map((e) => [
              e,
              {
                status: entities[e].status,
                rows: entities[e].rows,
                calls: entities[e].calls,
                ...(entities[e].error !== undefined ? { error: entities[e].error } : {}),
              },
            ]),
          ),
        },
      }),
    );
    const results2 = await db.batch(statements);
    // The close statements come first; report how many items each one closed.
    closing.forEach((entity, i) => {
      entities[entity].closed = results2[i]?.meta.changes ?? 0;
    });
    return {
      status,
      mode: opts.mode,
      divisionId: division.id,
      runSeq,
      callsUsed,
      startedAt,
      finishedAt,
      entities,
    };
  } finally {
    await releaseSyncLock(db, division.id, holder).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

interface Ctx {
  db: D1Database;
  client: ExactClient;
  division: DivisionRef;
  mode: SyncMode;
  runSeq: number;
  startedAt: string;
  nowIso: () => string;
  actor: string;
  chunkPages: number;
  state: Map<string, StateRow>;
  deadlineMs: number | undefined;
  now: () => number;
  /** Rows written so far for the entity being synced (kept when a later chunk fails). */
  progress: number;
}

function runEntity(ctx: Ctx, entity: EntityName): Promise<EntityResult> {
  switch (entity) {
    case "divisions":
      return syncDivisions(ctx);
    case "relations":
      return syncRelations(ctx);
    case "bank_accounts":
      return syncIbans(ctx);
    case "receivables":
      return syncOpenItems(ctx, "receivables");
    case "payables":
      return syncOpenItems(ctx, "payables");
  }
}

async function syncDivisions(ctx: Ctx): Promise<EntityResult> {
  const { db, division } = ctx;
  const list = await ctx.client.listDivisions();
  const units = list.map((d) => {
    const name = d.description ?? "";
    const stmt =
      name !== ""
        ? db
            .prepare(
              `INSERT INTO divisions (connection_id, exact_division, name) VALUES (?1, ?2, ?3)
               ON CONFLICT (connection_id, exact_division) DO UPDATE SET name = excluded.name`,
            )
            .bind(division.connectionId, d.code, name.slice(0, 200))
        : db
            .prepare(
              `INSERT INTO divisions (connection_id, exact_division, name) VALUES (?1, ?2, ?3)
               ON CONFLICT (connection_id, exact_division) DO NOTHING`,
            )
            .bind(division.connectionId, d.code, `Division ${d.code}`);
    return [stmt];
  });
  await runBatches(db, units);
  return { status: "ok", rows: list.length, calls: 0 };
}

/** Where a cursor-based read starts: see the header comment. */
function startCursor(ctx: Ctx, entity: EntityName): string {
  const st = ctx.state.get(entity);
  if (!st) return "0";
  if (ctx.mode === "incremental") return st.cursor;
  return st.last_status === "partial" && st.mode === "full" ? st.cursor : "0";
}

/**
 * Reads a Timestamp-cursor endpoint in chunks of `chunkPages` pages. After every chunk the rows
 * are written and the cursor saved, so a stop (budget, rate limit, time) loses at most one chunk.
 */
async function cursorLoop<T>(
  ctx: Ctx,
  entity: EntityName,
  read: (
    cursor: string,
    maxPages: number,
  ) => Promise<{ items: T[]; nextCursor: string; complete: boolean }>,
  toStatements: (item: T) => D1PreparedStatement,
): Promise<{ rows: number; complete: boolean; stop?: string }> {
  let cursor = startCursor(ctx, entity);
  let rows = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    if (ctx.deadlineMs !== undefined && ctx.now() >= ctx.deadlineMs) {
      return { rows, complete: false, stop: "time_limit" };
    }
    const page = await read(cursor, ctx.chunkPages);
    const units = page.items.map((it) => [toStatements(it)]);
    units.push([
      cursorStmt(
        ctx.db,
        ctx.division.id,
        entity,
        page.nextCursor,
        ctx.mode,
        page.complete ? "ok" : "partial",
        ctx.startedAt,
      ),
    ]);
    await runBatches(ctx.db, units);
    rows += page.items.length;
    ctx.progress = rows;
    cursor = page.nextCursor;
    if (page.complete) return { rows, complete: true };
  }
  return { rows, complete: false, stop: "chunk_limit" };
}

async function syncRelations(ctx: Ctx): Promise<EntityResult> {
  const nowIso = ctx.nowIso();
  const r = await cursorLoop(
    ctx,
    "relations",
    (cursor, maxPages) => ctx.client.syncAccounts(cursor, { maxPages }),
    (a) => relationStmt(ctx.db, ctx.division.id, a, nowIso),
  );
  return r.complete
    ? { status: "ok", rows: r.rows, calls: 0 }
    : { status: "partial", rows: r.rows, calls: 0, error: r.stop ?? "partial" };
}

async function syncOpenItems(ctx: Ctx, entity: "receivables" | "payables"): Promise<EntityResult> {
  const receivable = entity === "receivables";
  const nowIso = ctx.nowIso();
  if (ctx.mode === "full") {
    // One complete read of the bulk list; nothing is written (or closed) unless it finished.
    const items = await (receivable ? ctx.client.listReceivables() : ctx.client.listPayables());
    const seen = new Set<string>();
    const units: D1PreparedStatement[][] = [];
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      units.push([openItemStmt(ctx.db, ctx.division.id, it, ctx.runSeq, nowIso)]);
    }
    await runBatches(ctx.db, units);
    ctx.progress = units.length;
    return { status: "ok", rows: units.length, calls: 0, completeRead: true };
  }
  const r = await cursorLoop(
    ctx,
    entity,
    (cursor, maxPages) =>
      receivable
        ? ctx.client.syncReceivables(cursor, { maxPages })
        : ctx.client.syncPayables(cursor, { maxPages }),
    (it) => openItemStmt(ctx.db, ctx.division.id, it, ctx.runSeq, nowIso),
  );
  return r.complete
    ? { status: "ok", rows: r.rows, calls: 0 }
    : { status: "partial", rows: r.rows, calls: 0, error: r.stop ?? "partial" };
}

/**
 * IBANs per relation from crm/BankAccounts. A relation can have several; the main one wins, else
 * the lowest IBAN (stable). A changed IBAN, or a first IBAN on a relation that existed before the
 * previous IBAN pass, sets iban_changed_at and writes `relation.iban_changed` (masked) in the
 * same batch as the update. A relation that loses all its bank accounts keeps its last IBAN.
 */
async function syncIbans(ctx: Ctx): Promise<EntityResult> {
  const { db, division } = ctx;
  const accounts = await ctx.client.listBankAccounts();
  const best = new Map<string, { iban: string; main: boolean }>();
  for (const b of accounts) {
    if (b.iban === null || b.iban === "") continue;
    const key = b.accountId.toLowerCase();
    const cur = best.get(key);
    if (cur === undefined || (b.main && !cur.main) || (b.main === cur.main && b.iban < cur.iban)) {
      best.set(key, { iban: b.iban, main: b.main });
    }
  }
  const existing = await db
    .prepare("SELECT exact_id, iban FROM relations WHERE division_id = ?1")
    .bind(division.id)
    .all<{ exact_id: string; iban: string | null }>();
  const hadPass = (ctx.state.get("bank_accounts")?.last_completed_at ?? null) !== null;
  const nowIso = ctx.nowIso();
  const units: D1PreparedStatement[][] = [];
  for (const rel of existing.results) {
    const next = best.get(rel.exact_id);
    if (next === undefined || next.iban === rel.iban) continue;
    const flagged = rel.iban !== null || hadPass;
    if (!flagged) {
      units.push([
        db
          .prepare(
            `UPDATE relations SET iban = ?3, updated_at = ?4
             WHERE division_id = ?1 AND exact_id = ?2 AND iban IS NULL`,
          )
          .bind(division.id, rel.exact_id, next.iban, nowIso),
      ]);
      continue;
    }
    units.push([
      auditStatement(
        db,
        {
          actorEmail: ctx.actor,
          action: "relation.iban_changed",
          entity: "relation",
          entityId: `${division.id}:${rel.exact_id}`,
          before: { iban: rel.iban },
          after: { iban: next.iban },
        },
        {
          sql: "EXISTS (SELECT 1 FROM relations WHERE division_id = ?7 AND exact_id = ?8 AND iban IS ?9)",
          binds: [division.id, rel.exact_id, rel.iban],
        },
      ),
      db
        .prepare(
          `UPDATE relations SET iban = ?3, iban_changed_at = ?4, updated_at = ?4
           WHERE division_id = ?1 AND exact_id = ?2 AND iban IS ?5`,
        )
        .bind(division.id, rel.exact_id, next.iban, nowIso, rel.iban),
    ]);
  }
  await runBatches(db, units);
  return { status: "ok", rows: accounts.length, calls: 0 };
}
