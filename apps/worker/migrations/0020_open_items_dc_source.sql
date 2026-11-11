-- Where the booked division-currency amount of an open item came from (Phase 6 review B1,
-- ADR 0038). open_items.open_dc_minor can be read from Exact (the incremental sync endpoints,
-- 'sync'; the optional list fields, 'list') or computed by the worker from the open amount and the
-- booked rate ('computed', exact.rate_direction). The three are not equally trustworthy, so the
-- upsert keeps a better one for the same open balance (sync > list > computed), and a settings
-- change can clear exactly the values that depended on it: a new rate direction clears every
-- 'computed' amount, switching the list fields off clears every 'list' amount.
--
-- NULL when open_dc_minor is NULL. Before this migration only the sync read could set
-- open_dc_minor, so every stored amount is marked 'sync'.

ALTER TABLE open_items ADD COLUMN dc_source TEXT
  CHECK (dc_source IS NULL OR dc_source IN ('sync', 'list', 'computed'));
UPDATE open_items SET dc_source = 'sync' WHERE open_dc_minor IS NOT NULL;
