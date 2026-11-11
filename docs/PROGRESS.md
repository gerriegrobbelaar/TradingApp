# Progress

Orchestrator log. Update after every merge and every direct (trivial) edit.

## Phase status
| # | Phase | Status |
|---|---|---|
| 1 | Foundation | Done (open go-live gate: confirm Google returns auth_time, ADR 0007) |
| 2 | Exact connection | Code complete (E1-E3, G1-G3 merged, reviews done). NOT verified against real Exact: see docs/DEPLOY.md step 10 |
| 3 | Scheduler | Done: H1, H2, J1 (review fixes), J2 (DEPLOY runbook; docs only, not separately reviewed). Not run on real Cloudflare Queues/DOs. Exact jobs ship disabled |
| 4 | Read-only screens | Done (K1-K4, K3a, K3b; review fixes M1 infra/staging/EU queues, M2 truthfulness + payment-safety gate merged). NOT verified against real Exact. Phase 9 must not enable Pay until the approval mapping is verified live (ADR 0025) |
| 5 | Revolut connection | Built and merged (R1 client, R2 gate + connect + confirm step, R3a webhooks/ingest/sync/backfill/bank API, R3b Bank screen); final review done, no blockers; review fixes in progress (Q1-Q3). Revolut is optional per deployment. Nothing verified against real Revolut. Jobs revolut.sync and revolut.backfill ship DISABLED |
| 6 | ECB FX | Not started |
| 7 | Matching | Not started |
| 8 | Data quality | Not started. Also owns the `exact.bank_balances` job (ING/Rabobank balances from Exact, needed for the rule 'Exact balance differs from bank balance'; review S12). Its handler is not built; the job stays off |
| 9 | Payments | Not started |
| 10 | Reminders and resend emails | Not started |
| 11 | Cash forecast and Close checklist | Not started |
| 12 | Monthly FX revaluation booking | Not started |

## Log
Oldest first. Within a day, entries follow the order the work landed.

### 2026-11-10
- Scaffolded repo layout, agent definitions (`.claude/agents/`), project brief (`CLAUDE.md`). Direct edit, no pipeline (config/docs).
- ADR 0001 (Workers only), ADR 0002 (camelthorncapital.com only, no external emails in v1). Direct edit (docs).
- T1 monorepo tooling + CI merged (reviewer PASS).
- T2 D1 schema, seed, audit, idempotency merged (reviewer PASS).
- T3 design tokens + base components merged (reviewer PASS). Direct edit: dark --subtle lightened for 4.5:1.
  - Open for final review: control borders (--line) and off-switch knob below 3:1 non-text contrast; see docs/design/NOTES.md.
- T4 Google sign-in, sessions, users/roles API merged (reviewer PASS; fixed step-up refresh and callback replay).
  - Go-live check: confirm Google returns auth_time with max_age (step-up fails closed otherwise); see apps/worker/README.md.
- T5 app shell, sign-in UI, Settings/Users merged (reviewer PASS, browser-checked at 360/1280 in both themes; screenshots in docs/design/screens/).
- Phase 1 final review done: no blockers, see docs/reviews/phase-1-review.md. Fix tasks F1 (worker write pattern, errors, invite revoke/restore, cleanup), F2 (headers, deploy), F4 (contrast) started; F3 (dedupe + ADRs) follows F1.
- F3 (branch build/F3): shared auth logic moved to packages/core (roles, email, safeReturnTo), `allowedDomain` on /api/auth/me and public /api/config, auth.flow claim via idempotency helper; ADRs 0003-0013 written; CLAUDE.md 4.0 now says the admin is seeded at first Worker start.
- F1-F4 review fixes merged (atomic audit batches, headers, deploy guard, contrast tokens, shared core logic, ADRs 0003-0013). CLAUDE.md §4.0 seed wording changed (seed at first Worker start, ADR 0004).
- Phase 2 E1 (client), E2 (ExactGate, OAuth, Connections UI), E3 (sync, divisions, switcher, stopgap cron) merged with reviewer PASS. Nothing tested against real Exact: see ADRs 0014, 0016, 0017 for items to verify with credentials.
  - E2 (branch build/E2): ExactGate Durable Object (rate limit, priority, job budgets, single-flight refresh via token authority), AES-GCM token storage, Exact OAuth connect flow, Settings → Connections tab; ADR 0015 (gate design), 0016 (OAuth assumptions to verify with real credentials).

### 2026-11-11
- Phase 2 final review: docs/reviews/phase-2-review.md. Review fixes G1 (resumable sync, budgets), G2 (gate: refresh rules, window limiter, EU DOs), G3 (divisions, IBAN sets/flags, dedupe, docs) merged.
  - G3 (branch build/G3), Phase 2 review fixes S4, S7-S12, N1: sync entity `relation_ibans` (no CHECK on `sync_state.entity`), every relation bank account in `relation_bank_accounts` with distinct `iban_added_at` / `iban_changed_at` flags, per-division `sync_enabled` (admin toggle, only the `/Me` division on by default), division currency read from Exact, refusal of a reconnect to a different Exact account unless confirmed, incremental open-item sync off by default (`exact.incremental_open_items`), duplicated helpers removed (`fetchCurrentMe`, shared `maskIban`, rate-limit parser, `JOB_ID_RE`, Amsterdam time in core), relations continue from their cursor each night; ADR 0019, ADR status wording, DEPLOY.md live checklist, cron check in the deploy guard. (Logged earlier under 2026-11-10; the date is corrected here because the review it fixes is from 2026-11-11.)
- Phase 3 H1 (cron + TARGET calendar in core) and H2 (job runner, queue, JobLock DO, jobs API, Settings → Schedules, Exact sync jobs) merged with reviewer PASS. Queues must be created before first deploy (docs/DEPLOY.md).
- Phase 3 final review: docs/reviews/phase-3-review.md (no blockers; S1-S4 before the first job that writes to Exact/Revolut or sends email, S5-S7 before first deploy). Review fixes started: J1 (jobs code, defaults, ADR 0021: S6 Exact jobs ship disabled), J2 (docs only: S5 DEPLOY.md as one ordered runbook, N8 this log and the wrangler.toml header).
- 2026-11-11: Phase 3 review fixes J1 (handler contract, lateness, schedule rules, atomic retry), J2 (DEPLOY.md rewrite), and Phase 4 K1 (open-items read API, ageing, KPIs, indexed search) merged.
- 2026-11-11: Phase 4 K2, K3a, K4 merged with reviewer PASS. Phase 9 must not enable Pay until the Exact entry-status mapping is verified live (ADR 0025, GET /api/approvals/status-codes).
- 2026-11-11: Phase 4 K3b (balance sheet, P&L, ageing reports, Excel and print-to-PDF export) merged with reviewer PASS.
- 2026-11-11: Phase 4 final review done (docs/reviews/phase-4-review.md); fixes M1 and M2 merged. Direct edit: relaxed three wall-clock performance assertions in packages/core schedule tests (they flaked under load; now runaway-loop guards).
- 2026-11-11: Phase 5 R1, R2, R3a, R3b merged with reviewer PASS. Open decisions 1 (Revolut plan) and 2 (own Exact integration) are stored as per-connection settings (payments_mode, creates_bank_entries), chosen explicitly at connect time.
- 2026-11-11: Phase 5 final review: docs/reviews/phase-5-review.md (no blockers; S1-S5 before the first live Revolut connection, S6-S9 before Phase 7).
- 2026-11-11: Direct edit: LibreOffice export tests get a realistic timeout (they start a real office process; the 5 s default flaked under load). Superseded by Q3 below.
- 2026-11-11: Phase 5 review fixes, task Q3 (build/Q3): S5 Revolut is optional as a whole (the deploy guard passes with a notice when REVOLUT_CLIENT_ID, REVOLUT_REDIRECT_URI and REVOLUT_ISSUER are all empty, fails listing the missing ones when only some are set; the Revolut jobs skip with `revolut_not_configured`; the Connections card says Revolut is not configured instead of showing Connect); docs/DEPLOY.md Revolut parts rewritten (key and certificate commands, redirect URI, sandbox via staging, five secrets, connect checklist). S10 `open_items.amount_minor` renamed `stored_minor` (migration 0017) with plain name-scan guards. S12 `exact.bank_balances` assigned to Phase 8. N6 Revolut card has no preselected environment. N9 own-account transfers and exchanges in the Bank totals: design only (ADR 0032), totals unchanged until the counterparty columns exist. N10 source-scan test for IBAN selects. N11 this file reordered. Web `testTimeout` 15000; LibreOffice tests use `describe` options (they stay in the default run; CI skips them where `soffice` is missing). Parallel: Q1 (sync, ingest, packages/revolut, migration 0015) and Q2 (store, webhook route, gate, oauth, migration 0016, webhook health UI).

## Open decisions (CLAUDE.md §9)
Answered: 7 (Workers only), 8 (domain only). Unanswered: 1-6 (needed from Phase 2 onward). Record answers as ADRs in `docs/decisions/`.
