/**
 * Ledger sync (Phase 4, task K2, ADR 0024): the chart of accounts, reporting balances and budgets
 * of one division, for the balance sheet and profit and loss reports. Part of FULL sync cycles
 * only (the hourly incremental run never reads ledger data), after open items and relations:
 *
 *   gl_accounts  financial/GLAccounts, read completely every cycle.
 *   gl_balances  financial/ReportingBalance of the CURRENT reporting year every cycle, and of the
 *                PREVIOUS year only when it was never read completely, the last complete read is
 *                a week old (the year-end figures only move through late adjustments; we cannot
 *                cheaply see whether the year-end period changed, so "at most weekly" is the
 *                rule), or, while the old year is still being booked, EVERY night: when the
 *                current Amsterdam month is at most `exact.prior_year_nightly_until_month`
 *                (default 4 = April, review S4). The reporting year is the Amsterdam calendar
 *                year (assumption).
 *   gl_budgets   budget/Budgets of the current year, at most weekly. OPTIONAL: the module may not
 *                be licensed. When the very first page of a pass answers 400, 403 or 404 the
 *                entity is marked unavailable for a week (sync_state.unavailable_until) and the
 *                reports simply have no budget column. A manual full sync with `restart` tries
 *                again at once.
 *
 * Every read is a resumable pass like the open-item lists: after each chunk of pages the rows,
 * the `$skiptoken` and the progress are written in one D1 batch, guarded by the sync lease, so a
 * stop anywhere (budget, rate limit, deadline) loses nothing and the next run of the same cycle
 * continues. A pass of the balances carries its year in the saved token (`<year>:<token>`).
 *
 * A saved pass may be continued in a later full cycle while it is younger than
 * LEDGER_PASS_MAX_AGE_MS (a large ledger needs more than the two nights a 36-hour cycle allows).
 *
 * Rows Exact no longer returns: only a COMPLETE read counts. Rows the pass did not see (last seen
 * before the pass started) get a strike (the pass marker makes a strike idempotent, so a crash
 * between statements cannot double it); after two strikes (one when the pass ran in a single run,
 * or with `allowLargeClose`) an account is marked inactive (never deleted: its history stays) and
 * a balance or budget row is deleted. A read that returned nothing at all while we hold rows
 * changes nothing and is not recorded as complete, and the close guard of the open items (more
 * than max(5, 20 %) at once) applies here too.
 *
 * Money: integer minor units at the scale of the division currency. Sign: debit - credit
 * (assumption). Field and resource names: all to verify with credentials (ADR 0024).
 */
import { ExactApiError } from "@camelthorn/exact";
import type {
  BudgetRow,
  ExactClient,
  GlAccount,
  ListChunk,
  ReportingBalanceRow,
} from "@camelthorn/exact";
import { amsterdamParts, sumMinor } from "@camelthorn/core";
import type { EntityResult } from "./sync";
import { type Lease, type SubrequestMeter, closeAllowed, leaseHeld, runBatches } from "./sync-util";

export type LedgerEntityName = "gl_accounts" | "gl_balances" | "gl_budgets";
export const LEDGER_ENTITIES: readonly LedgerEntityName[] = [
  "gl_accounts",
  "gl_balances",
  "gl_budgets",
];
export const isLedgerEntity = (e: string): e is LedgerEntityName =>
  (LEDGER_ENTITIES as readonly string[]).includes(e);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** The previous year's balances and the budgets are read again after this long. */
export const LEDGER_REFRESH_MS = WEEK_MS;
/** How long budgets are left alone after Exact refused the resource. */
export const BUDGETS_UNAVAILABLE_MS = WEEK_MS;
/** Statuses of the first budget page that mean "no budgets here" (not licensed, not found). */
export const BUDGETS_UNAVAILABLE_STATUSES: readonly number[] = [400, 403, 404];
/**
 * Codes of 400s that our own gate raises (request validation, a wrong gate): they say nothing about
 * Exact's budget module, so they never mark budgets unavailable.
 */
export const GATE_REJECT_CODES: ReadonlySet<string> = new Set([
  "division_mismatch",
  "method",
  "division",
  "api",
  "priority",
  "job_id",
  "path",
  "query",
  "header",
  "body",
  "host",
  "budget",
]);
/**
 * How long a saved ledger pass may be resumed, across full cycles (review K2). A full cycle is
 * abandoned after 36 hours (CYCLE_MAX_AGE_MS), so without this a ledger that needs more than two
 * nights of the scheduled budget (about 1,750 ledger calls at pages of 60, ADR 0024) would restart
 * every other night and never finish. Five days lets a ledger of roughly four nights finish and
 * stays below the weekly refresh of the previous year and the budgets. Rows the pass has not seen
 * are judged against the pass's own start (pass_seq), not the cycle's, so an old pass never strikes
 * a row it saw days ago; a pass that ran over more than one run needs two strikes anyway.
 */
export const LEDGER_PASS_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const MAX_CHUNKS = 200;

/**
 * Setting (integer 0 to 12, default 4): while the current Amsterdam month is at most this, the
 * previous year's balances are read in every full cycle instead of weekly (the old year is still
 * being booked, review S4). 0 switches the nightly read off. Admin-editable through PUT
 * /api/sync/settings (audited).
 */
export const PRIOR_YEAR_NIGHTLY_UNTIL_MONTH_KEY = "exact.prior_year_nightly_until_month";
export const PRIOR_YEAR_NIGHTLY_UNTIL_MONTH_DEFAULT = 4;

/** The stored month limit; the default for a missing, malformed or out-of-range value. */
export async function readPriorYearNightlyUntilMonth(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value_json FROM settings WHERE key = ?1")
    .bind(PRIOR_YEAR_NIGHTLY_UNTIL_MONTH_KEY)
    .first<{ value_json: string }>();
  if (!row) return PRIOR_YEAR_NIGHTLY_UNTIL_MONTH_DEFAULT;
  try {
    const v: unknown = JSON.parse(row.value_json);
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 12
      ? v
      : PRIOR_YEAR_NIGHTLY_UNTIL_MONTH_DEFAULT;
  } catch {
    return PRIOR_YEAR_NIGHTLY_UNTIL_MONTH_DEFAULT;
  }
}

/** Amsterdam calendar month (1 to 12) of an instant. */
export const reportingMonth = (ms: number): number => Number(amsterdamParts(ms).date.slice(5, 7));

/** Exact list pages hold about this many rows (assumption, ADR 0017); used for estimates only. */
export const LEDGER_PAGE_SIZE_GUESS = 60;
export const LEDGER_PERIODS_GUESS = 12;

/**
 * Exact calls for one ledger pass set: the chart plus `years` years of balances (accounts x
 * periods rows each, the opening period counted in the 12 for a rough figure). 300 accounts: 5 +
 * 60 per year. Budgets (profit and loss accounts only, weekly) are estimated the same way.
 */
export function estimateLedgerCalls(p: {
  accounts: number;
  balanceYears: number;
  budgetAccounts?: number;
  periods?: number;
  pageSize?: number;
}): number {
  const size = p.pageSize ?? LEDGER_PAGE_SIZE_GUESS;
  const periods = p.periods ?? LEDGER_PERIODS_GUESS;
  const pages = (rows: number): number => Math.ceil(rows / size);
  return (
    pages(p.accounts) +
    p.balanceYears * pages(p.accounts * periods) +
    pages((p.budgetAccounts ?? 0) * periods)
  );
}

/** The part of sync_state a ledger pass reads. */
export interface LedgerStateRow {
  pass_cycle: number | null;
  pass_token: string | null;
  pass_rows: number;
  unavailable_until: string | null;
  pass_seq: number | null;
  pass_started_at: string | null;
}

/** The pass a ledger entity is in: resumed from its saved token, or a new one from page 1. */
interface PassInfo {
  resuming: boolean;
  token: string | null;
  /** Rows read in this pass before this run (the chunk id of the first chunk). */
  readBefore: number;
  /** run_seq of the run that started the pass: rows last seen before it were not seen by it. */
  seq: number;
  startedAt: string;
}

function passInfo(ctx: LedgerCtx, entity: LedgerEntityName, scope: string): PassInfo {
  const st = ctx.state.get(entity);
  const saved = st?.pass_token ?? "";
  const fits = saved.startsWith(scope) && saved.length > scope.length;
  const sameCycle = st?.pass_cycle === ctx.cycle;
  const startedMs = st?.pass_started_at ? Date.parse(st.pass_started_at) : NaN;
  const young =
    !ctx.restart &&
    st?.pass_seq != null &&
    !Number.isNaN(startedMs) &&
    ctx.nowMs() - startedMs < LEDGER_PASS_MAX_AGE_MS;
  if (st === undefined || !fits || !(sameCycle || young)) {
    return {
      resuming: false,
      token: null,
      readBefore: 0,
      seq: ctx.runSeq,
      startedAt: ctx.startedAt,
    };
  }
  return {
    resuming: true,
    token: saved.slice(scope.length),
    readBefore: st.pass_rows,
    seq: st.pass_seq ?? (ctx.cycle as number),
    startedAt: st.pass_started_at ?? ctx.startedAt,
  };
}

/** What the ledger entities need from a sync run (sync.ts's Ctx satisfies it). */
export interface LedgerCtx {
  db: D1Database;
  client: ExactClient;
  division: { id: number };
  restart: boolean;
  runSeq: number;
  lease: Lease;
  cycle: number | null;
  startedAt: string;
  nowIso: () => string;
  nowMs: () => number;
  chunkPages: number;
  state: Map<string, LedgerStateRow>;
  pastDeadline: () => boolean;
  /** Rows written so far for the entity being synced. */
  progress: number;
  pass: { read: number; total: number | null } | null;
  meter: SubrequestMeter;
  allowLargeClose: boolean;
}

const clip = (v: string | null, n: number): string | null => (v === null ? null : v.slice(0, n));

// ---------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------

function accountStmt(ctx: LedgerCtx, a: GlAccount, nowIso: string): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO gl_accounts (division_id, exact_id, code, name, type, type_description,
         balance_side, balance_type, is_blocked, is_active, last_seen_sync_id, missed_cycles,
         strike_cycle, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, 0, NULL, ?11)
       ON CONFLICT (division_id, exact_id) DO UPDATE SET
         code = excluded.code, name = excluded.name, type = excluded.type,
         type_description = excluded.type_description, balance_side = excluded.balance_side,
         balance_type = excluded.balance_type, is_blocked = excluded.is_blocked, is_active = 1,
         last_seen_sync_id = excluded.last_seen_sync_id, missed_cycles = 0, strike_cycle = NULL,
         updated_at = excluded.updated_at
       WHERE excluded.last_seen_sync_id >= COALESCE(gl_accounts.last_seen_sync_id, 0)`,
    )
    .bind(
      ctx.division.id,
      a.id,
      clip(a.code, 40),
      clip(a.name, 200) || clip(a.code, 40) || "(no name)",
      a.type,
      clip(a.typeDescription, 100),
      a.balanceSide,
      a.balanceType,
      a.isBlocked ? 1 : 0,
      ctx.runSeq,
      nowIso,
    );
}

/**
 * Rows of one chunk with the same key are one figure split over a dimension we do not select: they
 * are added (and flagged, `merged`). Across chunks the later one wins (see splitExpr).
 */
function mergeBalances(
  items: readonly ReportingBalanceRow[],
  year: number,
): (ReportingBalanceRow & { merged: boolean })[] {
  const groups = new Map<string, ReportingBalanceRow[]>();
  for (const it of items) {
    if (it.reportingYear !== year) continue; // the filter was ignored for this row: not ours
    const key = `${it.glAccountId}|${it.reportingPeriod}|${it.dimension}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [it]);
    else g.push(it);
  }
  return [...groups.values()].map((g) => {
    const first = g[0] as ReportingBalanceRow;
    if (g.length === 1) return { ...first, merged: false };
    const all = (pick: (r: ReportingBalanceRow) => number | null): number | null =>
      g.some((r) => pick(r) === null) ? null : sumMinor(g.map((r) => pick(r) as number));
    const debit = all((r) => r.debit?.minor ?? null);
    const credit = all((r) => r.credit?.minor ?? null);
    return {
      ...first,
      amount: { minor: sumMinor(g.map((r) => r.amount.minor)), currency: first.amount.currency },
      debit: debit === null ? null : { minor: debit, currency: first.amount.currency },
      credit: credit === null ? null : { minor: credit, currency: first.amount.currency },
      balanceType: first.balanceType ?? g.find((r) => r.balanceType !== null)?.balanceType ?? null,
      merged: true,
    };
  });
}

/** Where a row was written in its pass (see split_key in migration 0010). */
interface ChunkRef {
  seq: number;
  chunk: number;
}

/**
 * split_key: 1 when the same key arrives twice in one pass, in different chunks (or it was merged
 * inside a chunk, `merged`). A re-read of the same chunk (same pass, same chunk id, for example
 * after a crash between its batches) is an overwrite, not a split. The amount itself is always
 * the latest chunk's (idempotent: a page served twice must not count twice), so a split key may
 * under-count; the reports show how many there are instead of guessing.
 */
const splitExpr = (table: string): string =>
  `CASE WHEN ${table}.pass_seq = excluded.pass_seq
             AND (${table}.pass_chunk <> excluded.pass_chunk OR ${table}.split_key = 1)
        THEN 1 ELSE excluded.split_key END`;

function balanceStmt(
  ctx: LedgerCtx,
  b: ReportingBalanceRow & { merged: boolean },
  nowIso: string,
  at: ChunkRef,
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO gl_balances (division_id, gl_account_exact_id, year, period, dimension,
         amount_minor, debit_minor, credit_minor, currency, balance_type, last_seen_sync_id,
         missed_cycles, strike_cycle, updated_at, pass_seq, pass_chunk, split_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, NULL, ?12, ?13, ?14, ?15)
       ON CONFLICT (division_id, gl_account_exact_id, year, period, dimension) DO UPDATE SET
         amount_minor = excluded.amount_minor, debit_minor = excluded.debit_minor,
         credit_minor = excluded.credit_minor, currency = excluded.currency,
         balance_type = excluded.balance_type, last_seen_sync_id = excluded.last_seen_sync_id,
         missed_cycles = 0, strike_cycle = NULL, updated_at = excluded.updated_at,
         split_key = ${splitExpr("gl_balances")},
         pass_seq = excluded.pass_seq, pass_chunk = excluded.pass_chunk
       WHERE excluded.last_seen_sync_id >= COALESCE(gl_balances.last_seen_sync_id, 0)`,
    )
    .bind(
      ctx.division.id,
      b.glAccountId,
      b.reportingYear,
      b.reportingPeriod,
      b.dimension.slice(0, 120),
      b.amount.minor,
      b.debit === null ? null : b.debit.minor,
      b.credit === null ? null : b.credit.minor,
      b.amount.currency,
      b.balanceType,
      ctx.runSeq,
      nowIso,
      at.seq,
      at.chunk,
      b.merged ? 1 : 0,
    );
}

function mergeBudgets(
  items: readonly BudgetRow[],
  year: number,
): (BudgetRow & { merged: boolean })[] {
  const groups = new Map<string, BudgetRow[]>();
  for (const it of items) {
    if (it.reportingYear !== year) continue;
    const key = `${it.glAccountId}|${it.reportingPeriod}|${it.scenario}|${it.dimension}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [it]);
    else g.push(it);
  }
  return [...groups.values()].map((g) => {
    const first = g[0] as BudgetRow;
    return g.length === 1
      ? { ...first, merged: false }
      : {
          ...first,
          amount: {
            minor: sumMinor(g.map((r) => r.amount.minor)),
            currency: first.amount.currency,
          },
          merged: true,
        };
  });
}

function budgetStmt(
  ctx: LedgerCtx,
  b: BudgetRow & { merged: boolean },
  nowIso: string,
  at: ChunkRef,
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO gl_budgets (division_id, gl_account_exact_id, year, period, scenario, dimension,
         amount_minor, currency, last_seen_sync_id, missed_cycles, strike_cycle, updated_at,
         pass_seq, pass_chunk, split_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL, ?10, ?11, ?12, ?13)
       ON CONFLICT (division_id, gl_account_exact_id, year, period, scenario, dimension)
       DO UPDATE SET amount_minor = excluded.amount_minor, currency = excluded.currency,
         last_seen_sync_id = excluded.last_seen_sync_id, missed_cycles = 0, strike_cycle = NULL,
         updated_at = excluded.updated_at, split_key = ${splitExpr("gl_budgets")},
         pass_seq = excluded.pass_seq, pass_chunk = excluded.pass_chunk
       WHERE excluded.last_seen_sync_id >= COALESCE(gl_budgets.last_seen_sync_id, 0)`,
    )
    .bind(
      ctx.division.id,
      b.glAccountId,
      b.reportingYear,
      b.reportingPeriod,
      b.scenario,
      b.dimension.slice(0, 120),
      b.amount.minor,
      b.amount.currency,
      ctx.runSeq,
      nowIso,
      at.seq,
      at.chunk,
      b.merged ? 1 : 0,
    );
}

/** Saves a resumable pass (same batch as the rows it covers); only while the lease is held. */
function passStmt(
  ctx: LedgerCtx,
  entity: LedgerEntityName,
  token: string | null,
  rows: number,
  pass: PassInfo,
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO sync_state (division_id, entity, mode, last_started_at, last_status,
         pass_cycle, pass_token, pass_rows, pass_total, pass_seq, pass_started_at)
       SELECT ?1, ?2, 'full', ?3, 'partial', ?4, ?5, ?6, NULL, ?9, ?10 WHERE ${leaseHeld("?7", "?8")}
       ON CONFLICT (division_id, entity) DO UPDATE SET
         pass_cycle = excluded.pass_cycle, pass_token = excluded.pass_token,
         pass_rows = excluded.pass_rows, pass_total = NULL, pass_seq = excluded.pass_seq,
         pass_started_at = excluded.pass_started_at
       WHERE ${leaseHeld("?7", "?8")}`,
    )
    .bind(
      ctx.division.id,
      entity,
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

// ---------------------------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------------------------

interface PassSpec<T> {
  entity: LedgerEntityName;
  /** Prefix of the saved token: "" for the chart, "<year>:" for a year of balances or budgets. */
  scope: string;
  read: (token: string | null, maxPages: number) => Promise<ListChunk<T>>;
  upserts: (items: T[], nowIso: string, at: ChunkRef) => D1PreparedStatement[];
  /** After a complete read: the strike and bookkeeping statements, or what stopped them. */
  finish: (info: { rows: number; singleRun: boolean; pass: PassInfo }) => Promise<Finish>;
  /** Called when the first page of a fresh pass fails; true = handled, the pass is skipped. */
  firstPageError?: (e: unknown) => Promise<boolean>;
}

/**
 * "close_guard": too much would go at once. "empty": Exact answered nothing at all while we hold
 * rows: nothing changes and the read is NOT recorded as complete (freshness does not move).
 */
type Finish = D1PreparedStatement[] | "close_guard" | "empty";

type Outcome =
  | { kind: "done"; rows: number; empty: boolean }
  | { kind: "partial"; rows: number; code: string }
  | { kind: "guard"; rows: number }
  | { kind: "skipped"; rows: number };

async function runPass<T>(ctx: LedgerCtx, spec: PassSpec<T>): Promise<Outcome> {
  const pass = passInfo(ctx, spec.entity, spec.scope);
  let token = pass.token;
  let readTotal = pass.readBefore;
  let rows = 0;
  ctx.pass = { read: readTotal, total: null };
  const nowIso = ctx.nowIso();
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    if (ctx.pastDeadline()) return { kind: "partial", rows, code: "time_limit" };
    let page: ListChunk<T>;
    try {
      page = await spec.read(token, ctx.chunkPages);
    } catch (e) {
      if (token === null && chunk === 0 && spec.firstPageError && (await spec.firstPageError(e))) {
        return { kind: "skipped", rows };
      }
      throw e;
    }
    // The chunk id is the number of rows of the pass read before it: the same when a chunk is
    // read again after a crash, different for every other chunk of the pass.
    const at: ChunkRef = { seq: pass.seq, chunk: readTotal };
    readTotal += page.items.length;
    const units = spec.upserts(page.items, nowIso, at).map((s) => [s]);
    units.push([
      passStmt(
        ctx,
        spec.entity,
        page.nextToken === null ? null : `${spec.scope}${page.nextToken}`,
        readTotal,
        pass,
      ),
    ]);
    await runBatches(ctx.db, ctx.meter, units);
    rows += page.items.length;
    ctx.progress += page.items.length;
    ctx.pass = { read: readTotal, total: null };
    if (page.error !== undefined) throw page.error;
    if (page.complete) {
      const fin = await spec.finish({ rows: readTotal, singleRun: !pass.resuming, pass });
      if (fin === "close_guard") return { kind: "guard", rows };
      if (fin === "empty") return { kind: "done", rows, empty: true };
      if (fin.length > 0)
        await runBatches(
          ctx.db,
          ctx.meter,
          fin.map((s) => [s]),
        );
      return { kind: "done", rows, empty: false };
    }
    token = page.nextToken;
  }
  return { kind: "partial", rows, code: "chunk_limit" };
}

/** Small helper for numbered SQL parameters; ?1 is always the division. */
function binder(division: number): {
  p: (v: string | number | null) => string;
  vals: (string | number | null)[];
} {
  const vals: (string | number | null)[] = [division];
  return {
    vals,
    p: (v) => {
      vals.push(v);
      return `?${vals.length}`;
    },
  };
}

/**
 * Strike and prune statements after a COMPLETE read (see the file comment). `year` null for the
 * chart. "Not seen" means last seen before the PASS started (pass.seq), which for a pass inside one
 * cycle is at or after the cycle's start; a pass resumed across cycles keeps its own start, so
 * rows it read days ago are not struck. Returns "close_guard" when too much would go at once and
 * "empty" for an answer without any row while we hold some.
 */
async function finishStrikes(
  ctx: LedgerCtx,
  cfg: {
    table: "gl_accounts" | "gl_balances" | "gl_budgets";
    year: number | null;
    rows: number;
    singleRun: boolean;
    pass: PassInfo;
    extra: (splitKeys: number) => D1PreparedStatement[];
  },
): Promise<Finish> {
  const since = cfg.pass.seq;
  const live = cfg.table === "gl_accounts" ? " AND is_active = 1" : "";
  const scope = (b: ReturnType<typeof binder>): string =>
    cfg.year === null ? "" : ` AND year = ${b.p(cfg.year)}`;
  const c = binder(ctx.division.id);
  const split =
    cfg.table === "gl_accounts"
      ? "0"
      : `COALESCE(SUM(CASE WHEN split_key = 1 AND pass_seq = ${c.p(since)} THEN 1 ELSE 0 END), 0)`;
  ctx.meter.used += 1;
  const counts = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS held,
              COALESCE(SUM(CASE WHEN COALESCE(last_seen_sync_id, 0) < ${c.p(since)} THEN 1 ELSE 0 END), 0)
                AS stale,
              ${split} AS split
       FROM ${cfg.table} WHERE division_id = ?1${live}${scope(c)}`,
    )
    .bind(...c.vals)
    .first<{ held: number; stale: number; split: number }>();
  const held = counts?.held ?? 0;
  const stale = counts?.stale ?? 0;
  // An answer with no rows at all is far more likely a fault (wrong division, licence) than "the
  // whole ledger is gone": change nothing, and do not record it as a complete read either (so the
  // freshness of what we hold does not move and the next cycle asks again).
  if (cfg.rows === 0 && held > 0) return "empty";
  if (stale > 0 && !ctx.allowLargeClose && !closeAllowed(stale, held)) return "close_guard";

  const need = cfg.singleRun || ctx.allowLargeClose ? 1 : 2;
  const s = binder(ctx.division.id);
  const strike = ctx.db
    .prepare(
      `UPDATE ${cfg.table} SET missed_cycles = missed_cycles + 1, strike_cycle = ${s.p(since)}
       WHERE division_id = ?1${live}${scope(s)}
         AND COALESCE(last_seen_sync_id, 0) < ${s.p(since)}
         AND COALESCE(strike_cycle, 0) <> ${s.p(since)}
         AND ${leaseHeld(s.p(ctx.lease.holder), s.p(ctx.lease.runSeq))}`,
    )
    .bind(...s.vals);
  const d = binder(ctx.division.id);
  const effect =
    cfg.table === "gl_accounts"
      ? `UPDATE gl_accounts SET is_active = 0, updated_at = ${d.p(ctx.nowIso())}`
      : `DELETE FROM ${cfg.table}`;
  const prune = ctx.db
    .prepare(
      `${effect} WHERE division_id = ?1${live}${scope(d)}
         AND COALESCE(last_seen_sync_id, 0) < ${d.p(since)}
         AND missed_cycles >= ${d.p(need)}
         AND ${leaseHeld(d.p(ctx.lease.holder), d.p(ctx.lease.runSeq))}`,
    )
    .bind(...d.vals);
  return [strike, prune, ...cfg.extra(counts?.split ?? 0)];
}

/** Records the last complete read of a year (guarded by the lease). */
function yearDoneStmt(
  ctx: LedgerCtx,
  entity: "gl_balances" | "gl_budgets",
  year: number,
  rows: number,
  splitKeys: number,
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO gl_sync_years (division_id, entity, year, completed_at, cycle, rows_read,
         split_keys)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?9 WHERE ${leaseHeld("?7", "?8")}
       ON CONFLICT (division_id, entity, year) DO UPDATE SET
         completed_at = excluded.completed_at, cycle = excluded.cycle,
         rows_read = excluded.rows_read, split_keys = excluded.split_keys`,
    )
    .bind(
      ctx.division.id,
      entity,
      year,
      ctx.nowIso(),
      ctx.cycle,
      rows,
      ctx.lease.holder,
      ctx.lease.runSeq,
      splitKeys,
    );
}

interface YearRow {
  year: number;
  completed_at: string;
  cycle: number | null;
}

async function loadYears(
  ctx: LedgerCtx,
  entity: "gl_balances" | "gl_budgets",
): Promise<Map<number, YearRow>> {
  ctx.meter.used += 1;
  const rows = (
    await ctx.db
      .prepare(
        "SELECT year, completed_at, cycle FROM gl_sync_years WHERE division_id = ?1 AND entity = ?2",
      )
      .bind(ctx.division.id, entity)
      .all<YearRow>()
  ).results;
  return new Map(rows.map((r) => [r.year, r]));
}

/** The reporting year: the Amsterdam calendar year (assumption, ADR 0024). */
export const reportingYear = (ms: number): number => Number(amsterdamParts(ms).date.slice(0, 4));

const ageMs = (iso: string, nowMs: number): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Infinity : nowMs - t;
};

/**
 * True when a year that is no longer the current one was last read while it still was (before
 * 1 January 00:00 Amsterdam): read it once more after it closed, so the last days of December
 * and the first year-end adjustments do not wait up to a week (review K2).
 */
const readWhileCurrent = (row: YearRow): boolean => {
  const t = Date.parse(row.completed_at);
  return Number.isNaN(t) || reportingYear(t) <= row.year;
};

function outcomeResult(o: Exclude<Outcome, { kind: "done" }>, rows: number): EntityResult {
  switch (o.kind) {
    case "partial":
      return { status: "partial", rows, calls: 0, error: o.code };
    case "guard":
      return { status: "error", rows, calls: 0, error: "close_guard", cycleDone: false };
    case "skipped":
      return { status: "skipped", rows, calls: 0, cycleDone: true };
  }
}

/** Result of a finished entity; an ignored empty answer is visible as `empty_answer_ignored`. */
const doneResult = (ctx: LedgerCtx, empty: boolean): EntityResult => ({
  status: "ok",
  rows: ctx.progress,
  calls: 0,
  cycleDone: true,
  ...(empty ? { error: "empty_answer_ignored" } : {}),
});

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

export async function syncGlAccounts(ctx: LedgerCtx): Promise<EntityResult> {
  const o = await runPass<GlAccount>(ctx, {
    entity: "gl_accounts",
    scope: "",
    read: (t, n) => ctx.client.listGlAccountsChunk(t, { maxPages: n }),
    upserts: (items, now) => items.map((a) => accountStmt(ctx, a, now)),
    finish: ({ rows, singleRun, pass }) =>
      finishStrikes(ctx, {
        table: "gl_accounts",
        year: null,
        rows,
        singleRun,
        pass,
        extra: () => [],
      }),
  });
  if (o.kind !== "done") return outcomeResult(o, ctx.progress);
  return doneResult(ctx, o.empty);
}

export async function syncGlBalances(ctx: LedgerCtx): Promise<EntityResult> {
  const cycle = ctx.cycle as number;
  const nowMs = ctx.nowMs();
  const thisYear = reportingYear(nowMs);
  const years = await loadYears(ctx, "gl_balances");
  const due: number[] = [];
  const cur = years.get(thisYear);
  if (cur === undefined || cur.cycle !== cycle) due.push(thisYear);
  const prev = years.get(thisYear - 1);
  // One small read per run, only when it can matter (the previous year has been read before).
  let nightly = false;
  if (prev !== undefined && prev.cycle !== cycle) {
    ctx.meter.used += 1;
    nightly = reportingMonth(nowMs) <= (await readPriorYearNightlyUntilMonth(ctx.db));
  }
  // A pass of the previous year that an earlier attempt left partway is always continued, even when
  // the rule that started it no longer applies (an attempt cut off at 23:59 on the limit month's
  // last day and retried after midnight): otherwise its token would sit unused for a week.
  const prevResuming = passInfo(ctx, "gl_balances", `${thisYear - 1}:`).resuming;
  if (
    prev === undefined ||
    (prev.cycle !== cycle &&
      (prevResuming ||
        nightly ||
        ageMs(prev.completed_at, nowMs) >= LEDGER_REFRESH_MS ||
        readWhileCurrent(prev)))
  ) {
    due.push(thisYear - 1);
  }
  // One saved token per entity: a year whose pass can be resumed goes first, so a pass carried
  // into a new cycle is continued instead of being overwritten by the other year's fresh pass.
  due.sort(
    (a, b) =>
      Number(passInfo(ctx, "gl_balances", `${b}:`).resuming) -
      Number(passInfo(ctx, "gl_balances", `${a}:`).resuming),
  );
  let empty = false;
  for (const year of due) {
    const o = await runPass<ReportingBalanceRow>(ctx, {
      entity: "gl_balances",
      scope: `${year}:`,
      read: (t, n) => ctx.client.listReportingBalancesChunk(t, { year, maxPages: n }),
      upserts: (items, now, at) =>
        mergeBalances(items, year).map((b) => balanceStmt(ctx, b, now, at)),
      finish: ({ rows, singleRun, pass }) =>
        finishStrikes(ctx, {
          table: "gl_balances",
          year,
          rows,
          singleRun,
          pass,
          extra: (split) => [yearDoneStmt(ctx, "gl_balances", year, rows, split)],
        }),
    });
    if (o.kind !== "done") return outcomeResult(o, ctx.progress);
    empty ||= o.empty;
  }
  return doneResult(ctx, empty);
}

export async function syncGlBudgets(ctx: LedgerCtx): Promise<EntityResult> {
  const nowMs = ctx.nowMs();
  const year = reportingYear(nowMs);
  const st = ctx.state.get("gl_budgets");
  if (!ctx.restart && st?.unavailable_until != null && Date.parse(st.unavailable_until) > nowMs) {
    return { status: "skipped", rows: 0, calls: 0, error: "budgets_unavailable", cycleDone: true };
  }
  const scope = `${year}:`;
  const resuming = passInfo(ctx, "gl_budgets", scope).resuming;
  const done = (await loadYears(ctx, "gl_budgets")).get(year);
  if (!resuming && done !== undefined && ageMs(done.completed_at, nowMs) < LEDGER_REFRESH_MS) {
    return { status: "skipped", rows: 0, calls: 0, cycleDone: true };
  }
  const marked: { code: string | null } = { code: null };
  const o = await runPass<BudgetRow>(ctx, {
    entity: "gl_budgets",
    scope,
    read: (t, n) => ctx.client.listBudgetsChunk(t, { year, maxPages: n }),
    upserts: (items, now, at) => mergeBudgets(items, year).map((b) => budgetStmt(ctx, b, now, at)),
    finish: async ({ rows, singleRun, pass }) =>
      finishStrikes(ctx, {
        table: "gl_budgets",
        year,
        rows,
        singleRun,
        pass,
        extra: (split) => [
          yearDoneStmt(ctx, "gl_budgets", year, rows, split),
          ctx.db
            .prepare(
              `UPDATE sync_state SET unavailable_until = NULL
               WHERE division_id = ?1 AND entity = 'gl_budgets' AND ${leaseHeld("?2", "?3")}`,
            )
            .bind(ctx.division.id, ctx.lease.holder, ctx.lease.runSeq),
        ],
      }),
    firstPageError: async (e) => {
      // Only Exact's own refusal counts: a 5xx, a network failure or our gate rejecting the
      // request (its own 400 codes) is an ordinary failure and must not hide budgets for a week.
      if (
        !(e instanceof ExactApiError) ||
        !BUDGETS_UNAVAILABLE_STATUSES.includes(e.status) ||
        (e.code !== undefined && GATE_REJECT_CODES.has(e.code))
      ) {
        return false;
      }
      // Budgets are optional: remember it for a week instead of failing every night.
      marked.code = `budgets_unavailable_${e.status}`;
      await runBatches(ctx.db, ctx.meter, [
        [
          ctx.db
            .prepare(
              `INSERT INTO sync_state (division_id, entity, mode, last_started_at, last_error,
                 unavailable_until)
               SELECT ?1, 'gl_budgets', 'full', ?2, ?3, ?4 WHERE ${leaseHeld("?5", "?6")}
               ON CONFLICT (division_id, entity) DO UPDATE SET
                 last_error = excluded.last_error, unavailable_until = excluded.unavailable_until,
                 pass_token = NULL, pass_rows = 0
               WHERE ${leaseHeld("?5", "?6")}`,
            )
            .bind(
              ctx.division.id,
              ctx.startedAt,
              marked.code,
              new Date(nowMs + BUDGETS_UNAVAILABLE_MS).toISOString(),
              ctx.lease.holder,
              ctx.lease.runSeq,
            ),
        ],
      ]);
      return true;
    },
  });
  if (o.kind === "skipped") {
    return {
      status: "skipped",
      rows: 0,
      calls: 0,
      error: marked.code ?? "budgets_unavailable",
      cycleDone: true,
    };
  }
  if (o.kind !== "done") return outcomeResult(o, ctx.progress);
  return doneResult(ctx, o.empty);
}
