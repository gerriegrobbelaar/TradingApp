/**
 * User management (admin only). Reading needs no step-up; every change does (invite, role
 * change, removal). Removing a user or any role deletes that user's sessions at once.
 * "Removal" disables the user (history and audit references stay intact).
 */
import { writeAudit } from "../db/audit";
import { json, type Ctx, type Router } from "../router";
import { ROLES, deleteSessionsForUser, type Role } from "./session";
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
  const n = Number(ctx.params.id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function rolesOf(db: D1Database, userId: number): Promise<Role[]> {
  const { results } = await db
    .prepare("SELECT role FROM user_roles WHERE user_id = ?1 ORDER BY role")
    .bind(userId)
    .all<{ role: Role }>();
  return results.map((r) => r.role);
}

/** SQL fragment: another enabled admin exists besides user ?1. */
const OTHER_ADMIN = `EXISTS (SELECT 1 FROM user_roles r JOIN users u ON u.id = r.user_id
  WHERE r.role = 'admin' AND u.disabled_at IS NULL AND u.id <> ?1)`;

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
    const existing = await db
      .prepare(
        `SELECT 1 AS x FROM users WHERE email = ?1
         UNION ALL SELECT 1 FROM invites WHERE email = ?1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(email)
      .first();
    if (existing) return json({ error: "already_exists" }, 409);
    const actor = ctx.session?.email ?? "";
    const ins = await db
      .prepare("INSERT INTO invites (email, roles, invited_by) VALUES (?1, ?2, ?3)")
      .bind(email, JSON.stringify(roles), actor)
      .run();
    await writeAudit(db, {
      actorEmail: actor,
      action: "user.invite",
      entity: "invite",
      entityId: ins.meta.last_row_id,
      after: { email, roles },
    });
    return json({ id: ins.meta.last_row_id, email, roles }, 201);
  });

  router.add("PATCH", "/api/users/:id/roles", ADMIN_STEP_UP, async (ctx) => {
    const id = parseId(ctx);
    const body = await readJson(ctx.request);
    const roles = parseRoles(body?.roles);
    if (id === null || !roles) return json({ error: "invalid_request" }, 400);
    const db = ctx.env.DB;
    const target = await db
      .prepare("SELECT email, disabled_at FROM users WHERE id = ?1")
      .bind(id)
      .first<{ email: string; disabled_at: string | null }>();
    if (!target) return json({ error: "not_found" }, 404);
    if (target.disabled_at !== null) return json({ error: "user_disabled" }, 409);

    const before = await rolesOf(db, id);
    const removed = before.filter((r) => !roles.includes(r));
    const added = roles.filter((r) => !before.includes(r));

    // Atomic last-admin guard: the delete only happens if another enabled admin remains.
    if (removed.includes("admin")) {
      const r = await db
        .prepare(`DELETE FROM user_roles WHERE user_id = ?1 AND role = 'admin' AND ${OTHER_ADMIN}`)
        .bind(id)
        .run();
      if (r.meta.changes !== 1) return json({ error: "last_admin" }, 409);
    }
    const actor = ctx.session?.email ?? "";
    const stmts: D1PreparedStatement[] = [
      ...removed
        .filter((r) => r !== "admin")
        .map((role) =>
          db.prepare("DELETE FROM user_roles WHERE user_id = ?1 AND role = ?2").bind(id, role),
        ),
      ...added.map((role) =>
        db
          .prepare("INSERT INTO user_roles (user_id, role, granted_by) VALUES (?1, ?2, ?3)")
          .bind(id, role, actor),
      ),
    ];
    if (removed.length > 0) stmts.push(deleteSessionsForUser(db, id));
    if (stmts.length > 0) await db.batch(stmts);
    await writeAudit(db, {
      actorEmail: actor,
      action: "user.roles_changed",
      entity: "user",
      entityId: id,
      before: { roles: before },
      after: { roles },
    });
    return json({ id, email: target.email, roles });
  });

  router.add("DELETE", "/api/users/:id", ADMIN_STEP_UP, async (ctx) => {
    const id = parseId(ctx);
    if (id === null) return json({ error: "invalid_request" }, 400);
    const db = ctx.env.DB;
    const target = await db
      .prepare("SELECT email, disabled_at FROM users WHERE id = ?1")
      .bind(id)
      .first<{ email: string; disabled_at: string | null }>();
    if (!target) return json({ error: "not_found" }, 404);
    if (target.disabled_at === null) {
      // Atomic last-admin guard (an enabled admin may only be disabled if another remains).
      const r = await db
        .prepare(
          `UPDATE users SET disabled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?1 AND disabled_at IS NULL
             AND (NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = ?1 AND role = 'admin')
                  OR ${OTHER_ADMIN})`,
        )
        .bind(id)
        .run();
      if (r.meta.changes !== 1) return json({ error: "last_admin" }, 409);
      await writeAudit(db, {
        actorEmail: ctx.session?.email ?? "",
        action: "user.disabled",
        entity: "user",
        entityId: id,
        before: { email: target.email, roles: await rolesOf(db, id) },
      });
    }
    await deleteSessionsForUser(db, id).run();
    return json({ id, disabled: true });
  });
}
