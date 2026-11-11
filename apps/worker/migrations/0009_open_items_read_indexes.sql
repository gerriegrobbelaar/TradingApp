-- 0009 Read-only screens (Phase 4, ADR 0022): indexes and search text for the open-item lists.
--
-- Lists are ordered by (due date, id) with unknown due dates last, and paged with a keyset on that
-- pair. The ordering expression is COALESCE(due_date, '9999-12-31'); SQLite uses an expression
-- index only when the query repeats the expression exactly (see apps/worker/src/read/queries.ts,
-- DUE_KEY). Two indexes: with a status filter (the default, "open") and without ("all").
-- test/read-api.test.ts asserts with EXPLAIN QUERY PLAN that the list query uses them.
CREATE INDEX idx_open_items_list ON open_items
  (division_id, kind, status, COALESCE(due_date, '9999-12-31'), id);
CREATE INDEX idx_open_items_list_all ON open_items
  (division_id, kind, COALESCE(due_date, '9999-12-31'), id);
-- Relation drill-down and ageing grouping.
CREATE INDEX idx_open_items_relation ON open_items (division_id, relation_id);

-- Text search (invoice number, entry number, relation name, reference) folds case and diacritics,
-- which SQLite cannot do. The folded text is stored per row (`searchText` in
-- packages/core/src/search.ts), written by every sync upsert, and searched with LIKE in SQL, so a
-- search pages and totals like any other filter. Rows that predate this migration hold NULL; the
-- first search in a division fills them in code (apps/worker/src/read/routes.ts), found through the
-- partial index below.
ALTER TABLE open_items ADD COLUMN search_text TEXT;
CREATE INDEX idx_open_items_search_pending ON open_items (division_id) WHERE search_text IS NULL;
