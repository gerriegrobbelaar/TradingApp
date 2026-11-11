-- 0014 Revolut ingest and sync (Phase 5, task R3a, ADR 0032).
--
--  (a) revolut_sync_state: where the Revolut poll and the backfill are, per connection and entity.
--      Resumable: `cursor` is the JSON paging cursor of an unfinished walk (R1 TransactionCursor),
--      NULL when no walk is in progress. Only counts, timestamps and short codes; never a body.
--        entity 'accounts'      balances (last complete read = freshness of the Bank screen)
--        entity 'transactions'  the 10-minute poll; `watermark` = start of the last COMPLETE walk
--        entity 'backfill'      the daily 35-day walk and the one-off 90-day initial backfill
--  (b) bank_transactions.description: the leg description (a card merchant, a payment note). The
--      reference and the description are different fields at Revolut.
--  (c) an index for the Bank screen's keyset paging: newest first on (created_at, id).
--
-- Additive only (no rebuild), so a populated database migrates in place.

CREATE TABLE revolut_sync_state (
  connection_id     INTEGER NOT NULL REFERENCES connections (id),
  entity            TEXT NOT NULL CHECK (entity IN ('accounts', 'transactions', 'backfill')),
  -- JSON TransactionCursor of an unfinished walk, or NULL.
  cursor            TEXT,
  -- Start (UTC ISO) of the last complete poll walk; the next walk starts 2 hours before it.
  watermark         TEXT,
  -- Lower bound of the walk in progress (UTC ISO) and the number of days it was asked for.
  window_from       TEXT,
  window_days       INTEGER,
  -- When the walk in progress started (UTC ISO): becomes the watermark when the walk completes.
  walk_started_at   TEXT,
  -- A one-off backfill asked for (days), consumed when the walk starts.
  requested_days    INTEGER CHECK (requested_days IS NULL OR requested_days BETWEEN 1 AND 366),
  -- 1 while the walk in progress is the one-off initial backfill (its missing count is no signal).
  initial           INTEGER NOT NULL DEFAULT 0 CHECK (initial IN (0, 1)),
  last_started_at   TEXT,
  last_finished_at  TEXT,
  -- Last time this entity ended a COMPLETE read (the freshness the screens show).
  last_completed_at TEXT,
  last_status       TEXT CHECK (last_status IS NULL OR last_status IN ('running', 'ok', 'partial', 'error', 'skipped')),
  -- Short machine code, never a provider message.
  last_error        TEXT,
  rows_seen         INTEGER NOT NULL DEFAULT 0,
  -- Transactions found at Revolut that were not in D1 (a missed webhook / poll gap).
  rows_missing      INTEGER NOT NULL DEFAULT 0,
  -- The missing count of the last COMPLETE daily (non-initial) backfill: the data-quality signal.
  last_missing      INTEGER,
  calls_used        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, entity)
);

ALTER TABLE bank_transactions ADD COLUMN description TEXT;

CREATE INDEX idx_bank_tx_created ON bank_transactions (created_at, id);
