/**
 * Append-only audit log (CLAUDE.md 5). Before storage, IBANs are masked and secrets
 * (tokens, keys, passwords, email bodies) are redacted, both by key name and by value shape.
 *
 * PATTERN, all writes: batch change+audit. Every mutation runs its change and its audit row in
 * ONE `db.batch([...change, auditStatement(...)])` (a single D1 transaction), so a change can
 * never exist without its audit row or the other way round. Use `writeAudit` only for events
 * with no accompanying change. When a change is conditional (a guard such as "last admin"), put
 * the same condition on the audit statement via `guard`, then read the audit statement's
 * `meta.changes` (1 = it happened, 0 = the guard blocked everything).
 */
import { maskIban, normalizeEmail } from "@camelthorn/core";

export const LAST_INSERT_ID = Symbol("last-insert-id");

export interface AuditEntry {
  actorEmail: string;
  action: string;
  entity: string;
  /**
   * `LAST_INSERT_ID` uses SQLite's `last_insert_rowid()`: the row id of the insert directly
   * before this statement in the same batch. Only use it right after an UNCONDITIONAL single-row
   * INSERT; after an insert that wrote nothing (guarded, ON CONFLICT DO NOTHING) it would carry a
   * stale id from an earlier insert on the connection.
   */
  entityId?: string | number | null | typeof LAST_INSERT_ID;
  before?: unknown;
  after?: unknown;
}

export const REDACTED = "[redacted]";

/**
 * IBAN in compact or grouped form ("NL91ABNA0417164300", "NL91 ABNA 0417 1643 00"),
 * any case. Over-masking a lookalike is acceptable; leaking a real IBAN is not.
 */
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?)\b/gi;

/** Values that look like bearer tokens / JWTs. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Keys whose values are never stored. An OAuth authorization code is caught by its qualified
 * names (authorization_code, auth_code, oauth_code, grant_code, code_verifier); a bare `code` is
 * NOT a secret here: it is the short machine code of every job result and audit row (review R3a),
 * and redacting it hid the reason of every failed run. No caller audits a raw OAuth `code`.
 */
const SECRET_KEY_RE =
  /(token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization|cookie|signature|assertion|client[_-]?secret|code[_-]?verifier|auth[_-]?code|oauth[_-]?code|grant[_-]?code|body|html)/i;

function maskString(value: string): string {
  return value
    .replace(JWT_RE, REDACTED)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(IBAN_RE, (m) => maskIban(m));
}

export function maskDeep(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return maskString(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map((v) => maskDeep(v, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        if (SECRET_KEY_RE.test(k)) return [k, v === null || v === undefined ? v : REDACTED];
        if (/iban/i.test(k) && typeof v === "string") return [k, maskIban(v)];
        return [k, maskDeep(v, seen)];
      }),
    );
  }
  return value;
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(maskDeep(value));
}

/**
 * Optional condition for the audit row: a SQL boolean expression using placeholders from ?7
 * upward (?1-?6 are the audit columns), with its bind values in order.
 */
export interface AuditGuard {
  sql: string;
  binds: readonly (string | number | null)[];
}

/** Prepared (not executed) audit insert, to be run inside the same `db.batch` as the change. */
export function auditStatement(
  db: D1Database,
  entry: AuditEntry,
  guard?: AuditGuard,
): D1PreparedStatement {
  const actor = normalizeEmail(entry.actorEmail);
  if (actor === "") throw new Error("audit entry needs an actor");
  const id = entry.entityId;
  const fromInsert = id === LAST_INSERT_ID;
  const entityId =
    id === undefined || id === null || id === LAST_INSERT_ID ? null : maskString(String(id));
  return db
    .prepare(
      `INSERT INTO audit_log (actor_email, action, entity, entity_id, before_json, after_json)
       SELECT ?1, ?2, ?3, ${fromInsert ? "CAST(last_insert_rowid() AS TEXT)" : "?4"}, ?5, ?6
       WHERE ${guard ? guard.sql : "1"}`,
    )
    .bind(
      actor,
      entry.action,
      entry.entity,
      entityId,
      toJson(entry.before),
      toJson(entry.after),
      ...(guard?.binds ?? []),
    );
}

export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry).run();
}
