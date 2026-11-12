# 0053 Payment alerts in Data quality and Today (Phase 9 final review S1 and S2, F9b)

Status: accepted for the code; **no rule has run against live payment data**. Code: `packages/core/src/dq/rules-payments.ts` (pure evaluators), `apps/worker/src/dq/load-payments.ts` (the one loader), `apps/worker/src/dq/run.ts` (global pass), `packages/core/src/today.ts` and `apps/worker/src/today/routes.ts` (queue items). Builds on ADR 0045 (rules, not-available semantics), 0046 (instant alerts), 0047 (Today), 0049 to 0051 (payments). No migration.

## Why

The Phase 9 final review found that nothing told a person about a payment that needed them: the reconciliation writes `payment_reconcile.alert_at` and nothing reads it (S1), and the Today queue knew only Exact approvals, so a payment waiting for a second person, or approved and not sent, was invisible there (S2).

## Data quality rules (S1)

Six rules, **global scope** (payments are not per administration in the alert path), filed under area `bank` (the `dq_issues.area` CHECK has no `payments` area and a migration was out of scope), ids `payments.*`. All read D1 only and are evaluated by the existing `dq.checks` job in its global pass. Every loader read is bounded (500 rows + 1, oldest first); a cut list makes the rule `truncated` so it resolves nothing.

| Rule | Severity | Raised when | Reads |
|---|---|---|---|
| `payments.outcome_unknown_old` | critical | a payment or batch has been `outcome_unknown` for more than 30 minutes | `payments` / `payment_batches` (status), `payment_events` (when the state began, else `updated_at`) |
| `payments.alert_open` | critical | a reconcile alert is open: `approved_after_expiry`, `reverted_after_paid`, `mismatch`, `duplicate`. One issue per (subject, kind); the kind is in the subject | `payment_reconcile` (`alert_at`, `last_result`) |
| `payments.paid_not_booked` | warning, threshold 3 days (1 to 30) | the bank said paid more than N days ago and the Exact side is not booked: no linked bank line, or no live match, or the match is not `matched_in_exact` for the invoice. The stage is in the payload | `payments`, `payment_bank_links`, `matches`, `match_allocations`, `payment_events` |
| `payments.ready_not_sent` | warning | status `ready` for more than 4 hours (it expires 24 hours after the request); the message gives the countdown | `payments` / `payment_batches`, `payment_events` |
| `payments.draft_waiting_long` | info past half of `payments.draft_expiry_days`, the rule's severity (warning) past 80% | a submitted draft (mode `drafts`) still not approved in the Revolut app | same, plus the setting |
| `payments.disabled_with_inflight` | warning | `payments.enabled` is not `true` and at least one request is `pending_approval`, `ready`, `submitting`, `submitted` or `outcome_unknown` | `settings`, status counts |

Top-level requests only: a payment inside a batch is judged through its batch (as the reconciliation does), so one batch is one issue.

**Not available versus ok.** With zero rows every rule is `ok`: there is nothing to be wrong about. The rules are `not_available` (`payments_not_loaded`) only when the loader failed; the run is then `partial` and no open issue is resolved. An unreadable timestamp leaves that subject `unjudged` (its issue stays).

**Instant alerts.** `payments.outcome_unknown_old` and `payments.alert_open` are critical, so the existing path (ADR 0046) mails them to admin and finance once per life of an issue. Subjects are "Payment 12" or "Batch 3" plus the alert kind: no IBAN, no beneficiary, no reference. The fix keys `payments` and `payment_approvals` map to `/treasury/bank?tab=payments` and `/purchases/approvals?tab=payments`; `safeAppPath` (e-mail links) keeps exactly the paths of `DQ_FIX_PATHS`, so these two (which carry a tab query) are not degraded to `/`, while every other query is still refused.

**Assumed column names (the only place to change them is `load-payments.ts`, constant `COLS` and the SQL strings).** `payment_reconcile(subject_kind, subject_id, last_result, alert_at)`; an alert is open while `alert_at IS NOT NULL` and `last_result` is one of the four alert kinds. No acknowledgement column exists yet: **F9a adds one** (expected `alert_ack_at`). When it lands set `COLS.alertAckAt` to its real name and an acknowledged alert drops out of the rule, and its issue resolves on the next run. Until then an alert also leaves the rule when the reconciliation next writes a different `last_result` for that subject. The rest (`payments`, `payment_batches`, `payment_events.to_status/at`, `payment_bank_links`, `matches.exact_state`) is migration 0028/0029 and stable.

**Cost.** One `db.batch` of seven statements per run. Plans are asserted: status lists use `idx_payments_status` and `idx_payment_batches_status`; the payment-event lookups use `idx_payment_events_payment`. One deliberate scan: `payment_reconcile` (one row per request that was ever sent; no index on `alert_at`, no migration allowed). It is read hourly; if it grows large, index `alert_at` in a later migration. Paid payments older than 180 days are no longer checked for booking.

## Today items (S2)

Two new kinds, `payment_approval` and `payment_ready`, in the same total order (priority, `since`, id as text); the cursor, caps and the capped-horizon logic are unchanged. Ids are `payment_approval:5`, `payment_approval:batch-2`, `payment_ready:7`, `payment_ready:batch-3`.

- `payment_approval` (priority 85, above warnings and below critical issues): requests in `pending_approval` of the chosen administration, not yet expired, **not requested by the caller**, **only for a user with the approver role**. Title "N hours waiting for a second approver", subtitle with the 24-hour countdown ("Payment 5 · expires in 22 hours"). Action: `open` (the approval sheet is in the app, the fix path is the Approvals Payments tab).
- `payment_ready` (priority 70): requests in `ready` ("approved, not sent"), created within 7 days, **only for finance**. Action: `open` (Treasury, Bank, Payments tab). The requester's rejected requests need no item.
- Other roles get `[]` actions and no such items. Without a chosen administration the kinds are listed in `notChecked` (for the roles that would see them).
- **No duplicates.** The issue of `payments.ready_not_sent` is hidden from the queue **only** for a viewer who sees that same payment as a `payment_ready` item (same payment, same administration, finance role); every other viewer still sees the issue. Done in SQL from the issue payload (`subjectKind`, `subjectId`). Other payment issues (unknown outcome, alerts, paid not booked) are not Today payment items and stay visible.
- Cost: four extra statements only for the roles that see them; each reads at most 101 rows through the status indexes (`created_at` bounds and the expiry filter keep the sorted set small). No IBAN, fingerprint, requester e-mail or beneficiary leaves the endpoint; amounts are minor units plus currency.

## Tests

Core: rule boundaries with an injected clock (30 minutes, 4 hours, 3 days, half and 80% of the expiry), thresholds, caps, adversarial inputs, privacy, reconcile (a failed read resolves nothing), ranking and cursor stability with the new ids, the role matrix. Worker: loader against real rows (including agreement with `paymentSettlement` on every stage), job runs and reruns, a failing read, the cap, query plans, the instant-alert mail, Today role matrix, expiry, batches, cursor paging with arrivals, the cap, and a mutation self-check: removing the own-request guard, the expiry guard, the batch-item guard, the administration bound, or the duplicate skip each lets a bad row through, which the invariants catch.

## Not done here (other tasks)

An acknowledge action and its audit rows (F9a), the web display of the new kinds beyond their labels (F9c), a per-user "Later" for payment items (browser only, as for all kinds).
