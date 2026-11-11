-- 0009 Read-only screens (Phase 4, ADR 0022): indexes for the open-item lists.
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
