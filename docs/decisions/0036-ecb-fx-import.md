# 0036 ECB FX import, storage, rates API and staleness
Status: accepted (Phase 6).
## Source and request
- ECB Data Portal, dataset EXR, daily, units of currency per 1 EUR, CSV. The URL comes only from
  core `ecbRequestUrl` and is checked again in the worker (https, host `data-api.ecb.europa.eu`,
  path `/service/data/EXR/`, no port, user info or fragment, query keys only `format=csvdata`,
  `startPeriod`, `endPeriod`, `lastNObservations`, each once). Plain GET, `Accept: text/csv`, no
  credentials, redirects refused, 15 s timeout covering headers AND body (every body read races
  the abort), 5 MiB cap counted on decoded bytes while streaming (the runtime undoes gzip),
  content type `text/csv` or `application/vnd.sdmx.data+csv` with any parameters (assumption:
  the portal answers `format=csvdata` with `text/csv`; verify on the first live run). Bodies and
  URLs are never logged. No Worker config is needed for an outbound host.
- Network, timeout, 429, 5xx: transient (partial, retry). A `Retry-After` (seconds or HTTP date,
  capped at 1 hour) lengthens the retry delay; if it no longer fits before 17:30 the run ends
  `error`. Redirect, wrong type, oversize, unparseable: `error`, no retry loop. 404 and 204: no
  data. Parser outcomes (core `parseEcbCsv`): `no_observations` on a header-only CSV is "nothing in
  the window"; `no_observations` with data rows (all refused), `malformed_csv`,
  `ambiguous_columns`, `missing_columns`, `too_large` are `error` / `bad_response` with
  `parseError` in the summary.
## Storage
- `fx_rates` (0003) is unchanged. Migration 0018 adds `fx_import_state` (one row) and an index on
  `rate_date`. Rates are normalised by core `parseRate` before comparison and storage ("1.10",
  "1.1" and "1.1000" are one value; stored as "1.1"). Published rates are final: `INSERT ... ON
  CONFLICT DO NOTHING`, oldest first, at most 100 rows per (atomic) INSERT, so a failure part-way
  leaves a complete prefix and the next run's window (which starts before the newest stored date)
  completes it. A different later value is not stored: `conflicts` counts it and one
  `fx.rate_conflict` audit row is written per (currency, date, stored value, ECB value), ever;
  already-audited ones are filtered before the per-run cap of 25, so a long list is worked through.
- `fx_import_state` is written on every handler outcome, on a crash (`handler_error` / `aborted`,
  then the error is rethrown to the runner) and, through the runner's `onTooLate` hook, when an
  attempt arrives after 17:30 (`too_late`).
- Window: first import 400 days, then from 10 days back or 3 days before the newest stored date,
  whichever is older, so an outage heals itself.
## Job `ecb.fx_import`
- Working days 16:15 Amsterdam, lateness 75 minutes (17:30), 8 attempts, 10-minute retries. Slot
  day stored: `ok`. Not published: `partial` / `not_yet_published` + retry. Whether a retry fits is
  decided from the SLOT + 75 minutes and the clock at the moment of deciding (not the attempt
  number): the next attempt must be due by 17:27, leaving a 3-minute margin for queue delivery
  delay (observed 0 to 2 minutes) and this attempt's wind-down. Otherwise the run ends `error` /
  `rate_not_published` (Phase 8 alerts). If a delivery is later than the margin anyway, the
  runner records `error` / `too_late` for this job (`tooLateIsFailure`; other jobs keep
  `skipped` / `too_late`), never a quiet skip. Weekend or TARGET holiday (Good Friday, Easter
  Monday, 1 May, 25/26 December, 1 January): `skipped` / `non_working_day`. Manual runs refresh
  and backfill on any day. A publication after 17:30 is stored by the next working day's run
  (its window reaches 10 days back).
- Decision: ENABLED by default on new installs (public, read-only, no credentials, no Exact
  budget). The defaults version is not bumped, so existing rows keep their setting.
## Staleness (alert if older than one working day)
Expected newest date: today on a TARGET working day after 17:30, else the previous working day.
Stale means older than that. Monday 09:00 with Friday's rate is fine; Tuesday 18:00 with Monday's
is stale. All in Amsterdam local time (00:30 Amsterdam is already the next day). `workingDaysOld`
= core `targetWorkingDaysBetween(newest, today]`, so Friday's rate on Monday is 1 whether or not
it is stale yet. An empty table is `never_imported`. Staleness reads the rates table only (the
newest stored rate up to today), never the job's state, so a disabled or failing job shows.
## API
`GET /api/fx/rates?date=` and `GET /api/fx/history?currency=&days=` (1 to 400): any signed-in role,
no-store, types in core `api-types`, with the "for information only" notice. Rates are returned
in canonical form. `/rates` selects exactly as core `buildRateTable` (newest per currency on or
before `date`; a currency more than 10 TARGET days older than `asOf`, such as HRK, is left out)
and reads only that window (index seek on `rate_date`); its staleness describes the feed, not
the `date` asked for. History uses the primary key (currency, rate_date).
## Still open
Decision 4 (the accountant confirms ECB rates for revaluation) is not decided; nothing is booked
from these rates before Phase 12.
