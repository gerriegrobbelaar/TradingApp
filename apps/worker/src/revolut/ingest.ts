/**
 * Ingest of Revolut transactions into bank_transactions (Phase 5, ADR 0032).
 *
 * One Revolut transaction has one or more LEGS (a transfer between own accounts, an exchange);
 * each leg is one row, unique on (connection_id, external_id, leg_id). The same transaction
 * arrives from the webhook queue, the poll and the backfill, in any order, so the write is an
 * idempotent upsert whose state only moves forward (packages/core `decideLegUpdate`, ADR 0032):
 * a final state is never reopened by a stale event, an unknown state never replaces a known one,
 * completed -> reverted is the one legal final-to-final change.
 *
 * The decision is made in TypeScript from the stored rows and applied as a compare-and-swap
 * (the UPDATE only matches the state and `updated_at` that were decided on), so two writers racing
 * on one transaction cannot overwrite each other; a lost race is retried from a fresh read. All
 * legs of a transaction and the account rows they need are ONE db.batch (one D1 transaction).
 *
 * Amounts are the leg's signed minor units and currency exactly as Revolut gives them. The
 * counterparty IBAN is stored in full (matching needs it) and never logged or returned. Ingestion
 * is not a write to Revolut or Exact, so there is no audit row per transaction; the sync jobs
 * write one summary audit row per run.
 */
import { compactIban, decideLegUpdate, type StoredBankTxState } from "@camelthorn/core";
import type { RevolutLeg, RevolutTransaction } from "@camelthorn/revolut";

export type IngestSource = "webhook" | "poll" | "backfill";

export class IngestError extends Error {
  constructor(readonly code: "bad_timestamp" | "bad_amount" | "bad_currency") {
    super(code);
    this.name = "IngestError";
  }
}

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
  /** True when the transaction had legs and none of them was stored before. */
  missing: boolean;
}

const MAX_PASSES = 3;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A Revolut timestamp as UTC ISO with milliseconds, so stored values compare as strings. */
function normStamp(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new IngestError("bad_timestamp");
  return iso(ms);
}

interface StoredLeg {
  leg_id: string;
  state: StoredBankTxState;
  updated_at: string | null;
  type: string | null;
  request_id: string | null;
  amount_minor: number;
  currency: string;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  reference: string | null;
  description: string | null;
  booked_at: string;
  created_at: string;
  completed_at: string | null;
}

interface PreparedLeg {
  leg: RevolutLeg;
  account: string;
}

const COLS = `type, request_id, state, amount_minor, currency, counterparty_name, counterparty_iban,
  reference, description, booked_at, created_at, updated_at, completed_at`;

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
    missing: false,
  };
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
    if (!Number.isSafeInteger(leg.amountMinor)) throw new IngestError("bad_amount");
    if (!/^[A-Z]{3}$/.test(leg.currency)) throw new IngestError("bad_currency");
    prepared.push({ leg, account: leg.accountId });
  }
  if (prepared.length === 0) return result;

  const insertedLegs = new Set<string>();
  let finalCounts = { updated: 0, unchanged: 0 };
  let blocked = { regress: 0, conflict: 0, unknownIgnored: 0 };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const stored = (
      await db
        .prepare(
          `SELECT leg_id, state, updated_at, type, request_id, amount_minor, currency,
                  counterparty_name, counterparty_iban, reference, description, booked_at,
                  created_at, completed_at
           FROM bank_transactions WHERE connection_id = ?1 AND external_id = ?2`,
        )
        .bind(connectionId, tx.id)
        .all<StoredLeg>()
    ).results;
    const byLeg = new Map(stored.map((s) => [s.leg_id, s]));

    const statements: D1PreparedStatement[] = [];
    const changedLegs = new Map<string, boolean>();
    // kind per statement after the account inserts: how to read its meta.changes.
    const kinds: ("account" | "insert" | "cas" | "touch" | "noop")[] = [];
    const legOf: (string | null)[] = [];
    const counts = { updated: 0, unchanged: 0 };
    blocked = { regress: 0, conflict: 0, unknownIgnored: 0 };

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
              state: cur.state,
              updatedAtMs: cur.updated_at === null ? null : Date.parse(cur.updated_at),
            }
          : null,
        { state: tx.state, updatedAtMs: updatedAt === null ? null : Date.parse(updatedAt) },
      );
      const values = [
        tx.type,
        tx.requestId ?? null,
        tx.state,
        leg.amountMinor,
        leg.currency,
        leg.counterparty?.name ?? tx.merchant?.name ?? null,
        compactIban(leg.counterparty?.iban),
        tx.reference ?? null,
        leg.description ?? null,
        bookedAt,
        createdAt,
        updatedAt,
        completedAt,
      ];
      if (!cur) {
        statements.push(
          db
            .prepare(
              `INSERT INTO bank_transactions
                 (connection_id, bank_account_id, external_id, leg_id, ${COLS},
                  raw_state_changed_at, first_seen_at, last_event_at, source)
               VALUES (?1, (SELECT id FROM bank_accounts WHERE connection_id = ?1 AND external_id = ?2),
                       ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19, ?20)
               ON CONFLICT (connection_id, external_id, leg_id) DO NOTHING`,
            )
            .bind(
              connectionId,
              account,
              tx.id,
              leg.legId,
              ...values,
              updatedAt ?? createdAt,
              now,
              source,
            ),
        );
        kinds.push("insert");
        legOf.push(leg.legId);
        continue;
      }
      if (decision.apply) {
        const changed =
          cur.state !== tx.state ||
          cur.updated_at !== updatedAt ||
          cur.type !== tx.type ||
          cur.request_id !== (tx.requestId ?? null) ||
          cur.amount_minor !== leg.amountMinor ||
          cur.currency !== leg.currency ||
          cur.counterparty_name !== (values[5] as string | null) ||
          cur.counterparty_iban !== (values[6] as string | null) ||
          cur.reference !== (tx.reference ?? null) ||
          cur.description !== (leg.description ?? null) ||
          cur.booked_at !== bookedAt ||
          cur.created_at !== createdAt ||
          cur.completed_at !== completedAt;
        changedLegs.set(leg.legId, changed);
        statements.push(
          db
            .prepare(
              `UPDATE bank_transactions SET
                 type = ?5, request_id = ?6, state = ?7, amount_minor = ?8, currency = ?9,
                 counterparty_name = ?10, counterparty_iban = ?11, reference = ?12,
                 description = ?13, booked_at = ?14, created_at = ?15, updated_at = ?16,
                 completed_at = ?17,
                 raw_state_changed_at = CASE WHEN state <> ?7 THEN ?18 ELSE raw_state_changed_at END,
                 last_event_at = ?19
               WHERE connection_id = ?1 AND external_id = ?2 AND leg_id = ?3
                 AND state = ?4 AND COALESCE(updated_at, '') = ?20`,
            )
            .bind(
              connectionId,
              tx.id,
              leg.legId,
              cur.state,
              ...values,
              updatedAt ?? createdAt,
              now,
              cur.updated_at ?? "",
            ),
        );
        kinds.push("cas");
        legOf.push(leg.legId);
        continue;
      }
      // Not applied: only note that the event was seen.
      statements.push(
        db
          .prepare(
            `UPDATE bank_transactions SET last_event_at = ?4
             WHERE connection_id = ?1 AND external_id = ?2 AND leg_id = ?3`,
          )
          .bind(connectionId, tx.id, leg.legId, now),
      );
      kinds.push("touch");
      legOf.push(leg.legId);
      counts.unchanged++;
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
    if (!lost) break;
  }

  result.inserted = insertedLegs.size;
  result.updated = finalCounts.updated;
  result.unchanged = finalCounts.unchanged;
  // A leg that was inserted in an earlier pass shows up as stored (updated or unchanged) later.
  result.blocked = blocked;
  result.missing = insertedLegs.size === prepared.length;
  return result;
}
