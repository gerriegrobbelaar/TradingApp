/**
 * Append-only audit log (CLAUDE.md 5). Before storage, IBANs are masked and secrets
 * (tokens, keys, passwords, email bodies) are redacted, both by key name and by value shape.
 */
export interface AuditEntry {
  actorEmail: string;
  action: string;
  entity: string;
  entityId?: string | number | null;
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

/** Keys whose values are never stored. */
const SECRET_KEY_RE =
  /(token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization|cookie|signature|assertion|client[_-]?secret|code[_-]?verifier|^code$|body|html)/i;

/** Keeps country, check digits and the last four characters, e.g. NL91****4300. */
export function maskIban(iban: string): string {
  const compact = iban.replace(/\s+/g, "").toUpperCase();
  if (compact.length <= 8) return "****";
  return `${compact.slice(0, 4)}****${compact.slice(-4)}`;
}

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

export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  const actor = entry.actorEmail.trim().toLowerCase();
  if (actor === "") throw new Error("audit entry needs an actor");
  await db
    .prepare(
      `INSERT INTO audit_log (actor_email, action, entity, entity_id, before_json, after_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      actor,
      entry.action,
      entry.entity,
      entry.entityId === undefined || entry.entityId === null
        ? null
        : maskString(String(entry.entityId)),
      toJson(entry.before),
      toJson(entry.after),
    )
    .run();
}
