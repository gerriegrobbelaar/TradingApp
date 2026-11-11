# 0034 Revolut counterparties for matching, quarantine, frozen rows (Phase 5 review Q1)

Status: accepted (task Q1, review items S1, S2, S6, S7, S8, S9, N3, N4). Items marked **verify with sandbox** are
assumptions about Revolut payloads that no real call has confirmed (ADR 0030). The number 0034 may need to change at merge
if another task took it.

## Revolut counterparties for matching (S6)
**Problem.** Matching rule 2 (CLAUDE.md 4.2) needs the counterparty's IBAN. A leg of a Revolut transaction carries
`counterparty.id` / `account_id` / `account_type` and often no IBAN, so `bank_transactions.counterparty_iban` can be NULL
for every payment Revolut made to a saved counterparty.

**Decision.**
- `GET /counterparty/{id}` joins the gate allow-list for **job priority and one job id only**:
  `revolut-counterparty-lookup`. User priority, any other job id, other methods and sibling paths are refused
  (tests in `revolut-q1-counterparties.test.ts`). The response holds a name and IBANs; it is parsed by the client's
  `getCounterparty(id)` and only the cache row is kept. Error messages are redacted in the client (IBANs masked; a non-JSON
  body is never quoted).
- `revolut_counterparties` (migration 0015) is a cache keyed `(connection_id, counterparty_ref)`: status `ok` /
  `not_found` / `error`, name, **full IBAN (never returned by an API, never logged)**, type, `accounts_json`
  (`[{a: account id, i: IBAN, c: currency}]`, at most 10), attempts, fetched_at. Bounded to 5,000 rows per connection
  (oldest fetches pruned).
- The sync fills it **lazily**: after the walk it picks up to **5** counterparty ids per run
  (`COUNTERPARTY_LOOKUPS_PER_RUN`) that appear on stored, unmatched, non-`self` transactions without an IBAN and are not
  cached. The lookups run under their own gate job (own budget of 5), so the poll's 10-call budget is unchanged and a
  quiet run makes none. `not_found` is cached for good; a permanent error is retried after 1 hour, at most 5 times; a
  transient failure (rate limit, gate, network) records nothing and ends the loop; a failed lookup never fails the sync.
- The IBAN is copied to `counterparty_iban` of **unmatched** rows (never a matched/frozen one, S9). The ingest also takes
  the cached IBAN for a new transaction, and keeps a stored IBAN when a later delivery has none. The IBAN of the leg's own
  counterparty account (`counterparty_account_ref`) wins, else the EUR account, else the first with an IBAN.
- Own-account (`self`) legs are not looked up.
- **Verify with sandbox:** that `GET /counterparty/{id}` answers the shape of an element of `GET /counterparties`
  (`id`, `name`, `profile_type`, `accounts[{id, currency, type, iban}]`), that a leg's `counterparty.account_id` is one of
  those account ids, and the real leg field names (`fee`, `balance`, `bill_amount`, `bill_currency`, `reason_code`,
  `counterparty.account_type`) and units (fee assumed in the leg currency).

## Data stored with each leg (S6)
Migration 0015 adds nullable columns: `fee_minor`, `fee_currency`, `balance_minor` (balance after the leg),
`counterparty_ref`, `counterparty_account_ref`, `counterparty_account_type`, `reason_code`, `bill_amount_minor`,
`bill_currency`, `card_last4`, `merchant_name`. The client maps the card number to its **last four digits at parse time**
(`RevolutCardInfo.last4`; the masked number is not kept anywhere), so the full number cannot reach storage or logs.
Same-state refreshes (the backfill) fill them for existing rows while the row is unmatched.

## Per-row quarantine (S2)
`listTransactionsChunk` maps each row on its own. A row that fails mapping (a leg without id, too many decimals, a
zone-less timestamp, duplicate leg ids) goes into `TransactionChunk.rejected` as `{id | null, code}` (the id and a fixed
lower-case code, never payload text); the rest of the page proceeds. Paging uses the **raw** id and `created_at`, so a bad
row can neither stall the cursor nor hide its neighbours; a row with no usable id or timestamp is reported but left out
of the paging arithmetic. Rows the ingest refuses (more than 20 legs, bad leg/amount) are quarantined the same way.
`revolut_quarantine` (connection, external id, code, first/last seen, attempts, last attempt, gave_up) holds them. The run
ends `partial` with code `rows_quarantined` and counts in the summary. A quarantined row that is still inside a walk window
is judged by the walk again; one outside is **retried by a single `GET /transaction/{id}`**, one per poll run, at most once
an hour, at most 5 attempts, then `gave_up` (still reported, no more calls). Only a row that fails to map or store counts
as an attempt, not a rate limit or an outage; a transaction Revolut no longer has is cleared. `GET /api/bank/accounts` has
an additive optional `connection.quarantined` count (ids are never returned).

## Skipped legs and refused changes (S7)
A leg without our account id is counted (`skippedLegs`), written as `skipped_legs` on the stored sibling legs, and the run
ends `partial` with `legs_skipped` (the quarantine code wins when both occur). A transaction whose legs are all foreign
stores nothing (there is no row to hold the count). A refused state change (`state_change_blocked`) sets
`state_conflict = 1` on the row and is counted in `blocked`. The flag is **sticky**: only a person (Phase 7/8) clears it.
Audit rows for non-ok runs are written when the status/code differs from the previous run's, so a standing problem does
not add a row every ten minutes.

## Retry after a 404 (S8)
A 404 for a transaction the webhook named is retried via the queue after 30 s, 2 min and 10 min (the queue's three
redeliveries) before the event settles as `processed` / `transaction_not_found`.

## Frozen rows (S9)
`isFrozen(row)` = the row is FINAL and (has a live `matches` row, or `match_status != 'unmatched'`). For a frozen row the
ingest keeps amount, currency, counterparty name/IBAN/ref/account ref, reference, fee, bill amount and the booking date
exactly as stored. If the incoming data differs in one of these (both values present), or the state moves
(completed -> reverted), `state_conflict = 1` is set and `frozenConflicts` is counted in the summary, for Phase 7/8 to
alert on. State, timestamps and descriptive columns still follow the state table. The update is a compare-and-swap that
also checks the match status and the live-match count that were read, so a match made between the read and the write loses
the swap and the next pass decides again with the row frozen. Pending rows are never frozen.

## Accounts replaced (N3)
When the accounts read is complete and non-empty and none of the accounts this connection had read before is in it
(`balance_at` is set only by that read), the sync treats it as a re-authorisation to other accounts: the cursors, windows,
watermark and counts of the poll and backfill are reset, the 90-day initial backfill is requested (and enqueued), an audit
row `revolut.accounts_replaced` is written. The old accounts are already retired (inactive); their transactions **stay as
history** under the same connection. `queueInitialBackfill(..., {replacesAccounts: true})` does the same reset for the
confirm route, which is wired by the owner of `routes.ts`. No epoch column: an inactive account is the marker, and reads
that want only current data filter on `bank_accounts.is_active`.

## Initial backfill resumability (S1) and bank details (N4)
A walk is in progress as soon as its window is stored (`window_from IS NOT NULL`), cursor or not; it restarts from its first
page with the same bounds and the same `initial` flag. `requested_days` is cleared only when an initial walk **completes**.
The poll uses the same rule. Bank details keep an outcome per account (`details_status` `ok` / `no_iban` / `error`):
`no_iban` is never asked again, `error` is retried after 24 hours at most 5 times, a transient failure records nothing.
The account's own IBAN is preferred: not pooled, SEPA for EUR, SWIFT otherwise (**verify with sandbox**: `pooled`,
`schemes`).

## Not done here
N2 (the `unparsed` re-claim in the webhook route lacks an age test) lives in `webhook-route.ts`, which another task owns.
