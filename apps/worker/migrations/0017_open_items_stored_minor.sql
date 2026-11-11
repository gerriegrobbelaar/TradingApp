-- 0017 open_items.amount_minor -> stored_minor (Phase 5 review S10, ADR 0022).
--
-- The column is "the amount as stored": original_minor when Exact told us the invoice total, else
-- the OPEN balance. The name amount_minor invited reading it as an invoice total and, in lists and
-- totals, it is wrong for part-paid items. stored_minor says what it is, and the guard tests
-- (apps/worker/test/amount-minor-guard.test.ts, apps/web/src/amount-minor-guard.test.ts) now scan
-- by name: stored_minor / storedMinor may only appear in the sync upsert, the detail route and the
-- item sheet.
--
-- RENAME COLUMN is an in-place metadata change (SQLite 3.25+, supported by D1): no table copy, so
-- no implicit DELETE, no foreign key cascade (reminders and match_suggestions reference open_items
-- with ON DELETE CASCADE, see 0005) and every row, index and trigger stays. SQLite rewrites the
-- column name inside indexes, triggers, views and CHECK constraints that mention it; none of the
-- open_items indexes (0003, 0005, 0009) or triggers (0005) mentions this column, which the
-- migration test checks on a populated database.
--
-- Only open_items changes. bank_transactions.amount_minor (the signed leg amount), matches,
-- payments, purchase_entries and the ledger tables keep their amount_minor columns.

ALTER TABLE open_items RENAME COLUMN amount_minor TO stored_minor;
