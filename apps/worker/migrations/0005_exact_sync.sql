-- 0005 Exact sync: relations, sync state, a per-division sync lease, user division preference,
-- and the extra open_items columns the sync needs.
--
-- open_items is NOT rebuilt. SQLite cannot change a CHECK in place, but reminders and
-- match_suggestions reference open_items with ON DELETE CASCADE, and DROP TABLE runs an implicit
-- DELETE that fires those cascades, so the copy-aside pattern of 0004 would silently delete
-- reminders and match suggestions. Instead the existing vocabulary is kept and enforced:
--   open_items.kind   'invoice' = open receivable (sales invoice), 'bill' = open payable
--                     (existing CHECK in 0003)
--   open_items.status 'open' | 'closed', enforced by the triggers below.
-- Money stays integer minor units (amount_minor, open_minor) with the item's own currency.

ALTER TABLE open_items ADD COLUMN entry_number INTEGER;
ALTER TABLE open_items ADD COLUMN closed_at TEXT;
-- Sequence number of the sync run that last saw this item (sync_locks.run_seq of its division).
ALTER TABLE open_items ADD COLUMN last_seen_sync_id INTEGER;
CREATE INDEX idx_open_items_status ON open_items (division_id, kind, status);

CREATE TRIGGER open_items_status_insert BEFORE INSERT ON open_items
WHEN NEW.status NOT IN ('open', 'closed')
BEGIN
  SELECT RAISE(ABORT, 'open_items.status must be open or closed');
END;

CREATE TRIGGER open_items_status_update BEFORE UPDATE OF status ON open_items
WHEN NEW.status NOT IN ('open', 'closed')
BEGIN
  SELECT RAISE(ABORT, 'open_items.status must be open or closed');
END;

-- Exact accounts (customers and suppliers) per division. iban is the full IBAN (needed for
-- matching and paying): never log it, audit rows store it masked.
CREATE TABLE relations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id     INTEGER NOT NULL REFERENCES divisions (id),
  exact_id        TEXT NOT NULL,
  code            TEXT,
  name            TEXT NOT NULL,
  is_supplier     INTEGER NOT NULL DEFAULT 0 CHECK (is_supplier IN (0, 1)),
  is_customer     INTEGER NOT NULL DEFAULT 0 CHECK (is_customer IN (0, 1)),
  email           TEXT,
  vat_number      TEXT,
  country         TEXT,
  iban            TEXT,
  -- Set when a known IBAN changed (or a first IBAN appeared on a relation we already knew).
  -- The four-eyes check on payments reads this.
  iban_changed_at TEXT,
  updated_at      TEXT NOT NULL,
  UNIQUE (division_id, exact_id)
);
CREATE INDEX idx_relations_iban ON relations (division_id, iban);

-- One row per division and entity (divisions, relations, bank_accounts, receivables, payables)
-- plus entity 'run' for the whole run. cursor is the Exact Timestamp to resume a sync read from
-- (unsigned 64-bit as a digit string, never a number). mode is the mode of the last run of this
-- entity: a full run may resume a partial FULL pass but never a partial incremental one.
CREATE TABLE sync_state (
  division_id       INTEGER NOT NULL REFERENCES divisions (id),
  entity            TEXT NOT NULL
                    CHECK (entity IN ('run', 'divisions', 'relations', 'bank_accounts', 'receivables', 'payables')),
  cursor            TEXT NOT NULL DEFAULT '0' CHECK (cursor NOT GLOB '*[^0-9]*' AND length(cursor) BETWEEN 1 AND 20),
  mode              TEXT CHECK (mode IS NULL OR mode IN ('full', 'incremental')),
  last_started_at   TEXT,
  last_finished_at  TEXT,
  -- Last time this entity (or the whole run) ended 'ok'.
  last_completed_at TEXT,
  -- Last time a FULL run ended 'ok' (the stopgap scheduler runs one full sync per Amsterdam day).
  last_full_completed_at TEXT,
  last_status       TEXT CHECK (last_status IS NULL OR last_status IN ('running', 'ok', 'partial', 'error', 'needs_reauth')),
  -- Short machine code, never a provider message.
  last_error        TEXT,
  rows_seen         INTEGER NOT NULL DEFAULT 0,
  calls_used        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (division_id, entity)
);

-- Lease so two syncs of one division never overlap. A crashed run frees itself when the lease
-- expires. run_seq grows on every acquisition and is the "sync id" stored in
-- open_items.last_seen_sync_id.
CREATE TABLE sync_locks (
  division_id INTEGER PRIMARY KEY REFERENCES divisions (id),
  holder      TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  run_seq     INTEGER NOT NULL DEFAULT 0
);

-- The administration the user last chose in the switcher.
CREATE TABLE user_prefs (
  user_id     INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  division_id INTEGER REFERENCES divisions (id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL
);
