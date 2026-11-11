# 0043 Booking to Exact: outbox, executor, fail-closed writes (Phase 7, M7c)
Status: accepted; NEVER RUN against a real Exact (every Exact name and behaviour is ADR 0040's assumption list, plus A12/A13 below).
Code: `apps/worker/src/booking/` (settings, plan, outbox, executor, routes), `exact/write-policy.ts`, migration 0023, `BOOKING_PROTOCOL_VERSION`.

## State machine (outbox row, with the match's `exact_state`)
| Row status | Entered when | Leaves to | Match state |
|---|---|---|---|
| pending | claim batch stores payload + key (match `not_booked` -> `booking`); admin retry (`needs_probe`) | sending, waiting, manual_required | booking / bank_entry_created |
| sending | stored BEFORE every POST (attempts + 1) | sent_unverified, pending (nothing sent, or 429), failed (Exact 4xx), outcome_unknown | unchanged |
| sent_unverified | answer accepted, not yet read back | verified, failed (not applied), outcome_unknown | unchanged |
| verified | bank line probed / MatchSet items read back closed | final | `bank_entry_created`, then `matched_in_exact` + `booked_at` |
| failed | Exact refused (no auto retry) or MatchSet not applied (3 tries, 5/30/120 min) | pending (admin or backoff), given_up | booking_failed |
| outcome_unknown | thrown, timeout, 5xx, 3xx, unreadable answer or 401 AFTER a POST | pending ONLY by admin retry | outcome_unknown |
| manual_required / waiting_for_bank_line | plan failure or ambiguity / feed line missing (48 h) | resolved_manually, given_up / pending | manual_required / booking |
Transitions are conditional UPDATEs in one batch with their audit row (`changes() = 1` chain, first live check); a trigger refuses illegal `exact_state` moves.

## Fail-closed layers (all must agree)
1. `exact.booking_enabled` (default false) + `exact.booking_verified` whose `protocolVersion` = current `BOOKING_PROTOCOL_VERSION` (sha-256 of names, sign, builder rules and sample builder output: any change invalidates it). Enabling: admin, fresh sign-in, phrase `ENABLE EXACT BOOKING`, verification, active Exact connection, Revolut `bank_entries_decided_at`; re-checked in the write itself. A new verification switches booking OFF. Disabling: admin only, audited.
2. The job `exact.book_matches` ships disabled, checks the same state again (`booking_disabled`), runs admin + step-up, 30 calls per run and 400 per 24 h (`dailyExactCallCap` feeds the schedule projection).
3. `ExactGate` refuses every non-GET except POST BankEntries and XML upload for topic MatchSets, only for job `exact-booking` at priority `job`, re-reading switch and mark from D1 at request, before the token and before the fetch (`writes_disabled`); no redirects; POSTs never retried (a 401 refreshes the token, then `ExactWriteAuthRetryRefused`); writes count against the job budget.
4. The writer guard (ADR 0040) and the source scan: only `booking/executor.ts` holds the writer; only it and the policy know the job id.

## Never re-POST
Outbox row (payload = builder INPUT with sanitised text, hash checked, body rebuilt and compared with `builtHash`) and idempotency key are written before any call. Bank entry: YourRef probe before every POST. MatchSet: read-back before every POST (`verified` = skip, `inconclusive` = manual) and after it. Stale `sending` -> outcome_unknown. At most one bank entry per journal in flight (its closing balance is the next opening, A12).
**outcome_unknown procedure:** look in Exact for the bank entry (YourRef = Revolut id) and the MatchSet. Done -> `booked_manually`. Absent -> `retry` (executor probes first; no duplicate if it shows up). Not wanted -> `give_up`. Resolution covers every open row of the match.

## Allocation settlement (fixes ADR 0042's double count)
An allocation counts against an item until its match is `matched_in_exact` AND the item's `synced_at` is later than `booked_at`; the sync stamps `synced_at` BEFORE it reads, so a later stamp means Exact's own `open_minor` already has the payment. Same predicate (`allocCounts`) in the trigger, assembly, manual check, review flags, invariants. Failed, unknown and manual states keep counting.

## Manual in v1
Part payments, surplus, credit-note netting, several relations, foreign currency (FX), a ledger booking when Revolut's feed owns the line, unknown control account or bank balance, reversal (Undo stays 409 `already_booked_in_exact`, detail `reversal_required_in_exact`: reverse the MatchSet and the bank entry in Exact, then mark the outbox rows `given_up`).

## Added assumptions (verify on the test division)
A12 `BankEntries` latest `EntryNumber` has `ClosingBalanceFC` = next opening. A13 `BankEntryLines` filters on `AmountFC`, `Date`; the feed leaves a line in the mapped journal. A14 MatchSet `GLAccount` is the debtor/creditor control account (`bank_account_exact_map.receivable_gl_account_code` / `payable_...`); signs: debtor invoice +, receipt -, creditor bill -, payment +. A15 read-back `AmountFC` is the signed open amount equal to the stored `open_minor`.

## Live checklist (DEPLOY.md step 10, item 18)
1. Test division, test journal, test debtor, one invoice. 2. Set the map (journal, control accounts) and `creates_bank_entries`. 3. Run the ADR 0040 checks A1-A11 by hand. 4. Verify (note), enable, run once on one match; check the entry and the MatchSet in Exact. 5. Repeat with a lost answer (block the network) and the `retry`. 6. Only then production, switch on the job.
