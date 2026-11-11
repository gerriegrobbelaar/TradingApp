/**
 * Ledger sync (Phase 4, task K2, ADR 0023): the chart of accounts, reporting balances and budgets
 * of one division, for the balance sheet and profit and loss reports. Part of FULL sync cycles
 * only (the hourly incremental run never reads ledger data), after open items and relations:
 *
 *   gl_accounts  financial/GLAccounts, read completely every cycle.
 *   gl_balances  financial/ReportingBalance of the CURRENT reporting year every cycle, and of the
 *                PREVIOUS year only when it was never read completely or the last complete read is
 *                a week old (the year-end figures only move through late adjustments; we cannot
 *                cheaply see whether the year-end period changed, so "at most weekly" is the
 *                rule). The reporting year is the Amsterdam calendar year (assumption).
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
 * Rows Exact no longer returns: only a COMPLETE read counts. Rows not seen get a strike (a cycle
 * marker makes a strike idempotent, so a crash between statements cannot double it); after two
 * strikes (one when the pass ran in a single run, or with `allowLargeClose`) an account is marked
 * inactive (never deleted: its history stays) and a balance or budget row is deleted. A read that
 * returned nothing at all changes nothing, and the close guard of the open items (more than
 * max(5, 20 %) at once) applies here too.
 *
 * Money: integer minor units at the scale of the division currency. Sign: debit - credit
 * (assumption). Field and resource names: all to verify with credentials (ADR 0023).
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
const MAX_CHUNKS = 200;

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

/** Rows of one chunk with the same key are one figure split over a dimension we do not select. */
function mergeBalances(items: readonly ReportingBalanceRow[], year: number): ReportingBalanceRow[] {
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
    if (g.length === 1) return first;
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
    };
  });
}

function balanceStmt(ctx: LedgerCtx, b: ReportingBalanceRow, nowIso: string): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO gl_balances (division_id, gl_account_exact_id, year, period, dimension,
         amount_minor, debit_minor, credit_minor, currency, balance_type, last_seen_sync_id,
         missed_cycles, strike_cycle, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, NULL, ?12)
       ON CONFLICT (division_id, gl_account_exact_id, year, period, dimension) DO UPDATE SET
         amount_minor = excluded.amount_minor, debit_minor = excluded.debit_minor,
         credit_minor = excluded.credit_minor, currency = excluded.currency,
         balance_type = excluded.balance_type, last_seen_sync_id = excluded.last_seen_sync_id,
         missed_cycles = 0, strike_cycle = NULL, updated_at = excluded.updated_at
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
    );
}

function mergeBudgets(items: readonly BudgetRow[], year: number): BudgetRow[] {
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
      ? first
      : {
          ...first,
          amount: {
            minor: sumMinor(g.map((r) => r.amount.minor)),
            currency: first.amount.currency,
          },
        };
  });
}

function budgetStmt(ctx: LedgerCtx, b: BudgetRow, nowIso: string): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO gl_budgets (division_id, gl_account_exact_id, year, period, scenario, dimension,
         amount_minor, currency, last_seen_sync_id, missed_cycles, strike_cycle, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL, ?10)
       ON CONFLICT (division_id, gl_account_exact_id, year, period, scenario, dimension)
       DO UPDATE SET amount_minor = excluded.amount_minor, currency = excluded.currency,
         last_seen_sync_id = excluded.last_seen_sync_id, missed_cycles = 0, strike_cycle = NULL,
         updated_at = excluded.updated_at
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
    );
}

/** Saves a resumable pass (same batch as the rows it covers); only while the lease is held. */
function passStmt(
  ctx: LedgerCtx,
  entity: LedgerEntityName,
  token: string | null,
  rows: number,
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO sync_state (division_id, entity, mode, last_started_at, last_status,
         pass_cycle, pass_token, pass_rows, pass_total)
       VALUES (?1, ?2, 'full', ?3, 'partial', ?4, ?5, ?6, NULL)
       ON CONFLICT (division_id, entity) DO UPDATE SET
         pass_cycle = excluded.pass_cycle, pass_token = excluded.pass_token,
         pass_rows = excluded.pass_rows, pass_total = NULL
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
  upserts: (items: T[], nowIso: string) => D1PreparedStatement[];
  /** After a complete read: the strike and bookkeeping statements, or "close_guard". */
  finish: (info: {
    rows: number;
    singleRun: boolean;
  }) => Promise<D1PreparedStatement[] | "close_guard">;
  /** Called when the first page of a fresh pass fails; true = handled, the pass is skipped. */
  firstPageError?: (e: unknown) => Promise<boolean>;
}

type Outcome =
  | { kind: "done"; rows: number }
  | { kind: "partial"; rows: number; code: string }
  | { kind: "guard"; rows: number }
  | { kind: "skipped"; rows: number };

async function runPass<T>(ctx: LedgerCtx, spec: PassSpec<T>): Promise<Outcome> {
  const cycle = ctx.cycle as number;
  const st = ctx.state.get(spec.entity);
  const saved = st?.pass_token ?? "";
  const resuming =
    st?.pass_cycle === cycle && saved.startsWith(spec.scope) && saved.length > spec.scope.length;
  let token: string | null = resuming ? saved.slice(spec.scope.length) : null;
  let readTotal = resuming ? (st?.pass_rows ?? 0) : 0;
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
    readTotal += page.items.length;
    const units = spec.upserts(page.items, nowIso).map((s) => [s]);
    units.push([
      passStmt(
        ctx,
        spec.entity,
        page.nextToken === null ? null : `${spec.scope}${page.nextToken}`,
        readTotal,
      ),
    ]);
    await runBatches(ctx.db, ctx.meter, units);
    rows += page.items.length;
    ctx.progress += page.items.length;
    ctx.pass = { read: readTotal, total: null };
    if (page.error !== undefined) throw page.error;
    if (page.complete) {
      const fin = await spec.finish({ rows: readTotal, singleRun: !resuming });
      if (fin === "close_guard") return { kind: "guard", rows };
      if (fin.length > 0)
        await runBatches(
          ctx.db,
          ctx.meter,
          fin.map((s) => [s]),
        );
      return { kind: "done", rows };
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
 * chart. Returns "close_guard" when too much would go at once.
 */
async function finishStrikes(
  ctx: LedgerCtx,
  cfg: {
    table: "gl_accounts" | "gl_balances" | "gl_budgets";
    year: number | null;
    rows: number;
    singleRun: boolean;
    extra: D1PreparedStatement[];
  },
): Promise<D1PreparedStatement[] | "close_guard"> {
  const cycle = ctx.cycle as number;
  const live = cfg.table === "gl_accounts" ? " AND is_active = 1" : "";
  const scope = (b: ReturnType<typeof binder>): string =>
    cfg.year === null ? "" : ` AND year = ${b.p(cfg.year)}`;
  const c = binder(ctx.division.id);
  ctx.meter.used += 1;
  const counts = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS held,
              COALESCE(SUM(CASE WHEN COALESCE(last_seen_sync_id, 0) < ${c.p(cycle)} THEN 1 ELSE 0 END), 0)
                AS stale
       FROM ${cfg.table} WHERE division_id = ?1${live}${scope(c)}`,
    )
    .bind(...c.vals)
    .first<{ held: number; stale: number }>();
  const held = counts?.held ?? 0;
  const stale = counts?.stale ?? 0;
  // An answer with no rows at all is far more likely a fault (wrong division, licence) than "the
  // whole ledger is gone": change nothing.
  if (cfg.rows === 0 && held > 0) return cfg.extra;
  if (stale > 0 && !ctx.allowLargeClose && !closeAllowed(stale, held)) return "close_guard";

  const need = cfg.singleRun || ctx.allowLargeClose ? 1 : 2;
  const s = binder(ctx.division.id);
  const strike = ctx.db
    .prepare(
      `UPDATE ${cfg.table} SET missed_cycles = missed_cycles + 1, strike_cycle = ${s.p(cycle)}
       WHERE division_id = ?1${live}${scope(s)}
         AND COALESCE(last_seen_sync_id, 0) < ${s.p(cycle)}
         AND COALESCE(strike_cycle, 0) <> ${s.p(cycle)}
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
         AND COALESCE(last_seen_sync_id, 0) < ${d.p(cycle)}
         AND missed_cycles >= ${d.p(need)}
         AND ${leaseHeld(d.p(ctx.lease.holder), d.p(ctx.lease.runSeq))}`,
    )
    .bind(...d.vals);
  return [strike, prune, ...cfg.extra];
}

/** Records the last complete read of a year (guarded by the lease). */
function yearDoneStmt(
  ctx: LedgerCtx,
  entity: "gl_balances" | "gl_budgets",
  year: number,
  rows: number,
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO gl_sync_years (division_id, entity, year, completed_at, cycle, rows_read)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${leaseHeld("?7", "?8")}
       ON CONFLICT (division_id, entity, year) DO UPDATE SET
         completed_at = excluded.completed_at, cycle = excluded.cycle, rows_read = excluded.rows_read`,
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

/** The reporting year: the Amsterdam calendar year (assumption, ADR 0023). */
export const reportingYear = (ms: number): number => Number(amsterdamParts(ms).date.slice(0, 4));

const ageMs = (iso: string, nowMs: number): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Infinity : nowMs - t;
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

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

export async function syncGlAccounts(ctx: LedgerCtx): Promise<EntityResult> {
  const o = await runPass<GlAccount>(ctx, {
    entity: "gl_accounts",
    scope: "",
    read: (t, n) => ctx.client.listGlAccountsChunk(t, { maxPages: n }),
    upserts: (items, now) => items.map((a) => accountStmt(ctx, a, now)),
    finish: ({ rows, singleRun }) =>
      finishStrikes(ctx, { table: "gl_accounts", year: null, rows, singleRun, extra: [] }),
  });
  if (o.kind !== "done") return outcomeResult(o, ctx.progress);
  return { status: "ok", rows: ctx.progress, calls: 0, cycleDone: true };
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
  if (
    prev === undefined ||
    (prev.cycle !== cycle && ageMs(prev.completed_at, nowMs) >= LEDGER_REFRESH_MS)
  ) {
    due.push(thisYear - 1);
  }
  for (const year of due) {
    const o = await runPass<ReportingBalanceRow>(ctx, {
      entity: "gl_balances",
      scope: `${year}:`,
      read: (t, n) => ctx.client.listReportingBalancesChunk(t, { year, maxPages: n }),
      upserts: (items, now) => mergeBalances(items, year).map((b) => balanceStmt(ctx, b, now)),
      finish: ({ rows, singleRun }) =>
        finishStrikes(ctx, {
          table: "gl_balances",
          year,
          rows,
          singleRun,
          extra: [yearDoneStmt(ctx, "gl_balances", year, rows)],
        }),
    });
    if (o.kind !== "done") return outcomeResult(o, ctx.progress);
  }
  return { status: "ok", rows: ctx.progress, calls: 0, cycleDone: true };
}

export async function syncGlBudgets(ctx: LedgerCtx): Promise<EntityResult> {
  const cycle = ctx.cycle as number;
  const nowMs = ctx.nowMs();
  const year = reportingYear(nowMs);
  const st = ctx.state.get("gl_budgets");
  if (!ctx.restart && st?.unavailable_until != null && Date.parse(st.unavailable_until) > nowMs) {
    return { status: "skipped", rows: 0, calls: 0, error: "budgets_unavailable", cycleDone: true };
  }
  const scope = `${year}:`;
  const saved = st?.pass_token ?? "";
  const resuming =
    st?.pass_cycle === cycle && saved.startsWith(scope) && saved.length > scope.length;
  const done = (await loadYears(ctx, "gl_budgets")).get(year);
  if (!resuming && done !== undefined && ageMs(done.completed_at, nowMs) < LEDGER_REFRESH_MS) {
    return { status: "skipped", rows: 0, calls: 0, cycleDone: true };
  }
  const marked: { code: string | null } = { code: null };
  const o = await runPass<BudgetRow>(ctx, {
    entity: "gl_budgets",
    scope,
    read: (t, n) => ctx.client.listBudgetsChunk(t, { year, maxPages: n }),
    upserts: (items, now) => mergeBudgets(items, year).map((b) => budgetStmt(ctx, b, now)),
    finish: async ({ rows, singleRun }) =>
      finishStrikes(ctx, {
        table: "gl_budgets",
        year,
        rows,
        singleRun,
        extra: [
          yearDoneStmt(ctx, "gl_budgets", year, rows),
          ctx.db
            .prepare(
              `UPDATE sync_state SET unavailable_until = NULL
               WHERE division_id = ?1 AND entity = 'gl_budgets' AND ${leaseHeld("?2", "?3")}`,
            )
            .bind(ctx.division.id, ctx.lease.holder, ctx.lease.runSeq),
        ],
      }),
    firstPageError: async (e) => {
      if (!(e instanceof ExactApiError) || !BUDGETS_UNAVAILABLE_STATUSES.includes(e.status)) {
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
               VALUES (?1, 'gl_budgets', 'full', ?2, ?3, ?4)
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
  return { status: "ok", rows: ctx.progress, calls: 0, cycleDone: true };
}
