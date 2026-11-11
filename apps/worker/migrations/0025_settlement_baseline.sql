-- 0025 Settlement baseline (Phase 7 final-review fix S5, ADR 0042 addendum).
--
-- Until now an allocation of a match booked in Exact stopped counting against the item as soon as
-- the item had been re-read (open_items.synced_at > matches.booked_at). If Exact's list read lags
-- the MatchSet, the item reappears fully open and the same money could be allocated twice. The new
-- rule releases an allocation only when the re-read item PROVES the payment: it is closed, or its
-- open balance fell by at least the allocated amount since the balance recorded for the match.
--
--  (a) match_allocations.open_before_minor: Exact's signed open balance of the item when the match
--      was created (and again just before the booking claim, see recordOpenBefore). NULL (rows that
--      exist now) means "unknown": the allocation keeps counting. Booking is still off, so no
--      booked match depends on this.
--  (b) match_allocations_guard is recreated with the new predicate in the over-allocation check.
--      The predicate text is the SETTLEMENT_PREDICATE constant of src/matching/settlement.ts,
--      verbatim; test/matching-settlement.test.ts compares the two.
--  (c) match_allocations_guard_update: allocations stay immutable, EXCEPT open_before_minor, which
--      may be refreshed while the match is still 'not_booked' (a second trigger).
--
-- Rule for every later migration: any migration that rebuilds a guarded table must recreate its
-- triggers and update test/fixtures/trigger-hashes.json deliberately (pnpm run triggers:update).

ALTER TABLE match_allocations ADD COLUMN open_before_minor INTEGER;

-- (b) -------------------------------------------------------------------------------------------
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
  -- Live allocations count against the item's open balance, EXCEPT released ones (the settlement
  -- predicate: booked in Exact, item re-read, and the re-read balance proves the payment).
  SELECT RAISE(ABORT, 'match_err:alloc_exceeds_open')
  WHERE (SELECT COALESCE(SUM(a.allocated_minor), 0) FROM match_allocations a
           JOIN matches m ON m.id = a.match_id
           JOIN open_items oi ON oi.id = a.open_item_id
          WHERE a.open_item_id = NEW.open_item_id AND m.undone_at IS NULL AND NOT (m.exact_state = 'matched_in_exact' AND m.booked_at IS NOT NULL AND m.booked_at < oi.synced_at AND a.open_before_minor IS NOT NULL AND (oi.status <> 'open' OR oi.open_minor = 0 OR ABS(a.open_before_minor) - ABS(oi.open_minor) >= a.allocated_minor)))
        + NEW.allocated_minor
        > (SELECT ABS(oi.open_minor) FROM open_items oi WHERE oi.id = NEW.open_item_id);
  SELECT RAISE(ABORT, 'match_err:alloc_exceeds_tx')
  WHERE (SELECT COALESCE(SUM(a.allocated_minor), 0) FROM match_allocations a
          WHERE a.match_id = NEW.match_id) + NEW.allocated_minor
        > (SELECT m.amount_minor FROM matches m WHERE m.id = NEW.match_id);
END;

-- (c) -------------------------------------------------------------------------------------------
DROP TRIGGER match_allocations_guard_update;
CREATE TRIGGER match_allocations_guard_update
BEFORE UPDATE OF match_id, open_item_id, allocated_minor, currency, remaining_minor_after
  ON match_allocations
BEGIN
  SELECT RAISE(ABORT, 'match_err:immutable');
END;

CREATE TRIGGER match_allocations_guard_open_before BEFORE UPDATE OF open_before_minor
  ON match_allocations
WHEN NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = NEW.match_id AND m.exact_state = 'not_booked')
BEGIN
  SELECT RAISE(ABORT, 'match_err:immutable');
END;

-- (d) Retention of exact_write_outbox.payload_json (ADR 0011, review N3) ---------------------------
-- The payload holds counterparty names (personal data). A finished row (verified, resolved_manually,
-- given_up) is immutable (0023), with ONE exception: its payload may be replaced by the fixed
-- placeholder below, nothing else changing, so the housekeeping can redact it after 400 days while
-- the row, its hash and its audit trail stay. payload_json is NOT NULL and must be valid JSON, so
-- the placeholder stands in for NULL.
DROP TRIGGER outbox_guard_update;
CREATE TRIGGER outbox_guard_update BEFORE UPDATE ON exact_write_outbox
WHEN (OLD.status IN ('verified', 'resolved_manually', 'given_up')
      AND NOT (NEW.payload_json = '{"v":1,"stage":"redacted"}' AND OLD.payload_json <> NEW.payload_json
               AND NEW.status IS OLD.status AND NEW.payload_hash IS OLD.payload_hash
               AND NEW.updated_at IS OLD.updated_at))
  OR NEW.match_id IS NOT OLD.match_id OR NEW.kind IS NOT OLD.kind
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.division_id IS NOT OLD.division_id
BEGIN
  SELECT RAISE(ABORT, 'booking_err:terminal');
END;
