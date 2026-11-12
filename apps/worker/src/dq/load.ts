/**
 * Loads the inputs of the DQ rules from D1 ONLY (no Exact or Revolut call; ADR 0045). One function
 * per input section so a failing section can be reported as `not_available` for the rules that need
 * it instead of failing the whole run. Nothing here reads a full IBAN: duplicate bank lines are
 * grouped by the bank's counterparty reference or the name, and relations only report whether a
 * bank account exists.
 */
import {
  LEDGER_BALANCE_SEMANTICS,
  MAX_ISSUES_PER_RULE,
  amsterdamParts,
  nextRun,
  signedByAccount,
  type DqBankAccountIn,
  type DqBankTxIn,
  type DqBookedMatchIn,
  type DqBookingIn,
  type DqFxIn,
  type DqJobIn,
  type DqLedgerIn,
  type DqOpenItemIn,
  type DqSection,
  type DqSourceReason,
  type DqPurchaseEntryIn,
  type DqRelationIn,
  type LedgerBalance,
  type Schedule,
} from "@camelthorn/core";
import { CREDENTIALS_REJECTED } from "../exact/gate";
import { currenciesWithoutRate } from "../fx/rate-table";
import { fxStaleness } from "../fx/staleness";
import { OPEN_ITEMS_MAX_AGE_MS } from "../matching/run";
import { staleSettlements } from "../matching/settlement";
import { rejectedLast24h } from "../revolut/webhook-health";

const DAY = 86_400_000;
/** More open items than this and the item-based rules say not_available instead of guessing. */
export const MAX_OPEN_ITEMS = 20_000;
// Every list cap below is either larger than the per-rule issue cap (so a full list makes the rule
// `truncated`) or turns the section into not_available: a cut list must never look complete.
const MAX_UNMATCHED_LINES = 1_000;
export const MAX_RECENT_LINES = 5_000;
export const MAX_PURCHASE_ENTRIES = 20_000;
export const MAX_RELATIONS = 50_000;
const MAX_BOOKED_MATCHES = 1_000;
/** How far back duplicate bank lines are looked for. */
export const DUPLICATE_WINDOW_DAYS = 60;
export const EXACT_DAILY_LIMIT = 5_000;

/** A source whose last complete synchronisation is this old (or missing) cannot vouch for "ok". */
export const SOURCE_MAX_AGE_MS = OPEN_ITEMS_MAX_AGE_MS;
/** The IBAN read and the ledger are full-run only and may need several nights (ADR 0019, 0024). */
export const SLOW_SOURCE_MAX_AGE_MS = 4 * DAY;

export interface DqDivision {
  id: number;
  exactDivision: number;
  baseCurrency: string;
}

const bool = (v: unknown): boolean => v === 1 || v === true;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

/** Amsterdam calendar year of an instant (the reporting year, ADR 0024). */
const reportingYear = (nowMs: number): number => Number(amsterdamParts(nowMs).date.slice(0, 4));

export async function loadBankAccounts(db: D1Database, d: DqDivision): Promise<DqBankAccountIn[]> {
  const rows = (
    await db
      .prepare(
        `SELECT ba.id, ba.name, ba.currency, ba.balance_minor, ba.balance_at,
                ba.exact_balance_minor, ba.exact_balance_at
         FROM bank_accounts ba LEFT JOIN bank_account_exact_map m ON m.bank_account_id = ba.id
         WHERE ba.is_active = 1 AND COALESCE(m.division_id, ba.division_id) = ?1
         ORDER BY ba.id`,
      )
      .bind(d.id)
      .all<Record<string, unknown>>()
  ).results;
  return rows.map((r) => ({
    id: num(r["id"]),
    name: String(r["name"] ?? ""),
    currency: String(r["currency"]),
    balanceMinor: r["balance_minor"] === null ? null : num(r["balance_minor"]),
    balanceAt: (r["balance_at"] as string | null) ?? null,
    exactBalanceMinor: r["exact_balance_minor"] === null ? null : num(r["exact_balance_minor"]),
    exactBalanceAt: (r["exact_balance_at"] as string | null) ?? null,
  }));
}

/**
 * Final completed lines of a division: the oldest unmatched ones (for the age rule) plus the lines
 * of the duplicate look-back window. `capped` is true when the window had more lines than are
 * read; the duplicate rule then resolves nothing.
 */
export async function loadBankTransactions(
  db: D1Database,
  d: DqDivision,
  nowMs: number,
): Promise<{ lines: DqBankTxIn[]; capped: boolean }> {
  const base = `SELECT t.id, t.bank_account_id, t.amount_minor, t.currency, t.booked_at, t.match_status,
                       t.counterparty_name, COALESCE(t.counterparty_ref, lower(t.counterparty_name)) AS ckey,
                       t.reference
                FROM bank_transactions t
                  JOIN bank_accounts ba ON ba.id = t.bank_account_id
                  LEFT JOIN bank_account_exact_map m ON m.bank_account_id = ba.id
                WHERE t.is_final = 1 AND t.state = 'completed'
                  AND COALESCE(m.division_id, ba.division_id) = ?1`;
  const since = new Date(nowMs - DUPLICATE_WINDOW_DAYS * DAY).toISOString();
  const [unmatched, recent] = await db.batch<Record<string, unknown>>([
    // The oldest unmatched lines first: the rule caps its list, and the cap must keep the oldest.
    db
      .prepare(
        `${base} AND t.match_status IN ('unmatched', 'suggested') ORDER BY t.booked_at, t.id LIMIT ${MAX_UNMATCHED_LINES}`,
      )
      .bind(d.id),
    db
      .prepare(
        `${base} AND t.booked_at >= ?2 ORDER BY t.booked_at DESC, t.id DESC LIMIT ${MAX_RECENT_LINES + 1}`,
      )
      .bind(d.id, since),
  ]);
  const recentRows = recent?.results ?? [];
  const capped = recentRows.length > MAX_RECENT_LINES;
  const byId = new Map<number, DqBankTxIn>();
  for (const r of [...(unmatched?.results ?? []), ...recentRows.slice(0, MAX_RECENT_LINES)]) {
    const id = num(r["id"]);
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      accountId: num(r["bank_account_id"]),
      amountMinor: num(r["amount_minor"]),
      currency: String(r["currency"]),
      bookedAt: String(r["booked_at"]),
      matchStatus: r["match_status"] as DqBankTxIn["matchStatus"],
      counterpartyName: (r["counterparty_name"] as string | null) ?? null,
      counterpartyKey: (r["ckey"] as string | null) ?? null,
      reference: (r["reference"] as string | null) ?? null,
    });
  }
  return { lines: [...byId.values()].sort((a, b) => a.id - b.id), capped };
}

export async function loadBookedMatches(db: D1Database, d: DqDivision): Promise<DqBookedMatchIn[]> {
  const rows = (
    await db
      .prepare(
        `SELECT m.id, m.bank_transaction_id, m.amount_minor, m.currency, t.state, t.state_conflict, m.booked_at
         FROM matches m JOIN bank_transactions t ON t.id = m.bank_transaction_id
         WHERE m.division_id = ?1 AND m.undone_at IS NULL AND m.exact_state = 'matched_in_exact'
           AND (t.state_conflict = 1 OR t.state = 'reverted')
         ORDER BY m.id LIMIT ${MAX_BOOKED_MATCHES}`,
      )
      .bind(d.id)
      .all<Record<string, unknown>>()
  ).results;
  return rows.map((r) => ({
    matchId: num(r["id"]),
    txId: num(r["bank_transaction_id"]),
    amountMinor: num(r["amount_minor"]),
    currency: String(r["currency"]),
    lineState: String(r["state"]),
    stateConflict: bool(r["state_conflict"]),
    bookedAt: (r["booked_at"] as string | null) ?? null,
  }));
}

export async function loadBookingHealth(
  db: D1Database,
  d: DqDivision,
  nowMs: number,
): Promise<DqBookingIn> {
  const [outbox, already] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT o.status AS status, COUNT(*) AS n FROM exact_write_outbox o
           JOIN matches m ON m.id = o.match_id
         WHERE m.undone_at IS NULL AND o.division_id = ?1
           AND o.status IN ('manual_required', 'outcome_unknown')
         GROUP BY o.status`,
      )
      .bind(d.id),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM matches
         WHERE division_id = ?1 AND undone_at IS NULL AND exact_note = 'already_matched_in_exact'`,
      )
      .bind(d.id),
  ]);
  const byStatus = new Map((outbox?.results ?? []).map((r) => [String(r["status"]), num(r["n"])]));
  return {
    outcomeUnknown: byStatus.get("outcome_unknown") ?? 0,
    manualRequired: byStatus.get("manual_required") ?? 0,
    alreadyMatchedInExact: num(already?.results?.[0]?.["n"]),
    staleSettlements: await staleSettlements(db, new Date(nowMs).toISOString(), d.id),
  };
}

/** Open items of a division, or null when there are more than the rules can judge in one run. */
export async function loadOpenItems(db: D1Database, d: DqDivision): Promise<DqOpenItemIn[] | null> {
  const rows = (
    await db
      .prepare(
        `SELECT id, kind, relation_id, relation_name, invoice_number, currency, original_minor, open_minor,
                rate, open_dc_minor, invoice_date
         FROM open_items WHERE division_id = ?1 AND status = 'open' ORDER BY id LIMIT ${MAX_OPEN_ITEMS + 1}`,
      )
      .bind(d.id)
      .all<Record<string, unknown>>()
  ).results;
  if (rows.length > MAX_OPEN_ITEMS) return null;
  return rows.map((r) => ({
    id: num(r["id"]),
    kind: r["kind"] as "invoice" | "bill",
    relationId: (r["relation_id"] as string | null) ?? null,
    relationName: (r["relation_name"] as string | null) ?? null,
    invoiceNumber: (r["invoice_number"] as string | null) ?? null,
    currency: String(r["currency"]),
    originalMinor: r["original_minor"] === null ? null : num(r["original_minor"]),
    openMinor: num(r["open_minor"]),
    rate: (r["rate"] as string | null) ?? null,
    openDcMinor: r["open_dc_minor"] === null ? null : num(r["open_dc_minor"]),
    invoiceDate: (r["invoice_date"] as string | null) ?? null,
  }));
}

export async function loadPurchaseEntries(
  db: D1Database,
  d: DqDivision,
  nowMs: number,
): Promise<DqPurchaseEntryIn[] | null> {
  const since = new Date(nowMs - 400 * DAY).toISOString().slice(0, 10);
  const rows = (
    await db
      .prepare(
        `SELECT id, entry_number, relation_name, status, submitted_at, modified_at, entry_date, has_pdf,
                amount_minor, currency
         FROM purchase_entries
         WHERE division_id = ?1 AND (status = 'pending_approval' OR entry_date >= ?2)
         ORDER BY id LIMIT ${MAX_PURCHASE_ENTRIES + 1}`,
      )
      .bind(d.id, since)
      .all<Record<string, unknown>>()
  ).results;
  // More than can be judged in one run: not_available, never a silently cut list (whose missing
  // tail would be auto-resolved).
  if (rows.length > MAX_PURCHASE_ENTRIES) return null;
  return rows.map((r) => ({
    id: num(r["id"]),
    entryNumber: (r["entry_number"] as string | null) ?? null,
    supplierName: (r["relation_name"] as string | null) ?? null,
    status: r["status"] as DqPurchaseEntryIn["status"],
    submittedAt: (r["submitted_at"] as string | null) ?? null,
    modifiedAt: (r["modified_at"] as string | null) ?? null,
    entryDate: (r["entry_date"] as string | null) ?? null,
    hasPdf: r["has_pdf"] === null ? null : bool(r["has_pdf"]),
    amountMinor: num(r["amount_minor"]),
    currency: String(r["currency"]),
  }));
}

export async function loadRelations(db: D1Database, d: DqDivision): Promise<DqRelationIn[] | null> {
  const rows = (
    await db
      .prepare(
        `SELECT r.id, r.name, r.is_supplier, r.is_customer, r.email, r.vat_number, r.country,
                EXISTS (SELECT 1 FROM relation_bank_accounts b
                        WHERE b.relation_id = r.id AND b.removed_at IS NULL) AS has_bank,
                r.iban_changed_at, r.iban_added_at,
                (SELECT COUNT(*) FROM open_items o WHERE o.division_id = r.division_id
                   AND o.relation_id = r.exact_id AND o.kind = 'invoice' AND o.status = 'open') AS open_invoices,
                (SELECT COUNT(*) FROM open_items o WHERE o.division_id = r.division_id
                   AND o.relation_id = r.exact_id AND o.kind = 'bill' AND o.status = 'open') AS open_bills
         FROM relations r WHERE r.division_id = ?1 ORDER BY r.id LIMIT ${MAX_RELATIONS + 1}`,
      )
      .bind(d.id)
      .all<Record<string, unknown>>()
  ).results;
  if (rows.length > MAX_RELATIONS) return null;
  return rows.map((r) => ({
    id: num(r["id"]),
    name: String(r["name"] ?? ""),
    isSupplier: bool(r["is_supplier"]),
    isCustomer: bool(r["is_customer"]),
    email: (r["email"] as string | null) ?? null,
    vatNumber: (r["vat_number"] as string | null) ?? null,
    country: (r["country"] as string | null) ?? null,
    hasIban: bool(r["has_bank"]),
    ibanChangedAt: (r["iban_changed_at"] as string | null) ?? null,
    ibanAddedAt: (r["iban_added_at"] as string | null) ?? null,
    openInvoices: num(r["open_invoices"]),
    openBills: num(r["open_bills"]),
  }));
}

export async function loadFx(db: D1Database, d: DqDivision | null, nowMs: number): Promise<DqFxIn> {
  const newest = (
    await db.prepare("SELECT MAX(rate_date) AS d FROM fx_rates").first<{ d: string | null }>()
  )?.d;
  const st = fxStaleness(newest ?? null, nowMs);
  const conflicts = (
    await db
      .prepare(
        `SELECT id, currency, rate_date FROM fx_rate_conflicts WHERE resolved_at IS NULL ORDER BY id LIMIT ${MAX_ISSUES_PER_RULE + 1}`,
      )
      .all<{ id: number; currency: string; rate_date: string }>()
  ).results;
  let without: { currency: string; items: number }[] = [];
  if (d !== null) {
    const per = (
      await db
        .prepare(
          `SELECT currency, COUNT(*) AS n FROM open_items
           WHERE division_id = ?1 AND status = 'open' AND currency <> ?2 GROUP BY currency`,
        )
        .bind(d.id, d.baseCurrency)
        .all<{ currency: string; n: number }>()
    ).results;
    const missing = new Set(
      await currenciesWithoutRate(
        db,
        per.map((p) => p.currency),
        amsterdamParts(nowMs).date,
      ),
    );
    without = per
      .filter((p) => missing.has(p.currency))
      .map((p) => ({ currency: p.currency, items: p.n }));
  }
  return {
    newestRateDate: newest ?? null,
    stale: st.stale,
    staleReason: st.staleReason,
    workingDaysOld: st.workingDaysOld,
    currenciesWithoutRate: without,
    unresolvedConflicts: conflicts.map((c) => ({
      id: c.id,
      currency: c.currency,
      rateDate: c.rate_date,
    })),
  };
}

/**
 * Suspense balances for the configured account codes. Null when the ledger of this division has
 * never been read (the rules then say not_available instead of reading zero balances).
 */
export async function loadLedger(
  db: D1Database,
  d: DqDivision,
  nowMs: number,
  suspenseCodes: readonly string[],
): Promise<DqLedgerIn | null> {
  const year = reportingYear(nowMs);
  const read = await db
    .prepare(
      "SELECT 1 AS x FROM gl_sync_years WHERE division_id = ?1 AND entity = 'gl_balances' AND year = ?2",
    )
    .bind(d.id, year)
    .first();
  if (!read) return null;
  const accounts =
    suspenseCodes.length === 0
      ? []
      : (
          await db
            .prepare(
              `SELECT exact_id, trim(code) AS code, name FROM gl_accounts
               WHERE division_id = ?1 AND is_active = 1
                 AND trim(code) IN (${suspenseCodes.map((_, i) => `?${i + 2}`).join(",")})`,
            )
            .bind(d.id, ...suspenseCodes)
            .all<{ exact_id: string; code: string; name: string }>()
        ).results;
  let balances: LedgerBalance[] = [];
  if (accounts.length > 0) {
    const rows = (
      await db
        .prepare(
          `SELECT gl_account_exact_id, year, period, amount_minor, balance_type FROM gl_balances
           WHERE division_id = ?1 AND year = ?2 AND gl_account_exact_id IN (${accounts
             .map((_, i) => `?${i + 3}`)
             .join(",")})`,
        )
        .bind(d.id, year, ...accounts.map((a) => a.exact_id))
        .all<{
          gl_account_exact_id: string;
          year: number;
          period: number;
          amount_minor: number;
          balance_type: "B" | "W" | null;
        }>()
    ).results;
    balances = rows.map((r) => ({
      glAccountExactId: r.gl_account_exact_id,
      year: r.year,
      period: r.period,
      amountMinor: r.amount_minor,
      balanceType: r.balance_type,
    }));
  }
  const sums = signedByAccount(balances, year, { from: 0, to: 99 }, LEDGER_BALANCE_SEMANTICS);
  return {
    suspense: accounts.map((a) => ({
      code: a.code,
      name: a.name,
      balanceMinor: Number(sums.get(a.exact_id) ?? 0n),
      currency: d.baseCurrency,
    })),
    closedPeriodBookings: null,
  };
}

type Sources = Partial<Record<DqSection, DqSourceReason>>;

function judgeAge(
  at: string | null | undefined,
  maxMs: number,
  nowMs: number,
): DqSourceReason | null {
  if (at === null || at === undefined) return "source_never_synced";
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "source_never_synced";
  return nowMs - t < maxMs ? null : "source_stale";
}

/** Never beats stale: a source that never completed is reported as such. */
function worst(...r: (DqSourceReason | null)[]): DqSourceReason | null {
  if (r.includes("source_never_synced")) return "source_never_synced";
  return r.includes("source_stale") ? "source_stale" : null;
}

/**
 * Which input sections cannot vouch for "ok" because their source was never synchronised or its last
 * COMPLETE synchronisation is too old (review V1 S5; the same signal as the Phase 7 matching gate,
 * sync_state.last_completed_at younger than 26 hours). Exact data per division, Revolut data per
 * active Revolut connection (revolut_sync_state.last_completed_at). Reads D1 only.
 */
export async function loadSourceFreshness(
  db: D1Database,
  d: DqDivision,
  nowMs: number,
): Promise<Sources> {
  const exact = new Map(
    (
      await db
        .prepare(
          `SELECT entity, last_completed_at FROM sync_state
           WHERE division_id = ?1 AND entity IN ('receivables', 'payables', 'relations',
                                                 'relation_ibans', 'purchase_entries', 'gl_balances')`,
        )
        .bind(d.id)
        .all<{ entity: string; last_completed_at: string | null }>()
    ).results.map((r) => [r.entity, r.last_completed_at] as const),
  );
  const fast = (e: string): DqSourceReason | null =>
    judgeAge(exact.get(e), SOURCE_MAX_AGE_MS, nowMs);
  const out: Sources = {};
  const set = (k: DqSection, r: DqSourceReason | null): void => {
    if (r !== null) out[k] = r;
  };
  set("openItems", worst(fast("receivables"), fast("payables")));
  set("purchaseEntries", fast("purchase_entries"));
  set(
    "relations",
    worst(fast("relations"), judgeAge(exact.get("relation_ibans"), SLOW_SOURCE_MAX_AGE_MS, nowMs)),
  );
  set("ledger", judgeAge(exact.get("gl_balances"), SLOW_SOURCE_MAX_AGE_MS, nowMs));

  // Revolut: every active connection must have a fresh complete read. No connection, no judgement
  // (there are then no Revolut accounts or lines to be wrong about).
  const rv = (
    await db
      .prepare(
        `SELECT c.id,
                (SELECT last_completed_at FROM revolut_sync_state WHERE connection_id = c.id AND entity = 'accounts') AS accounts_at,
                (SELECT last_completed_at FROM revolut_sync_state WHERE connection_id = c.id AND entity = 'transactions') AS tx_at
         FROM connections c WHERE c.kind = 'revolut' AND c.status = 'active'`,
      )
      .all<{ id: number; accounts_at: string | null; tx_at: string | null }>()
  ).results;
  if (rv.length > 0) {
    set("bankAccounts", worst(...rv.map((r) => judgeAge(r.accounts_at, SOURCE_MAX_AGE_MS, nowMs))));
    set("bankTransactions", worst(...rv.map((r) => judgeAge(r.tx_at, SOURCE_MAX_AGE_MS, nowMs))));
  }
  return out;
}

/** Length of one interval of a schedule in ms, or null when it has no two consecutive runs. */
export function scheduleIntervalMs(schedule: Schedule, nowMs: number): number | null {
  const a = nextRun(schedule, nowMs);
  if (a === null) return null;
  const b = nextRun(schedule, a);
  return b === null ? null : b - a;
}

/** What the handler registry says about a job's handler (passed in, so this file does not import it). */
export type DescribeHandler = (handler: string) => { title: string | null; implemented: boolean };

export async function loadJobs(
  db: D1Database,
  nowMs: number,
  describe: DescribeHandler,
): Promise<DqJobIn[]> {
  const rows = (
    await db
      .prepare(
        `SELECT j.name, j.handler, j.enabled, j.schedule_json, j.created_at, j.last_scheduled_at, j.last_status,
                (SELECT MAX(r.finished_at) FROM job_runs r WHERE r.job_id = j.id AND r.status = 'ok') AS last_ok,
                (SELECT MIN(r.queued_at) FROM job_runs r WHERE r.job_id = j.id) AS first_run,
                (SELECT r.error_code FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_code
         FROM jobs j ORDER BY j.name`,
      )
      .all<Record<string, unknown>>()
  ).results;
  const out: DqJobIn[] = [];
  for (const r of rows) {
    let interval: number | null = null;
    let schedule: Schedule | null = null;
    try {
      schedule = JSON.parse(String(r["schedule_json"])) as Schedule;
      interval = scheduleIntervalMs(schedule, nowMs);
    } catch {
      interval = null;
      schedule = null;
    }
    const handler = String(r["handler"]);
    const code = (r["last_code"] as string | null) ?? null;
    out.push({
      name: String(r["name"]),
      title: describe(handler).title ?? String(r["name"]),
      enabled: bool(r["enabled"]),
      implemented: describe(handler).implemented,
      schedule,
      intervalMs: interval,
      lastSuccessAt: (r["last_ok"] as string | null) ?? null,
      referenceAt:
        ((r["first_run"] ?? r["last_scheduled_at"] ?? r["created_at"]) as string | null) ?? null,
      lastStatus: (r["last_status"] as string | null) ?? null,
      lastCode: code !== null && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null,
    });
  }
  return out;
}

/** Revolut webhook health, or null when there is no Revolut connection to judge. */
export async function loadWebhook(
  db: D1Database,
  nowMs: number,
): Promise<{ rejected24h: number; errored24h: number } | null> {
  const conn = await db
    .prepare(
      "SELECT id, connected_at FROM connections WHERE kind = 'revolut' AND status = 'active' ORDER BY id LIMIT 1",
    )
    .first<{ id: number; connected_at: string | null }>();
  if (!conn) return null;
  const rejected = await rejectedLast24h(db, conn.id, nowMs, conn.connected_at);
  const since = new Date(nowMs - DAY).toISOString();
  const errored = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM webhook_events WHERE connection_id = ?1 AND status = 'error' AND received_at >= ?2",
    )
    .bind(conn.id, since)
    .first<{ n: number }>();
  return { rejected24h: rejected, errored24h: errored?.n ?? 0 };
}

export async function loadExactConnection(db: D1Database): Promise<{
  status: string;
  lastError: string | null;
  refreshExpiresAt: string | null;
} | null> {
  const c = await db
    .prepare(
      "SELECT status, last_error, refresh_expires_at FROM connections WHERE kind = 'exact' ORDER BY id LIMIT 1",
    )
    .first<{ status: string; last_error: string | null; refresh_expires_at: string | null }>();
  if (!c) return null;
  return {
    status: c.status,
    // Our own fixed code only; the stored text is never passed on.
    lastError: c.last_error === CREDENTIALS_REJECTED ? "credentials_rejected" : null,
    refreshExpiresAt: c.refresh_expires_at,
  };
}

export async function loadExactBudget(
  db: D1Database,
  d: DqDivision,
  nowMs: number,
): Promise<{ dailyLimit: number; calls: number; remaining: number | null }> {
  const row = await db
    .prepare("SELECT calls, remaining FROM exact_usage WHERE division = ?1 AND day = ?2")
    // ExactGate keys exact_usage by the UTC day (gate.ts dayOf), not the Amsterdam date: between
    // midnight Amsterdam and midnight UTC the Amsterdam date finds no row and would read 0 calls.
    .bind(d.exactDivision, new Date(nowMs).toISOString().slice(0, 10))
    .first<{ calls: number; remaining: number | null }>();
  return {
    dailyLimit: EXACT_DAILY_LIMIT,
    calls: row?.calls ?? 0,
    remaining: row?.remaining ?? null,
  };
}
