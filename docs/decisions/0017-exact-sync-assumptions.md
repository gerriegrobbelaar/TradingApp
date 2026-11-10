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
  (`last_seen_sync_id <> this run`). A budget stop, rate limit, deadline, API error or auth error
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
3. **Meaning of `Amount`.** The client exposes one open amount in the item's currency. We store it
   as both `amount_minor` and `open_minor`, so the original invoice total is NOT available. The
   original-currency vs EUR-at-booking amounts the brief mentions are not exposed by the client yet,
   so `open_items.rate` and a EUR column are left empty. Matching on part payments and the FX view
   need those fields (ADR 0014 item 3, `AmountDC`/`AmountFC`).
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
   platform's subrequest limit (1,000 on the paid plan when this was written). The default budgets
   stay below it, but a very large FULL read must move to the Phase 3 queue consumer.
9. **A genuinely empty complete list closes everything.** The client rejects wrong envelopes
   (`BAD_SHAPE`), so an empty list is taken as true. Revisit if Exact ever answers an empty page
   for a failed filter.

## Consequences

- Later screens read `open_items` (`status = 'open'`) and `relations`; the four-eyes check reads
  `relations.iban_changed_at` and the `relation.iban_changed` audit rows.
- `sync_state.entity = 'run'` is the single place for "last sync" timestamps; the UI stamps use
  `last_finished_at`.
- Phase 3 should call `syncDivision` from a queue consumer and drop `scheduled.ts`.
