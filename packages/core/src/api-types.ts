/**
 * Response types of the read-only API (Phase 4, ADR 0022), shared by the Worker and the web app.
 * Money is always integer minor units plus a currency code; `dc*` fields are the division
 * currency amount (no FX conversion happens anywhere, EUR-equivalents come in Phase 6).
 * Dates are `YYYY-MM-DD` (Amsterdam calendar days); timestamps are UTC ISO-8601.
 * Error bodies are `{ error: string }` with 400 (bad query), 401, 403 (no role), 404 (unknown
 * division or row, or a `relationId` of another division: `unknown_relation`) and 503
 * `search_index_building` (retry after `Retry-After` seconds).
 * `asOf` is always today's Amsterdam date; other values are refused (400 `as_of_in_past` /
 * `as_of_in_future`). Shape tests: apps/worker/test/read-api-shapes.test.ts.
 */
import type { AgeingBucket, BucketAmounts } from "./ageing";
import type { BalanceSheet } from "./reports/balance-sheet";
import type { BalanceSheetSection, ProfitLossSection } from "./reports/classify";
import type { ProfitLoss } from "./reports/profit-loss";

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
  /**
   * True for an open item that the last complete full read did not see (`missed_cycles > 0`): it
   * may have been paid in Exact since. Open items refresh nightly (review S8).
   */
  possiblyPaid: boolean;
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
  /** Open rows in this total that the last complete full read did not see (review S8). */
  possiblyPaid: number;
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
  /**
   * Last complete read of this kind's open items (`receivables` for /api/invoices, `payables`
   * for /api/bills), same basis as the Overview and the ageing report (review K3a).
   */
  freshness: Freshness;
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
export type FreshnessEntity = "receivables" | "payables" | "purchase_entries";

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

// ---- ledger and reports (task K2, ADR 0024) -----------------------------------------------------
// Every ledger amount is integer minor units in the DIVISION currency (`division.currency`), at
// that currency's scale. Nothing here is converted. Report builders live in ./reports.

export type LedgerEntity = "gl_accounts" | "gl_balances" | "gl_budgets";

export interface LedgerFreshnessEntry {
  /**
   * Last COMPLETE read, or null when never. Balances and budgets: of the requested year. Balances
   * of the current year go stale after 36 hours; other years and budgets, read at most weekly,
   * after 8 days.
   */
  lastCompletedAt: string | null;
  /** True when never read, or older than staleAfterHours. */
  stale: boolean;
  staleAfterHours: number;
}

export type LedgerFreshness = Record<LedgerEntity, LedgerFreshnessEntry>;

/**
 * `not_synced`: the balances of the requested year were never read from Exact. `no_data`: they
 * were read completely but Exact holds no figures for that year (a new year before its opening
 * balances exist, a new administration). Either way the answer is still 200, with `report: null`,
 * so a screen can show an empty state instead of an error or an empty sheet presented as real.
 */
export type LedgerReportStatus = "ok" | "not_synced" | "no_data";

export interface BalanceSheetResponse {
  division: DivisionRef;
  status: LedgerReportStatus;
  year: number;
  /** Last period included. */
  period: number;
  /**
   * Highest period (1 and up) of `year` that holds any ledger figure, null without one or when the
   * year was never read completely. Without a `period` in the request the report uses this period,
   * capped at the current month (or 12 for another year) (review K3b).
   */
  latestPeriodWithData: number | null;
  /** Null when no comparison was asked for or the compare year was never synced. */
  compareYear: number | null;
  /** True when a comparison was asked for but that year was never synced. */
  compareMissing: boolean;
  report: BalanceSheet | null;
  freshness: LedgerFreshness;
  /** Freshness of the compare year's balances (read at most weekly), null without one. */
  compareFreshness: LedgerFreshnessEntry | null;
  budgetsAvailable: boolean;
  /**
   * Figures in the data used that Exact split over a field we do not read (the same key twice in
   * one read, ADR 0024): they may be too low. 0 normally; a screen warns otherwise.
   */
  splitKeys: number;
}

export interface ProfitLossResponse {
  division: DivisionRef;
  status: LedgerReportStatus;
  year: number;
  periodTo: number;
  /** As on the balance sheet: the default `periodTo` when the request names none. */
  latestPeriodWithData: number | null;
  /** The year of the last-year column. */
  compareYear: number;
  /** True when that year was never synced: the last-year figures are then null. */
  compareMissing: boolean;
  report: ProfitLoss | null;
  /** The budget scenario used (its GUID, "" for none), or null without budgets. */
  budgetScenario: string | null;
  /** Every scenario that has budget rows for the year. */
  budgetScenarios: string[];
  freshness: LedgerFreshness;
  /** Freshness of the compare year's balances (read at most weekly), null when never read. */
  compareFreshness: LedgerFreshnessEntry | null;
  /** False while Exact refuses the budget resource (not licensed); budget figures are then null. */
  budgetsAvailable: boolean;
  /** As on the balance sheet, including the budgets used. */
  splitKeys: number;
}

export type LedgerStatement = "balance_sheet" | "profit_loss";

export interface LedgerAccountRow {
  /** Our gl_accounts.id. */
  id: number;
  exactId: string;
  code: string | null;
  name: string;
  type: number | null;
  typeDescription: string | null;
  balanceSide: "D" | "C" | null;
  balanceType: "B" | "W" | null;
  isBlocked: boolean;
  /** False once Exact stopped returning the account (kept, never deleted). */
  isActive: boolean;
  statement: LedgerStatement;
  /** The report section the account is shown in; "unclassified" when it cannot be placed. */
  section: BalanceSheetSection | ProfitLossSection;
}

export interface LedgerAccountsResponse {
  division: DivisionRef;
  status: LedgerReportStatus;
  /** True when the chart has more than the 5,000 accounts one answer holds. */
  truncated: boolean;
  accounts: LedgerAccountRow[];
  unclassifiedCount: number;
  freshness: LedgerFreshness;
}

export interface LedgerPeriodRow {
  period: number;
  /** debit - credit of the period (rows split by cost centre or status are added). */
  amountMinor: number;
  debitMinor: number | null;
  creditMinor: number | null;
  /** Stored rows added up. */
  rows: number;
}

export interface LedgerAccountBalancesResponse {
  division: DivisionRef;
  status: LedgerReportStatus;
  year: number;
  account: LedgerAccountRow;
  periods: LedgerPeriodRow[];
  /** Sum of the period amounts shown. */
  totalMinor: number;
  freshness: LedgerFreshness;
}

// ---- approvals (task K4, ADR 0025) ----------------------------------------------------------

export type ApprovalStatus = "pending_approval" | "approved" | "rejected" | "unknown";

/**
 * One purchase entry as the Approvals screen shows it. No IBANs or emails. `amountMinor` is the
 * entry total in `currency` (credit notes negative). `status` comes from the one mapping table in
 * approvals.ts (unverified, ADR 0025; unknown codes are 'unknown'). `ageDays` is set for pending
 * items only. `hasPdf` is null when we could not tell.
 */
export interface ApprovalItemDto {
  id: number;
  exactId: string;
  entryNumber: string | null;
  relation: { id: number | null; name: string } | null;
  currency: string;
  amountMinor: number;
  dueDate: string | null;
  entryDate: string | null;
  status: ApprovalStatus;
  submittedAt: string | null;
  ageDays: number | null;
  hasPdf: boolean | null;
}

/**
 * GET /api/approvals?division=&status=pending_approval|approved|rejected|all&q=&limit=&cursor=
 * `available` is false until the purchase entries have been read completely once (also when Exact
 * has refused the resource from the start); items are then empty. After that, a refusal or failing
 * reads show as `freshness.stale`, not as unavailable. `countsByStatus` ignores the status filter but
 * follows `q`.
 */
export interface ApprovalsResponse {
  division: { id: number; name: string };
  items: ApprovalItemDto[];
  nextCursor: string | null;
  total: number;
  countsByStatus: Record<ApprovalStatus, number>;
  freshness: Freshness;
  available: boolean;
  /**
   * True once an admin has recorded that the status mapping was verified against Exact (review S2,
   * ADR 0025). While false the screen shows a non-dismissable notice and nothing may rely on the
   * statuses for a payment.
   */
  mappingVerified: boolean;
}

/**
 * GET /api/approvals/status-codes?division= (admin only): cached entries per raw Exact Status
 * code, to verify the unverified mapping on a real division (ADR 0025). `storedStatus` is what
 * the rows hold, `mappedStatus` what the current table makes of the code (they differ only after
 * a table change, until the rows are read again).
 */
export interface ApprovalStatusCodesResponse {
  division: { id: number; name: string };
  table: { statusCode: number; status: ApprovalStatus }[];
  /** The stored marker, null while the mapping is not verified. */
  mappingVerified: { verifiedAt: string; verifiedBy: string; adrRef: string } | null;
  codes: {
    statusCode: number | null;
    storedStatus: ApprovalStatus;
    mappedStatus: ApprovalStatus;
    count: number;
    lastSeenAt: string;
  }[];
}

/** GET /api/approvals/:id */
export interface ApprovalDetail {
  division: { id: number; name: string };
  item: ApprovalItemDto;
  statusCode: number | null;
  amountDcMinor: number | null;
  dcCurrency: string | null;
  modifiedAt: string | null;
  provenance: {
    lastSeenAt: string;
    lastSeenSyncId: number | null;
    missedCycles: number;
  };
}
