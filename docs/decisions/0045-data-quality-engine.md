# 0045 Data quality engine: rules, fingerprints, not-available semantics, storage (Phase 8, D8a)

Status: accepted for the code; **no rule has run against live data**. Code: `packages/core/src/dq/` (types, util, rules-bank, rules-relations, rules-system, registry), `apps/worker/src/dq/` (load, store, run, routes), `apps/worker/src/exact/bank-balances.ts`, migration `0026_data_quality.sql`, API types in `packages/core/src/api-types.ts` (Dq*), phrase `DQ_LOOSEN_PHRASE`. CLAUDE.md 4.6 is the brief. The screens (Data health, Today) came in D8c, see ADR 0047.

## What was built

- **27 rules** in seven areas, each a pure definition in `packages/core`: id (`area.name`), area, scope (`division` runs once per synchronised administration, `global` once per run), default severity, threshold spec, title, description, a **fix target** (a key; `DQ_FIX_PATHS` maps it to a web route) and `evaluate(input, config)`. Evaluators do no I/O, work in integer minor units and return issues with a **fingerprint** `ruleId:subjectKey`.
- **Job `dq.checks`** (the registry key and the existing default job row keep the name from Phase 3, not `dq.check`): hourly at :20, reads **D1 only** (no Exact, no Revolut call; a source scan enforces it), evaluates, reconciles and records the run. It ships **enabled on new installs** (D1 only); an existing row keeps its stored `enabled` (the seeding never flips a row), so on an existing deployment an admin switches it on (docs/DEPLOY.md).
- **Job `exact.bank_balances`** (was a placeholder): reads the balance of each mapped bank ledger account from Exact and stores it on `bank_accounts.exact_balance_minor/_at`. Ships **disabled** (`awaiting_live_verification`).
- **API** `/api/dq/summary`, `/api/dq/issues`, `POST /api/dq/issues/:id/snooze` and `/resolve-note`, `GET /api/dq/rules`, `PATCH /api/dq/rules/:id`.

## The rules

| Rule id | Area, severity | Threshold | Needs | Behaviour |
|---|---|---|---|---|
| `bank.balance_mismatch` | bank, warning | tolerance 100 minor | `bank_accounts.balance_minor` and `exact_balance_minor` | Issue when the two differ by more than the tolerance. Compared only when the Exact read is at most 36 h old and the two reads are at most 3 h apart; otherwise skipped, and with nothing comparable the rule is `not_available` (`no_comparable_exact_balance`). |
| `bank.unmatched_old` | bank, warning | 5 days | completed final lines, `match_status` unmatched/suggested | One issue per line older than N days (oldest first, capped). |
| `bank.duplicate_lines` | bank, warning | none | lines of the last 60 days | Same account, amount, currency, UTC day, counterparty (Revolut counterparty ref, else name) and reference (both non-empty). Key = the lowest line id. |
| `bank.booked_line_reverted` | bank, critical | none | matches `matched_in_exact` | Booked match whose line later became `reverted` or got `state_conflict` (Phase 7 S10). |
| `bank.stale_settlements` | bank, warning | count 0 | `staleSettlements(db, now, division)` | Allocations still counting 48 h after booking (Phase 7 S5). One issue per division with the count. |
| `bank.booking_outcome_unknown` | bank, critical | count 0 | outbox rows | Outcome unknown. |
| `bank.booking_manual_required` | bank, warning | count 0 | outbox rows | Needs a person. |
| `bank.already_matched_in_exact` | bank, warning | count 0 | matches `exact_note` | Legacy note; kept for old rows. |
| `payables.duplicate_invoices` | payables, warning | none | open bills | Same supplier and normalised invoice number (NFKC, case folded, spaces/dashes/slashes dropped); without a number, same supplier, currency, stored amount and invoice date. **Only open bills are compared**: `open_items` holds Exact's open list, not paid history. |
| `payables.missing_pdf` | payables, info | 90 days (1 to 365; the loader reads 400) | `purchase_entries.has_pdf` | `has_pdf = 0` on non-rejected entries of the last N days. **Not available** (`document_flag_not_synced`) when no entry has the flag (the `Document` field was never seen). |
| `payables.supplier_iban_changed` | payables, **critical** | 30 days | `relations.iban_changed_at/iban_added_at` | A supplier whose IBAN changed, or got a first IBAN while already known, in the last N days. Snooze to the end of the window once verified. |
| `payables.approvals_overdue` | payables, warning | 3 days | `purchase_entries` pending | Waiting since `submitted_at`, else `modified_at`, else `entry_date`. |
| `receivables.customer_no_email` | receivables, warning | none | customers with open invoices | Blank e-mail. |
| `receivables.bounced_emails` | receivables | none | e-mail log | **Always not_available** (`email_log_empty_until_phase_10`). |
| `receivables.disputed_chased` | receivables | none | dispute flag, reminders | **Always not_available** (same reason). |
| `master.supplier_no_iban` | master data, warning | none | suppliers with open bills | No active row in `relation_bank_accounts`. (Not `relations.iban`: reading IBAN columns here would need the IBAN-select allow-list; the table is filled for every relation bank account, ADR 0019.) |
| `master.eu_customer_no_vat` | master data, info | none | customers with open invoices, `country`, `vat_number` | EU-27 country (Greece as `GR` or `EL`) or `XI` (Northern Ireland) and blank VAT number. Private customers have none: a prompt, not an error. |
| `master.vat_code_country` | master data | none | VAT code of invoice lines | **Always not_available** (`vat_code_not_synced`): the sync reads no VAT codes. |
| `fx.rate_stale` | fx, warning, global | none | `fx_rates` | `fxStaleness()` of the newest rate (the Phase 6 rule, not re-derived). |
| `fx.currency_without_rate` | fx, critical | none | open items by currency | A foreign currency the ECB table cannot price (`currenciesWithoutRate`). One issue per currency. |
| `fx.item_without_booked_rate` | fx, info | none | open items | Foreign items with neither a booked rate nor a booked division-currency amount; one issue per currency. |
| `fx.rate_conflicts` | fx, warning, global | none | `fx_rate_conflicts` | One issue per unresolved conflict. |
| `ledger.suspense_not_zero` | ledger, warning | list of GL codes, default **empty** | `gl_accounts`, `gl_balances` | `not_configured` while the list is empty; `not_available` while the division's balances were never read; else a non-zero balance (debit minus credit, `LEDGER_BALANCE_SEMANTICS`) is an issue, and a configured code the chart does not have is an issue too (unknown is not zero). |
| `ledger.closed_period_bookings` | ledger, critical | none | a closed-period marker | **Always not_available** (`no_closed_period_marker`): nothing in the schema says which periods are locked. Phase 11 (Close) adds the marker; the evaluator already handles rows. |
| `integrations.job_stale` | integrations, warning, global | 2 x interval | `jobs`, `job_runs` | Enabled, implemented job whose last `ok` run is older than N x its schedule interval (computed with `nextRun`); never succeeded: counted from the first run. Skipped runs are not successes. The issue carries the last status and code. |
| `integrations.webhook_failures` | integrations, warning, global | 5 / 24 h | `webhook_rejections`, `webhook_events` | Rejected deliveries plus events ending `error` in the last 24 h. `not_configured` without an active Revolut connection. |
| `integrations.exact_connection` | integrations, **critical**, global | 7 days | `connections` | Status not active, credentials rejected, or the refresh token expires within N days (`refresh_expires_at`). |
| `integrations.exact_budget` | integrations, warning | 500 calls | `exact_usage` | Remaining calls today below N: the lower of 5,000 minus our count and Exact's last reported remaining. Today is the **UTC** day, the key ExactGate writes `exact_usage` under (review D8a: the Amsterdam date found no row between midnight in Amsterdam and midnight UTC and read 0 calls). |

## Fingerprints and idempotence

`fingerprint = ruleId + ":" + subjectKey`. The subject key is built from **stable ids** (bank line id, relation id, match id, currency, GL code, job name) and falls back to a hash when it would contain other characters, so a unicode name or a long invoice number is still stable. It never contains an IBAN, an amount that moves, or a timestamp. `UNIQUE (division_id, fingerprint)`; `division_id = 0` is global. A rerun of the same data therefore finds the same rows.

`planReconcile` (pure, in core) turns results plus stored issues into a plan:

- reported, unknown -> insert; reported, open -> refresh (`last_seen_at`, severity, text, payload);
- reported, **resolved** -> the explicit **reopen** path: status open, `resolved_*` cleared, `reopen_count + 1`, `notified_at` cleared;
- reported, **snoozed**: while `snoozed_until` is in the future only last_seen and text move; once it has passed (or cannot be read) the issue is open again (`unsnooze`);
- not reported and open/snoozed -> resolved by `system`, **but only when the rule really vouched**: status `ok` or `issues` and **not truncated**. A rule that was `not_available`, `not_configured`, `disabled`, `error`, or cut its list at the cap (500 per rule) resolves nothing. Tested at core and Worker level (a failing section, a disabled rule, a stale Exact balance).
- **Partial coverage (review D8a)**: a rule that judged some subjects but not others lists the fingerprints it could not judge in `unjudged`; their issues are left alone. Used for an account whose Exact read is stale or missing or whose two reads drifted apart (`bank.balance_mismatch`, while another account is compared), an entry whose document flag was not seen (`payables.missing_pdf`), a date that cannot be read (`bank.unmatched_old`, `payables.approvals_overdue`) and a job whose schedule cannot be read (`integrations.job_stale`; a job switched off IS resolved). Not seeing a problem is not proof that it is gone.
- **Loader caps (review D8a)**: no input list may be silently cut. Open items (20,000), purchase entries (20,000) and relations (50,000) above their cap make the section `null` (rules `not_available`); the duplicate look-back window (5,000 lines) above its cap marks `bank.duplicate_lines` truncated; the unmatched-line (1,000), booked-match (1,000) and ECB-conflict (501) lists are longer than the 500 issue cap, so a full list makes the rule truncated.

Every change is conditional on the status the plan saw (`WHERE id = ? AND status = ?`), the insert is an upsert that does not touch a resolved row, and the `dq_runs` row is keyed by `job_run_id`: a repeated or overlapping execution (handler contract) neither duplicates nor corrupts. The contract test runs the job twice. Resolved issues older than 180 days are deleted by every run; open and snoozed ones cannot be deleted (trigger).

## Not available, not configured, never ok

`DqRuleResult.status` is one of `ok`, `issues`, `not_available`, `not_configured`, `disabled`, `error`. A rule says `not_available`/`not_configured` with a machine reason whenever the data it needs is missing: an input section that failed to load (`*_not_loaded`), an empty or never-read source, a flag the sync never saw, a feature that does not exist yet. It never says `ok`. `dq_rule_status` stores status and reason per (division, rule) (a CHECK requires a reason for every status except ok/issues), and `GET /api/dq/summary` shows all 27 rules, `never_run` before the first run. A section that throws makes the run `partial` (`section_failed`), never a guess.

## What data is missing (so the rule is not available or reduced)

1. **ING and Rabobank.** `bank_accounts` holds Revolut accounts only. The brief's "Bank balances from Exact (ING, Rabobank)" has no second number to compare with, so `exact.bank_balances` covers **mapped Revolut accounts** (ledger account via `bank_account_exact_map`). Showing ING/Rabobank balances needs `bank_accounts` rows with an Exact-sourced kind: a later task.
2. **Missing PDF** depends on `PurchaseEntries.Document` (ADR 0025); when Exact does not return it the flag is null and the rule stays not available.
3. **VAT code vs country**: VAT codes are not synced.
4. **Bounced e-mails, disputed invoices still chased**: no e-mail log or dispute flag before Phase 10.
5. **Closed period**: no marker (Phase 11).
6. **Suspense accounts**: no default; an admin lists GL codes.
7. **Duplicate supplier invoices** see only open bills.

## Settings (overrides)

`dq_rules` stores only OVERRIDES keyed by the rule id in code: `enabled`, `severity` (null = default), `threshold_json` (`{"value": n}` or `{"codes": [...]}`, null = default), `rev`, `updated_by/at`. A stored value that fails the rule's spec is ignored (default). `PATCH /api/dq/rules/:id` (admin, **step-up**) takes `{enabled?, severity?, threshold?, confirm?, rev}`: `rev` is the revision the editor read (null = never overridden), a stale one is 409; a PATCH that changes nothing writes nothing. **Loosening a rule whose effective severity is critical needs `confirm = DQ_LOOSEN_PHRASE`** (422 `confirmation_required`): switching it off, lowering its severity, or moving a threshold so that less is reported (more days/factor/count/tolerance is looser; for the `calls` unit, fewer is looser; removing a suspense code is looser). Tightening and warning/info rules need no phrase. **Direction is per rule** (`DqThresholdSpec.looser`, review D8a): an age limit, a tolerance, a factor or a count loosens when it goes UP; a look-back window (`payables.supplier_iban_changed`, `payables.missing_pdf`: "in the last N days"), a warning lead time (`integrations.exact_connection`: "expires within N days") and the remaining-calls floor loosen when they go DOWN. Every PATCH is judged against the stored setting, so a series of small steps needs the phrase every time; once an admin has lowered a critical rule's severity (with the phrase) it is no longer critical and later edits need none, which is the intended trade-off. Each change is one batch of change + audit row (`dq.rule_changed`, before/after), conditional on `changes() = 1`.

## Issues: snooze and resolve

`POST .../snooze {until, note}` (finance or admin): `until` between one minute and 90 days ahead, note 1 to 200 characters, only for an **open** issue. `POST .../resolve-note {note}` resolves an open or snoozed issue. Notes are masked (IBAN-like text) before they are stored, audited or returned (review D8a). Both are audited in the same batch (`dq.issue_snoozed`, `dq.issue_resolved`) with an audit guard on `changes() = 1`; an identical repeat by the same person answers 200 with the same issue and writes no second row, anything else is 409 (`not_open`, `already_resolved`). CSRF is the router's header rule. **A person's resolve does not silence a problem that is still there**: the next run reopens it (count + 1). To accept a known condition, snooze it (at most 90 days) or disable/adjust the rule.

## Guards (migration 0026, hashes in `trigger-hashes.json`)

`dq_issues_identity` (rule, division, fingerprint, first_seen_at immutable), `dq_issues_reopen_path` (a resolved issue becomes open/snoozed only in a statement that raises `reopen_count` by exactly one), `dq_issues_counter` (the count never goes down), `dq_issues_keep_live` (only resolved rows can be deleted). Plus CHECKs: status agrees with `resolved_at`/`snoozed_until`; severity/area/status sets; integer money; `payload_json` valid JSON of at most 4,000 characters; `dq_rule_status` needs a reason unless ok/issues. `dq_issues`/`dq_rules` from migration 0003 were never written and are replaced (dropped and recreated).

## Privacy

Issue subject and message are cleaned (control and bidi characters out, whitespace collapsed, capped at 80 and 240 characters, IBAN-like text masked by the core masker) when built, and passed through the audit masker again when stored; text that still looks like an IBAN is replaced by `[redacted]`. The API masks once more. Payloads hold small non-secret facts (counts, ids, codes). Duplicate bank lines are grouped on the Revolut counterparty reference or the name, so no IBAN column is read by this feature (`iban-select-guard` needs no new allow-list entry; a source scan in `dq-guards.test.ts` checks it, and checks that the DQ code makes no Exact/Revolut call, logs no rows and has no float).

## `exact.bank_balances` details and A-items (all UNVERIFIED against a live Exact)

- Per mapped, active account whose currency is the division currency and whose ledger code (`bank_account_exact_map.bank_gl_account_code`) is in our copy of the chart: one `financial/ReportingBalance` read with `$filter=GLAccount eq guid'…' and ReportingYear eq <year>` (client option `glAccountId`, GUID-checked), up to 3 pages. The balance is the sum of periods 0..99 of the current Amsterdam year (`LEDGER_BALANCE_SEMANTICS`, ADR 0024). An empty answer (a filter Exact ignored would look the same), more than 3 pages (fewer when the run's budget has less left), or **any row of another ledger account** (Exact ignored the `GLAccount` filter; code `other_account_rows`, run `partial`) stores nothing. Oldest balance first; stops at the budget (20 calls), the deadline, a rate limit, an auth failure or an unavailable Exact; the next run continues with the rest.
- **A-1** `GLAccount eq guid'…'` is accepted in a `ReportingBalance` filter next to `ReportingYear`. **A-2** The sum of period rows is the ledger balance (period 0 = brought-forward; ADR 0024 item 2). **A-3** Exact's ledger balance of a bank account is comparable to the bank's live balance: lines not yet imported/booked explain differences, which is why the rule is a warning with a tolerance and a freshness guard. **A-4** The daily call budget is 5,000 per administration (`DEFAULT_LIMITS.perDay`).
- Cost per day at the default hourly schedule: at most 24 x (mapped accounts) calls, under the 20-call budget per run.

## Not done here

The screens (Data health, Today queue: done in D8c, ADR 0047), the daily digest and instant alerts (done in D8b, ADR 0046), Cloudflare cron wiring beyond the existing scheduler, ING/Rabobank balances, retention of `dq_runs` (small; one row per run, add to housekeeping if it grows), and a per-user "assigned to" field.
