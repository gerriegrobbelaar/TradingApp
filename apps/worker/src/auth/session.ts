import { randomBase64Url, sha256Hex } from "./crypto";

export const IDLE_TIMEOUT_MS = 12 * 3600 * 1000;
export const ABSOLUTE_CAP_MS = 7 * 24 * 3600 * 1000;
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;
/** last_seen_at is only rewritten when older than this, to avoid a D1 write per request. */
const TOUCH_INTERVAL_MS = 60 * 1000;

/**
 * Roles are NOT hierarchical: a user holds exactly the roles granted explicitly. Admin does not
 * imply finance, approver or viewer. Routes list every role that may use them.
 */
export type Role = "admin" | "approver" | "finance" | "viewer";
export const ROLES: readonly Role[] = ["admin", "approver", "finance", "viewer"];

export interface Session {
  tokenHash: string;
  userId: number;
  email: string;
  roles: Role[];
  lastAuthAt: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Returns the raw token (for the cookie). Only its SHA-256 hex is stored. `lastAuthMs` is when
 * Google says the user actually authenticated (auth_time); it drives the step-up window.
 */
export async function createSession(
  db: D1Database,
  userId: number,
  nowMs: number,
  lastAuthMs: number,
): Promise<string> {
  const token = randomBase64Url(32);
  const hash = await sha256Hex(token);
  await db.batch([
    // Opportunistic cleanup of dead sessions.
    db
      .prepare("DELETE FROM sessions WHERE expires_at <= ?1 OR last_seen_at <= ?2")
      .bind(iso(nowMs), iso(nowMs - IDLE_TIMEOUT_MS)),
    db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, last_auth_at)
         VALUES (?1, ?2, ?3, ?3, ?4, ?5)`,
      )
      .bind(hash, userId, iso(nowMs), iso(nowMs + ABSOLUTE_CAP_MS), iso(lastAuthMs)),
  ]);
  return token;
}

export async function loadSession(
  db: D1Database,
  token: string,
  nowMs: number,
): Promise<Session | null> {
  if (token.length < 20 || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.user_id, s.last_seen_at, s.last_auth_at, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2
         AND s.last_seen_at > ?3 AND u.disabled_at IS NULL`,
    )
    .bind(hash, iso(nowMs), iso(nowMs - IDLE_TIMEOUT_MS))
    .first<{ user_id: number; last_seen_at: string; last_auth_at: string; email: string }>();
  if (!row) return null;
  if (nowMs - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
    await db
      .prepare("UPDATE sessions SET last_seen_at = ?1 WHERE token_hash = ?2")
      .bind(iso(nowMs), hash)
      .run();
  }
  const { results } = await db
    .prepare("SELECT role FROM user_roles WHERE user_id = ?1 ORDER BY role")
    .bind(row.user_id)
    .all<{ role: Role }>();
  return {
    tokenHash: hash,
    userId: row.user_id,
    email: row.email,
    roles: results.map((r) => r.role),
    lastAuthAt: row.last_auth_at,
  };
}

export async function deleteSessionByToken(db: D1Database, token: string): Promise<void> {
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?1")
    .bind(await sha256Hex(token))
    .run();
}

export function deleteSessionsForUser(db: D1Database, userId: number): D1PreparedStatement {
  return db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId);
}

export function isStepUpFresh(session: Session, nowMs: number): boolean {
  const t = Date.parse(session.lastAuthAt);
  return Number.isFinite(t) && nowMs - t <= STEP_UP_WINDOW_MS;
}
