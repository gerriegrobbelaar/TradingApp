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
  /**
   * The amount as stored: the invoice total when Exact told us, else the open balance (ADR 0022).
   * Shown only on the item sheet as "Amount as stored"; lists and totals use openMinor and
   * originalMinor.
   */
  storedMinor: number;
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
export type FreshnessEntity =
  "receivables" | "payables" | "purchase_entries" | "bank_accounts" | "bank_transactions";

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
   * True only while an admin's "verified" mark exists AND was made for the status table and join
   * rule as they are now (the mark stores their SHA-256; review S2, ADR 0025). While false the
   * screen shows a non-dismissable notice and nothing may rely on the statuses for a payment.
   */
  mappingVerified: boolean;
  /** True when a mark exists but the table or join rule changed since it was made. */
  mappingChanged: boolean;
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
  /** True only when `marker` exists and its hash equals `currentMappingHash`. */
  mappingVerified: boolean;
  /** A mark exists but was made for another table or join rule (it no longer counts). */
  mappingChanged: boolean;
  /** The stored mark (also when it no longer counts), null when there is none. */
  marker: { verifiedAt: string; verifiedBy: string; adrRef: string; mappingHash: string } | null;
  /** SHA-256 of the current table and join rule; PUT mapping-verified must send it back. */
  currentMappingHash: string;
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

// ---- Bank (Revolut) screen, Phase 5 (R3a owns the worker side, R3b the screen; ADRs 0032, 0033) -------
//
// Contract (review R3b):
// - Amounts are integer minor units in the leg's own currency at its real exponent (JPY 0,
//   KWD 3). `amountMinor` is SIGNED: positive = money in, negative = money out, 0 = neither.
// - IBANs are masked by the server (core `maskIban`: "NL91****4300"; short values "****"); a
//   full IBAN or a provider counterparty id never leaves the server. The screen renders only the
//   last four characters of whatever it gets.
// - Currencies are never summed together; every total is per currency.

export interface BankAccountDto {
  id: number;
  name: string;
  currency: string;
  /** Signed minor units; null until Revolut reported a balance. */
  balanceMinor: number | null;
  balanceAt: string | null;
  state: string | null;
  /** Masked by the server; never a full IBAN. */
  ibanMasked: string | null;
  isActive: boolean;
}

export type BankTxState = "pending" | "completed" | "declined" | "failed" | "reverted" | "unknown";

export interface BankTransactionDto {
  /** Row id (one per leg); stable, unique. */
  id: number;
  /** Revolut transaction id; several legs (rows) can share it. */
  externalId: string;
  legId: string;
  accountId: number | null;
  accountName: string | null;
  type: string | null;
  /** A stored state the server does not recognise is reported as 'unknown', never 'completed'. */
  state: BankTxState;
  /** True only for completed / declined / failed / reverted (CLAUDE.md §3: book final only). */
  isFinal: boolean;
  /** UTC ISO. Lists are ordered by it (desc) and `from` / `to` filter on it. */
  createdAt: string;
  completedAt: string | null;
  /** SIGNED: positive = in, negative = out. */
  amountMinor: number;
  currency: string;
  reference: string | null;
  description: string | null;
  counterpartyName: string | null;
  /** Masked by the server; never a full IBAN. */
  counterpartyIbanMasked: string | null;
  /**
   * Number of legs stored for `externalId`, whatever the filter or page. The worker (R3a) always
   * sends it; it stays optional so the screen keeps its fallback: when absent it counts the legs
   * it has loaded and says "at least" when the list is filtered or more pages remain.
   */
  legCount?: number;
}

export interface BankAccountsResponse {
  connection: {
    id: number;
    /** connections.status: 'pending' | 'active' | 'expired' | 'disabled' | 'needs_reauth'. */
    status: string;
    createsBankEntries: boolean | null;
    paymentsMode: string;
    /**
     * Transactions the sync could not store and keeps retrying (Phase 5 review S2). Optional and
     * additive: absent from older servers; 0 when nothing is waiting.
     */
    quarantined?: number;
    /** Of `quarantined`, the rows whose retries ran out (still counted, no more calls). */
    quarantineGaveUp?: number;
    /** Transactions flagged `state_conflict` (Revolut contradicted a final or matched row). */
    stateConflicts?: number;
    /** True while the one-off 90-day initial backfill has not completed (review S1, N7). */
    initialBackfillPending?: boolean;
  } | null;
  accounts: BankAccountDto[];
  /** Per currency, ACTIVE accounts with a known balance only; `accounts` counts those. */
  totalsByCurrency: { currency: string; balanceMinor: number; accounts: number }[];
  freshness: Freshness;
  /** False until the first successful sync. */
  available: boolean;
}

/**
 * GET /api/bank/transactions?account=&state=&direction=&from=&to=&q=&limit=&cursor=
 * - `state`: ONE of pending | completed | declined | failed | reverted (or absent / 'all').
 * - `direction`: in (amount > 0) | out (amount < 0) | all.
 * - `from` / `to`: Amsterdam calendar days (YYYY-MM-DD), both inclusive, on `createdAt`.
 * - `q`: case-insensitive text in reference, description and counterparty name (never the IBAN).
 */
export interface BankTransactionsResponse {
  items: BankTransactionDto[];
  nextCursor: string | null;
  /** All rows matching the filter, every state. */
  total: number;
  /**
   * Per currency over the whole filter (not the page), PENDING AND COMPLETED rows only: declined,
   * failed, reverted and unknown rows are listed but never summed. `inMinor` and `outMinor` are
   * both POSITIVE magnitudes (out is the sum of -amountMinor of negative rows); `count` is the
   * number of pending and completed rows in that currency.
   */
  totalsByCurrency: { currency: string; inMinor: number; outMinor: number; count: number }[];
  freshness: Freshness;
  available: boolean;
}

export interface BankTransactionDetail extends BankTransactionDto {
  /** Every leg of the same Revolut transaction id (including this one), by leg id. */
  legs: BankTransactionDto[];
  firstSeenAt: string;
  lastEventAt: string | null;
  source: "webhook" | "poll" | "backfill";
}

// ---- ECB exchange rates (Phase 6, F2) ----------------------------------------------------------

export interface FxRateDto {
  currency: string;
  rate: string;
  rateDate: string;
  source: "ECB";
}

/**
 * GET /api/fx/rates?date=YYYY-MM-DD (default: today, Amsterdam). Units of currency per 1 EUR, as
 * canonical decimal strings (core parseRate form: "1.165", never "1.1650"). For each currency the
 * newest rate on or before `date`; `rateDate` is that rate's own date (a weekend or holiday reuses
 * the last rate and shows its date). Same selection as core `buildRateTable`: a currency whose
 * newest rate is more than ECB_MAX_RATE_AGE_TARGET_DAYS (10) TARGET working days older than
 * `asOf` (the ECB stopped publishing it, e.g. HRK) is left out.
 *
 * `stale` / `staleReason` / `workingDaysOld` describe the FEED: the newest rate stored at all (up
 * to today) against now, whatever `date` asks for, and independent of the job's state (a disabled
 * or failing job shows as stale once the rates age). Stale = older than the date expected at this
 * moment (today's after 17:30 Amsterdam on a TARGET working day, else the previous working day;
 * ADR 0036). `workingDaysOld` = TARGET working days in (newest, today]: Friday's rate on Monday
 * morning is 1 and not stale; on Monday after 17:30 it is 1 and stale.
 */
export interface FxRatesResponse {
  base: "EUR";
  /** Date of the newest rate returned, or null when there is none. */
  asOf: string | null;
  rates: FxRateDto[];
  stale: boolean;
  staleReason: "never_imported" | "older_than_one_working_day" | null;
  workingDaysOld: number | null;
  lastImportAt: string | null;
  lastImportStatus: string | null;
  /**
   * Code of the last import's outcome (fx_import_state.last_error_code), for example
   * rate_not_published, ecb_rate_limited, bad_response, too_late, ecb_network; null when none.
   * Optional so older clients' fixtures stay valid; the Worker always sends it.
   */
  lastImportCode?: string | null;
  /**
   * Number of unresolved ECB rate conflicts (the ECB shows another value than the one stored for a
   * date, ADR 0039). Optional so older fixtures stay valid; the Worker always sends it.
   */
  unresolvedConflicts?: number;
  /** 'ECB reference rates are for information only…' */
  notice: string;
}

/** GET /api/fx/history?currency=USD&days=90 (days 1..400, oldest first). */
export interface FxHistoryResponse {
  currency: string;
  base: "EUR";
  points: { rateDate: string; rate: string }[];
}

/** A stored ECB rate the ECB later reported differently (GET /api/fx/conflicts, ADR 0039). */
export interface FxConflictDto {
  id: number;
  currency: string;
  rateDate: string;
  /** The rate we hold for that date (canonical decimal text). */
  storedRate: string;
  /** What the ECB showed when the conflict was seen. */
  ecbRate: string;
  firstSeenAt: string;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: "kept" | "accepted" | null;
}

/** GET /api/fx/conflicts (admin, finance): unresolved first; `?resolved=1` adds resolved ones. */
export interface FxConflictsResponse {
  unresolvedCount: number;
  conflicts: FxConflictDto[];
}

/** POST /api/fx/conflicts/:id/resolve (admin, step-up): `confirm` must be true. */
export interface FxConflictResolveRequest {
  resolution: "kept" | "accepted";
  confirm: true;
}

/** `alreadyResolved`: the same resolution was applied before; nothing changed this time. */
export interface FxConflictResolveResponse {
  conflict: FxConflictDto;
  alreadyResolved: boolean;
}

// ---- Bank matching (Phase 7, M7b, ADR 0042) ---------------------------------------------------
// Read: any signed-in role. Matching actions: finance or admin. Config, account map and patterns:
// admin (writes also need a fresh sign-in). IBANs are always masked (first 4 and last 4). Errors are
// `{ error: code }`: 400 bad_*, 401, 403, 404 not_found, 409 (state changed: already_matched,
// tx_ignored, tx_state_conflict, already_undone, already_booked_in_exact, item_changed, ...),
// 422 (validation of a manual match: currency_mismatch, direction_mismatch, ...).

export type MatchStatus = "unmatched" | "suggested" | "matched" | "ignored";
export type MatchQueueFilter = "review" | "suggested" | "ignored" | "all";
export type MatchSource = "auto" | "manual" | "ledger";
export type MatchIgnoreReason = "internal_transfer" | "not_ours" | "other";

export interface MatchBlockedReason {
  code: string;
  /** Plain English, from core explainBlock. */
  text: string;
}

export interface MatchAllocationDto {
  openItemId: number;
  invoiceNumber: string | null;
  relationName: string | null;
  kind: OpenItemKind | null;
  currency: string;
  /** Magnitude allocated to this item. */
  allocatedMinor: number;
  /** Signed open balance left after the allocation; null when unknown. */
  remainingMinorAfter: number | null;
}

export interface MatchCandidateDto {
  rank: number;
  rule: 1 | 2 | 3 | 4;
  kind: "full" | "partial" | "overpayment" | "ledger";
  score: number;
  allocatedMinor: number;
  remainingMinor: number;
  surplusMinor: number;
  /** The engine would match this automatically if automatic matching were on. */
  autoEligible: boolean;
  blocked: MatchBlockedReason[];
  /** Cleaned plain-English lines, amount first. */
  explanation: string[];
  reasonCodes: string[];
  ledgerAccountCode: string | null;
  groupId: string | null;
  allocations: MatchAllocationDto[];
  computedAt: string;
}

export interface MatchTxDto {
  id: number;
  accountId: number | null;
  accountName: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Signed: negative is money out. */
  amountMinor: number;
  currency: string;
  type: string | null;
  reference: string | null;
  description: string | null;
  counterpartyName: string | null;
  counterpartyIbanMasked: string | null;
  matchStatus: MatchStatus;
  /** The bank account has an Exact administration mapping (matching needs it). */
  mapped: boolean;
  /**
   * The Exact administration (divisions.id) the bank account is mapped to: the only one whose open
   * items this line can be matched to. Null exactly when `mapped` is false (review M7d).
   */
  divisionId: number | null;
  stateConflict: boolean;
  ignore: { reason: MatchIgnoreReason; note: string | null; by: string; at: string } | null;
}

export interface MatchDto {
  id: number;
  transactionId: number;
  divisionId: number;
  source: MatchSource;
  status: "live" | "undone";
  ledgerAccountCode: string | null;
  score: number | null;
  rule: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  undoneBy: string | null;
  undoneAt: string | null;
  undoReason: string | null;
  exactState: string;
  /**
   * Set when the data changed after matching (over_allocated, item_closed, tx_state_conflict,
   * tx_changed): the match is never booked in Exact; a person checks it and undoes it.
   */
  reviewReason: string | null;
  /** Live and not booked in Exact yet. */
  undoAvailable: boolean;
  allocations: MatchAllocationDto[];
}

export interface MatchQueueItem {
  transaction: MatchTxDto;
  /** Best first, at most 3 (the detail route lists all). */
  candidates: MatchCandidateDto[];
}

/** GET /api/matching/queue?status=review|suggested|ignored|all&account=&q=&limit=&cursor= */
export interface MatchQueueResponse {
  items: MatchQueueItem[];
  nextCursor: string | null;
  total: number;
  autoEnabled: boolean;
}

export interface MatchAutoItem {
  match: MatchDto;
  transaction: MatchTxDto;
}

/** GET /api/matching/auto?limit=&cursor= : recent automatic matches, newest first. */
export interface MatchAutoResponse {
  items: MatchAutoItem[];
  nextCursor: string | null;
}

/** GET /api/matching/transactions/:id */
export interface MatchDetailResponse {
  transaction: MatchTxDto;
  candidates: MatchCandidateDto[];
  /** The live match, else null. */
  match: MatchDto | null;
}

/** POST /api/matching/matches: exactly one of `allocations` and `ledgerAccountCode`. */
export interface MatchCreateRequest {
  transactionId: number;
  allocations?: { openItemId: number; allocatedMinor: number }[];
  ledgerAccountCode?: string;
  note?: string;
  /**
   * Required (true) when an item belongs to another relation than the one the line's IBAN belongs
   * to; otherwise 409 different_relation.
   */
  confirmDifferentRelation?: boolean;
}

/** POST /api/matching/transactions/:id/clear-conflict (admin, step-up). */
export interface MatchClearConflictRequest {
  note: string;
}
export interface MatchCreateResponse {
  match: MatchDto;
}

/** POST /api/matching/matches/:id/undo */
export interface MatchUndoRequest {
  reason: string;
}
export interface MatchUndoResponse {
  match: MatchDto;
}

/** POST /api/matching/transactions/:id/ignore */
export interface MatchIgnoreRequest {
  reason: MatchIgnoreReason;
  note?: string;
}
export interface MatchIgnoreResponse {
  transaction: MatchTxDto;
}

export interface MatchTunablesDto {
  autoMatchMinScore: number;
  autoMatchMinGap: number;
  suggestMinScore: number;
  maxCandidates: number;
  amountToleranceMinor: number;
  blockAutoOnRecentIbanChangeDays: number;
  /** Always present in responses; optional in the web form until it has a switch for it. */
  autoIncomingUnknownIban?: boolean;
  autoLedgerPatterns: boolean;
  autoTxTypes: string[];
  noMatchTxTypes: string[];
  internalAccountTypes: string[];
}

/** GET /api/matching/config (admin) */
export interface MatchConfigResponse {
  enabled: boolean;
  autoEnabled: boolean;
  config: MatchTunablesDto;
  defaults: MatchTunablesDto;
  /** Problems with the stored config (matching refuses to run until they are fixed). */
  configErrors: string[];
  updatedAt: string | null;
  updatedBy: string | null;
  /** The text that must be typed to switch automatic matching on. */
  autoConfirmPhrase: string;
  /**
   * Revision of the matching settings (opaque; null before the first save). Send it back as `rev`
   * in the PUT to get 409 `conflict` instead of overwriting somebody else's change.
   */
  rev?: string | null;
}

/**
 * PUT /api/matching/config (admin, step-up): every field optional. `confirm` (the typed phrase) to
 * switch auto on, and again for a config change that loosens automatic matching while it is on
 * (422 `confirmation_required`). `rev`: optional optimistic-concurrency check (409 `conflict`).
 */
export interface MatchConfigRequest {
  enabled?: boolean;
  autoEnabled?: boolean;
  config?: Partial<MatchTunablesDto>;
  confirm?: string;
  rev?: string | null;
}

export interface MatchAccountMapDto {
  bankAccountId: number;
  accountName: string;
  ibanMasked: string | null;
  currency: string;
  divisionId: number | null;
  divisionName: string | null;
  journalCode: string | null;
  bankGlAccountCode: string | null;
  /** Control accounts the MatchSet names (M7c); null = booking stops with control_account_unknown. */
  receivableGlAccountCode?: string | null;
  payableGlAccountCode?: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** GET /api/matching/account-map (admin) */
export interface MatchAccountMapResponse {
  accounts: MatchAccountMapDto[];
  divisions: { id: number; name: string }[];
}

/** PUT /api/matching/account-map (admin, step-up): one account per call; `null` division removes it. */
export interface MatchAccountMapRequest {
  bankAccountId: number;
  divisionId: number | null;
  journalCode?: string;
  bankGlAccountCode?: string;
  /** Optional (M7c): ledger accounts of the debtors and creditors control accounts. */
  receivableGlAccountCode?: string | null;
  payableGlAccountCode?: string | null;
}

export interface MatchPatternDto {
  id: number;
  name: string;
  ledgerAccountCode: string;
  counterpartyNameRegex: string | null;
  referenceRegex: string | null;
  type: string | null;
  direction: "in" | "out" | null;
  maxAmountMinor: number | null;
  enabled: boolean;
  createdBy: string;
  updatedAt: string;
}

/** GET /api/matching/patterns (admin) */
export interface MatchPatternsResponse {
  patterns: MatchPatternDto[];
}

/** POST / PUT /api/matching/patterns[/:id] (admin, step-up). Regexes use the safe subset (ADR 0041). */
export interface MatchPatternRequest {
  name: string;
  ledgerAccountCode: string;
  counterpartyNameRegex?: string | null;
  referenceRegex?: string | null;
  type?: string | null;
  direction?: "in" | "out" | null;
  maxAmountMinor?: number | null;
  enabled?: boolean;
}

/**
 * GET /api/matching/items?ids=1,2 (any role; up to 20 ids): what is still FREE on open items for a
 * manual match, i.e. the open balance from Exact minus the live matches in this app (the same
 * number the server checks on POST /api/matching/matches). Unknown ids are left out.
 */
export interface MatchItemBalanceDto {
  openItemId: number;
  divisionId: number;
  kind: "invoice" | "bill";
  currency: string;
  status: string;
  /** Signed open balance from Exact (credit notes negative). */
  openMinor: number;
  /** Sum of live in-app allocations on this item (a magnitude, never negative). */
  matchedMinor: number;
  /** max(0, |openMinor| - matchedMinor): the most a new allocation may take. */
  freeMinor: number;
}

export interface MatchItemBalancesResponse {
  items: MatchItemBalanceDto[];
}

/** GET /api/matching/stats */
export interface MatchStatsResponse {
  unmatched: number;
  suggested: number;
  matched: number;
  ignored: number;
  /** Oldest unmatched or suggested completed line (UTC ISO), and its age in whole days. */
  oldestUnmatchedAt: string | null;
  oldestUnmatchedDays: number | null;
  /** Lines still open for more than 5 days (Phase 8 rule). */
  unmatchedOverFiveDays: number;
  liveAutoMatches: number;
  /** Live matches flagged because their data changed after matching (see MatchDto.reviewReason). */
  matchesNeedingReview: number;
  enabled: boolean;
  autoEnabled: boolean;
  /** Active Revolut accounts without an Exact administration mapping. */
  unmappedAccounts: number;
  /**
   * Allocations of matches booked in Exact more than 48 hours ago that still count against their
   * item because Exact has not shown the payment (Phase 8 data-quality signal; never auto-released).
   */
  staleSettlements: number;
}

// ---- Booking in Exact (Phase 7, M7c). Fixed shapes shared with the web (M7d). -----------------------
// GET /api/booking/settings ; PUT /api/booking/settings {enabled, confirm, note?} ;
// POST /api/booking/verify {note, confirm} ; GET /api/booking/outbox?status=&limit=&cursor= ;
// POST /api/booking/outbox/:id/resolve {resolution: 'booked_manually'|'retry'|'give_up', note}

export type BookingStatus =
  | "pending"
  | "sending"
  | "sent_unverified"
  | "verified"
  | "failed"
  | "outcome_unknown"
  | "manual_required"
  | "waiting_for_bank_line"
  | "resolved_manually"
  | "given_up";

export interface BookingOutboxItemDto {
  id: number;
  matchId: number;
  kind: "bank_entry" | "matchset";
  status: BookingStatus;
  attempts: number;
  lastErrorCode: string | null;
  exactRef: string | null;
  createdAt: string;
  updatedAt: string;
  transactionId: number;
  amountMinor: number;
  currency: string;
  counterpartyName: string | null;
  itemLabels: string[];
}

export interface BookingOutboxResponse {
  items: BookingOutboxItemDto[];
  nextCursor: string | null;
  total: number;
  countsByStatus: Record<BookingStatus, number>;
}

export interface BookingSettingsResponse {
  enabled: boolean;
  verified: { at: string; by: string; note: string; protocolVersion: string } | null;
  protocolVersion: string;
  protocolChanged: boolean;
  createsBankEntries: boolean | null;
  blockers: string[];
}

// ---- Booking request shapes (M7c, ADR 0044). One definition, shared with the web (M7d). ------
// GET /api/booking/settings: any role. Blockers: not_verified, protocol_changed,
// bank_entries_undecided, no_exact_connection, writes_disabled.

/** PUT /api/booking/settings (admin; enabling needs a fresh sign-in and confirm = BOOKING_ENABLE_PHRASE). */
export interface BookingSettingsRequest {
  enabled: boolean;
  confirm: string;
  note?: string;
}

/** POST /api/booking/verify (admin, step-up): confirm = BOOKING_VERIFY_PHRASE (confirm-phrases.ts). */
export interface BookingVerifyRequest {
  note: string;
  confirm: string;
}

/** POST /api/booking/outbox/:id/resolve (admin, step-up) */
export interface BookingResolveRequest {
  resolution: "booked_manually" | "retry" | "give_up";
  note: string;
}
export interface BookingResolveResponse {
  item: BookingOutboxItemDto;
}
