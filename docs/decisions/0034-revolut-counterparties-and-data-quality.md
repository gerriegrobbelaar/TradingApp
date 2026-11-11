# 0034 Revolut counterparties for matching, quarantine, frozen rows (Phase 5 review Q1)

Status: accepted (task Q1, review items S1, S2, S6, S7, S8, S9, N3, N4). Items marked **verify with sandbox** are
assumptions about Revolut payloads that no real call has confirmed (ADR 0030). Migration 0015 runs before 0016 (Q2,
webhook health) and 0017 (Q3, `open_items.stored_minor`); nothing here touches `open_items`.

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
  (`[{a: account id, i: IBAN, c: currency}]`, at most 10), `attempts` (failed attempts since the last answer),
  `fetched_at` (last answer), `checked_at` (last attempt). Bounded to 5,000 rows per connection (oldest answers
  pruned; a pruned id is simply looked up again when a row needs it).
- The sync fills it **lazily**: after the walk it picks up to **5** counterparty ids per run
  (`COUNTERPARTY_LOOKUPS_PER_RUN`) that appear on stored, unmatched, non-`self` transactions without an IBAN and are not
  cached. The lookups run under their own gate job (own budget of 5), so the poll's 10-call budget is unchanged and a
  quiet run makes none. A permanent error is retried after 1 hour, at most 5 times in a row, then once a week (an
  outage never parks an id for good); a transient failure (rate limit, budget, gate, network, 5xx) records nothing
  and ends the loop; a failed lookup never fails the sync.
- **Freshness (review of Q1).** An answer (`ok` or `not_found`) is read again after **7 days** while an unmatched row
  still depends on it (its IBAN is missing or came from the cache), so matching rule 2 and the IBAN-change checks of
  Phase 9 are not fed a stale IBAN. A refresh that fails keeps the last answer (status and IBAN) and only counts the
  attempt. `bank_transactions.counterparty_iban_cached` says where a row's IBAN came from: `1` = the cache, which
  follows a changed answer on **unmatched** rows (the leg's account first, else the preferred account; none left =
  none); `0` = Revolut sent it on the leg, never rewritten. Matched rows are never rewritten, and a cache change is
  never a frozen-row conflict (only data Revolut itself sends can be).
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
Units: `fee_minor` is the leg's fee in minor units of the **leg currency** (`fee_currency` is always the leg currency),
stored with the sign Revolut sends (the sign is not documented; matching must use its magnitude until the sandbox shows the
sign); `balance_minor` is the account balance after the leg, leg currency; `bill_amount_minor` is scaled by the **bill
currency's** minor units (JPY 0, EUR 2, ...), not the leg's; a bill amount without a bill currency is dropped. None of
these columns, nor `counterparty_ref` / `counterparty_account_ref` (internal provider ids), is returned by the read API:
`src/read/bank-routes.ts` maps its columns explicitly.

## Per-row quarantine (S2)
`listTransactionsChunk` maps each row on its own. A row that fails mapping (a leg without id, too many decimals, a
zone-less timestamp, duplicate leg ids) goes into `TransactionChunk.rejected` as `{id | null, code}` (the id and a fixed
lower-case code, never payload text); the rest of the page proceeds. Paging uses the **raw** id and `created_at`, so a bad
row can neither stall the cursor nor hide its neighbours; a row with no usable id or timestamp is reported but left out
of the paging arithmetic. Rows the ingest refuses (more than 20 legs, bad leg/amount) are quarantined the same way.
`revolut_quarantine` (connection, external id, code, first/last seen, attempts, last attempt, gave_up) holds them. The run
ends `partial` with code `rows_quarantined` and counts in the summary. A quarantined row that is still inside a walk window
is judged by the walk again; one outside is **retried by a single `GET /transaction/{id}`**, one per poll run, at most once
an hour, at most 5 attempts, then `gave_up` (still reported, no more calls). A row that fails to map or store, or a 4xx
for that transaction, counts as an attempt; a 5xx does not count but the row still waits the hour (no call every poll
for a transaction Revolut keeps failing on); a rate limit, an exhausted budget, the gate or the network records nothing;
a transaction Revolut no longer has is cleared; a row that later stores (by a walk or the retry) leaves the table, gave_up
or not. **Retention:** at most 1,000 rows per connection (least recently seen go first) and a `gave_up` row is deleted 30
days after a walk last saw it (outside every window by then; if it ever comes back it is quarantined again), done by the
poll (`pruneQuarantine`). `GET /api/bank/accounts` has additive optional counts `connection.quarantined` and
`connection.quarantineGaveUp` (ids are never returned).

## Skipped legs and refused changes (S7)
A leg without our account id is counted (`skippedLegs`), written as `skipped_legs` on the stored sibling legs, and the run
ends `partial` with `legs_skipped` (the quarantine code wins when both occur). A transaction whose legs are all foreign
stores nothing (there is no row to hold the count). A refused **final -> final** change (`conflict_blocked`: failed ->
completed, reverted -> completed, ...) sets `state_conflict = 1` on the row and is counted in `blocked`. A pending read of
a final row (`regress_blocked`) is counted in `blocked` but **not flagged**: it is what a lagging read or a pending
webhook that loses a race to the completion looks like (the CAS interleaving test produced exactly that), and a sticky
flag on it would be a false alarm. A run that turned a flag on (`conflictsFlagged`, frozen conflicts included) ends
`partial` with code `state_conflict` (it wins over the other two codes: it concerns money that may be booked); the next
run is `ok` again unless something new happens, the flag stays on the row. The flag is **sticky**: only a person clears
it. `src/revolut/conflicts.ts` is the consumer API for Phase 7/8: `listStateConflicts` (ids, state, amount, currency;
never an IBAN, name or reference), `countStateConflicts`, `clearStateConflict` (guarded, with its audit row in the same
batch; the caller's route checks the role). `GET /api/bank/accounts` has an additive optional
`connection.stateConflicts` count.
Audit rows for non-ok runs are written when the status/code differs from the previous run's, so a standing problem does
not add a row every ten minutes.

## Retry after a 404 (S8)
A 404 for a transaction the webhook named is retried via the queue (`message.retry({ delaySeconds })`, Workers Queues
API) after 30 s, 2 min and 10 min, chosen by the delivery number (`msg.attempts`), before the event settles as
`processed` / `transaction_not_found`. The 404 retries share the queue's `max_retries = 3` with the other retryable
errors: whatever mix of 404s and rate limits happens, the 4th delivery always settles the row (`processed` for a 404,
`error` with the code otherwise), so it never reaches the DLQ as `queued`. If the handler itself throws on the last
delivery (D1 down), the consumer marks the row `error` / `internal` (best effort) before the message goes to the DLQ.
Interplay with the webhook housekeeping (Q2): the sweep re-enqueues a row still `queued` 15 minutes after it was received;
the three 404 delays add up to 12.5 minutes, so a plain 404 sequence settles first. A sequence stretched by long
rate-limit waits can be re-enqueued by the sweep: the duplicate message is harmless (the handler and the upsert are
idempotent, and the sweep's re-enqueues are bounded by `MAX_REQUEUES`).

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
(`balance_at` is set only by that read), the replacement is only **suspected**: the old ids go to
`revolut_sync_state.pending_replacement` (entity `accounts`), nothing is retired or reset, the summary says
`accountsReplacementSuspected`. One such answer could be a glitch or a permission change at Revolut. A **second complete
read in a row** that still lists none of them confirms it: the cursors, windows, watermark and counts of the poll and
backfill are reset, the old accounts retired, the 90-day initial backfill requested (and enqueued), an audit row
`revolut.accounts_replaced` written. A read that lists one of the old ids again clears the suspicion; an empty or failed
read decides nothing. The old accounts' transactions **stay as history** under the same connection.
`queueInitialBackfill(..., {replacesAccounts: true})` is the explicit signal for the confirm route (wired by the owner of
`routes.ts`): it resets at once, audits with the person's email, and marks the next accounts read so that it only retires
the old accounts and does not detect (and reset) the same replacement a second time. No epoch column: an inactive account
is the marker, and reads that want only current data filter on `bank_accounts.is_active`.

**Concurrent reset (walk identity).** Every save of a walk's progress (cursor per page, the completion patch: watermark,
`requested_days`, `last_missing`, counts) is conditional on the stored walk still being the one the run works on
(`window_from` and `walk_started_at` unchanged). A reset from the sync or the confirm route while a backfill or poll is
running therefore wins: the old walk stops (`walk_superseded`), cannot resurrect its cursor, and cannot consume the new
90-day request.

## Initial backfill resumability (S1) and bank details (N4)
A walk is in progress as soon as its window is stored (`window_from IS NOT NULL`), cursor or not; it restarts from its first
page with the same bounds and the same `initial` flag. `requested_days` is cleared only when an initial walk **completes**.
The poll uses the same rule. An initial request that arrives while an ordinary daily walk is in progress **supersedes** it
(the 90-day window covers the 35-day one, and the manual run queued with the request must do the initial walk; the daily
walk's missing count is not recorded). A first page that keeps failing costs at most the run's budget (12 calls) per run;
scheduled runs retry at most 6 times, manual ones never; the window is kept. Every backfill summary carries
`initialBackfillPending` (true while an initial walk has not completed, whatever stopped it, a failing first page with
an `error` status included) and `GET /api/bank/accounts` has `connection.initialBackfillPending` (review N7). `missing` is
saved with each page's cursor in one statement, so a stop and a resume never count a row twice.

Bank details keep an outcome per account (`details_status` `ok` / `no_iban` / `error`): `no_iban` is never asked again,
`error` is retried after 24 hours at most 5 times, a transient failure records nothing, an authentication error ends the
run (it is the connection's problem, not the account's). The account's **own** IBAN only: never a pooled one (Revolut's
shared collection account, told apart by a reference; stored as "our IBAN" it would identify the wrong account), SEPA
first for EUR, SWIFT first otherwise, else the first own entry with an IBAN; only pooled details = `no_iban`. A BIC left
empty by an earlier failed lookup is filled when the IBAN arrives (**verify with sandbox**: `pooled`, `schemes`).

## Tests and the wall clock
No test waits for real time: the gate's clock and sleeper are replaced where a test needs them (`fakeRevolutClock`),
and the Revolut client's 5xx backoff (0.5 s + 2 s) is a no-op in tests through `setRevolutClientSleepForTests`
(`src/revolut/client-timing.ts`, set in `test/do-namespace.ts`; production never calls it). That backoff was the main real
wait in the worker suite (about 85 s of test time, the cause of timeouts under load).

## Not done here
N2 (the `unparsed` re-claim in the webhook route lacks an age test) lives in `webhook-route.ts`, which another task owns.
