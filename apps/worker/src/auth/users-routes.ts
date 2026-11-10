/**
 * User management (admin only). Reading needs no step-up; every change does (invite, revoke,
 * role change, removal, restore). Removing a user or any role deletes that user's sessions at
 * once. "Removal" disables the user (history and audit references stay intact); "restore"
 * re-enables a removed user with an explicit new role list.
 *
 * Every mutation is ONE db.batch of the change plus its audit row (see db/audit.ts). Guarded
 * changes (last admin, user still disabled, invite still open) put the same condition on every
 * statement including the audit row, so a blocked request writes nothing at all.
 */
import { auditStatement, LAST_INSERT_ID } from "../db/audit";
import { json, type Ctx, type Router } from "../router";
import { ROLES, type Role } from "./session";
import { parseInviteRoles } from "./signin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMIN_ONLY = { roles: ["admin"] } as const;
const ADMIN_STEP_UP = { roles: ["admin"], stepUp: true } as const;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await request.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseRoles(v: unknown): Role[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((r) => typeof r === "string" && ROLES.includes(r as Role))) return null;
  return [...new Set(v as Role[])].sort();
}

function parseId(ctx: Ctx): number | null {
  const raw = ctx.params.id ?? "";
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function rolesOf(db: D1Database, userId: number): Promise<Role[]> {
  const { results } = await db
    .prepare("SELECT role FROM user_roles WHERE user_id = ?1 ORDER BY role")
    .bind(userId)
    .all<{ role: Role }>();
  return results.map((r) => r.role);
}

interface UserState {
  email: string;
  disabled_at: string | null;
}

const userState = (db: D1Database, id: number): Promise<UserState | null> =>
  db.prepare("SELECT email, disabled_at FROM users WHERE id = ?1").bind(id).first<UserState>();

/** SQL fragment: another enabled admin exists besides user `p` (a placeholder like ?1). */
const otherAdmin = (p: string): string =>
  `EXISTS (SELECT 1 FROM user_roles r JOIN users u ON u.id = r.user_id
    WHERE r.role = 'admin' AND u.disabled_at IS NULL AND u.id <> ${p})`;
const userEnabled = (p: string): string =>
  `EXISTS (SELECT 1 FROM users WHERE id = ${p} AND disabled_at IS NULL)`;
const userDisabled = (p: string): string =>
  `EXISTS (SELECT 1 FROM users WHERE id = ${p} AND disabled_at IS NOT NULL)`;
/** Disabling is allowed unless the user is an admin and no other enabled admin exists. */
const mayDisable = (p: string): string =>
  `${userEnabled(p)} AND (NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = ${p} AND role = 'admin')
    OR ${otherAdmin(p)})`;

export function registerUserRoutes(router: Router): void {
  router.add("GET", "/api/users", ADMIN_ONLY, async (ctx) => {
    const db = ctx.env.DB;
    const users = await db
      .prepare(
        `SELECT u.id, u.email, u.disabled_at, u.last_login_at,
                (SELECT group_concat(role) FROM (SELECT role FROM user_roles WHERE user_id = u.id ORDER BY role)) AS roles
         FROM users u ORDER BY u.email`,
      )
      .all<{
        id: number;
        email: string;
        disabled_at: string | null;
        last_login_at: string | null;
        roles: string | null;
      }>();
    const invites = await db
      .prepare(
        `SELECT id, email, roles, invited_by, created_at FROM invites
         WHERE accepted_at IS NULL AND revoked_at IS NULL ORDER BY email`,
      )
      .all<{ id: number; email: string; roles: string; invited_by: string; created_at: string }>();
    return json({
      users: users.results.map((u) => ({
        id: u.id,
        email: u.email,
        roles: u.roles ? u.roles.split(",") : [],
        disabled: u.disabled_at !== null,
        lastLoginAt: u.last_login_at,
      })),
      invites: invites.results.map((i) => ({
        id: i.id,
        email: i.email,
        roles: parseInviteRoles(i.roles),
        invitedBy: i.invited_by,
        createdAt: i.created_at,
      })),
    });
  });

  router.add("POST", "/api/users/invite", ADMIN_STEP_UP, async (ctx) => {
    const body = await readJson(ctx.request);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const roles = parseRoles(body?.roles);
    if (!EMAIL_RE.test(email) || !email.endsWith(`@${ctx.config.allowedHd}`)) {
      return json({ error: "invalid_email" }, 400);
    }
    if (!roles || roles.length === 0) return json({ error: "invalid_roles" }, 400);
    const db = ctx.env.DB;
    const user = await db
      .prepare("SELECT disabled_at FROM users WHERE email = ?1")
      .bind(email)
      .first<{ disabled_at: string | null }>();
    // A removed user is restored, not re-invited (the UI offers Restore).
    if (user)
      return json({ error: user.disabled_at !== null ? "user_disabled" : "already_exists" }, 409);
    const pending = await db
      .prepare(
        "SELECT 1 AS x FROM invites WHERE email = ?1 AND accepted_at IS NULL AND revoked_at IS NULL",
      )
      .bind(email)
      .first();
    if (pending) return json({ error: "already_exists" }, 409);

    const actor = ctx.session?.email ?? "";
    let results: D1Result[];
    try {
      results = await db.batch([
        db
          .prepare("INSERT INTO invites (email, roles, invited_by) VALUES (?1, ?2, ?3)")
          .bind(email, JSON.stringify(roles), actor),
        auditStatement(db, {
          actorEmail: actor,
          action: "user.invite",
          entity: "invite",
          entityId: LAST_INSERT_ID,
          after: { email, roles },
        }),
      ]);
    } catch {
      // A concurrent invite for the same email won the partial unique index; nothing was written.
      return json({ error: "already_exists" }, 409);
    }
    const id = results[0]?.meta.last_row_id;
    return json({ id, email, roles }, 201);
  });

  router.add("DELETE", "/api/users/invites/:id", ADMIN_STEP_UP, async (ctx) => {
    const id = parseId(ctx);
    if (id === null) return json({ error: "invalid_request" }, 400);
    const db = ctx.env.DB;
    const invite = await db
      .prepare(
        `SELECT email, roles FROM invites WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(id)
      .first<{ email: string; roles: string }>();
    if (!invite) return json({ error: "not_found" }, 404);
    const open =
      "EXISTS (SELECT 1 FROM invites WHERE id = ?7 AND accepted_at IS NULL AND revoked_at IS NULL)";
    const results = await db.batch([
      auditStatement(
        db,
        {
          actorEmail: ctx.session?.email ?? "",
          action: "user.invite_revoked",
          entity: "invite",
          entityId: id,
          before: { email: invite.email, roles: parseInviteRoles(invite.roles) },
        },
        { sql: open, binds: [id] },
      ),
      db
        .prepare(
          `UPDATE invites SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        )
        .bind(id),
    ]);
    // Someone accepted or revoked it between our read and the batch: nothing was written.
    if (results[0]?.meta.changes !== 1) return json({ error: "not_found" }, 404);
    return json({ id, revoked: true });
  });

  router.add("PATCH", "/api/users/:id/roles", ADMIN_STEP_UP, async (ctx) => {
    const id = parseId(ctx);
    const body = await readJson(ctx.request);
    const roles = parseRoles(body?.roles);
    if (id === null || !roles) return json({ error: "invalid_request" }, 400);
    const db = ctx.env.DB;
    const target = await userState(db, id);
    if (!target) return json({ error: "not_found" }, 404);
    if (target.disabled_at !== null) return json({ error: "user_disabled" }, 409);

    const before = await rolesOf(db, id);
    const removed = before.filter((r) => !roles.includes(r));
    const added = roles.filter((r) => !before.includes(r));
    const actor = ctx.session?.email ?? "";

    // One condition on every statement: the user is still enabled and, when the admin role is
    // being removed, another enabled admin exists. Statements only touch this user's rows, so
    // the condition holds (or fails) consistently across the batch; of two concurrent
    // demotions of each other exactly one passes.
    const cond = (p: string): string =>
      `${userEnabled(p)}${removed.includes("admin") ? ` AND ${otherAdmin(p)}` : ""}`;
    const results = await db.batch([
      ...removed.map((role) =>
        db
          .prepare(`DELETE FROM user_roles WHERE user_id = ?1 AND role = ?2 AND ${cond("?1")}`)
          .bind(id, role),
      ),
      // ON CONFLICT DO NOTHING: two concurrent PATCHes adding the same role both succeed.
      ...added.map((role) =>
        db
          .prepare(
            `INSERT INTO user_roles (user_id, role, granted_by)
             SELECT ?1, ?2, ?3 WHERE ${cond("?1")}
             ON CONFLICT (user_id, role) DO NOTHING`,
          )
          .bind(id, role, actor),
      ),
      ...(removed.length > 0
        ? [db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND ${cond("?1")}`).bind(id)]
        : []),
      auditStatement(
        db,
        {
          actorEmail: actor,
          action: "user.roles_changed",
          entity: "user",
          entityId: id,
          before: { roles: before },
          after: { roles },
        },
        { sql: cond("?7"), binds: [id] },
      ),
    ]);
    if (results[results.length - 1]?.meta.changes !== 1) {
      const now = await userState(db, id);
      return json({ error: now?.disabled_at ? "user_disabled" : "last_admin" }, 409);
    }
    return json({ id, email: target.email, roles });
  });

  router.add("DELETE", "/api/users/:id", ADMIN_STEP_UP, async (ctx) => {
    const id = parseId(ctx);
    if (id === null) return json({ error: "invalid_request" }, 400);
    const db = ctx.env.DB;
    const target = await userState(db, id);
    if (!target) return json({ error: "not_found" }, 404);
    const actor = ctx.session?.email ?? "";
    if (target.disabled_at === null) {
      const before = { email: target.email, roles: await rolesOf(db, id) };
      // Audit first (its guard sees the state before the update); then the guarded update;
      // sessions go once the user is disabled. A blocked last-admin removal writes nothing.
      const results = await db.batch([
        auditStatement(
          db,
          { actorEmail: actor, action: "user.disabled", entity: "user", entityId: id, before },
          { sql: mayDisable("?7"), binds: [id] },
        ),
        db
          .prepare(
            `UPDATE users SET disabled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?1 AND ${mayDisable("?1")}`,
          )
          .bind(id),
        db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND ${userDisabled("?1")}`).bind(id),
      ]);
      if (results[0]?.meta.changes !== 1) {
        const now = await userState(db, id);
        if (now?.disabled_at === null) return json({ error: "last_admin" }, 409);
        // Disabled concurrently by someone else: fall through to the idempotent answer.
      }
    } else {
      // Already removed: still make sure no session survives.
      await db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(id).run();
    }
    return json({ id, disabled: true });
  });

  router.add("POST", "/api/users/:id/restore", ADMIN_STEP_UP, async (ctx) => {
    const id = parseId(ctx);
    const body = await readJson(ctx.request);
    const roles = parseRoles(body?.roles);
    if (id === null) return json({ error: "invalid_request" }, 400);
    if (!roles || roles.length === 0) return json({ error: "invalid_roles" }, 400);
    const db = ctx.env.DB;
    const target = await userState(db, id);
    if (!target) return json({ error: "not_found" }, 404);
    if (target.disabled_at === null) return json({ error: "not_disabled" }, 409);
    const actor = ctx.session?.email ?? "";
    const before = await rolesOf(db, id);

    // Old sessions and old roles are wiped; the explicit list replaces them. The user row is
    // re-enabled last, because every earlier statement is conditioned on it still being disabled.
    const cond = (p: string): string => userDisabled(p);
    const results = await db.batch([
      auditStatement(
        db,
        {
          actorEmail: actor,
          action: "user.restored",
          entity: "user",
          entityId: id,
          before: { email: target.email, roles: before },
          after: { roles },
        },
        { sql: cond("?7"), binds: [id] },
      ),
      db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND ${cond("?1")}`).bind(id),
      db.prepare(`DELETE FROM user_roles WHERE user_id = ?1 AND ${cond("?1")}`).bind(id),
      ...roles.map((role) =>
        db
          .prepare(
            `INSERT INTO user_roles (user_id, role, granted_by)
             SELECT ?1, ?2, ?3 WHERE ${cond("?1")}
             ON CONFLICT (user_id, role) DO NOTHING`,
          )
          .bind(id, role, actor),
      ),
      db
        .prepare("UPDATE users SET disabled_at = NULL WHERE id = ?1 AND disabled_at IS NOT NULL")
        .bind(id),
    ]);
    if (results[0]?.meta.changes !== 1) return json({ error: "not_disabled" }, 409);
    return json({ id, email: target.email, roles });
  });
}
