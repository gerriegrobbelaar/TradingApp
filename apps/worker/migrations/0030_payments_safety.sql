-- 0030 payments safety fixes (Phase 9 final review, F9a, ADR 0052). ADDITIVE ONLY: nothing is rebuilt,
-- no row of an existing table is rewritten except the best-effort back-fill of `alert_kind`, and
-- nothing here can move money.
--
--   payment_reconcile        alert state a person can see and acknowledge (S1):
--                              alert_at       when the CURRENT alert was raised (existed before)
--                              alert_kind     what it is (closed list below)
--                              alert_ack_at / alert_ack_by   who acknowledged it, when
--                            An alert is OPEN while alert_at IS NOT NULL AND alert_ack_at IS NULL.
--   key_id on supplier_iban_verifications, payment_payees, payments (S5): the non-secret id of the
--                            PAYMENTS_IBAN_KEY under which the fingerprint beside it was made (first 8
--                            hex of HMAC(key, 'key-id')), so a rotated key is told from a changed IBAN.
--                            NULL = a row from before key ids; such a row cannot show a rotation.
--   payment_draft_transactions  the transaction ids (with amounts) a COMPLETED draft named when it was
--                            marked paid, so the items of a batch can be linked to their bank lines (B2).
-- Triggers are pinned in test/fixtures/trigger-hashes.json.

ALTER TABLE payment_reconcile ADD COLUMN alert_kind TEXT
  CHECK (alert_kind IS NULL OR alert_kind IN
    ('mismatch', 'duplicate', 'approved_after_expiry', 'reverted_after_paid', 'draft_gone',
     'draft_completed_unlinked'));
ALTER TABLE payment_reconcile ADD COLUMN alert_ack_at TEXT;
ALTER TABLE payment_reconcile ADD COLUMN alert_ack_by TEXT;

-- Best effort for alerts raised before this migration (the feature is not live; this only keeps the
-- open-alert definition true for any row that has one): the last result names the kind when it can.
UPDATE payment_reconcile
   SET alert_kind = CASE WHEN last_result IN ('mismatch', 'duplicate', 'approved_after_expiry', 'reverted_after_paid')
                         THEN last_result ELSE 'mismatch' END
 WHERE alert_at IS NOT NULL AND alert_kind IS NULL;

ALTER TABLE supplier_iban_verifications ADD COLUMN key_id TEXT
  CHECK (key_id IS NULL OR (length(key_id) = 8 AND key_id NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE payment_payees ADD COLUMN key_id TEXT
  CHECK (key_id IS NULL OR (length(key_id) = 8 AND key_id NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE payments ADD COLUMN key_id TEXT
  CHECK (key_id IS NULL OR (length(key_id) = 8 AND key_id NOT GLOB '*[^0-9a-f]*'));

-- A key id is written once with its fingerprint and never changes (the existing payload guard cannot
-- cover a column that did not exist when it was written). A row without one stays without one.
CREATE TRIGGER payments_guard_key_id BEFORE UPDATE OF key_id ON payments
WHEN NEW.key_id IS NOT OLD.key_id
BEGIN
  SELECT RAISE(ABORT, 'payment_err:payload_immutable');
END;
CREATE TRIGGER payment_payees_guard_key_id BEFORE UPDATE OF key_id ON payment_payees
WHEN NEW.key_id IS NOT OLD.key_id
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;

CREATE TABLE payment_draft_transactions (
  subject_kind   TEXT NOT NULL CHECK (subject_kind IN ('payment', 'batch')),
  subject_id     INTEGER NOT NULL,
  transaction_id TEXT NOT NULL CHECK (length(transaction_id) BETWEEN 1 AND 100),
  -- Magnitude of the money that left our account in this transaction (always positive).
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency       TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  recorded_at    TEXT NOT NULL,
  PRIMARY KEY (subject_kind, subject_id, transaction_id)
) WITHOUT ROWID;

-- Recorded only for a subject that is `paid` (the move comes first in the same batch), append-only.
CREATE TRIGGER payment_draft_transactions_guard_insert BEFORE INSERT ON payment_draft_transactions
BEGIN
  SELECT RAISE(ABORT, 'payment_err:link_subject')
  WHERE NOT (
    (NEW.subject_kind = 'payment' AND EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.subject_id AND p.status = 'paid'))
    OR (NEW.subject_kind = 'batch' AND EXISTS (SELECT 1 FROM payment_batches b WHERE b.id = NEW.subject_id AND b.status = 'paid')));
END;
CREATE TRIGGER payment_draft_transactions_guard_update BEFORE UPDATE ON payment_draft_transactions
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;
CREATE TRIGGER payment_draft_transactions_guard_delete BEFORE DELETE ON payment_draft_transactions
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;
