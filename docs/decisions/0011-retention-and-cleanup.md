# ADR 0011: Retention and cleanup
Status: accepted 2026-11-10

## Context
Tables that grow without bound cost money and, for security data, keep more than needed.

## Decision
- `sessions`: dead rows (expired, or idle beyond 12 hours) are deleted opportunistically at sign-in, at most 100 per sign-in. A scheduled sweep (Phase 3) replaces this later.
- `idempotency_keys`: scope `auth.flow` is purged after 24 hours, bounded to 100 per sign-in, by `claimOnceAndPurge`. That helper only accepts scopes on an exact allow-list (today only `auth.flow`; no prefix matching) and refuses a retention under 1 hour, so a purge can never reopen replay of a still-valid flow cookie (10 minutes). Keys for payment and Exact/Revolut write scopes are NEVER purged: they are the protection against double payment.
- `audit_log`: append-only; no update or delete in code. Later a job archives old rows to R2 (EU) with a manifest, and removal happens only under a written retention period (to agree with the accountant; Dutch bookkeeping rules suggest 7 years).
- `invites`: accepted and revoked rows are kept; they document who granted access.
- `webhook_events` (Revolut deliveries, hashes and ids only): `processed`, `ignored` and `error` rows are deleted 30 days after they were received, `queued` rows are never deleted by age (a stale one is re-enqueued, then ends as `error`, see ADR 0033). `webhook_rejections` (rejected deliveries counted per UTC minute and reason code): deleted after 7 days. Both are deleted in batches of 200 (at most 5 batches per run) by `housekeepWebhookEvents`, which the scheduler tick calls on one tick in ten (minute 3, 13, 23, ...); one isolate wins a `settings` claim per 10 minutes, and when nothing is due the run costs the claim and one query.

## Consequences
- Cleanup is bounded work per request. A backlog drains over several sign-ins and never blocks one.
- Until the sweep job exists, an idle system keeps a few dead rows. That is harmless.
