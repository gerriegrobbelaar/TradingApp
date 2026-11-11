# 0042 Matching data model, run, race safety and undo (Phase 7, M7b)
Status: accepted. Code: `apps/worker/src/matching/`, migration `0022_matching.sql`. The engine itself is ADR 0041.
Internal only: this task never writes to Exact or Revolut. M7c (booking outbox) builds on it.

## Data model
- `matches`: one row per bank line (partial UNIQUE on `bank_transaction_id` where `undone_at IS NULL`), `source` auto|manual|ledger,
  `division_id`, absolute `amount_minor`, `score`/`rule` (NULL for people), `created_by` (email or `system`), `undone_*`,
  `exact_state` (default `not_booked`; free lower-case word so M7c adds states without a rebuild). `status` is a GENERATED column
  from `undone_at`, so the Phase 5 queries (`undone_at IS NULL`) and the new ones can never disagree.
- `match_allocations`: one row per open item of a match (positive magnitude, so credit notes work), UNIQUE (match, item), index
  (open_item_id, match_id) for "live allocations per item". Matches and suggestions were rebuilt copy-aside (nothing wrote to them before).
- `match_suggestions`: recomputable cache, UNIQUE (tx, rank), codes and weights only plus cleaned explanation lines, `input_hash`
  (tx snapshot + all items of the division + config + engine version), `engine_version`.
- `matches.review_reason` / `review_flagged_at`: see "Data that changes after matching".
- `bank_account_exact_map` (account -> division, journal, bank GL; admin, step-up), `ledger_patterns` (regex length cap, safe subset
  checked on write by core and again before every run), settings `matching.config`, `matching.enabled` (default true),
  `matching.auto_enabled` (default **false**).

## Race safety (the database decides)
Triggers abort the whole `db.batch` with `match_err:<code>` (full list in the migration header):
- match insert: the line is final+completed, has no state conflict, is unmatched/suggested, same amount and currency; its account is
  mapped to the match's division; that division is synced and its Exact connection not disabled; the row is inserted live,
  `not_booked` and unflagged;
- match update: an undone match never revives; line, division, source, ledger account, amount and currency are immutable;
- allocation insert: a live match without a ledger account, an open item of the same division and currency, a compatible direction
  (money in pays invoices and supplier credit notes, money out bills and customer credit notes), `SUM(live allocations) <=
  ABS(open_minor)` and `SUM(allocations of the match) <= bank amount`; allocations are never updated;
- bank_transactions: amount, currency and account of a line with a live match never change (`tx_frozen`); `match_status = 'matched'`
  if and only if a live match exists (`status_mismatch`);
- bank_account_exact_map: the division cannot change, and the row cannot be deleted, under live matches.
Application code maps the code to `lost_race` / `item_changed` and counts it. Change + audit are one batch (ADR 0013).
`checkMatchingInvariants(db)` (`matching/invariants.ts`, a fixed number of read queries, ids and codes only) asserts the consistency
rules after every race test and is meant for the Phase 8 data-quality monitor. Tests: two job runs, job vs person vs ignore vs undo on
one line, four lines for one item, undo vs the booking claim, the Exact sync lowering a balance mid-run, the ingest flagging or
changing the line mid-run, a person ignoring mid-run (`matching-guards.test.ts`).

D1 notes: the triggers, the partial UNIQUE index and the VIRTUAL generated column are standard SQLite and run on Miniflare's D1.
D1 documents a batch as one transaction ("if a statement fails, the entire batch is rolled back"); the trigger-abort rollback is
tested on Miniflare only, so it is a first-live check in DEPLOY.md.

## Data that changes after matching (needs review)
The triggers only guard writes to the matching tables. The Exact sync can still lower or close an item after it was matched (paid
elsewhere), and Revolut can contradict a matched line (`state_conflict`). Every run ends with ONE `flagMatchesForReview` statement:
live, `not_booked` matches get a sticky `review_reason` (`tx_state_conflict`, `tx_changed`, `item_closed`, `over_allocated`). A
flagged match stays live (its items stay taken, nothing is double-offered), shows in `matchesNeedingReview` and on the match, can be
undone, and is NEVER booked: `claimMatchForBooking` refuses it. Booked matches are not flagged (Exact's balance falls because we booked).

## Manual match
Besides the engine-independent checks (sum equals the bank amount, per item at most the free balance, currency, direction, line final
and open, account mapped to a synced division), an item of ANOTHER relation than the one the line's IBAN belongs to (active IBANs in
that division) needs `confirmDifferentRelation: true` (409 `different_relation` otherwise; the confirmation is in the audit row). An
IBAN we do not know gives no signal. Clearing a state conflict re-enables matching of the line: admin, fresh sign-in, a written note
(audited).

## Run (`bank.match`)
Per mapped division: up to 500 final completed lines of the last 120 days (least recently checked first; stamped only when capped),
items net of live allocations (`openMinor`; fully allocated = 0 and `hasLiveMatch`), then core `matchBatch`. Suggestions are rewritten
only when the hash changed; `match_status` becomes `suggested` (candidates) or `unmatched`. A `suggested` line is NOT frozen for the
ingest (changed from Phase 5: only `matched`/`ignored` or a live match freeze) and still receives cached counterparty IBANs.
An invalid config or pattern: job `error` `matching_config_invalid`, nothing written.

## Auto-match is opt-in
Only when `matching.auto_enabled` is exactly JSON `true` AND the engine says `auto` AND the worker's own input check passes
(`autoInputGap`: type present, Amsterdam booking day present, counterparty account type present except for card payments, final,
not frozen, no conflict; otherwise `incomplete_input`, review only). Switching it on needs an admin with a fresh sign-in and the
typed phrase `ENABLE AUTOMATIC MATCHING`. Switching it OFF is the safe direction: `POST /api/matching/auto/disable` needs an admin
but no fresh sign-in and no phrase. Both directions are audited. The default-jobs upgrade (version 3) only inserts the missing
`bank.match` job (`ON CONFLICT DO NOTHING`) and never touches `matching.auto_enabled` or a job an admin switched off.
Reasoning: a wrong automatic match marks a customer paid and stops reminders, so people review suggestions first.
The engine blocks an item for later lines as soon as it decides `auto` for an earlier line. When that match is not actually made
(auto off, a lost race, incomplete input) the run removes the false `claimed_by_earlier_transaction` block before storing the
suggestions; a failed automatic match still writes the line's suggestions (it never sits at the head of the queue run after run).

## Undo window
Undo is allowed while `exact_state = 'not_booked'` (compare-and-swap in the batch). M7c moves a match out of `not_booked` ONLY through
`claimMatchForBooking` (store.ts): `UPDATE ... WHERE undone_at IS NULL AND exact_state = 'not_booked' AND review_reason IS NULL`, so
Undo and booking cannot both win (tested in both orders); M7c adds its audit row to that batch and the delay before claiming. After
that, undo returns 409 `already_booked_in_exact` until M7c adds a reversal. Undo frees the allocations, returns the line to
`unmatched`, drops suggestions.
M7c must also revisit what counts against an item's balance: today every LIVE allocation counts (trigger and assembly). Once a match
is booked and the sync has lowered `open_minor`, its allocation would count twice; M7c must exclude allocations already reflected in
Exact (for example booked and synced after the booking) in the trigger, the assembly, the review flags and the invariants together.

## What M7c adds
Done in M7c (ADR 0043): booking outbox, `exact_state` transitions, retry and idempotency keys, and the allocation settlement rule that fixes the double count noted under "Undo window". Reversal stays manual (409 `already_booked_in_exact`, detail `reversal_required_in_exact`).
Not done here: auto-ignore of internal transfers (they stay unmatched until a person ignores them), FX matches, group UI.
