/**
 * The booking outbox (task M7c, ADR 0044): one row per write to Exact, stored WITH its full
 * sanitised payload and idempotency key before any network call. Every state change of a row, its
 * audit row and the matching change of `matches.exact_state` are ONE db.batch (ADR 0013).
 *
 * Atomicity inside a batch: each statement is guarded by `changes() = 1` of the statement before
 * it, so a lost race (the row is no longer in the state we expected) turns the rest into no-ops and
 * the caller sees `false`. `matches.exact_state` only moves through conditional UPDATEs, and
 * migration 0023 adds a trigger that refuses illegal transitions.
 */
import { auditStatement } from "../db/audit";
import { claimStatement } from "../matching/store";

export const OUTBOX_STATUSES = [
  "pending",
  "sending",
  "sent_unverified",
  "verified",
  "failed",
  "outcome_unknown",
  "manual_required",
  "waiting_for_bank_line",
  "resolved_manually",
  "given_up",
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
export const TERMINAL_STATUSES: readonly OutboxStatus[] = [
  "verified",
  "resolved_manually",
  "given_up",
];
export type OutboxKind = "bank_entry" | "matchset";

export interface OutboxRow {
  id: number;
  match_id: number;
  division_id: number;
  journal_code: string | null;
  kind: OutboxKind;
  idempotency_key: string;
  payload_json: string;
  payload_hash: string;
  status: OutboxStatus;
  attempts: number;
  last_error_code: string | null;
  exact_ref: string | null;
  needs_probe: number;
  next_attempt_at: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  /** The booking mode when the row was claimed (1 = this app creates the bank entries); null = legacy. */
  creates_bank_entries: number | null;
}

export const OUTBOX_COLUMNS = `id, match_id, division_id, journal_code, kind, idempotency_key, payload_json,
  payload_hash, status, attempts, last_error_code, exact_ref, needs_probe, next_attempt_at, claimed_at,
  lease_expires_at, created_at, updated_at, creates_bank_entries`;

/** Lease of a row while an executor works on it. A POST in flight longer than this is "unknown". */
export const LEASE_MS = 10 * 60_000;

const CODE_RE = /^[a-z0-9_]{1,64}$/;
/** A code is stored only if it is a plain machine word: nothing from Exact or the bank. */
export const safeCode = (code: string): string => (CODE_RE.test(code) ? code : "unknown_error");

export type ClaimResult = "claimed" | "lost";

export interface NewOutboxRow {
  matchId: number;
  divisionId: number;
  journalCode: string | null;
  kind: OutboxKind;
  idempotencyKey: string;
  payloadJson: string;
  payloadHash: string;
  /** 'pending' to book, 'manual_required' when planning already failed (code in `errorCode`). */
  status: "pending" | "manual_required" | "waiting_for_bank_line";
  errorCode: string | null;
  nowIso: string;
  /** The booking mode in force at the claim (stored on the row; re-checked before every POST). */
  createsBankEntries: boolean;
}

/** The previous statement of the batch changed exactly one row. */
export const GUARD = "changes() = 1";

/**
 * The claim (ADR 0042 "Undo window"): `not_booked` becomes 'booking' (or 'manual_required' when the
 * plan already failed) through the conditional UPDATE only, so Undo and booking cannot both win.
 * The outbox row (payload and key), the idempotency key and the audit row are written in the SAME
 * batch, so nothing is ever sent without a stored row. `claimed` only for the one winner.
 */
export async function claimAndEnqueue(db: D1Database, r: NewOutboxRow): Promise<ClaimResult> {
  const initial = r.status === "manual_required" ? "manual_required" : "booking";
  const code = r.errorCode === null ? null : safeCode(r.errorCode);
  const out = await db.batch([
    claimStatement(db, r.matchId, initial, code),
    db
      .prepare(
        `INSERT INTO exact_write_outbox (match_id, division_id, journal_code, kind, idempotency_key,
           payload_json, payload_hash, status, last_error_code, needs_probe, created_at, updated_at,
           creates_bank_entries)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10, ?11 WHERE ${GUARD}`,
      )
      .bind(
        r.matchId,
        r.divisionId,
        r.journalCode,
        r.kind,
        r.idempotencyKey,
        r.payloadJson,
        r.payloadHash,
        r.status,
        code,
        r.nowIso,
        r.createsBankEntries ? 1 : 0,
      ),
    auditStatement(
      db,
      {
        actorEmail: "system",
        action: initial === "booking" ? "booking.claimed" : "booking.manual_required",
        entity: "match",
        entityId: r.matchId,
        before: { exactState: "not_booked" },
        after: {
          exactState: initial,
          kind: r.kind,
          outboxStatus: r.status,
          createsBankEntries: r.createsBankEntries,
          ...(code !== null ? { code } : {}),
        },
      },
      { sql: GUARD, binds: [] },
    ),
    // The idempotency key is stored BEFORE any call (CLAUDE.md 5): same batch as the claim.
    db
      .prepare(
        `INSERT INTO idempotency_keys (scope, key) SELECT ?1, ?2 WHERE ${GUARD}
         ON CONFLICT (scope, key) DO NOTHING`,
      )
      .bind(`exact.write.${r.kind}`, r.idempotencyKey),
  ]);
  return (out[0]?.meta.changes ?? 0) === 1 ? "claimed" : "lost";
}

/**
 * Takes the lease of a row (exclusive: a second executor, or a zombie whose lease ran out, gets
 * null). Returns the lease token (= claimed_at) on success.
 */
export async function leaseRow(
  db: D1Database,
  rowId: number,
  statuses: readonly OutboxStatus[],
  nowMs: number,
): Promise<string | null> {
  const token = new Date(nowMs).toISOString();
  const out = await db
    .prepare(
      `UPDATE exact_write_outbox SET claimed_at = ?2, lease_expires_at = ?3
       WHERE id = ?1 AND status IN (${inList(statuses)})
         AND (lease_expires_at IS NULL OR lease_expires_at < ?2)`,
    )
    .bind(rowId, token, new Date(nowMs + LEASE_MS).toISOString())
    .run();
  return (out.meta.changes ?? 0) === 1 ? token : null;
}

export interface MatchMove {
  from: string;
  to: string;
  /** Machine code stored in matches.exact_note (null clears it). */
  note: string | null;
  /** Set together with 'matched_in_exact'. */
  bookedAt?: string;
  /** Set together with 'matched_in_exact' by an admin's `booked_manually` (N7). */
  manuallyBooked?: boolean;
}

export interface Transition {
  rowId: number;
  matchId: number;
  /** The row must be in one of these. */
  from: readonly OutboxStatus[];
  to: OutboxStatus;
  /** Lease token the executor holds; null for admin changes (no lease check). */
  token: string | null;
  nowIso: string;
  /** undefined keeps the stored value; null clears. */
  errorCode?: string | null;
  exactRef?: string | null;
  attemptsDelta?: number;
  needsProbe?: boolean;
  nextAttemptAt?: string | null;
  payload?: { json: string; hash: string; journalCode: string | null };
  /** Keep the lease (the executor continues with the row) instead of releasing it. */
  keepLease?: boolean;
  /** An admin's decision (retry): recorded on the row; the database refuses a retry without it. */
  adminResolved?: { by: string; at: string };
  match?: MatchMove;
  actor: string;
  action: string;
  /** Codes and counts only (never payloads, IBANs or Exact text). */
  audit: Record<string, unknown>;
  /** Run only when the transition applied; the first statement must be guarded by `GUARD`. */
  after?: (db: D1Database) => D1PreparedStatement[];
}

function inList(xs: readonly OutboxStatus[]): string {
  for (const x of xs) {
    if (!(OUTBOX_STATUSES as readonly string[]).includes(x)) throw new RangeError("bad status");
  }
  return xs.map((x) => `'${x}'`).join(", ");
}

/**
 * One atomic transition of an outbox row (plus its audit row, an optional change of the match and
 * optional follow-up statements). True when everything applied; false when the row was no longer in
 * `from` (a lost race) or its lease belongs to someone else.
 */
export async function transition(db: D1Database, t: Transition): Promise<boolean> {
  const binds: (string | number | null)[] = [t.rowId, t.to, t.nowIso];
  const set: string[] = ["status = ?2", "updated_at = ?3"];
  const add = (column: string, value: string | number | null): void => {
    binds.push(value);
    set.push(`${column} = ?${binds.length}`);
  };
  if (t.errorCode !== undefined) {
    add("last_error_code", t.errorCode === null ? null : safeCode(t.errorCode));
  }
  if (t.exactRef !== undefined) add("exact_ref", t.exactRef);
  if (t.attemptsDelta !== undefined) {
    set.push(`attempts = MAX(0, attempts + ${Math.trunc(t.attemptsDelta)})`);
  }
  if (t.needsProbe !== undefined) add("needs_probe", t.needsProbe ? 1 : 0);
  if (t.nextAttemptAt !== undefined) add("next_attempt_at", t.nextAttemptAt);
  if (t.payload !== undefined) {
    add("payload_json", t.payload.json);
    add("payload_hash", t.payload.hash);
    add("journal_code", t.payload.journalCode);
  }
  if (t.adminResolved !== undefined) {
    add("admin_resolved_by", t.adminResolved.by);
    add("admin_resolved_at", t.adminResolved.at);
  }
  if (t.keepLease !== true) set.push("claimed_at = NULL", "lease_expires_at = NULL");
  const nonce = crypto.randomUUID();
  add("op_nonce", nonce);
  let where = `id = ?1 AND status IN (${inList(t.from)})`;
  if (t.token !== null) {
    binds.push(t.token);
    where += ` AND claimed_at = ?${binds.length}`;
  }
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE exact_write_outbox SET ${set.join(", ")} WHERE ${where}`).bind(...binds),
    auditStatement(
      db,
      {
        actorEmail: t.actor,
        action: t.action,
        entity: "exact_write_outbox",
        entityId: t.rowId,
        after: { matchId: t.matchId, status: t.to, ...t.audit },
      },
      { sql: GUARD, binds: [] },
    ),
  ];
  const moveIndex = t.match === undefined ? -1 : stmts.length;
  if (t.match !== undefined) {
    stmts.push(
      db
        .prepare(
          `UPDATE matches SET exact_state = ?2, exact_note = ?3, booked_at = COALESCE(?4, booked_at),
             manually_booked = CASE WHEN ?6 = 1 THEN 1 ELSE manually_booked END, op_nonce = ?7
           WHERE id = ?1 AND exact_state = ?5 AND undone_at IS NULL AND ${GUARD}`,
        )
        .bind(
          t.matchId,
          t.match.to,
          t.match.note === null ? null : safeCode(t.match.note),
          t.match.bookedAt ?? null,
          t.match.from,
          t.match.manuallyBooked === true ? 1 : 0,
          nonce,
        ),
    );
  }
  if (t.after !== undefined) stmts.push(...t.after(db));
  if (t.match !== undefined) {
    // LAST statement (an INSERT that adds nothing would reset changes() for the statements after
    // it): the row moved (its nonce is ours) but the match did not take our nonce, so it was not
    // where the transition expected it. The insert fires the trigger of migration 0024, which
    // raises `batch_guard:match_out_of_step` and aborts the WHOLE batch: a row can never change
    // state without its match, and the error is a code, not text matching on SQLite internals.
    stmts.push(
      db
        .prepare(
          `INSERT INTO batch_guard (code)
           SELECT 'match_out_of_step'
           WHERE EXISTS (SELECT 1 FROM exact_write_outbox WHERE id = ?1 AND op_nonce = ?2)
             AND NOT EXISTS (SELECT 1 FROM matches WHERE id = ?3 AND op_nonce = ?2)`,
        )
        .bind(t.rowId, nonce, t.matchId),
    );
  }
  let out: D1Result[];
  try {
    out = await db.batch(stmts);
  } catch (e) {
    // The out-of-step guard rolled the batch back: nothing changed, the caller lost a race.
    if (isOutOfStep(e)) {
      console.error("booking: match state out of step", t.matchId);
      return false;
    }
    throw e;
  }
  if ((out[0]?.meta.changes ?? 0) !== 1) return false;
  if (moveIndex >= 0 && (out[moveIndex]?.meta.changes ?? 0) !== 1) {
    // Unreachable: the guard statement above aborts the batch in this case.
    console.error("booking: match state out of step", t.matchId);
    return false;
  }
  return true;
}

/** True for the error the batch guard raises (migration 0024): the message or its cause carries the code. */
export function isOutOfStep(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String(err.cause ?? "")}` : String(err);
  return /batch_guard:match_out_of_step/.test(msg);
}

/** Marks the idempotency key of a finished write completed (codes only in the stored result). */
export const completeKeyStatement = (
  db: D1Database,
  kind: OutboxKind,
  key: string,
  result: string,
  nowIso: string,
): D1PreparedStatement =>
  db
    .prepare(
      `UPDATE idempotency_keys SET status = 'completed', result_json = ?3, completed_at = ?4
       WHERE scope = ?1 AND key = ?2 AND status = 'pending' AND ${GUARD}`,
    )
    .bind(`exact.write.${kind}`, key, JSON.stringify({ result }), nowIso);

export async function loadRow(db: D1Database, id: number): Promise<OutboxRow | null> {
  return db
    .prepare(`SELECT ${OUTBOX_COLUMNS} FROM exact_write_outbox WHERE id = ?1`)
    .bind(id)
    .first<OutboxRow>();
}
