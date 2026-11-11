-- 0024 Booking path hardening (Phase 7 final review, task U1, ADR 0044 "Final review").
--
--  (a) matches.booking_deferred_code / booking_deferred_at: why the executor cannot book a match YET
--      (configuration or missing data). The match is NOT claimed: it stays 'not_booked', so Undo and
--      a later run still work (review B1). matches.manually_booked: 1 when a person booked it in
--      Exact by hand (resolution `booked_manually`), so a read can tell it from an app booking (N7).
--  (b) bank_account_exact_map.opening_balance_minor: admin-supplied opening balance, used ONLY for
--      the first bank entry of a journal that has no entry in Exact yet (assumption A12b).
--  (c) exact_write_outbox: creates_bank_entries (the booking mode at claim time), admin_resolved_by /
--      admin_resolved_at (set by the resolve route when a person retries a row).
--  (d) batch_guard: a table nobody ever fills. A statement of a db.batch INSERTs into it when the
--      batch is out of step; its trigger raises `batch_guard:match_out_of_step`, which aborts the
--      whole batch deterministically (replaces the text match on 'malformed JSON', N4).
--  (e) Guards, recreated or new:
--        matches_guard_exact_state   not_booked -> booking needs review_reason IS NULL (S9);
--                                    manual_required -> not_booked only when no outbox row is left
--                                    (retry of a match that never reached Exact, B1)
--        matches_guard_undo_claimed  a claimed match can be undone only when it is manual_required,
--                                    has outbox rows and EVERY one of them is a stage 'none' row that
--                                    never sent anything (B1); any other claimed match is never undone
--        matches_guard_manually_booked  1 only together with 'matched_in_exact', and never reset
--        outbox_guard_status         the legal status transitions of an outbox row (S9). A row leaves
--                                    outcome_unknown or failed for pending ONLY by an admin retry:
--                                    needs_probe = 1 and admin_resolved_by/at set in the same UPDATE.
--        outbox_guard_sent_facts     what proves that something MAY have been sent is never erased
--                                    (review of U1): attempts only go down by one together with
--                                    sending -> pending (a provably unsent POST), exact_ref is never
--                                    cleared, a stage 'none' payload is never written or changed by an
--                                    UPDATE, sending -> pending needs that given-back attempt or a probe.
--        outbox_guard_delete         only an unsent stage 'none' row may be deleted (undo or retry of a
--                                    claim that never reached Exact): with the rows gone a match may go
--                                    back to not_booked, so deleting a row that was sent would re-open
--                                    a booked match for a second booking.
--      Rebuilding matches or exact_write_outbox later MUST recreate these triggers.

-- (a) -------------------------------------------------------------------------------------------
ALTER TABLE matches ADD COLUMN booking_deferred_code TEXT
  CHECK (booking_deferred_code IS NULL OR
         (length(booking_deferred_code) <= 64 AND booking_deferred_code NOT GLOB '*[^a-z0-9_]*'));
ALTER TABLE matches ADD COLUMN booking_deferred_at TEXT;
ALTER TABLE matches ADD COLUMN manually_booked INTEGER NOT NULL DEFAULT 0
  CHECK (manually_booked IN (0, 1));
-- Random id of the last booking transition that moved the match (booking/outbox.ts): lets the batch
-- that moved the outbox row prove that it moved the match too (batch_guard, (d) below).
ALTER TABLE matches ADD COLUMN op_nonce TEXT;

-- (b) -------------------------------------------------------------------------------------------
ALTER TABLE bank_account_exact_map ADD COLUMN opening_balance_minor INTEGER
  CHECK (opening_balance_minor IS NULL OR typeof(opening_balance_minor) = 'integer');

-- (c) -------------------------------------------------------------------------------------------
ALTER TABLE exact_write_outbox ADD COLUMN creates_bank_entries INTEGER
  CHECK (creates_bank_entries IS NULL OR creates_bank_entries IN (0, 1));
ALTER TABLE exact_write_outbox ADD COLUMN admin_resolved_by TEXT;
ALTER TABLE exact_write_outbox ADD COLUMN admin_resolved_at TEXT;

-- (d) -------------------------------------------------------------------------------------------
CREATE TABLE batch_guard (code TEXT NOT NULL);
CREATE TRIGGER batch_guard_match_out_of_step BEFORE INSERT ON batch_guard
WHEN NEW.code = 'match_out_of_step'
BEGIN
  SELECT RAISE(ABORT, 'batch_guard:match_out_of_step');
END;
CREATE TRIGGER batch_guard_other BEFORE INSERT ON batch_guard
WHEN NEW.code <> 'match_out_of_step'
BEGIN
  SELECT RAISE(ABORT, 'batch_guard:refused');
END;

-- (e) -------------------------------------------------------------------------------------------
DROP TRIGGER matches_guard_exact_state;
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
         OR (OLD.exact_state = 'manual_required' AND NEW.exact_state IN ('matched_in_exact', 'not_booked')));
  -- A flagged match (its data changed after matching) is never claimed for booking.
  SELECT RAISE(ABORT, 'match_err:bad_transition')
  WHERE OLD.exact_state = 'not_booked' AND NEW.exact_state = 'booking' AND NEW.review_reason IS NOT NULL;
  -- Back to 'not_booked' only when nothing of this match is left in the outbox.
  SELECT RAISE(ABORT, 'match_err:bad_transition')
  WHERE NEW.exact_state = 'not_booked'
    AND EXISTS (SELECT 1 FROM exact_write_outbox o WHERE o.match_id = OLD.id);
  SELECT RAISE(ABORT, 'match_err:bad_match_row')
  WHERE NEW.exact_state = 'matched_in_exact' AND NEW.booked_at IS NULL;
END;

DROP TRIGGER matches_guard_undo_claimed;
CREATE TRIGGER matches_guard_undo_claimed BEFORE UPDATE OF undone_at ON matches
WHEN OLD.undone_at IS NULL AND NEW.undone_at IS NOT NULL AND OLD.exact_state <> 'not_booked'
  AND NOT (OLD.exact_state = 'manual_required'
           AND EXISTS (SELECT 1 FROM exact_write_outbox oy WHERE oy.match_id = OLD.id)
           AND NOT EXISTS (SELECT 1 FROM exact_write_outbox o WHERE o.match_id = OLD.id
                             AND NOT (json_extract(o.payload_json, '$.stage') = 'none'
                                      AND o.status = 'manual_required' AND o.attempts = 0
                                      AND o.exact_ref IS NULL)))
BEGIN
  SELECT RAISE(ABORT, 'match_err:bad_transition');
END;

CREATE TRIGGER matches_guard_manually_booked BEFORE UPDATE OF manually_booked ON matches
WHEN NEW.manually_booked IS NOT OLD.manually_booked
BEGIN
  SELECT RAISE(ABORT, 'match_err:bad_match_row')
  WHERE OLD.manually_booked = 1 OR NEW.exact_state <> 'matched_in_exact';
END;

CREATE TRIGGER outbox_guard_status BEFORE UPDATE OF status ON exact_write_outbox
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'booking_err:bad_transition')
  WHERE NOT (
       (OLD.status = 'pending' AND NEW.status IN
          ('sending', 'manual_required', 'waiting_for_bank_line', 'verified', 'resolved_manually', 'given_up'))
    OR (OLD.status = 'waiting_for_bank_line' AND NEW.status IN
          ('pending', 'manual_required', 'verified', 'resolved_manually', 'given_up'))
    OR (OLD.status = 'sending' AND NEW.status IN
          ('pending', 'sent_unverified', 'failed', 'outcome_unknown', 'manual_required', 'verified',
           'resolved_manually', 'given_up'))
    OR (OLD.status = 'sent_unverified' AND NEW.status IN
          ('verified', 'outcome_unknown', 'failed', 'manual_required', 'resolved_manually', 'given_up'))
    OR (OLD.status = 'failed' AND NEW.status IN
          ('sending', 'pending', 'verified', 'manual_required', 'resolved_manually', 'given_up'))
    -- An unknown outcome is decided by a person only: retry (pending, probe first), booked by hand
    -- (resolved_manually) or given up. Nothing in the app may call it verified.
    OR (OLD.status = 'outcome_unknown' AND NEW.status IN ('pending', 'resolved_manually', 'given_up'))
    OR (OLD.status = 'manual_required' AND NEW.status IN ('resolved_manually', 'given_up')));
  -- Out of 'outcome_unknown' or 'failed' back to 'pending' only by a person's retry: the same
  -- UPDATE asks for a probe before any send and records who resolved it and when.
  SELECT RAISE(ABORT, 'booking_err:admin_only')
  WHERE OLD.status IN ('outcome_unknown', 'failed') AND NEW.status = 'pending'
    AND NOT (NEW.needs_probe = 1 AND NEW.admin_resolved_by IS NOT NULL AND NEW.admin_resolved_at IS NOT NULL
             AND (NEW.admin_resolved_at IS NOT OLD.admin_resolved_at
                  OR NEW.admin_resolved_by IS NOT OLD.admin_resolved_by));
END;

-- The facts that say something MAY be in Exact are never erased (U1 review). The undo/retry of an
-- unsent claim (matches_guard_undo_claimed, matches_guard_exact_state, outbox_guard_delete) trusts
-- `attempts = 0`, `exact_ref IS NULL` and the stage 'none' payload: none of them can be forged later.
CREATE TRIGGER outbox_guard_sent_facts BEFORE UPDATE ON exact_write_outbox
BEGIN
  SELECT RAISE(ABORT, 'booking_err:sent_facts')
  WHERE NEW.attempts < OLD.attempts
    AND NOT (OLD.status = 'sending' AND NEW.status = 'pending' AND NEW.attempts = OLD.attempts - 1);
  SELECT RAISE(ABORT, 'booking_err:sent_facts')
  WHERE OLD.exact_ref IS NOT NULL AND NEW.exact_ref IS NOT OLD.exact_ref AND NEW.exact_ref IS NULL;
  SELECT RAISE(ABORT, 'booking_err:sent_facts')
  WHERE NEW.payload_json IS NOT OLD.payload_json
    AND ((json_valid(NEW.payload_json) AND json_extract(NEW.payload_json, '$.stage') = 'none')
      OR (json_valid(OLD.payload_json) AND json_extract(OLD.payload_json, '$.stage') = 'none'));
  -- Back from sending to pending only when the POST provably did not leave (the attempt is given
  -- back) or with a probe before any new send (429).
  SELECT RAISE(ABORT, 'booking_err:sent_facts')
  WHERE OLD.status = 'sending' AND NEW.status = 'pending'
    AND NOT (NEW.attempts = OLD.attempts - 1 OR NEW.needs_probe = 1);
END;

CREATE TRIGGER outbox_guard_delete BEFORE DELETE ON exact_write_outbox
WHEN NOT (json_valid(OLD.payload_json) AND json_extract(OLD.payload_json, '$.stage') = 'none'
          AND OLD.status = 'manual_required' AND OLD.attempts = 0 AND OLD.exact_ref IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'booking_err:not_deletable');
END;
