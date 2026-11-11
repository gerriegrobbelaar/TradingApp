-- 0022 Bank matching data model (Phase 7, task M7b, ADR 0042).
--
--  (a) bank_transactions: ignore bookkeeping (reason, who, when, short note) and match_checked_at
--      (round-robin when more than the per-run cap of rows is waiting). Additive.
--  (b) matches is REBUILT (copy-aside, like 0013): one match per bank line (partial UNIQUE), the
--      allocations move to the child table match_allocations (one row per open item, so one
--      payment can settle several invoices), `status` is GENERATED from undone_at (so the existing
--      `undone_at IS NULL` queries of the ingest stay the single source of truth), and the old
--      CHECK "open_item_id OR ledger_account" is gone. Nothing wrote to matches before this
--      migration (Phase 7 is the first writer); rows that exist anyway are converted: one
--      allocation per old row, a second LIVE row of one bank line is marked undone, a row whose
--      division cannot be resolved (neither the open item nor the bank account) is not carried
--      over. exact_state is a free lower-case word (M7c adds its own states, no rebuild).
--  (c) match_suggestions is REBUILT: suggestions are a recomputable cache, so rows from before
--      this migration are not carried over (the next matching run recomputes every row whose
--      input_hash differs). Stores codes and cleaned explanation strings only, never bank text.
--  (d) bank_account_exact_map, ledger_patterns: admin-managed configuration.
--  (e) Database-level guards (triggers), created AFTER the copy so the migration itself is not
--      subject to them. They RAISE `match_err:<code>`; the Worker maps the code:
--        matches insert     tx_not_matchable (not final+completed, state conflict, not
--                           unmatched/suggested, amount or currency differ), division_mismatch
--                           (account map), division_inactive (not synced / Exact connection
--                           disabled), bad_match_row (inserted undone, booked or flagged)
--        matches update     cannot_revive (an undone match never becomes live again), immutable
--                           (line, division, source, ledger account, amount, currency)
--        allocations insert match_not_live, alloc_on_ledger_match, item_not_matchable (closed, zero,
--                           other division or currency), direction_mismatch (money in pays
--                           invoices and supplier credit notes, money out bills and customer credit
--                           notes), alloc_exceeds_open (live allocations of the item would pass its
--                           open balance), alloc_exceeds_tx (allocations pass the bank amount)
--        allocations update immutable
--        bank_transactions  tx_frozen (amount, currency or account of a line with a live match),
--                           status_mismatch ('matched' if and only if a live match exists)
--        account map        has_live_matches (division change or removal under live matches)
--      Together with the partial UNIQUE index (one live match per bank line) two writers racing for
--      the same line or item cannot both win, whatever the application does. A later migration
--      that rebuilds bank_transactions, matches, match_allocations or bank_account_exact_map MUST
--      recreate these triggers.
--  (f) matches.review_reason: the matching run flags live, unbooked matches whose data changed
--      after matching (Exact closed or reduced the item, Revolut contradicted the line). The
--      triggers only guard writes; this is how a change made by the sync AFTER matching surfaces.

-- (a) -------------------------------------------------------------------------------------------
ALTER TABLE bank_transactions ADD COLUMN ignored_reason TEXT
  CHECK (ignored_reason IS NULL OR ignored_reason IN ('internal_transfer', 'not_ours', 'other'));
ALTER TABLE bank_transactions ADD COLUMN ignored_note TEXT
  CHECK (ignored_note IS NULL OR length(ignored_note) <= 200);
ALTER TABLE bank_transactions ADD COLUMN ignored_by TEXT;
ALTER TABLE bank_transactions ADD COLUMN ignored_at TEXT;
ALTER TABLE bank_transactions ADD COLUMN match_checked_at TEXT;
CREATE INDEX idx_bank_tx_match_queue ON bank_transactions (connection_id, match_status, created_at);

-- (d) first, because the guards and the conversion refer to the map ------------------------------
CREATE TABLE bank_account_exact_map (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id      INTEGER NOT NULL UNIQUE REFERENCES bank_accounts (id),
  division_id          INTEGER NOT NULL REFERENCES divisions (id),
  journal_code         TEXT NOT NULL CHECK (length(journal_code) BETWEEN 1 AND 10),
  bank_gl_account_code TEXT NOT NULL CHECK (length(bank_gl_account_code) BETWEEN 1 AND 20),
  created_by           TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by           TEXT NOT NULL,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_bank_account_map_division ON bank_account_exact_map (division_id);

CREATE TABLE ledger_patterns (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  ledger_account_code     TEXT NOT NULL CHECK (length(ledger_account_code) BETWEEN 1 AND 20),
  counterparty_name_regex TEXT CHECK (counterparty_name_regex IS NULL OR length(counterparty_name_regex) BETWEEN 1 AND 200),
  reference_regex         TEXT CHECK (reference_regex IS NULL OR length(reference_regex) BETWEEN 1 AND 200),
  type                    TEXT CHECK (type IS NULL OR length(type) BETWEEN 1 AND 40),
  direction               TEXT CHECK (direction IS NULL OR direction IN ('in', 'out')),
  max_amount_minor        INTEGER CHECK (max_amount_minor IS NULL OR max_amount_minor > 0),
  enabled                 INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by              TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by              TEXT NOT NULL,
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (counterparty_name_regex IS NOT NULL OR reference_regex IS NOT NULL OR type IS NOT NULL
         OR direction IS NOT NULL OR max_amount_minor IS NOT NULL)
);

-- (b) and (c) -----------------------------------------------------------------------------------
CREATE TABLE match_suggestions_0022_copy AS SELECT * FROM match_suggestions;
CREATE TABLE matches_0022_copy AS SELECT * FROM matches;
DROP TABLE match_suggestions;
DROP TABLE matches;

CREATE TABLE matches (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id),
  division_id         INTEGER NOT NULL REFERENCES divisions (id),
  -- auto: made by the matching job; manual: a person, invoice allocations; ledger: a person, ledger account.
  source              TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'ledger')),
  ledger_account_code TEXT CHECK (ledger_account_code IS NULL OR length(ledger_account_code) BETWEEN 1 AND 20),
  -- Absolute amount of the bank line.
  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
  currency            TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  score               INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  rule                INTEGER CHECK (rule IS NULL OR rule BETWEEN 1 AND 4),
  note                TEXT CHECK (note IS NULL OR length(note) <= 200),
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  undone_by           TEXT,
  undone_at           TEXT,
  undo_reason         TEXT CHECK (undo_reason IS NULL OR length(undo_reason) <= 200),
  exact_state         TEXT NOT NULL DEFAULT 'not_booked'
                      CHECK (length(exact_state) BETWEEN 1 AND 32 AND exact_state NOT GLOB '*[^a-z_]*'),
  exact_matchset_id   TEXT,
  -- Set by the matching run when a live, not yet booked match no longer agrees with the data it was
  -- built on (the item was paid or closed elsewhere, the line got a state conflict). Sticky: a person
  -- undoes the match (or M7c's booking refuses it). M7c MUST NOT book a match with a review_reason.
  review_reason       TEXT CHECK (review_reason IS NULL OR review_reason IN
                        ('over_allocated', 'item_closed', 'tx_state_conflict', 'tx_changed')),
  review_flagged_at   TEXT,
  status              TEXT GENERATED ALWAYS AS (CASE WHEN undone_at IS NULL THEN 'live' ELSE 'undone' END) VIRTUAL,
  CHECK (source <> 'ledger' OR ledger_account_code IS NOT NULL),
  CHECK (source <> 'manual' OR ledger_account_code IS NULL),
  CHECK ((undone_at IS NULL) = (undone_by IS NULL)),
  CHECK ((review_reason IS NULL) = (review_flagged_at IS NULL))
);

CREATE TABLE match_allocations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id              INTEGER NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  open_item_id          INTEGER NOT NULL REFERENCES open_items (id),
  -- Magnitude (credit notes have a negative open balance; the allocation is still positive).
  allocated_minor       INTEGER NOT NULL CHECK (allocated_minor > 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  -- Signed open balance left after this allocation (NULL for rows converted by migration 0022).
  remaining_minor_after INTEGER,
  UNIQUE (match_id, open_item_id)
);

INSERT INTO matches (id, bank_transaction_id, division_id, source, ledger_account_code, amount_minor,
                     currency, score, created_by, created_at, undone_by, undone_at, exact_matchset_id)
  SELECT c.id, c.bank_transaction_id, c.div,
         CASE WHEN c.open_item_id IS NULL THEN 'ledger' ELSE c.mode END,
         CASE WHEN c.open_item_id IS NULL THEN c.ledger_account END,
         ABS(c.amount_minor), c.currency, c.score, c.matched_by, c.matched_at,
         CASE WHEN c.dup = 1 THEN c.matched_by
              WHEN c.undone_at IS NOT NULL THEN COALESCE(c.undone_by, 'migration') END,
         CASE WHEN c.dup = 1 THEN c.matched_at ELSE c.undone_at END,
         c.exact_matchset_id
  FROM (
    SELECT o.*,
           COALESCE((SELECT oi.division_id FROM open_items oi WHERE oi.id = o.open_item_id),
                    (SELECT ba.division_id FROM bank_transactions t
                       JOIN bank_accounts ba ON ba.id = t.bank_account_id
                      WHERE t.id = o.bank_transaction_id)) AS div,
           CASE WHEN o.undone_at IS NULL AND o.id > (SELECT MIN(d.id) FROM matches_0022_copy d
                      WHERE d.bank_transaction_id = o.bank_transaction_id AND d.undone_at IS NULL)
                THEN 1 ELSE 0 END AS dup
    FROM matches_0022_copy o
  ) c
  WHERE c.amount_minor <> 0 AND c.div IS NOT NULL;

INSERT INTO match_allocations (match_id, open_item_id, allocated_minor, currency)
  SELECT c.id, c.open_item_id, ABS(c.amount_minor), c.currency
  FROM matches_0022_copy c
  WHERE c.open_item_id IS NOT NULL AND c.amount_minor <> 0 AND c.id IN (SELECT id FROM matches);

-- match_status and the matches table agree from the start (the status trigger below keeps it so):
-- a line that says 'matched' without a live match after the conversion (a dropped or undone row)
-- goes back to 'unmatched' (the review queue); a line with a live match is 'matched'. The first
-- matching run flags converted matches whose items no longer agree (review_reason).
UPDATE bank_transactions SET match_status = 'unmatched'
WHERE match_status = 'matched'
  AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.bank_transaction_id = bank_transactions.id
                    AND m.undone_at IS NULL);
UPDATE bank_transactions SET match_status = 'matched'
WHERE match_status <> 'matched'
  AND EXISTS (SELECT 1 FROM matches m WHERE m.bank_transaction_id = bank_transactions.id
                AND m.undone_at IS NULL);

CREATE UNIQUE INDEX idx_matches_live_tx ON matches (bank_transaction_id) WHERE undone_at IS NULL;
CREATE INDEX idx_matches_tx ON matches (bank_transaction_id);
CREATE INDEX idx_matches_source ON matches (source, created_at DESC, id DESC);
CREATE INDEX idx_match_alloc_item ON match_allocations (open_item_id, match_id);

CREATE TABLE match_suggestions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
  rank                INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 50),
  -- First allocation's item (lowest id for a group); NULL for a ledger candidate.
  open_item_id        INTEGER REFERENCES open_items (id) ON DELETE CASCADE,
  ledger_account_code TEXT CHECK (ledger_account_code IS NULL OR length(ledger_account_code) BETWEEN 1 AND 20),
  score               INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  rule                INTEGER NOT NULL CHECK (rule BETWEEN 1 AND 4),
  kind                TEXT NOT NULL CHECK (kind IN ('full', 'partial', 'overpayment', 'ledger')),
  allocated_minor     INTEGER NOT NULL CHECK (allocated_minor >= 0),
  remaining_minor     INTEGER NOT NULL DEFAULT 0,
  surplus_minor       INTEGER NOT NULL DEFAULT 0,
  -- [{"i": open item id, "a": allocated minor}] for every item of the candidate.
  allocations_json    TEXT NOT NULL DEFAULT '[]',
  -- Codes and weights only: [{"c": code, "w": weight}]; blocked_json: ["code", ...].
  reasons_json        TEXT NOT NULL DEFAULT '[]',
  blocked_json        TEXT NOT NULL DEFAULT '[]',
  -- Cleaned plain-English lines from core explainCandidate (no IBAN, no raw bank text).
  explanation_json    TEXT NOT NULL DEFAULT '[]',
  auto_eligible       INTEGER NOT NULL DEFAULT 0 CHECK (auto_eligible IN (0, 1)),
  group_id            TEXT,
  computed_at         TEXT NOT NULL,
  engine_version      TEXT NOT NULL,
  input_hash          TEXT NOT NULL CHECK (length(input_hash) = 64),
  UNIQUE (bank_transaction_id, rank),
  CHECK (open_item_id IS NOT NULL OR ledger_account_code IS NOT NULL)
);

DROP TABLE matches_0022_copy;
DROP TABLE match_suggestions_0022_copy;

-- (e) -------------------------------------------------------------------------------------------
-- Every guard is a BEFORE trigger that RAISEs ABORT: the statement fails and D1 rolls back the whole
-- db.batch it is part of (D1 batches are one transaction). The Worker maps `match_err:<code>`.

CREATE TRIGGER matches_guard_insert BEFORE INSERT ON matches
BEGIN
  SELECT RAISE(ABORT, 'match_err:tx_not_matchable')
  WHERE NOT EXISTS (
    SELECT 1 FROM bank_transactions t
    WHERE t.id = NEW.bank_transaction_id AND t.match_status IN ('unmatched', 'suggested')
      AND t.is_final = 1 AND t.state = 'completed' AND t.state_conflict = 0
      AND ABS(t.amount_minor) = NEW.amount_minor AND t.currency = NEW.currency);
  SELECT RAISE(ABORT, 'match_err:division_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM bank_transactions t
      JOIN bank_account_exact_map m ON m.bank_account_id = t.bank_account_id
    WHERE t.id = NEW.bank_transaction_id AND m.division_id = NEW.division_id);
  -- The administration must still be synced and its Exact connection not disabled: its open items
  -- would otherwise be stale.
  SELECT RAISE(ABORT, 'match_err:division_inactive')
  WHERE NOT EXISTS (
    SELECT 1 FROM divisions d JOIN connections c ON c.id = d.connection_id
    WHERE d.id = NEW.division_id AND d.sync_enabled = 1 AND c.status <> 'disabled');
  SELECT RAISE(ABORT, 'match_err:bad_match_row')
  WHERE NEW.undone_at IS NOT NULL OR NEW.exact_state <> 'not_booked' OR NEW.review_reason IS NOT NULL;
END;

-- An undone match never becomes live again (a new match is a new row).
CREATE TRIGGER matches_guard_update BEFORE UPDATE OF undone_at ON matches
WHEN OLD.undone_at IS NOT NULL AND (NEW.undone_at IS NULL OR NEW.undone_at <> OLD.undone_at)
BEGIN
  SELECT RAISE(ABORT, 'match_err:cannot_revive');
END;

-- What a match is about never changes after insert (undo, exact_state, review flags may).
CREATE TRIGGER matches_guard_immutable BEFORE UPDATE OF bank_transaction_id, division_id, source,
  ledger_account_code, amount_minor, currency ON matches
WHEN NEW.bank_transaction_id IS NOT OLD.bank_transaction_id OR NEW.division_id IS NOT OLD.division_id
  OR NEW.source IS NOT OLD.source OR NEW.ledger_account_code IS NOT OLD.ledger_account_code
  OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency
BEGIN
  SELECT RAISE(ABORT, 'match_err:immutable');
END;

CREATE TRIGGER match_allocations_guard BEFORE INSERT ON match_allocations
BEGIN
  SELECT RAISE(ABORT, 'match_err:match_not_live')
  WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = NEW.match_id AND m.undone_at IS NULL);
  -- A ledger match books to a ledger account; it has no invoice allocations.
  SELECT RAISE(ABORT, 'match_err:alloc_on_ledger_match')
  WHERE EXISTS (SELECT 1 FROM matches m WHERE m.id = NEW.match_id AND m.ledger_account_code IS NOT NULL);
  SELECT RAISE(ABORT, 'match_err:item_not_matchable')
  WHERE NOT EXISTS (
    SELECT 1 FROM open_items oi JOIN matches m ON m.id = NEW.match_id
    WHERE oi.id = NEW.open_item_id AND oi.status = 'open' AND oi.open_minor <> 0
      AND oi.division_id = m.division_id AND oi.currency = NEW.currency
      AND oi.currency = m.currency);
  -- Money in settles an invoice or a supplier credit note; money out a bill or a customer credit
  -- note: (kind = invoice) = (open_minor > 0) is "settled by money in".
  SELECT RAISE(ABORT, 'match_err:direction_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM open_items oi, matches m JOIN bank_transactions t ON t.id = m.bank_transaction_id
    WHERE oi.id = NEW.open_item_id AND m.id = NEW.match_id
      AND ((oi.kind = 'invoice') = (oi.open_minor > 0)) = (t.amount_minor > 0));
  SELECT RAISE(ABORT, 'match_err:alloc_exceeds_open')
  WHERE (SELECT COALESCE(SUM(a.allocated_minor), 0) FROM match_allocations a
           JOIN matches m ON m.id = a.match_id
          WHERE a.open_item_id = NEW.open_item_id AND m.undone_at IS NULL) + NEW.allocated_minor
        > (SELECT ABS(oi.open_minor) FROM open_items oi WHERE oi.id = NEW.open_item_id);
  SELECT RAISE(ABORT, 'match_err:alloc_exceeds_tx')
  WHERE (SELECT COALESCE(SUM(a.allocated_minor), 0) FROM match_allocations a
          WHERE a.match_id = NEW.match_id) + NEW.allocated_minor
        > (SELECT m.amount_minor FROM matches m WHERE m.id = NEW.match_id);
END;

-- Allocations are never edited: Undo marks the whole match undone, a new match is a new row.
CREATE TRIGGER match_allocations_guard_update BEFORE UPDATE ON match_allocations
BEGIN
  SELECT RAISE(ABORT, 'match_err:immutable');
END;

-- The money fields of a line with a live match never change (the Revolut ingest keeps them and only
-- flags state_conflict, ADR 0034); this is the database backstop for any other writer.
CREATE TRIGGER bank_transactions_guard_matched BEFORE UPDATE OF amount_minor, currency, bank_account_id
  ON bank_transactions
WHEN (NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency
      OR NEW.bank_account_id IS NOT OLD.bank_account_id)
  AND EXISTS (SELECT 1 FROM matches m WHERE m.bank_transaction_id = OLD.id AND m.undone_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'match_err:tx_frozen');
END;

-- match_status and the matches table agree: a line with a live match stays 'matched'; nothing else
-- may claim 'matched' without a live match (applyMatch inserts the match first, undo ends it first).
CREATE TRIGGER bank_transactions_guard_status BEFORE UPDATE OF match_status ON bank_transactions
WHEN NEW.match_status IS NOT OLD.match_status
  AND ((NEW.match_status = 'matched') <> EXISTS (SELECT 1 FROM matches m
         WHERE m.bank_transaction_id = OLD.id AND m.undone_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'match_err:status_mismatch');
END;

-- The administration of a bank account cannot move (or be removed) under live matches.
CREATE TRIGGER bank_account_map_guard_update BEFORE UPDATE OF division_id, bank_account_id
  ON bank_account_exact_map
WHEN (NEW.division_id IS NOT OLD.division_id OR NEW.bank_account_id IS NOT OLD.bank_account_id)
  AND EXISTS (SELECT 1 FROM matches m JOIN bank_transactions t ON t.id = m.bank_transaction_id
              WHERE t.bank_account_id = OLD.bank_account_id AND m.undone_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'match_err:has_live_matches');
END;

CREATE TRIGGER bank_account_map_guard_delete BEFORE DELETE ON bank_account_exact_map
WHEN EXISTS (SELECT 1 FROM matches m JOIN bank_transactions t ON t.id = m.bank_transaction_id
             WHERE t.bank_account_id = OLD.bank_account_id AND m.undone_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'match_err:has_live_matches');
END;
