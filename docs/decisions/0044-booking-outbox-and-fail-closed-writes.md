# 0044 Booking to Exact: outbox, executor, fail-closed writes (Phase 7, M7c)
Status: accepted; NEVER RUN against a real Exact. Every Exact name and behaviour is an assumption (ADR 0040 A1-A11, plus A12-A16 below). (Renumbered from 0043 at review: 0043 is the M7d matching-screens ADR.)
Code: `apps/worker/src/booking/` (settings, plan, outbox, executor, classify, constants, protocol, routes), `exact/write-policy.ts`, migration 0023.

## State machine (outbox row, with the match's `exact_state`)
| Row status | Entered when | Leaves to | Match state |
|---|---|---|---|
| pending | claim batch stores payload + key (match `not_booked` -> `booking`); admin retry (`needs_probe`) | sending, waiting, manual_required | booking / bank_entry_created |
| sending | stored BEFORE every POST (attempts + 1) | sent_unverified, pending (provably not sent, or 429), failed (Exact 4xx), outcome_unknown | unchanged |
| sent_unverified | an answer came back, not yet proven by a read | verified, failed (MatchSet explicitly refused AND not applied), outcome_unknown (after 6 h, or at once for an unreadable MatchSet answer or an inconclusive read) | unchanged |
| verified | bank line probed / MatchSet items read back closed | final | `bank_entry_created`, then `matched_in_exact` + `booked_at` |
| failed | Exact 4xx (no auto retry) or MatchSet refused by Exact's own message and not applied (3 tries, 5/30/120 min) | pending (admin or backoff), given_up | booking_failed |
| outcome_unknown | thrown, timeout, 5xx, 3xx, unreadable answer, 401 after a POST, RPC failure, stale `sending` | pending ONLY by admin retry | outcome_unknown |
| manual_required / waiting_for_bank_line | plan failure, ambiguity, changed bank line or balance / feed line missing (48 h) | resolved_manually, given_up / pending | manual_required / booking |

Transitions are one batch: the conditional row UPDATE (lease token, `from` states; it stamps a random `op_nonce`), its audit row, the match move, and a guard `SELECT ... json('x')` that ABORTS the batch when the row moved (nonce is ours) but the match was not in the expected state. Triggers refuse illegal `exact_state` moves, any change of a finished row, `booked_at` changes, and an undo of a claimed match (`matches_guard_undo_claimed`).

## Fail-closed layers (all must agree)
1. `exact.booking_enabled` (default false, only JSON `true`) + `exact.booking_verified` whose `protocolVersion` = the worker's `BOOKING_PROTOCOL_VERSION`. Enabling: admin, fresh sign-in, phrase `ENABLE EXACT BOOKING`, verification, active Exact connection, Revolut `bank_entries_decided_at`, all re-checked inside the INSERT. A new verification switches booking OFF. Disabling: admin, no step-up, immediate, audited.
2. `BOOKING_PROTOCOL_VERSION` (booking/protocol.ts) = sha-256 over: the Exact package's version (EXACT_WRITE_NAMES, sign, builder rules, builder output on samples, AND the outputs of the sanitiser/IBAN masking, xmlEscape, money formatting at scales 0/2/3 and 2^53, the builders' refusals, the probe and balance queries, the answer parsers and the read-back verdicts on adversarial samples), the worker's `planMatch` on hand-built samples (signs, full-match-only refusals, bank text), the error classification and the executor limits. Any behaviour change in any of them, including a shared dependency, invalidates the verification. Both versions are pinned in tests.
3. The job `exact.book_matches` ships disabled (also on the DEFAULT_JOBS_VERSION 4 upgrade), re-checks every precondition at start (`booking_disabled`) and right before every POST (`writes_disabled`), runs admin + step-up, minimum interval 5 minutes, 10 new matches and 30 calls per run, 400 calls per rolling 25 hours.
4. `ExactGate` refuses every non-GET except POST `/financialtransaction/BankEntries` (no query, a JSON object with only bank entry fields, 1-50 lines with only line fields) and POST `/docs/XMLUpload.aspx?Topic=MatchSets` (exactly one query key; exactly our envelope around one `<MatchSets>` of `<MatchSet>` elements; no DOCTYPE, PI, CDATA, comment or second topic), only headers content-type/accept, only job `exact-booking` at priority `job`, and only while EVERY precondition holds (switch, current verification, Exact connection, Revolut decision), read from D1 at request, before the token step and after it, right before the fetch. No redirects; POSTs never retried (a 401 refreshes the token, then `ExactWriteAuthRetryRefused`); writes count against the job budget. GET bodies are never sent.
5. The writer guard (ADR 0040) and the source scan: only `booking/executor.ts` holds the writer; only it and the policy know the job id.

## Never re-POST
- Outbox row (payload = builder INPUT with sanitised text, hash checked, body rebuilt and compared with `builtHash`) and idempotency key are in the claim batch, before any call; `sending` is stored before every POST.
- Errors (`booking/classify.ts`): only gate refusals that happen before the fetch are `not_sent` (row back to pending, attempts not counted). 429 = pending with `needs_probe`. A definite 4xx = failed, no auto retry. Everything else = outcome_unknown. A writer-level `ExactAuthError` (a 401 answer that reached it) is unknown, not "not sent".
- Bank entry: YourRef probe before every POST (an error is never "not found"; two hits, a hit with an unreadable ref, or a paged answer is ambiguous = manual). Before every POST of a row not claimed in this same run (a retry, a row that waited), the journal's latest closing balance is read again and must equal the stored opening balance; otherwise `bank_balance_changed` (manual). This is a second detector of our own lost POST that the probe cannot see (A13 wrong), and of anyone else booking in the journal (A12). The bank line must still be final, completed and the same amount (`bank_line_changed`).
- MatchSet: read-back before every POST (`verified` = done, marked `already_matched_in_exact` when we never sent it; `inconclusive` = manual) and after it. Only Exact's explicit error message plus an unchanged read-back allows an automatic new attempt; an accepted, empty or unreadable answer with nothing visible is never re-posted (outcome_unknown after 6 h, at once when unreadable).
- Stale `sending` (lease 10 min) -> outcome_unknown. At most one bank entry per journal in flight. A resolution is refused while another row of the match is `sending`.
- **outcome_unknown procedure:** look in Exact for the bank entry (YourRef = Revolut id, and the journal's last entry) and the MatchSet. Done -> `booked_manually`. Absent -> `retry` (executor probes, re-reads the balance and the items first). Not wanted -> `give_up`. Resolution covers every open row of the match.

## Daily cap
`booking_call_ledger` (migration 0023): one row per Exact call, inserted BEFORE the call by a conditional INSERT that succeeds only while fewer than 400 calls were made in the last 25 hours (the longest Amsterdam day). Overlapping runs, crashed runs and manual runs all count; a refused reservation stops the run before the call (a POST is "not sent"). The schedule projection uses the same cap: all jobs on = 2,960 <= 3,000.

## Allocation settlement (fixes ADR 0042's double count)
An allocation counts against an item until its match is `matched_in_exact` AND the item's `synced_at` is later than `booked_at`; the sync stamps `synced_at` before it reads (a full pass stamps once, before its first chunk, also when resumed), so a later stamp means the read started after the MatchSet was proven applied. (Superseded by the settlement rule v2 in ADR 0042's addendum: the re-read must also prove the payment.) Same predicate (`allocCounts`, the trigger has the same text) in the trigger, assembly, manual check, review flags, invariants. Failed, unknown and manual states keep counting. Items that vanish from the list after full payment keep their (blocking) allocation until the two-strike rule closes them; closed items are not matchable either way.
Residual risk: if Exact's SYNC read lags behind the read-back (A15b), a re-read after the booking can still show the old open amount and free the item for a second match. That second match cannot double-book: its MatchSet read-back finds the item closed and marks it `already_matched_in_exact` (a person checks); its bank entry is a real second payment.

## Manual in v1
Part payments, surplus, credit-note netting, several relations, mixed kinds, foreign currency (FX), amounts above 2^53, a ledger booking when Revolut's feed owns the line, unknown control account or bank balance, changed balance or bank line, reversal (Undo stays 409 `already_booked_in_exact`, detail `reversal_required_in_exact`: reverse the MatchSet and the bank entry in Exact, then mark the outbox rows `given_up`).

## Assumptions, all UNVERIFIED (verify on the test division)
The fake Exact in the tests (`apps/worker/test/booking-fake-exact.ts`) implements these assumptions itself: tests pass BY CONSTRUCTION for them and prove nothing about Exact.
- A12 `BankEntries` ordered by `EntryNumber desc`: the first row's `ClosingBalanceFC` is the next entry's opening balance (also across financial years).
- A13 `BankEntryLines` filters on `YourRef`+`JournalCode` (and `AmountFC`, `Date` for the feed); an unknown or ignored filter would return OTHER lines (we read that as ambiguous only when more than one comes back): test that a random YourRef returns zero rows in a journal that has lines. The feed leaves its line in the mapped journal.
- A14 MatchSet `GLAccount` is the debtor/creditor control account (`receivable_gl_account_code` / `payable_...`); signs: debtor invoice +, receipt -, creditor bill -, payment +; bills are stored with a positive `open_minor` when unpaid.
- A15 read-back `AmountFC` is the signed open amount equal to the stored `open_minor`; A15b the sync endpoints show a MatchSet no later than `cashflow/Receivables`.
- A16 a bank entry line with `Account` (and `OurRef` = invoice number) is NOT settled against the invoice by Exact itself (if it is, the MatchSet read-back shows `already_matched_in_exact`, harmless but noisy).

## Follow-ups (not in M7c)
- Web (M7d): fields for the two control accounts in Settings, Matching (the API accepts them, admin + step-up); the Verify dialog must list the checklist below, including the duplicate-probe check and the lost-answer drill.
- A way to release a `given_up` match whose booking was reversed in Exact (today it stays `manual_required` and keeps its allocation).
- Data health: list matches with `exact_note = already_matched_in_exact` and `manual_required` rows.

## Live checklist
See DEPLOY.md step 10, item 18 (ordered, concrete).
