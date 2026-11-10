# ADR 0011: Retention and cleanup
Status: accepted 2026-11-10

## Context
Tables that grow without bound cost money and, for security data, keep more than needed.

## Decision
- `sessions`: dead rows (expired, or idle beyond 12 hours) are deleted opportunistically at sign-in, at most 100 per sign-in. A scheduled sweep (Phase 3) replaces this later.
- `idempotency_keys`: scope `auth.flow` is purged after 24 hours, bounded to 100 per sign-in, by `claimOnceAndPurge`, which refuses any scope not starting with `auth.`. Keys for payment and Exact/Revolut write scopes are NEVER purged: they are the protection against double payment.
- `audit_log`: append-only; no update or delete in code. Later a job archives old rows to R2 (EU) with a manifest, and removal happens only under a written retention period (to agree with the accountant; Dutch bookkeeping rules suggest 7 years).
- `invites`: accepted and revoked rows are kept; they document who granted access.

## Consequences
- Cleanup is bounded work per request. A backlog drains over several sign-ins and never blocks one.
- Until the sweep job exists, an idle system keeps a few dead rows. That is harmless.
