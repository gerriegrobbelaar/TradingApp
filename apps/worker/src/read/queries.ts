/**
 * SQL and row mapping for the read-only open-item API (Phase 4, ADR 0022). Pure query building and
 * mapping: no request handling here, so tests can run the exact list query through EXPLAIN.
 */
import {
  ageingBucket,
  daysOverdue,
  resolveDcMinor,
  searchText,
  type CurrencyTotal,
  type DivisionRef,
  type OpenItemKind,
  type OpenItemRow,
} from "@camelthorn/core";

/** Sort key of a row: unknown due dates sort last. Must match migration 0009 character for character. */
export const DUE_KEY = "COALESCE(oi.due_date, '9999-12-31')";
export const NO_DUE_KEY = "9999-12-31";

export interface ListFilter {
  divisionId: number;
  kind: OpenItemKind;
  status: "open" | "closed" | "all";
  /** Today (or the requested as-of date), for `overdue`. */
  asOf: string;
  overdue: boolean;
  currency: string | null;
  relationId: number | null;
  dueBefore: string | null;
  dueAfter: string | null;
  noDueDate: boolean;
  /** LIKE patterns from `likePatterns` (core/search.ts) against `search_text`; all must match. */
  search: string[];
}

export interface Cursor {
  dir: "asc" | "desc";
  key: string;
  id: number;
}

export interface Built {
  sql: string;
  binds: (string | number)[];
}

const FROM = `FROM open_items oi
  LEFT JOIN relations r ON r.division_id = oi.division_id AND r.exact_id = oi.relation_id`;

function where(f: ListFilter): Built {
  const parts = ["oi.division_id = ?", "oi.kind = ?"];
  const binds: (string | number)[] = [f.divisionId, f.kind];
  if (f.status !== "all") {
    parts.push("oi.status = ?");
    binds.push(f.status);
  }
  if (f.overdue) {
    parts.push("oi.status = 'open'", "oi.due_date < ?");
    binds.push(f.asOf);
  }
  if (f.currency !== null) {
    parts.push("oi.currency = ?");
    binds.push(f.currency);
  }
  if (f.relationId !== null) {
    // Resolved inside the division: another division's relation id matches nothing.
    parts.push(
      "oi.relation_id = (SELECT x.exact_id FROM relations x WHERE x.id = ? AND x.division_id = ?)",
    );
    binds.push(f.relationId, f.divisionId);
  }
  if (f.dueBefore !== null) {
    parts.push("oi.due_date < ?");
    binds.push(f.dueBefore);
  }
  if (f.dueAfter !== null) {
    parts.push("oi.due_date > ?");
    binds.push(f.dueAfter);
  }
  if (f.noDueDate) parts.push("oi.due_date IS NULL");
  for (const pattern of f.search) {
    parts.push("oi.search_text LIKE ? ESCAPE '\\'");
    binds.push(pattern);
  }
  return { sql: parts.join(" AND "), binds };
}

export const ROW_COLUMNS = `oi.id, oi.exact_id, oi.kind, oi.status, oi.invoice_number, oi.entry_number,
  oi.reference, oi.relation_id AS relation_exact_id, oi.relation_name, r.id AS relation_row_id,
  r.name AS relation_row_name, oi.invoice_date, oi.due_date, oi.currency, oi.original_minor,
  oi.open_minor, oi.open_dc_minor, oi.dc_currency, oi.source, oi.synced_at`;

export interface ListRow {
  id: number;
  exact_id: string;
  kind: OpenItemKind;
  status: "open" | "closed";
  invoice_number: string | null;
  entry_number: number | null;
  reference: string | null;
  relation_exact_id: string | null;
  relation_name: string | null;
  relation_row_id: number | null;
  relation_row_name: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string;
  original_minor: number | null;
  open_minor: number;
  open_dc_minor: number | null;
  dc_currency: string | null;
  source: "list" | "sync" | null;
  synced_at: string;
}

/**
 * The list query: one page, keyset on (due key, id). `limit` is the page size plus one (the extra
 * row tells whether there is a next page).
 */
export function buildListQuery(
  f: ListFilter,
  dir: "asc" | "desc",
  cursor: Cursor | null,
  limit: number | null,
): Built {
  const w = where(f);
  const binds = [...w.binds];
  let sql = `SELECT ${ROW_COLUMNS} ${FROM} WHERE ${w.sql}`;
  if (cursor) {
    sql += ` AND (${DUE_KEY}, oi.id) ${dir === "asc" ? ">" : "<"} (?, ?)`;
    binds.push(cursor.key, cursor.id);
  }
  const d = dir === "asc" ? "ASC" : "DESC";
  sql += ` ORDER BY ${DUE_KEY} ${d}, oi.id ${d}`;
  if (limit !== null) {
    sql += " LIMIT ?";
    binds.push(limit);
  }
  return { sql, binds };
}

export interface DivisionCurrency {
  currency: string;
  known: boolean;
}

/** SQL mirror of resolveDcMinor (packages/core/src/ageing.ts); a test checks they agree. */
const DCM = `CASE
    WHEN oi.open_dc_minor IS NOT NULL AND (oi.dc_currency IS NULL OR oi.dc_currency = ?) THEN oi.open_dc_minor
    WHEN ? = 1 AND oi.currency = ? THEN oi.open_minor
  END`;

/** Count and sums per currency over every row matching the filter. */
export function buildTotalsQuery(f: ListFilter, dc: DivisionCurrency): Built {
  const w = where(f);
  return {
    sql: `SELECT currency, COUNT(*) AS n, COALESCE(SUM(open_minor), 0) AS open_minor,
            COALESCE(SUM(dcm), 0) AS dc_minor,
            COALESCE(SUM(CASE WHEN dcm IS NULL THEN 1 ELSE 0 END), 0) AS dc_missing
          FROM (SELECT oi.currency AS currency, oi.open_minor AS open_minor, ${DCM} AS dcm
                ${FROM} WHERE ${w.sql})
          GROUP BY currency ORDER BY currency`,
    binds: [dc.currency, dc.known ? 1 : 0, dc.currency, ...w.binds],
  };
}

export interface TotalsRow {
  currency: string;
  n: number;
  open_minor: number;
  dc_minor: number;
  dc_missing: number;
}

export function totalsFromSql(rows: readonly TotalsRow[]): CurrencyTotal[] {
  return rows.map((r) => ({
    currency: r.currency,
    count: r.n,
    openMinor: r.open_minor,
    dcMinor: r.dc_minor,
    dcMissing: r.dc_missing,
    dcComplete: r.dc_missing === 0,
  }));
}

export function mapRow(r: ListRow, division: DivisionRef, asOf: string): OpenItemRow {
  const open = r.status === "open";
  return {
    id: r.id,
    exactId: r.exact_id,
    kind: r.kind,
    status: r.status,
    invoiceNumber: r.invoice_number,
    entryNumber: r.entry_number,
    reference: r.reference,
    relation: {
      id: r.relation_row_id,
      name: r.relation_name ?? r.relation_row_name,
    },
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    currency: r.currency,
    originalMinor: r.original_minor,
    openMinor: r.open_minor,
    dcMinor: resolveDcMinor(
      {
        currency: r.currency,
        openMinor: r.open_minor,
        openDcMinor: r.open_dc_minor,
        dcCurrency: r.dc_currency,
      },
      { currency: division.currency, known: division.currencyVerified },
    ),
    dcCurrency: division.currency,
    bucket: open ? ageingBucket(r.due_date, asOf) : null,
    daysOverdue: open ? daysOverdue(r.due_date, asOf) : null,
    source: r.source,
    lastSeenAt: r.synced_at,
  };
}

/** Rows written before migration 0009 have no search text yet; filled on the first search. */
export const PENDING_SEARCH_SQL = `SELECT id, invoice_number, entry_number, relation_name, reference
  FROM open_items WHERE division_id = ?1 AND search_text IS NULL LIMIT ?2`;

export interface PendingSearchRow {
  id: number;
  invoice_number: string | null;
  entry_number: number | null;
  relation_name: string | null;
  reference: string | null;
}

/** One statement for a whole chunk: `?1` is a JSON array of `[id, text]` pairs. */
export const FILL_SEARCH_SQL = `UPDATE open_items SET search_text = json_extract(j.value, '$[1]')
  FROM json_each(?1) AS j
  WHERE open_items.id = json_extract(j.value, '$[0]') AND open_items.search_text IS NULL`;

/** The same fields, in the same order, as the sync upsert (exact/sync.ts, openItemStmt). */
export function pendingSearchPairs(rows: readonly PendingSearchRow[]): string {
  return JSON.stringify(
    rows.map((r) => [
      r.id,
      searchText([r.invoice_number, r.entry_number, r.relation_name, r.reference]),
    ]),
  );
}

export function rowKey(r: ListRow): string {
  return r.due_date ?? NO_DUE_KEY;
}

export function encodeCursor(c: Cursor): string {
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
