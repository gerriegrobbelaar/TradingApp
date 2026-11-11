/**
 * ECB rate conflicts (Phase 6 review S9, ADR 0039). The importer never overwrites a stored rate;
 * when the ECB later shows a different value for a stored (currency, date) it records a conflict
 * here (in the same batch as its `fx.rate_conflict` audit row). An admin resolves it:
 *
 *  - `kept`      the stored rate stays; the conflict is marked resolved.
 *  - `accepted`  the stored rate is replaced by the ECB value. The replacement, its audit row
 *                (before/after) and the resolved mark are ONE D1 batch (ADR 0013), each statement
 *                guarded by the same "still unresolved and the rate is still what we read" test,
 *                so either all three happen or none.
 *
 * Resolving the same way twice changes nothing and audits nothing; resolving the other way is
 * refused (409). A NEW ECB value for the same date is a new conflict (the importer's upsert is
 * keyed on (currency, date, ECB value)); the same value is not re-opened after it was resolved.
 */
import type { FxConflictDto } from "@camelthorn/core";
import { auditStatement } from "../db/audit";

export interface ConflictRow {
  id: number;
  currency: string;
  rate_date: string;
  stored_rate: string;
  ecb_rate: string;
  first_seen_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: "kept" | "accepted" | null;
}

export const toConflictDto = (r: ConflictRow): FxConflictDto => ({
  id: r.id,
  currency: r.currency,
  rateDate: r.rate_date,
  storedRate: r.stored_rate,
  ecbRate: r.ecb_rate,
  firstSeenAt: r.first_seen_at,
  resolved: r.resolved_at !== null,
  resolvedAt: r.resolved_at,
  resolvedBy: r.resolved_by,
  resolution: r.resolution,
});

export const CONFLICT_COLUMNS =
  "id, currency, rate_date, stored_rate, ecb_rate, first_seen_at, resolved_at, resolved_by, resolution";

/** How many conflicts are unresolved (partial index idx_fx_rate_conflicts_open). */
export async function unresolvedConflictCount(db: D1Database): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM fx_rate_conflicts WHERE resolved_at IS NULL")
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * The importer's write: records a conflict, idempotent. The same (currency, date, ECB value) is
 * one row. If that row was resolved against another stored rate (the rate changed since, for
 * example after an accepted value), it is opened again; resolved against the same stored rate it
 * stays resolved.
 */
export function upsertConflictStatement(
  db: D1Database,
  c: { currency: string; date: string; stored: string; ecb: string },
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO fx_rate_conflicts (currency, rate_date, stored_rate, ecb_rate, first_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (currency, rate_date, ecb_rate) DO UPDATE SET
         stored_rate = excluded.stored_rate, first_seen_at = excluded.first_seen_at,
         resolved_at = NULL, resolved_by = NULL, resolution = NULL
       WHERE fx_rate_conflicts.resolved_at IS NOT NULL
         AND fx_rate_conflicts.stored_rate <> excluded.stored_rate`,
    )
    .bind(c.currency, c.date, c.stored, c.ecb, nowIso);
}

export type ResolveOutcome =
  | { kind: "resolved"; conflict: ConflictRow }
  | { kind: "already_resolved"; conflict: ConflictRow }
  | { kind: "not_found" }
  /** Resolved the other way already. */
  | { kind: "conflicting_resolution"; conflict: ConflictRow }
  /** The stored rate is not the one in the conflict any more (or changed during the request). */
  | { kind: "stale"; conflict: ConflictRow };

const byId = (db: D1Database, id: number) =>
  db
    .prepare(`SELECT ${CONFLICT_COLUMNS} FROM fx_rate_conflicts WHERE id = ?1`)
    .bind(id)
    .first<ConflictRow>();

export async function resolveConflict(
  db: D1Database,
  id: number,
  resolution: "kept" | "accepted",
  actorEmail: string,
  nowIso: string,
): Promise<ResolveOutcome> {
  const c = await byId(db, id);
  if (c === null) return { kind: "not_found" };
  if (c.resolved_at !== null) {
    return c.resolution === resolution
      ? { kind: "already_resolved", conflict: c }
      : { kind: "conflicting_resolution", conflict: c };
  }
  const stored = await db
    .prepare("SELECT rate FROM fx_rates WHERE currency = ?1 AND rate_date = ?2")
    .bind(c.currency, c.rate_date)
    .first<{ rate: string }>();
  // The conflict was recorded against a stored rate that is gone (never happens through the
  // app: fx_rates is insert-only except for this route) or replaced since.
  if (stored === null) return { kind: "stale", conflict: c };

  const entityId = `${c.currency}@${c.rate_date}`;
  // Same guard on the audit row and on the rate replacement: still unresolved, and the rate is
  // still the one we just read. They run before the resolved mark, which is the last statement.
  const guard = {
    sql: `EXISTS (SELECT 1 FROM fx_rate_conflicts WHERE id = ?7 AND resolved_at IS NULL)
          AND EXISTS (SELECT 1 FROM fx_rates WHERE currency = ?8 AND rate_date = ?9 AND rate = ?10)`,
    binds: [id, c.currency, c.rate_date, stored.rate],
  };
  const statements: D1PreparedStatement[] = [
    auditStatement(
      db,
      {
        actorEmail,
        action: "fx.rate_conflict_resolved",
        entity: "fx_rate",
        entityId,
        before: { rate: stored.rate },
        after: {
          rate: resolution === "accepted" ? c.ecb_rate : stored.rate,
          resolution,
          ecb: c.ecb_rate,
          conflictId: id,
        },
      },
      guard,
    ),
  ];
  if (resolution === "accepted") {
    statements.push(
      db
        .prepare(
          `UPDATE fx_rates SET rate = ?4, source = 'ECB', fetched_at = ?5
           WHERE currency = ?1 AND rate_date = ?2 AND rate = ?3
             AND EXISTS (SELECT 1 FROM fx_rate_conflicts WHERE id = ?6 AND resolved_at IS NULL)`,
        )
        .bind(c.currency, c.rate_date, stored.rate, c.ecb_rate, nowIso, id),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE fx_rate_conflicts SET resolved_at = ?2, resolved_by = ?3, resolution = ?4
         WHERE id = ?1 AND resolved_at IS NULL
           AND (?4 = 'kept' OR EXISTS (SELECT 1 FROM fx_rates
                                       WHERE currency = ?5 AND rate_date = ?6 AND rate = ?7))`,
      )
      .bind(
        id,
        nowIso,
        actorEmail.trim().toLowerCase(),
        resolution,
        c.currency,
        c.rate_date,
        c.ecb_rate,
      ),
  );
  const results = await db.batch(statements);
  const done = (results[results.length - 1]?.meta.changes ?? 0) === 1;
  const after = await byId(db, id);
  if (after === null) return { kind: "not_found" };
  if (done) return { kind: "resolved", conflict: after };
  // Lost a race or the rate moved: say what is true now.
  if (after.resolved_at !== null) {
    return after.resolution === resolution
      ? { kind: "already_resolved", conflict: after }
      : { kind: "conflicting_resolution", conflict: after };
  }
  return { kind: "stale", conflict: after };
}
