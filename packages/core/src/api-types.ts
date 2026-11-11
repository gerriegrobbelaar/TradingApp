/**
 * Response types of the read-only API (Phase 4, ADR 0022), shared by the Worker and the web app.
 * Money is always integer minor units plus a currency code; `dc*` fields are the division
 * currency amount (no FX conversion happens anywhere, EUR-equivalents come in Phase 6).
 * Dates are `YYYY-MM-DD` (Amsterdam calendar days); timestamps are UTC ISO-8601.
 * Error bodies are `{ error: string }` with 400 (bad query), 401, 403 (no role), 404 (unknown
 * division or row) and 503 `search_index_building` (retry after `Retry-After` seconds).
 * `asOf` is always today's Amsterdam date; other values are refused (400 `as_of_in_past` /
 * `as_of_in_future`). Shape tests: apps/worker/test/read-api-shapes.test.ts.
 */
import type { AgeingBucket, BucketAmounts } from "./ageing";

export type OpenItemKind = "invoice" | "bill";
export type OpenItemStatus = "open" | "closed";

export interface DivisionRef {
  /** Our divisions.id (not the Exact division number). */
  id: number;
  name: string;
  /** Division (base) currency, the currency of every `dc*` amount. */
  currency: string;
  /** True once the currency was read from Exact; false means "EUR by default, unverified". */
  currencyVerified: boolean;
}

export interface RelationRef {
  /** Our relations.id; null when the relation row has not been synced (yet). */
  id: number | null;
  name: string | null;
}

/** One row of GET /api/invoices (receivables) or GET /api/bills (payables). No IBANs or emails. */
export interface OpenItemRow {
  id: number;
  exactId: string;
  kind: OpenItemKind;
  status: OpenItemStatus;
  invoiceNumber: string | null;
  entryNumber: number | null;
  reference: string | null;
  relation: RelationRef;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string;
  /** Invoice total in `currency` when Exact told us, else null (never the open balance). */
  originalMinor: number | null;
  /** Open balance in `currency`; credit notes are negative. 0 when closed. */
  openMinor: number;
  /** Open balance in the division currency, or null when unknown. */
  dcMinor: number | null;
  dcCurrency: string;
  /** Null for closed items. */
  bucket: AgeingBucket | null;
  /** Days past due on `asOf` (<= 0: not yet due); null for closed items or without a due date. */
  daysOverdue: number | null;
  source: "list" | "sync" | null;
  /** When a sync last saw this item (open_items.synced_at). */
  lastSeenAt: string;
}

/** Totals over ALL rows matching the filters (not just the page), per currency. */
export interface CurrencyTotal {
  currency: string;
  count: number;
  openMinor: number;
  /** Sum of the known division-currency amounts. */
  dcMinor: number;
  /** Rows without a division-currency amount. */
  dcMissing: number;
  /** False when `dcMissing > 0`: dcMinor then understates the total. */
  dcComplete: boolean;
}

export interface OpenItemListResponse {
  division: DivisionRef;
  asOf: string;
  items: OpenItemRow[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  limit: number;
  /** Number of rows matching the filters. */
  total: number;
  totalsByCurrency: CurrencyTotal[];
}

export interface OpenItemDetail {
  division: DivisionRef;
  asOf: string;
  item: OpenItemRow;
  /** Stored amounts as we hold them. amountMinor may equal the open balance (ADR 0022). */
  amountMinor: number;
  rate: string | null;
  closedAt: string | null;
  openDcMinor: number | null;
  storedDcCurrency: string | null;
  relation: RelationSummary | null;
  provenance: {
    lastSeenAt: string;
    lastSeenSyncId: number | null;
    missedCycles: number;
    source: "list" | "sync" | null;
  };
  /** Deep link into Exact; null until the URL pattern is verified with credentials. */
  exactLink: string | null;
}

export interface RelationSummary {
  id: number;
  divisionId: number;
  exactId: string;
  code: string | null;
  name: string;
  isCustomer: boolean;
  isSupplier: boolean;
  country: string | null;
  /** Presence only, never the values. */
  hasVatNumber: boolean;
  hasEmail: boolean;
  updatedAt: string;
}

/** Query parameters that reproduce a figure on GET /api/invoices or /api/bills. */
export interface DrilldownHint {
  path: "/api/invoices" | "/api/bills";
  query: Record<string, string>;
}

export interface AgeingReportRow {
  relation: RelationRef;
  /** Open amount per bucket, and the item count per bucket. */
  buckets: BucketAmounts;
  bucketCounts: BucketAmounts;
  totalMinor: number;
  count: number;
  dcMinor: number;
  dcComplete: boolean;
  /*
   * No drill-down per row (it would repeat seven hints for every relation): use the currency's
   * `totals.drilldown` with `drilldownForRelation(hint, relation.id)`. Not possible when
   * `relation.id` is null (the relation has not been synced yet).
   */
}

export interface AgeingReportTotals {
  currency: string;
  buckets: BucketAmounts;
  bucketCounts: BucketAmounts;
  totalMinor: number;
  count: number;
  dcMinor: number;
  dcComplete: boolean;
  /** Per bucket and "total": list filters that return exactly this cell's rows. */
  drilldown: Record<AgeingBucket | "total", DrilldownHint>;
}

/** The drill-down of a totals cell narrowed to one relation (our relations.id). */
export function drilldownForRelation(hint: DrilldownHint, relationId: number): DrilldownHint {
  return { path: hint.path, query: { ...hint.query, relationId: String(relationId) } };
}

export interface AgeingReportResponse {
  division: DivisionRef;
  kind: "receivable" | "payable";
  asOf: string;
  /** Per currency, never summed across currencies. */
  currencies: { currency: string; rows: AgeingReportRow[]; totals: AgeingReportTotals }[];
  totalsByCurrency: AgeingReportTotals[];
  freshness: Freshness;
}

/** The sync_state entities whose complete reads freshness is based on. */
export type FreshnessEntity = "receivables" | "payables";

export interface Freshness {
  /**
   * The oldest last complete read of the `basis` entities (receivables, payables or both), or
   * null when one of them was never read completely. Not the last sync run: hourly runs complete
   * without reading open items.
   */
  lastCompletedAt: string | null;
  basis: FreshnessEntity[];
  /** True when lastCompletedAt is older than staleAfterHours, or null. */
  stale: boolean;
  staleAfterHours: number;
}

export interface KpiAmountDto {
  count: number;
  minor: number;
  dcMinor: number;
  dcComplete: boolean;
}

export type KpiFigure = "total" | "overdue" | "due7" | "due30" | "noDueDate";

export interface CurrencyKpisDto {
  currency: string;
  total: KpiAmountDto;
  /** Due before today (due today is not overdue). Credit notes reduce it. */
  overdue: KpiAmountDto;
  /** Due from today up to and including today + 7. */
  due7: KpiAmountDto;
  /** Due from today up to and including today + 30 (includes due7). */
  due30: KpiAmountDto;
  noDueDate: KpiAmountDto;
  /** Amount-weighted over overdue items with a positive balance, rounded half up; null if none. */
  avgDaysOverdue: number | null;
  /** Per figure: list filters that return exactly the items behind it. */
  drilldown: Record<KpiFigure, DrilldownHint>;
}

export interface SyncFreshnessEntry {
  entity: string;
  status: string | null;
  completedAt: string | null;
  finishedAt: string | null;
  /** Short machine code, never a provider message. */
  error: string | null;
}

export interface OverviewResponse {
  division: DivisionRef;
  asOf: string;
  /** Same as freshness.stale: open items not read completely within 36 hours. */
  stale: boolean;
  freshness: Freshness;
  kpis: {
    receivable: CurrencyKpisDto[];
    payable: CurrencyKpisDto[];
  };
  lastSync: SyncFreshnessEntry[];
}
