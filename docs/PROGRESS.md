# Progress

Orchestrator log. Update after every merge and every direct (trivial) edit.

## Phase status
| # | Phase | Status |
|---|---|---|
| 1 | Foundation | Done (open go-live gate: confirm Google returns auth_time, ADR 0007) |
| 2 | Exact connection | Code complete (E1-E3, G1-G3 merged, reviews done). NOT verified against real Exact: see docs/DEPLOY.md section 9 |
| 3 | Scheduler | Not started |
| 4 | Read-only screens | Not started |
| 5 | Revolut connection | Not started |
| 6 | ECB FX | Not started |
| 7 | Matching | Not started |
| 8 | Data quality | Not started |
| 9 | Payments | Not started |
| 10 | Reminders and resend emails | Not started |
| 11 | Cash forecast and Close checklist | Not started |
| 12 | Monthly FX revaluation booking | Not started |

## Log
- 2026-11-10: Scaffolded repo layout, agent definitions (`.claude/agents/`), project brief (`CLAUDE.md`). Direct edit, no pipeline (config/docs).
- 2026-11-10: T1 monorepo tooling + CI merged (reviewer PASS).
- 2026-11-10: T2 D1 schema, seed, audit, idempotency merged (reviewer PASS).
- 2026-11-10: T3 design tokens + base components merged (reviewer PASS). Direct edit: dark --subtle lightened for 4.5:1.
  - Open for final review: control borders (--line) and off-switch knob below 3:1 non-text contrast; see docs/design/NOTES.md.
- 2026-11-10: T4 Google sign-in, sessions, users/roles API merged (reviewer PASS; fixed step-up refresh and callback replay).
  - Go-live check: confirm Google returns auth_time with max_age (step-up fails closed otherwise); see apps/worker/README.md.
- 2026-11-10: T5 app shell, sign-in UI, Settings/Users merged (reviewer PASS, browser-checked at 360/1280 in both themes; screenshots in docs/design/screens/).
- 2026-11-10: Phase 1 final review done: no blockers, see docs/reviews/phase-1-review.md. Fix tasks F1 (worker write pattern, errors, invite revoke/restore, cleanup), F2 (headers, deploy), F4 (contrast) started; F3 (dedupe + ADRs) follows F1.
- 2026-11-10: F1-F4 review fixes merged (atomic audit batches, headers, deploy guard, contrast tokens, shared core logic, ADRs 0003-0013). CLAUDE.md §4.0 seed wording changed (seed at first Worker start, ADR 0004).
- 2026-11-10: Phase 2 E1 (client), E2 (ExactGate, OAuth, Connections UI), E3 (sync, divisions, switcher, stopgap cron) merged with reviewer PASS. Nothing tested against real Exact: see ADRs 0014, 0016, 0017 for items to verify with credentials.
- 2026-11-11: Phase 2 review fixes G1 (resumable sync, budgets), G2 (gate: refresh rules, window limiter, EU DOs), G3 (divisions, IBAN sets/flags, dedupe, docs) merged. Review: docs/reviews/phase-2-review.md.
- 2026-11-10: ADR 0001 (Workers only), ADR 0002 (camelthorncapital.com only, no external emails in v1). Direct edit (docs).
- 2026-11-10: F3 (branch build/F3): shared auth logic moved to packages/core (roles, email, safeReturnTo), `allowedDomain` on /api/auth/me and public /api/config, auth.flow claim via idempotency helper; ADRs 0003-0013 written; CLAUDE.md 4.0 now says the admin is seeded at first Worker start.
- 2026-11-10: E2 (branch build/E2): ExactGate Durable Object (rate limit, priority, job budgets, single-flight refresh via token authority), AES-GCM token storage, Exact OAuth connect flow, Settings → Connections tab; ADR 0015 (gate design), 0016 (OAuth assumptions to verify with real credentials).

- 2026-11-10: G3 (branch build/G3), Phase 2 review fixes S4, S7-S12, N1: sync entity `relation_ibans` (no CHECK on `sync_state.entity`), every relation bank account in `relation_bank_accounts` with distinct `iban_added_at` / `iban_changed_at` flags, per-division `sync_enabled` (admin toggle, only the `/Me` division on by default), division currency read from Exact, refusal of a reconnect to a different Exact account unless confirmed, incremental open-item sync off by default (`exact.incremental_open_items`), duplicated helpers removed (`fetchCurrentMe`, shared `maskIban`, rate-limit parser, `JOB_ID_RE`, Amsterdam time in core), relations continue from their cursor each night; ADR 0019, ADR status wording, DEPLOY.md live checklist, cron check in the deploy guard.

## Open decisions (CLAUDE.md §9)
Answered: 7 (Workers only), 8 (domain only). Unanswered: 1-6 (needed from Phase 2 onward). Record answers as ADRs in `docs/decisions/`.
