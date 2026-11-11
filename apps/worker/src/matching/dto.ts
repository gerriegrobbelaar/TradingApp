/**
 * Row -> API shape for the matching routes (Phase 7, ADR 0042). IBANs are masked everywhere, and
 * free text from outside (bank references, explanation lines) is passed through core cleaning
 * (control characters removed, IBAN-like strings masked, length capped).
 */
import {
  cleanText,
  explainBlock,
  maskIban,
  maskIbans,
  type MatchAllocationDto,
  type MatchCandidateDto,
  type MatchDto,
  type MatchIgnoreReason,
  type MatchStatus,
  type MatchTxDto,
} from "@camelthorn/core";
import { MATCH_UNSENT } from "../booking/unsent";

const MAX_TEXT = 300;

/** Free text from the bank or a person, safe to return: no control characters, no IBAN. */
export const safeText = (s: string | null, max = MAX_TEXT): string | null =>
  s === null ? null : cleanText(maskIbans(s), max);

export interface TxSqlRow {
  id: number;
  bank_account_id: number | null;
  account_name: string | null;
  created_at: string;
  completed_at: string | null;
  amount_minor: number;
  currency: string;
  type: string | null;
  reference: string | null;
  description: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  match_status: string;
  state_conflict: number;
  ignored_reason: string | null;
  ignored_note: string | null;
  ignored_by: string | null;
  ignored_at: string | null;
  mapped: number;
  division_id: number | null;
}

export const TX_SELECT = `SELECT t.id, t.bank_account_id, a.name AS account_name, t.created_at,
  t.completed_at, t.amount_minor, t.currency, t.type, t.reference, t.description,
  t.counterparty_name, t.counterparty_iban, t.match_status, t.state_conflict, t.ignored_reason,
  t.ignored_note, t.ignored_by, t.ignored_at, (m.id IS NOT NULL) AS mapped, m.division_id
  FROM bank_transactions t
  LEFT JOIN bank_accounts a ON a.id = t.bank_account_id
  LEFT JOIN bank_account_exact_map m ON m.bank_account_id = t.bank_account_id`;

export function toTxDto(r: TxSqlRow): MatchTxDto {
  return {
    id: r.id,
    accountId: r.bank_account_id,
    accountName: safeText(r.account_name, 80),
    createdAt: r.created_at,
    completedAt: r.completed_at,
    amountMinor: r.amount_minor,
    currency: r.currency,
    type: safeText(r.type, 40),
    reference: safeText(r.reference),
    description: safeText(r.description),
    counterpartyName: safeText(r.counterparty_name, 120),
    counterpartyIbanMasked: r.counterparty_iban === null ? null : maskIban(r.counterparty_iban),
    matchStatus: r.match_status as MatchStatus,
    mapped: r.mapped === 1,
    divisionId: r.mapped === 1 ? r.division_id : null,
    stateConflict: r.state_conflict === 1,
    ignore:
      r.match_status === "ignored" && r.ignored_reason !== null
        ? {
            reason: r.ignored_reason as MatchIgnoreReason,
            note: safeText(r.ignored_note, 200),
            by: r.ignored_by ?? "",
            at: r.ignored_at ?? "",
          }
        : null,
  };
}

interface ItemInfoRow {
  id: number;
  invoice_number: string | null;
  relation_name: string | null;
  kind: "invoice" | "bill";
  currency: string;
}

/** Display facts of open items (invoice number, relation name), by id; one query per 90 ids. */
export async function loadItemInfo(
  db: D1Database,
  ids: number[],
): Promise<Map<number, ItemInfoRow>> {
  const out = new Map<number, ItemInfoRow>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 90) {
    const part = unique.slice(i, i + 90);
    const rows = (
      await db
        .prepare(
          `SELECT id, invoice_number, relation_name, kind, currency FROM open_items
           WHERE id IN (${part.map((_, k) => `?${k + 1}`).join(", ")})`,
        )
        .bind(...part)
        .all<ItemInfoRow>()
    ).results;
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

export interface SuggestionSqlRow {
  bank_transaction_id: number;
  rank: number;
  ledger_account_code: string | null;
  score: number;
  rule: number;
  kind: string;
  allocated_minor: number;
  remaining_minor: number;
  surplus_minor: number;
  allocations_json: string;
  reasons_json: string;
  blocked_json: string;
  explanation_json: string;
  auto_eligible: number;
  group_id: string | null;
  computed_at: string;
}

const parseArray = (s: string): unknown[] => {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** Suggestions of the given lines, best first. */
export async function loadSuggestions(
  db: D1Database,
  txIds: number[],
): Promise<Map<number, MatchCandidateDto[]>> {
  const rows: SuggestionSqlRow[] = [];
  for (let i = 0; i < txIds.length; i += 90) {
    const part = txIds.slice(i, i + 90);
    rows.push(
      ...(
        await db
          .prepare(
            `SELECT bank_transaction_id, rank, ledger_account_code, score, rule, kind, allocated_minor,
                    remaining_minor, surplus_minor, allocations_json, reasons_json, blocked_json,
                    explanation_json, auto_eligible, group_id, computed_at
             FROM match_suggestions
             WHERE bank_transaction_id IN (${part.map((_, k) => `?${k + 1}`).join(", ")})
             ORDER BY bank_transaction_id, rank`,
          )
          .bind(...part)
          .all<SuggestionSqlRow>()
      ).results,
    );
  }
  const parsed = rows.map((r) => ({
    r,
    allocs: parseArray(r.allocations_json).flatMap((x) => {
      const o = x as { i?: unknown; a?: unknown };
      return typeof o.i === "number" && typeof o.a === "number" ? [{ i: o.i, a: o.a }] : [];
    }),
  }));
  const info = await loadItemInfo(
    db,
    parsed.flatMap((p) => p.allocs.map((a) => a.i)),
  );
  const out = new Map<number, MatchCandidateDto[]>();
  for (const { r, allocs } of parsed) {
    const dto: MatchCandidateDto = {
      rank: r.rank,
      rule: r.rule as 1 | 2 | 3 | 4,
      kind: r.kind as MatchCandidateDto["kind"],
      score: r.score,
      allocatedMinor: r.allocated_minor,
      remainingMinor: r.remaining_minor,
      surplusMinor: r.surplus_minor,
      autoEligible: r.auto_eligible === 1,
      blocked: parseArray(r.blocked_json)
        .filter((c): c is string => typeof c === "string")
        .slice(0, 12)
        .map((code) => ({ code: cleanText(code, 40), text: explainBlock(code) })),
      explanation: parseArray(r.explanation_json)
        .filter((c): c is string => typeof c === "string")
        .slice(0, 8)
        .map((line) => cleanText(maskIbans(line), 240)),
      reasonCodes: parseArray(r.reasons_json).flatMap((x) => {
        const c = (x as { c?: unknown }).c;
        return typeof c === "string" ? [cleanText(c, 40)] : [];
      }),
      ledgerAccountCode: r.ledger_account_code,
      groupId: r.group_id === null ? null : cleanText(r.group_id, 120),
      allocations: allocs.map((a) => allocationDto(a.i, a.a, null, info.get(a.i))),
      computedAt: r.computed_at,
    };
    const list = out.get(r.bank_transaction_id) ?? [];
    list.push(dto);
    out.set(r.bank_transaction_id, list);
  }
  return out;
}

export function allocationDto(
  openItemId: number,
  allocatedMinor: number,
  remainingAfter: number | null,
  info: ItemInfoRow | undefined,
): MatchAllocationDto {
  return {
    openItemId,
    invoiceNumber: info ? safeText(info.invoice_number, 60) : null,
    relationName: info ? safeText(info.relation_name, 120) : null,
    kind: info ? info.kind : null,
    currency: info ? info.currency : "",
    allocatedMinor,
    remainingMinorAfter: remainingAfter,
  };
}

interface MatchSqlRow {
  id: number;
  bank_transaction_id: number;
  division_id: number;
  source: string;
  status: string;
  ledger_account_code: string | null;
  score: number | null;
  rule: number | null;
  note: string | null;
  created_by: string;
  created_at: string;
  undone_by: string | null;
  undone_at: string | null;
  undo_reason: string | null;
  exact_state: string;
  review_reason: string | null;
  booking_deferred_code: string | null;
  manually_booked: number;
  unsent_claim: number;
}

export const MATCH_COLUMNS = `m.id, m.bank_transaction_id, m.division_id, m.source, m.status,
  m.ledger_account_code, m.score, m.rule, m.note, m.created_by, m.created_at, m.undone_by,
  m.undone_at, m.undo_reason, m.exact_state, m.review_reason, m.booking_deferred_code,
  m.manually_booked, ${MATCH_UNSENT("m")} AS unsent_claim`;

/** Matches by id, with allocations. */
export async function loadMatches(db: D1Database, ids: number[]): Promise<Map<number, MatchDto>> {
  const out = new Map<number, MatchDto>();
  if (ids.length === 0) return out;
  const marks = ids.map((_, i) => `?${i + 1}`).join(", ");
  const rows = (
    await db
      .prepare(`SELECT ${MATCH_COLUMNS} FROM matches m WHERE m.id IN (${marks})`)
      .bind(...ids)
      .all<MatchSqlRow>()
  ).results;
  const allocs = (
    await db
      .prepare(
        `SELECT match_id, open_item_id, allocated_minor, remaining_minor_after
         FROM match_allocations WHERE match_id IN (${marks}) ORDER BY match_id, id`,
      )
      .bind(...ids)
      .all<{
        match_id: number;
        open_item_id: number;
        allocated_minor: number;
        remaining_minor_after: number | null;
      }>()
  ).results;
  const info = await loadItemInfo(
    db,
    allocs.map((a) => a.open_item_id),
  );
  for (const r of rows) {
    const live = r.status === "live";
    out.set(r.id, {
      id: r.id,
      transactionId: r.bank_transaction_id,
      divisionId: r.division_id,
      source: r.source as MatchDto["source"],
      status: live ? "live" : "undone",
      ledgerAccountCode: r.ledger_account_code,
      score: r.score,
      rule: r.rule,
      note: safeText(r.note, 200),
      createdBy: r.created_by,
      createdAt: r.created_at,
      undoneBy: r.undone_by,
      undoneAt: r.undone_at,
      undoReason: safeText(r.undo_reason, 200),
      exactState: r.exact_state,
      reviewReason: r.review_reason,
      // A claimed match that provably never reached Exact can be undone as well (migration 0024).
      undoAvailable: live && (r.exact_state === "not_booked" || r.unsent_claim === 1),
      bookingDeferredCode: r.booking_deferred_code,
      bookedManually: r.manually_booked === 1,
      allocations: allocs
        .filter((a) => a.match_id === r.id)
        .map((a) =>
          allocationDto(
            a.open_item_id,
            a.allocated_minor,
            a.remaining_minor_after,
            info.get(a.open_item_id),
          ),
        ),
    });
  }
  return out;
}
