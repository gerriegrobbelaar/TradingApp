# Phase 5 (Revolut connection) final review — condensed
Reviewed at 18df746 (+729a478 test timeout). Typecheck, lint, 2,859 tests x3 (no flakes), core 99.5% / revolut 99.8% coverage, web build, dry-runs (default + staging), Playwright screens 62/62, migrations 0001–0014 applied in order to DBs seeded at 8 phase points (0 FK violations) all pass. **No blocking findings; ready for Phase 6.** Nothing verified against real Revolut/Cloudflare/Exact/Google. S1–S5 before the first live Revolut connection; S6–S9 before Phase 7.

## Should fix (before first live Revolut connection)
- S1 90-day initial backfill silently becomes a 35-day walk if its first page fails (`requested_days` cleared at start, resumable only with a cursor); treat window_from IS NOT NULL as in progress, clear on completion; test.
- S2 One unparseable transaction stops poll and backfill indefinitely (mapTransaction throws for the whole page → permanent bad_shape, cursor never advances, pending refresh skipped): map per row, quarantine bad id (ids/code only), continue, end partial with a code.
- S3 Rotating TOKEN_ENC_KEY breaks webhooks silently (webhook_secret_enc/_prev_enc never re-encrypted): re-encrypt with the current key; fix DEPLOY.md 'Rotating secrets'.
- S4 No health signal for the webhook channel: last_webhook_verified_at, rejected counter, sweep of stale `queued` rows, webhook_events retention (ADR 0011).
- S5 DEPLOY.md cannot be followed for Revolut (guard refuses empty REVOLUT_CLIENT_ID but Step 0 has no Revolut row; no key/cert commands, redirect URI registration, sandbox step; staging section omits REVOLUT_* vars/secret/RevolutGate; contradiction about wrangler dev/tunnel; 'four secrets' is five). Decision taken: Revolut is OPTIONAL as a whole (all-empty passes with a warning; partial config fails).

## Should fix (before Phase 7)
- S6 Stored transaction lacks fee, leg balance, counterparty id/account_id/account_type, reason_code, bill_amount/currency, masked card; counterparty IBAN may always be NULL (leg counterparties carry only ids) → rule 2 needs a counterparty lookup (`GET /counterparty/{id}` not on gate allow-list): add columns, verify on sandbox, ADR.
- S7 Legs without account_id dropped without trace; blocked state changes count only: report, end partial, flag row.
- S8 404 right after TransactionCreated is final: retry a couple of times with delay.
- S9 Matched rows can change under Phase 7: freeze/flag money fields once match_status != unmatched.
- S10 Amount guard breaks on first matching query: rename open_items.amount_minor (e.g. stored_minor), simplify guard.
- S11 Gates ~half the same code (≈450 of 836 lines): extract shared gate core before Phase 9.
- S12 `exact.bank_balances` labelled Phase 5 but not built; assign phase (Phase 8 needs it for 'Exact balance ≠ bank balance').

## Nice to have
N1 webhook route reads body/D1 before cheap checks; N2 overlapping deliveries both enqueue; N3 stale cursor survives disconnect/re-auth, old-account rows stay under the same connection after replacesAccounts; N4 fillBankDetails marks 'no IBAN' forever after a permanent error, takes first IBAN; N5 ADR 0031/0033 stale text; N6 connect UI preselects production; N7 stalled initial backfill only visible in Schedules; N8 no stored refresh-token expiry date; N9 own-account transfers/exchanges count in In/Out totals; N10 no source-scan guard for unmasked IBAN selects; N11 PROGRESS log placement.
Tests: raise web testTimeout to 15000 (six tests take 2.5–3.1 s unloaded); LibreOffice tests use describe options and their own project.

## Questions for the user (ranked)
1 staging deploy with Revolut sandbox + Exact test division (gates trust in Phases 2–5, precedes Phase 7); 2 decision 2 (own Exact integration on? Phase 7); 3 decision 1 (Revolut plan Company? re-consent every 90 days? Phase 9); 4 deploy guard may allow first deploy without Revolut — DONE (optional); 5 decision 6 four-eyes limit/approvers/who pays and locks; are first-sync IBANs trusted without a second approver?; 6 decision 3 currencies/FX result account/reversal (Phase 6 needs the currency list); 7 decision 4 ECB accepted by accountant; 8 decision 5 reminders; 9 monthly Revolut transaction volume and when to build ING/Rabobank balances from Exact.
