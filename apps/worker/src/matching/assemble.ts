/**
 * Data assembly for the matching engine (Phase 7, ADR 0042): D1 rows -> core MatchTx / MatchItem.
 * Read-only. Full IBANs are used in memory only; nothing here returns or logs one.
 *
 * Division scope: a bank account is mapped to ONE Exact division (bank_account_exact_map); only the
 * open items of that division are candidates (the same invoice number can exist in two divisions).
 * `openMinor` of an item is the stored Exact balance MINUS the live allocations of earlier matches
 * that Exact has not booked yet, so a part payment leaves the rest open and a fully allocated item
 * has nothing left to offer (`hasLiveMatch`).
 */
import { amsterdamParts, normalizeIban, type MatchItem, type MatchTx } from "@camelthorn/core";
import { allocCounts } from "./store";

export const TX_WINDOW_DAYS = 120;
export const TX_CAP_PER_RUN = 500;

export interface MappedAccount {
  bankAccountId: number;
  connectionId: number;
  divisionId: number;
  journalCode: string;
  bankGlAccountCode: string;
}

/** Mapped, active Revolut accounts whose division is visible; plus how many active accounts are not mapped. */
export async function loadMappings(
  db: D1Database,
): Promise<{ mapped: MappedAccount[]; unmappedAccounts: number }> {
  const rows = (
    await db
      .prepare(
        `SELECT m.bank_account_id, ba.connection_id, m.division_id, m.journal_code, m.bank_gl_account_code
         FROM bank_account_exact_map m
           JOIN bank_accounts ba ON ba.id = m.bank_account_id
           JOIN connections rc ON rc.id = ba.connection_id AND rc.kind = 'revolut' AND rc.status <> 'disabled'
           JOIN divisions d ON d.id = m.division_id AND d.sync_enabled = 1
           JOIN connections ec ON ec.id = d.connection_id AND ec.status <> 'disabled'
         WHERE ba.is_active = 1
         ORDER BY m.division_id, m.bank_account_id`,
      )
      .all<{
        bank_account_id: number;
        connection_id: number;
        division_id: number;
        journal_code: string;
        bank_gl_account_code: string;
      }>()
  ).results;
  const unmapped = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bank_accounts ba
         JOIN connections rc ON rc.id = ba.connection_id AND rc.kind = 'revolut' AND rc.status <> 'disabled'
       WHERE ba.is_active = 1
         AND NOT EXISTS (SELECT 1 FROM bank_account_exact_map m WHERE m.bank_account_id = ba.id)`,
    )
    .first<{ n: number }>();
  return {
    mapped: rows.map((r) => ({
      bankAccountId: r.bank_account_id,
      connectionId: r.connection_id,
      divisionId: r.division_id,
      journalCode: r.journal_code,
      bankGlAccountCode: r.bank_gl_account_code,
    })),
    unmappedAccounts: unmapped?.n ?? 0,
  };
}

interface TxSqlRow {
  id: number;
  connection_id: number;
  bank_account_id: number;
  amount_minor: number;
  currency: string;
  completed_at: string | null;
  created_at: string;
  booked_at: string;
  reference: string | null;
  description: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  counterparty_ref: string | null;
  type: string | null;
  counterparty_account_type: string | null;
  is_final: number;
  state: string;
  request_id: string | null;
  state_conflict: number;
  match_status: string;
  live: number;
}

/** Amsterdam calendar day of an ISO instant, else the first 10 characters if they are a date. */
export function amsterdamDay(...candidates: (string | null)[]): string {
  for (const c of candidates) {
    if (c === null) continue;
    const t = Date.parse(c);
    if (Number.isFinite(t)) return amsterdamParts(t).date;
  }
  return "";
}

export function toMatchTx(r: TxSqlRow): MatchTx {
  const amount = BigInt(r.amount_minor);
  return {
    id: r.id,
    connectionId: r.connection_id,
    accountId: r.bank_account_id,
    direction: r.amount_minor >= 0 ? "in" : "out",
    amountMinor: amount < 0n ? -amount : amount,
    currency: r.currency,
    bookedAt: amsterdamDay(r.completed_at, r.created_at, r.booked_at),
    reference: r.reference,
    description: r.description,
    counterpartyName: r.counterparty_name,
    counterpartyIban: r.counterparty_iban === null ? null : normalizeIban(r.counterparty_iban),
    counterpartyRef: r.counterparty_ref,
    type: r.type,
    counterpartyAccountType: r.counterparty_account_type,
    isFinal: r.is_final === 1,
    state: r.state,
    requestId: r.request_id,
    frozen: r.live > 0,
    stateConflict: r.state_conflict === 1,
  };
}

export interface AssembledTxs {
  txs: MatchTx[];
  /** Stored match_status per transaction id ('unmatched' or 'suggested'). */
  status: Map<number, string>;
  /** True when more rows were waiting than the cap allows in one run. */
  capped: boolean;
}

/**
 * Final, completed bank lines of the given accounts that still need a decision, least recently
 * checked first (then oldest), at most `cap`, of the last TX_WINDOW_DAYS days.
 */
export async function assembleTransactions(
  db: D1Database,
  accountIds: number[],
  nowMs: number,
  cap: number = TX_CAP_PER_RUN,
): Promise<AssembledTxs> {
  if (accountIds.length === 0) return { txs: [], status: new Map(), capped: false };
  const since = new Date(nowMs - TX_WINDOW_DAYS * 86_400_000).toISOString();
  const marks = accountIds.map((_, i) => `?${i + 2}`).join(", ");
  const rows = (
    await db
      .prepare(
        `SELECT t.id, t.connection_id, t.bank_account_id, t.amount_minor, t.currency, t.completed_at,
                t.created_at, t.booked_at, t.reference, t.description, t.counterparty_name,
                t.counterparty_iban, t.counterparty_ref, t.type, t.counterparty_account_type,
                t.is_final, t.state, t.request_id, t.state_conflict, t.match_status,
                (SELECT COUNT(*) FROM matches m WHERE m.bank_transaction_id = t.id
                   AND m.undone_at IS NULL) AS live
         FROM bank_transactions t
         WHERE t.created_at >= ?1 AND t.bank_account_id IN (${marks})
           AND t.is_final = 1 AND t.state = 'completed'
           AND t.match_status IN ('unmatched', 'suggested')
         ORDER BY COALESCE(t.match_checked_at, ''), t.created_at, t.id
         LIMIT ${cap + 1}`,
      )
      .bind(since, ...accountIds)
      .all<TxSqlRow>()
  ).results;
  const page = rows.slice(0, cap);
  return {
    txs: page.map(toMatchTx),
    status: new Map(page.map((r) => [r.id, r.match_status])),
    capped: rows.length > cap,
  };
}

interface ItemSqlRow {
  id: number;
  kind: "invoice" | "bill";
  invoice_number: string | null;
  entry_number: number | null;
  reference: string | null;
  relation_name: string | null;
  currency: string;
  open_minor: number;
  due_date: string | null;
  status: string;
  rel_id: number | null;
  rel_name: string | null;
  rel_iban: string | null;
  iban_added_at: string | null;
  iban_changed_at: string | null;
  allocated: number;
}

/** Open items of one division, net of live allocations, with the relation's active IBANs. */
export async function assembleItems(db: D1Database, divisionId: number): Promise<MatchItem[]> {
  const rows = (
    await db
      .prepare(
        `SELECT oi.id, oi.kind, oi.invoice_number, oi.entry_number, oi.reference, oi.relation_name,
                oi.currency, oi.open_minor, oi.due_date, oi.status, r.id AS rel_id, r.name AS rel_name,
                r.iban AS rel_iban, r.iban_added_at, r.iban_changed_at,
                COALESCE((SELECT SUM(a.allocated_minor) FROM match_allocations a
                            JOIN matches m ON m.id = a.match_id
                           WHERE a.open_item_id = oi.id AND ${allocCounts("m", "oi")}), 0) AS allocated
         FROM open_items oi
           LEFT JOIN relations r ON r.division_id = oi.division_id AND r.exact_id = oi.relation_id
         WHERE oi.division_id = ?1 AND oi.status = 'open' AND oi.open_minor <> 0
         ORDER BY oi.id`,
      )
      .bind(divisionId)
      .all<ItemSqlRow>()
  ).results;
  const ibanRows = (
    await db
      .prepare(
        `SELECT relation_id, iban FROM relation_bank_accounts
         WHERE division_id = ?1 AND removed_at IS NULL ORDER BY relation_id, iban`,
      )
      .bind(divisionId)
      .all<{ relation_id: number; iban: string }>()
  ).results;
  const ibansBy = new Map<number, Set<string>>();
  for (const r of ibanRows) {
    const set = ibansBy.get(r.relation_id) ?? new Set<string>();
    const n = normalizeIban(r.iban);
    if (n !== "") set.add(n);
    ibansBy.set(r.relation_id, set);
  }
  return rows.map((r) => {
    const open = BigInt(r.open_minor);
    const sign = open < 0n ? -1n : 1n;
    const magnitude = open < 0n ? -open : open;
    const allocated = BigInt(r.allocated);
    // Never below zero: more allocated than open (Exact booked meanwhile) leaves nothing to offer.
    const left = allocated >= magnitude ? 0n : magnitude - allocated;
    const ibans = new Set(r.rel_id === null ? [] : (ibansBy.get(r.rel_id) ?? []));
    if (r.rel_iban !== null && normalizeIban(r.rel_iban) !== "")
      ibans.add(normalizeIban(r.rel_iban));
    return {
      id: r.id,
      kind: r.kind === "invoice" ? "receivable" : "payable",
      invoiceNumber: r.invoice_number,
      entryNumber: r.entry_number === null ? null : String(r.entry_number),
      yourRef: r.reference,
      relationId: r.rel_id,
      relationName: r.rel_name ?? r.relation_name,
      relationIbans: [...ibans].sort(),
      relationIbanAddedAt: r.iban_added_at,
      relationIbanChangedAt: r.iban_changed_at,
      currency: r.currency,
      openMinor: sign * left,
      dueDate: r.due_date,
      hasLiveMatch: allocated > 0n && allocated >= magnitude,
      closed: r.status !== "open",
    } satisfies MatchItem;
  });
}
