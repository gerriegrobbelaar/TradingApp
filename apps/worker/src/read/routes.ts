/**
 * Read-only API for invoices, bills, ageing and the Overview (Phase 4, ADR 0022).
 *
 *  GET /api/invoices | /api/bills   paged open-item lists (receivables | payables)
 *  GET /api/open-items/:id          one stored open item with its sync provenance
 *  GET /api/relations/:id           minimal relation summary (presence flags, never IBAN/email)
 *  GET /api/reports/ageing          ageing per relation and bucket (kind, asOf)
 *  GET /api/overview                KPIs and sync freshness
 *
 * Any signed-in role may read. The division comes from `?division=<divisions.id>` (400 when it is
 * not a positive integer, 404 when it is unknown or its connection is disabled) and defaults to the
 * user's saved choice (the same default as the switcher). Row routes (`/api/open-items/:id`,
 * `/api/relations/:id`) take the division from the row and 404 when that division is not visible.
 * The only write is filling the derived `search_text` of rows that predate migration 0009 (a
 * cache column, no business data), so there is no CSRF or audit concern. Responses are
 * `no-store` (json()).
 */
import {
  addDays,
  AGEING_BUCKETS,
  buildAgeing,
  buildOverviewKpis,
  likePatterns,
  resolveDcMinor,
  toCalendarDate,
  amsterdamParts,
  type AgeingBucket,
  type AgeingReportResponse,
  type AgeingReportRow,
  type AgeingReportTotals,
  type CurrencyKpisDto,
  type DivisionRef,
  type DrilldownHint,
  type Freshness,
  type FreshnessEntity,
  type KpiFigure,
  type OpenItemDetail,
  type OpenItemKind,
  type OpenItemListResponse,
  type OverviewResponse,
  type RelationSummary,
  type SyncFreshnessEntry,
} from "@camelthorn/core";
import { selectedId, type DivisionJoin } from "../exact/sync-routes";
import { json, type Ctx, type Router } from "../router";
import {
  buildListQuery,
  buildTotalsQuery,
  decodeCursor,
  encodeCursor,
  FILL_SEARCH_SQL,
  mapRow,
  PENDING_SEARCH_SQL,
  pendingSearchPairs,
  rowKey,
  totalsFromSql,
  type Cursor,
  type ListFilter,
  type ListRow,
  type PendingSearchRow,
  type TotalsRow,
} from "./queries";

export const ANY_ROLE = { roles: ["admin", "finance", "approver", "viewer"] } as const;

export const STALE_AFTER_HOURS = 36;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** Rows without search text (written before migration 0009) filled per statement, and per request. */
export const SEARCH_FILL_CHUNK = 2_000;
export const SEARCH_FILL_MAX_CHUNKS = 10;

export class BadRequest extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 503 = 400,
  ) {
    super(code);
  }
}

export type DivisionRow = DivisionJoin & { base_currency_read_at: string | null };

export const toRef = (d: DivisionRow): DivisionRef => ({
  id: d.id,
  name: d.name,
  currency: d.base_currency,
  currencyVerified: d.base_currency_read_at !== null,
});

/** Divisions of connections that are not disabled (what the switcher offers). */
async function visibleDivisions(db: D1Database): Promise<DivisionRow[]> {
  return (
    await db
      .prepare(
        `SELECT d.id, d.connection_id, d.exact_division, d.name, d.base_currency, d.sync_enabled,
                d.base_currency_read_at, c.status AS connection_status
         FROM divisions d JOIN connections c ON c.id = d.connection_id
         WHERE c.kind = 'exact' AND c.status <> 'disabled'
         ORDER BY d.name COLLATE NOCASE, d.id`,
      )
      .all<DivisionRow>()
  ).results;
}

const POSITIVE_INT = /^[1-9][0-9]{0,15}$/;

export function positiveIntParam(raw: string | null, name: string): number | null {
  if (raw === null) return null;
  if (!POSITIVE_INT.test(raw)) throw new BadRequest(`bad_${name}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new BadRequest(`bad_${name}`);
  return n;
}

function dateParam(raw: string | null, name: string): string | null {
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new BadRequest(`bad_${name}`);
  try {
    return toCalendarDate(raw);
  } catch {
    throw new BadRequest(`bad_${name}`);
  }
}

const today = (ctx: Ctx): string => amsterdamParts(ctx.nowMs).date;

/**
 * `asOf` for lists and reports: today's Amsterdam calendar date, the only date the tables can
 * answer for (ADR 0022). They hold today's open balances, so a past date would silently omit
 * everything paid since, and a future one would present today's balances as a forecast: both
 * are refused (400 `as_of_in_past` / `as_of_in_future`). Omit it to get today; the response says
 * which date that was.
 */
export function resolveAsOf(raw: string | null, nowMs: number): string {
  const now = amsterdamParts(nowMs).date;
  const v = dateParam(raw, "as_of");
  if (v === null || v === now) return now;
  throw new BadRequest(v < now ? "as_of_in_past" : "as_of_in_future");
}

const asOfParam = (ctx: Ctx): string => resolveAsOf(ctx.url.searchParams.get("asOf"), ctx.nowMs);

export async function resolveDivision(ctx: Ctx): Promise<DivisionRow> {
  const session = ctx.session;
  if (!session) throw new BadRequest("unauthenticated");
  const divisions = await visibleDivisions(ctx.env.DB);
  const id = positiveIntParam(ctx.url.searchParams.get("division"), "division");
  if (id !== null) {
    const found = divisions.find((d) => d.id === id);
    if (!found) throw new BadRequest("unknown_division", 404);
    return found;
  }
  const chosen = await selectedId(ctx.env.DB, session.userId, divisions);
  const found = divisions.find((d) => d.id === chosen);
  if (!found) throw new BadRequest("no_division", 404);
  return found;
}

export async function divisionById(db: D1Database, id: number): Promise<DivisionRow | null> {
  return (await visibleDivisions(db)).find((d) => d.id === id) ?? null;
}

export function guarded(fn: (ctx: Ctx) => Promise<Response>): (ctx: Ctx) => Promise<Response> {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      if (err instanceof BadRequest) {
        if (err.code === "unauthenticated") return json({ error: err.code }, 401);
        if (err.status === 503) return json({ error: err.code }, 503, { "retry-after": "1" });
        return json({ error: err.code }, err.status);
      }
      throw err;
    }
  };
}

// ---- lists ----------------------------------------------------------------------------------

function searchParam(raw: string | null): string[] {
  const q = (raw ?? "").trim();
  if (q.length > 100) throw new BadRequest("bad_q");
  try {
    return likePatterns(q);
  } catch {
    throw new BadRequest("bad_q");
  }
}

/**
 * Fill `search_text` of rows written before migration 0009 (the sync writes it for every row it
 * touches). A derived cache column, not a business change: no audit. One SELECT when nothing is
 * pending (partial index); otherwise chunks of SEARCH_FILL_CHUNK rows, one UPDATE each, and a 503
 * `search_index_building` (retry) if a division still has rows left after SEARCH_FILL_MAX_CHUNKS.
 */
export async function fillSearchText(
  db: D1Database,
  divisionId: number,
  chunk = SEARCH_FILL_CHUNK,
  maxChunks = SEARCH_FILL_MAX_CHUNKS,
): Promise<void> {
  for (let round = 0; round < maxChunks; round++) {
    const rows = (
      await db.prepare(PENDING_SEARCH_SQL).bind(divisionId, chunk).all<PendingSearchRow>()
    ).results;
    if (rows.length === 0) return;
    await db.prepare(FILL_SEARCH_SQL).bind(pendingSearchPairs(rows)).run();
    if (rows.length < chunk) return;
  }
  const left = await db.prepare(PENDING_SEARCH_SQL).bind(divisionId, 1).all<PendingSearchRow>();
  if (left.results.length > 0) throw new BadRequest("search_index_building", 503);
}

function parseFilter(
  ctx: Ctx,
  division: DivisionRow,
  kind: OpenItemKind,
  asOf: string,
): ListFilter {
  const p = ctx.url.searchParams;
  const status = p.get("status") ?? "open";
  if (status !== "open" && status !== "closed" && status !== "all")
    throw new BadRequest("bad_status");
  const currency = p.get("currency");
  if (currency !== null && !/^[A-Za-z]{3}$/.test(currency)) throw new BadRequest("bad_currency");
  const overdue = p.get("overdue");
  if (overdue !== null && overdue !== "1" && overdue !== "0") throw new BadRequest("bad_overdue");
  const noDue = p.get("noDueDate");
  if (noDue !== null && noDue !== "1" && noDue !== "0") throw new BadRequest("bad_no_due_date");
  const dueBefore = dateParam(p.get("dueBefore"), "due_before");
  const dueAfter = dateParam(p.get("dueAfter"), "due_after");
  return {
    divisionId: division.id,
    kind,
    status,
    asOf,
    overdue: overdue === "1",
    currency: currency === null ? null : currency.toUpperCase(),
    relationId: positiveIntParam(p.get("relationId"), "relation_id"),
    dueBefore,
    dueAfter,
    noDueDate: noDue === "1",
    search: searchParam(p.get("q")),
  };
}

async function listHandler(ctx: Ctx, kind: OpenItemKind): Promise<Response> {
  const division = await resolveDivision(ctx);
  const ref = toRef(division);
  const asOf = asOfParam(ctx);
  const filter = parseFilter(ctx, division, kind, asOf);
  const p = ctx.url.searchParams;

  const sort = p.get("sort") ?? "due";
  if (sort !== "due" && sort !== "-due") throw new BadRequest("bad_sort");
  const dir = sort === "due" ? "asc" : "desc";
  const limit = positiveIntParam(p.get("limit"), "limit") ?? DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) throw new BadRequest("bad_limit");
  const rawCursor = p.get("cursor");
  let cursor: Cursor | null = null;
  if (rawCursor !== null) {
    cursor = decodeCursor(rawCursor);
    if (!cursor || cursor.dir !== dir) throw new BadRequest("bad_cursor");
  }
  const dc = { currency: division.base_currency, known: division.base_currency_read_at !== null };
  const db = ctx.env.DB;
  if (filter.search.length > 0) await fillSearchText(db, division.id);

  const list = buildListQuery(filter, dir, cursor, limit + 1);
  const totals = buildTotalsQuery(filter, dc);
  const [rows, totalRows] = await db.batch<ListRow | TotalsRow>([
    db.prepare(list.sql).bind(...list.binds),
    db.prepare(totals.sql).bind(...totals.binds),
  ]);
  const all = (rows?.results ?? []) as ListRow[];
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  const totalsByCurrency = totalsFromSql((totalRows?.results ?? []) as TotalsRow[]);
  const body: OpenItemListResponse = {
    division: ref,
    asOf,
    items: page.map((r) => mapRow(r, ref, asOf)),
    nextCursor:
      all.length > limit && last ? encodeCursor({ dir, key: rowKey(last), id: last.id }) : null,
    limit,
    total: totalsByCurrency.reduce((n, t) => n + t.count, 0),
    totalsByCurrency,
  };
  return json(body);
}

// ---- detail ---------------------------------------------------------------------------------

interface DetailRow extends ListRow {
  division_id: number;
  amount_minor: number;
  rate: string | null;
  closed_at: string | null;
  last_seen_sync_id: number | null;
  missed_cycles: number;
}

const DETAIL_SQL = `SELECT oi.id, oi.exact_id, oi.kind, oi.status, oi.invoice_number, oi.entry_number,
    oi.reference, oi.relation_id AS relation_exact_id, oi.relation_name, r.id AS relation_row_id,
    r.name AS relation_row_name, oi.invoice_date, oi.due_date, oi.currency, oi.original_minor,
    oi.open_minor, oi.open_dc_minor, oi.dc_currency, oi.source, oi.synced_at,
    oi.division_id, oi.amount_minor, oi.rate, oi.closed_at, oi.last_seen_sync_id, oi.missed_cycles
  FROM open_items oi
  LEFT JOIN relations r ON r.division_id = oi.division_id AND r.exact_id = oi.relation_id
  WHERE oi.id = ?`;

/**
 * Deep link into Exact for an entry. The URL pattern has NOT been verified against a real Exact
 * account, so none is built: null until checked with credentials (ADR 0022, open question).
 */
export function exactDeepLink(): string | null {
  return null;
}

async function detailHandler(ctx: Ctx): Promise<Response> {
  const id = positiveIntParam(ctx.params["id"] ?? null, "id");
  if (id === null) throw new BadRequest("bad_id");
  const db = ctx.env.DB;
  const row = await db.prepare(DETAIL_SQL).bind(id).first<DetailRow>();
  if (!row) throw new BadRequest("not_found", 404);
  const division = await divisionById(db, row.division_id);
  if (!division) throw new BadRequest("not_found", 404);
  const ref = toRef(division);
  const asOf = today(ctx);
  let relation: RelationSummary | null = null;
  if (row.relation_row_id !== null) {
    relation = await relationSummary(db, row.relation_row_id, division.id);
  }
  const body: OpenItemDetail = {
    division: ref,
    asOf,
    item: mapRow(row, ref, asOf),
    amountMinor: row.amount_minor,
    rate: row.rate,
    closedAt: row.closed_at,
    openDcMinor: row.open_dc_minor,
    storedDcCurrency: row.dc_currency,
    relation,
    provenance: {
      lastSeenAt: row.synced_at,
      lastSeenSyncId: row.last_seen_sync_id,
      missedCycles: row.missed_cycles,
      source: row.source,
    },
    exactLink: exactDeepLink(),
  };
  return json(body);
}

interface RelationRow {
  id: number;
  division_id: number;
  exact_id: string;
  code: string | null;
  name: string;
  is_customer: number;
  is_supplier: number;
  country: string | null;
  has_vat: number;
  has_email: number;
  updated_at: string;
}

async function relationSummary(
  db: D1Database,
  id: number,
  divisionId: number | null,
): Promise<RelationSummary | null> {
  const r = await db
    .prepare(
      `SELECT id, division_id, exact_id, code, name, is_customer, is_supplier, country,
              (vat_number IS NOT NULL AND trim(vat_number) <> '') AS has_vat,
              (email IS NOT NULL AND trim(email) <> '') AS has_email, updated_at
       FROM relations WHERE id = ?1 AND (?2 IS NULL OR division_id = ?2)`,
    )
    .bind(id, divisionId)
    .first<RelationRow>();
  if (!r) return null;
  return {
    id: r.id,
    divisionId: r.division_id,
    exactId: r.exact_id,
    code: r.code,
    name: r.name,
    isCustomer: r.is_customer === 1,
    isSupplier: r.is_supplier === 1,
    country: r.country,
    hasVatNumber: r.has_vat === 1,
    hasEmail: r.has_email === 1,
    updatedAt: r.updated_at,
  };
}

async function relationHandler(ctx: Ctx): Promise<Response> {
  const id = positiveIntParam(ctx.params["id"] ?? null, "id");
  if (id === null) throw new BadRequest("bad_id");
  const db = ctx.env.DB;
  const rel = await relationSummary(db, id, null);
  if (!rel || !(await divisionById(db, rel.divisionId))) throw new BadRequest("not_found", 404);
  return json(rel);
}

// ---- ageing ---------------------------------------------------------------------------------

interface AgeingSqlRow {
  relation_exact_id: string | null;
  relation_name: string | null;
  relation_row_id: number | null;
  relation_row_name: string | null;
  currency: string;
  open_minor: number;
  due_date: string | null;
  open_dc_minor: number | null;
  dc_currency: string | null;
}

/**
 * Filters that reproduce one ageing cell on the list endpoint. Absolute dates, so a drill-down
 * opened after midnight still returns the rows of the cell that was shown.
 */
export function bucketQuery(bucket: AgeingBucket | "total", asOf: string): Record<string, string> {
  switch (bucket) {
    case "total":
      return {};
    case "not_due":
      return { dueAfter: addDays(asOf, -1) };
    case "d1_30":
      return { dueAfter: addDays(asOf, -31), dueBefore: asOf };
    case "d31_60":
      return { dueAfter: addDays(asOf, -61), dueBefore: addDays(asOf, -30) };
    case "d61_90":
      return { dueAfter: addDays(asOf, -91), dueBefore: addDays(asOf, -60) };
    case "d90_plus":
      return { dueBefore: addDays(asOf, -90) };
    case "no_due_date":
      return { noDueDate: "1" };
  }
}

function hints(
  path: DrilldownHint["path"],
  currency: string,
  asOf: string,
): Record<AgeingBucket | "total", DrilldownHint> {
  const out = {} as Record<AgeingBucket | "total", DrilldownHint>;
  for (const b of [...AGEING_BUCKETS, "total"] as const) {
    out[b] = { path, query: { status: "open", currency, ...bucketQuery(b, asOf) } };
  }
  return out;
}

interface SyncStateRow {
  entity: string;
  last_status: string | null;
  last_completed_at: string | null;
  last_finished_at: string | null;
  last_error: string | null;
}

async function syncState(db: D1Database, divisionId: number): Promise<SyncStateRow[]> {
  return (
    await db
      .prepare(
        `SELECT entity, last_status, last_completed_at, last_finished_at, last_error
         FROM sync_state WHERE division_id = ?1 ORDER BY entity`,
      )
      .bind(divisionId)
      .all<SyncStateRow>()
  ).results;
}

/**
 * How current the open items are: the last complete read of each entity in `basis` (sync_state
 * `last_completed_at`, set only when that entity's read reached Exact's last page). The OLDEST of
 * them counts, and a missing one makes it null. Not the `run` row: an hourly incremental run
 * completes without reading open items (ADR 0019), so it would hide a nightly sync that keeps
 * failing.
 */
export function freshnessOf(
  rows: readonly SyncStateRow[],
  basis: readonly FreshnessEntity[],
  nowMs: number,
): Freshness {
  let oldest: string | null = null;
  let missing = false;
  for (const entity of basis) {
    const at = rows.find((r) => r.entity === entity)?.last_completed_at ?? null;
    if (at === null || Number.isNaN(Date.parse(at))) missing = true;
    else if (oldest === null || Date.parse(at) < Date.parse(oldest)) oldest = at;
  }
  const lastCompletedAt = missing ? null : oldest;
  const age = lastCompletedAt === null ? Infinity : nowMs - Date.parse(lastCompletedAt);
  return {
    lastCompletedAt,
    basis: [...basis],
    stale: !(age <= STALE_AFTER_HOURS * 3_600_000),
    staleAfterHours: STALE_AFTER_HOURS,
  };
}

async function ageingHandler(ctx: Ctx): Promise<Response> {
  const division = await resolveDivision(ctx);
  const ref = toRef(division);
  const kindParam = ctx.url.searchParams.get("kind");
  if (kindParam !== "receivable" && kindParam !== "payable") throw new BadRequest("bad_kind");
  const asOf = asOfParam(ctx);
  const currency = ctx.url.searchParams.get("currency");
  if (currency !== null && !/^[A-Za-z]{3}$/.test(currency)) throw new BadRequest("bad_currency");
  const path = kindParam === "receivable" ? "/api/invoices" : "/api/bills";
  const db = ctx.env.DB;
  const rows = (
    await db
      .prepare(
        `SELECT oi.relation_id AS relation_exact_id, oi.relation_name, r.id AS relation_row_id,
                r.name AS relation_row_name, oi.currency, oi.open_minor, oi.due_date,
                oi.open_dc_minor, oi.dc_currency
         FROM open_items oi
         LEFT JOIN relations r ON r.division_id = oi.division_id AND r.exact_id = oi.relation_id
         WHERE oi.division_id = ?1 AND oi.kind = ?2 AND oi.status = 'open'`,
      )
      .bind(division.id, kindParam === "receivable" ? "invoice" : "bill")
      .all<AgeingSqlRow>()
  ).results;

  const rowIds = new Map<string, number | null>();
  const dcDiv = {
    currency: division.base_currency,
    known: division.base_currency_read_at !== null,
  };
  const report = buildAgeing(
    rows.map((r) => {
      const key = r.relation_exact_id ?? "";
      rowIds.set(key, r.relation_row_id);
      return {
        relationKey: key,
        relationName: r.relation_name ?? r.relation_row_name,
        currency: r.currency,
        openMinor: r.open_minor,
        dueDate: r.due_date,
        dcMinor: resolveDcMinor(
          {
            currency: r.currency,
            openMinor: r.open_minor,
            openDcMinor: r.open_dc_minor,
            dcCurrency: r.dc_currency,
          },
          dcDiv,
        ),
      };
    }),
    asOf,
    currency === null ? {} : { currency: currency.toUpperCase() },
  );

  const totalsDto = (t: (typeof report.totalsByCurrency)[number]): AgeingReportTotals => ({
    currency: t.currency,
    buckets: t.buckets,
    bucketCounts: t.bucketCounts,
    totalMinor: t.totalMinor,
    count: t.count,
    dcMinor: t.dc.minor,
    dcComplete: t.dc.complete,
    drilldown: hints(path, t.currency, asOf),
  });
  const fresh = freshnessOf(
    await syncState(db, division.id),
    [kindParam === "receivable" ? "receivables" : "payables"],
    ctx.nowMs,
  );
  const body: AgeingReportResponse = {
    division: ref,
    kind: kindParam,
    asOf,
    currencies: report.currencies.map((c) => ({
      currency: c.currency,
      totals: totalsDto(c.totals),
      rows: c.rows.map((row): AgeingReportRow => ({
        relation: { id: rowIds.get(row.relationKey) ?? null, name: row.relationName },
        buckets: row.buckets,
        bucketCounts: row.bucketCounts,
        totalMinor: row.totalMinor,
        count: row.count,
        dcMinor: row.dc.minor,
        dcComplete: row.dc.complete,
      })),
    })),
    totalsByCurrency: report.totalsByCurrency.map(totalsDto),
    freshness: fresh,
  };
  return json(body);
}

// ---- overview -------------------------------------------------------------------------------

/** Filters that reproduce one KPI figure on the list endpoint (same rules as core/kpis.ts). */
export function kpiQuery(figure: KpiFigure, asOf: string): Record<string, string> {
  switch (figure) {
    case "total":
      return {};
    case "overdue":
      return { dueBefore: asOf };
    case "due7":
      return { dueAfter: addDays(asOf, -1), dueBefore: addDays(asOf, 8) };
    case "due30":
      return { dueAfter: addDays(asOf, -1), dueBefore: addDays(asOf, 31) };
    case "noDueDate":
      return { noDueDate: "1" };
  }
}

const KPI_FIGURES: readonly KpiFigure[] = ["total", "overdue", "due7", "due30", "noDueDate"];

async function overviewHandler(ctx: Ctx): Promise<Response> {
  const division = await resolveDivision(ctx);
  const ref = toRef(division);
  const asOf = today(ctx);
  const db = ctx.env.DB;
  const rows = (
    await db
      .prepare(
        `SELECT kind, currency, open_minor, due_date, open_dc_minor, dc_currency
         FROM open_items WHERE division_id = ?1 AND status = 'open'`,
      )
      .bind(division.id)
      .all<{
        kind: OpenItemKind;
        currency: string;
        open_minor: number;
        due_date: string | null;
        open_dc_minor: number | null;
        dc_currency: string | null;
      }>()
  ).results;
  const dcDiv = {
    currency: division.base_currency,
    known: division.base_currency_read_at !== null,
  };
  const kpis = buildOverviewKpis(
    rows.map((r) => ({
      kind: r.kind === "invoice" ? ("receivable" as const) : ("payable" as const),
      currency: r.currency,
      openMinor: r.open_minor,
      dueDate: r.due_date,
      dcMinor: resolveDcMinor(
        {
          currency: r.currency,
          openMinor: r.open_minor,
          openDcMinor: r.open_dc_minor,
          dcCurrency: r.dc_currency,
        },
        dcDiv,
      ),
    })),
    asOf,
  );
  const dto =
    (path: DrilldownHint["path"]) =>
    (k: (typeof kpis.receivable)[number]): CurrencyKpisDto => {
      const drilldown = {} as Record<KpiFigure, DrilldownHint>;
      for (const f of KPI_FIGURES) {
        drilldown[f] = {
          path,
          query: { status: "open", currency: k.currency, ...kpiQuery(f, asOf) },
        };
      }
      return {
        currency: k.currency,
        total: k.total,
        overdue: k.overdue,
        due7: k.due7,
        due30: k.due30,
        noDueDate: k.noDueDate,
        avgDaysOverdue: k.avgDaysOverdue,
        drilldown,
      };
    };
  const state = await syncState(db, division.id);
  const fresh = freshnessOf(state, ["receivables", "payables"], ctx.nowMs);
  const body: OverviewResponse = {
    division: ref,
    asOf,
    stale: fresh.stale,
    freshness: fresh,
    kpis: {
      receivable: kpis.receivable.map(dto("/api/invoices")),
      payable: kpis.payable.map(dto("/api/bills")),
    },
    lastSync: state.map((r): SyncFreshnessEntry => ({
      entity: r.entity,
      status: r.last_status,
      completedAt: r.last_completed_at,
      finishedAt: r.last_finished_at,
      error: r.last_error,
    })),
  };
  return json(body);
}

export function registerReadRoutes(router: Router): void {
  router.add(
    "GET",
    "/api/invoices",
    ANY_ROLE,
    guarded((ctx) => listHandler(ctx, "invoice")),
  );
  router.add(
    "GET",
    "/api/bills",
    ANY_ROLE,
    guarded((ctx) => listHandler(ctx, "bill")),
  );
  router.add("GET", "/api/open-items/:id", ANY_ROLE, guarded(detailHandler));
  router.add("GET", "/api/relations/:id", ANY_ROLE, guarded(relationHandler));
  router.add("GET", "/api/reports/ageing", ANY_ROLE, guarded(ageingHandler));
  router.add("GET", "/api/overview", ANY_ROLE, guarded(overviewHandler));
}
