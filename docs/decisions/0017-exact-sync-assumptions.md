# 0017 Exact sync: design and unverified assumptions

Status: provisional — verify with credentials (the design is accepted; every figure and field name
below is an unverified assumption). Built (task E3, reworked in G1 and G3 after the Phase 2
review) with no Exact credentials; everything was tested
against a scripted transport and a stubbed `fetch`. It builds on ADR 0014 (API shapes), 0015 (gate)
and 0016 (OAuth). Items under "Verify" must be checked on the first real connection; a wrong guess
is local to `apps/worker/src/exact/sync.ts` or to the client field lists.

## Design

- **Entities, in order:** divisions, receivables, payables, relations (`/sync/CRM/Accounts`),
  relation_ibans (the bank accounts of customers and suppliers from `/crm/BankAccounts`; renamed
  from `bank_accounts` in G3, ADR 0019). Open items are what users look at, so they
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
  `PayablesList` in chunks of `chunkPages` (5) pages. Each chunk's rows are written together
  with the `$skiptoken` to continue from and the pass progress (`pass_token`, `pass_rows`,
  `pass_total`). A chunk can be more than one D1 batch (100 statements each: 5 pages of 60 rows
  are 4 batches); the progress statement is always the LAST statement of the last batch, so the
  saved token never runs ahead of the rows: if a batch fails, the next run re-reads (upserts are
  idempotent) instead of skipping. If a page after the first fails, the client hands back the
  pages it did read (`ListChunk.error`) and the sync writes them before rethrowing, so a stop
  anywhere loses nothing. Pass and cursor progress is only saved while the run still holds its
  lease (the upsert's `DO UPDATE ... WHERE` checks `sync_locks`), and so are `done_cycle`, the
  cycle columns on the `run` row and the token reset after an error: a run that outlived its
  lease cannot move another run's pass, finish its cycle or leave a half-open one behind (tested).
  The read is COMPLETE only when Exact returns a last page. Then, in the final batch, the open
  items of that kind last seen BEFORE the cycle began (`last_seen_sync_id < cycle_seq`) get a
  strike and close under the **two-strike rule** below (only while this run holds the lease).
  Items the cycle's reads, or an hourly incremental run in between, have seen carry a newer
  `run_seq` and stay open. A partial, failed, rate-limited, time-boxed or subrequest-stopped run
  never strikes or closes anything. A permanent API error while resuming drops the saved token so
  it is not retried until the cycle expires.
- **Two-strike rule (review G1).** A pass that resumes from a `$skiptoken` saved minutes or hours
  earlier relies on Exact keeping the list order between runs (Verify item 10). If the token is
  an offset and an earlier row is paid in between, every later row moves up one place and the
  row at the page boundary is never served: without a guard that still-open item would be
  closed, and the 20 % close guard only catches mass errors. So `open_items.missed_cycles`
  (migration 0006) counts the complete reads in a row that did not see an open item; any read
  that sees it (full or incremental) resets it to 0. An item is closed when it has been missed
  by **two complete reads in a row**, or by **one complete read done in a single run** (the
  whole list from its first to its last page in one run, no token carried over: the pre-G1
  behaviour; the nightly full read of a normal division is one), or by one confirmed with
  `allowLargeClose` (the admin accepts the closes). The chance that the same item sits at a
  shifting page boundary in two consecutive passes is negligible; a genuinely paid item closes
  one cycle later at most (the hourly incremental read usually closes it first, from its zero
  open amount). An item paid AFTER a pass read it counts as seen in that cycle and is struck
  by the next one, so it is never left open for good. The close guard counts the strikes
  (`stale`), so a mass problem is refused on its first pass, before anything is struck; a
  refused read adds no strike. The `exact.sync` audit row records per kind `missed` (struck) and
  `closed`, counted under the lease just before the final batch. Rejected alternatives:
  `$orderby=ID` on the list reads (not verified that `read/financial/*List` accepts it; a 400
  would break every full read; keep as the fix once Verify item 10 is checked) and re-reading
  candidates by ID (an unverified filter, and up to one call per candidate).
- **INCREMENTAL** continues every cursor-based entity from its saved Timestamp and never closes by
  absence. **Since G3 it reads open items only when the admin setting
  `exact.incremental_open_items` is on (default off, ADR 0019, verify 13)**; with it off the hourly
  tick refreshes divisions and relations (about 2 calls) and the nightly full pass refreshes open
  items. Relations continue from their saved cursor in every mode (nightly too); deletions in
  Exact are not detected for them. A row whose open amount is zero updates a row we know to closed; a closed row we have
  never seen is NOT inserted (G1: the first pass from cursor 0 would import the whole paid
  history as closed rows). Incremental runs never read IBANs. Note the cost: after the first
  full sync the open-item incremental cursors still start at 0 and walk the sync endpoint once,
  history included, inside the hourly budget (`ceil(rows / page size)` calls over as many hourly
  ticks as it takes; the volume test shows 9 calls at 1,000 per page for the reference
  division). The cursors cannot be seeded from the completed full cycle: the bulk list rows
  carry no `Timestamp` (`OPEN_ITEM_LIST_FIELDS`; `mapOpenItem(..., sync = false)` leaves
  `timestamp` null). Seeding with the latest Timestamp of the sync endpoint itself
  (`$orderby=Timestamp desc&$top=1`, one call, taken BEFORE a full pass so nothing changed during
  the pass is skipped) would remove the walk, but needs that query verified on real Exact; it is
  a one-time cost per division, so it waits for the first live connection.
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
  partial run of the same mode (not after a rate limit, and not with `restart`, which is a new
  run). The route checks the cooldown for a fast answer, and `syncDivision` checks it again
  UNDER the lease (`admit`), before writing anything: runs of a division are serialised by the
  lease, so two requests that both pass the route's check cannot both start a new run (the second
  gets 409 while the first runs, or 429 once it has finished). `GET /api/divisions` returns the
  remaining cooldown per mode. There is no separate daily cap on manual slices: each is at most
  60 calls, the gate's 60/minute limit bounds them in time, and the gate never lets `job`
  calls into the last 10 % of the day (the user reserve). A user who keeps clicking can use
  daytime budget that later Phase 3 jobs would want; revisit with the jobs table (Phase 3). A manual full run covers everything but IBANs and does not count
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
  run as `partial`: the next entities would fail the same way and the next run resumes. The
  gate's retryable token errors (`token_refresh_retry`, a refused or failed refresh, HTTP 503)
  are transient too, never `needs_reauth`. FULL runs count them per Amsterdam day (`retry_count`,
  `retry_day` on the `run` row, never reset by a success); after `MAX_TRANSIENT_RETRIES` (3) the
  failure is recorded as `error`. A full run that ends `error` for any reason (permanent API
  error, close guard, internal error, too many transient failures) sets the counter past the
  bound, so `scheduledMode` starts no other full sync that Amsterdam day, even after
  incremental ticks in between (before G1 review the check only looked at the last run, so an
  incremental tick re-enabled the failing full sync every other hour). Incremental runs do not
  touch the counter; they run hourly anyway. Other `ExactApiError`s are permanent: recorded
  with a short code (`http_400`, ...) as `error`, and the next entities still run, so one bad
  endpoint does not hide the rest.
  While the gate has marked the connection `token_endpoint_rejected_credentials`
  (`connections.last_error`, ADR 0016; the fix is the client secret, not a re-authorisation) the
  scheduler skips the sync instead of failing every hour, except one incremental run of one
  division at 03:00 Amsterdam (`CREDENTIALS_PROBE_HOUR`) that lets a fixed secret clear the flag.
  A manual sync is still allowed and works as the same probe.
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
  `relation.iban_changed` / `relation.iban_added` row, in one batch with the update, guarded by the
  old value and the sync lease, with the IBAN masked (`NL91****4300`, the one `maskIban` in
  `@camelthorn/core`). Actor is `system` for the scheduler and the user's email for manual runs.
- **IBAN rules (G3, ADR 0019).** All bank accounts of a relation are kept in
  `relation_bank_accounts`; `relations.iban` is the main account, else the lowest active IBAN. A new
  IBAN in the active set sets `iban_added_at`; a changed main account (or a first IBAN) sets
  `iban_changed_at`; neither fires on the very first pass, on a reordered answer or on case and
  spacing. A relation that loses all bank accounts keeps its last IBAN in `relations.iban`.
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
   All returned divisions are upserted (name, currency) but, since G3, only those with
   `sync_enabled = 1` are synced, so a long list costs no budget. The sync has no `currentMe`
   fallback; the connect callback learns the current division through the division-0 gate.
5. **Dates.** Stored as Amsterdam calendar dates (`YYYY-MM-DD`), assuming a Dutch division. A
   division in another timezone would need its own zone.
6. **Account `IsSales`** is read as "customer". Exact has account statuses (customer, supplier,
   prospect) that may be more accurate.
7. **Bank accounts per relation** come from one full `crm/BankAccounts` read in scheduled FULL
   runs only (see above), `ceil(rows / page size)` calls once a night. Field names: ADR 0014 item 7.
8. **Subrequest limit.** Each gate RPC and each D1 call in a Worker invocation counts toward the
   platform's per-invocation subrequest limit. We assume the conservative 1,000 (`SUBREQUEST_LIMIT`)
   until the account's actual limit is checked, and that one `db.batch` of up to 100 statements
   counts as ONE call (it is one round trip to D1; the meter counts it once). If a batch counts per
   statement, the limit would be reached about 100 times sooner: see verify 15. Every run counts its gate calls and D1 calls on a
   meter shared by the whole invocation (the scheduler syncs all divisions in one) and stops as
   `partial` / `subrequest_limit` while 25 remain for the final batch, `endJob` and the release.
   The scheduler leaves the remaining divisions for the next tick.
9. **A complete but empty list.** The client rejects wrong envelopes (`BAD_SHAPE`), so an empty
   list is taken as true, but see the close guard below.
10. **`$skiptoken` is stateless and the list order is stable between runs.** Resuming a bulk read
    in a later run (minutes or hours later) assumes the token from `__next` keeps working and
    that rows do not move to earlier pages when others are added or paid. If Exact rejects an old
    token (HTTP 400) the pass restarts from the top. If the order is not stable, an item can be
    skipped once; the two-strike rule keeps it open (it is only closed when two complete reads
    in a row miss it, or a single-run read does), and the close guard (S5) catches mass errors.
    Verify on a test division by reading a list across two runs with a payment in between, and
    check whether `$orderby=ID` is accepted on `read/financial/ReceivablesList`; if it is, add it
    to the list reads (`listChunk` in `packages/exact/src/client.ts`).
11. **Page sizes.** 60 on list endpoints and 1,000 on sync endpoints are assumptions (tested at
    both and at 60 everywhere); real sizes change only the call counts above. The IBAN read is
    sized at about 50 rows per page (`IBAN_PAGE_GUESS`).
12. **Minute-window semantics, and whether 429 answers count.** We enforce the stricter reading
    (never more than 60 calls in any 60 s, ADR 0016 item 18) and count every request we send,
    including those Exact answers with 429, against our own window. If Exact uses a clock minute
    and does not count rejected calls we are merely conservative; if it counts them, a 429 burst
    must not be retried at once (the gate blocks until `Retry-After` / the reset). Check with a
    full minute under load; the daily window's reset time (midnight UTC assumed) too.
13. **Same `ID` across the list and the sync endpoints (UNVERIFIED, blocks incremental open
    items).** Open items are upserted on `(division_id, exact_id)` from both sources. If an
    invoice has a different identifier in `ReceivablesList` and in `/sync/Cashflow/Receivables`
    (the list key may be `HID`, ADR 0014 item 3), every changed invoice becomes a second row, the
    original is never seen by the incremental read and the nightly full read closes the wrong one.
    Therefore incremental open-item reads are OFF by default (`exact.incremental_open_items`,
    ADR 0019) and `open_items.source` records `list` or `sync`. To switch it on: read one
    invoice from both endpoints on a test division, compare the identifiers, and only then turn
    the setting on in Settings, Connections. The payables sync resource may be `Payments` or
    `PaymentTerms` instead of `Payables` (ADR 0014 item 4).
14. **`sync/Deleted` is not used.** Rows deleted in Exact (a deleted invoice, a deleted account)
    are not reported by the Timestamp reads. Open items are closed by absence from a complete full
    read under the two-strike rule, so a deleted invoice is noticed after the next nightly pass at
    the earliest (two passes if the read spans runs); a deleted relation is never removed from
    `relations` (ADR 0019). If Exact offers `sync/Deleted`, it would give faster and exact
    answers: a later task.
15. **D1 batch versus subrequest counting.** See item 8. Check the subrequest count of a real
    nightly invocation in the Worker logs; if batches count per statement, lower the batch size
    or the budgets.

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
  `relations.iban_changed_at`, `relations.iban_added_at` and the `relation.iban_changed` /
  `relation.iban_added` audit rows (ADR 0019).
- `sync_state.entity = 'run'` is the single place for "last sync" timestamps; the UI "Updated x ago"
  stamps use `last_completed_at` (last run that ended `ok`); `last_finished_at` is the last attempt.
- Phase 3 should call `syncDivision` from a queue consumer and drop `scheduled.ts`.
