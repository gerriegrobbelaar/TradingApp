# ADR 0013: Audit pattern, change and audit row in one batch
Status: accepted 2026-11-10

## Context
CLAUDE.md 5: every write is audited (who, what, when, before/after) and idempotent.

## Decision
Every mutation is one `db.batch([...changes, auditStatement(...)])`, a single D1 transaction, so a change cannot exist without its audit row or the reverse. When a change is conditional (last admin, user still disabled, invite still open), the same guard SQL goes on EVERY statement including the audit row. The audit statement's `meta.changes` then says whether it happened (1) or was blocked (0), and a blocked request writes nothing. Entries are masked before storage (IBANs, tokens, bodies). `writeAudit` alone is only for events without a change. The actor is the Google email in lowercase, or `system` for the seed.

## Consequences
- Races lose cleanly: two admins removing each other cannot leave zero admins.
- Authors must repeat the guard on each statement; review checks for it, and the helpers in `db/audit.ts` keep it short.
- Writes to Exact or Revolut also store an idempotency key first (`db/idempotency.ts`) and audit the outcome.
