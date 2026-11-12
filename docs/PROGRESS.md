# Progress

Orchestrator log. Update after every merge and every direct (trivial) edit.

## Phase status
| # | Phase | Status |
|---|---|---|
| 1 | Foundation | Done (open go-live gate: confirm Google returns auth_time, ADR 0007) |
| 2 | Exact connection | Code complete (E1-E3, G1-G3 merged, reviews done). NOT verified against real Exact: see docs/DEPLOY.md step 10 |
| 3 | Scheduler | Done: H1, H2, J1 (review fixes), J2 (DEPLOY runbook; docs only, not separately reviewed). Not run on real Cloudflare Queues/DOs. Exact jobs ship disabled |
| 4 | Read-only screens | Done (K1-K4, K3a, K3b; review fixes M1 infra/staging/EU queues, M2 truthfulness + payment-safety gate merged). NOT verified against real Exact. Phase 9 must not enable Pay until the approval mapping is verified live (ADR 0025) |
| 5 | Revolut connection | Done (R1-R3b, review fixes Q1-Q3 merged). NOT verified against real Revolut. Jobs revolut.sync / revolut.backfill ship DISABLED. Revolut is optional for a first deploy |
| 6 | ECB FX | Done (F1-F3, review fixes T1 booked amount/rate tables/rate conflicts, T2 error boundaries/wording/stale handling). ecb.fx_import ON by default. Unrealised difference is dormant until the Exact booked-amount source is verified live (ADR 0038, DEPLOY.md item 17). Decision 4 still open |
| 7 | Matching | Done: M7a–M7e built, final review fixes U1 (booking path), U2 (matching safety), U3 (web/docs/tests) merged on 2026-11-12; full suite green (ui 257, core 854, exact 258, revolut 151, web 1358, worker 2001). Booking and automatic matching are OFF by default; NOT verified against real Exact |
| 8 | Data quality | In progress (D8a rules engine + bank balances job, D8b alerts + digest, D8c Data health + Today screens). Also owns the `exact.bank_balances` job (ING/Rabobank balances from Exact, needed for the rule 'Exact balance differs from bank balance'; review S12). Its handler is not built; the job stays off |
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
- Phase 3 review fixes J1 (handler contract, lateness, schedule rules, atomic retry), J2 (DEPLOY.md rewrite), and Phase 4 K1 (open-items read API, ageing, KPIs, indexed search) merged.
- Phase 4 K2, K3a, K4 merged with reviewer PASS. Phase 9 must not enable Pay until the Exact entry-status mapping is verified live (ADR 0025, GET /api/approvals/status-codes).
- Phase 4 K3b (balance sheet, P&L, ageing reports, Excel and print-to-PDF export) merged with reviewer PASS.
- Phase 4 final review done (docs/reviews/phase-4-review.md); fixes M1 and M2 merged. Direct edit: relaxed three wall-clock performance assertions in packages/core schedule tests (they flaked under load; now runaway-loop guards).
- Phase 5 R1, R2, R3a, R3b merged with reviewer PASS. Open decisions 1 (Revolut plan) and 2 (own Exact integration) are stored as per-connection settings (payments_mode, creates_bank_entries), chosen explicitly at connect time.
- Phase 5 final review: docs/reviews/phase-5-review.md (no blockers; S1-S5 before the first live Revolut connection, S6-S9 before Phase 7).
- Direct edit: LibreOffice export tests get a realistic timeout (they start a real office process; the 5 s default flaked under load). Superseded by Q3 below.
- Phase 5 review fixes, task Q3 (build/Q3): S5 Revolut is optional as a whole (the deploy guard passes with a notice when REVOLUT_CLIENT_ID, REVOLUT_REDIRECT_URI and REVOLUT_ISSUER are all empty, fails listing the missing ones when only some are set; the Revolut jobs skip with `revolut_not_configured`; the Connections card says Revolut is not configured instead of showing Connect); docs/DEPLOY.md Revolut parts rewritten (key and certificate commands, redirect URI, sandbox via staging, five secrets, connect checklist). S10 `open_items.amount_minor` renamed `stored_minor` (migration 0017) with plain name-scan guards. S12 `exact.bank_balances` assigned to Phase 8. N6 Revolut card has no preselected environment. N9 own-account transfers and exchanges in the Bank totals: design only (ADR 0032), totals unchanged until the counterparty columns exist. N10 source-scan test for IBAN selects. N11 this file reordered. Web `testTimeout` 15000; LibreOffice tests use `describe` options (they stay in the default run; CI skips them where `soffice` is missing). Parallel: Q1 (sync, ingest, packages/revolut, migration 0015) and Q2 (store, webhook route, gate, oauth, migration 0016, webhook health UI).
  - Q3 review: the deploy guard compares Revolut values trimmed (as the Worker does), refuses non-string values and a REVOLUT_CLIENT_ID shared between environments; the Worker treats non-string Revolut settings as missing; unconfigured-Revolut tests pin each route's answer (webhook: the same 401 as a configured deployment; bank API: `available: false`) and no logging from skipped jobs; the IBAN select guard reads IBAN tables and columns from the migrated schema and is case-, quote- and RETURNING-aware; the stored_minor guard also refuses `SELECT *` from open_items; the Revolut card asks for the environment on re-authorise when none is recorded; r2 screenshots regenerated (new state: Revolut not configured). When Q1 lands, its new IBAN readers must be added to the IBAN guard allow-list.
- 2026-11-11: Phase 6 F1, F2, F3 merged with reviewer PASS; Phase 6 final review: docs/reviews/phase-6-review.md. Direct edits: relaxed wall-clock bounds in ecb.adversarial tests; added the ECB section to docs/DEPLOY.md.
- 2026-11-11: Phase 6 final review + fixes T1/T2 merged; full suite green (ui 252, core 680, exact 162, revolut 151, web 1017, worker 1468). Phase 7 started.
- 2026-11-11 (Phase 7 build, in order, each merged with reviewer PASS): M7a pure matching engine in packages/core (ADR 0040, 0041); M7e Exact payload builders and the call-time write guard (ADR 0040); M7b bank matching worker, migration 0022, API (ADR 0042); M7c fail-closed booking to Exact, outbox, executor job, migration 0023 (ADR 0044); M7d matching screens and the Booking card (ADR 0043). Review rounds of each followed on the same day.
- 2026-11-11: Phase 7 M7a–M7e merged with reviewer PASS (full suite: ui 257, core 792, exact 258, revolut 151, web 1272, worker 1813). Phase 7 final review found B1/B2 (booking path) and S1–S10; fix tasks U1–U3 started. Defaults chosen: incoming payments from an unknown IBAN go to review; Revolut lines with a fee are refused for booking in v1.
- 2026-11-12: Phase 7 fix task U3 (build/U3-web, on top of U1 and U2): web for the booking path (verification checklist with the runbook text from one constant, Preview booking with the exact bodies and hashes, Enable dialog that saves the limits then switches on and re-reads first, signed opening balance and control accounts in the account map, deferral and preview wording checked against the worker source), lazy screens with a retry card for a chunk that fails to load, loosening phrase for threshold and pattern saves while automatic matching is on (U2), source scan against small elapsed-time bounds. Integration fixes on the merge: migration 0025's redaction exception also pins the 0024 outbox columns; the settings answer gains `backlogIfEnabledNow`.
- 2026-11-12: U3 merged onto the integration branch (U1 review + U2) on merge/u3-into-integration: migrations and the 26 trigger hashes are the U1-review side (a strict superset of U3's guards); the Enable dialog now sends ONE call `{enabled, confirm, divisions?, maxPerRun?}` (server writes limits, guarded switch and watermark in one batch); settings answer keeps both `proposed` and `backlogIfEnabledNow`; DEPLOY item 18 step 6 merged by hand. Full suite: ui 257, core 854, exact 258, revolut 151, web 1360, worker 2001; screens suites 183; five mutation spot checks (delete guard, preflight, watermark, settlement aggregate, enable phrase) each fail tests.

- Before Phase 9 (Phase 5 S11, Phase 6 N7, Phase 7 N8): the Revolut gate and the Exact gate share roughly 450 lines (queueing, budgets, token handling, write policy). Refactor them to one shared core in packages/ before any payment path is added, so a payment safeguard is fixed in one place.

## Open decisions (CLAUDE.md §9)
Answered: 7 (Workers only), 8 (domain only). Unanswered: 1-6 (needed from Phase 2 onward). Record answers as ADRs in `docs/decisions/`.
