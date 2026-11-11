# 0035 ECB FX import, storage, rates API and staleness
Status: accepted (Phase 6).
## Source and request
- ECB Data Portal, dataset EXR, daily, units of currency per 1 EUR, CSV. The URL comes only from
  core `ecbRequestUrl` and is checked again in the worker (https, host `data-api.ecb.europa.eu`,
  path `/service/data/EXR/`, no port, user info or fragment). Plain GET, `Accept: text/csv`, no
  credentials, redirects refused, 15 s timeout, 5 MB cap counted while streaming, content type
  `text/csv`. Bodies are never logged. No Worker config is needed for an outbound host.
- Network, timeout, 429, 5xx: transient (partial, retry). Redirect, wrong type, oversize,
  unparseable: `error`, no retry loop. 404 and 204: no data.
## Storage
- `fx_rates` (0003) is unchanged. Migration 0018 adds `fx_import_state` (one row) and an index on
  `rate_date`. Published rates are final: `INSERT ... ON CONFLICT DO NOTHING`. A different later
  value is not stored: `conflicts` counts it and one `fx.rate_conflict` audit row is written per
  (currency, date, value).
- Window: first import 400 days, then from 10 days back or 3 days before the newest stored date,
  whichever is older, so an outage heals itself.
## Job `ecb.fx_import`
- Working days 16:15 Amsterdam, lateness 75 minutes (17:30), 8 attempts, 10-minute retries. Slot
  day stored: `ok`. Not published: `partial` / `not_yet_published` + retry; the last attempt that
  fits before 17:30 ends `error` / `rate_not_published` (Phase 8 alerts). Weekend or TARGET
  holiday: `skipped` / `non_working_day`. Manual runs refresh and backfill on any day.
- Decision: ENABLED by default on new installs (public, read-only, no credentials, no Exact
  budget). The defaults version is not bumped, so existing rows keep their setting.
## Staleness (alert if older than one working day)
Expected newest date: today on a TARGET working day after 17:30, else the previous working day.
Stale means older than that. Monday 09:00 with Friday's rate is fine; Tuesday 18:00 with Monday's
is stale. `workingDaysOld` counts TARGET days. An empty table is `never_imported`.
## API
`GET /api/fx/rates?date=` and `GET /api/fx/history?currency=&days=` (1 to 400): any signed-in role,
no-store, types in core `api-types`, with the "for information only" notice.
## Still open
Decision 4 (the accountant confirms ECB rates for revaluation) is not decided; nothing is booked
from these rates before Phase 12.
