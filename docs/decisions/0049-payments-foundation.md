# 0049 Payments foundation: state machine, four-eyes, fail-closed layers (Phase 9, P9a)

Status: accepted for P9a. NOTHING IN P9a MOVES MONEY and nothing here has run against a real Revolut. The Revolut payment endpoints stay unreachable from the gate (`revolut/request.ts` allow-list, ADR 0034/0048); P9b opens them behind everything below.
Code: `packages/core/src/payments/` (pure rules, 99% covered), `apps/worker/src/payments/` (settings, facts, store, transition, submit, iban-store, iban-verify, read, routes, http), migration 0028, trigger fixture `test/fixtures/trigger-hashes.json`.

## What P9a builds, and what it does not

Builds: the payment REQUEST (a record of "pay this open bill, from this account, this much"), its pre-checks, its confirmation, the four-eyes approval, supplier IBAN trust, batches, the DB guards, the audit trail, the settings and the fail-closed switch, and the call boundary as an interface with a disabled default.

Does not build (deliberately): any call to Revolut (`/pay`, payment drafts, counterparties, transaction lookup for payments), the real `PaymentSubmitter`, the reconciliation job (interface only), booking a paid invoice in Exact, the Pay button and screens (web), reminders. The switch cannot be turned on in P9a: enabling reports the blocker `submitter_unavailable` because `getSubmitter()` returns `DisabledSubmitter`.

## Request states

| State | Meaning | Leaves to |
|---|---|---|
| draft | created and pre-checked; the sheet was shown | pending_approval, ready, cancelled, expired |
| pending_approval | confirmed; waits for a second person | ready, rejected, cancelled, expired |
| ready | confirmed (and approved when needed); nothing sent | submitting, cancelled, expired |
| submitting | a single writer holds the claim and may be calling the bank | submitted, rejected, outcome_unknown |
| submitted | the bank accepted the instruction; final bank state not known yet | paid, failed |
| outcome_unknown | the call may or may not have reached the bank | submitted, paid, failed, rejected (reconciliation or a person; never an automatic retry) |
| paid, failed, rejected, cancelled, expired | final | nothing |

`rejected` covers two different "no"s that both mean nothing was paid: an approver rejected it (`status_reason approver_rejected`), or the bank refused it (`provider_rejected:<code>`). A definitely-not-sent failure is also `rejected`; the request is then recreated with a NEW `request_id`, which is safe because nothing was sent. Moves are strictly forward: there is no `submitting -> ready`, so a request that was claimed never goes back to be claimed again. "Paid" in the sense of CLAUDE.md 4.3 (bank confirms AND the match is booked in Exact) is two facts: `paid` here is the bank's, the booking is the matching/booking outbox (ADR 0044) and is wired in P9b.

Expiry: a request not confirmed, approved or sent within 24 hours of creation becomes `expired` (lazily, before every read that decides something; no job needed). An approval is valid for 24 hours from the approval and can never outlive its request.

## The pre-checks (CLAUDE.md 4.3)

`precheckPayment` returns EVERY applicable block code (stable strings, `PAYMENT_BLOCK_CODES`), in a fixed order. Doubt is a block, never an assumption.

- Payable: exists, is a bill, something is open, amount valid (a safe positive integer; floats, strings, zero, negatives and > 2^53-1 refused), equals the open balance unless `allowPartial`, not above the open balance; currency allowed (default EUR only) and equal to the source account's.
- Exact approval: `approval_mapping_unverified` unless the status mapping was verified for the CURRENT table (ADR 0025); the one purchase entry of the payable (`findPurchaseEntryForPayable`) must prove `approved` (`isInvoiceApprovedForPayment`: read recently, seen by the last complete read); an entry that says approved but cannot be proven now is `approval_unknown`, not "approved".
- Double payment: an open request or open batch for the invoice (also a unique index), or a `paid` payment newer than the last sync of the invoice.
- Supplier and IBAN: supplier known; IBAN present, valid (mod-97), equal to the invoice's own IBAN when it has one, read completely within 3 days, and VERIFIED (below).
- Limits: EUR equivalent at the stored ECB rate. No rate = `no_eur_rate` BLOCK. Per request (`maxRequestMinor`, default 25,000.00 EUR) and per rolling 24 hours over all open and paid requests (`maxDailyMinor`, default 50,000.00 EUR). Both inclusive at the boundary.
- Source account: found, active, balance at least the amount minus what other open requests already reserve. A low or unknown or stale balance is a WARNING unless `blockOnInsufficientBalance`.
- Reference: `Invoice <number>`, built only from the invoice number, NFKD-folded to the SEPA character set (a-z A-Z 0-9 / - ? : ( ) . , ' + space; no `//`, no leading or trailing `/`), cap 140; nothing usable left = `reference_empty`.
- `request_id`: a UUIDv4 minted once at creation (`crypto.randomUUID()`), stored in the same row, `UNIQUE`, immutable (trigger). It is never regenerated for any retry.

## Four-eyes (CLAUDE.md 4.4)

`requiredApprovals` returns reasons (stable codes): `above_limit`, `batch_total_above_limit`, `batch_item_above_limit`, `no_eur_rate`, `new_or_changed_iban`.

- Amount: with the master switch on, a request ABOVE `fourEyesLimitMinor` (default 2,500.00 EUR; exactly at the limit needs no one) needs a second approver. For another currency the comparison is "at or above" because the rounded EUR figure can hide a fraction of a cent over the line. A batch is judged by its total AND by every item. Rounding is `convertMinor`'s: half away from zero, once, at the end.
- New or changed bank details: a SEPARATE toggle (`requireApprovalForNewIban`, default on), independent of the master switch and of the amount. It applies unless the IBAN is `verified_established`, i.e. verified by an approver AND already paid to once (`paid` payment with the same fingerprint). A requester who verified the IBAN themselves is `verified_by_requester`, still needing a second person.
- One second approver suffices (no count). The approver is a user holding the `approver` role (roles are not hierarchical: admin and finance do not count), is not the requester (compared trimmed and lower-cased, and by a CHECK, and again in the ready-guard), and has signed in with Google within 15 minutes (route step-up, and `approver_auth_at` is stored).
- The approval is bound to a SHA-256 over the exact payload: kind, mode, source account, currency, total, and per item (sorted by request id) the request id, invoice, amount, currency, IBAN fingerprint and reference. The approver's screen sends the hash it saw; a different hash is `payload_changed`. Any change to the payload, in the app or in the database, yields another hash.
- Re-checked when the request is about to be sent (`approvalStillValid`, used by `runSubmission`): still under 24 hours, same hash, approver still active AND still holding the role (removing the role or disabling the user after approving stops the payment), approver not the requester.
- Every confirm, approve, reject and cancel writes an audit row under the Google email, in the same batch as the change.

## Supplier IBAN trust

A first-sync IBAN is NOT trusted. A supplier IBAN counts as verified only after an approver confirmed it: `POST /api/payments/ibans/verify {relationId, fingerprint, lastFour}` (approver, fresh sign-in). The fingerprint is `sha256("iban-fp-v1:" + normalised IBAN)`: an identity for comparison, audit rows and payloads, NOT a secret (an IBAN has little entropy and the full IBAN is in the database anyway). The approver must repeat the fingerprint they saw (so a change between display and click is `iban_changed`) and type the last four characters (so they looked). A verification is one append-only row; the latest row of the relation decides; `revoked` undoes it. Exact changing the IBAN changes the fingerprint, so the old verification no longer covers it and the supplier is `changed` (blocked) until an approver confirms the new one. An IBAN read older than 3 days is never confirmed.

Full IBANs live in one place: `payments/iban-store.ts` (the allow-list in `test/iban-select-guard.test.ts` names it with the reason). The `payments.beneficiary_iban` column holds the IBAN to send to; responses, audit rows and logs carry only `NL91****4300` and a fingerprint (the first 16 hex characters in request DTOs).

## Defaults for the unanswered decisions (every one is a setting)

Decision 1 (Revolut plan): payment mode `drafts`. Revolut payment drafts are approved in the Revolut app, which works on every plan and is itself a second control. `pay` (one-click `/pay`, Company plan) is selectable by an admin ONLY after a current verification and when the Revolut connection says `payments_mode = pay`; loosening to `pay` also needs the typed phrase and a fresh sign-in. Why: the safe mode is the default and the dangerous one needs three separate facts.

Decision 6 (four-eyes limit, approvers, roles): four-eyes ON, limit 2,500.00 EUR (250,000 minor), second approver for any new or changed IBAN whatever the amount (separate toggle, on), approvers are users with the `approver` role (never the requester), finance requests, admin configures. The hard ceilings (25,000 per request, 50,000 per rolling day) are NOT in the brief; they are invented conservative defaults so a mistyped limit setting cannot authorise a large payment. They are settings; please confirm or replace (question 3 below).

Settings loosening rule: tightening (a lower limit, four-eyes back on, ...) needs only the admin. A LOOSENING (limit up, four-eyes or the new-IBAN rule off, ceilings up, partial payments on, balance blocking off, a currency added, mode `pay`) needs a fresh sign-in AND the phrase `LOOSEN PAYMENT CONTROLS`. We did not require a second admin: with one initial admin it would lock the system, and the audit row names who did it. Revisit when there is more than one admin.

## Fail-closed layers (same pattern as ADR 0044)

1. `payments.enabled` (default false, only JSON `true`) AND `payments.verified` whose `protocolVersion` equals `paymentsProtocolVersion()` (a hash over the transition table, block and approval codes, defaults, the payload layout and the rule outputs on fixed samples: any rule change voids the mark). Enabling: admin, fresh sign-in, phrase `ENABLE PAYMENTS`, every blocker gone, re-checked inside the INSERT. A new verification switches payments OFF. Disabling: admin, immediate, audited.
2. Verification checklist `PAYMENTS_VERIFY_CHECKS` (core): plan known, sandbox draft round trip, `request_id` idempotent on the sandbox, a lost answer reconciles by `request_id`, approver accounts checked, first IBAN verified out of band, approval mapping verified in Exact, limits reviewed. The route refuses an incomplete list.
3. Blockers: `not_verified`, `protocol_changed`, `submitter_unavailable`, `approval_mapping_unverified`, `no_revolut_connection`, `no_approver`, `payments_disabled`.
4. The database: inserting a request needs the switch on; `ready -> submitting` needs the switch on, an unreleased claim and (when needed) a valid approval. See below.
5. The call boundary (submit.ts): `runSubmission` refuses before claiming anything unless the switch, the verification, the mapping, the connection, an approver and an AVAILABLE submitter all hold; it re-checks status, expiry, the payload hash against the stored fields and the approval, takes the claim in the same batch as the move to `submitting`, makes ONE call, and maps anything unclear to `outcome_unknown`.
6. Source scans (`test/payments-scan.test.ts`): no payment path in the gate allow-list or any source, no payments file imports the Revolut modules or calls `fetch`, nothing but `submit.ts` mentions `runSubmission`, no float near money, no full IBAN in DTOs.

## Database guards (migration 0028)

`payments`, `payment_batches`, `payment_approvals` (not `approvals`: the 0003 table of that name is a generic skeleton with a different shape and is left alone and unused), `supplier_iban_verifications`, `payment_events` (append-only), `payment_claims`. `payments` and `payment_batches` existed since 0003 and were never written; they are rebuilt, and the migration FAILS (CHECK) if either holds a row, so a populated table is never dropped silently. Triggers (names pinned in the fixture; the diff of the regenerated fixture is purely additive):

- `*_guard_status`: only the legal moves (full 11 x 11 matrix tested against an independent table); `*_guard_final`: a final row accepts no update; `*_guard_no_delete`.
- `*_guard_request_id`, `*_guard_payload`: request id, hash, amount, currency, IBAN, fingerprint, reference, account, invoice, mode, requester, approvals required, expiry and client key never change after insert, in any state.
- `*_guard_confirm`: leaving `draft` needs `confirmed_at` and the requester's sign-in time; `ready` straight from `draft` only when no second person is required.
- `*_guard_approved`: `pending_approval -> ready` needs an approval row by somebody else, for this payload, by a person who still holds the approver role and is not disabled.
- `*_guard_submitting`: the switch on, an unreleased claim (a batch item is sent under its batch's claim), and the same approval again.
- `payments_guard_insert`: starts as a draft with nothing sent, switch on, an open bill of that division with enough open, a source account in the same currency, a batch item joins a draft batch of the same account, currency, mode and requester. `payments_guard_batch_item`: an item moves only with its batch (the bank's per-item `paid`/`failed` may arrive after the batch was submitted).
- `payment_approvals_guard_*`: the decision targets a waiting subject and its exact hash, the decider holds the approver role now, `decided_by <> requested_by` (CHECK), one decision per subject, append-only.
- `payment_claims_guard_*`: a claim only for a `ready` subject, one live claim per subject, never deleted; only the release may be written.

Time (24 h, 15 minutes) is checked in the application inside the same batch as the write, with the request's clock, because triggers cannot be tested against a frozen clock.

## Idempotency

Create takes a client key (8-100 characters); `UNIQUE (requested_by, client_key)` makes a repeat return the same request (200, `replayed`), and the same key for another invoice is `client_key_reused`. State moves are conditional UPDATEs (`WHERE status = <the state the decision was made on>`), so a replayed confirm/approve/cancel is a 409, never a second move. We did not use the `idempotency_keys` table for these: the change and its key are one row, which is atomic without a second table. P9b stores an idempotency key for each call to Revolut BEFORE the call (ADR 0013), keyed by the `request_id`.

## The submit boundary

`PaymentSubmitter { available; submit(req) -> accepted(providerId) | rejected(code) | unknown }`; `DisabledSubmitter` has `available = false` and returns `rejected payments_disabled`. The request handed over carries no IBAN (P9b adds one reader in `iban-store.ts`). A claim past its lease (10 minutes) is turned into `outcome_unknown` by `markStaleSubmissions`, never into a retry. `getSubmitter()` returns the disabled one; `setSubmitterForTests` (mentioned nowhere else in `src/`, pinned by the scan) lets tests pretend one exists so the enabling SQL is exercised. `PaymentReconciler.lookup(requestId)` is an interface only. Tested with fake submitters: accepted, rejected, unknown, thrown, garbage answers, parallel runs (one call), stale claims, tamper, removed approver role, expired approval.

## Deliberate deviations from the task text (stricter, or different)

- No EUR rate = BLOCK (`no_eur_rate`), not only "needs approval": the hard ceilings cannot be checked without a figure. The four-eyes function still returns `no_eur_rate` as a reason (used if the ceilings are ever relaxed).
- The daily ceiling is a rolling 24 hours, not an Amsterdam calendar day (no DST edge cases).
- `DisabledSubmitter` returns `rejected payments_disabled` as asked, but the orchestration never reaches it: it refuses before claiming. There is no `not_sent` outcome and no `submitting -> ready` move.
- Creating a request needs the switch ON (a request made while off would only sit in a queue). In P9a the switch cannot be on, so production returns `payments_disabled` for every create; the tests set the switch directly.
- `rejected` is used for both an approver's no and the bank's no (see above).

## Assumptions, all UNVERIFIED

- `open_items.entry_number` joins to exactly one `purchase_entries` row (ADR 0025); the status code `50` means approved (ADR 0025). Nothing is payable until an admin verified the mapping.
- `relation_bank_accounts.last_seen_at` of the row that equals `relations.iban` is "the IBAN was seen by the last complete read".
- `bank_accounts.balance_minor/balance_at` is the last known Revolut balance (not reserved/pending aware, hence the reservation by other open requests).
- Revolut's `request_id` makes a payment idempotent and a lost answer can be looked up by it (`GET /transaction/{request_id}?id_type=request_id` exists in the client). Verify on the sandbox before P9b is enabled (checklist items).

## Questions for the user (needed before P9b goes live)

1. Revolut plan: Company (true one-click `/pay`) or not (payment drafts approved in the Revolut app)? Default drafts.
2. Four-eyes: confirm 2,500.00 EUR, the approvers (which users get the `approver` role), and that finance may request but not approve.
3. The two hard ceilings (25,000 per request, 50,000 per rolling day) are my invention. What are the real ones?
4. Should a loosening of the controls require a second admin once there is one?
5. Currencies to pay in (default EUR only) and whether part payments are ever wanted.
6. Who may cancel a request that is already `ready` (today: the requester or an admin)?
