/**
 * Settings of the data quality notifications (setting `dq.notifications`, ADR 0046) and the
 * recipient allow-list. Recipients are ALWAYS read from the users table: an active, internal user
 * who holds role admin (mode `admin`) or admin or finance (mode `admin_finance`) and whose address is
 * on the allowed Google Workspace domain (ALLOWED_HD; v1 is domain-only). There is no free-text
 * address anywhere in this feature.
 */
import {
  isEmailInDomain,
  normalizeEmail,
  parseStoredSettings,
  type AlertRecipientsMode,
  type DqNotificationSettings,
} from "@camelthorn/core";

export const SETTING_NOTIFICATIONS = "dq.notifications";

export interface StoredNotifications {
  settings: DqNotificationSettings;
  /** Changes with every write; a PATCH must send the one it read (null = never saved). */
  rev: string | null;
}

export async function loadNotificationSettings(db: D1Database): Promise<StoredNotifications> {
  const row = await db
    .prepare("SELECT value_json FROM settings WHERE key = ?1")
    .bind(SETTING_NOTIFICATIONS)
    .first<{ value_json: string }>();
  if (row === null) return { settings: parseStoredSettings(null), rev: null };
  let rev: string | null = null;
  try {
    const r = (JSON.parse(row.value_json) as { rev?: unknown }).rev;
    if (typeof r === "string") rev = r;
  } catch {
    // unreadable: defaults, no rev (a PATCH with rev null then rewrites it)
  }
  return { settings: parseStoredSettings(row.value_json), rev };
}

export interface Recipient {
  id: number;
  email: string;
}

// Dot-atoms only: no leading, trailing or doubled dot.
const LOCAL = /^(?=.{1,64}$)[a-z0-9+_-]+(\.[a-z0-9+_-]+)*$/;

/**
 * A plain mailbox on the allowed domain: no display name, list, comment or control character. The
 * stored value must already be plain ASCII: lower-casing can turn a non-ASCII look-alike into ASCII
 * (the Kelvin sign U+212A becomes "k"), so a stored address that is not what we would send to is out.
 */
export function isAllowedRecipient(email: string, domain: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(email.trim())) return false;
  const e = normalizeEmail(email);
  if (!isEmailInDomain(e, domain)) return false;
  return LOCAL.test(e.slice(0, e.indexOf("@")));
}

export async function loadRecipients(
  db: D1Database,
  domain: string,
  mode: AlertRecipientsMode,
): Promise<Recipient[]> {
  const roles = mode === "admin" ? ["admin"] : ["admin", "finance"];
  const rows = (
    await db
      .prepare(
        `SELECT DISTINCT u.id, u.email FROM users u
           JOIN user_roles r ON r.user_id = u.id
         WHERE r.role IN (${roles.map((_, i) => `?${i + 1}`).join(",")})
           AND u.disabled_at IS NULL AND u.is_external = 0
         ORDER BY u.id`,
      )
      .bind(...roles)
      .all<{ id: number; email: string }>()
  ).results;
  return rows
    .filter((r) => isAllowedRecipient(r.email, domain))
    .map((r) => ({ id: r.id, email: normalizeEmail(r.email) }));
}
