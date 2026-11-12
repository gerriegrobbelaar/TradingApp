# 0052 Phase 9 final review: worker payment safety fixes (F9a)

Status: accepted, built on `build/F9a-payment-safety`. Follows ADR 0049 (foundation), 0050 (Revolut
execution), 0051 (screens) and the condensed final review `docs/reviews/phase-9-review.md`. The web
half (B1, B2 labels and screens, S2) is F9c, the data-quality and Today half (S1 rules, S2) is F9b.

Principle for every item below: **fail closed on doubt.** Where the code used to believe a refusal,
a "not found" or a "completed" on thin evidence, it now keeps the request where it is and tells a
person.

## What changed

### B3 Double-payment guards

- **(a) The earlier-attempt check is never cut off** (`revolut-submitter.ts`, `priorAttempts`). It
  looks at no more than `MAX_PRIOR_ROWS` = 200 earlier rows and `MAX_PRIOR_DRAFTS` = 20 distinct drafts;
  one row more (or one draft more) answers `prior_attempt_unchecked` and nothing is created. Rows are
  deduplicated by DRAFT before any lookup (the items of one bulk draft share one lookup), so a long
  batch can no longer push a live draft out of a `LIMIT 20`.
- **(b) A 4xx on `POST /payment-drafts` is believed only after a readable list** (`adoptDraft` is
  three-valued). A list that cannot be read, or that shows two drafts with our title, is `unknown`
  (reconciliation looks again and raises `duplicate`); only a readable list with no draft of ours makes
  the refusal a `rejected`. Exactly one draft is adopted as before.
- **(c) "Not found" never fails a known draft** (`reconcile.ts`, `viaDraft`). A draft we hold an id for
  that answers 404 stays `submitted` and raises the alert `draft_gone`, whatever the bank feed says.
  Review F9a: the reconciliation never fails it on its own (the builder's version failed it automatically
  on "evidence"; but the balance is read before the transactions, so a fresh balance did not prove the
  lines were read, and a failed request makes the invoice payable again). An ADMIN ends it with
  `resolveNotSent` (`POST .../resolve-not-sent`, fresh sign-in, typed phrase), which for a `submitted`
  draft with an open-or-acknowledged `draft_gone` demands: past `payments.draft_expiry_days`
  (`draft_not_expired`), the last lookup a "not found" at most 30 minutes old (`lookup_not_fresh`), and
  `nothingPaidEvidence` (`no_bank_evidence`): the account's balance read AND a complete transactions walk
  (`revolut_sync_state.watermark`) started after the draft was first seen gone, both within 24 hours, and
  no line of that account and currency since the request (one day of slack) with its amount, with or
  without a fee, to anybody, other than a failed/declined/reverted one. It becomes `failed /
  draft_expired` (audit `payment.draft_gone_resolved` under the admin), so the 30-day watch and the
  earlier-attempt check of a new request still look at that draft.
- **Protocol version re-pinned.** The worker label is now `payments-execution-v3` (v2 by the builder, v3
  by the review: byte-equal gate check, the human step of (c), one transaction per request; a behaviour change
  the sampled outputs cannot show), the core checklist and block codes changed, so both pins moved:
  core `db5c8f24...cf367` (`packages/core/src/payments/protocol.test.ts`), worker `501f9a43...6787`
  (`test/payments-p9b-api.test.ts`). Every earlier verification mark is void.

### B2 (worker half) and N8: batch items linked to bank lines; a completed draft needs its transactions

- A draft that says `completed` must name ONE transaction per payment we asked for, each read from
  Revolut, each a leg out of OUR account, in OUR amounts (a batch: the multiset of its items). Missing
  ids, a different count, or other amounts: the request stays `submitted` and the alert
  `draft_completed_unlinked` (or `mismatch`) is raised. It never becomes `paid` silently (N8).
- When it does become `paid`, the named transactions are recorded in the same batch
  (`payment_draft_transactions`, append-only, insertable only for a `paid` subject; a plain INSERT so a
  refused row rolls the whole move back).
- `linkBatchItems` (runs after `linkPaidPayments` in every reconcile run) links the items of a PAID batch
  to their bank lines through those transaction ids (`bank_transactions.external_id`): one item and one
  line are paired when they are the only ones of that amount, or, with several of one amount, when the
  line's `reference` equals the item's reference and nobody else has it. Anything else stays
  `awaiting_bank_line` (never guessed). `payment_bank_links_guard_insert` repeats the account/currency/
  amount rule. `linkPaidPayments` also accepts the recorded transaction ids for single payments.

### S1 (worker half): alerts as state, audit rows, acknowledge, honest settlement

**Alert state is columns of `payment_reconcile`** (the table of migration 0029, one row per
`(subject_kind, subject_id)`; `subject_kind` is `'payment'` or `'batch'`, `subject_id` the id in
`payments` / `payment_batches`). Migration 0030 adds three columns next to the existing `alert_at`:

| column | meaning |
|---|---|
| `alert_at` | when the CURRENT alert was raised (ISO UTC); NULL = never |
| `alert_kind` | `mismatch`, `duplicate`, `approved_after_expiry`, `reverted_after_paid`, `draft_gone`, `draft_completed_unlinked` (CHECK) |
| `alert_ack_at`, `alert_ack_by` | when and by whom (lower-case email) the alert was acknowledged; NULL = not yet |

**An alert is OPEN while `alert_at IS NOT NULL AND alert_ack_at IS NULL`.** Other columns F9b can use:
`last_checked_at`, `last_result`, `provider_state`, `checks`. For "`outcome_unknown` > 30 minutes", "`ready` not
sent" and "paid, not booked after N days" no new column was needed: read `payments`/`payment_batches`
(`status`, `updated_at`) and `payment_bank_links` / `paymentSettlement` (the settlement is also reachable as
SQL: no row in `payment_bank_links` for a `paid` payment = `awaiting_bank_line`).

Rules (all in `reconcile.ts`, tested in `test/payments-f9a-reconcile.test.ts`):

- Raising is idempotent: while an alert is open, or was acknowledged and the new one is the same kind, a
  later run changes none of the four alert columns. A different kind after an acknowledgement raises
  again and clears the acknowledgement. Review F9a: an ACKNOWLEDGED alert is cleared (all four columns
  NULL) when a run sees the subject healthy (`last_result` pending, paid, failed, draft_expired,
  resolved; never on an error or a "not found"), so the same condition coming back is raised and audited
  again. An unacknowledged alert is never cleared by a run.
- Every raise writes ONE audit row in the same batch (`payment.<kind>` / `payment_batch.<kind>`, actor
  `system`, entity id = the request id), only when that very run raised it. `mismatch`, `duplicate`
  (no audit row before), `draft_gone`, `draft_completed_unlinked`, plus the two that had one
  (`approved_after_expiry`, `reverted_after_paid`).
- `POST /api/payments/:id/alert/ack {note?}` and `POST /api/payment-batches/:id/alert/ack {note?}`
  (finance or admin, no step-up, a JSON body is required: send `{}`), audited as
  `payment.alert_acknowledged` / `payment_batch.alert_acknowledged` with the alert kind and the note.
  Answers `200 {acknowledged: true, alertKind}`; `404 not_found`; `409 no_alert`, `409
  already_acknowledged`, `409 conflict` (the alert changed while it was read). It moves nothing. An alert
  on an item of a batch is on the BATCH row.
- **The settlement answer is honest** (`paymentSettlement`, `GET /api/payments/:id/settlement`): a
  payment that is `failed` after its draft was approved late answers `approved_after_expiry` (not
  `not_paid`), and a paid payment whose bank line was reversed answers `reverted_after_paid`. The
  `Settlement` type gained these two values (F9c must show them).

### S5 Key id next to the fingerprints; rotation is not "IBAN changed"

- `ibanKeyId(key)` (core) = first 8 hex of `HMAC-SHA-256(key, "key-id")`: non-secret, no useful handle on
  the key. Stored in the new `key_id` column of `supplier_iban_verifications`, `payment_payees` and
  `payments` (written once; triggers `payments_guard_key_id` and `payment_payees_guard_key_id` refuse a
  change; the verification table was already append-only).
- A verification whose stored key id differs from the current key's id is reported as the block code
  **`iban_key_rotated`** (new in `PAYMENT_BLOCK_CODES`) instead of `iban_changed`. The IBAN state stays
  `changed`, so existing screens keep working; the web has a sentence for the new code (see "Web files").
  A row without a key id (from before 0030) cannot show a rotation and stays `changed`.
- `runSubmission` answers `iban_key_rotated` instead of `iban_binding_broken` when the stored request
  was made under another key id.
- The payee cache is orphaned by a rotation (its fingerprint changes). Before creating a payee, the
  submitter now also LOOKS the IBAN up at Revolut when payees of another key (or without a key id)
  exist, not only when an earlier claim exists. A failed lookup still falls through to creating the
  payee (creating a counterparty moves no money). A duplicate counterparty remains possible if
  `GET /counterparties` does not return IBANs (A14, now a runbook check).
- DEPLOY.md: the three secret lists (step 5 "seven secrets", Staging first step 4, Rotating secrets)
  name `PAYMENTS_IBAN_KEY` and `EMAIL_API_KEY`; the rotation entry lists every consequence. The deploy
  guard's refusal list gained both names.

### S6 Deploy guard for `REVOLUT_PAYMENTS_EXECUTION`

`scripts/deploy-config.mjs` (`paymentsExecutionProblems`): the resolved value of the environment being
deployed must be exactly `"off"` or `"on"` (missing, `"ON"`, `"true"`, `""`, `" on"` are refused: the
Worker reads only `"on"` as on, so a typo would silently mean off). `"on"` in **production** also needs
`CF_ALLOW_PAYMENTS_ON=yes` in the environment of that deploy command (read by
`check-deploy-config.mjs`; only the literal `true` option counts in the pure function). Staging and
other named environments may carry `"on"`. Every deploy prints the value
(`paymentsExecutionStatement`). Tests: `test/deploy-config-payments.test.ts`.

### S7 Preview does not hash the counterparty body

The counterparty step of Preview payment returns `sha256: null` (type `string | null`) and its hash is
not in the audit row. The body is still shown with the IBAN masked. The payment and draft steps keep
their SHA-256 (they hold no IBAN). Nothing consumed the field.

### S8 `requester_inactive`

`requesterIsActiveFinance(db, email)` (store.ts): an enabled user holding `finance`. Checked in
`whyNot` (at send, before any claim), at confirm (403) and when APPROVING (409); turning a request down
stays allowed.

### S11 Settings PATCH compare-and-swap

`PaymentsState.settingsRaw` carries the raw stored JSON (or null) the patch was computed on; the write is
`INSERT ... SELECT ... WHERE (SELECT value_json FROM settings WHERE key = ?1) IS ?4` with that raw value, so a
change made between the read and the write is a `409 conflict` and the other writer's value stays
(tested with a D1 wrapper that writes in between). `storedOrDefault` is gone.

### S12 Payee audit rows

`recordPayee` writes the cache row and `payee.created` (made by this app) or `payee.adopted` (found at
Revolut) in one batch; the audit row only when the cache row was really inserted (`changes() = 1`).
Actor `system`; the row names the request, the Revolut ids and a 16-character fingerprint prefix, never
an IBAN or a name.

### S3/S4 The runbook can be followed

- **Environments CAN be told apart in the worker**: the Revolut connection has
  `revolut_environment` (`sandbox` / `production`). So the first option of the task was built, not the
  "partial list" fallback: `POST /api/settings/payments/verify {..., provisional: true, checks: <any subset
  of known checks>}` records a **provisional mark** (`provisional: true` in `payments.verified`). It is
  accepted only when `REVOLUT_PAYMENTS_EXECUTION` is `"on"` AND every active Revolut connection is a
  sandbox one, and it is honoured (`revolutIsSandboxOnly`, re-read from D1 every time) by the gate
  (`paymentWritesOpen`: otherwise `not_verified`), by `loadPaymentsState` (reads as no mark), and by the
  enabling SQL of the switch. It covers both modes (drafts and pay), because it exists only on the
  sandbox. It leaves payments OFF and is audited as `payments.verified_provisional`. A complete
  verification replaces it (no flag). Without the flag an incomplete list is still `checks_incomplete`.
  Errors: `provisional_not_allowed` (409), `bad_checks` (400).
- Runbook step 4 is now a two-pass procedure (probes without the app, provisional mark, round trips with
  the app, final complete mark); the "staging fault switch" never existed and is gone: the lost-answer
  drill says to run the staging Worker with `wrangler dev --env staging --remote` and stop it after the
  sandbox received the call (the claim then runs out after 10 minutes, not 5; the text says so).
- New checks in `PAYMENTS_VERIFY_CHECKS` (now 15): `counterparty_lookup_probe` (A14 does the list show
  IBANs, paging, A16 rate limit) and `draft_lifecycle_probe` (A10 a refused call creates no draft, A8 state
  words, delete, approve late, paging). A11 (`/pay` on a non-Company plan) is a step of
  `revolut_plan_known`, payee-name verification a step of `sandbox_counterparty_roundtrip`, transfer
  fees (S13) a step of `sandbox_draft_roundtrip`. DEPLOY.md prints the constant; a test compares them.

### N6, N7, N3, S14

- **N6** `PUT /api/settings/payments/draft-expiry` needs a fresh sign-in.
- **N7** The gate (`gate-request.ts`, called from `#assertPaymentWrite` at the door and again before the
  fetch) reads the stored request from D1 and refuses a `/pay` or `/payment-drafts` body that disagrees
  with it: not JSON (`payment_body_unreadable`), unknown request, not `submitting` or a source account of
  another Revolut connection (`payment_unknown_request`), no cached payee (`payment_payee_unknown`), any
  other byte (`payment_body_mismatch`). Review F9a: the gate REBUILDS the body with the real builders
  (`buildPay` / `buildPaymentDraft`) from the stored rows (by id) and the cached payee and demands byte
  equality, so the amount is compared as its token text (never as a float), and a duplicated key,
  another spelling of the number or another reference are refused. A D1 error throws, and the gate
  refuses. The counterparty create is not compared (it moves no money).
- **One transaction, one request** (review F9a): a completed draft naming a transaction another request
  already recorded is a `mismatch`; `payment_draft_transactions_tx` (UNIQUE on `transaction_id`) is the
  database's fence. Batch items are paired by reference also in the form the builder SENT
  (`revolutReference`); two items with the same sent reference and amount are never paired.
- **N3** The three real-time tests: the timeout test uses fake timers (`vi.useFakeTimers` for
  `setTimeout`); the other two wait for an event (the call reaching the fake bank, the guard being
  consulted), not for milliseconds. Where no clock is involved a signal is the right fix; this deviates
  from the letter ("fake clocks") deliberately.
- **S14** ADR 0049 corrected (a late refusal is not recorded; the row stays `outcome_unknown`); the
  headers of `routes.ts`, `store.ts` and `submit.ts` and the pin test name in `protocol-version.ts` are
  true again.

## Web files touched (outside F9c's ownership, deliberately small)

`apps/web/src/lib/payment-labels.ts`: two entries in `VERIFY_CHECK_TEXT` (the task), plus one `BLOCK_TEXT`
entry (`iban_key_rotated`) and two `ERROR_TEXT` entries (`requester_inactive`, `provisional_not_allowed`).
The last three are needed because the existing web tests demand a sentence for every block code of core
and every `PaymentError` code of the worker; they are single inserts next to `iban_changed` so a merge
with F9c's edits is mechanical. Codes the new routes return without a string literal (`no_alert`,
`already_acknowledged`, the gate's `payment_*` codes, `iban_key_rotated` as a submit refusal) are NOT in
the scan and need F9c's wording.

## Still open (decisions or later; not done here)

S9 (structuring under the limit), S10 (paid outside the app window; Exact SEPA batch), N1, N2, N4, N5, N9
as listed in the review. Also: the alert columns have no screen yet (F9b/F9c); `payment_draft_transactions`
is only written for drafts (pay mode has the request id); A14 (does `GET /counterparties` return IBANs)
decides whether a rotation can create a duplicate counterparty; the 24-hour freshness and the "amount
only" evidence of `nothingPaidEvidence` are conservative guesses, not measured.

## Tests

`test/payments-f9a-submitter.test.ts` (B3a, B3b, N7, S8, S5, S12), `test/payments-f9a-reconcile.test.ts`
(B3c, N8, B2 linking, S1), `test/payments-f9a-api.test.ts` (ack route, S7, S11, N6, provisional mark),
`test/deploy-config-payments.test.ts` (S6), core `precheck.test.ts` / `runbook.test.ts`, and the updated
existing tests (the gate tests stage a real `submitting` request; the bulk-draft test names its
transactions). Six invariants were mutated to prove the tests notice (see the task report).
