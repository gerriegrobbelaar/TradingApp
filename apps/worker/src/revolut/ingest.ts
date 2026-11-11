/**
 * Ingest of Revolut transactions into bank_transactions (Phase 5, ADR 0033).
 *
 * One Revolut transaction has one or more LEGS (a transfer between own accounts, an exchange);
 * each leg is one row, unique on (connection_id, external_id, leg_id). The same transaction
 * arrives from the webhook queue, the poll and the backfill, in any order, so the write is an
 * idempotent upsert whose state only moves forward (packages/core `decideLegUpdate`, ADR 0033):
 * a final state is never reopened by a stale event, an unknown state never replaces a known one,
 * completed -> reverted is the one legal final-to-final change.
 *
 * The decision is made in TypeScript from the stored rows and applied as a compare-and-swap
 * (the UPDATE only matches the state and `updated_at` that were decided on), so two writers racing
 * on one transaction cannot overwrite each other; a lost race is retried from a fresh read. All
 * legs of a transaction and the account rows they need are ONE db.batch (one D1 transaction).
 *
 * Matching data (review S6): fee, balance after the leg, counterparty id / account id / type, reason
 * code, card bill amount, the card's last four digits and the merchant are stored with the leg.
 * Once a final row is matched (a live match, or match_status other than 'unmatched') it is FROZEN
 * (review S9): the fields a match was built on are never rewritten; different data from Revolut
 * only sets `state_conflict` (and is counted) for Phase 7/8 to alert on. A refused state change
 * sets the same flag (review S7). The flag is sticky: only a person (later phases) clears it.
 *
 * Amounts are the leg's signed minor units and currency exactly as Revolut gives them. The
 * counterparty IBAN is stored in full (matching needs it) and never logged or returned. Ingestion
 * is not a write to Revolut or Exact, so there is no audit row per transaction; the sync jobs
 * write one summary audit row per run.
 */
import { compactIban, decideLegUpdate, type StoredBankTxState } from "@camelthorn/core";
import type { RevolutLeg, RevolutTransaction } from "@camelthorn/revolut";
import { cachedCounterpartyIban } from "./counterparties";

export type IngestSource = "webhook" | "poll" | "backfill";

export class IngestError extends Error {
  constructor(
    readonly code:
      | "bad_timestamp"
      | "bad_amount"
      | "bad_currency"
      | "bad_transaction_id"
      | "bad_leg"
      | "too_many_legs",
  ) {
    super(code);
    this.name = "IngestError";
  }
}

/**
 * The compare-and-swap lost to concurrent writers on every pass. Not an IngestError: the caller
 * classifies it as retryable (`internal`), and a retry decides again from a fresh read.
 */
export class IngestContendedError extends Error {
  constructor() {
    super("ingest contended");
    this.name = "IngestContendedError";
  }
}

/** Legs per transaction we accept: Revolut has 1 (card, transfer) or 2 (exchange, own transfer). */
export const MAX_LEGS = 20;
const TX_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const LEG_ID_RE = /^[A-Za-z0-9_-]{0,100}$/;
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface IngestResult {
  /** Legs seen in the transaction. */
  legs: number;
  /** Legs that were not stored before (all of them: the transaction was MISSING). */
  inserted: number;
  /** Stored legs that changed. */
  updated: number;
  /** Stored legs left as they were (same data, older data, or a blocked change). */
  unchanged: number;
  /** Changes refused by the transition table. */
  blocked: { regress: number; conflict: number; unknownIgnored: number };
  /** Legs without an account id (cannot be placed). */
  skipped: number;
  /** Frozen (matched, final) legs that received different money data or a different state. */
  frozenConflicts: number;
  /** True when the transaction had legs and none of them was stored before. */
  missing: boolean;
}

const MAX_PASSES = 3;
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * ISO-8601 instant WITH a zone (Z or an offset); fractions of any precision. A zone-less value is
 * refused: it would be read in whatever zone the runtime has.
 */
const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A Revolut timestamp as UTC ISO with milliseconds (toISOString), so stored values compare as
 * strings. Sub-millisecond digits are truncated (not rounded): two updates within the same
 * millisecond count as equal, and equal is "not older" in the transition table.
 */
export function normStamp(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const m = STAMP_RE.exec(raw.trim());
  if (!m) throw new IngestError("bad_timestamp");
  const frac = (m[2] ?? "").slice(0, 3).padEnd(3, "0");
  const zone = m[3] === "Z" ? "Z" : (m[3] as string);
  const ms = Date.parse(
    `${m[1] as string}${(m[1] as string).length === 16 ? ":00" : ""}.${frac}${zone}`,
  );
  if (Number.isNaN(ms)) throw new IngestError("bad_timestamp");
  return iso(ms);
}

type Val = string | number | null;

/**
 * Every column the ingest writes from the incoming transaction, in one place, so the INSERT, the
 * UPDATE, the stored-row SELECT and the "did anything change" test cannot drift apart.
 */
const WRITE_COLS = [
  "type",
  "request_id",
  "state",
  "amount_minor",
  "currency",
  "counterparty_name",
  "counterparty_iban",
  "reference",
  "description",
  "booked_at",
  "created_at",
  "updated_at",
  "completed_at",
  "fee_minor",
  "fee_currency",
  "balance_minor",
  "counterparty_ref",
  "counterparty_account_ref",
  "counterparty_account_type",
  "reason_code",
  "bill_amount_minor",
  "bill_currency",
  "card_last4",
  "merchant_name",
  "skipped_legs",
] as const;
type Col = (typeof WRITE_COLS)[number];
type Values = Record<Col, Val>;

/**
 * The fields matching and booking rely on. Once a row is FROZEN (final and matched, review S9)
 * the ingest keeps these exactly as they are, whatever Revolut says later. The balance after the
 * leg is not here: it is information, not something a match is built on.
 */
export const FROZEN_COLS: readonly Col[] = [
  "amount_minor",
  "currency",
  "counterparty_name",
  "counterparty_iban",
  "reference",
  "fee_minor",
  "fee_currency",
  "bill_amount_minor",
  "bill_currency",
  "counterparty_ref",
  "counterparty_account_ref",
];

interface StoredLeg extends Values {
  leg_id: string;
  match_status: string;
  is_final: number;
  state_conflict: number;
  live_matches: number;
}

/**
 * Review S9. A row is frozen when it has a live match or its match_status is not 'unmatched'.
 * The ingest only freezes FINAL rows: a pending row is not matched yet (only final states are
 * booked), and its amount can still legitimately change.
 */
export function isFrozen(row: {
  match_status: string;
  live_matches: number;
  is_final: number;
}): boolean {
  return row.is_final === 1 && (row.live_matches > 0 || row.match_status !== "unmatched");
}

interface PreparedLeg {
  leg: RevolutLeg;
  account: string;
}

const SELECT_STORED = `SELECT leg_id, match_status, is_final, state_conflict,
  (SELECT COUNT(*) FROM matches m WHERE m.bank_transaction_id = bank_transactions.id
     AND m.undone_at IS NULL) AS live_matches, ${WRITE_COLS.join(", ")}
  FROM bank_transactions WHERE connection_id = ?1 AND external_id = ?2`;

const colIndex = new Map<Col, number>(WRITE_COLS.map((c, i) => [c, i]));
const STATE_AT = (colIndex.get("state") as number) + 6;

const INSERT_SQL = `INSERT INTO bank_transactions
    (connection_id, bank_account_id, external_id, leg_id, ${WRITE_COLS.join(", ")},
     raw_state_changed_at, first_seen_at, last_event_at, source)
  VALUES (?1, (SELECT id FROM bank_accounts WHERE connection_id = ?1 AND external_id = ?2),
          ?3, ?4, ${WRITE_COLS.map((_, i) => `?${i + 5}`).join(", ")},
          ?${WRITE_COLS.length + 5}, ?${WRITE_COLS.length + 6}, ?${WRITE_COLS.length + 6},
          ?${WRITE_COLS.length + 7})
  ON CONFLICT (connection_id, external_id, leg_id) DO NOTHING`;

/**
 * Compare-and-swap UPDATE. Binds: 1 connection, 2 transaction, 3 leg, 4 stored state, 5 stored
 * updated_at, 6.. the values (WRITE_COLS order), then raw_state_changed_at, now, the conflict flag,
 * the stored match_status and the number of live matches that were read. The row is only written
 * while it is still in the state the decision was made on: a match made between our read and this
 * write makes the CAS lose, and the next pass decides again, now with the row frozen.
 */
const UPDATE_SQL = ((): string => {
  const n = WRITE_COLS.length;
  return `UPDATE bank_transactions SET
      ${WRITE_COLS.map((c, i) => `${c} = ?${i + 6}`).join(", ")},
      raw_state_changed_at = CASE WHEN state <> ?${STATE_AT} THEN ?${n + 6} ELSE raw_state_changed_at END,
      last_event_at = ?${n + 7},
      state_conflict = CASE WHEN ?${n + 8} = 1 THEN 1 ELSE state_conflict END
    WHERE connection_id = ?1 AND external_id = ?2 AND leg_id = ?3
      AND state = ?4 AND COALESCE(updated_at, '') = ?5 AND match_status = ?${n + 9}
      AND (SELECT COUNT(*) FROM matches m WHERE m.bank_transaction_id = bank_transactions.id
             AND m.undone_at IS NULL) = ?${n + 10}`;
})();

const SAFE_REF_RE = /^[A-Za-z0-9_-]{1,100}$/;
const safeRef = (v: string | undefined): string | null =>
  v !== undefined && SAFE_REF_RE.test(v) ? v : null;
const clip = (v: string | undefined, max: number): string | null =>
  v === undefined || v === "" ? null : v.slice(0, max);

export async function upsertTransaction(
  env: { DB: D1Database },
  connectionId: number,
  tx: RevolutTransaction,
  source: IngestSource,
  nowMs: number = Date.now(),
): Promise<IngestResult> {
  const db = env.DB;
  const result: IngestResult = {
    legs: tx.legs.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    blocked: { regress: 0, conflict: 0, unknownIgnored: 0 },
    skipped: 0,
    frozenConflicts: 0,
    missing: false,
  };
  // Ids go into SQL binds only, but they are also used to build gate paths elsewhere: strict.
  if (!TX_ID_RE.test(tx.id)) throw new IngestError("bad_transaction_id");
  if (tx.legs.length > MAX_LEGS) throw new IngestError("too_many_legs");
  const createdAt = normStamp(tx.createdAt);
  if (createdAt === null) throw new IngestError("bad_timestamp");
  const updatedAt = normStamp(tx.updatedAt);
  const completedAt = normStamp(tx.completedAt);
  const bookedAt = completedAt ?? createdAt;
  const now = iso(nowMs);

  const prepared: PreparedLeg[] = [];
  for (const leg of tx.legs) {
    if (leg.accountId === undefined || leg.accountId === "") {
      result.skipped++;
      continue;
    }
    if (!LEG_ID_RE.test(leg.legId) || !ACCOUNT_ID_RE.test(leg.accountId)) {
      throw new IngestError("bad_leg");
    }
    if (prepared.some((p) => p.leg.legId === leg.legId)) throw new IngestError("bad_leg");
    if (!Number.isSafeInteger(leg.amountMinor)) throw new IngestError("bad_amount");
    if (!/^[A-Z]{3}$/.test(leg.currency)) throw new IngestError("bad_currency");
    if (leg.feeMinor !== undefined && !Number.isSafeInteger(leg.feeMinor)) {
      throw new IngestError("bad_amount");
    }
    if (leg.balanceMinor !== undefined && !Number.isSafeInteger(leg.balanceMinor)) {
      throw new IngestError("bad_amount");
    }
    if (
      leg.billAmountMinor !== undefined &&
      (!Number.isSafeInteger(leg.billAmountMinor) ||
        leg.billCurrency === undefined ||
        !/^[A-Z]{3}$/.test(leg.billCurrency))
    ) {
      throw new IngestError("bad_amount");
    }
    prepared.push({ leg, account: leg.accountId });
  }
  if (prepared.length === 0) return result;

  // A leg that carries only a counterparty id gets the IBAN a lookup cached earlier (review S6).
  const cachedIbans = new Map<string, string | null>();
  for (const { leg } of prepared) {
    const cp = leg.counterparty;
    if (cp?.id === undefined || compactIban(cp.iban) !== null) continue;
    const ref = safeRef(cp.id);
    if (ref === null) continue;
    const key = `${ref}\n${cp.accountId ?? ""}`;
    if (!cachedIbans.has(key)) {
      cachedIbans.set(key, await cachedCounterpartyIban(db, connectionId, ref, cp.accountId));
    }
  }

  const insertedLegs = new Set<string>();
  let finalCounts = { updated: 0, unchanged: 0 };
  let blocked = { regress: 0, conflict: 0, unknownIgnored: 0 };
  let frozenConflicts = 0;
  let settled = false;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const stored = (await db.prepare(SELECT_STORED).bind(connectionId, tx.id).all<StoredLeg>())
      .results;
    const byLeg = new Map(stored.map((s) => [s.leg_id, s]));

    const statements: D1PreparedStatement[] = [];
    const changedLegs = new Map<string, boolean>();
    // kind per statement after the account inserts: how to read its meta.changes.
    const kinds: ("account" | "insert" | "cas" | "touch" | "noop")[] = [];
    const legOf: (string | null)[] = [];
    const counts = { updated: 0, unchanged: 0 };
    blocked = { regress: 0, conflict: 0, unknownIgnored: 0 };
    frozenConflicts = 0;

    for (const account of new Set(prepared.map((p) => p.account))) {
      const first = prepared.find((p) => p.account === account) as PreparedLeg;
      statements.push(
        db
          .prepare(
            `INSERT INTO bank_accounts (connection_id, external_id, name, currency, is_active, created_at, updated_at)
             VALUES (?1, ?2, 'Revolut account', ?3, 1, ?4, ?4)
             ON CONFLICT (connection_id, external_id) DO NOTHING`,
          )
          .bind(connectionId, account, first.leg.currency, now),
      );
      kinds.push("account");
      legOf.push(null);
    }

    for (const { leg, account } of prepared) {
      const cur = byLeg.get(leg.legId);
      const decision = decideLegUpdate(
        cur
          ? {
              state: cur.state as StoredBankTxState,
              updatedAtMs: cur.updated_at === null ? null : Date.parse(cur.updated_at as string),
            }
          : null,
        { state: tx.state, updatedAtMs: updatedAt === null ? null : Date.parse(updatedAt) },
      );
      const cp = leg.counterparty;
      const cpRef = safeRef(cp?.id);
      const cached =
        cp?.id !== undefined
          ? (cachedIbans.get(`${cpRef ?? ""}\n${cp.accountId ?? ""}`) ?? null)
          : null;
      const incoming: Values = {
        type: tx.type,
        request_id: tx.requestId ?? null,
        state: tx.state,
        amount_minor: leg.amountMinor,
        currency: leg.currency,
        counterparty_name: cp?.name ?? tx.merchant?.name ?? null,
        // The stored IBAN is kept when this delivery has none (a lookup may have filled it).
        counterparty_iban:
          compactIban(cp?.iban) ??
          cached ??
          (cur ? (cur.counterparty_iban as string | null) : null),
        reference: tx.reference ?? null,
        description: leg.description ?? null,
        booked_at: bookedAt,
        created_at: createdAt,
        updated_at: updatedAt,
        completed_at: completedAt,
        fee_minor: leg.feeMinor ?? null,
        fee_currency: leg.feeMinor === undefined ? null : leg.currency,
        balance_minor: leg.balanceMinor ?? null,
        counterparty_ref: cpRef,
        counterparty_account_ref: safeRef(cp?.accountId),
        counterparty_account_type: clip(cp?.accountType, 20),
        reason_code: clip(tx.reasonCode, 60),
        bill_amount_minor: leg.billAmountMinor ?? null,
        bill_currency: leg.billAmountMinor === undefined ? null : (leg.billCurrency ?? null),
        card_last4: leg.card?.last4 ?? tx.card?.last4 ?? null,
        merchant_name: clip(tx.merchant?.name, 200),
        skipped_legs: result.skipped,
      };
      if (!cur) {
        statements.push(
          db
            .prepare(INSERT_SQL)
            .bind(
              connectionId,
              account,
              tx.id,
              leg.legId,
              ...WRITE_COLS.map((c) => incoming[c]),
              updatedAt ?? createdAt,
              now,
              source,
            ),
        );
        kinds.push("insert");
        legOf.push(leg.legId);
        continue;
      }
      const frozen = isFrozen(cur);
      if (decision.apply) {
        // Review S9: a frozen row keeps the fields a match was built on. If Revolut now says
        // something different (or the state moved, completed -> reverted), the row is flagged.
        const values: Values = { ...incoming };
        let conflict = false;
        if (frozen) {
          for (const c of FROZEN_COLS) {
            const was = cur[c];
            if (incoming[c] !== null && was !== null && incoming[c] !== was) conflict = true;
            values[c] = was;
          }
          if (cur.state !== tx.state) conflict = true;
          // The booking date stays too, but a late `completed_at` alone is not a conflict.
          values.booked_at = cur.booked_at;
          if (conflict) frozenConflicts++;
        }
        const flagged = conflict && cur.state_conflict === 0;
        const changed = flagged || WRITE_COLS.some((c) => cur[c] !== values[c]);
        changedLegs.set(leg.legId, changed);
        statements.push(
          db
            .prepare(UPDATE_SQL)
            .bind(
              connectionId,
              tx.id,
              leg.legId,
              cur.state,
              (cur.updated_at as string | null) ?? "",
              ...WRITE_COLS.map((c) => values[c]),
              updatedAt ?? createdAt,
              now,
              conflict ? 1 : 0,
              cur.match_status,
              cur.live_matches,
            ),
        );
        kinds.push("cas");
        legOf.push(leg.legId);
        continue;
      }
      // Not applied: note that the event was seen; a refused state change flags the row (S7).
      const refused =
        decision.reason === "regress_blocked" || decision.reason === "conflict_blocked";
      statements.push(
        db
          .prepare(
            `UPDATE bank_transactions SET last_event_at = ?4,
               state_conflict = CASE WHEN ?5 = 1 THEN 1 ELSE state_conflict END
             WHERE connection_id = ?1 AND external_id = ?2 AND leg_id = ?3`,
          )
          .bind(connectionId, tx.id, leg.legId, now, refused ? 1 : 0),
      );
      kinds.push("touch");
      legOf.push(leg.legId);
      if (refused && cur.state_conflict === 0) counts.updated++;
      else counts.unchanged++;
      if (decision.reason === "regress_blocked") blocked.regress++;
      else if (decision.reason === "conflict_blocked") blocked.conflict++;
      else if (decision.reason === "unknown_ignored") blocked.unknownIgnored++;
    }

    const out = await db.batch(statements);
    let lost = false;
    out.forEach((r, i) => {
      const k = kinds[i];
      const leg = legOf[i] ?? "";
      if (k === "insert") {
        if (r.meta.changes === 1) insertedLegs.add(leg);
        else lost = true; // somebody inserted it meanwhile: decide again from a fresh read
      } else if (k === "cas") {
        if (r.meta.changes !== 1) lost = true;
        else if (!insertedLegs.has(leg)) {
          // The row is rewritten either way (last_event_at); it only counts as updated when
          // something in it really differs.
          if (changedLegs.get(leg) === true) counts.updated++;
          else counts.unchanged++;
        }
      }
    });
    finalCounts = counts;
    if (!lost) {
      settled = true;
      break;
    }
  }
  // Still losing after MAX_PASSES: the write did not happen. Never report it as done.
  if (!settled) throw new IngestContendedError();

  result.inserted = insertedLegs.size;
  result.updated = finalCounts.updated;
  result.unchanged = finalCounts.unchanged;
  // A leg that was inserted in an earlier pass shows up as stored (updated or unchanged) later.
  result.blocked = blocked;
  result.frozenConflicts = frozenConflicts;
  result.missing = insertedLegs.size === prepared.length;
  return result;
}
