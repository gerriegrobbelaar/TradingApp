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
- `bank_account_exact_map` (account -> division, journal, bank GL; admin, step-up), `ledger_patterns` (regex length cap, safe subset
  checked on write by core and again before every run), settings `matching.config`, `matching.enabled` (default true),
  `matching.auto_enabled` (default **false**).

## Race safety (the database decides)
Triggers abort the whole `db.batch` with `match_err:<code>`: the line must be final+completed, unmatched/suggested, same amount and
currency, and its account mapped to the match's division; an allocation needs a live match, an open item of the same division and
currency, `SUM(live allocations) <= ABS(open_minor)` and `SUM(allocations of the match) <= bank amount`; an undone match cannot revive.
Application code maps the code to `lost_race` / `item_changed` and counts it. Tests: two job runs, job vs person, two lines for one
item (exactly one wins, loser leaves no row and no audit). Change + audit are one batch (ADR 0013).

## Run (`bank.match`)
Per mapped division: up to 500 final completed lines of the last 120 days (least recently checked first; stamped only when capped),
items net of live allocations (`openMinor`; fully allocated = 0 and `hasLiveMatch`), then core `matchBatch`. Suggestions are rewritten
only when the hash changed; `match_status` becomes `suggested` (candidates) or `unmatched`. A `suggested` line is NOT frozen for the
ingest (changed from Phase 5: only `matched`/`ignored` or a live match freeze) and still receives cached counterparty IBANs.
An invalid config or pattern: job `error` `matching_config_invalid`, nothing written.

## Auto-match is opt-in
Only when `matching.auto_enabled` is true AND the engine says `auto`. Switching it on needs an admin with a fresh sign-in and the typed
phrase `ENABLE AUTOMATIC MATCHING`; both directions are audited. Reasoning: a wrong automatic match marks a customer paid and stops
reminders, so people review suggestions first. With auto off the engine's would-be claims still affect later lines in the same run.

## Undo window
Undo is allowed while `exact_state = 'not_booked'` (compare-and-swap in the batch). M7c must move a match to a booking state with a
conditional UPDATE on `not_booked` after a delay, so Undo and booking cannot both win; after that, undo returns 409
`already_booked_in_exact` until M7c adds a reversal. Undo frees the allocations, returns the line to `unmatched`, drops suggestions.

## What M7c adds
Booking outbox (bank entry unless Revolut's feed does it, then MatchSet), `exact_state` transitions, reversal, retry/idempotency keys.
Not done here: auto-ignore of internal transfers (they stay unmatched until a person ignores them), FX matches, group UI.
