-- 0007 Phase 2 review fixes S4, S7, S8, S9 (docs/reviews/phase-2-review.md, ADR 0017, ADR 0019).
--
-- S9  The sync entity for relation IBANs is renamed 'bank_accounts' -> 'relation_ibans' (the name
--     clashed with the bank_accounts TABLE of our own bank accounts), and the CHECK on
--     sync_state.entity is dropped: the allowed entities live in code (SYNC_ENTITIES in
--     apps/worker/src/exact/sync.ts), so a new entity never needs a table rebuild again.
--     SQLite cannot drop a CHECK in place, so sync_state is rebuilt. Nothing references
--     sync_state (it only references divisions as a child), so the plain copy -> drop -> rename
--     pattern is safe with foreign keys on; no PRAGMA is needed. Existing rows are copied with the
--     entity renamed (test/migration-0007.test.ts runs this on a populated database).
-- S8  relation_bank_accounts: every bank account of a relation (not just one IBAN).
-- S7  divisions.sync_enabled, divisions.base_currency_read_at, connections.exact_identity.
-- S4  open_items.source.

CREATE TABLE sync_state_0007 (
  division_id       INTEGER NOT NULL REFERENCES divisions (id),
  -- 'run', 'divisions', 'relations', 'relation_ibans', 'receivables', 'payables' (checked in code).
  entity            TEXT NOT NULL,
  cursor            TEXT NOT NULL DEFAULT '0' CHECK (cursor NOT GLOB '*[^0-9]*' AND length(cursor) BETWEEN 1 AND 20),
  mode              TEXT CHECK (mode IS NULL OR mode IN ('full', 'incremental')),
  last_started_at   TEXT,
  last_finished_at  TEXT,
  last_completed_at TEXT,
  last_full_completed_at TEXT,
  last_status       TEXT CHECK (last_status IS NULL OR last_status IN ('running', 'ok', 'partial', 'error', 'needs_reauth')),
  last_error        TEXT,
  rows_seen         INTEGER NOT NULL DEFAULT 0,
  calls_used        INTEGER NOT NULL DEFAULT 0,
  cycle_seq         INTEGER,
  cycle_started_at  TEXT,
  pass_cycle        INTEGER,
  pass_token        TEXT,
  pass_rows         INTEGER NOT NULL DEFAULT 0,
  pass_total        INTEGER,
  done_cycle        INTEGER,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  retry_day         TEXT,
  UNIQUE (division_id, entity)
);

INSERT INTO sync_state_0007 (division_id, entity, cursor, mode, last_started_at, last_finished_at,
    last_completed_at, last_full_completed_at, last_status, last_error, rows_seen, calls_used,
    cycle_seq, cycle_started_at, pass_cycle, pass_token, pass_rows, pass_total, done_cycle,
    retry_count, retry_day)
  SELECT division_id,
         CASE entity WHEN 'bank_accounts' THEN 'relation_ibans' ELSE entity END,
         cursor, mode, last_started_at, last_finished_at, last_completed_at,
         last_full_completed_at, last_status, last_error, rows_seen, calls_used, cycle_seq,
         cycle_started_at, pass_cycle, pass_token, pass_rows, pass_total, done_cycle, retry_count,
         retry_day
  FROM sync_state;

DROP TABLE sync_state;
ALTER TABLE sync_state_0007 RENAME TO sync_state;

-- S8. One row per (relation, IBAN) ever seen on an Exact bank account of that relation.
--   iban          normalised: upper case, no spaces (packages/core normalizeIban)
--   is_main       Exact's "Main" flag at the last read
--   exact_id      the Exact bank account GUID (lower case)
--   first_seen_at when this IBAN first appeared on the relation (kept when it comes back)
--   last_seen_at  the last complete IBAN read that returned it
--   removed_at    set by a COMPLETE read that no longer returned it; cleared if it comes back
-- relations.iban stays the one IBAN to DISPLAY (main, else the lowest active one).
-- relations.iban_changed_at / iban_added_at are the two payment-safety flags (ADR 0019).
CREATE TABLE relation_bank_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id   INTEGER NOT NULL REFERENCES divisions (id),
  relation_id   INTEGER NOT NULL REFERENCES relations (id) ON DELETE CASCADE,
  iban          TEXT NOT NULL CHECK (iban = upper(iban) AND length(iban) BETWEEN 5 AND 34
                                     AND iban NOT GLOB '*[^A-Z0-9]*'),
  bic           TEXT,
  is_main       INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0, 1)),
  exact_id      TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  removed_at    TEXT,
  UNIQUE (relation_id, iban)
);
CREATE INDEX idx_relation_bank_accounts_iban ON relation_bank_accounts (division_id, iban)
  WHERE removed_at IS NULL;

-- A new IBAN appeared on a relation (never active before, or back after removal). Distinct from
-- iban_changed_at (the IBAN we would pay to changed because the main account changed).
ALTER TABLE relations ADD COLUMN iban_added_at TEXT;

-- S7. Which divisions are synced. Only the division /current/Me returned is enabled when it is
-- first connected; the others are listed but off until an admin turns them on. Existing rows: the
-- connect callback inserted the /Me division first, so the lowest id of each connection is it.
ALTER TABLE divisions ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK (sync_enabled IN (0, 1));
UPDATE divisions SET sync_enabled = 1 WHERE id IN (SELECT MIN(id) FROM divisions GROUP BY connection_id);
-- NULL until the currency was read from Exact (base_currency defaults to EUR, which is a guess).
ALTER TABLE divisions ADD COLUMN base_currency_read_at TEXT;

-- Stable identity of the Exact account the connection points at: a SHA-256 hex of the Exact
-- customer (subscription) id or name from /current/Me. NULL for connections made before this.
ALTER TABLE connections ADD COLUMN exact_identity TEXT;

-- S4. Where the row was last written from: 'list' (bulk ReceivablesList / PayablesList reads) or
-- 'sync' (the Timestamp sync endpoints). ADR 0017 verify item: both must use the same ID.
ALTER TABLE open_items ADD COLUMN source TEXT CHECK (source IS NULL OR source IN ('list', 'sync'));
