# 0017 Exact sync: design and unverified assumptions

Status: accepted, provisional. Built (task E3, reworked in G1 after the Phase 2 review) with no
Exact credentials; everything was tested
against a scripted transport and a stubbed `fetch`. It builds on ADR 0014 (API shapes), 0015 (gate)
and 0016 (OAuth). Items under "Verify" must be checked on the first real connection; a wrong guess
is local to `apps/worker/src/exact/sync.ts` or to the client field lists.

## Design

- **Entities, in order:** divisions, receivables, payables, relations (`/sync/CRM/Accounts`),
  bank_accounts (IBANs from `/crm/BankAccounts`). Open items are what users look at, so they
  refresh first (G1; before, 5,000+ bank accounts could eat the whole hourly budget). One
  `sync_state` row per division and entity plus an entity `run` row for the whole run (what the UI
  shows).
- **FULL runs work in cycles that can span many runs** (migration 0006). The cycle is recorded on the
  `run` row (`cycle_seq` = the `run_seq` of the run that started it, `cycle_started_at`). Inside a
  cycle each entity is read completely once (`done_cycle`) and later runs of the cycle skip it; the
  cycle ends when every entity it covers is done, and the next full run starts a new one. A cycle
  older than 36 hours (`CYCLE_MAX_AGE_MS`) is abandoned, and a run with `restart` abandons it
  explicitly. Divisions are cheap (one call) and always re-read. A crash between chunk and final
  batch is safe: saved tokens carry the cycle they belong to (`pass_cycle`) and are ignored by
  any other cycle.
- **Resumable bulk reads.** Receivables and payables are read from `ReceivablesList` /
  `PayablesList` in chunks of `chunkPages` (5) pages. Each chunk is written in ONE batch together
  with the `$skiptoken` to continue from and the pass progress (`pass_token`, `pass_rows`,
  `pass_total`); if a page after the first fails, the client hands back the pages it did read
  (`ListChunk.error`) and the sync writes them before rethrowing, so a stop anywhere loses nothing.
  The read is COMPLETE only when Exact returns a last page. Then, in the final batch, open items
  of that kind last seen BEFORE the cycle began (`last_seen_sync_id < cycle_seq`) are closed
  (still only while this run holds the lease). Items the cycle's reads, or an hourly incremental
  run in between, have seen carry a newer `run_seq` and stay open. A partial, failed,
  rate-limited, time-boxed or subrequest-stopped run never closes anything. A permanent API error
  while resuming drops the saved token so it is not retried until the cycle expires.
- **INCREMENTAL** continues every cursor-based entity from its saved Timestamp and never closes by
  absence. A row whose open amount is zero updates a row we know to closed; a closed row we have
  never seen is NOT inserted (G1: the first pass from cursor 0 would import the whole paid
  history as closed rows). Incremental runs never read IBANs. Note the cost: after the first
  full sync the open-item incremental cursors still start at 0 and walk the sync endpoint once,
  history included, inside the hourly budget (`ceil(rows / page size)` calls over as many hourly
  ticks as it takes; the volume test shows 9 calls at 1,000 per page for the reference
  division). Seeding the cursor with the latest Timestamp (`$orderby=Timestamp desc&$top=1`
  taken before a full pass) would remove it, but needs that query verified on real Exact.
- **IBANs are read in scheduled FULL runs only** (`readIbans`; B1a). Manual runs skip them. Of the
  two options (full only, or per-relation reads for relations whose Timestamp changed) the full
  read is cheaper: `ceil(4,000 / 60) = 67` calls once a night against one call per changed
  relation every hour (a few dozen a day, more after an import). The price is that a changed IBAN
  is noticed within a day, so Phase 9 must re-read the supplier's IBAN
  (`listBankAccounts({ accountId })`, one call) when a payment is prepared. The read is one piece:
  when the budget left cannot cover what the previous read needed (`rows_seen / 50` calls) it is
  not started and the next run begins with a fresh budget.
- **Manual runs are time-boxed slices (B1d).** `POST /api/divisions/:id/sync` runs one slice:
  60 Exact calls (`MANUAL_SYNC_BUDGET`) and 20 s. It always reads at least one page of the first
  entity that has work, even if the deadline has passed (`guaranteeProgress`), answers `partial`
  with `entities.<kind>.progress = { read, total }` ("Read 1,240 of about 5,000 receivables"; the
  total is the number of open items of that kind we held before the pass, null when unknown) and
  the next call continues the cycle. One new run per division per 60 s (`MANUAL_COOLDOWN_MS`):
  429 `cooldown` with `retryAfterSeconds` and a `Retry-After` header, except continuing a
  partial run of the same mode (not after a rate limit). `GET /api/divisions` returns the
  remaining cooldown per mode. A manual full run covers everything but IBANs and does not count
  as the night's full sync (`last_full_completed_at`).
- **Budgets (S2).** Scheduled full runs get 240 Exact calls, hourly incremental runs 40
  (`SCHEDULED_FULL_BUDGET`, `SCHEDULED_INCREMENTAL_BUDGET`). A day has at most 25 ticks (the
  fall-back day) and at most 5 of them in the 02:00-05:59 window (local hours 2, 2, 3, 4, 5), so
  the worst case per division is 5 x 240 + 20 x 40 = **2,000 calls a day** (asserted in
  `exact-scheduled.test.ts`). That leaves 3,000 of Exact's 5,000 for the 10 % user reserve (500),
  Phase 3+ jobs and manual slices. Volume test (`exact-sync-volume.test.ts`, 10,000 relations,
  4,000 relation bank accounts, 3,000 receivables, 2,000 payables, a fake gate that enforces the
  job budget): with list pages of 60 and sync pages of 1,000 the whole night is 162 calls in
  one tick (day total 266); with 60 everywhere it is 320 calls over two ticks (240 + 80; day total
  485, which includes the first incremental walk); with 1,000 everywhere it is 20 calls. By hand,
  at 60 per page: divisions 1 + receivables 50 + payables 34 + relations 167 + IBANs 67 = 319.
  Subrequests per invocation peak at about 450 of the assumed 1,000.
- **Fairness (B1f).** The scheduler takes divisions least recently completed first
  (`sync_state.run.last_completed_at`), so with the shared 12-minute deadline and subrequest meter
  a slow division cannot starve the ones behind it; the invocation that runs out of time or
  subrequests simply continues with the next division first on the next tick.
- **Errors.** Budget, rate limit and the deadline stop the run as `partial`. `ExactAuthError`
  stops it as `needs_reauth` (recorded in `sync_state`, no retry; the scheduler also skips the
  other divisions of that connection). **Transient failures (S3)** (HTTP 502/503/504, the gate's
  `network` and `gate_unavailable`, a rate limit, a gate that cannot start the job) also stop the
  run as `partial`: the next entities would fail the same way and the next run resumes. They are
  counted per Amsterdam day (`retry_count`, `retry_day` on the `run` row, never reset by a
  success); after `MAX_TRANSIENT_RETRIES` (3) the failure is recorded as `error`, and
  `scheduledMode` stops starting full syncs for that day (so retries are bounded, not
  infinite). Other `ExactApiError`s are permanent: recorded with a short code (`http_400`, ...)
  as `error`, and the next entities still run, so one bad endpoint does not hide the rest.
  Unknown exceptions stop the run as `error` / `internal_error`; only the error name is logged.
  `endJob` is always called in a `finally`.
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
7. **Bank accounts per relation** come from one full `crm/BankAccounts` read in scheduled FULL
   runs only (see above), `ceil(rows / page size)` calls once a night.
8. **Subrequest limit.** Each gate RPC and each D1 call in a Worker invocation counts toward the
   platform's per-invocation subrequest limit. We assume the conservative 1,000 (`SUBREQUEST_LIMIT`)
   until the account's actual limit is checked. Every run counts its gate calls and D1 calls on a
   meter shared by the whole invocation (the scheduler syncs all divisions in one) and stops as
   `partial` / `subrequest_limit` while 25 remain for the final batch, `endJob` and the release.
   The scheduler leaves the remaining divisions for the next tick.
9. **A complete but empty list.** The client rejects wrong envelopes (`BAD_SHAPE`), so an empty
   list is taken as true, but see the close guard below.
10. **`$skiptoken` is stateless and the list order is stable between runs.** Resuming a bulk read
    in a later run (minutes or hours later) assumes the token from `__next` keeps working and
    that rows do not move to earlier pages when others are added or paid. If Exact rejects an old
    token (HTTP 400) the pass restarts from the top; if the order is not stable an item can be
    missed and wrongly look paid, which the close guard (S5) catches when many are affected but
    not a single one: verify on a test division by reading a list across two runs. A stable sort
    (`$orderby=ID`) would be the fix.
11. **Page sizes.** 60 on list endpoints and 1,000 on sync endpoints are assumptions (tested at
    both and at 60 everywhere); real sizes change only the call counts above.

## Closing guards (review E3)

- Only a FULL read of that kind that completed and was written closes, only rows of that division
  and kind, and never after a partial, failed, rate-limited, budget-, time- or subrequest-stopped,
  or auth-failed read. Incremental runs never close by absence.
- **Close guard (S5; was the empty-list guard).** Before a complete FULL read closes anything,
  the run counts the open items of that kind it would close (`stale`) and all open ones (`open`).
  If `stale > max(5, 20 % of open)` nothing is closed and the entity ends `error` /
  `close_guard` (shown in the Data sync card); the cycle stays open for that entity. A wrong
  division, licence, filter or unstable paging is far more likely than a fifth of all invoices
  being paid in a day. An admin can confirm with `POST /api/divisions/:id/sync
  {"mode":"full","allowLargeClose":true}` (renamed from `allowEmptyClose`; audited in the
  `exact.sync` row; the cycle re-reads the list and closes with the override). An empty list
  with more than 5 open items is the extreme case of the same rule; at most 5 close normally.
  The UI for the override belongs to the Data health screen (Phase 8). Boundaries are tested
  (20 of 100 closes, 21 do not; 5 of 10 close, 6 do not; a read that took several runs is
  guarded too).
- **Lease guard.** The close statement only runs while `sync_locks` still has this run's holder
  and `run_seq`; open-item upserts only apply when the run is not older than the run that last saw
  the row. A run that outlives its lease can therefore neither close nor overwrite what a newer run
  wrote. Lease 15 minutes; manual runs stop after 20 s and scheduled ones after 12 minutes, checked
  before every Exact call (not only between chunks), so a long bulk read cannot overrun.
- **Scheduler.** Inside the 02:00-05:59 window only a `partial` (or interrupted `running`) full
  sync is retried; a full sync that ended `error` or `needs_reauth`, or after more than
  `MAX_TRANSIENT_RETRIES` transient failures that day, is not repeated, so a broken endpoint
  cannot spend the daily budget (worst case 2,000 calls per division, see Budgets).

## Consequences

- Later screens read `open_items` (`status = 'open'`) and `relations`; the four-eyes check reads
  `relations.iban_changed_at` and the `relation.iban_changed` audit rows.
- `sync_state.entity = 'run'` is the single place for "last sync" timestamps; the UI "Updated x ago"
  stamps use `last_completed_at` (last run that ended `ok`); `last_finished_at` is the last attempt.
- Phase 3 should call `syncDivision` from a queue consumer and drop `scheduled.ts`.
