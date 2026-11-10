# ADR 0004: Initial admin is seeded at Worker start, once
Status: accepted 2026-11-10 (changes CLAUDE.md 4.0 wording)

## Context
D1 migrations cannot read Workers variables, so the admin email from `INITIAL_ADMIN_EMAIL` cannot be seeded "in the first migration" and must not be hard-coded in source.

## Decision
`ensureSeeded` runs `seedInitialAdmin` at the start of requests and scheduled runs (once per isolate, retried after a failure). It inserts the user, the `admin` role and an audit row `user.seed_admin` in one batch, guarded by "no `seed.initial_admin` marker in `settings`" and "no admin role exists". The marker is written in the same batch, so the seed happens at most once per database, even if admins are later removed. Re-runs are no-ops and never create a second admin. CLAUDE.md 4.0 now says this.

## Consequences
- A mistyped `INITIAL_ADMIN_EMAIL` is also marked as done, so fixing the variable alone does nothing. Recovery (needs Cloudflare account access, `wrangler d1 execute --remote`):
  1. Check the wrong user never signed in: `SELECT id, email, google_sub FROM users WHERE id IN (SELECT user_id FROM user_roles WHERE role='admin')`. If `google_sub` is set, handle it in the app instead.
  2. `DELETE FROM user_roles WHERE role='admin'; DELETE FROM users WHERE google_sub IS NULL AND email='<wrong>'; DELETE FROM settings WHERE key='seed.initial_admin';`
  3. Correct the variable, deploy, load any page, and check `user.seed_admin` in `audit_log`.
  4. Insert an `audit_log` row by hand describing the recovery (who, why).
- Until step 3 nobody can administer users. That is the intended fail-closed outcome.
