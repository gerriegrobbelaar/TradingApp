/**
 * Writes of the matching feature (Phase 7, ADR 0042). INTERNAL ONLY: nothing here talks to Exact
 * or Revolut. Every change and its audit row are ONE db.batch (ADR 0013).
 *
 * Race safety lives in the database (migration 0022): triggers abort the whole batch with
 * `match_err:<code>` when the bank line is no longer open for matching, when an item would be
 * over-allocated, or when the division, currency or amount do not agree; a partial UNIQUE index
 * allows one live match per bank line. The code only maps those errors to a result, so two writers
 * racing (two job runs, the job against a person) end with exactly one match.
 */
import { auditStatement, LAST_INSERT_ID } from "../db/audit";
import { allocCounts } from "./settlement";

export const MATCH_ENGINE_VERSION = "m7-1";

export const ERR_CODES = [
  "tx_not_matchable",
  "division_mismatch",
  "division_inactive",
  "bad_match_row",
  "match_not_live",
  "alloc_on_ledger_match",
  "item_not_matchable",
  "direction_mismatch",
  "alloc_exceeds_open",
  "alloc_exceeds_tx",
  "cannot_revive",
  "immutable",
  "tx_frozen",
  "status_mismatch",
  "has_live_matches",
  "bad_transition",
] as const;

export type MatchErrCode = (typeof ERR_CODES)[number];

/** The code a trigger raised, or the unique-index violation of a second live match; else null. */
export function matchErrorCode(err: unknown): MatchErrCode | null {
  const msg = err instanceof Error ? `${err.message} ${String(err.cause ?? "")}` : String(err);
  const m = /match_err:([a-z_]+)/.exec(msg);
  if (m)
    return (ERR_CODES as readonly string[]).includes(m[1] as string)
      ? (m[1] as MatchErrCode)
      : null;
  if (/UNIQUE constraint failed: matches\.bank_transaction_id/.test(msg)) return "tx_not_matchable";
  return null;
}

export interface AllocInput {
  openItemId: number;
  /** Magnitude, positive. */
  allocatedMinor: number;
  /** Signed open balance left after this allocation, when known. */
  remainingAfter: number | null;
}

export interface ApplyMatchInput {
  txId: number;
  divisionId: number;
  /** Absolute amount of the bank line. */
  txAmountMinor: number;
  currency: string;
  source: "auto" | "manual" | "ledger";
  ledgerAccountCode: string | null;
  score: number | null;
  rule: number | null;
  note: string | null;
  /** Email of the person, or `system` for the job. */
  actor: string;
  allocations: AllocInput[];
  nowIso: string;
  /** A person confirmed matching to an item of another relation than the IBAN's (audited). */
  differentRelationConfirmed?: boolean;
}

export type ApplyResult = { ok: true; matchId: number } | { ok: false; code: MatchErrCode };

const ACTION: Record<ApplyMatchInput["source"], string> = {
  auto: "match.auto",
  manual: "match.manual",
  ledger: "match.ledger",
};

/**
 * Match + allocations + audit + tx status + suggestion cleanup, atomically. A lost race or a
 * stale view is `{ ok: false, code }`; an unexpected database error is thrown.
 */
export async function applyMatch(db: D1Database, m: ApplyMatchInput): Promise<ApplyResult> {
  // A match settles invoices (allocations) OR books to a ledger account, never both and never
  // neither (checkMatchingInvariants). The triggers check every allocation; this checks the shape.
  if ((m.ledgerAccountCode === null) === (m.allocations.length === 0)) {
    throw new RangeError("a match needs allocations or a ledger account, not both");
  }
  if (m.source === "manual" && m.ledgerAccountCode !== null) {
    throw new RangeError("a manual match has allocations; a ledger match is source 'ledger'");
  }
  if (m.source === "ledger" && m.ledgerAccountCode === null) {
    throw new RangeError("a ledger match needs a ledger account");
  }
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO matches (bank_transaction_id, division_id, source, ledger_account_code, amount_minor,
                              currency, score, rule, note, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        m.txId,
        m.divisionId,
        m.source,
        m.ledgerAccountCode,
        m.txAmountMinor,
        m.currency,
        m.score,
        m.rule,
        m.note,
        m.actor,
        m.nowIso,
      ),
    auditStatement(db, {
      actorEmail: m.actor,
      action: ACTION[m.source],
      entity: "match",
      entityId: LAST_INSERT_ID,
      after: {
        transactionId: m.txId,
        divisionId: m.divisionId,
        source: m.source,
        score: m.score,
        rule: m.rule,
        ledgerAccountCode: m.ledgerAccountCode,
        amountMinor: m.txAmountMinor,
        currency: m.currency,
        allocations: m.allocations.map((a) => ({
          openItemId: a.openItemId,
          allocatedMinor: a.allocatedMinor,
          remainingAfter: a.remainingAfter,
        })),
        ...(m.note !== null ? { note: m.note } : {}),
        ...(m.differentRelationConfirmed === true ? { differentRelationConfirmed: true } : {}),
      },
    }),
    ...m.allocations.map((a) =>
      db
        .prepare(
          `INSERT INTO match_allocations (match_id, open_item_id, allocated_minor, currency, remaining_minor_after,
                                        open_before_minor)
           VALUES ((SELECT id FROM matches WHERE bank_transaction_id = ?1 AND undone_at IS NULL),
                   ?2, ?3, ?4, ?5, (SELECT oi.open_minor FROM open_items oi WHERE oi.id = ?2))`,
        )
        .bind(m.txId, a.openItemId, a.allocatedMinor, m.currency, a.remainingAfter),
    ),
    db
      .prepare(
        `UPDATE bank_transactions SET match_status = 'matched'
         WHERE id = ?1 AND match_status IN ('unmatched', 'suggested')`,
      )
      .bind(m.txId),
    db.prepare("DELETE FROM match_suggestions WHERE bank_transaction_id = ?1").bind(m.txId),
  ];
  try {
    const out = await db.batch(statements);
    const matchId = out[0]?.meta.last_row_id;
    if (typeof matchId !== "number" || matchId <= 0) throw new Error("match insert returned no id");
    return { ok: true, matchId };
  } catch (err) {
    const code = matchErrorCode(err);
    if (code === null) throw err;
    return { ok: false, code };
  }
}

export type UndoResult =
  | { kind: "undone" }
  | { kind: "not_found" }
  | { kind: "already_undone" }
  | { kind: "already_booked_in_exact"; exactState: string };

/**
 * Undo while Exact has not booked the match (`exact_state = 'not_booked'`): the match becomes
 * `undone` (its allocations stop counting), the bank line returns to `unmatched` and its stale
 * suggestions are dropped so the next run recomputes them.
 */
export async function undoMatch(
  db: D1Database,
  matchId: number,
  actor: string,
  reason: string,
  nowIso: string,
): Promise<UndoResult> {
  const m = await db
    .prepare(
      `SELECT bank_transaction_id, source, exact_state, undone_at FROM matches WHERE id = ?1`,
    )
    .bind(matchId)
    .first<{
      bank_transaction_id: number;
      source: string;
      exact_state: string;
      undone_at: string | null;
    }>();
  if (!m) return { kind: "not_found" };
  if (m.undone_at !== null) return { kind: "already_undone" };
  if (m.exact_state !== "not_booked") {
    return { kind: "already_booked_in_exact", exactState: m.exact_state };
  }
  const live =
    "EXISTS (SELECT 1 FROM matches WHERE id = ?7 AND undone_at IS NULL AND exact_state = 'not_booked')";
  const done = `EXISTS (SELECT 1 FROM matches WHERE id = ?1 AND undone_at = ?2 AND undone_by = ?3)`;
  const out = await db.batch([
    auditStatement(
      db,
      {
        actorEmail: actor,
        action: "match.undo",
        entity: "match",
        entityId: matchId,
        before: { status: "live", source: m.source, exactState: m.exact_state },
        after: { status: "undone", reason },
      },
      { sql: live, binds: [matchId] },
    ),
    db
      .prepare(
        `UPDATE matches SET undone_at = ?2, undone_by = ?3, undo_reason = ?4
         WHERE id = ?1 AND undone_at IS NULL AND exact_state = 'not_booked'`,
      )
      .bind(matchId, nowIso, actor, reason),
    db
      .prepare(
        `UPDATE bank_transactions SET match_status = 'unmatched', match_checked_at = NULL
         WHERE id = ?4 AND match_status = 'matched' AND ${done}`,
      )
      .bind(matchId, nowIso, actor, m.bank_transaction_id),
    db
      .prepare(`DELETE FROM match_suggestions WHERE bank_transaction_id = ?4 AND ${done}`)
      .bind(matchId, nowIso, actor, m.bank_transaction_id),
  ]);
  if ((out[0]?.meta.changes ?? 0) === 1) return { kind: "undone" };
  // The guard failed: somebody else undid it, or it was booked, between our read and the batch.
  const now = await db
    .prepare("SELECT exact_state, undone_at FROM matches WHERE id = ?1")
    .bind(matchId)
    .first<{ exact_state: string; undone_at: string | null }>();
  if (now?.undone_at != null) return { kind: "already_undone" };
  return { kind: "already_booked_in_exact", exactState: now?.exact_state ?? "booking" };
}

export type IgnoreReason = "internal_transfer" | "not_ours" | "other";

/** True when the line was open and is now ignored (audited in the same batch). */
export async function ignoreTransaction(
  db: D1Database,
  txId: number,
  reason: IgnoreReason,
  note: string | null,
  actor: string,
  nowIso: string,
): Promise<boolean> {
  const open = `EXISTS (SELECT 1 FROM bank_transactions WHERE id = ?7 AND match_status IN ('unmatched', 'suggested')
                  AND is_final = 1 AND state = 'completed')
                AND NOT EXISTS (SELECT 1 FROM matches WHERE bank_transaction_id = ?7 AND undone_at IS NULL)`;
  const out = await db.batch([
    auditStatement(
      db,
      {
        actorEmail: actor,
        action: "bank_transaction.ignore",
        entity: "bank_transaction",
        entityId: txId,
        before: { matchStatus: "open" },
        after: { matchStatus: "ignored", reason, ...(note !== null ? { note } : {}) },
      },
      { sql: open, binds: [txId] },
    ),
    db
      .prepare(
        `UPDATE bank_transactions
         SET match_status = 'ignored', ignored_reason = ?2, ignored_note = ?3, ignored_by = ?4, ignored_at = ?5
         WHERE id = ?1 AND match_status IN ('unmatched', 'suggested') AND is_final = 1 AND state = 'completed'
           AND NOT EXISTS (SELECT 1 FROM matches WHERE bank_transaction_id = ?1 AND undone_at IS NULL)`,
      )
      .bind(txId, reason, note, actor, nowIso),
    db
      .prepare(
        `DELETE FROM match_suggestions WHERE bank_transaction_id = ?1
           AND EXISTS (SELECT 1 FROM bank_transactions WHERE id = ?1 AND match_status = 'ignored')`,
      )
      .bind(txId),
  ]);
  return (out[1]?.meta.changes ?? 0) === 1;
}

/** True when the line was ignored and is now open again. */
export async function unignoreTransaction(
  db: D1Database,
  txId: number,
  actor: string,
): Promise<boolean> {
  const out = await db.batch([
    auditStatement(
      db,
      {
        actorEmail: actor,
        action: "bank_transaction.unignore",
        entity: "bank_transaction",
        entityId: txId,
        before: { matchStatus: "ignored" },
        after: { matchStatus: "unmatched" },
      },
      {
        sql: "EXISTS (SELECT 1 FROM bank_transactions WHERE id = ?7 AND match_status = 'ignored')",
        binds: [txId],
      },
    ),
    db
      .prepare(
        `UPDATE bank_transactions
         SET match_status = 'unmatched', ignored_reason = NULL, ignored_note = NULL, ignored_by = NULL,
             ignored_at = NULL, match_checked_at = NULL
         WHERE id = ?1 AND match_status = 'ignored'`,
      )
      .bind(txId),
  ]);
  return (out[1]?.meta.changes ?? 0) === 1;
}

export interface SuggestionRow {
  rank: number;
  openItemId: number | null;
  ledgerAccountCode: string | null;
  score: number;
  rule: number;
  kind: "full" | "partial" | "overpayment" | "ledger";
  allocatedMinor: number;
  remainingMinor: number;
  surplusMinor: number;
  allocationsJson: string;
  reasonsJson: string;
  blockedJson: string;
  explanationJson: string;
  autoEligible: boolean;
  groupId: string | null;
}

export interface SuggestionMeta {
  computedAt: string;
  inputHash: string;
}

/**
 * Replaces a line's suggestions and sets its status ('suggested' when there are rows, else
 * 'unmatched'). Every statement only acts while the line is still unmatched or suggested, so a
 * match, an ignore or an undo made meanwhile is never overwritten.
 */
export function suggestionStatements(
  db: D1Database,
  txId: number,
  rows: SuggestionRow[],
  meta: SuggestionMeta,
): D1PreparedStatement[] {
  const open =
    "EXISTS (SELECT 1 FROM bank_transactions WHERE id = ?1 AND match_status IN ('unmatched', 'suggested'))";
  return [
    db
      .prepare(`DELETE FROM match_suggestions WHERE bank_transaction_id = ?1 AND ${open}`)
      .bind(txId),
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO match_suggestions
             (bank_transaction_id, rank, open_item_id, ledger_account_code, score, rule, kind,
              allocated_minor, remaining_minor, surplus_minor, allocations_json, reasons_json,
              blocked_json, explanation_json, auto_eligible, group_id, computed_at, engine_version, input_hash)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
           WHERE ${open}`,
        )
        .bind(
          txId,
          r.rank,
          r.openItemId,
          r.ledgerAccountCode,
          r.score,
          r.rule,
          r.kind,
          r.allocatedMinor,
          r.remainingMinor,
          r.surplusMinor,
          r.allocationsJson,
          r.reasonsJson,
          r.blockedJson,
          r.explanationJson,
          r.autoEligible ? 1 : 0,
          r.groupId,
          meta.computedAt,
          MATCH_ENGINE_VERSION,
          meta.inputHash,
        ),
    ),
    db
      .prepare(
        `UPDATE bank_transactions SET match_status = ?2
         WHERE id = ?1 AND match_status IN ('unmatched', 'suggested')`,
      )
      .bind(txId, rows.length > 0 ? "suggested" : "unmatched"),
  ];
}

// The settlement predicate lives in ONE place (settlement.ts, ADR 0042 addendum).
export { allocCounts } from "./settlement";

export type ReviewReason = "over_allocated" | "item_closed" | "tx_state_conflict" | "tx_changed";

/**
 * Flags every live, not yet booked match that no longer agrees with the data it was built on
 * (ADR 0042, "Data that changes after matching"). ONE statement for all divisions. The flag is
 * sticky: a person undoes the match, and M7c must never book a flagged match. Returns how many
 * matches were flagged now.
 *
 *   tx_state_conflict  Revolut contradicted the line after it was matched (state_conflict).
 *   tx_changed         the line's amount or currency differ from the match (a database trigger
 *                      makes this impossible today; checked anyway).
 *   item_closed        an allocated item is closed or has no open balance any more in Exact
 *                      (paid or credited elsewhere; the sync wrote it).
 *   over_allocated     the live allocations of an item now exceed its Exact open balance (Exact's
 *                      balance fell, for example a part payment booked elsewhere).
 */
export async function flagMatchesForReview(db: D1Database, nowIso: string): Promise<number> {
  const out = await db
    .prepare(
      `UPDATE matches SET review_flagged_at = ?1, review_reason = (
         CASE
           WHEN EXISTS (SELECT 1 FROM bank_transactions t WHERE t.id = matches.bank_transaction_id
                          AND t.state_conflict = 1) THEN 'tx_state_conflict'
           WHEN NOT EXISTS (SELECT 1 FROM bank_transactions t WHERE t.id = matches.bank_transaction_id
                              AND ABS(t.amount_minor) = matches.amount_minor
                              AND t.currency = matches.currency) THEN 'tx_changed'
           WHEN EXISTS (SELECT 1 FROM match_allocations a JOIN open_items oi ON oi.id = a.open_item_id
                         WHERE a.match_id = matches.id
                           AND (oi.status <> 'open' OR oi.open_minor = 0)) THEN 'item_closed'
           WHEN EXISTS (SELECT 1 FROM match_allocations a JOIN open_items oi ON oi.id = a.open_item_id
                         WHERE a.match_id = matches.id
                           AND (SELECT SUM(a2.allocated_minor) FROM match_allocations a2
                                  JOIN matches m2 ON m2.id = a2.match_id
                                 WHERE a2.open_item_id = a.open_item_id AND ${allocCounts("m2", "oi", "a2")})
                               > ABS(oi.open_minor)) THEN 'over_allocated'
         END)
       WHERE undone_at IS NULL AND exact_state = 'not_booked' AND review_reason IS NULL
         AND (EXISTS (SELECT 1 FROM bank_transactions t WHERE t.id = matches.bank_transaction_id
                        AND (t.state_conflict = 1 OR ABS(t.amount_minor) <> matches.amount_minor
                             OR t.currency <> matches.currency))
              OR EXISTS (SELECT 1 FROM match_allocations a JOIN open_items oi ON oi.id = a.open_item_id
                          WHERE a.match_id = matches.id
                            AND (oi.status <> 'open' OR oi.open_minor = 0
                                 OR (SELECT SUM(a2.allocated_minor) FROM match_allocations a2
                                       JOIN matches m2 ON m2.id = a2.match_id
                                      WHERE a2.open_item_id = a.open_item_id AND ${allocCounts("m2", "oi", "a2")})
                                    > ABS(oi.open_minor))))`,
    )
    .bind(nowIso)
    .run();
  return out.meta.changes ?? 0;
}

/**
 * The booking contract for M7c (ADR 0042, "Undo window"): a match moves out of `not_booked` ONLY
 * through this conditional UPDATE, so Undo (which needs `not_booked`) and booking can never both
 * win. A match flagged for review is never claimed. True when this caller won the claim.
 */
export async function claimMatchForBooking(
  db: D1Database,
  matchId: number,
  nextState: string,
): Promise<boolean> {
  const out = await claimStatement(db, matchId, nextState).run();
  // `>= 1`: D1 also counts the allocation rows the claim trigger refreshes (the settlement baseline,
  // migration 0025); the UPDATE targets one id, so any change means this caller won.
  return (out.meta.changes ?? 0) >= 1;
}

/**
 * The claim as a prepared statement (`note` = machine code for matches.exact_note, or null). The
 * SAME conditional UPDATE serves `claimMatchForBooking` and the booking outbox (booking/outbox.ts
 * `claimAndEnqueue` adds the outbox row, the idempotency key and the audit row to the batch).
 */
export function claimStatement(
  db: D1Database,
  matchId: number,
  nextState: string,
  note: string | null = null,
): D1PreparedStatement {
  if (!/^[a-z_]{1,32}$/.test(nextState) || nextState === "not_booked") {
    throw new RangeError("bad exact_state");
  }
  return db
    .prepare(
      `UPDATE matches SET exact_state = ?2, exact_note = ?3
       WHERE id = ?1 AND undone_at IS NULL AND exact_state = 'not_booked' AND review_reason IS NULL`,
    )
    .bind(matchId, nextState, note);
}
