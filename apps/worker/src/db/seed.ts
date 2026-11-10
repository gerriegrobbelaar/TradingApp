/**
 * Idempotent initial administrator seed (CLAUDE.md 4.0). The email comes from the
 * INITIAL_ADMIN_EMAIL Workers variable; it is never hard-coded. D1 migrations cannot read
 * Workers variables, so the seed runs at startup instead of inside migration 0001.
 *
 * The seed runs at most once per database, ever: a `seed.initial_admin` marker in `settings`
 * is written in the same transaction. So if admins later remove the seeded admin (even
 * leaving no admin at all), a restart never silently re-grants admin to that email.
 */
export type SeedResult = "created" | "exists" | "skipped";

const SEED_MARKER = "seed.initial_admin";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function seedInitialAdmin(
  db: D1Database,
  email: string | undefined,
): Promise<SeedResult> {
  const normalised = (email ?? "").trim().toLowerCase();
  if (normalised === "") return "skipped";
  if (!EMAIL_RE.test(normalised)) throw new Error("INITIAL_ADMIN_EMAIL is not a valid email");

  // Every statement is guarded by "not seeded yet and no admin yet". D1 runs a batch as one
  // transaction and serialises writes, so concurrent isolates cannot both seed.
  const guard = `NOT EXISTS (SELECT 1 FROM settings WHERE key = '${SEED_MARKER}')
    AND NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO users (email, is_external)
         SELECT ?1, 0 WHERE ${guard}
         ON CONFLICT (email) DO NOTHING`,
      )
      .bind(normalised),
    db
      .prepare(
        `INSERT INTO user_roles (user_id, role, granted_by)
         SELECT id, 'admin', 'system' FROM users WHERE email = ?1 AND ${guard}`,
      )
      .bind(normalised),
    db
      .prepare(
        `INSERT INTO audit_log (actor_email, action, entity, entity_id, after_json)
         SELECT 'system', 'user.seed_admin', 'user', CAST(u.id AS TEXT), json_object('role', 'admin')
         FROM users u
         WHERE u.email = ?1
           AND NOT EXISTS (SELECT 1 FROM settings WHERE key = '${SEED_MARKER}')
           AND EXISTS (SELECT 1 FROM user_roles r
                       WHERE r.user_id = u.id AND r.role = 'admin' AND r.granted_by = 'system')`,
      )
      .bind(normalised),
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_by)
       VALUES ('${SEED_MARKER}', json_object('at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 'system')
       ON CONFLICT (key) DO NOTHING`,
    ),
  ]);
  const roleInserted = results[1]?.meta.changes === 1;
  return roleInserted ? "created" : "exists";
}

let seeding: Promise<void> | null = null;

/**
 * Call at the start of a request or scheduled run; runs the seed once per isolate.
 * Concurrent callers share one attempt. A failed attempt is forgotten so the next call
 * retries (a transient D1 error must not leave the isolate unseeded for its lifetime).
 */
export function ensureSeeded(env: { DB: D1Database; INITIAL_ADMIN_EMAIL?: string }): Promise<void> {
  if (!seeding) {
    seeding = seedInitialAdmin(env.DB, env.INITIAL_ADMIN_EMAIL).then(
      () => undefined,
      (err: unknown) => {
        seeding = null;
        throw err;
      },
    );
  }
  return seeding;
}

/** Test hook: forget the per-isolate memo. */
export function resetSeedMemoForTests(): void {
  seeding = null;
}
