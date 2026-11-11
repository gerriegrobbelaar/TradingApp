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
Done in M7c (ADR 0044): booking outbox, `exact_state` transitions, retry and idempotency keys, and the allocation settlement rule that fixes the double count noted under "Undo window". Reversal stays manual (409 `already_booked_in_exact`, detail `reversal_required_in_exact`).
Not done here: auto-ignore of internal transfers (they stay unmatched until a person ignores them), FX matches, group UI.

## Addendum: settlement rule v2 (phase 7 final review S5, migration 0025)
The rule of ADR 0044 ("released once the item was re-read after `booked_at`") trusted that Exact's list read reflects a MatchSet
as soon as the read starts after booking. If it lags, the item reappears fully open and the same money could be allocated again.
New rule, ONE predicate (`SETTLEMENT_PREDICATE` in `apps/worker/src/matching/settlement.ts`, copied verbatim into the migration;
`allocCounts(m, oi, a)` rewrites only its aliases): an allocation of a live match counts, EXCEPT when the match is
`matched_in_exact`, `booked_at < open_items.synced_at`, the baseline `match_allocations.open_before_minor` is known, AND the item
is closed or has no balance or `ABS(open_before_minor) - ABS(open_minor) >= allocated_minor`. Anything else keeps counting:
a lagging read, a partial decrease, an unknown (NULL) baseline. Nothing is released by a timeout. After 48 hours past
`booked_at` a still-counting booked allocation is a data-quality signal: `staleSettlements(db, nowIso)` and
`GET /api/matching/stats` `staleSettlements` (Phase 8 raises the issue; a person reviews it).
- `open_before_minor` is Exact's signed open balance when the match is created (`applyMatch` writes it in the same batch). The
  booking executor calls `recordOpenBefore(db, matchId)` right BEFORE the claim to refresh it to the balance of the last read
  before the MatchSet; a trigger refuses the write once the match left `not_booked`. Rows that existed at migration time have
  NULL = unknown (booking was still off, so no booked match depends on it).
- The remaining allocation fields stay immutable (`match_allocations_guard_update` now lists its columns).
- Known limit: the test is per allocation. Two booked matches against one item are each judged on their own decrease; a decrease
  caused by only one of them can release both, and the over-allocation check then flags the item for review.
- **Trigger pinning (N5).** `apps/worker/test/fixtures/trigger-hashes.json` lists every trigger after all migrations with the
  sha-256 of its whitespace-normalised body; `migrations-all.test.ts` compares the exact list and each hash. Rule: any
  migration that rebuilds a guarded table must recreate its triggers and update the fixture deliberately with
  `pnpm --filter @camelthorn/worker run triggers:update`, reviewing the diff.
- Migration 0025 also lets the outbox immutability trigger accept one change to a finished row: replacing `payload_json` by the
  placeholder `{"v":1,"stage":"redacted"}` (ADR 0011).
