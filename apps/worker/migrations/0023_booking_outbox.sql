-- 0023 Booking outbox: the GATED write path to Exact (Phase 7, task M7c, ADR 0044).
--
--  (a) matches.booked_at: when the MatchSet was read back as applied in Exact. matches.exact_note:
--      a short machine code for the last booking problem (never text from Exact or the bank).
--  (b) bank_account_exact_map: the receivable and payable CONTROL accounts of the administration
--      (the MatchSet names the ledger account the open items sit on). NULL = booking stops with
--      `control_account_unknown`, never a guess.
--  (c) exact_write_outbox: one row per write to Exact, stored with its full (sanitised) payload and
--      idempotency key BEFORE any network call. UNIQUE (match_id, kind).
--  (d) Allocation settlement (ADR 0044, fixes the double count noted in ADR 0042): an allocation of
--      a match that reached 'matched_in_exact' stops counting against the item's open balance once
--      the item was re-read from Exact AFTER the booking (open_items.synced_at > matches.booked_at);
--      from then on Exact's own open_minor reflects the payment. match_allocations_guard is
--      recreated with that rule; the assembly, the review flags and the invariants use the same
--      predicate (matching/store.ts `allocCounts`).
--  (e) Guards (triggers): legal exact_state transitions only (`match_err:bad_transition`), an
--      undone match never changes state, a claimed match is never undone, 'matched_in_exact' needs booked_at, outbox rows only for a
--      claimed live match (`booking_err:not_claimed`), a finished outbox row never changes
--      (`booking_err:terminal`).

-- (a) -------------------------------------------------------------------------------------------
ALTER TABLE matches ADD COLUMN booked_at TEXT;
ALTER TABLE matches ADD COLUMN exact_note TEXT
  CHECK (exact_note IS NULL OR (length(exact_note) <= 64 AND exact_note NOT GLOB '*[^a-z0-9_]*'));

-- (b) -------------------------------------------------------------------------------------------
ALTER TABLE bank_account_exact_map ADD COLUMN receivable_gl_account_code TEXT
  CHECK (receivable_gl_account_code IS NULL OR length(receivable_gl_account_code) BETWEEN 1 AND 20);
ALTER TABLE bank_account_exact_map ADD COLUMN payable_gl_account_code TEXT
  CHECK (payable_gl_account_code IS NULL OR length(payable_gl_account_code) BETWEEN 1 AND 20);

-- (c) -------------------------------------------------------------------------------------------
CREATE TABLE exact_write_outbox (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id         INTEGER NOT NULL REFERENCES matches (id),
  division_id      INTEGER NOT NULL REFERENCES divisions (id),
  -- Set for a built bank entry only: at most one such entry per journal is in flight (the opening
  -- balance of the next one depends on the closing balance of this one).
  journal_code     TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('bank_entry', 'matchset')),
  idempotency_key  TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 64),
  -- {"v":1,"stage":"none"|"plan"|"built",...}: builder INPUT with sanitised text (no IBAN, no
  -- token), plus builtHash (sha-256 of the built body) once built. payload_hash = sha-256 of this text.
  payload_json     TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash     TEXT NOT NULL CHECK (length(payload_hash) = 64),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                     'pending', 'sending', 'sent_unverified', 'verified', 'failed', 'outcome_unknown',
                     'manual_required', 'waiting_for_bank_line', 'resolved_manually', 'given_up')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code  TEXT CHECK (last_error_code IS NULL OR
                     (length(last_error_code) <= 64 AND last_error_code NOT GLOB '*[^a-z0-9_]*')),
  exact_ref        TEXT CHECK (exact_ref IS NULL OR length(exact_ref) <= 64),
  -- 1 = read Exact first (probe / read-back) before any POST of this row.
  needs_probe      INTEGER NOT NULL DEFAULT 0 CHECK (needs_probe IN (0, 1)),
  next_attempt_at  TEXT,
  claimed_at       TEXT,
  lease_expires_at TEXT,
  -- Random id of the last transition (booking/outbox.ts): lets the same batch prove that IT moved
  -- the row, so a match that is not where the transition expected rolls the whole batch back.
  op_nonce         TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (match_id, kind)
);
CREATE INDEX idx_outbox_status ON exact_write_outbox (status, created_at);
CREATE INDEX idx_outbox_journal ON exact_write_outbox (division_id, journal_code, status);

CREATE TRIGGER outbox_guard_insert BEFORE INSERT ON exact_write_outbox
BEGIN
  SELECT RAISE(ABORT, 'booking_err:not_claimed')
  WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = NEW.match_id AND m.undone_at IS NULL
                      AND m.exact_state IN ('booking', 'bank_entry_created', 'manual_required')
                      AND m.division_id = NEW.division_id);
END;

CREATE TRIGGER outbox_guard_update BEFORE UPDATE ON exact_write_outbox
WHEN OLD.status IN ('verified', 'resolved_manually', 'given_up')
  OR NEW.match_id IS NOT OLD.match_id OR NEW.kind IS NOT OLD.kind
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.division_id IS NOT OLD.division_id
BEGIN
  SELECT RAISE(ABORT, 'booking_err:terminal');
END;

-- The persisted call ledger of the booking job (review M7c): one row per Exact call, inserted
-- BEFORE the call by a conditional INSERT that only succeeds while fewer than the daily cap were
-- made in the rolling window. Overlapping runs, crashed runs and manual runs all count.
CREATE TABLE booking_call_ledger (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  run_id INTEGER
);
CREATE INDEX idx_booking_call_ledger_at ON booking_call_ledger (at);

-- (e) -------------------------------------------------------------------------------------------
CREATE TRIGGER matches_guard_exact_state BEFORE UPDATE OF exact_state ON matches
WHEN NEW.exact_state IS NOT OLD.exact_state
BEGIN
  SELECT RAISE(ABORT, 'match_err:bad_transition')
  WHERE OLD.undone_at IS NOT NULL
    OR NOT ((OLD.exact_state = 'not_booked' AND NEW.exact_state IN ('booking', 'manual_required'))
         OR (OLD.exact_state = 'booking' AND NEW.exact_state IN
              ('bank_entry_created', 'matched_in_exact', 'booking_failed', 'manual_required', 'outcome_unknown'))
         OR (OLD.exact_state = 'bank_entry_created' AND NEW.exact_state IN
              ('matched_in_exact', 'booking_failed', 'manual_required', 'outcome_unknown'))
         OR (OLD.exact_state = 'booking_failed' AND NEW.exact_state IN
              ('booking', 'manual_required', 'matched_in_exact'))
         OR (OLD.exact_state = 'outcome_unknown' AND NEW.exact_state IN
              ('booking', 'matched_in_exact', 'manual_required'))
         OR (OLD.exact_state = 'manual_required' AND NEW.exact_state IN ('matched_in_exact')));
  SELECT RAISE(ABORT, 'match_err:bad_match_row')
  WHERE NEW.exact_state = 'matched_in_exact' AND NEW.booked_at IS NULL;
END;

-- A match that the booking has claimed (anything but 'not_booked') can never be undone in the app:
-- it may already be in Exact (reversal is a manual step there, ADR 0044).
CREATE TRIGGER matches_guard_undo_claimed BEFORE UPDATE OF undone_at ON matches
WHEN OLD.undone_at IS NULL AND NEW.undone_at IS NOT NULL AND OLD.exact_state <> 'not_booked'
BEGIN
  SELECT RAISE(ABORT, 'match_err:bad_transition');
END;

-- booked_at is written once, together with 'matched_in_exact', and never changes afterwards.
CREATE TRIGGER matches_guard_booked_at BEFORE UPDATE OF booked_at ON matches
WHEN NEW.booked_at IS NOT OLD.booked_at AND OLD.booked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'match_err:immutable');
END;

-- (d) -------------------------------------------------------------------------------------------
DROP TRIGGER match_allocations_guard;
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
  -- Live allocations count against the item's open balance, EXCEPT those of a match booked in
  -- Exact whose item was re-read from Exact after the booking (Exact's own open_minor has them).
  SELECT RAISE(ABORT, 'match_err:alloc_exceeds_open')
  WHERE (SELECT COALESCE(SUM(a.allocated_minor), 0) FROM match_allocations a
           JOIN matches m ON m.id = a.match_id
          WHERE a.open_item_id = NEW.open_item_id AND m.undone_at IS NULL
            AND NOT (m.exact_state = 'matched_in_exact' AND m.booked_at IS NOT NULL
                     AND m.booked_at < (SELECT oi.synced_at FROM open_items oi WHERE oi.id = NEW.open_item_id)))
        + NEW.allocated_minor
        > (SELECT ABS(oi.open_minor) FROM open_items oi WHERE oi.id = NEW.open_item_id);
  SELECT RAISE(ABORT, 'match_err:alloc_exceeds_tx')
  WHERE (SELECT COALESCE(SUM(a.allocated_minor), 0) FROM match_allocations a
          WHERE a.match_id = NEW.match_id) + NEW.allocated_minor
        > (SELECT m.amount_minor FROM matches m WHERE m.id = NEW.match_id);
END;
