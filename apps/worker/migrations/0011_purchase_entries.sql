-- 0011 Purchase entries and their approval status (Phase 4, task K4, ADR 0025).
--
-- A cache of Exact purchase entries (purchaseentry/PurchaseEntries) for the Approvals screen and
-- for Phase 9's pre-check "invoice approved in Exact". Not the ledger: Exact stays the system of
-- record. Filled by the sync entity `purchase_entries` (apps/worker/src/exact/purchase-sync.ts),
-- only entries of the last 120 days or still waiting for approval.
--
--   status_code   Exact's raw Status (kept so a corrected mapping can be applied without a re-read
--                 of the stored rows: `status` is derived from it by the one table in
--                 packages/core/src/approvals.ts, which is UNVERIFIED, ADR 0025).
--   status        ApprovalStatus. 'unknown' for any code the table does not list and by default;
--                 never silently 'approved' (CHECK: 'approved' needs a raw code).
--   amount_minor  entry total in `currency` (AmountFC); amount_dc_minor / dc_currency the division
--                 currency amount as for open_items (NULL when Exact did not send it).
--   has_pdf       1 / 0 when the read told us, NULL when it could not.
--   submitted_at  Exact's Created (UTC instant); modified_at Exact's Modified, the sync cursor.
--   search_text   folded entry number, supplier name (searchText in packages/core/src/search.ts).
--   last_seen_sync_id / missed_cycles  as for open_items (two-strike removal, ADR 0017). A row is
--                 deleted only after COMPLETE full reads that did not see it; it is a cache.
--
-- Additive only: nothing existing is rebuilt, so it is safe on a populated database
-- (test/migration-0011.test.ts).

CREATE TABLE purchase_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id       INTEGER NOT NULL REFERENCES divisions (id),
  exact_id          TEXT NOT NULL,
  entry_number      TEXT,
  relation_id       TEXT,
  relation_name     TEXT,
  currency          TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  amount_minor      INTEGER NOT NULL,
  amount_dc_minor   INTEGER,
  dc_currency       TEXT CHECK (dc_currency IS NULL OR (length(dc_currency) = 3 AND dc_currency = upper(dc_currency))),
  entry_date        TEXT,
  due_date          TEXT,
  status_code       INTEGER,
  status            TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (status IN ('pending_approval', 'approved', 'rejected', 'unknown')),
  submitted_at      TEXT,
  modified_at       TEXT,
  has_pdf           INTEGER CHECK (has_pdf IS NULL OR has_pdf IN (0, 1)),
  search_text       TEXT,
  synced_at         TEXT NOT NULL,
  last_seen_sync_id INTEGER,
  missed_cycles     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (division_id, exact_id),
  -- 'approved' (the one status that can allow a payment) only ever comes from a raw code that the
  -- mapping table lists; never from a default or a row without a code.
  CHECK (status <> 'approved' OR status_code IS NOT NULL)
);

-- The list is ordered newest first by (entry date, id) with unknown dates last; the status filter
-- is the common case. The expression must be repeated exactly by the query
-- (apps/worker/src/read/approvals-routes.ts, ENTRY_KEY); a test asserts the plan uses the index.
CREATE INDEX idx_purchase_entries_list ON purchase_entries
  (division_id, status, COALESCE(entry_date, '0000-01-01'), id);
CREATE INDEX idx_purchase_entries_list_all ON purchase_entries
  (division_id, COALESCE(entry_date, '0000-01-01'), id);
CREATE INDEX idx_purchase_entries_relation ON purchase_entries (division_id, relation_id);
