# 0025 Purchase-entry approval status: sync and read API (Phase 4, task K4)

Status: accepted for the code, **provisional for every Exact name, filter and status code below: verify with credentials.** Nothing here has run against a real Exact division; it is tested against a scripted transport. Code: `packages/exact/src/client.ts` (`listPurchaseEntriesChunk`, `purchaseEntryFilterExpr`), `packages/core/src/approvals.ts`, `apps/worker/src/exact/purchase-sync.ts`, `apps/worker/migrations/0011_purchase_entries.sql`, `apps/worker/src/read/approvals-routes.ts`. It follows 0017 (sync design), 0022 (read model) and 0024 (ledger sync, whose pass pattern it reuses).

## What it is for

The Approvals screen (`GET /api/approvals`) and Phase 9's pre-check "invoice approved in Exact" (CLAUDE.md 4.3), and the data quality rule "approvals > 3 days" (4.6). Exact stays the system of record: `purchase_entries` is a cache.

## The status mapping: VERIFY WITH CREDENTIALS (the whole table)

One table, `PURCHASE_ENTRY_STATUS_TABLE` in `packages/core/src/approvals.ts`. Nothing else looks at raw codes.

| Exact `Status` | ApprovalStatus | Basis |
|---|---|---|
| 5 | `pending_approval` | the reviewer's recollection, not verified |
| 50 | `approved` | recollection ("processed / final"), not verified |
| anything else, missing, not an integer | `unknown` | by rule |

No code maps to `rejected` yet: it is a status the API can carry, but no known code produces it, so a rejected entry shows as `unknown` until the table is filled in. That is deliberate. Safety rules, tested:

- an unlisted code is `unknown`, never `approved`;
- `isInvoiceApprovedForPayment(entry)` (core) is true **only** for `approved`; `unknown` is false;
- a wrong guess towards `pending_approval` or `rejected` can only stop a payment, never allow one. **The `approved` row (50) is the one that can allow a payment, so it must be checked first.** Phase 9 must not enable the Pay button until the mapping has been verified on a real division (read a few entries in each state from Exact's UI and compare `status_code`, which is stored raw for exactly this reason). Correcting the table is a one-line change; stored `status` is re-derived by the next read of each row (rows outside the 120-day window keep the old derivation until they are modified, so after a correction run a full sync with `restart`, or re-derive from `status_code` in a migration).

## Verify with credentials (everything else)

1. **Resource:** `purchaseentry/PurchaseEntries` (candidates were also `PurchaseEntries` in other services). A 400, 403 or 404 on the first page marks the entity unavailable for a day (`sync_state.unavailable_until`, `last_error = purchase_entries_unavailable_<status>`); the API answers `available: false`. Our own gate's 400 codes never mark it. `restart` on a manual full sync tries again at once.
2. **Fields** (`PURCHASE_ENTRY_FIELDS`): `EntryID, EntryNumber, Supplier, SupplierName, Currency, AmountFC, AmountDC, EntryDate, DueDate, Status, Created, Modified, Document`. A wrong `$select` name is a 400 and shows as unavailable. `DueDate` may not exist on the header (it may be `PaymentCondition` plus lines): then `due_date` is null. `Created` is taken as the submission time (`submittedAt`); if Exact has a better field (the date it entered the approval flow), use it.
3. **Filters:** `$filter` with `or` between `EntryDate ge datetime'...'`, `Modified ge datetime'...'` and `Status eq 5`, and `$orderby=Modified`. UNVERIFIED that `Modified` is filterable and sortable, that datetimes are read as UTC (we send second precision and keep a 10-minute margin on the cursor), and that `$skiptoken` stays valid between runs (same assumption as ADR 0017 item 10).
4. **`hasPdf`:** from the `Document` field (a GUID means a document is attached). When the row has no `Document` key at all the value is null ("could not tell"). The documents/attachments resource (`documents/DocumentAttachments`) is NOT read: one call per entry is too expensive, and a bulk read of attachments is unverified.
5. **Amounts:** `AmountFC` in `Currency` is the entry total (credit notes negative, assumed); `AmountDC` in the division currency, optional. A missing currency falls back to the division currency.
6. **Dates:** entry and due date are stored as Amsterdam calendar dates (ADR 0017 item 5).

## Scope: which entries are read

An entry is read when its `EntryDate` or `Modified` is within the last **120 days** (`PURCHASE_ENTRY_WINDOW_DAYS`) **or** its status code is one that maps to `pending_approval` (whatever its age). Everything older and not pending is not read and not refreshed, which bounds the volume; the Approvals screen is about recent and open work. An old entry whose status is an unknown code is not read until it is modified within the window. The window start is fixed by the pass start (`pass_started_at`), so a saved `$skiptoken` is always used with the filter that issued it.

## Sync

Entity `purchase_entries`, one `sync_state` row per division like the others, last in the FULL order (after the ledger) and, in the hourly INCREMENTAL order, right after `divisions` (before the relations, whose first walk can use the whole hourly budget). `readPurchaseEntries: false` switches it off.

- **FULL:** a resumable pass (the ledger pattern): each chunk of 5 pages writes its rows, the saved `$skiptoken`, the row count and the pass start in one D1 batch, guarded by the sync lease (a run that outlived its lease writes nothing). Resumed in later runs of the same cycle. Only a COMPLETE read removes anything: rows in the read's scope that the pass did not see (`last_seen_sync_id < pass seq`, scope = the same three conditions as the filter) get a strike and are deleted after **two** complete reads in a row, or one when the pass ran inside a single run (no token carried over) or an admin passed `allowLargeClose`. Close guard: more than max(5, 20 %) of the scope at once is refused (`close_guard`, nothing changes). A complete answer with no row at all while we hold rows changes nothing (`empty_answer_ignored`) and does not start the cursor. Rows outside the scope are never removed. Strike, delete and cursor start are one D1 batch under the lease.
- **INCREMENTAL (hourly):** `Modified ge <cursor>` ordered by Modified, cursor in `sync_state.cursor` (epoch milliseconds; that column only holds digits, migration 0005). `ge` so a tie at the cursor is read again; upserts are idempotent. The cursor starts when the first complete full read ends (pass start minus 10 minutes) and moves forward after the rows up to it are written, and only when the chunk was in ascending Modified order (otherwise it stays: fail-safe). Before that first complete read the hourly run does nothing for this entity (`skipped`/`no_cursor`) and the API says `available: false`. Never deletes, never inserts old history (a row is only upserted when Exact returned it).
- **Cap:** at most `INCREMENTAL_MAX_CHUNKS` (2) chunks = 10 calls per hourly run, so an import of hundreds of entries cannot take the hour's 40. A capped run ends `skipped`/`incremental_cap` for this entity: the cursor is saved, the next hour continues, the run stays `ok`, and `last_completed_at` is not touched, so the API does not claim the data is current while a backlog is worked off.
- **Errors** as for the other entities: budget, rate limit, deadline and subrequest stops are `partial`; an unexpected API error is `error` for the entity and the saved token is dropped.

## Call arithmetic

The job budgets are unchanged (240 per full attempt, 40 per hourly run), so the scheduled worst case per administration and day is still **4 x 240 + 25 x 40 = 1,960** of 5,000 (`test/purchase-budget.test.ts` recomputes it from the constants, and `jobs-exact.test.ts` still asserts 1,960). What changes is how a night's budget is shared: a window of 640 entries is `ceil(640 / 60) = 11` calls, which with the reference division's 153 + 65 calls (ADR 0024) is 229 of 240, still one attempt; a busy administration (6,000 entries in 120 days) is 100 calls and needs a second attempt, which the scheduler gives. The hourly read is usually one call (the changes of the last hour); worst case 10 (the cap), of the 40.

## Table and API

- `purchase_entries` (migration 0011): see the file for columns. `status_code` raw, `status` derived, `has_pdf` nullable, `search_text` (folded entry number and supplier name), `last_seen_sync_id` and `missed_cycles` as for open items. Additive migration, tested on a populated database.
- `GET /api/approvals?division=&status=&q=&limit=&cursor=` and `GET /api/approvals/:id`. Any signed-in role. `status` defaults to `pending_approval` (also `approved`, `rejected`, `all`; `unknown` cannot be asked for and shows under `all` and in `countsByStatus`). Order: pending oldest first, anything else newest first, ties by id, keyset cursor bound to its direction. `countsByStatus` follows `q` but not `status`. `ageDays` (pending only) = Amsterdam calendar days since `submittedAt`, else since the entry date. `freshness` has basis `purchase_entries` and the 36-hour stale rule of 0022. `available` is false until the entity has completed once. The `relation` is the supplier name as read with the entry, else the synced relation's name; its `id` links to `/api/relations/:id`. No IBAN, email or VAT number is stored in the table or returned (tested). Types: `ApprovalItemDto`, `ApprovalsResponse`, `ApprovalDetail` in `packages/core/src/api-types.ts` (the first two are the fixed interface agreed with K3a; `FreshnessEntity` gained `purchase_entries`).

## Not done / open

- The mapping above, and a way for an admin to see the raw codes found (the detail route returns `statusCode`; a count of codes per division would help the verification, not built).
- Deep link into Exact (the URL pattern is unverified, ADR 0022).
- Attachment presence beyond the `Document` field.
- Phase 9 must call `isInvoiceApprovedForPayment` on a fresh row and re-read the entry from Exact when preparing a payment (the cache can be an hour old).
