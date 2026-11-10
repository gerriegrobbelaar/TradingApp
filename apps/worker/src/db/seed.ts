/**
 * Idempotent initial administrator seed (CLAUDE.md 4.0). The email comes from the
 * INITIAL_ADMIN_EMAIL Workers variable; it is never hard-coded.
 */
export type SeedResult = "created" | "exists" | "skipped";

export async function seedInitialAdmin(
  db: D1Database,
  email: string | undefined,
): Promise<SeedResult> {
  const normalised = (email ?? "").trim().toLowerCase();
  if (normalised === "") return "skipped";

  const existing = await db
    .prepare("SELECT 1 AS found FROM user_roles WHERE role = 'admin' LIMIT 1")
    .first();
  if (existing) return "exists";

  // Both statements are guarded by "no admin yet", so a race or re-run adds nothing extra.
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (email, is_external)
         SELECT ?1, 0
         WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')
         ON CONFLICT (email) DO NOTHING`,
      )
      .bind(normalised),
    db
      .prepare(
        `INSERT INTO user_roles (user_id, role, granted_by)
         SELECT id, 'admin', 'system' FROM users
         WHERE email = ?1 AND NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')`,
      )
      .bind(normalised),
  ]);
  return "created";
}

let seeded = false;

/** Call at the start of a request or scheduled run; runs the seed once per isolate. */
export async function ensureSeeded(env: {
  DB: D1Database;
  INITIAL_ADMIN_EMAIL?: string;
}): Promise<void> {
  if (seeded) return;
  await seedInitialAdmin(env.DB, env.INITIAL_ADMIN_EMAIL);
  seeded = true;
}
