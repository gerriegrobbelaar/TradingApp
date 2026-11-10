# 0017 Exact sync: design and unverified assumptions

Status: accepted, provisional. Built (task E3) with no Exact credentials; everything was tested
against a scripted transport and a stubbed `fetch`. It builds on ADR 0014 (API shapes), 0015 (gate)
and 0016 (OAuth). Items under "Verify" must be checked on the first real connection; a wrong guess
is local to `apps/worker/src/exact/sync.ts` or to the client field lists.

## Design

- **Entities, in order:** divisions, relations (`/sync/CRM/Accounts`), bank_accounts (IBANs from
  `/crm/BankAccounts`), receivables, payables. One `sync_state` row per division and entity plus
  an entity `run` row for the whole run (what the UI shows).
- **FULL** reads open receivables/payables from the bulk list resources
  (`ReceivablesList`/`PayablesList`) completely, upserts them in batches of at most 100 statements,
  and only then, in the final batch, closes the open items of that kind it did not see
  (`last_seen_sync_id` lower than this run's `run_seq`, and only while this run still holds the
  lease; see "Closing guards"). A budget stop, rate limit, deadline, API error or auth error
  on that entity means nothing is closed. Relations restart from Timestamp 0 unless the previous
  pass of that entity is a half-done FULL pass (`last_status = partial` and `mode = full`), in which
  case they resume from the saved cursor.
- **INCREMENTAL** continues every cursor-based entity from its saved Timestamp and never closes by
  absence. A row whose open amount is zero is stored as closed. The first incremental pass of
  receivables/payables reads the sync endpoints from cursor 0.
- **Resumable in chunks.** Cursor reads go `chunkPages` (5) pages at a time; rows and cursor are
  written after every chunk, so a stop loses at most one chunk. The open-item FULL read is one
  bulk read and is NOT resumable mid-entity: it restarts that entity next time. A budget below
  the number of pages in the list can therefore never finish a FULL receivables read (a 5,000-row
  list is about 84 pages at 60 rows per page). Defaults: manual 300 calls, scheduled full 600,
  hourly incremental 120.
- **Errors.** Budget, rate limit and the deadline stop the run as `partial`. `ExactAuthError`
  stops it as `needs_reauth` (recorded in `sync_state`, no retry; the scheduler also skips the
  other divisions of that connection). Other `ExactApiError`s are recorded with a short code
  (`http_400`, `gate_unavailable`, ...) and the next entities still run, so one bad endpoint does
  not hide the rest. Unknown exceptions stop the run as `error` / `internal_error`; only the error
  name is logged. `endJob` is always called in a `finally`.
- **Lock.** `sync_locks` holds a 15-minute lease per division. Taking it is one
  `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now RETURNING run_seq`, so of two
  concurrent runs exactly one gets a row. Chosen over a Durable Object because the state is in D1
  already, a crashed run frees itself when the lease expires (no alarm needed) and a single
  statement is race-free. `run_seq` is the sync id stored in `open_items.last_seen_sync_id`. A
  second caller gets `locked` (HTTP 409 `sync_running`) and nothing is written or audited.
- **Audit (ADR 0013).** One `exact.sync` audit row per run, in the same `db.batch` as the closes
  and the final `sync_state` rows; no per-row audit. IBAN changes get their own
  `relation.iban_changed` row, in one batch with the update, guarded by the old value, with the IBAN
  masked (`NL91****4300`). Actor is `system` for the scheduler and the user's email for manual runs.
- **IBAN change rule.** A different IBAN on a relation that has one is a change. A first IBAN on a
  relation sets `iban_changed_at` only if a previous IBAN pass already completed (so the very
  first sync does not flag every supplier). A relation that loses all bank accounts keeps its last
  IBAN. The main bank account wins, otherwise the lowest IBAN.
- **Migration 0005 does not rebuild `open_items`.** Dropping it would fire the `ON DELETE
  CASCADE` of `reminders` and `match_suggestions` and delete them, so the 0004 copy-aside pattern
  is unsafe here. Columns are added instead (`entry_number`, `closed_at`, `last_seen_sync_id`) and
  the `status IN ('open','closed')` rule is enforced by triggers. `kind` keeps its 0003 values:
  `invoice` = receivable, `bill` = payable. Tested on a populated database.
- **Scheduled stopgap (`exact/scheduled.ts`).** One hourly UTC cron. The handler uses the
  Amsterdam wall clock: from 02:00 to 05:59 the first tick without a completed full sync that
  Amsterdam day is FULL, every other tick INCREMENTAL. This survives daylight saving time (no 02:00
  on the spring-forward day, 02:00 twice on the fall-back day). Phase 3 replaces it.
- **Division preference** lives in `user_prefs (user_id, division_id)`, validated against divisions
  of non-disabled Exact connections on write and on read (a stale choice falls back to the first
  division). The API ids are our `divisions.id`, never the Exact division number.

## Verify with real credentials

1. **Sync endpoints for open items** (`/sync/Cashflow/Receivables`, `/Payables`; ADR 0014 item 4).
   If they do not exist or lack open amount, incremental open-item sync does not work; fall back
   to the nightly FULL sync only (the hourly tick would then fail with `http_400`/`BAD_SHAPE`
   per entity and keep the rest).
2. **Do the sync endpoints return paid or closed rows?** We assume they return changed rows and a
   paid row has amount 0. If closed rows keep a non-zero amount, incremental never closes them
   (the nightly FULL does). If they also return stale rows, incremental could reopen an item the
   FULL run closed.
3. **Amount fields.** Bulk lists (`ReceivablesList`/`PayablesList`) give one `Amount` + `CurrencyCode`,
   taken as the OPEN amount in the item currency. The cashflow sync resources are read with
   `AmountFC` (open, item currency; forced to 0 when `IsFullyPaid`), `AmountDC` (same in the
   division currency, scaled by `divisions.base_currency`), `TransactionAmountFC` (invoice total)
   and `RateFC` (booked rate, kept as a decimal string; anything that is not a positive plain
   decimal is stored as unknown). All five names and meanings are guesses from the cashflow
   model: **verify with credentials**. If `$select` rejects one, the incremental open-item read
   fails with `http_400` and only the nightly FULL keeps open items right.
   Stored as (migration 0005): `open_minor` open balance (part payments keep the remainder),
   `original_minor` invoice total or NULL, `amount_minor` = original when known else open,
   `open_dc_minor` + `dc_currency` (snapshot, cleared when a read does not carry it so it is never
   stale), `rate`. Original total and rate are kept when a later bulk read lacks them (same
   currency only).
4. **`system/Divisions`** may list only the current division, or archived/test divisions as well.
   All returned divisions are upserted by name and then synced hourly, so a long list costs budget.
   There is no `currentMe` fallback in the sync (it would need the division 0 gate).
5. **Dates.** Stored as Amsterdam calendar dates (`YYYY-MM-DD`), assuming a Dutch division. A
   division in another timezone would need its own zone.
6. **Account `IsSales`** is read as "customer". Exact has account statuses (customer, supplier,
   prospect) that may be more accurate.
7. **Bank accounts per relation** come from one full `crm/BankAccounts` read on every run
   (hourly as well). Cost is `ceil(rows / 60)` calls per hour per division; if that is too much,
   read it only when accounts changed, or only in FULL mode.
8. **Subrequest limit.** Each gate RPC and each D1 call in a Worker invocation counts toward the
   platform's per-invocation subrequest limit. We assume the conservative 1,000 (`SUBREQUEST_LIMIT`)
   until the account's actual limit is checked. Every run counts its gate calls and D1 calls on a
   meter shared by the whole invocation (the scheduler syncs all divisions in one) and stops as
   `partial` / `subrequest_limit` while 25 remain for the final batch, `endJob` and the release.
   The scheduler leaves the remaining divisions for the next tick.
9. **A complete but empty list.** The client rejects wrong envelopes (`BAD_SHAPE`), so an empty
   list is taken as true, but see the empty-list guard below.

## Closing guards (review E3)

- Only a FULL read of that kind that completed and was written closes, only rows of that division
  and kind, and never after a partial, failed, rate-limited, budget-, time- or subrequest-stopped,
  or auth-failed read. Incremental runs never close by absence.
- **Empty-list guard.** If a complete FULL list is empty while more than `EMPTY_CLOSE_GUARD` (5)
  items of that kind are open, nothing is closed and the entity ends `error` /
  `empty_list_guard` (shown in the Data sync card). A wrong division, licence or filter is far more
  likely than every invoice being paid at once. An admin can confirm with
  `POST /api/divisions/:id/sync {"mode":"full","allowEmptyClose":true}` (audited in the
  `exact.sync` row); the UI for this belongs to the Data health screen (Phase 8). A division with
  5 or fewer open items closes them normally.
- **Lease guard.** The close statement only runs while `sync_locks` still has this run's holder
  and `run_seq`; open-item upserts only apply when the run is not older than the run that last saw
  the row. A run that outlives its lease can therefore neither close nor overwrite what a newer run
  wrote. Lease 15 minutes; manual runs stop after 20 s and scheduled ones after 12 minutes, checked
  before every Exact call (not only between chunks), so a long bulk read cannot overrun.
- **Scheduler.** Inside the 02:00-05:59 window only a `partial` (or interrupted `running`) full
  sync is retried; a full sync that ended `error` or `needs_reauth` is not repeated that day, so a
  broken endpoint cannot spend 4 x 600 calls of the 5,000 daily budget.

## Consequences

- Later screens read `open_items` (`status = 'open'`) and `relations`; the four-eyes check reads
  `relations.iban_changed_at` and the `relation.iban_changed` audit rows.
- `sync_state.entity = 'run'` is the single place for "last sync" timestamps; the UI "Updated x ago"
  stamps use `last_completed_at` (last run that ended `ok`); `last_finished_at` is the last attempt.
- Phase 3 should call `syncDivision` from a queue consumer and drop `scheduled.ts`.
