# ADR 0009: Removing a user disables them; restore re-enables
Status: accepted 2026-11-10

## Context
Audit rows, approvals and payments reference users. Deleting a user would break that history and lose the Google `sub` binding.

## Decision
"Remove" sets `users.disabled_at`, deletes all of the user's sessions in the same batch, and writes `user.disabled` with the roles held before. Sign-in for a disabled user is denied (`user_disabled`). "Restore" is an explicit admin action that replaces the roles with a new explicit list and writes `user.restored`. Invites can be revoked until accepted. All of these need step-up. The last enabled admin cannot be removed.

## Consequences
- History stays intact and the `sub` binding survives a restore.
- A removed person cannot be re-invited; they must be restored (the UI says so).
- Hard deletion (for example a data-protection request) is out of scope for v1 and would be a separate, audited procedure.
