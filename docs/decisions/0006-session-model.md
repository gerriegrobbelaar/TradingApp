# ADR 0006: Session model
Status: accepted 2026-11-10

## Context
CLAUDE.md 4.0: server-side sessions in D1, HttpOnly Secure SameSite=Lax cookie, 12-hour idle timeout, immediate end on removal.

## Decision
- The `__Host-session` cookie holds 32 random bytes; D1 stores only the SHA-256 hex. A database leak yields no usable tokens.
- Idle timeout 12 hours (`last_seen_at`, rewritten at most once a minute). Absolute cap 7 days (`expires_at`), so a continuously used session still ends.
- Every sign-in, including step-up, creates a new session and deletes the one presented (no fixation, no in-place upgrade). Delete, insert and audit row are one batch.
- Ending a session means deleting the row (logout, user removal, role removal). `sessions.revoked_at` is unused; it stays as a read-side filter. Dropping the column needs a migration, deferred.
- Every request also checks `users.disabled_at IS NULL` and loads roles fresh from `user_roles`, so role changes apply on the next request.

## Consequences
- One D1 read per request, plus a write at most once a minute per session.
- No "revoked" history in the table: the audit log is the record of who was signed out and why.
