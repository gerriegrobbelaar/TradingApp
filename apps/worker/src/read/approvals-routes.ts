/**
 * Read-only API for the Approvals screen (Phase 4, task K4, ADR 0025).
 *
 *  GET /api/approvals?division=&status=pending_approval|approved|rejected|all&q=&limit=&cursor=
 *  GET /api/approvals/:id
 *
 * Any signed-in role may read. Same division rules, error codes and `no-store` as the other read
 * routes (routes.ts): `?division=` is our divisions.id (400 bad, 404 unknown or disabled), default
 * the user's saved choice. `status` defaults to `pending_approval`; `unknown` cannot be asked for
 * (such entries show under `all` and in `countsByStatus`). Order: pending entries oldest first (the
 * ones waiting longest on top), every other filter newest first, ties by id; a cursor is bound to
 * the direction it was issued for. `available` is false until the purchase entries were read
 * completely once or when Exact refuses the resource; the list is then empty. Nothing here is a
 * write: no CSRF or audit concern. No IBAN or email is stored in the table, so none is returned.
 */
import {
  APPROVAL_STATUSES,
  approvalAgeDays,
  type ApprovalDetail,
  type ApprovalItemDto,
  type ApprovalStatus,
  type ApprovalsResponse,
} from "@camelthorn/core";
import { json, type Ctx, type Router } from "../router";
import {
  ANY_ROLE,
  BadRequest,
  divisionById,
  freshnessOf,
  guarded,
  positiveIntParam,
  resolveDivision,
  searchParam,
  syncState,
  today,
} from "./routes";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** Sort key of a row: unknown entry dates sort first in ascending, last in descending order. */
export const ENTRY_KEY = "COALESCE(pe.entry_date, '0000-01-01')";
export const NO_ENTRY_KEY = "0000-01-01";

type StatusFilter = ApprovalStatus | "all";

interface Cursor {
  dir: "asc" | "desc";
  key: string;
  id: number;
}

interface Built {
  sql: string;
  binds: (string | number)[];
}

interface Row {
  id: number;
  exact_id: string;
  entry_number: string | null;
  relation_name: string | null;
  relation_row_id: number | null;
  relation_row_name: string | null;
  has_relation_id: number;
  currency: string;
  amount_minor: number;
  due_date: string | null;
  entry_date: string | null;
  status: ApprovalStatus;
  submitted_at: string | null;
  has_pdf: number | null;
}

const COLUMNS = `pe.id, pe.exact_id, pe.entry_number, pe.relation_name, r.id AS relation_row_id,
  r.name AS relation_row_name, (pe.relation_id IS NOT NULL) AS has_relation_id, pe.currency,
  pe.amount_minor, pe.due_date, pe.entry_date, pe.status, pe.submitted_at, pe.has_pdf`;

const FROM = `FROM purchase_entries pe
  LEFT JOIN relations r ON r.division_id = pe.division_id AND r.exact_id = pe.relation_id`;

function searchWhere(divisionId: number, search: readonly string[]): Built {
  const parts = ["pe.division_id = ?"];
  const binds: (string | number)[] = [divisionId];
  for (const pattern of search) {
    parts.push("pe.search_text LIKE ? ESCAPE '\\'");
    binds.push(pattern);
  }
  return { sql: parts.join(" AND "), binds };
}

export function buildListQuery(
  divisionId: number,
  status: StatusFilter,
  search: readonly string[],
  dir: "asc" | "desc",
  cursor: Cursor | null,
  limit: number,
): Built {
  const w = searchWhere(divisionId, search);
  const binds = [...w.binds];
  let sql = `SELECT ${COLUMNS} ${FROM} WHERE ${w.sql}`;
  if (status !== "all") {
    sql += " AND pe.status = ?";
    binds.push(status);
  }
  if (cursor) {
    sql += ` AND (${ENTRY_KEY}, pe.id) ${dir === "asc" ? ">" : "<"} (?, ?)`;
    binds.push(cursor.key, cursor.id);
  }
  const d = dir === "asc" ? "ASC" : "DESC";
  sql += ` ORDER BY ${ENTRY_KEY} ${d}, pe.id ${d} LIMIT ?`;
  binds.push(limit);
  return { sql, binds };
}

export function buildCountsQuery(divisionId: number, search: readonly string[]): Built {
  const w = searchWhere(divisionId, search);
  return {
    sql: `SELECT pe.status AS status, COUNT(*) AS n FROM purchase_entries pe
          WHERE ${w.sql} GROUP BY pe.status`,
    binds: w.binds,
  };
}

function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify([c.dir === "asc" ? "a" : "d", c.key, c.id]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Null for anything that is not a cursor we issued (strict: shape, key format, positive id). */
export function decodeCursor(raw: string): Cursor | null {
  try {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return null;
    const v: unknown = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [d, key, id] = v as unknown[];
    if ((d !== "a" && d !== "d") || typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      return null;
    }
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null;
    return { dir: d === "a" ? "asc" : "desc", key, id };
  } catch {
    return null;
  }
}

function mapRow(r: Row, todayDate: string): ApprovalItemDto {
  const name = r.relation_name ?? r.relation_row_name;
  const item = {
    status: r.status,
    submittedAt: r.submitted_at,
    entryDate: r.entry_date,
  };
  return {
    id: r.id,
    exactId: r.exact_id,
    entryNumber: r.entry_number,
    relation:
      name === null && r.relation_row_id === null && r.has_relation_id === 0
        ? null
        : { id: r.relation_row_id, name: name ?? "" },
    currency: r.currency,
    amountMinor: r.amount_minor,
    dueDate: r.due_date,
    entryDate: r.entry_date,
    status: r.status,
    submittedAt: r.submitted_at,
    ageDays: approvalAgeDays(item, todayDate),
    hasPdf: r.has_pdf === null ? null : r.has_pdf === 1,
  };
}

const zeroCounts = (): Record<ApprovalStatus, number> => ({
  pending_approval: 0,
  approved: 0,
  rejected: 0,
  unknown: 0,
});

async function listHandler(ctx: Ctx): Promise<Response> {
  const division = await resolveDivision(ctx);
  const p = ctx.url.searchParams;
  const rawStatus = p.get("status") ?? "pending_approval";
  if (rawStatus !== "all" && !["pending_approval", "approved", "rejected"].includes(rawStatus)) {
    throw new BadRequest("bad_status");
  }
  const status = rawStatus as StatusFilter;
  const search = searchParam(p.get("q"));
  const limit = positiveIntParam(p.get("limit"), "limit") ?? DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) throw new BadRequest("bad_limit");
  const dir = status === "pending_approval" ? "asc" : "desc";
  const rawCursor = p.get("cursor");
  let cursor: Cursor | null = null;
  if (rawCursor !== null) {
    cursor = decodeCursor(rawCursor);
    if (!cursor || cursor.dir !== dir) throw new BadRequest("bad_cursor");
  }
  const db = ctx.env.DB;
  const state = await syncState(db, division.id);
  const fresh = freshnessOf(state, ["purchase_entries"], ctx.nowMs);
  const available = state.some(
    (r) => r.entity === "purchase_entries" && r.last_completed_at !== null,
  );
  const base = { division: { id: division.id, name: division.name }, freshness: fresh };
  if (!available) {
    const empty: ApprovalsResponse = {
      ...base,
      items: [],
      nextCursor: null,
      total: 0,
      countsByStatus: zeroCounts(),
      available: false,
    };
    return json(empty);
  }

  const list = buildListQuery(division.id, status, search, dir, cursor, limit + 1);
  const counts = buildCountsQuery(division.id, search);
  const [rows, countRows] = await db.batch<Row | { status: ApprovalStatus; n: number }>([
    db.prepare(list.sql).bind(...list.binds),
    db.prepare(counts.sql).bind(...counts.binds),
  ]);
  const all = (rows?.results ?? []) as Row[];
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  const countsByStatus = zeroCounts();
  for (const c of (countRows?.results ?? []) as { status: ApprovalStatus; n: number }[]) {
    if (APPROVAL_STATUSES.includes(c.status)) countsByStatus[c.status] = c.n;
  }
  const total =
    status === "all"
      ? APPROVAL_STATUSES.reduce((n, s) => n + countsByStatus[s], 0)
      : countsByStatus[status];
  const todayDate = today(ctx);
  const body: ApprovalsResponse = {
    ...base,
    items: page.map((r) => mapRow(r, todayDate)),
    nextCursor:
      all.length > limit && last
        ? encodeCursor({ dir, key: last.entry_date ?? NO_ENTRY_KEY, id: last.id })
        : null,
    total,
    countsByStatus,
    available: true,
  };
  return json(body);
}

interface DetailRow extends Row {
  division_id: number;
  status_code: number | null;
  amount_dc_minor: number | null;
  dc_currency: string | null;
  modified_at: string | null;
  synced_at: string;
  last_seen_sync_id: number | null;
  missed_cycles: number;
}

async function detailHandler(ctx: Ctx): Promise<Response> {
  const id = positiveIntParam(ctx.params["id"] ?? null, "id");
  if (id === null) throw new BadRequest("bad_id");
  const db = ctx.env.DB;
  const row = await db
    .prepare(
      `SELECT ${COLUMNS}, pe.division_id, pe.status_code, pe.amount_dc_minor, pe.dc_currency,
              pe.modified_at, pe.synced_at, pe.last_seen_sync_id, pe.missed_cycles
       ${FROM} WHERE pe.id = ?`,
    )
    .bind(id)
    .first<DetailRow>();
  if (!row) throw new BadRequest("not_found", 404);
  const division = await divisionById(db, row.division_id);
  if (!division) throw new BadRequest("not_found", 404);
  const body: ApprovalDetail = {
    division: { id: division.id, name: division.name },
    item: mapRow(row, today(ctx)),
    statusCode: row.status_code,
    amountDcMinor: row.amount_dc_minor,
    dcCurrency: row.dc_currency,
    modifiedAt: row.modified_at,
    provenance: {
      lastSeenAt: row.synced_at,
      lastSeenSyncId: row.last_seen_sync_id,
      missedCycles: row.missed_cycles,
    },
  };
  return json(body);
}

export function registerApprovalsRoutes(router: Router): void {
  router.add("GET", "/api/approvals", ANY_ROLE, guarded(listHandler));
  router.add("GET", "/api/approvals/:id", ANY_ROLE, guarded(detailHandler));
}
