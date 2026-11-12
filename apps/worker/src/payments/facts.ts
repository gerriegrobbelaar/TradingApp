/**
 * Gathers the facts for the pure pre-check (packages/core payments/precheck.ts). Read-only. Doubt
 * becomes a block code in the core, never an assumption here: a missing purchase entry, an
 * unverified status mapping or an entry that was not read recently are all "not approved".
 */
import {
  amsterdamParts,
  findPurchaseEntryForPayable,
  previousTargetWorkingDay,
  ibanFingerprint,
  isInvoiceApprovedForPayment,
  PAYMENT_OPEN_STATUSES,
  precheckPayment,
  purchaseEntryJoinKey,
  type ApprovalStatus,
  type InvoiceApproval,
  type PaymentSettings,
  type PrecheckInput,
  type PrecheckResult,
} from "@camelthorn/core";
import { readMappingCheck } from "../read/approvals-routes";
import { loadRateTableWithNewest } from "../fx/rate-table";
import { openItemsFreshness } from "../matching/run";
import {
  readInvoiceIban,
  readSourceAccount,
  readSupplier,
  type SourceAccountRow,
  type SupplierRow,
} from "./iban-store";
import { paymentsPermitted, type PaymentsState } from "./settings";

const OPEN_LIST = PAYMENT_OPEN_STATUSES.map((s) => `'${s}'`).join(", ");

export interface ItemRow {
  id: number;
  divisionId: number;
  kind: "invoice" | "bill";
  relationExactId: string | null;
  invoiceNumber: string | null;
  currency: string;
  openMinor: number;
  closed: boolean;
  syncedAt: string;
  entryNumber: number | null;
  dueDate: string | null;
}

export async function readItem(db: D1Database, id: number): Promise<ItemRow | null> {
  const r = await db
    .prepare(
      `SELECT id, division_id, kind, relation_id, invoice_number, currency, open_minor, status, closed_at,
              synced_at, entry_number, due_date
         FROM open_items WHERE id = ?1`,
    )
    .bind(id)
    .first<{
      id: number;
      division_id: number;
      kind: "invoice" | "bill";
      relation_id: string | null;
      invoice_number: string | null;
      currency: string;
      open_minor: number;
      status: string;
      closed_at: string | null;
      synced_at: string;
      entry_number: number | null;
      due_date: string | null;
    }>();
  if (r === null) return null;
  return {
    id: r.id,
    divisionId: r.division_id,
    kind: r.kind,
    relationExactId: r.relation_id,
    invoiceNumber: r.invoice_number,
    currency: r.currency,
    openMinor: r.open_minor,
    closed: r.status !== "open" || r.closed_at !== null,
    syncedAt: r.synced_at,
    entryNumber: r.entry_number,
    dueDate: r.due_date,
  };
}

/** "approved" only when the cached Exact entry proves it under a verified mapping. */
async function invoiceApproval(
  db: D1Database,
  item: ItemRow,
  nowMs: number,
): Promise<InvoiceApproval> {
  const mapping = await readMappingCheck(db);
  if (!mapping.verified) return "mapping_unverified";
  const key = purchaseEntryJoinKey(item.entryNumber);
  if (key === null) return "unknown";
  const rows = await db
    .prepare(
      `SELECT division_id, entry_number, status, status_code, synced_at, missed_cycles
         FROM purchase_entries WHERE division_id = ?1 AND (entry_number = ?2 OR ltrim(entry_number, '0') = ?2)`,
    )
    .bind(item.divisionId, key)
    .all<{
      division_id: number;
      entry_number: string | null;
      status: ApprovalStatus;
      status_code: number | null;
      synced_at: string;
      missed_cycles: number;
    }>();
  const entry = findPurchaseEntryForPayable(
    { divisionId: item.divisionId, entryNumber: item.entryNumber },
    rows.results.map((r) => ({ ...r, divisionId: r.division_id, entryNumber: r.entry_number })),
  );
  if (entry === null) return "unknown";
  const ok = isInvoiceApprovedForPayment(
    {
      status: entry.status,
      statusCode: entry.status_code,
      lastSeenAt: entry.synced_at,
      missedCycles: entry.missed_cycles,
    },
    { nowMs, mapping },
  );
  if (ok) return "approved";
  // Marked approved but not provable now (old read, missed cycle): doubt, not a "no".
  return entry.status === "approved" ? "unknown" : "not_approved";
}

export interface Gathered {
  input: PrecheckInput;
  item: ItemRow | null;
  supplier: SupplierRow | null;
  source: SourceAccountRow | null;
}

export interface GatherOptions {
  nowMs: number;
  state: PaymentsState;
  requester: string;
  openItemId: number;
  sourceAccountId: number;
  requestedAmountMinor?: number | undefined;
  /** A request that exists already (confirm re-checks it): it does not conflict with itself. */
  excludePaymentId?: number;
  /** Its batch does not conflict with the item either. */
  excludeBatchId?: number;
  /** The keyed-fingerprint key (Workers secret PAYMENTS_IBAN_KEY); null = every IBAN is refused. */
  ibanKey: string | null;
}

/**
 * How many TARGET working days the newest ECB rate may lag today for a payment LIMIT check: the
 * rate of the previous working day (before today's 16:00 publication) and one more for a failed
 * import. An older feed is no rate at all (`no_eur_rate`, review P9a): a stale rate could make a
 * foreign amount look smaller than it is.
 */
export const PAYMENT_RATE_MAX_LAG_TARGET_DAYS = 2;

/** The rate table for today, or null when there is none or the feed is older than the lag above. */
export async function freshRates(db: D1Database, nowMs: number) {
  const today = amsterdamParts(nowMs).date;
  const { table, newestDate } = await loadRateTableWithNewest(db, today);
  if (table === null || newestDate === null) return null;
  let oldest = today;
  for (let k = 0; k < PAYMENT_RATE_MAX_LAG_TARGET_DAYS; k += 1) {
    oldest = previousTargetWorkingDay(oldest);
  }
  return newestDate >= oldest ? table : null;
}

export async function gatherPrecheck(db: D1Database, o: GatherOptions): Promise<Gathered> {
  const item = await readItem(db, o.openItemId);
  const source = await readSourceAccount(db, o.sourceAccountId);
  const supplier =
    item !== null && item.relationExactId !== null
      ? await readSupplier(db, item.divisionId, item.relationExactId)
      : null;
  const exclude = o.excludePaymentId ?? 0;
  const excludeBatch = o.excludeBatchId ?? 0;
  const since = new Date(o.nowMs - 24 * 3600_000).toISOString();
  const key = o.ibanKey ?? "";
  const fp = supplier === null ? null : ibanFingerprint(supplier.iban, key);

  const [conflict, daily, reserved, verification, paid] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM payments WHERE open_item_id = ?1 AND batch_id IS NULL AND id <> ?2
                     AND status IN (${OPEN_LIST})) AS open_request,
           EXISTS (SELECT 1 FROM payments WHERE open_item_id = ?1 AND batch_id IS NOT NULL AND id <> ?2
                     AND batch_id <> ?3 AND status IN (${OPEN_LIST})) AS open_batch,
           EXISTS (SELECT 1 FROM payments p JOIN open_items oi ON oi.id = p.open_item_id
                    WHERE p.open_item_id = ?1 AND p.status = 'paid' AND p.updated_at > oi.synced_at) AS paid_since,
           EXISTS (SELECT 1 FROM payments WHERE open_item_id = ?1 AND id <> ?2 AND status = 'paid') AS paid_before`,
      )
      .bind(o.openItemId, exclude, excludeBatch),
    db
      .prepare(
        `SELECT COALESCE(SUM(eur_minor), 0) AS n FROM payments
          WHERE (created_at >= ?1 OR updated_at >= ?1) AND id <> ?2 AND status IN (${OPEN_LIST}, 'paid')
            AND (batch_id IS NULL OR batch_id <> ?3)`,
      )
      .bind(since, exclude, excludeBatch),
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payments
          WHERE bank_account_id = ?1 AND id <> ?2 AND status IN (${OPEN_LIST})
            AND (batch_id IS NULL OR batch_id <> ?3)`,
      )
      .bind(o.sourceAccountId, exclude, excludeBatch),
    db
      .prepare(
        `SELECT iban_fingerprint, kind, verified_by FROM supplier_iban_verifications
          WHERE relation_id = ?1 ORDER BY id DESC LIMIT 1`,
      )
      .bind(supplier?.rowId ?? 0),
    db
      .prepare(
        "SELECT EXISTS (SELECT 1 FROM payments WHERE iban_fingerprint = ?1 AND status = 'paid') AS n",
      )
      .bind(fp ?? ""),
  ]);
  const c = conflict?.results?.[0];
  const v = verification?.results?.[0];
  const rates = item !== null && item.currency !== "EUR" ? await freshRates(db, o.nowMs) : null;
  const fresh =
    item === null ? false : (await openItemsFreshness(db, item.divisionId, o.nowMs)).payable;
  const approval: InvoiceApproval =
    item === null ? "unknown" : await invoiceApproval(db, item, o.nowMs);

  const input: PrecheckInput = {
    nowMs: o.nowMs,
    paymentsEnabled: paymentsPermitted(o.state),
    settings: o.state.settings,
    requesterEmail: o.requester,
    item:
      item === null
        ? null
        : {
            kind: item.kind,
            closed: item.closed,
            openMinor: item.openMinor,
            currency: item.currency,
            invoiceNumber: item.invoiceNumber,
            invoiceIban: item.kind === "bill" ? await readInvoiceIban(db, item.id) : null,
            fresh,
          },
    approval,
    supplier: supplier === null ? null : { found: true, isSupplier: supplier.isSupplier },
    iban: {
      recordIban: supplier?.iban ?? null,
      verification:
        v === undefined
          ? null
          : {
              fingerprint: String(v["iban_fingerprint"]),
              verifiedBy: String(v["verified_by"]),
              revoked: v["kind"] === "revoked",
            },
      paidBefore: Number(paid?.results?.[0]?.["n"] ?? 0) === 1,
      fingerprintKey: key,
    },
    ibanReadAtMs: supplier?.ibanReadAtMs ?? null,
    ...(o.requestedAmountMinor !== undefined
      ? { requestedAmountMinor: o.requestedAmountMinor }
      : {}),
    conflicts: {
      openRequest: Number(c?.["open_request"] ?? 0) === 1,
      openBatch: Number(c?.["open_batch"] ?? 0) === 1,
      paidSinceSync: Number(c?.["paid_since"] ?? 0) === 1,
      paidBefore: Number(c?.["paid_before"] ?? 0) === 1,
    },
    source:
      source === null
        ? null
        : {
            found: true,
            active: source.active,
            currency: source.currency,
            balanceMinor: source.balanceMinor,
            balanceAtMs: source.balanceAtMs,
            reservedMinor: Number(reserved?.results?.[0]?.["n"] ?? 0),
          },
    dailyTotalEurMinor: Number(daily?.results?.[0]?.["n"] ?? 0),
    rates,
  };
  return { input, item, supplier, source };
}

export function precheck(g: Gathered): PrecheckResult {
  return precheckPayment(g.input);
}

export type { PaymentSettings };
