/**
 * The Revolut sync jobs (Phase 5, task R3a, ADR 0033): `revolut.sync` (balances and a poll of new
 * transactions, every 10 minutes) and `revolut.backfill` (a daily walk over the last 35 days that
 * counts what was missing, plus the one-off 90-day initial backfill after a connection is
 * confirmed). Both follow the handler contract (ADR 0021): idempotent (the ingest upserts), counts
 * and codes only in the result, `ctx.signal` checked between calls, the window of a backfill taken
 * from the slot (`run.scheduledFor`), a small per-run Revolut call budget enforced by the gate.
 *
 * Call arithmetic (ADR 0033): a poll run spends at most SYNC_CALL_BUDGET = 10 calls (1 accounts,
 * up to 2 bank details, up to 4 transaction pages, up to 2 refreshes of old pending rows, up to 1
 * retry of a quarantined row); a quiet run costs 3 (accounts and the two-call end of a walk).
 * Counterparty lookups (review S6, ADR 0034) run under their OWN job id and budget of at most 5
 * calls, and only when a stored transaction names a counterparty the cache does not know.
 * Backfill: at most 12 per run.
 *
 * Quality of the data (Phase 5 review Q1): a run that stored everything it could but met rows it
 * could not store (quarantined, review S2) or legs it could not place (review S7) ends `partial`
 * with the code `rows_quarantined` / `legs_skipped`; the counts are in the summary.
 */
import {
  RevolutAuthError,
  type RevolutBankDetails,
  type RevolutClient,
  type RevolutTransaction,
  type TransactionCursor,
} from "@camelthorn/revolut";
import { auditStatement } from "../db/audit";
import type { Env } from "../env";
import type { HandlerResult, JobContext } from "../jobs/types";
import { scheduledForMs } from "../jobs/period";
import {
  applyCounterpartyCache,
  counterpartiesToLookUp,
  COUNTERPARTY_LOOKUPS_PER_RUN,
  lookUpCounterparties,
} from "./counterparties";
import { classifyRevolutError } from "./errors";
import { CREDENTIALS_REJECTED } from "./gate";
import {
  IngestError,
  normStamp,
  upsertTransaction,
  type IngestResult,
  type IngestSource,
} from "./ingest";
import { queueInitialBackfill } from "./initial-backfill";
import { startJobClient } from "./job-client";
import {
  clearQuarantine,
  QUARANTINE_RETRIES_PER_RUN,
  quarantineCounts,
  recordQuarantine,
  retryQuarantined,
  type QuarantineItem,
} from "./quarantine";
import { COUNTERPARTY_LOOKUP_JOB_ID } from "./request";
import { loadRevolutConnection, type RevolutConnectionRow } from "./store";

export const SYNC_JOB_ID = "revolut-sync";
export const BACKFILL_JOB_ID = "revolut-backfill";
/** Revolut calls per poll run (the gate enforces it). */
export const SYNC_CALL_BUDGET = 10;
export const SYNC_PAGE_SIZE = 200;
export const SYNC_MAX_PAGES = 4;
export const SYNC_DETAILS_PER_RUN = 2;
export const SYNC_PENDING_REFRESH = 2;
/** Bank-details lookups are retried after this long when they failed, at most this many times. */
export const DETAILS_RETRY_MS = 24 * 3600_000;
export const DETAILS_MAX_ATTEMPTS = 5;
/** The poll starts this long before the end of its last complete walk. */
export const POLL_OVERLAP_MS = 2 * 3600_000;
/** First poll of a connection (no watermark): history is the backfill's job. */
export const FIRST_POLL_LOOKBACK_MS = 24 * 3600_000;

export const BACKFILL_CALL_BUDGET = 12;
export const BACKFILL_PAGE_SIZE = 500;
export const BACKFILL_MAX_PAGES = 10;
export const BACKFILL_DAYS = 35;
export const INITIAL_BACKFILL_DAYS = 90;
export const BACKFILL_RETRY_SECONDS = 120;
/**
 * A transaction the backfill inserts only counts as `missing` (a missed webhook and poll) when it
 * was created at Revolut more than this long ago: a younger one may simply not have been
 * delivered or polled yet, and counting it would race the webhook.
 */
export const MISS_GRACE_MS = 10 * 60_000;
/** Wall time one run may spend; the runner's own limit is 13 minutes. */
const RUN_MAX_MS = 10 * 60_000;

const DAY_MS = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

type Entity = "accounts" | "transactions" | "backfill";

interface StateRow {
  cursor: string | null;
  watermark: string | null;
  window_from: string | null;
  window_days: number | null;
  walk_started_at: string | null;
  requested_days: number | null;
  initial: number;
  rows_seen: number;
  rows_missing: number;
  last_status: string | null;
  last_error: string | null;
}

async function loadState(db: D1Database, connectionId: number, entity: Entity): Promise<StateRow> {
  await db
    .prepare(
      "INSERT INTO revolut_sync_state (connection_id, entity) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
    )
    .bind(connectionId, entity)
    .run();
  const row = await db
    .prepare(
      `SELECT cursor, watermark, window_from, window_days, walk_started_at, requested_days, initial,
              rows_seen, rows_missing, last_status, last_error
       FROM revolut_sync_state WHERE connection_id = ?1 AND entity = ?2`,
    )
    .bind(connectionId, entity)
    .first<StateRow>();
  return row as StateRow;
}

const STATE_COLUMNS = new Set([
  "cursor",
  "watermark",
  "window_from",
  "window_days",
  "walk_started_at",
  "requested_days",
  "initial",
  "last_started_at",
  "last_finished_at",
  "last_completed_at",
  "last_status",
  "last_error",
  "rows_seen",
  "rows_missing",
  "last_missing",
  "calls_used",
]);

async function saveState(
  db: D1Database,
  connectionId: number,
  entity: Entity,
  patch: Record<string, string | number | null>,
): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  for (const k of keys) if (!STATE_COLUMNS.has(k)) throw new Error("unknown state column");
  await db
    .prepare(
      `UPDATE revolut_sync_state SET ${keys.map((k, i) => `${k} = ?${i + 3}`).join(", ")}
       WHERE connection_id = ?1 AND entity = ?2`,
    )
    .bind(connectionId, entity, ...keys.map((k) => patch[k] ?? null))
    .run();
}

/** The one-off backfill asked for at confirmation: picked up by the next backfill run. */
export async function requestBackfill(
  db: D1Database,
  connectionId: number,
  days: number,
): Promise<void> {
  await loadState(db, connectionId, "backfill");
  await db
    .prepare(
      `UPDATE revolut_sync_state SET requested_days = ?3
       WHERE connection_id = ?1 AND entity = ?2`,
    )
    .bind(connectionId, "backfill", days)
    .run();
}

function parseCursor(raw: string | null): TransactionCursor | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as TransactionCursor;
    return v && typeof v.toIso === "string" && Array.isArray(v.seen) ? v : null;
  } catch {
    return null;
  }
}

/** Why a run cannot start, or null when the connection is usable. */
function skipReason(conn: RevolutConnectionRow | null): string | null {
  if (!conn) return "no_connection";
  if (conn.status === "pending") return "pending_confirmation";
  if (conn.status === "needs_reauth") return "needs_reauth";
  if (conn.status !== "active") return "not_active";
  if (conn.last_error === CREDENTIALS_REJECTED) return "credentials_rejected";
  return null;
}

interface Counts {
  seen: number;
  inserted: number;
  updated: number;
  missing: number;
  blocked: number;
  skippedLegs: number;
  /** Rows that could not be stored this run (client mapping or ingest refused), review S2. */
  quarantined: number;
  /** Ids already counted in `quarantined` this run (a row is counted once). */
  quarantinedIds: Set<string>;
  /** Matched final rows that received different data or a different state, review S9. */
  frozenConflicts: number;
}
const zero = (): Counts => ({
  seen: 0,
  inserted: 0,
  updated: 0,
  missing: 0,
  blocked: 0,
  skippedLegs: 0,
  quarantined: 0,
  quarantinedIds: new Set(),
  frozenConflicts: 0,
});

/** Counts rows that could not be stored; a known id counts once per run, however often it is met. */
function noteQuarantined(into: Counts, items: QuarantineItem[]): void {
  for (const it of items) {
    if (it.id !== null) {
      if (into.quarantinedIds.has(it.id)) continue;
      into.quarantinedIds.add(it.id);
    }
    into.quarantined++;
  }
}

/** The code of a run that finished its walk but met data it could not fully use, or null. */
function dataQualityCode(c: Counts): string | null {
  if (c.quarantined > 0) return "rows_quarantined";
  if (c.skippedLegs > 0) return "legs_skipped";
  return null;
}

function addResult(into: Counts, tx: RevolutTransaction, r: IngestResult, nowMs: number): void {
  into.seen++;
  into.inserted += r.inserted;
  into.updated += r.updated;
  const createdMs = Date.parse(normStamp(tx.createdAt) ?? "");
  if (r.missing && Number.isFinite(createdMs) && createdMs < nowMs - MISS_GRACE_MS) {
    into.missing++;
  }
  into.blocked += r.blocked.regress + r.blocked.conflict;
  into.skippedLegs += r.skipped;
  into.frozenConflicts += r.frozenConflicts;
}

/**
 * Ingests a page row by row. A row the ingest refuses (IngestError: too many legs, a bad leg, a bad
 * amount) is quarantined and the rest of the page goes on (review S2); anything else (D1, a lost
 * race) propagates and the page is retried as a whole.
 */
async function ingestAll(
  env: Env,
  connectionId: number,
  txs: RevolutTransaction[],
  source: IngestSource,
  nowMs: number,
  into: Counts,
): Promise<void> {
  const stored: string[] = [];
  const bad: QuarantineItem[] = [];
  for (const tx of txs) {
    try {
      addResult(into, tx, await upsertTransaction(env, connectionId, tx, source, nowMs), nowMs);
      stored.push(tx.id);
    } catch (e) {
      if (!(e instanceof IngestError)) throw e;
      bad.push({ id: tx.id, code: e.code });
    }
  }
  if (bad.length > 0) {
    await recordQuarantine(env.DB, connectionId, bad, iso(nowMs));
    noteQuarantined(into, bad);
  }
  await clearQuarantine(env.DB, connectionId, stored);
}

interface WalkOptions {
  env: Env;
  client: RevolutClient;
  connectionId: number;
  entity: "transactions" | "backfill";
  source: IngestSource;
  from: string;
  count: number;
  maxPages: number;
  signal: AbortSignal;
  deadlineMs: number;
  now: () => number;
  counts: Counts;
  /** Called after each page has been ingested and its cursor saved. */
  onPage?: () => Promise<void>;
}

/**
 * Walks /transactions newest first from the persisted cursor, ingesting each page and saving the
 * cursor after it (so a crash or a stop resumes there). True when the walk reached its end.
 */
async function walk(w: WalkOptions, startCursor: TransactionCursor | null): Promise<boolean> {
  let cursor = startCursor;
  for (let page = 0; page < w.maxPages; page++) {
    if (w.signal.aborted || w.now() >= w.deadlineMs) return false;
    const chunk = await w.client.listTransactionsChunk({
      from: w.from,
      count: w.count,
      cursor,
    });
    await ingestAll(w.env, w.connectionId, chunk.transactions, w.source, w.now(), w.counts);
    if (chunk.rejected.length > 0) {
      await recordQuarantine(w.env.DB, w.connectionId, chunk.rejected, iso(w.now()));
      noteQuarantined(w.counts, chunk.rejected);
    }
    cursor = chunk.nextCursor;
    await saveState(w.env.DB, w.connectionId, w.entity, {
      cursor: cursor === null ? null : JSON.stringify(cursor),
    });
    if (w.onPage) await w.onPage();
    if (cursor === null) return true;
  }
  return false;
}

function outcome(e: unknown): { result: HandlerResult; code: string } {
  const c = classifyRevolutError(e);
  if (e instanceof RevolutAuthError) {
    return { result: { status: "skipped", code: c.code, summary: {} }, code: c.code };
  }
  return {
    result: {
      status: c.retryable ? "partial" : "error",
      code: c.code,
      summary: {},
    },
    code: c.code,
  };
}

// ---------------------------------------------------------------------------------------------
// revolut.sync
// ---------------------------------------------------------------------------------------------

interface AccountRow {
  id: number;
  external_id: string;
  currency: string;
}

async function syncAccounts(
  env: Env,
  client: RevolutClient,
  connectionId: number,
  nowIso: string,
): Promise<{ accounts: number; retired: number; replaced: boolean }> {
  const db = env.DB;
  const list = await client.listAccounts();
  // Review N3: accounts this connection has read before (balance_at is only set by this function)
  // and not one of them is in a complete, non-empty answer: the connection now points at other
  // accounts (re-authorised as a different Revolut business). The old accounts are retired below.
  const previous = (
    await db
      .prepare(
        `SELECT external_id FROM bank_accounts
         WHERE connection_id = ?1 AND is_active = 1 AND balance_at IS NOT NULL`,
      )
      .bind(connectionId)
      .all<{ external_id: string }>()
  ).results;
  const listed = new Set(list.map((a) => a.id));
  const replaced =
    list.length > 0 && previous.length > 0 && !previous.some((p) => listed.has(p.external_id));
  const statements: D1PreparedStatement[] = list.map((a) =>
    db
      .prepare(
        `INSERT INTO bank_accounts (connection_id, external_id, name, currency, balance_minor,
                                    balance_at, state, is_active, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?6, ?6)
         ON CONFLICT (connection_id, external_id) DO UPDATE SET
           name = excluded.name, balance_minor = excluded.balance_minor,
           balance_at = excluded.balance_at, state = excluded.state,
           is_active = excluded.is_active, updated_at = excluded.updated_at`,
      )
      .bind(
        connectionId,
        a.id,
        a.name === "" ? "Revolut account" : a.name,
        a.currency,
        a.balanceMinor,
        nowIso,
        a.state,
        a.state === "inactive" ? 0 : 1,
      ),
  );
  // Retire accounts that are gone, but only after a COMPLETE and non-empty read: an empty answer
  // is more likely a fault than every account closing.
  // The ids travel as ONE JSON bind (json_each): D1 caps bound parameters at 100 per statement.
  if (list.length > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE bank_accounts SET is_active = 0, updated_at = ?2
           WHERE connection_id = ?1 AND is_active = 1
             AND external_id NOT IN (SELECT value FROM json_each(?3))`,
        )
        .bind(connectionId, nowIso, JSON.stringify(list.map((a) => a.id))),
    );
  }
  if (statements.length === 0) return { accounts: 0, retired: 0, replaced: false };
  const out = await db.batch(statements);
  const retired = list.length > 0 ? (out[out.length - 1]?.meta.changes ?? 0) : 0;
  return { accounts: list.length, retired, replaced };
}

/**
 * Review N3, ADR 0034. The connection now points at other accounts: forget where the old walks
 * were (their cursors and windows belong to the old accounts), and ask for the 90-day initial
 * backfill again. The old accounts are inactive and their transactions stay as history under the
 * same connection; nothing is deleted.
 */
export async function resetSyncForReplacedAccounts(
  db: D1Database,
  connectionId: number,
): Promise<void> {
  await loadState(db, connectionId, "transactions");
  await loadState(db, connectionId, "backfill");
  await db
    .prepare(
      `UPDATE revolut_sync_state SET cursor = NULL, watermark = NULL, window_from = NULL,
         window_days = NULL, walk_started_at = NULL, requested_days = NULL, initial = 0,
         rows_seen = 0, rows_missing = 0, last_missing = NULL
       WHERE connection_id = ?1 AND entity IN ('transactions', 'backfill')`,
    )
    .bind(connectionId)
    .run();
  await requestBackfill(db, connectionId, INITIAL_BACKFILL_DAYS);
}

/**
 * The details entry that is the account's OWN IBAN for its currency (review N4): not a pooled
 * (shared) one, and for EUR the SEPA scheme, for other currencies SWIFT. ASSUMPTION (verify with
 * the sandbox, ADR 0030): `pooled` marks shared details and `schemes` lists 'sepa' / 'swift'.
 */
export function pickOwnDetails(
  details: RevolutBankDetails[],
  currency: string,
): RevolutBankDetails | undefined {
  const withIban = details.filter((d) => d.iban !== undefined && d.iban !== "");
  const own = withIban.filter((d) => d.pooled !== true);
  const pool = own.length > 0 ? own : withIban;
  const scheme = currency === "EUR" ? "sepa" : "swift";
  return pool.find((d) => d.schemes.some((x) => x.toLowerCase() === scheme)) ?? pool[0];
}

/**
 * Bank details (IBAN, BIC) for accounts that need a lookup; at most `limit` calls. Review N4: the
 * outcome is kept apart. `ok` stores the IBAN; `no_iban` means Revolut answered and the account
 * has none (a non-SEPA currency): not asked again; `error` means the lookup failed permanently
 * (bad data, a 4xx): asked again after 24 hours, at most 5 times. A transient failure (rate limit,
 * gate, network) records nothing and ends the loop.
 */
async function fillBankDetails(
  env: Env,
  client: RevolutClient,
  connectionId: number,
  limit: number,
  nowMs: number,
): Promise<number> {
  const db = env.DB;
  const nowIso = iso(nowMs);
  const todo = (
    await db
      .prepare(
        `SELECT id, external_id, currency FROM bank_accounts
         WHERE connection_id = ?1 AND is_active = 1 AND iban IS NULL
           AND (details_status IS NULL
                OR (details_status = 'error' AND details_attempts < ?3
                    AND (details_checked_at IS NULL OR details_checked_at <= ?2)))
         ORDER BY id LIMIT ?4`,
      )
      .bind(connectionId, iso(nowMs - DETAILS_RETRY_MS), DETAILS_MAX_ATTEMPTS, limit)
      .all<AccountRow>()
  ).results;
  let filled = 0;
  for (const a of todo) {
    let details: RevolutBankDetails[] | null = null;
    try {
      details = await client.getAccountBankDetails(a.external_id);
    } catch (e) {
      if (classifyRevolutError(e).retryable) break; // try again next run
    }
    const pick = details === null ? undefined : pickOwnDetails(details, a.currency);
    const status = details === null ? "error" : pick ? "ok" : "no_iban";
    const anyBic = details?.find((d) => d.bic !== undefined)?.bic;
    await db
      .prepare(
        `UPDATE bank_accounts SET iban = COALESCE(iban, ?2), bic = COALESCE(bic, ?3),
           details_status = ?4, details_attempts = details_attempts + 1, details_checked_at = ?5
         WHERE id = ?1`,
      )
      .bind(
        a.id,
        pick?.iban?.replace(/\s+/g, "").toUpperCase() ?? null,
        details === null ? null : (pick?.bic ?? anyBic ?? ""),
        status,
        nowIso,
      )
      .run();
    if (pick) filled++;
  }
  return filled;
}

/** Old pending rows (outside the poll window) are refreshed one by one: a missed state change heals. */
async function refreshPending(
  env: Env,
  client: RevolutClient,
  connectionId: number,
  before: string,
  limit: number,
  counts: Counts,
  now: () => number,
  signal: AbortSignal,
): Promise<number> {
  const db = env.DB;
  const rows = (
    await db
      .prepare(
        `SELECT external_id FROM bank_transactions
         WHERE connection_id = ?1 AND state IN ('pending', 'created', 'unknown') AND created_at < ?2
         GROUP BY external_id ORDER BY MIN(COALESCE(last_event_at, first_seen_at)) LIMIT ?3`,
      )
      .bind(connectionId, before, limit)
      .all<{ external_id: string }>()
  ).results;
  let done = 0;
  for (const r of rows) {
    if (signal.aborted) break;
    try {
      const tx = await client.getTransaction(r.external_id);
      await ingestAll(env, connectionId, [tx], "poll", now(), counts);
      done++;
    } catch (e) {
      const c = classifyRevolutError(e);
      if (c.retryable) break;
      // Gone or unreadable: move it to the back of the queue instead of retrying it every run.
      await db
        .prepare(
          `UPDATE bank_transactions SET last_event_at = ?3
           WHERE connection_id = ?1 AND external_id = ?2`,
        )
        .bind(connectionId, r.external_id, iso(now()))
        .run();
    }
  }
  return done;
}

/** True when the previous run of this entity ended the same way (same status and code). */
function sameOutcomeAsBefore(before: StateRow, status: string, code: string | null): boolean {
  return before.last_status === status && (before.last_error ?? null) === code;
}

export async function runRevolutSync(ctx: JobContext): Promise<HandlerResult> {
  const { env } = ctx;
  const db = env.DB;
  const nowMs = ctx.now();
  const conn = await loadRevolutConnection(db);
  const skip = skipReason(conn);
  if (skip !== null || !conn)
    return { status: "skipped", code: skip ?? "no_connection", summary: {} };
  const deadlineMs = Math.min(ctx.deadlineMs, nowMs + RUN_MAX_MS);
  const nowIso = iso(nowMs);
  const counts = zero();
  const summary: Record<string, unknown> = {};
  let job: Awaited<ReturnType<typeof startJobClient>> | null = null;
  let lookupJob: Awaited<ReturnType<typeof startJobClient>> | null = null;
  let result: HandlerResult;
  let errorCode: string | null = null;
  let walkComplete = false;
  let accountsOk = false;
  let retired = 0;
  let walkStarted = nowIso;

  await loadState(db, conn.id, "accounts");
  await saveState(db, conn.id, "accounts", { last_started_at: nowIso, last_status: "running" });
  const before = await loadState(db, conn.id, "transactions");
  await saveState(db, conn.id, "transactions", { last_started_at: nowIso, last_status: "running" });

  try {
    job = await startJobClient(env, conn.id, SYNC_JOB_ID, SYNC_CALL_BUDGET);
    const client = job.client;

    // (a) accounts and balances
    const acc = await syncAccounts(env, client, conn.id, nowIso);
    accountsOk = true;
    retired = acc.retired;
    summary["accounts"] = acc.accounts;
    summary["accountsRetired"] = acc.retired;
    await saveState(db, conn.id, "accounts", {
      last_completed_at: nowIso,
      last_finished_at: nowIso,
      last_status: "ok",
      last_error: null,
    });
    if (acc.replaced) {
      // Review N3: other accounts than before. Old cursors are meaningless; walk 90 days again.
      summary["accountsReplaced"] = true;
      await resetSyncForReplacedAccounts(db, conn.id);
      await auditStatement(db, {
        actorEmail: "system",
        action: "revolut.accounts_replaced",
        entity: "connection",
        entityId: conn.id,
        after: { accounts: acc.accounts, retired: acc.retired },
      })
        .run()
        .catch(() => undefined);
      await queueInitialBackfill(env, conn.id, "system", nowMs).catch(() => undefined);
    }
    summary["ibansFilled"] = await fillBankDetails(
      env,
      client,
      conn.id,
      SYNC_DETAILS_PER_RUN,
      nowMs,
    );

    // (b) transactions newer than the watermark minus the overlap, resumable. A walk is in
    // progress when its window was stored, with or without a cursor (the first page may have
    // failed): the window must not slide (review S1).
    const tstate = await loadState(db, conn.id, "transactions");
    const resume = parseCursor(tstate.cursor);
    const hasWalk = tstate.window_from !== null && tstate.walk_started_at !== null;
    const from = hasWalk
      ? (tstate.window_from as string)
      : iso(
          tstate.watermark !== null && !Number.isNaN(Date.parse(tstate.watermark))
            ? Date.parse(tstate.watermark) - POLL_OVERLAP_MS
            : nowMs - FIRST_POLL_LOOKBACK_MS,
        );
    walkStarted = hasWalk ? (tstate.walk_started_at as string) : nowIso;
    if (!hasWalk) {
      await saveState(db, conn.id, "transactions", {
        cursor: null,
        window_from: from,
        walk_started_at: walkStarted,
      });
    }
    walkComplete = await walk(
      {
        env,
        client,
        connectionId: conn.id,
        entity: "transactions",
        source: "poll",
        from,
        count: SYNC_PAGE_SIZE,
        maxPages: SYNC_MAX_PAGES,
        signal: ctx.signal,
        deadlineMs,
        now: ctx.now,
        counts,
      },
      hasWalk ? resume : null,
    );

    // (c) old pending rows
    summary["pendingRefreshed"] = await refreshPending(
      env,
      client,
      conn.id,
      from,
      SYNC_PENDING_REFRESH,
      counts,
      ctx.now,
      ctx.signal,
    );

    // (d) one quarantined row is read again (review S2); it leaves the quarantine when it stores
    const retry = await retryQuarantined(
      db,
      client,
      conn.id,
      QUARANTINE_RETRIES_PER_RUN,
      ctx.now(),
      ctx.signal,
      counts.quarantinedIds,
      async (tx) => {
        const at = ctx.now();
        addResult(counts, tx, await upsertTransaction(env, conn.id, tx, "poll", at), at);
      },
    );
    noteQuarantined(
      counts,
      retry.stillBad.map((id) => ({ id, code: "bad_shape" })),
    );
    summary["quarantineRetried"] = retry.tried;
    summary["quarantineCleared"] = retry.cleared;

    // (e) counterparty IBANs for matching (review S6): own job id, own small budget
    try {
      const refs = await counterpartiesToLookUp(
        db,
        conn.id,
        ctx.now(),
        COUNTERPARTY_LOOKUPS_PER_RUN,
      );
      if (refs.length > 0 && !ctx.signal.aborted) {
        lookupJob = await startJobClient(
          env,
          conn.id,
          COUNTERPARTY_LOOKUP_JOB_ID,
          COUNTERPARTY_LOOKUPS_PER_RUN,
        );
        const l = await lookUpCounterparties(
          db,
          lookupJob.client,
          conn.id,
          refs,
          ctx.now(),
          ctx.signal,
        );
        summary["counterpartyLookups"] = l.looked;
        summary["counterpartiesResolved"] = l.resolved;
        summary["counterpartyIbansFilled"] = l.filled;
      } else {
        summary["counterpartyIbansFilled"] = await applyCounterpartyCache(db, conn.id);
      }
    } catch (e) {
      if (e instanceof RevolutAuthError) throw e;
      // Best effort: a failed lookup never fails the sync; the next run tries again.
      summary["counterpartyLookupError"] = classifyRevolutError(e).code;
    }

    summary["complete"] = walkComplete;
    const quality = dataQualityCode(counts);
    result = walkComplete
      ? quality === null
        ? { status: "ok", summary }
        : { status: "partial", code: quality, summary }
      : { status: "partial", code: "walk_incomplete", summary };
  } catch (e) {
    const o = outcome(e);
    errorCode = o.code;
    result = { ...o.result, summary };
  }

  const calls = ((await job?.end()) ?? 0) + ((await lookupJob?.end()) ?? 0);
  const finishedIso = iso(ctx.now());
  summary["seen"] = counts.seen;
  summary["inserted"] = counts.inserted;
  summary["updated"] = counts.updated;
  summary["blocked"] = counts.blocked;
  summary["quarantined"] = counts.quarantined;
  summary["skippedLegs"] = counts.skippedLegs;
  summary["frozenConflicts"] = counts.frozenConflicts;
  summary["calls"] = calls;
  summary["quarantineOpen"] = await quarantineCounts(db, conn.id)
    .then((q) => q.open)
    .catch(() => null);
  result = { ...result, summary, callsUsed: calls };

  const tPatch: Record<string, string | number | null> = {
    last_finished_at: finishedIso,
    last_status: result.status === "skipped" ? "skipped" : result.status,
    last_error: errorCode ?? result.code ?? null,
    rows_seen: counts.seen,
    calls_used: calls,
  };
  if (walkComplete) {
    tPatch["last_completed_at"] = finishedIso;
    tPatch["watermark"] = walkStarted;
    tPatch["window_from"] = null;
    tPatch["walk_started_at"] = null;
  }
  await saveState(db, conn.id, "transactions", tPatch).catch(() => undefined);
  if (!accountsOk) {
    await saveState(db, conn.id, "accounts", {
      last_finished_at: finishedIso,
      last_status: result.status === "skipped" ? "skipped" : "error",
      last_error: errorCode,
    }).catch(() => undefined);
  }

  // One summary audit row for a run that changed something, or that did not end ok in a way the
  // previous run did not already report (a quiet poll every ten minutes, or the same standing
  // problem every ten minutes, would only add noise).
  const changed = counts.inserted + counts.updated + retired > 0;
  const code = errorCode ?? result.code ?? null;
  if (changed || (result.status !== "ok" && !sameOutcomeAsBefore(before, result.status, code))) {
    await auditStatement(db, {
      actorEmail: "system",
      action: "revolut.sync_run",
      entity: "connection",
      entityId: conn.id,
      after: {
        status: result.status,
        failure: result.code ?? null,
        inserted: counts.inserted,
        updated: counts.updated,
        retired,
        quarantined: counts.quarantined,
        skippedLegs: counts.skippedLegs,
        frozenConflicts: counts.frozenConflicts,
        calls,
      },
    })
      .run()
      .catch(() => undefined);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// revolut.backfill
// ---------------------------------------------------------------------------------------------

export async function runRevolutBackfill(ctx: JobContext): Promise<HandlerResult> {
  const { env } = ctx;
  const db = env.DB;
  const nowMs = ctx.now();
  const conn = await loadRevolutConnection(db);
  const skip = skipReason(conn);
  if (skip !== null || !conn)
    return { status: "skipped", code: skip ?? "no_connection", summary: {} };
  const deadlineMs = Math.min(ctx.deadlineMs, nowMs + RUN_MAX_MS);
  const nowIso = iso(nowMs);
  const state = await loadState(db, conn.id, "backfill");

  // Resume a walk in progress; otherwise start one. A walk is in progress as soon as its window is
  // stored, even if no page ever succeeded and no cursor was saved (review S1): it then restarts
  // from its first page with the SAME bounds and the same initial flag, so a failing first page
  // can never turn the 90-day initial backfill into a 35-day walk. The window comes from the slot,
  // not the clock (handler contract rule 3). The one-off request (`requested_days`) is cleared only
  // when an initial walk COMPLETES.
  const resume = parseCursor(state.cursor);
  const resuming = state.window_from !== null;
  let from: string;
  let days: number;
  let initial: boolean;
  const counts = zero();
  if (resuming) {
    from = state.window_from as string;
    days = state.window_days ?? BACKFILL_DAYS;
    initial = state.initial === 1;
    counts.missing = state.rows_missing;
  } else {
    days = state.requested_days ?? BACKFILL_DAYS;
    initial = state.requested_days !== null;
    from = iso(scheduledForMs(ctx) - days * DAY_MS);
    await saveState(db, conn.id, "backfill", {
      cursor: null,
      window_from: from,
      window_days: days,
      walk_started_at: nowIso,
      initial: initial ? 1 : 0,
      rows_seen: 0,
      rows_missing: 0,
    });
  }
  await saveState(db, conn.id, "backfill", { last_started_at: nowIso, last_status: "running" });
  const seenBefore = resuming ? state.rows_seen : 0;

  let job: Awaited<ReturnType<typeof startJobClient>> | null = null;
  let result: HandlerResult;
  let complete = false;
  let errorCode: string | null = null;
  try {
    job = await startJobClient(env, conn.id, BACKFILL_JOB_ID, BACKFILL_CALL_BUDGET);
    complete = await walk(
      {
        env,
        client: job.client,
        connectionId: conn.id,
        entity: "backfill",
        source: "backfill",
        from,
        count: BACKFILL_PAGE_SIZE,
        maxPages: BACKFILL_MAX_PAGES,
        signal: ctx.signal,
        deadlineMs,
        now: ctx.now,
        counts,
        onPage: () =>
          saveState(db, conn.id, "backfill", {
            rows_seen: seenBefore + counts.seen,
            rows_missing: counts.missing,
          }),
      },
      resuming ? resume : null,
    );
    const quality = dataQualityCode(counts);
    result = complete
      ? quality === null
        ? { status: "ok", summary: {} }
        : { status: "partial", code: quality, summary: {} }
      : {
          status: "partial",
          // The initial 90-day walk is usually a manual run, which the runner never retries: its
          // own code makes the stop visible in Settings > Schedules, and the stored window and
          // cursor are resumed by the next run of the job (the daily slot or another "Run now").
          code: initial ? "initial_backfill_incomplete" : "walk_incomplete",
          retry: { delaySeconds: BACKFILL_RETRY_SECONDS },
          summary: {},
        };
  } catch (e) {
    const o = outcome(e);
    errorCode = o.code;
    result = {
      ...o.result,
      ...(o.result.status === "partial"
        ? {
            retry: {
              delaySeconds: Math.max(BACKFILL_RETRY_SECONDS, classifyRevolutError(e).delaySeconds),
            },
          }
        : {}),
      summary: {},
    };
  }
  const calls = (await job?.end()) ?? 0;
  const finished = iso(ctx.now());
  const totalSeen = seenBefore + counts.seen;
  // `missing` is the walk's running total (it was seeded with the stored count when resuming).
  result = {
    ...result,
    callsUsed: calls,
    summary: {
      windowDays: days,
      initial,
      complete,
      seen: counts.seen,
      missing: counts.missing,
      inserted: counts.inserted,
      updated: counts.updated,
      blocked: counts.blocked,
      quarantined: counts.quarantined,
      skippedLegs: counts.skippedLegs,
      frozenConflicts: counts.frozenConflicts,
      calls,
    },
  };
  const patch: Record<string, string | number | null> = {
    last_finished_at: finished,
    last_status: result.status,
    last_error: errorCode ?? result.code ?? null,
    rows_seen: totalSeen,
    rows_missing: counts.missing,
    calls_used: calls,
  };
  if (complete) {
    patch["last_completed_at"] = finished;
    patch["cursor"] = null;
    patch["window_from"] = null;
    patch["walk_started_at"] = null;
    // The one-off request is satisfied only by a COMPLETE initial walk.
    if (initial) patch["requested_days"] = null;
    // The data-quality signal: transactions Revolut has that we never received (daily walks only;
    // everything is "missing" in the initial backfill).
    if (!initial) patch["last_missing"] = counts.missing;
  }
  await saveState(db, conn.id, "backfill", patch).catch(() => undefined);

  const code = errorCode ?? result.code ?? null;
  if (
    counts.inserted + counts.updated > 0 ||
    (result.status !== "ok" && !sameOutcomeAsBefore(state, result.status, code))
  ) {
    await auditStatement(db, {
      actorEmail: "system",
      action: "revolut.backfill_run",
      entity: "connection",
      entityId: conn.id,
      after: {
        status: result.status,
        failure: result.code ?? null,
        windowDays: days,
        initial,
        complete,
        missing: counts.missing,
        inserted: counts.inserted,
        updated: counts.updated,
        quarantined: counts.quarantined,
        skippedLegs: counts.skippedLegs,
        frozenConflicts: counts.frozenConflicts,
      },
    })
      .run()
      .catch(() => undefined);
  }
  return result;
}
