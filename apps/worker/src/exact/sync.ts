/**
 * Exact -> D1 sync for one division (Phase 2, tasks E3 and G1). See ADR 0017.
 *
 * Entities, in this order (what users look at first refreshes first): divisions, receivables,
 * payables, relations (accounts via the Timestamp sync endpoint), relation_ibans (the bank
 * accounts of those relations, crm/BankAccounts; not our own bank accounts table).
 *
 *  - Everything goes through the division's ExactGate with priority 'job' and a call budget
 *    (startJob ... endJob in a finally).
 *  - FULL mode works in CYCLES that may span many runs (sync_state.cycle_seq on the 'run' row,
 *    abandoned after 36 h or on `restart`). Inside a cycle every entity is read completely once
 *    and then skipped by later runs of the cycle. Receivables and payables are read from the bulk
 *    lists in resumable chunks (the `$skiptoken` is saved with the rows). Only when the read of
 *    that kind has COMPLETED, items last seen before the cycle began get a strike; they close
 *    after two strikes in a row, or one from a read done in a single run (two-strike rule,
 *    `strikesToClose`). A partial, failed, rate-limited or time-boxed run never strikes or closes
 *    anything. A guard refuses more than max(5, 20 %) of the open items of a kind without
 *    `allowLargeClose`. Progress and cycle state are only saved while the run holds its lease.
 *  - IBANs (crm/BankAccounts) are read in scheduled FULL runs only (`readIbans`), never hourly.
 *    Every bank account of a relation is kept in relation_bank_accounts (ADR 0019).
 *  - INCREMENTAL mode continues every cursor-based entity from its saved Timestamp and never
 *    closes by absence. A zero open amount closes an item we know; unknown closed items are not
 *    inserted (that would import the whole paid history). Open items are only read in
 *    incremental mode when the admin setting `exact.incremental_open_items` is on (default OFF
 *    until the same-ID assumption across the list and sync endpoints is confirmed, ADR 0017);
 *    otherwise the nightly full list pass is what refreshes them.
 *  - Relations continue from their saved Timestamp cursor in every mode (a full run restarts them
 *    from 0 only with `restart`). Deletions in Exact are not detected for relations.
 *  - Budget, rate limit, time limit, transient failures: save progress, finish as 'partial', the
 *    next run resumes. Transient failures are counted per Amsterdam day and become 'error' after
 *    MAX_TRANSIENT_RETRIES. Auth failure: record 'needs_reauth' and stop (no retry loop).
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
import { createGateTransport, gateName, getExactGate } from "./gate-transport";
import { amsterdamDate, amsterdamParts, isPlausibleIban, normalizeIban } from "@camelthorn/core";

export type SyncMode = "full" | "incremental";
export type RunStatus = "ok" | "partial" | "error" | "needs_reauth";
export type EntityName = "divisions" | "relations" | "relation_ibans" | "receivables" | "payables";
export const ENTITIES: readonly EntityName[] = [
  "divisions",
  "receivables",
  "payables",
  "relations",
  "relation_ibans",
];
/**
 * Every value sync_state.entity may hold: the entities plus 'run' for the whole run. The table has
 * no CHECK for it (migration 0007); this is the one list, enforced before any write.
 */
export const SYNC_ENTITIES: readonly (EntityName | "run")[] = ["run", ...ENTITIES];
export const isSyncEntity = (v: string): v is EntityName | "run" =>
  (SYNC_ENTITIES as readonly string[]).includes(v);
function assertSyncEntity(v: string): void {
  if (!isSyncEntity(v)) throw new Error("unknown sync entity");
}
/** Admin setting (settings table): read open items in INCREMENTAL runs too. Default off. */
export const INCREMENTAL_OPEN_ITEMS_KEY = "exact.incremental_open_items";

export const DEFAULT_SYNC_BUDGET = 300;
/** A full cycle that has not finished after this long is abandoned and started again. */
export const CYCLE_MAX_AGE_MS = 36 * 60 * 60 * 1000;
/** Transient failures (502/503/504, network, gate unavailable, rate limit) per Amsterdam day. */
export const MAX_TRANSIENT_RETRIES = 3;
/** Rough rows per page of crm/BankAccounts (unverified), used to skip an IBAN read the budget cannot finish. */
const IBAN_PAGE_GUESS = 50;
/** Pages read per chunk of a cursor-based read; progress is saved after every chunk. */
export const DEFAULT_CHUNK_PAGES = 5;
const MAX_CHUNKS = 200;
const BATCH_LIMIT = 100;
/**
 * Lease length. Longer than any run may take: manual runs stop after 20 s and scheduled ones
 * after SCHEDULED_MAX_MS (12 min) between Exact calls, and Cron Triggers end after 15 min wall
 * time anyway. A crashed run frees the division after at most this long. Even if a run outlives
 * its lease and another run takes over, the old run can no longer close items or overwrite rows
 * the newer run has seen (lease-guarded close, run_seq-guarded upserts).
 */
export const LEASE_MS = 15 * 60 * 1000;

/**
 * Subrequests one Worker invocation may make (each gate RPC and each D1 call counts). 1,000 is
 * the long-standing Workers Paid per-invocation limit; it is the conservative figure until the
 * account's actual limit is checked (ADR 0017). The run stops as `partial` (`subrequest_limit`)
 * while SUBREQUEST_RESERVE remain, which is enough for the final batch, endJob and the release.
 */
export const SUBREQUEST_LIMIT = 1000;
export const SUBREQUEST_RESERVE = 25;

/** Shared by all runs of one invocation (the scheduler syncs several divisions in one). */
export interface SubrequestMeter {
  used: number;
  limit: number;
}
export const newMeter = (limit = SUBREQUEST_LIMIT): SubrequestMeter => ({ used: 0, limit });

/**
 * A complete FULL read closes every open item of that kind it did not see. If that would be more
 * than max(CLOSE_GUARD_MIN, CLOSE_GUARD_FRACTION of the open items of that kind), it is far more
 * likely a fault (wrong division, filter, licence, unstable paging) than a genuine mass payment:
 * nothing is closed and the entity ends `error` / `close_guard` until an admin runs a full sync
 * with `allowLargeClose`.
 */
export const CLOSE_GUARD_MIN = 5;
export const CLOSE_GUARD_FRACTION = 0.2;

/**
 * Two-strike rule (ADR 0017): complete reads an open item must be missing from before it is
 * closed. 2 when the read was carried across runs by a saved $skiptoken (an unstable list order
 * between runs could skip a row once; twice in a row at the same item is very unlikely); 1 when
 * the whole list was read in one run (as before G1) or an admin confirmed with allowLargeClose.
 */
export const strikesToClose = (
  r: Pick<EntityResult, "singleRunRead">,
  opts: Pick<SyncOptions, "allowLargeClose">,
): 1 | 2 => (r.singleRunRead === true || opts.allowLargeClose === true ? 1 : 2);

/** True when closing `stale` of `open` open items is allowed without the admin override. */
export const closeAllowed = (stale: number, open: number): boolean =>
  stale <= Math.max(CLOSE_GUARD_MIN, open * CLOSE_GUARD_FRACTION);

/** A clean stop between Exact calls: deadline or subrequest limit. Ends the run as partial. */
class SyncStop extends Error {
  constructor(readonly code: "time_limit" | "subrequest_limit") {
    super(code);
    this.name = "SyncStop";
  }
}

export interface DivisionRef {
  /** divisions.id */
  id: number;
  connectionId: number;
  /** The Exact division number. */
  exactDivision: number;
  /** divisions.base_currency (scale of division-currency amounts). Default EUR. */
  currency?: string;
}

export interface SyncOptions {
  jobId: string;
  mode: SyncMode;
  /** Exact calls this run may spend (gate job budget). */
  budget?: number;
  /** Audit actor: the user's email for manual runs, `system` otherwise. */
  actor?: string;
  chunkPages?: number;
  /** Epoch ms after which the run stops before the next Exact call and finishes as partial. */
  deadlineMs?: number;
  /** Subrequest meter of the invocation; a fresh one (SUBREQUEST_LIMIT) when omitted. */
  meter?: SubrequestMeter;
  /** Full mode only (admin): close a large share of the open items of a kind (close guard). */
  allowLargeClose?: boolean;
  /** Full mode: read crm/BankAccounts (nightly scheduled runs). Default true; manual runs pass false. */
  readIbans?: boolean;
  /**
   * Incremental mode: also read the open receivables / payables from the Timestamp sync
   * endpoints. Default: the `exact.incremental_open_items` setting, which is OFF unless an admin
   * turned it on (ADR 0017: same-ID assumption not yet verified). Full mode is unaffected.
   */
  incrementalOpenItems?: boolean;
  /** Full mode: abandon the open cycle and start a new one. */
  restart?: boolean;
  /**
   * Manual slices: the first page of the first entity that has work is read even when the
   * deadline has already passed, so every slice advances (no livelock under the inline limit).
   */
  guaranteeProgress?: boolean;
  /**
   * Manual runs: decides, UNDER the sync lock, whether the run may start, from the previous run
   * (seconds to wait; 0 = go). Checked after the lease is taken, so two requests racing past the
   * route's own check still cannot both start a new run inside the cooldown.
   */
  admit?: (prev: PrevRun | null) => number;
}

/** The previous run of a division as `admit` sees it (sync_state entity 'run'). */
export interface PrevRun {
  mode: string | null;
  last_status: string | null;
  last_error: string | null;
  last_started_at: string | null;
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
  /**
   * Rows read so far in the pass this run belongs to, and an estimate of the total (open items of
   * that kind before the pass), or null when unknown. For "Read 1,240 of about 5,000 items".
   */
  progress?: { read: number; total: number | null };
  /** The entity is finished for the current full cycle (this run or an earlier one). */
  cycleDone?: boolean;
  /**
   * Full open-item reads: the whole list was read in this run, from the first page to the last
   * (no `$skiptoken` carried over from an earlier run). One strike is then enough to close.
   */
  singleRunRead?: boolean;
  /** Open items of that kind this complete read did not see (closed or waiting for a 2nd miss). */
  missed?: number;
}

export interface SyncSummary {
  status: RunStatus | "locked" | "cooldown";
  /** status 'cooldown': seconds until a new run may start (see SyncOptions.admit). */
  retryAfterSeconds?: number;
  mode: SyncMode;
  divisionId: number;
  runSeq: number | null;
  callsUsed: number;
  startedAt: string;
  finishedAt: string;
  entities: Record<EntityName, EntityResult>;
  /** Full mode: every entity of the cycle is finished (the cycle closed). */
  cycleComplete: boolean;
}

// ---------------------------------------------------------------------------------------------

interface StateRow {
  entity: string;
  cursor: string;
  mode: SyncMode | null;
  last_status: string | null;
  last_error: string | null;
  last_started_at: string | null;
  last_completed_at: string | null;
  rows_seen: number;
  cycle_seq: number | null;
  cycle_started_at: string | null;
  pass_cycle: number | null;
  pass_token: string | null;
  pass_rows: number;
  pass_total: number | null;
  done_cycle: number | null;
  retry_count: number;
  retry_day: string | null;
}

type Failure = {
  kind: "stop" | "continue";
  status: RunStatus;
  code: string;
  /** Worth retrying soon (counted per day, bounded by MAX_TRANSIENT_RETRIES). */
  transient?: boolean;
};

const TRANSIENT_STATUS: ReadonlySet<number> = new Set([502, 503, 504]);

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,60}$/;
const safeCode = (c: string | undefined, fallback: string): string =>
  c !== undefined && SAFE_CODE.test(c) ? c : fallback;

function classify(e: unknown): Failure {
  if (e instanceof SyncStop) return { kind: "stop", status: "partial", code: e.code };
  if (e instanceof ExactBudgetExhaustedError) {
    return { kind: "stop", status: "partial", code: "budget_exhausted" };
  }
  if (e instanceof ExactRateLimitedError) {
    return { kind: "stop", status: "partial", code: "rate_limited", transient: true };
  }
  if (e instanceof ExactAuthError) {
    return { kind: "stop", status: "needs_reauth", code: safeCode(e.message, "auth_failed") };
  }
  if (e instanceof ExactApiError) {
    const code = safeCode(e.code, `http_${e.status}`);
    // Bad gateway / unavailable / timeout, an unreachable Exact and an unavailable gate pass by
    // themselves: stop the run (the next entities would fail the same way) and retry later.
    if (TRANSIENT_STATUS.has(e.status) || e.code === "network" || e.code === "gate_unavailable") {
      return { kind: "stop", status: "partial", code, transient: true };
    }
    return { kind: "continue", status: "error", code };
  }
  // A D1 or programming error. Name only: messages can carry row data.
  console.error("exact sync failed", e instanceof Error ? e.name : "unknown");
  return { kind: "stop", status: "error", code: "internal_error" };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Counts one subrequest, refusing it when only the reserve would be left. */
function spend(meter: SubrequestMeter): void {
  if (meter.used + 1 + SUBREQUEST_RESERVE > meter.limit) throw new SyncStop("subrequest_limit");
  meter.used += 1;
}

async function runBatches(
  db: D1Database,
  meter: SubrequestMeter,
  units: D1PreparedStatement[][],
): Promise<void> {
  // Units (for example change + its audit row) are never split across batches.
  let cur: D1PreparedStatement[] = [];
  for (const unit of units) {
    if (cur.length > 0 && cur.length + unit.length > BATCH_LIMIT) {
      spend(meter);
      await db.batch(cur);
      cur = [];
    }
    cur.push(...unit);
  }
  if (cur.length > 0) {
    spend(meter);
    await db.batch(cur);
  }
}

function defaultGate(env: Env, exactDivision: number): JobGate {
  // The same EU-jurisdiction object that serves the calls (ADR 0018), so the budget applies.
  const stub = getExactGate(env, gateName(exactDivision));
  return {
    startJob: (id, budget) => stub.startJob(id, budget),
    endJob: (id) => stub.endJob(id),
  };
}

// ---------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------

/** The run that wrote a statement still holds the division's lease (?1 = division_id). */
const leaseHeld = (holderParam: string, seqParam: string): string =>
  `EXISTS (SELECT 1 FROM sync_locks WHERE division_id = ?1 AND holder = ${holderParam}
           AND run_seq = ${seqParam})`;

/** Identifies the run for the lease guard. */
interface Lease {
  holder: string;
  runSeq: number;
}

const cursorStmt = (
  db: D1Database,
  divisionId: number,
  entity: EntityName,
  cursor: string,
  mode: SyncMode,
  status: "partial" | "ok",
  startedAt: string,
  cycle: number | null,
  lease: Lease,
): D1PreparedStatement => {
  assertSyncEntity(entity);
  return db
    .prepare(
      `INSERT INTO sync_state (division_id, entity, cursor, mode, last_started_at, last_status,
         pass_cycle)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (division_id, entity) DO UPDATE SET
         cursor = excluded.cursor, mode = excluded.mode, last_status = excluded.last_status,
         last_started_at = excluded.last_started_at,
         pass_cycle = COALESCE(excluded.pass_cycle, sync_state.pass_cycle)
       WHERE ${leaseHeld("?8", "?9")}`,
    )
    .bind(divisionId, entity, cursor, mode, startedAt, status, cycle, lease.holder, lease.runSeq);
};

/** Saves a resumable open-item pass (same batch as the rows it covers). */
const passStmt = (
  db: D1Database,
  divisionId: number,
  entity: EntityName,
  startedAt: string,
  cycle: number,
  token: string | null,
  rows: number,
  total: number | null,
  lease: Lease,
): D1PreparedStatement => {
  assertSyncEntity(entity);
  return db
    .prepare(
      `INSERT INTO sync_state (division_id, entity, mode, last_started_at, last_status,
         pass_cycle, pass_token, pass_rows, pass_total)
       VALUES (?1, ?2, 'full', ?3, 'partial', ?4, ?5, ?6, ?7)
       ON CONFLICT (division_id, entity) DO UPDATE SET
         pass_cycle = excluded.pass_cycle, pass_token = excluded.pass_token,
         pass_rows = excluded.pass_rows, pass_total = excluded.pass_total
       WHERE ${leaseHeld("?8", "?9")}`,
    )
    .bind(divisionId, entity, startedAt, cycle, token, rows, total, lease.holder, lease.runSeq);
};

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
  source: "list" | "sync",
): D1PreparedStatement {
  const closed = item.amount.minor === 0;
  // Amount model (migration 0005, ADR 0017): open_minor is the open balance in the item
  // currency; original_minor the invoice total when known. Original amount and rate describe the
  // booked invoice and are kept when a later read (the bulk list) does not carry them, unless the
  // currency changed. open_dc_minor is a snapshot of the open balance and is never kept stale.
  // A closed item we have never seen is not inserted (the sync endpoints return the whole paid
  // history from cursor 0); a closed item we do know is updated.
  // The DO UPDATE only applies when this run is not older than the run that last saw the row, so
  // a run that outlived its lease cannot overwrite (or un-see) what a newer run wrote.
  const original =
    item.originalAmount?.currency === item.amount.currency ? item.originalAmount : null;
  const dc = item.amountDc;
  return db
    .prepare(
      `INSERT INTO open_items (division_id, exact_id, kind, relation_id, relation_name,
         invoice_number, reference, currency, amount_minor, open_minor, invoice_date, due_date,
         status, closed_at, synced_at, entry_number, last_seen_sync_id, original_minor,
         open_dc_minor, dc_currency, rate, source)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?17, ?9), ?9, ?10, ?11, ?12, ?13, ?14,
         ?15, ?16, ?17, ?18, ?19, ?20, ?21
       WHERE ?12 = 'open'
          OR EXISTS (SELECT 1 FROM open_items WHERE division_id = ?1 AND exact_id = ?2)
       ON CONFLICT (division_id, exact_id) DO UPDATE SET
         kind = excluded.kind, relation_id = excluded.relation_id,
         relation_name = excluded.relation_name, invoice_number = excluded.invoice_number,
         reference = excluded.reference,
         original_minor = CASE WHEN excluded.original_minor IS NOT NULL THEN excluded.original_minor
                               WHEN open_items.currency = excluded.currency
                               THEN open_items.original_minor ELSE NULL END,
         amount_minor = COALESCE(excluded.original_minor,
                                 CASE WHEN open_items.currency = excluded.currency
                                      THEN open_items.original_minor END,
                                 excluded.open_minor),
         rate = CASE WHEN excluded.rate IS NOT NULL THEN excluded.rate
                     WHEN open_items.currency = excluded.currency THEN open_items.rate
                     ELSE NULL END,
         currency = excluded.currency, open_minor = excluded.open_minor,
         open_dc_minor = excluded.open_dc_minor, dc_currency = excluded.dc_currency,
         invoice_date = excluded.invoice_date, due_date = excluded.due_date,
         status = excluded.status,
         closed_at = CASE WHEN excluded.status = 'closed'
                          THEN COALESCE(open_items.closed_at, excluded.closed_at) ELSE NULL END,
         synced_at = excluded.synced_at, entry_number = excluded.entry_number,
         last_seen_sync_id = excluded.last_seen_sync_id, missed_cycles = 0,
         source = excluded.source
       WHERE excluded.last_seen_sync_id >= COALESCE(open_items.last_seen_sync_id, 0)`,
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
      original === null ? null : original.minor,
      dc === null ? null : dc.minor,
      dc === null ? null : dc.currency,
      item.rate,
      source,
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
  /**
   * Counts as the day's complete FULL sync (last_full_completed_at). Only a full run that also
   * read the IBANs does: a manual full run skips them, and the nightly one must still run.
   */
  fullOk = false,
): D1PreparedStatement {
  assertSyncEntity(entity);
  return db
    .prepare(
      `INSERT INTO sync_state (division_id, entity, mode, last_started_at, last_finished_at,
         last_completed_at, last_full_completed_at, last_status, last_error, rows_seen, calls_used)
       VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?6 = 'ok' THEN ?5 ELSE NULL END,
         CASE WHEN ?6 = 'ok' AND ?10 = 1 THEN ?5 ELSE NULL END, ?6, ?7, ?8, ?9)
       ON CONFLICT (division_id, entity) DO UPDATE SET
         mode = excluded.mode, last_started_at = excluded.last_started_at,
         last_finished_at = excluded.last_finished_at,
         last_completed_at = CASE WHEN excluded.last_status = 'ok' THEN excluded.last_finished_at
                                  ELSE sync_state.last_completed_at END,
         last_full_completed_at = CASE WHEN excluded.last_status = 'ok' AND ?10 = 1
                                       THEN excluded.last_finished_at
                                       ELSE sync_state.last_full_completed_at END,
         last_status = excluded.last_status, last_error = excluded.last_error,
         rows_seen = excluded.rows_seen, calls_used = excluded.calls_used`,
    )
    .bind(
      divisionId,
      entity,
      mode,
      startedAt,
      finishedAt,
      status,
      error,
      rows,
      calls,
      fullOk ? 1 : 0,
    );
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
  const budget = opts.budget ?? DEFAULT_SYNC_BUDGET;
  const readIbans = opts.mode === "full" && (opts.readIbans ?? true);
  const entities = Object.fromEntries(ENTITIES.map((e) => [e, emptyResult()])) as Record<
    EntityName,
    EntityResult
  >;
  const meter = opts.meter ?? newMeter();
  const holder = crypto.randomUUID();
  const early = (
    status: "partial" | "locked" | "cooldown",
    runSeq: number | null,
  ): SyncSummary => ({
    status,
    mode: opts.mode,
    divisionId: division.id,
    runSeq,
    callsUsed: 0,
    startedAt,
    finishedAt: startedAt,
    entities,
    cycleComplete: false,
  });
  if (meter.used + 1 + SUBREQUEST_RESERVE > meter.limit) {
    // Nothing left in this invocation: do not even take the lock.
    return early("partial", null);
  }
  meter.used += 1;
  const runSeq = await acquireSyncLock(db, division.id, holder, now());
  if (runSeq === null) return early("locked", null);

  let callsUsed = 0;
  try {
    const gate = deps.gate ?? defaultGate(env, division.exactDivision);
    const baseTransport = deps.transport ?? createGateTransport(env, division.exactDivision);
    let current: EntityName = "divisions";
    const tally = new Map<EntityName, number>();
    // True once a page of a real entity (not the divisions list) has been received.
    let pageSeen = false;
    // Past the deadline, except that a manual slice (guaranteeProgress) may still read the first
    // page of its first entity, so that every slice advances.
    const pastDeadline = (): boolean =>
      opts.deadlineMs !== undefined &&
      now() >= opts.deadlineMs &&
      !(opts.guaranteeProgress === true && !pageSeen);
    // Every Exact call: stop cleanly at the deadline or before the invocation's subrequest limit
    // (SyncStop -> partial). Checked per call, so a long bulk read cannot overrun either.
    const transport: ExactTransport = async (req) => {
      if (pastDeadline()) throw new SyncStop("time_limit");
      spend(meter);
      tally.set(current, (tally.get(current) ?? 0) + 1);
      const res = await baseTransport(req);
      if (current !== "divisions") pageSeen = true;
      return res;
    };
    const makeClient = (currency: string): ExactClient =>
      createExactClient(transport, {
        division: division.exactDivision,
        jobId: opts.jobId,
        priority: "job",
        divisionCurrency: currency,
      });

    // State first (the previous run as it ended), then the 'running' marker.
    meter.used += 1;
    const stateRows = await db
      .prepare(
        `SELECT entity, cursor, mode, last_status, last_error, last_started_at, last_completed_at,
                rows_seen, cycle_seq, cycle_started_at, pass_cycle, pass_token, pass_rows,
                pass_total, done_cycle, retry_count, retry_day
         FROM sync_state WHERE division_id = ?1`,
      )
      .bind(division.id)
      .all<StateRow>();
    const state = new Map(stateRows.results.map((r) => [r.entity, r]));

    if (opts.admit !== undefined) {
      // Under the lease: runs of this division are serialised, so this check cannot race.
      const wait = opts.admit(state.get("run") ?? null);
      if (wait > 0) return { ...early("cooldown", runSeq), retryAfterSeconds: wait };
    }

    // Incremental open-item reads are off unless an admin turned them on (ADR 0017).
    let incrementalOpenItems = opts.incrementalOpenItems ?? false;
    if (opts.mode === "incremental" && opts.incrementalOpenItems === undefined) {
      meter.used += 1;
      incrementalOpenItems = await readBoolSetting(db, INCREMENTAL_OPEN_ITEMS_KEY, false).catch(
        () => false,
      );
    }

    meter.used += 1;
    await stateStmt(db, division.id, "run", opts.mode, startedAt, startedAt, "running", null, 0, 0)
      .run()
      .catch(() => undefined);

    // FULL cycle: continue the open one (younger than CYCLE_MAX_AGE_MS, not restarted), else
    // this run starts a new one. Its id is this run's sequence number.
    const prevRun = state.get("run");
    let cycle: number | null = null;
    let cycleStartedAt = startedAt;
    if (opts.mode === "full") {
      const startedMs = prevRun?.cycle_started_at ? Date.parse(prevRun.cycle_started_at) : NaN;
      const open =
        prevRun?.cycle_seq != null &&
        !Number.isNaN(startedMs) &&
        now() - startedMs < CYCLE_MAX_AGE_MS &&
        opts.restart !== true;
      cycle = open ? (prevRun?.cycle_seq ?? runSeq) : runSeq;
      if (open && prevRun?.cycle_started_at) cycleStartedAt = prevRun.cycle_started_at;
    }

    let fatal: Failure | null = null;
    let stopFailure: Failure | null = null;
    const transientEntities = new Set<EntityName>();
    let started = false;
    try {
      try {
        meter.used += 1;
        await gate.startJob(opts.jobId, budget);
        started = true;
      } catch {
        fatal = { kind: "stop", status: "partial", code: "gate_unavailable", transient: true };
      }

      const ctx: Ctx = {
        db,
        client: makeClient(division.currency ?? "EUR"),
        setCurrency: (currency) => {
          ctx.client = makeClient(currency);
        },
        restart: opts.restart === true,
        division,
        mode: opts.mode,
        runSeq,
        lease: { holder, runSeq },
        cycle,
        startedAt,
        nowIso: () => iso(now()),
        actor,
        chunkPages,
        state,
        pastDeadline,
        progress: 0,
        pass: null,
        meter,
        budget,
        callsSoFar: () => [...tally.values()].reduce((a, b) => a + b, 0),
      };

      for (const entity of ENTITIES) {
        if (fatal !== null) break;
        current = entity;
        ctx.progress = 0;
        ctx.pass = null;
        if (entity === "relation_ibans" && !readIbans) continue;
        if (
          opts.mode === "incremental" &&
          !incrementalOpenItems &&
          (entity === "receivables" || entity === "payables")
        ) {
          continue; // left to the nightly full list pass
        }
        if (cycle !== null && entity !== "divisions" && state.get(entity)?.done_cycle === cycle) {
          // Read completely earlier in this cycle: nothing to do.
          entities[entity] = { status: "skipped", rows: 0, calls: 0, cycleDone: true };
          continue;
        }
        let result: EntityResult;
        let failure: Failure | null = null;
        if (pastDeadline()) {
          failure = { kind: "stop", status: "partial", code: "time_limit" };
          result = { status: "partial", rows: 0, calls: 0, error: failure.code };
        } else {
          try {
            result = await runEntity(ctx, entity);
          } catch (e) {
            failure = classify(e);
            result = { status: failure.status, rows: ctx.progress, calls: 0, error: failure.code };
            if (ctx.pass !== null) result.progress = ctx.pass;
          }
          const partialCode = result.status === "partial" ? result.error : undefined;
          if (failure === null && partialCode !== undefined) {
            failure = { kind: "stop", status: "partial", code: partialCode };
          }
        }
        result.calls = tally.get(entity) ?? 0;
        entities[entity] = result;
        if (failure?.transient === true) transientEntities.add(entity);
        if (failure?.kind === "stop") {
          stopFailure = failure;
          break;
        }
      }
    } finally {
      if (started) {
        try {
          meter.used += 1;
          callsUsed = (await gate.endJob(opts.jobId)).used;
        } catch {
          // The job record is purged by the gate after 24 hours; nothing else to do.
        }
      }
    }

    // Close guard (see CLOSE_GUARD_MIN): checked before the status is computed, so a refused
    // close shows as an error on the entity and the run. The cycle stays open for that entity.
    for (const [entity, kind] of [
      ["receivables", "invoice"],
      ["payables", "bill"],
    ] as const) {
      const r = entities[entity];
      if (cycle === null || r.status !== "ok" || r.completeRead !== true) continue;
      // `stale`: open items this read did not see; `due`: those that close now (two-strike rule,
      // see the close statements below). Counted under the lease, so they match what the final
      // batch does and the audit row can record them.
      const need = strikesToClose(r, opts);
      meter.used += 1;
      const counts = await db
        .prepare(
          `SELECT COUNT(*) AS open,
                  COALESCE(SUM(CASE WHEN COALESCE(last_seen_sync_id, 0) < ?3 THEN 1 ELSE 0 END), 0)
                    AS stale,
                  COALESCE(SUM(CASE WHEN COALESCE(last_seen_sync_id, 0) < ?3
                                     AND missed_cycles + 1 >= ?4 THEN 1 ELSE 0 END), 0) AS due
           FROM open_items WHERE division_id = ?1 AND kind = ?2 AND status = 'open'`,
        )
        .bind(division.id, kind, cycle, need)
        .first<{ open: number; stale: number; due: number }>();
      entities[entity] = { ...r, missed: counts?.stale ?? 0, closed: counts?.due ?? 0 };
      if (opts.allowLargeClose !== true && !closeAllowed(counts?.stale ?? 0, counts?.open ?? 0)) {
        entities[entity] = {
          status: "error",
          rows: r.rows,
          calls: r.calls,
          error: "close_guard",
          completeRead: false,
          cycleDone: false,
          ...(r.progress !== undefined ? { progress: r.progress } : {}),
        };
      }
    }

    // FULL runs: transient failures are retried by the next run, but only MAX_TRANSIENT_RETRIES
    // times per Amsterdam day; after that they count as errors. retry_count / retry_day count the
    // failed full attempts of the day and are what scheduledMode reads, so they survive the
    // incremental runs in between (a full that failed is not retried every other tick).
    // Incremental runs do not touch the counter: they run hourly anyway and a transient failure
    // simply ends them `partial`.
    const today = amsterdamParts(now()).date;
    let retryCount = prevRun?.retry_count ?? 0;
    let retryDay = prevRun?.retry_day ?? null;
    if (opts.mode === "full" && (fatal?.transient === true || transientEntities.size > 0)) {
      retryCount = (retryDay === today ? retryCount : 0) + 1;
      retryDay = today;
      if (retryCount > MAX_TRANSIENT_RETRIES) {
        if (fatal?.transient === true) fatal = { ...fatal, status: "error" };
        if (stopFailure?.transient === true) stopFailure = { ...stopFailure, status: "error" };
        for (const e of transientEntities) entities[e] = { ...entities[e], status: "error" };
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

    // The cycle is finished when every entity it covers is. IBANs are only part of it for runs
    // that read them (a manual full run leaves them to the nightly one).
    const required = ENTITIES.filter((e) => e !== "relation_ibans" || readIbans);
    const cycleComplete =
      cycle !== null && status === "ok" && required.every((e) => entities[e].cycleDone === true);

    // A full run that ended in error (a permanent API error, the close guard, an internal error,
    // or transient failures past the bound) is not started again by the scheduler that day.
    if (opts.mode === "full" && status === "error") {
      retryCount = Math.max(retryDay === today ? retryCount : 0, MAX_TRANSIENT_RETRIES + 1);
      retryDay = today;
    }

    const finishedAt = iso(now());
    const rowsTotal = results.reduce((n, r) => n + r.rows, 0);
    const statements: D1PreparedStatement[] = [];
    // [entity, index of its strike statement]; the close statement follows it.
    const closing: [EntityName, number][] = [];
    for (const [entity, kind] of [
      ["receivables", "invoice"],
      ["payables", "bill"],
    ] as const) {
      const r = entities[entity];
      if (cycle !== null && r.status === "ok" && r.completeRead === true) {
        closing.push([entity, statements.length]);
        // Two-strike rule (ADR 0017): every open item this complete read did not see (last seen
        // BEFORE the cycle began) gets a strike; it is closed once it has missed two complete
        // reads in a row, or one that was read in a single run (no $skiptoken carried across
        // runs, so no risk from a list order that moved between runs), or one an admin confirmed
        // with allowLargeClose. Seeing the item again resets the count (openItemStmt). Both
        // statements touch only this division and kind, and only while this run still holds
        // the lease: if it expired and another run took over, run_seq moved on and nothing
        // changes.
        const need = strikesToClose(r, opts);
        statements.push(
          db
            .prepare(
              `UPDATE open_items SET missed_cycles = missed_cycles + 1
               WHERE division_id = ?1 AND kind = ?2 AND status = 'open'
                 AND COALESCE(last_seen_sync_id, 0) < ?3 AND ${leaseHeld("?4", "?5")}`,
            )
            .bind(division.id, kind, cycle, holder, runSeq),
          db
            .prepare(
              `UPDATE open_items SET status = 'closed', open_minor = 0,
                 open_dc_minor = CASE WHEN open_dc_minor IS NULL THEN NULL ELSE 0 END,
                 closed_at = ?4
               WHERE division_id = ?1 AND kind = ?2 AND status = 'open'
                 AND COALESCE(last_seen_sync_id, 0) < ?3 AND missed_cycles >= ?7
                 AND ${leaseHeld("?5", "?6")}`,
            )
            .bind(division.id, kind, cycle, finishedAt, holder, runSeq, need),
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
      if (cycle !== null && entity !== "divisions" && r.status === "ok" && r.cycleDone === true) {
        statements.push(
          db
            .prepare(
              `UPDATE sync_state SET done_cycle = ?3, pass_token = NULL
               WHERE division_id = ?1 AND entity = ?2 AND ${leaseHeld("?4", "?5")}`,
            )
            .bind(division.id, entity, cycle, holder, runSeq),
        );
      } else if (
        cycle !== null &&
        r.status === "error" &&
        (entity === "receivables" || entity === "payables") &&
        r.error !== "close_guard"
      ) {
        // A saved $skiptoken that keeps failing must not be retried until the cycle expires.
        statements.push(
          db
            .prepare(
              `UPDATE sync_state SET pass_token = NULL, pass_rows = 0
               WHERE division_id = ?1 AND entity = ?2 AND ${leaseHeld("?3", "?4")}`,
            )
            .bind(division.id, entity, holder, runSeq),
        );
      }
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
        cycleComplete && readIbans,
      ),
      db
        .prepare(
          `UPDATE sync_state SET
             cycle_seq = CASE WHEN ?2 = 1 THEN ?3 ELSE cycle_seq END,
             cycle_started_at = CASE WHEN ?2 = 1 THEN ?4 ELSE cycle_started_at END,
             retry_count = ?5, retry_day = ?6
           WHERE division_id = ?1 AND entity = 'run' AND ${leaseHeld("?7", "?8")}`,
        )
        .bind(
          division.id,
          opts.mode === "full" ? 1 : 0,
          cycle === null || cycleComplete ? null : cycle,
          cycle === null || cycleComplete ? null : cycleStartedAt,
          retryCount,
          retryDay,
          holder,
          runSeq,
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
          ...(opts.allowLargeClose === true ? { allowLargeClose: true } : {}),
          ...(opts.mode === "full" ? { cycleComplete } : {}),
          callsUsed,
          entities: Object.fromEntries(
            ENTITIES.map((e) => [
              e,
              {
                status: entities[e].status,
                rows: entities[e].rows,
                calls: entities[e].calls,
                ...(entities[e].error !== undefined ? { error: entities[e].error } : {}),
                ...(entities[e].closed !== undefined
                  ? { missed: entities[e].missed ?? 0, closed: entities[e].closed }
                  : {}),
              },
            ]),
          ),
        },
      }),
    );
    meter.used += 1;
    const results2 = await db.batch(statements);
    // The strike and close statements come first; report what each kind missed and closed.
    // (The audit row in the same batch cannot carry these counts; the sync_state row and the
    // response do, and every closed row has closed_at.)
    for (const [entity, i] of closing) {
      entities[entity].missed = results2[i]?.meta.changes ?? 0;
      entities[entity].closed = results2[i + 1]?.meta.changes ?? 0;
    }
    return {
      status,
      mode: opts.mode,
      divisionId: division.id,
      runSeq,
      callsUsed,
      startedAt,
      finishedAt,
      entities,
      cycleComplete,
    };
  } finally {
    meter.used += 1;
    await releaseSyncLock(db, division.id, holder).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

interface Ctx {
  db: D1Database;
  /** Replaced by setCurrency once the division's own currency has been read. */
  client: ExactClient;
  /** Rebuilds the client with this division currency (scale of division-currency amounts). */
  setCurrency: (currency: string) => void;
  /** Full mode: start cursor-based reads from 0 instead of the saved cursor. */
  restart: boolean;
  division: DivisionRef;
  mode: SyncMode;
  runSeq: number;
  /** This run's lease (holder + run_seq): progress is only saved while it is held. */
  lease: Lease;
  /** Full mode: the cycle this run belongs to (its first run's sequence number). */
  cycle: number | null;
  startedAt: string;
  nowIso: () => string;
  actor: string;
  chunkPages: number;
  state: Map<string, StateRow>;
  pastDeadline: () => boolean;
  /** Rows written so far for the entity being synced (kept when a later chunk fails). */
  progress: number;
  /** Pass progress of the entity being synced (open-item lists), for the UI. */
  pass: { read: number; total: number | null } | null;
  meter: SubrequestMeter;
  /** The gate job budget and the Exact calls this run has spent so far. */
  budget: number;
  callsSoFar: () => number;
}

function runEntity(ctx: Ctx, entity: EntityName): Promise<EntityResult> {
  switch (entity) {
    case "divisions":
      return syncDivisions(ctx);
    case "relations":
      return syncRelations(ctx);
    case "relation_ibans":
      return syncIbans(ctx);
    case "receivables":
    case "payables":
      return ctx.mode === "full"
        ? syncOpenItemsFull(ctx, entity)
        : syncOpenItemsIncremental(ctx, entity);
  }
}

async function syncDivisions(ctx: Ctx): Promise<EntityResult> {
  const { db, division } = ctx;
  const list = await ctx.client.listDivisions();
  const nowIso = ctx.nowIso();
  // New divisions arrive DISABLED (sync_enabled defaults to 0): an admin turns them on. Only the
  // /current/Me division is enabled, by the connect callback. The currency is the division's own
  // (scale of division-currency amounts); when Exact does not send one the stored value stays.
  const units = list.map((d) => [
    db
      .prepare(
        `INSERT INTO divisions (connection_id, exact_division, name, base_currency,
           base_currency_read_at)
         VALUES (?1, ?2, ?3, COALESCE(?4, 'EUR'), CASE WHEN ?4 IS NULL THEN NULL ELSE ?5 END)
         ON CONFLICT (connection_id, exact_division) DO UPDATE SET
           name = CASE WHEN ?6 = 1 THEN excluded.name ELSE divisions.name END,
           base_currency = COALESCE(?4, divisions.base_currency),
           base_currency_read_at = CASE WHEN ?4 IS NULL THEN divisions.base_currency_read_at
                                        ELSE ?5 END`,
      )
      .bind(
        division.connectionId,
        d.code,
        (d.description ?? "") !== "" ? (d.description ?? "").slice(0, 200) : `Division ${d.code}`,
        d.currency,
        nowIso,
        (d.description ?? "") !== "" ? 1 : 0,
      ),
  ]);
  await runBatches(db, ctx.meter, units);
  // The rest of this run reads amounts in the division's own currency.
  const own = list.find((d) => d.code === division.exactDivision)?.currency ?? null;
  if (own !== null && own !== (division.currency ?? "EUR")) ctx.setCurrency(own);
  return { status: "ok", rows: list.length, calls: 0, cycleDone: ctx.mode === "full" };
}

export async function readBoolSetting(
  db: D1Database,
  key: string,
  fallback: boolean,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT value_json FROM settings WHERE key = ?1")
    .bind(key)
    .first<{ value_json: string }>();
  if (!row) return fallback;
  try {
    const v: unknown = JSON.parse(row.value_json);
    return typeof v === "boolean" ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Where a cursor-based read starts: the saved Timestamp, in every mode. The Timestamp endpoints
 * return everything changed since the cursor, so continuing is complete for new and changed rows
 * (a full nightly run used to start accounts over from 0, review N1). A full run with `restart`
 * (an admin asked for a clean start) reads from 0. Rows deleted in Exact are NOT seen by a
 * Timestamp read at all (sync/Deleted is not used, ADR 0017): relations never disappear here.
 */
function startCursor(ctx: Ctx, entity: EntityName): string {
  const st = ctx.state.get(entity);
  if (!st) return "0";
  if (ctx.mode === "full" && ctx.restart) return "0";
  return st.cursor;
}

/**
 * Reads a Timestamp-cursor endpoint in chunks of `chunkPages` pages. After every chunk the rows
 * are written and the cursor saved, so a stop (budget, rate limit, time) loses at most one chunk
 * (and not even that when the failure comes after the chunk's first page: the client hands back
 * the pages it read together with the error, which is rethrown once they are written).
 */
async function cursorLoop<T>(
  ctx: Ctx,
  entity: EntityName,
  read: (
    cursor: string,
    maxPages: number,
  ) => Promise<{ items: T[]; nextCursor: string; complete: boolean; error?: unknown }>,
  toStatements: (item: T) => D1PreparedStatement,
): Promise<{ rows: number; complete: boolean; stop?: string }> {
  let cursor = startCursor(ctx, entity);
  let rows = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    if (ctx.pastDeadline()) return { rows, complete: false, stop: "time_limit" };
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
        ctx.mode === "full" ? ctx.cycle : null,
        ctx.lease,
      ),
    ]);
    await runBatches(ctx.db, ctx.meter, units);
    rows += page.items.length;
    ctx.progress = rows;
    ctx.pass = { read: rows, total: null };
    if (page.error !== undefined) throw page.error;
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
    ? { status: "ok", rows: r.rows, calls: 0, cycleDone: ctx.mode === "full" }
    : { status: "partial", rows: r.rows, calls: 0, error: r.stop ?? "partial" };
}

async function syncOpenItemsIncremental(
  ctx: Ctx,
  entity: "receivables" | "payables",
): Promise<EntityResult> {
  const receivable = entity === "receivables";
  const nowIso = ctx.nowIso();
  const r = await cursorLoop(
    ctx,
    entity,
    (cursor, maxPages) =>
      receivable
        ? ctx.client.syncReceivables(cursor, { maxPages })
        : ctx.client.syncPayables(cursor, { maxPages }),
    (it) => openItemStmt(ctx.db, ctx.division.id, it, ctx.runSeq, nowIso, "sync"),
  );
  return r.complete
    ? { status: "ok", rows: r.rows, calls: 0 }
    : { status: "partial", rows: r.rows, calls: 0, error: r.stop ?? "partial" };
}

/**
 * FULL read of the open receivables / payables list, resumable across runs. Every chunk writes
 * its rows, the `$skiptoken` to continue from and the progress in ONE batch, so a stop anywhere
 * (budget, rate limit, deadline, subrequests, a transient error) loses nothing. The read is
 * COMPLETE only when Exact returns a last page; then (and only then) the caller closes the items
 * last seen before the cycle began.
 */
async function syncOpenItemsFull(
  ctx: Ctx,
  entity: "receivables" | "payables",
): Promise<EntityResult> {
  const receivable = entity === "receivables";
  const cycle = ctx.cycle as number;
  const kind = receivable ? "invoice" : "bill";
  const st = ctx.state.get(entity);
  const resuming = st?.pass_cycle === cycle && st.pass_token !== null && st.pass_token !== "";
  let token: string | null = resuming ? (st?.pass_token ?? null) : null;
  let readTotal = resuming ? (st?.pass_rows ?? 0) : 0;
  let total: number | null = resuming ? (st?.pass_total ?? null) : null;
  if (!resuming) {
    // Estimate for the progress line: the open items of this kind we hold before the pass.
    ctx.meter.used += 1;
    const n = await ctx.db
      .prepare(
        "SELECT COUNT(*) AS n FROM open_items WHERE division_id = ?1 AND kind = ?2 AND status = 'open'",
      )
      .bind(ctx.division.id, kind)
      .first<{ n: number }>();
    total = (n?.n ?? 0) > 0 ? (n?.n ?? null) : null;
  }
  const nowIso = ctx.nowIso();
  let rows = 0;
  ctx.pass = { read: readTotal, total };
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    if (ctx.pastDeadline()) {
      return { status: "partial", rows, calls: 0, error: "time_limit", progress: ctx.pass };
    }
    const page = await (receivable
      ? ctx.client.listReceivablesChunk(token, { maxPages: ctx.chunkPages })
      : ctx.client.listPayablesChunk(token, { maxPages: ctx.chunkPages }));
    readTotal += page.items.length;
    const units: D1PreparedStatement[][] = page.items.map((it) => [
      openItemStmt(ctx.db, ctx.division.id, it, ctx.runSeq, nowIso, "list"),
    ]);
    units.push([
      passStmt(
        ctx.db,
        ctx.division.id,
        entity,
        ctx.startedAt,
        cycle,
        page.nextToken,
        readTotal,
        total,
        ctx.lease,
      ),
    ]);
    await runBatches(ctx.db, ctx.meter, units);
    rows += page.items.length;
    ctx.progress = rows;
    ctx.pass = { read: readTotal, total };
    if (page.error !== undefined) throw page.error;
    if (page.complete) {
      return {
        status: "ok",
        rows,
        calls: 0,
        completeRead: true,
        cycleDone: true,
        singleRunRead: !resuming,
        progress: ctx.pass,
      };
    }
    token = page.nextToken;
  }
  return { status: "partial", rows, calls: 0, error: "chunk_limit", progress: ctx.pass };
}

/**
 * Bank accounts of the relations (crm/BankAccounts; full runs that read IBANs only). Every
 * account of a relation is kept in relation_bank_accounts (ADR 0019); relations.iban stays the one
 * IBAN to show and pay to: the main account, else the lowest active IBAN (stable). The read is
 * COMPLETE or it throws, and only a complete read marks an account `removed_at`; an empty answer
 * (no accounts at all) changes nothing.
 *
 * Two flags for payment safety (four-eyes, CLAUDE.md 4.4), both only after a first IBAN pass has
 * completed (the first pass is the baseline) and never because Exact returned rows in another order:
 *  - relations.iban_added_at   the set of active IBANs gained an IBAN it did not have (new, or one
 *                              that was removed and came back). Audit `relation.iban_added`.
 *  - relations.iban_changed_at the IBAN we would pay to changed because the MAIN account changed
 *                              (or the first IBAN appeared). Audit `relation.iban_changed`. A
 *                              display IBAN that moves only because a new lowest IBAN joined the
 *                              set is an addition, not a change.
 * Audit rows are masked and sit in the same batch as the change, guarded by the sync lease. A
 * relation that loses all its accounts keeps its last IBAN in relations.iban.
 */
interface IbanCandidate {
  iban: string;
  bic: string | null;
  main: boolean;
  exactId: string;
}
interface StoredIban {
  relation_id: number;
  iban: string;
  is_main: number;
  bic: string | null;
  exact_id: string | null;
  removed_at: string | null;
}

const lowest = (ibans: Iterable<string>): string | null => {
  let best: string | null = null;
  for (const i of ibans) if (best === null || i < best) best = i;
  return best;
};

async function syncIbans(ctx: Ctx): Promise<EntityResult> {
  const { db, division, lease } = ctx;
  // The read is one piece (about rows / 50 calls). When the budget left cannot cover what the
  // last read needed, do not start it: the next run begins with a fresh budget.
  const prevRows = ctx.state.get("relation_ibans")?.rows_seen ?? 0;
  const needed = Math.ceil(prevRows / IBAN_PAGE_GUESS);
  if (needed > 0 && ctx.budget - ctx.callsSoFar() < needed) {
    return { status: "partial", rows: 0, calls: 0, error: "budget_exhausted" };
  }
  const accounts = await ctx.client.listBankAccounts();

  // Group by relation, normalise and de-duplicate (the same IBAN twice on a relation is one).
  const returned = new Map<string, Map<string, IbanCandidate>>();
  for (const b of accounts) {
    if (b.iban === null) continue;
    const iban = normalizeIban(b.iban);
    if (!isPlausibleIban(iban)) continue;
    const key = b.accountId.toLowerCase();
    const perRelation = returned.get(key) ?? new Map<string, IbanCandidate>();
    const cur = perRelation.get(iban);
    perRelation.set(
      iban,
      cur === undefined
        ? { iban, bic: b.bic, main: b.main, exactId: b.id.toLowerCase() }
        : { ...cur, bic: cur.bic ?? b.bic, main: cur.main || b.main },
    );
    returned.set(key, perRelation);
  }
  // An answer with no usable account at all is far more likely a fault (wrong division, licence)
  // than "every supplier lost every bank account": change nothing.
  if (returned.size === 0) {
    return { status: "ok", rows: accounts.length, calls: 0, cycleDone: true };
  }

  ctx.meter.used += 2;
  const relations = (
    await db
      .prepare("SELECT id, exact_id, iban FROM relations WHERE division_id = ?1")
      .bind(division.id)
      .all<{ id: number; exact_id: string; iban: string | null }>()
  ).results;
  const stored = new Map<number, Map<string, StoredIban>>();
  for (const r of (
    await db
      .prepare(
        `SELECT relation_id, iban, is_main, bic, exact_id, removed_at
         FROM relation_bank_accounts WHERE division_id = ?1`,
      )
      .bind(division.id)
      .all<StoredIban>()
  ).results) {
    const m = stored.get(r.relation_id) ?? new Map<string, StoredIban>();
    m.set(r.iban, r);
    stored.set(r.relation_id, m);
  }

  const hadPass = (ctx.state.get("relation_ibans")?.last_completed_at ?? null) !== null;
  const nowIso = ctx.nowIso();
  // ?{n}: division, holder, run_seq of the lease, appended to every statement below.
  const lease3 = (a: string, b: string, c: string): string =>
    `EXISTS (SELECT 1 FROM sync_locks WHERE division_id = ${a} AND holder = ${b} AND run_seq = ${c})`;
  const units: D1PreparedStatement[][] = [];

  for (const rel of relations) {
    const now = returned.get(rel.exact_id) ?? new Map<string, IbanCandidate>();
    const before = stored.get(rel.id) ?? new Map<string, StoredIban>();
    const activeBefore = [...before.values()].filter((r) => r.removed_at === null);
    const added = [...now.keys()].filter((i) => {
      const s = before.get(i);
      return s === undefined || s.removed_at !== null;
    });
    const removed = activeBefore.filter((r) => !now.has(r.iban)).map((r) => r.iban);

    const mainOf = (ibans: Iterable<IbanCandidate | StoredIban>): string | null =>
      lowest([...ibans].filter((r) => ("main" in r ? r.main : r.is_main === 1)).map((r) => r.iban));
    const prevMain = mainOf(activeBefore);
    const newMain = mainOf(now.values());
    const newDisplay = newMain ?? lowest(now.keys()) ?? rel.iban;
    const displayChanged = newDisplay !== rel.iban;

    // Relations from before migration 0007 have an IBAN but no rows: their rows are a baseline,
    // not additions; only a different display IBAN counts (the old rule).
    const legacy = before.size === 0 && rel.iban !== null;
    const flagAdded = hadPass && !legacy && added.length > 0;
    const flagChanged =
      hadPass && displayChanged && (rel.iban === null || legacy || prevMain !== newMain);

    // Rows that need writing: new, changed in a stored column, or no longer returned.
    const upserts = [...now.values()].filter((c) => {
      const s = before.get(c.iban);
      return (
        s === undefined ||
        s.removed_at !== null ||
        s.is_main !== (c.main ? 1 : 0) ||
        s.bic !== c.bic ||
        s.exact_id !== c.exactId
      );
    });
    if (
      upserts.length === 0 &&
      removed.length === 0 &&
      !displayChanged &&
      !flagAdded &&
      !flagChanged
    ) {
      continue;
    }

    const unit: D1PreparedStatement[] = [];
    const entityId = `${division.id}:${rel.exact_id}`;
    if (flagAdded) {
      for (const iban of added) {
        unit.push(
          auditStatement(
            db,
            {
              actorEmail: ctx.actor,
              action: "relation.iban_added",
              entity: "relation",
              entityId,
              after: { iban },
            },
            {
              sql: `${lease3("?7", "?8", "?9")} AND NOT EXISTS (SELECT 1 FROM relation_bank_accounts
                      WHERE relation_id = ?10 AND iban = ?11 AND removed_at IS NULL)`,
              binds: [division.id, lease.holder, lease.runSeq, rel.id, iban],
            },
          ),
        );
      }
    }
    if (flagChanged) {
      unit.push(
        auditStatement(
          db,
          {
            actorEmail: ctx.actor,
            action: "relation.iban_changed",
            entity: "relation",
            entityId,
            before: { iban: rel.iban },
            after: { iban: newDisplay },
          },
          {
            sql: `${lease3("?7", "?8", "?9")} AND EXISTS (SELECT 1 FROM relations
                    WHERE id = ?10 AND iban IS ?11)`,
            binds: [division.id, lease.holder, lease.runSeq, rel.id, rel.iban],
          },
        ),
      );
    }
    for (const c of upserts) {
      unit.push(
        db
          .prepare(
            `INSERT INTO relation_bank_accounts (division_id, relation_id, iban, bic, is_main,
               exact_id, first_seen_at, last_seen_at, removed_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL
             WHERE ${lease3("?1", "?8", "?9")}
             ON CONFLICT (relation_id, iban) DO UPDATE SET
               bic = excluded.bic, is_main = excluded.is_main, exact_id = excluded.exact_id,
               last_seen_at = excluded.last_seen_at, removed_at = NULL`,
          )
          .bind(
            division.id,
            rel.id,
            c.iban,
            c.bic,
            c.main ? 1 : 0,
            c.exactId,
            nowIso,
            lease.holder,
            lease.runSeq,
          ),
      );
    }
    for (const iban of removed) {
      unit.push(
        db
          .prepare(
            `UPDATE relation_bank_accounts SET removed_at = ?3
             WHERE relation_id = ?2 AND iban = ?4 AND removed_at IS NULL
               AND ${lease3("?1", "?5", "?6")}`,
          )
          .bind(division.id, rel.id, nowIso, iban, lease.holder, lease.runSeq),
      );
    }
    if (displayChanged || flagAdded || flagChanged) {
      unit.push(
        db
          .prepare(
            `UPDATE relations SET iban = ?3,
               iban_added_at = CASE WHEN ?4 = 1 THEN ?6 ELSE iban_added_at END,
               iban_changed_at = CASE WHEN ?5 = 1 THEN ?6 ELSE iban_changed_at END,
               updated_at = ?6
             WHERE id = ?2 AND iban IS ?7 AND ${lease3("?1", "?8", "?9")}`,
          )
          .bind(
            division.id,
            rel.id,
            newDisplay,
            flagAdded ? 1 : 0,
            flagChanged ? 1 : 0,
            nowIso,
            rel.iban,
            lease.holder,
            lease.runSeq,
          ),
      );
    }
    units.push(unit);
  }
  // Every account still active after the statements above was returned by this complete read.
  units.push([
    db
      .prepare(
        `UPDATE relation_bank_accounts SET last_seen_at = ?2
         WHERE division_id = ?1 AND removed_at IS NULL AND ${lease3("?1", "?3", "?4")}`,
      )
      .bind(division.id, nowIso, lease.holder, lease.runSeq),
  ]);
  await runBatches(db, ctx.meter, units);
  return { status: "ok", rows: accounts.length, calls: 0, cycleDone: true };
}
