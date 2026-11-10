/** Append-only audit log (CLAUDE.md 5). IBANs are masked before storage. */
export interface AuditEntry {
  actorEmail: string;
  action: string;
  entity: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
}

const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

/** Keeps country, check digits and the last four characters, e.g. NL91****4300. */
export function maskIban(iban: string): string {
  const compact = iban.replace(/\s+/g, "");
  if (compact.length <= 8) return "****";
  return `${compact.slice(0, 4)}****${compact.slice(-4)}`;
}

export function maskDeep(value: unknown): unknown {
  if (typeof value === "string") return value.replace(IBAN_RE, (m) => maskIban(m));
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        /iban/i.test(k) && typeof v === "string" ? maskIban(v) : maskDeep(v),
      ]),
    );
  }
  return value;
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(maskDeep(value));
}

export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (actor_email, action, entity, entity_id, before_json, after_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      entry.actorEmail.toLowerCase(),
      entry.action,
      entry.entity,
      entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      toJson(entry.before),
      toJson(entry.after),
    )
    .run();
}
