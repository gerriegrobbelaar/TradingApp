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
 * Nothing here writes, so there is no CSRF or audit concern. Responses are `no-store` (json()).
 */
import {
  addDays,
  AGEING_BUCKETS,
  buildAgeing,
  buildOverviewKpis,
  resolveDcMinor,
  toCalendarDate,
  amsterdamParts,
  type AgeingBucket,
  type AgeingReportResponse,
  type AgeingReportRow,
  type AgeingReportTotals,
  type DivisionRef,
  type DrilldownHint,
  type Freshness,
  type OpenItemDetail,
  type OpenItemKind,
  type OpenItemListResponse,
  type OverviewResponse,
  type RelationRef,
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
  mapRow,
  rowKey,
  rowMatches,
  totalsFromRows,
  totalsFromSql,
  type Cursor,
  type ListFilter,
  type ListRow,
  type TotalsRow,
} from "./queries";

const ANY_ROLE = { roles: ["admin", "finance", "approver", "viewer"] } as const;

export const STALE_AFTER_HOURS = 36;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** Text search filters in code (SQLite cannot fold diacritics); more candidates than this is refused. */
export const MAX_SEARCH_CANDIDATES = 20_000;

class BadRequest extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(code);
  }
}

type DivisionRow = DivisionJoin & { base_currency_read_at: string | null };

const toRef = (d: DivisionRow): DivisionRef => ({
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

function positiveIntParam(raw: string | null, name: string): number | null {
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
 * `asOf` for lists and reports. The tables hold today's open balances only, so a past date would
 * silently omit everything paid since: refused (ADR 0022). Default: today in Amsterdam.
 */
function asOfParam(ctx: Ctx): string {
  const now = today(ctx);
  const v = dateParam(ctx.url.searchParams.get("asOf"), "as_of");
  if (v === null) return now;
  if (v < now) throw new BadRequest("as_of_in_past");
  return v;
}

async function resolveDivision(ctx: Ctx): Promise<DivisionRow> {
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

async function divisionById(db: D1Database, id: number): Promise<DivisionRow | null> {
  return (await visibleDivisions(db)).find((d) => d.id === id) ?? null;
}

function guarded(fn: (ctx: Ctx) => Promise<Response>): (ctx: Ctx) => Promise<Response> {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      if (err instanceof BadRequest) {
        if (err.code === "unauthenticated") return json({ error: err.code }, 401);
        return json({ error: err.code }, err.status);
      }
      throw err;
    }
  };
}

// ---- lists ----------------------------------------------------------------------------------

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
  const q = (p.get("q") ?? "").trim();
  if (q.length > 100) throw new BadRequest("bad_q");
  const rawCursor = p.get("cursor");
  let cursor: Cursor | null = null;
  if (rawCursor !== null) {
    cursor = decodeCursor(rawCursor);
    if (!cursor || cursor.dir !== dir) throw new BadRequest("bad_cursor");
  }
  const dc = { currency: division.base_currency, known: division.base_currency_read_at !== null };
  const db = ctx.env.DB;

  if (q === "") {
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

  // Text search: fold case and diacritics in code over the rows the other filters leave.
  const list = buildListQuery(filter, dir, null, MAX_SEARCH_CANDIDATES + 1);
  const result = await db
    .prepare(list.sql)
    .bind(...list.binds)
    .all<ListRow>();
  if (result.results.length > MAX_SEARCH_CANDIDATES) throw new BadRequest("search_too_broad");
  const matching = result.results.filter((r) => rowMatches(q, r));
  const start = cursor
    ? matching.findIndex((r) => {
        const k = rowKey(r);
        return dir === "asc"
          ? k > cursor.key || (k === cursor.key && r.id > cursor.id)
          : k < cursor.key || (k === cursor.key && r.id < cursor.id);
      })
    : 0;
  const rest = start < 0 ? [] : matching.slice(start);
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  const totalsByCurrency = totalsFromRows(matching.map((r) => mapRow(r, ref, asOf)));
  const body: OpenItemListResponse = {
    division: ref,
    asOf,
    items: page.map((r) => mapRow(r, ref, asOf)),
    nextCursor:
      rest.length > limit && last ? encodeCursor({ dir, key: rowKey(last), id: last.id }) : null,
    limit,
    total: matching.length,
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

/** Filters that reproduce one ageing cell on the list endpoint. */
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
  relationId: number | null,
): Record<AgeingBucket | "total", DrilldownHint> {
  const out = {} as Record<AgeingBucket | "total", DrilldownHint>;
  for (const b of [...AGEING_BUCKETS, "total"] as const) {
    out[b] = {
      path,
      query: {
        status: "open",
        currency,
        asOf,
        ...(relationId === null ? {} : { relationId: String(relationId) }),
        ...bucketQuery(b, asOf),
      },
    };
  }
  return out;
}

async function freshness(
  db: D1Database,
  divisionId: number,
  nowMs: number,
): Promise<{ fresh: Freshness; entries: SyncFreshnessEntry[] }> {
  const rows = (
    await db
      .prepare(
        `SELECT entity, last_status, last_completed_at, last_finished_at, last_error
         FROM sync_state WHERE division_id = ?1 ORDER BY entity`,
      )
      .bind(divisionId)
      .all<{
        entity: string;
        last_status: string | null;
        last_completed_at: string | null;
        last_finished_at: string | null;
        last_error: string | null;
      }>()
  ).results;
  const run = rows.find((r) => r.entity === "run");
  const completed = run?.last_completed_at ?? null;
  const age = completed === null ? Infinity : nowMs - Date.parse(completed);
  return {
    fresh: {
      lastCompletedAt: completed,
      stale: !(age <= STALE_AFTER_HOURS * 3_600_000),
      staleAfterHours: STALE_AFTER_HOURS,
    },
    entries: rows.map((r) => ({
      entity: r.entity,
      status: r.last_status,
      completedAt: r.last_completed_at,
      finishedAt: r.last_finished_at,
      error: r.last_error,
    })),
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

  const rowIds = new Map<string, RelationRef>();
  const dcDiv = {
    currency: division.base_currency,
    known: division.base_currency_read_at !== null,
  };
  const report = buildAgeing(
    rows.map((r) => {
      const key = r.relation_exact_id ?? "";
      rowIds.set(key, { id: r.relation_row_id, name: r.relation_name ?? r.relation_row_name });
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
    drilldown: hints(path, t.currency, asOf, null),
  });
  const { fresh } = await freshness(db, division.id, ctx.nowMs);
  const body: AgeingReportResponse = {
    division: ref,
    kind: kindParam,
    asOf,
    currencies: report.currencies.map((c) => ({
      currency: c.currency,
      totals: totalsDto(c.totals),
      rows: c.rows.map((row): AgeingReportRow => {
        const rel = rowIds.get(row.relationKey) ?? { id: null, name: row.relationName };
        return {
          relation: { id: rel.id, name: row.relationName ?? rel.name },
          buckets: row.buckets,
          bucketCounts: row.bucketCounts,
          totalMinor: row.totalMinor,
          count: row.count,
          dcMinor: row.dc.minor,
          dcComplete: row.dc.complete,
          drilldown: rel.id === null ? null : hints(path, c.currency, asOf, rel.id),
        };
      }),
    })),
    totalsByCurrency: report.totalsByCurrency.map(totalsDto),
    freshness: fresh,
  };
  return json(body);
}

// ---- overview -------------------------------------------------------------------------------

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
  const { fresh, entries } = await freshness(db, division.id, ctx.nowMs);
  const body: OverviewResponse = {
    division: ref,
    asOf,
    stale: fresh.stale,
    freshness: fresh,
    kpis: { receivable: kpis.receivable, payable: kpis.payable },
    lastSync: entries,
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
