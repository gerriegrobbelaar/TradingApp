/**
 * One state move of a payment request or batch, as the statements of a single `db.batch` (ADR 0013,
 * ADR 0049): the conditional UPDATE, an append-only event row and the audit row. The event and the
 * audit row carry the same guard, so if the UPDATE did not happen (the row moved, the request
 * expired) NEITHER is written, and the audit statement's `meta.changes` (1/0) says which.
 */
import type { PaymentStatus } from "@camelthorn/core";
import { auditStatement } from "../db/audit";

export type SubjectKind = "payment" | "batch";

export const TABLE: Record<SubjectKind, "payments" | "payment_batches"> = {
  payment: "payments",
  batch: "payment_batches",
};
export const EVENT_COL: Record<SubjectKind, "payment_id" | "batch_id"> = {
  payment: "payment_id",
  batch: "batch_id",
};

export interface Move {
  kind: SubjectKind;
  id: number;
  /** Audit entity id: the request id (a UUID), known before the row exists. */
  requestId: string;
  from: PaymentStatus;
  to: PaymentStatus;
  actor: string;
  /** Stable code stored as status_reason and in the event. */
  code: string;
  nowIso: string;
  /** The move only happens while the request has not expired. */
  notExpired?: boolean;
  /** Extra columns written by the same UPDATE (names are code constants, never request data). */
  set?: Record<string, string | number | null>;
  audit: { action: string; before?: unknown; after?: unknown };
}

const SET_COL = /^[a-z_]+$/;

/** [update, event, audit, ...children]; the audit statement is at index 2. */
export function moveStatements(db: D1Database, m: Move): D1PreparedStatement[] {
  const table = TABLE[m.kind];
  const sets = Object.entries(m.set ?? {});
  for (const [c] of sets) if (!SET_COL.test(c)) throw new Error("bad column name");
  // ?1 id, ?2 from, ?3 to, ?4 code, ?5 now, ?6 actor, ?7 now (for the expiry), then the extra columns
  const extra = sets.map(([c], i) => `${c} = ?${8 + i}`).join(", ");
  // ?6 (the actor) is only referenced so the numbering has no gap; ?7 is the expiry cut-off or NULL.
  const update = db
    .prepare(
      `UPDATE ${table} SET status = ?3, status_reason = ?4, updated_at = ?5${extra ? `, ${extra}` : ""}
        WHERE id = ?1 AND status = ?2 AND ?6 IS NOT NULL AND (?7 IS NULL OR expires_at > ?7)`,
    )
    .bind(
      m.id,
      m.from,
      m.to,
      m.code,
      m.nowIso,
      m.actor,
      m.notExpired ? m.nowIso : null,
      ...sets.map(([, v]) => v),
    );
  const guard = `EXISTS (SELECT 1 FROM ${table} WHERE id = ?7 AND status = ?8 AND updated_at = ?9 AND status_reason = ?10)`;
  const event = db
    .prepare(
      `INSERT INTO payment_events (${EVENT_COL[m.kind]}, from_status, to_status, code, actor, at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ?1 AND status = ?3 AND updated_at = ?6 AND status_reason = ?4)`,
    )
    .bind(m.id, m.from, m.to, m.code, m.actor, m.nowIso);
  const audit = auditStatement(
    db,
    {
      actorEmail: m.actor,
      action: m.audit.action,
      entity: m.kind === "payment" ? "payment" : "payment_batch",
      entityId: m.requestId,
      before: { status: m.from, ...(m.audit.before as object | undefined) },
      after: { status: m.to, code: m.code, ...(m.audit.after as object | undefined) },
    },
    { sql: guard, binds: [m.id, m.to, m.nowIso, m.code] },
  );
  return [update, event, audit];
}

/**
 * The items of a batch follow it (the database insists: payments_guard_batch_item). Run AFTER the
 * batch's own move. One UPDATE and one event row per item, guarded by the batch having arrived.
 */
export function childMoveStatements(
  db: D1Database,
  m: Pick<Move, "id" | "from" | "to" | "code" | "nowIso" | "actor">,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE payments SET status = ?3, status_reason = ?4, updated_at = ?5
          WHERE batch_id = ?1 AND status = ?2
            AND (SELECT status FROM payment_batches WHERE id = ?1) = ?3`,
      )
      .bind(m.id, m.from, m.to, m.code, m.nowIso),
    db
      .prepare(
        `INSERT INTO payment_events (payment_id, from_status, to_status, code, actor, at)
         SELECT id, ?2, ?3, ?4, ?5, ?6 FROM payments
          WHERE batch_id = ?1 AND status = ?3 AND updated_at = ?6 AND status_reason = ?4`,
      )
      .bind(m.id, m.from, m.to, m.code, m.actor, m.nowIso),
  ];
}

/** The database's own refusal codes ('payment_err:<code>'), or null for any other error. */
export function dbErrorCode(err: unknown): string | null {
  let e: unknown = err;
  for (let i = 0; i < 4 && e !== undefined && e !== null; i++) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = /payment_err:([a-z_]+)/.exec(msg);
    if (m) return m[1] ?? null;
    if (/UNIQUE constraint failed: payments\.open_item_id/.test(msg)) return "already_in_request";
    if (
      /UNIQUE constraint failed: (payments|payment_batches)\.(requested_by|request_id)/.test(msg)
    ) {
      return "client_key_reused";
    }
    e = e instanceof Error ? e.cause : undefined;
  }
  return null;
}
