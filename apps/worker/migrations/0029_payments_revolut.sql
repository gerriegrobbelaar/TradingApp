-- 0029 payments, Revolut execution (Phase 9, P9b, ADR 0050). ADDITIVE ONLY: nothing of 0028 is
-- rebuilt, and nothing here can move money. It adds
--   * payment_payees          the Revolut counterparty created ONCE per (connection, supplier IBAN
--                             fingerprint); the IBAN itself is not stored here (it stays in payments)
--   * payment_bank_links      payment <-> bank line, written only for a `paid` payment and only when
--                             the line has the same account, currency and amount (money out)
--   * payment_reconcile       what the reconciliation saw last for a payment or batch (a bookkeeping
--                             row; the state itself lives in payments / payment_batches)
-- and one guard on the state machine: a payment or batch that is `outcome_unknown` can only be
-- called `rejected` (nothing was sent) after the reconciliation looked it up at least once and
-- found nothing. A person can still do it (the route needs a step-up and a typed phrase) but never
-- without that proof of a lookup. Triggers are pinned in test/fixtures/trigger-hashes.json.

CREATE TABLE payment_payees (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id           INTEGER NOT NULL REFERENCES connections (id),
  iban_fingerprint        TEXT NOT NULL CHECK (length(iban_fingerprint) = 64 AND iban_fingerprint NOT GLOB '*[^0-9a-f]*'),
  revolut_counterparty_id TEXT NOT NULL CHECK (length(revolut_counterparty_id) BETWEEN 8 AND 100),
  revolut_account_id      TEXT CHECK (revolut_account_id IS NULL OR length(revolut_account_id) BETWEEN 8 AND 100),
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 140),
  created_for             TEXT NOT NULL CHECK (length(created_for) BETWEEN 8 AND 100),
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at              TEXT,
  UNIQUE (connection_id, iban_fingerprint)
);

-- Only revoking is allowed after the insert (a payee that no longer exists at Revolut).
CREATE TRIGGER payment_payees_guard_update BEFORE UPDATE ON payment_payees
WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id
  OR NEW.iban_fingerprint IS NOT OLD.iban_fingerprint
  OR NEW.revolut_counterparty_id IS NOT OLD.revolut_counterparty_id
  OR NEW.revolut_account_id IS NOT OLD.revolut_account_id
  OR NEW.name IS NOT OLD.name OR NEW.created_for IS NOT OLD.created_for
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;
CREATE TRIGGER payment_payees_guard_delete BEFORE DELETE ON payment_payees
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;

CREATE TABLE payment_bank_links (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id          INTEGER NOT NULL UNIQUE REFERENCES payments (id),
  bank_transaction_id INTEGER NOT NULL UNIQUE REFERENCES bank_transactions (id),
  via                 TEXT NOT NULL CHECK (via IN ('request_id', 'transaction_id')),
  linked_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER payment_bank_links_guard_insert BEFORE INSERT ON payment_bank_links
BEGIN
  SELECT RAISE(ABORT, 'payment_err:link_subject')
  WHERE NOT EXISTS (
    SELECT 1 FROM payments p JOIN bank_transactions t ON t.id = NEW.bank_transaction_id
     WHERE p.id = NEW.payment_id AND p.status = 'paid'
       AND t.bank_account_id = p.bank_account_id AND t.currency = p.currency
       AND t.amount_minor = -p.amount_minor);
END;
CREATE TRIGGER payment_bank_links_guard_update BEFORE UPDATE ON payment_bank_links
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;
CREATE TRIGGER payment_bank_links_guard_delete BEFORE DELETE ON payment_bank_links
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;

CREATE TABLE payment_reconcile (
  subject_kind     TEXT NOT NULL CHECK (subject_kind IN ('payment', 'batch')),
  subject_id       INTEGER NOT NULL,
  first_checked_at TEXT NOT NULL,
  last_checked_at  TEXT NOT NULL,
  checks           INTEGER NOT NULL DEFAULT 1 CHECK (checks >= 1),
  not_found_checks INTEGER NOT NULL DEFAULT 0 CHECK (not_found_checks >= 0),
  last_result      TEXT NOT NULL CHECK (last_result IN
                     ('pending', 'paid', 'failed', 'not_found', 'mismatch', 'duplicate', 'unreadable',
                      'error', 'draft_expired', 'approved_after_expiry', 'reverted_after_paid', 'resolved')),
  provider_state   TEXT CHECK (provider_state IS NULL OR length(provider_state) <= 40),
  transaction_id   TEXT CHECK (transaction_id IS NULL OR length(transaction_id) <= 100),
  alert_at         TEXT,
  PRIMARY KEY (subject_kind, subject_id)
) WITHOUT ROWID;

-- An unknown outcome is called "rejected" (nothing was sent) only after a lookup found nothing.
CREATE TRIGGER payments_guard_unknown_reject BEFORE UPDATE OF status ON payments
WHEN OLD.status = 'outcome_unknown' AND NEW.status = 'rejected'
BEGIN
  SELECT RAISE(ABORT, 'payment_err:not_looked_up')
  WHERE NOT EXISTS (SELECT 1 FROM payment_reconcile r
                     WHERE r.subject_kind = 'payment' AND r.subject_id = NEW.id AND r.not_found_checks >= 1);
END;
CREATE TRIGGER payment_batches_guard_unknown_reject BEFORE UPDATE OF status ON payment_batches
WHEN OLD.status = 'outcome_unknown' AND NEW.status = 'rejected'
BEGIN
  SELECT RAISE(ABORT, 'payment_err:not_looked_up')
  WHERE NOT EXISTS (SELECT 1 FROM payment_reconcile r
                     WHERE r.subject_kind = 'batch' AND r.subject_id = NEW.id AND r.not_found_checks >= 1);
END;
