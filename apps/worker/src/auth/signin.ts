/**
 * Maps a verified Google identity to a local user. Invite-only: an enabled user row (for
 * example the seeded admin) or an open invite for the email must exist. Email compare is
 * lowercase. The Google `sub` is bound on first sign-in and must match from then on.
 */
import { writeAudit } from "../db/audit";
import { AuthError, type GoogleIdentity } from "./google";
import { ROLES, type Role } from "./session";

export function parseInviteRoles(raw: string): Role[] {
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((r): r is Role => ROLES.includes(r as Role));
  } catch {
    /* fall through */
  }
  return [];
}

export async function resolveUser(db: D1Database, id: GoogleIdentity): Promise<number> {
  const user = await db
    .prepare("SELECT id, google_sub, disabled_at FROM users WHERE email = ?1")
    .bind(id.email)
    .first<{ id: number; google_sub: string | null; disabled_at: string | null }>();

  if (user) {
    if (user.disabled_at !== null) throw new AuthError("user_disabled");
    if (user.google_sub === null) {
      try {
        const r = await db
          .prepare("UPDATE users SET google_sub = ?1 WHERE id = ?2 AND google_sub IS NULL")
          .bind(id.sub, user.id)
          .run();
        if (r.meta.changes !== 1) throw new AuthError("sub_mismatch");
      } catch (err) {
        if (err instanceof AuthError) throw err;
        throw new AuthError("sub_already_bound"); // UNIQUE: this Google account belongs to another row
      }
    } else if (user.google_sub !== id.sub) {
      throw new AuthError("sub_mismatch");
    }
    await db
      .prepare(
        "UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      )
      .bind(user.id)
      .run();
    return user.id;
  }

  const invite = await db
    .prepare(
      `SELECT id, roles FROM invites
       WHERE email = ?1 AND accepted_at IS NULL AND revoked_at IS NULL`,
    )
    .bind(id.email)
    .first<{ id: number; roles: string }>();
  if (!invite) throw new AuthError("not_invited");

  const roles = parseInviteRoles(invite.roles);
  // One transaction: the user row, its roles and the invite acceptance land together or not
  // at all. Every statement is guarded on the invite still being open, so a concurrent accept
  // or a revoke in between leaves nothing behind.
  const open = (p: string): string =>
    `EXISTS (SELECT 1 FROM invites WHERE id = ${p} AND accepted_at IS NULL AND revoked_at IS NULL)`;
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO users (email, google_sub, last_login_at)
           SELECT ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${open("?3")}`,
        )
        .bind(id.email, id.sub, invite.id),
      ...roles.map((role) =>
        db
          .prepare(
            `INSERT INTO user_roles (user_id, role, granted_by)
             SELECT id, ?2, 'invite' FROM users WHERE google_sub = ?1 AND ${open("?3")}`,
          )
          .bind(id.sub, role, invite.id),
      ),
      db
        .prepare(
          `UPDATE invites SET accepted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        )
        .bind(invite.id),
    ]);
  } catch {
    throw new AuthError("sub_already_bound"); // UNIQUE: this Google account belongs to another row
  }
  if (results[0]?.meta.changes !== 1) throw new AuthError("invite_closed");
  const userId = results[0].meta.last_row_id;
  await writeAudit(db, {
    actorEmail: id.email,
    action: "invite.accept",
    entity: "user",
    entityId: userId,
    after: { roles },
  });
  return userId;
}
