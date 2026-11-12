/**
 * The ONE place the payment DQ rules (ADR 0053) read their input from: D1 only, no Exact or Revolut
 * call. Phase 9 final review fix F9b.
 *
 * ALERT SCHEMA (read at run time, never assumed; review F9b):
 *   payment_reconcile      subject_kind ('payment'|'batch'), subject_id, last_result, alert_at (0029)
 *                          and, from migration 0030 (F9a), alert_kind, alert_ack_at.
 *   - With the 0030 columns ("acknowledged" schema) an alert is OPEN while `alert_at IS NOT NULL AND
 *     alert_ack_at IS NULL`, and its kind is `alert_kind` (the reconciliation keeps it stable; an
 *     acknowledged alert leaves the rule and its issue resolves on the next run).
 *   - Without them ("legacy" schema, migration 0029 only) an alert is open while `alert_at IS NOT
 *     NULL` and `last_result` is one of the four alert results.
 *   - Any other shape (a base column missing, or only one of the two 0030 columns) is refused: the
 *     loader throws `PaymentsSchemaError`, so all payment rules are `not_available` and the run is
 *     partial. A missing column is never read as "no alerts".
 *   payments / payment_batches   status, mode, batch_id (payments only), currency, expires_at,
 *                          created_at, updated_at, amount_minor (payments) / total_minor (batches)
 *   payment_events         payment_id | batch_id, to_status, at   (when a request entered a state)
 *   payment_bank_links, matches (exact_state, undone_at), match_allocations (open_item_id)
 *   settings               payments.enabled ("true" = on), payments.draft_expiry_days
 *
 * Only top-level requests are subjects: a payment that belongs to a batch is judged through its
 * batch (the same rule the reconciliation uses), so one batch is one alert, never 50.
 *
 * Reads are bounded: every list is cut at MAX_ISSUES_PER_RULE + 1 rows, oldest first, and a cut is
 * reported (`capped`) so the rule resolves nothing from a list it only partly saw. The paid-not-booked
 * look-back is PAID_LOOKBACK_DAYS; older never-booked payments drop out of the check (documented).
 */
import {
  MAX_ISSUES_PER_RULE,
  PAYMENT_ALERT_RESULTS,
  PAYMENTS_ENABLED_KEY,
  type DqPaymentAlertIn,
  type DqPaymentSubjectIn,
  type DqPaymentsIn,
  type DqPaymentUnbookedIn,
} from "@camelthorn/core";
import {
  DEFAULT_DRAFT_EXPIRY_DAYS,
  DRAFT_EXPIRY_KEY,
  MAX_DRAFT_EXPIRY_DAYS,
} from "../payments/reconcile";

const DAY = 86_400_000;

/** The columns every alert read needs (migration 0029). */
export const RECONCILE_BASE_COLUMNS = [
  "subject_kind",
  "subject_id",
  "last_result",
  "alert_at",
] as const;
/** The acknowledgement columns of migration 0030 (F9a): all of them, or none. */
export const RECONCILE_ACK_COLUMNS = ["alert_kind", "alert_ack_at"] as const;
export type AlertSchema = "legacy" | "acknowledged";

/** The payment tables do not have the shape this loader knows: fail closed (never "no alerts"). */
export class PaymentsSchemaError extends Error {
  override name = "PaymentsSchemaError";
}

export const RECONCILE_COLUMNS_SQL = "SELECT name FROM pragma_table_info('payment_reconcile')";

/** Which alert schema the database has; throws PaymentsSchemaError for any other shape. */
export async function alertSchema(db: D1Database): Promise<AlertSchema> {
  const rows = await db.prepare(RECONCILE_COLUMNS_SQL).all<{ name: string }>();
  const cols = new Set(rows.results.map((r) => r.name));
  const missing = RECONCILE_BASE_COLUMNS.filter((c) => !cols.has(c));
  if (missing.length > 0) {
    throw new PaymentsSchemaError(`payment_reconcile lacks ${missing.join(", ")}`);
  }
  const ack = RECONCILE_ACK_COLUMNS.filter((c) => cols.has(c));
  if (ack.length === 0) return "legacy";
  if (ack.length === RECONCILE_ACK_COLUMNS.length) return "acknowledged";
  throw new PaymentsSchemaError(`payment_reconcile has only ${ack.join(", ")} of the 0030 columns`);
}

/** The setting, default and bound of the reconciliation job itself (one source, no drift). */
const DRAFT_EXPIRY_SETTING = DRAFT_EXPIRY_KEY;
/** Paid payments older than this are no longer checked for booking. */
export const PAID_LOOKBACK_DAYS = 180;
const IN_FLIGHT = "('pending_approval', 'ready', 'submitting', 'submitted', 'outcome_unknown')";
const READ = MAX_ISSUES_PER_RULE + 1;

const ALERT_LIST = PAYMENT_ALERT_RESULTS.map((r) => `'${r}'`).join(", ");
/** When an alert is open, per schema (see the header). */
export const alertOpenSql = (schema: AlertSchema): string =>
  schema === "acknowledged"
    ? "r.alert_at IS NOT NULL AND r.alert_ack_at IS NULL"
    : `r.alert_at IS NOT NULL AND r.last_result IN (${ALERT_LIST})`;

const since = (alias: string, idCol: string, status: string): string =>
  `COALESCE((SELECT MAX(e.at) FROM payment_events e WHERE e.${idCol} = ${alias}.id AND e.to_status = '${status}'),
            ${alias}.updated_at, ${alias}.created_at)`;

/** Top-level requests (payments outside batches, and batches) in one status, oldest state first. */
const subjectsSql = (status: string, extra = ""): string =>
  `SELECT kind, id, amount_minor, currency, expires_at, since FROM (
     SELECT 'payment' AS kind, p.id AS id, p.amount_minor AS amount_minor, p.currency AS currency,
            p.expires_at AS expires_at, ${since("p", "payment_id", status)} AS since
       FROM payments p WHERE p.status = '${status}' AND p.batch_id IS NULL ${extra && `AND p.${extra}`}
     UNION ALL
     SELECT 'batch', b.id, b.total_minor, b.currency, b.expires_at, ${since("b", "batch_id", status)}
       FROM payment_batches b WHERE b.status = '${status}' ${extra && `AND b.${extra}`}
   ) ORDER BY since ASC, kind ASC, id ASC LIMIT ${READ}`;

export const OUTCOME_UNKNOWN_SQL = subjectsSql("outcome_unknown");
export const READY_SQL = subjectsSql("ready");
export const DRAFTS_WAITING_SQL = subjectsSql("submitted", "mode = 'drafts'");

/** The open alerts, oldest first. The kind is `alert_kind` (0030) or the alert result (0029). */
export const alertsSql = (
  schema: AlertSchema,
): string => `SELECT r.subject_kind AS kind, r.subject_id AS id,
    ${schema === "acknowledged" ? "COALESCE(r.alert_kind, '')" : "r.last_result"} AS result,
    r.alert_at AS alert_at,
    CASE r.subject_kind WHEN 'payment' THEN (SELECT p.amount_minor FROM payments p WHERE p.id = r.subject_id)
                        ELSE (SELECT b.total_minor FROM payment_batches b WHERE b.id = r.subject_id) END AS amount_minor,
    CASE r.subject_kind WHEN 'payment' THEN (SELECT p.currency FROM payments p WHERE p.id = r.subject_id)
                        ELSE (SELECT b.currency FROM payment_batches b WHERE b.id = r.subject_id) END AS currency
  FROM payment_reconcile r
  WHERE ${alertOpenSql(schema)}
  ORDER BY r.alert_at ASC, r.subject_kind ASC, r.subject_id ASC LIMIT ${READ}`;

/**
 * Paid at the bank (status paid) and the Exact side not booked: no bank line linked, or the line has
 * no live match, or its live match is for another invoice, or the match is not `matched_in_exact` for
 * OUR invoice (the same stages as `paymentSettlement`). Oldest first; the status +
 * created_at index bounds the scan to the look-back.
 */
export const PAID_NOT_BOOKED_SQL = `SELECT p.id, p.amount_minor, p.currency,
    ${since("p", "payment_id", "paid")} AS paid_at,
    CASE WHEN l.bank_transaction_id IS NULL THEN 'awaiting_bank_line'
         WHEN NOT EXISTS (SELECT 1 FROM matches m
                           WHERE m.bank_transaction_id = l.bank_transaction_id AND m.undone_at IS NULL)
           THEN 'awaiting_match'
         WHEN NOT EXISTS (SELECT 1 FROM matches m JOIN match_allocations a ON a.match_id = m.id
                           WHERE m.bank_transaction_id = l.bank_transaction_id AND m.undone_at IS NULL
                             AND a.open_item_id = p.open_item_id)
           THEN 'match_other_invoice'
         ELSE 'awaiting_booking' END AS stage
  FROM payments p LEFT JOIN payment_bank_links l ON l.payment_id = p.id
  WHERE p.status = 'paid' AND p.created_at >= ?1
    AND NOT EXISTS (SELECT 1 FROM matches m JOIN match_allocations a ON a.match_id = m.id
                     WHERE m.bank_transaction_id = l.bank_transaction_id AND m.undone_at IS NULL
                       AND m.exact_state = 'matched_in_exact' AND a.open_item_id = p.open_item_id)
  ORDER BY p.created_at ASC, p.id ASC LIMIT ${READ}`;

export const IN_FLIGHT_SQL = `SELECT
    (SELECT COUNT(*) FROM payments INDEXED BY idx_payments_status WHERE status IN ${IN_FLIGHT} AND batch_id IS NULL)
  + (SELECT COUNT(*) FROM payment_batches WHERE status IN ${IN_FLIGHT}) AS n`;

export const SETTINGS_SQL = "SELECT key, value_json FROM settings WHERE key IN (?1, ?2)";

type Row = Record<string, unknown>;
const int = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isSafeInteger(n) ? n : 0;
};
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const kindOf = (v: unknown): "payment" | "batch" => (v === "batch" ? "batch" : "payment");

function subjects(rows: readonly Row[]): { list: DqPaymentSubjectIn[]; capped: boolean } {
  return {
    capped: rows.length > MAX_ISSUES_PER_RULE,
    list: rows.slice(0, MAX_ISSUES_PER_RULE).map((r) => ({
      kind: kindOf(r["kind"]),
      id: int(r["id"]),
      amountMinor: int(r["amount_minor"]),
      currency: String(r["currency"] ?? ""),
      since: text(r["since"]),
      expiresAt: text(r["expires_at"]),
    })),
  };
}

/** Throws when D1 fails: the caller turns that into `payments_not_loaded` (never a guess). */
export async function loadPayments(db: D1Database, nowMs: number): Promise<DqPaymentsIn> {
  const lookback = new Date(nowMs - PAID_LOOKBACK_DAYS * DAY).toISOString();
  const schema = await alertSchema(db);
  const [unknown, alerts, unbooked, ready, drafts, inflight, settings] = await db.batch<Row>([
    db.prepare(OUTCOME_UNKNOWN_SQL),
    db.prepare(alertsSql(schema)),
    db.prepare(PAID_NOT_BOOKED_SQL).bind(lookback),
    db.prepare(READY_SQL),
    db.prepare(DRAFTS_WAITING_SQL),
    db.prepare(IN_FLIGHT_SQL),
    db.prepare(SETTINGS_SQL).bind(PAYMENTS_ENABLED_KEY, DRAFT_EXPIRY_SETTING),
  ]);
  const rows = (r: { results: Row[] } | undefined): Row[] => r?.results ?? [];
  const u = subjects(rows(unknown));
  const rd = subjects(rows(ready));
  const dw = subjects(rows(drafts));
  const alertRows = rows(alerts);
  const alertList: DqPaymentAlertIn[] = alertRows.slice(0, MAX_ISSUES_PER_RULE).map((r) => ({
    kind: kindOf(r["kind"]),
    id: int(r["id"]),
    result: String(r["result"] ?? ""),
    alertAt: text(r["alert_at"]),
    amountMinor:
      r["amount_minor"] === null || r["amount_minor"] === undefined ? null : int(r["amount_minor"]),
    currency: text(r["currency"]),
  }));
  const unbookedRows = rows(unbooked);
  const unbookedList: DqPaymentUnbookedIn[] = unbookedRows
    .slice(0, MAX_ISSUES_PER_RULE)
    .map((r) => ({
      id: int(r["id"]),
      amountMinor: int(r["amount_minor"]),
      currency: String(r["currency"] ?? ""),
      paidAt: text(r["paid_at"]),
      stage:
        r["stage"] === "awaiting_match" ||
        r["stage"] === "match_other_invoice" ||
        r["stage"] === "awaiting_booking"
          ? r["stage"]
          : "awaiting_bank_line",
    }));
  const byKey = new Map(rows(settings).map((r) => [String(r["key"]), String(r["value_json"])]));
  const days = Number(byKey.get(DRAFT_EXPIRY_SETTING));
  return {
    outcomeUnknown: u.list,
    alerts: alertList,
    paidNotBooked: unbookedList,
    ready: rd.list,
    draftsWaiting: dw.list,
    draftExpiryDays:
      Number.isInteger(days) && days >= 1 && days <= MAX_DRAFT_EXPIRY_DAYS
        ? days
        : DEFAULT_DRAFT_EXPIRY_DAYS,
    switchOn: byKey.get(PAYMENTS_ENABLED_KEY) === "true",
    inFlight: int(rows(inflight)[0]?.["n"]),
    capped: {
      outcomeUnknown: u.capped,
      alerts: alertRows.length > MAX_ISSUES_PER_RULE,
      paidNotBooked: unbookedRows.length > MAX_ISSUES_PER_RULE,
      ready: rd.capped,
      draftsWaiting: dw.capped,
    },
  };
}
