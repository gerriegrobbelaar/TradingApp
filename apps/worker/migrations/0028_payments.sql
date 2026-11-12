-- 0028 payments: requests, batches, approvals, supplier IBAN verification, events, claims
-- (Phase 9, P9a, ADR 0049). NOTHING IN THIS MIGRATION SENDS MONEY: it is the record of requests and
-- the database's own enforcement of the rules. The Revolut payment endpoints stay unreachable from the
-- gate (apps/worker/src/revolut/request.ts allow-list) until P9b.
--
-- `payments` and `payment_batches` existed since 0003 as an unused skeleton (no code ever wrote them).
-- They are rebuilt here; the migration FAILS (CHECK n = 0) if either holds a row, so a populated
-- table is never dropped silently. The skeleton `approvals` table (0003) is a different thing in the
-- data model (generic subject approvals); ours is `payment_approvals`, bound to a payload hash, and
-- the old table is left untouched and unused.
--
-- Rules enforced by triggers (names are pinned by test/fixtures/trigger-hashes.json):
--   * states only move forward; a final state is final; rows are never deleted
--   * request_id, the payload hash and everything it covers never change after insert
--   * leaving 'draft' needs a recorded confirmation
--   * pending_approval -> ready needs an approval by somebody else, for this payload, by a person
--     who STILL holds the approver role and is not disabled
--   * ready -> submitting needs the payments switch ON, an unreleased claim and (when needed) the same approval
--   * an approval row is append-only, requester <> approver (also by CHECK), approver holds the role
--   * events and IBAN verifications are append-only
-- Time (24 h validity, 15 minute sign-in) is checked in the application against the request's clock,
-- inside the same batch as the write, because triggers cannot be tested against a frozen clock.

CREATE TABLE p9a_guard (n INTEGER NOT NULL CHECK (n = 0));
INSERT INTO p9a_guard (n)
  SELECT (SELECT count(*) FROM payments) + (SELECT count(*) FROM payment_batches);
DROP TABLE p9a_guard;
DROP TABLE payments;
DROP TABLE payment_batches;


CREATE TABLE payment_batches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id         TEXT NOT NULL UNIQUE CHECK (length(request_id) = 36 AND request_id NOT GLOB '*[^0-9a-f-]*'
                AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
                AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
                AND substr(request_id, 15, 1) = '4' AND substr(request_id, 20, 1) IN ('8', '9', 'a', 'b')),
  division_id        INTEGER NOT NULL REFERENCES divisions (id),
  bank_account_id    INTEGER NOT NULL REFERENCES bank_accounts (id),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'ready', 'submitting', 'submitted', 'outcome_unknown', 'paid', 'failed', 'rejected', 'cancelled', 'expired')),
  status_reason      TEXT,
  mode               TEXT NOT NULL CHECK (mode IN ('drafts', 'pay')),
  currency           TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  total_minor        INTEGER NOT NULL CHECK (total_minor > 0 AND total_minor <= 9007199254740991),
  item_count         INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 50),
  eur_minor          INTEGER CHECK (eur_minor IS NULL OR (eur_minor >= 0 AND eur_minor <= 9007199254740991)),
  payload_hash       TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  approvals_required TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(approvals_required) AND json_type(approvals_required) = 'array'),
  requested_by       TEXT NOT NULL CHECK (requested_by = lower(requested_by) AND length(requested_by) > 0),
  requester_auth_at  TEXT,
  confirmed_at       TEXT,
  client_key         TEXT CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 100),
  expires_at         TEXT NOT NULL,
  submit_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (submit_attempts >= 0),
  provider_id        TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT,
  UNIQUE (requested_by, client_key)
);
CREATE INDEX idx_payment_batches_status ON payment_batches (status, created_at);

CREATE TABLE payments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id         TEXT NOT NULL UNIQUE CHECK (length(request_id) = 36 AND request_id NOT GLOB '*[^0-9a-f-]*'
                AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
                AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
                AND substr(request_id, 15, 1) = '4' AND substr(request_id, 20, 1) IN ('8', '9', 'a', 'b')),
  division_id        INTEGER NOT NULL REFERENCES divisions (id),
  open_item_id       INTEGER NOT NULL REFERENCES open_items (id),
  batch_id           INTEGER REFERENCES payment_batches (id),
  bank_account_id    INTEGER NOT NULL REFERENCES bank_accounts (id),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'ready', 'submitting', 'submitted', 'outcome_unknown', 'paid', 'failed', 'rejected', 'cancelled', 'expired')),
  status_reason      TEXT,
  mode               TEXT NOT NULL CHECK (mode IN ('drafts', 'pay')),
  amount_minor       INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency           TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  eur_minor          INTEGER CHECK (eur_minor IS NULL OR (eur_minor >= 0 AND eur_minor <= 9007199254740991)),
  eur_rate           TEXT,
  beneficiary_name   TEXT NOT NULL,
  -- The full IBAN is needed to pay and is never returned or logged; the fingerprint is the identity
  -- used in payloads, audit rows and answers.
  beneficiary_iban   TEXT NOT NULL CHECK (beneficiary_iban = upper(beneficiary_iban) AND beneficiary_iban NOT GLOB '*[^A-Z0-9]*' AND length(beneficiary_iban) BETWEEN 5 AND 34),
  iban_fingerprint   TEXT NOT NULL CHECK (length(iban_fingerprint) = 64 AND iban_fingerprint NOT GLOB '*[^0-9a-f]*'),
  reference          TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 140),
  payload_hash       TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  approvals_required TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(approvals_required) AND json_type(approvals_required) = 'array'),
  requested_by       TEXT NOT NULL CHECK (requested_by = lower(requested_by) AND length(requested_by) > 0),
  requester_auth_at  TEXT,
  confirmed_at       TEXT,
  client_key         TEXT CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 100),
  expires_at         TEXT NOT NULL,
  submit_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (submit_attempts >= 0),
  provider_id        TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT,
  UNIQUE (requested_by, client_key)
);
CREATE INDEX idx_payments_item ON payments (open_item_id);
CREATE INDEX idx_payments_status ON payments (status, created_at);
CREATE INDEX idx_payments_batch ON payments (batch_id);
CREATE INDEX idx_payments_fingerprint ON payments (iban_fingerprint, status);
-- At most one open request per invoice: no second request while one is in flight.
CREATE UNIQUE INDEX idx_payments_in_flight ON payments (open_item_id)
  WHERE status IN ('draft', 'pending_approval', 'ready', 'submitting', 'submitted', 'outcome_unknown');

-- Four-eyes decisions. One row per subject, ever (a decision is final; a new request is a new subject).
CREATE TABLE payment_approvals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id       INTEGER REFERENCES payments (id),
  batch_id         INTEGER REFERENCES payment_batches (id),
  decision         TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  payload_hash     TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  requested_by     TEXT NOT NULL CHECK (requested_by = lower(requested_by)),
  decided_by       TEXT NOT NULL CHECK (decided_by = lower(decided_by) AND length(decided_by) > 0),
  approver_auth_at TEXT NOT NULL,
  note             TEXT,
  decided_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((payment_id IS NULL) <> (batch_id IS NULL)),
  -- An approver can never approve (or reject) their own request.
  CHECK (decided_by <> requested_by)
);
CREATE UNIQUE INDEX idx_payment_approvals_payment ON payment_approvals (payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX idx_payment_approvals_batch ON payment_approvals (batch_id) WHERE batch_id IS NOT NULL;

-- A supplier's IBAN counts as verified only through a row here: the fingerprint of the exact IBAN an
-- approver confirmed. The latest row of a relation decides ('revoked' undoes a verification). Exact
-- changing the IBAN changes the fingerprint, which no longer equals the verified one.
CREATE TABLE supplier_iban_verifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id      INTEGER NOT NULL REFERENCES divisions (id),
  relation_id      INTEGER NOT NULL REFERENCES relations (id),
  iban_fingerprint TEXT NOT NULL CHECK (length(iban_fingerprint) = 64 AND iban_fingerprint NOT GLOB '*[^0-9a-f]*'),
  kind             TEXT NOT NULL CHECK (kind IN ('verified', 'revoked')),
  verified_by      TEXT NOT NULL CHECK (verified_by = lower(verified_by) AND length(verified_by) > 0),
  note             TEXT,
  verified_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_supplier_iban_verifications ON supplier_iban_verifications (relation_id, id);

-- Append-only record of every state change (the audit_log row of the same batch says who and why).
CREATE TABLE payment_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  INTEGER REFERENCES payments (id),
  batch_id    INTEGER REFERENCES payment_batches (id),
  from_status TEXT,
  to_status   TEXT NOT NULL CHECK (to_status IN ('draft', 'pending_approval', 'ready', 'submitting', 'submitted', 'outcome_unknown', 'paid', 'failed', 'rejected', 'cancelled', 'expired')),
  code        TEXT,
  actor       TEXT NOT NULL,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((payment_id IS NULL) <> (batch_id IS NULL))
);
CREATE INDEX idx_payment_events_payment ON payment_events (payment_id, id);
CREATE INDEX idx_payment_events_batch ON payment_events (batch_id, id);

-- Single-writer claim taken BEFORE any call to the bank, with a lease. Released only for a call that
-- provably did not happen; never deleted. An expired lease is NOT a licence to call again: the
-- request becomes outcome_unknown and is reconciled by request_id (P9b).
CREATE TABLE payment_claims (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id     INTEGER REFERENCES payments (id),
  batch_id       INTEGER REFERENCES payment_batches (id),
  owner          TEXT NOT NULL,
  claimed_at     TEXT NOT NULL,
  lease_until    TEXT NOT NULL,
  released_at    TEXT,
  release_reason TEXT,
  CHECK ((payment_id IS NULL) <> (batch_id IS NULL))
);
CREATE UNIQUE INDEX idx_payment_claims_payment ON payment_claims (payment_id) WHERE payment_id IS NOT NULL AND released_at IS NULL;
CREATE UNIQUE INDEX idx_payment_claims_batch ON payment_claims (batch_id) WHERE batch_id IS NOT NULL AND released_at IS NULL;


-- ---- payments: guards --------------------------------------------------------------------------------
CREATE TRIGGER payments_guard_status BEFORE UPDATE OF status ON payments
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'payment_err:bad_transition')
  WHERE NOT (
    (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'ready', 'cancelled', 'expired'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('ready', 'rejected', 'cancelled', 'expired'))
    OR (OLD.status = 'ready' AND NEW.status IN ('submitting', 'cancelled', 'expired'))
    OR (OLD.status = 'submitting' AND NEW.status IN ('submitted', 'rejected', 'outcome_unknown'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('paid', 'failed'))
    OR (OLD.status = 'outcome_unknown' AND NEW.status IN ('submitted', 'paid', 'failed', 'rejected')));
END;

CREATE TRIGGER payments_guard_request_id BEFORE UPDATE OF request_id ON payments
WHEN NEW.request_id IS NOT OLD.request_id
BEGIN
  SELECT RAISE(ABORT, 'payment_err:request_id_immutable');
END;

CREATE TRIGGER payments_guard_payload BEFORE UPDATE ON payments
WHEN NEW.payload_hash IS NOT OLD.payload_hash
     OR NEW.amount_minor IS NOT OLD.amount_minor
     OR NEW.currency IS NOT OLD.currency
     OR NEW.beneficiary_iban IS NOT OLD.beneficiary_iban
     OR NEW.iban_fingerprint IS NOT OLD.iban_fingerprint
     OR NEW.beneficiary_name IS NOT OLD.beneficiary_name
     OR NEW.reference IS NOT OLD.reference
     OR NEW.bank_account_id IS NOT OLD.bank_account_id
     OR NEW.open_item_id IS NOT OLD.open_item_id
     OR NEW.division_id IS NOT OLD.division_id
     OR NEW.mode IS NOT OLD.mode
     OR NEW.requested_by IS NOT OLD.requested_by
     OR NEW.batch_id IS NOT OLD.batch_id
     OR NEW.eur_minor IS NOT OLD.eur_minor
     OR NEW.eur_rate IS NOT OLD.eur_rate
     OR NEW.approvals_required IS NOT OLD.approvals_required
     OR NEW.expires_at IS NOT OLD.expires_at
     OR NEW.created_at IS NOT OLD.created_at
     OR NEW.client_key IS NOT OLD.client_key
BEGIN
  SELECT RAISE(ABORT, 'payment_err:payload_immutable');
END;

CREATE TRIGGER payments_guard_final BEFORE UPDATE ON payments
WHEN OLD.status IN ('paid', 'failed', 'rejected', 'cancelled', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'payment_err:final');
END;

CREATE TRIGGER payments_guard_no_delete BEFORE DELETE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payment_err:no_delete');
END;

-- Leaving 'draft' for approval or ready needs a recorded confirmation (who, when, fresh sign-in),
-- and 'ready' straight from 'draft' only when no second person is required.
CREATE TRIGGER payments_guard_confirm BEFORE UPDATE OF status ON payments
WHEN OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'ready') AND NEW.batch_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'payment_err:not_confirmed')
  WHERE NEW.confirmed_at IS NULL OR NEW.requester_auth_at IS NULL;
  SELECT RAISE(ABORT, 'payment_err:approval_required')
  WHERE NEW.status = 'ready' AND NEW.approvals_required <> '[]';
  SELECT RAISE(ABORT, 'payment_err:bad_transition')
  WHERE NEW.status = 'pending_approval' AND NEW.approvals_required = '[]';
END;

-- pending_approval -> ready only with an approval of someone other than the requester, for this
-- exact payload, by a person who still holds the approver role (four-eyes at the database).
CREATE TRIGGER payments_guard_approved BEFORE UPDATE OF status ON payments
WHEN OLD.status = 'pending_approval' AND NEW.status = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'payment_err:not_approved')
  WHERE NOT (NEW.batch_id IS NOT NULL OR EXISTS (SELECT 1 FROM payment_approvals a
                  JOIN users u ON u.email = a.decided_by
                  JOIN user_roles r ON r.user_id = u.id AND r.role = 'approver'
                 WHERE a.payment_id = NEW.id AND a.decision = 'approved'
                   AND a.payload_hash = NEW.payload_hash
                   AND a.decided_by <> lower(NEW.requested_by)
                   AND u.disabled_at IS NULL));
END;

-- ready -> submitting: the switch is on, a single-writer claim exists, and an approval that was
-- needed is still good (role not removed, payload unchanged).
CREATE TRIGGER payments_guard_submitting BEFORE UPDATE OF status ON payments
WHEN OLD.status = 'ready' AND NEW.status = 'submitting'
BEGIN
  SELECT RAISE(ABORT, 'payment_err:payments_disabled')
  WHERE NOT COALESCE((SELECT value_json FROM settings WHERE key = 'payments.enabled') = 'true', 0);
  SELECT RAISE(ABORT, 'payment_err:no_claim')
  WHERE NOT EXISTS (SELECT 1 FROM payment_claims c WHERE (c.payment_id = NEW.id OR c.batch_id = NEW.batch_id) AND c.released_at IS NULL);
  SELECT RAISE(ABORT, 'payment_err:not_approved')
  WHERE NEW.approvals_required <> '[]' AND NOT (NEW.batch_id IS NOT NULL OR EXISTS (SELECT 1 FROM payment_approvals a
                  JOIN users u ON u.email = a.decided_by
                  JOIN user_roles r ON r.user_id = u.id AND r.role = 'approver'
                 WHERE a.payment_id = NEW.id AND a.decision = 'approved'
                   AND a.payload_hash = NEW.payload_hash
                   AND a.decided_by <> lower(NEW.requested_by)
                   AND u.disabled_at IS NULL));
END;


-- ---- payment_batches: guards --------------------------------------------------------------------------------
CREATE TRIGGER payment_batches_guard_status BEFORE UPDATE OF status ON payment_batches
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'payment_err:bad_transition')
  WHERE NOT (
    (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'ready', 'cancelled', 'expired'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('ready', 'rejected', 'cancelled', 'expired'))
    OR (OLD.status = 'ready' AND NEW.status IN ('submitting', 'cancelled', 'expired'))
    OR (OLD.status = 'submitting' AND NEW.status IN ('submitted', 'rejected', 'outcome_unknown'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('paid', 'failed'))
    OR (OLD.status = 'outcome_unknown' AND NEW.status IN ('submitted', 'paid', 'failed', 'rejected')));
END;

CREATE TRIGGER payment_batches_guard_request_id BEFORE UPDATE OF request_id ON payment_batches
WHEN NEW.request_id IS NOT OLD.request_id
BEGIN
  SELECT RAISE(ABORT, 'payment_err:request_id_immutable');
END;

CREATE TRIGGER payment_batches_guard_payload BEFORE UPDATE ON payment_batches
WHEN NEW.payload_hash IS NOT OLD.payload_hash
     OR NEW.total_minor IS NOT OLD.total_minor
     OR NEW.currency IS NOT OLD.currency
     OR NEW.item_count IS NOT OLD.item_count
     OR NEW.bank_account_id IS NOT OLD.bank_account_id
     OR NEW.division_id IS NOT OLD.division_id
     OR NEW.mode IS NOT OLD.mode
     OR NEW.requested_by IS NOT OLD.requested_by
     OR NEW.eur_minor IS NOT OLD.eur_minor
     OR NEW.approvals_required IS NOT OLD.approvals_required
     OR NEW.expires_at IS NOT OLD.expires_at
     OR NEW.created_at IS NOT OLD.created_at
     OR NEW.client_key IS NOT OLD.client_key
BEGIN
  SELECT RAISE(ABORT, 'payment_err:payload_immutable');
END;

CREATE TRIGGER payment_batches_guard_final BEFORE UPDATE ON payment_batches
WHEN OLD.status IN ('paid', 'failed', 'rejected', 'cancelled', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'payment_err:final');
END;

CREATE TRIGGER payment_batches_guard_no_delete BEFORE DELETE ON payment_batches
BEGIN
  SELECT RAISE(ABORT, 'payment_err:no_delete');
END;

-- Leaving 'draft' for approval or ready needs a recorded confirmation (who, when, fresh sign-in),
-- and 'ready' straight from 'draft' only when no second person is required.
CREATE TRIGGER payment_batches_guard_confirm BEFORE UPDATE OF status ON payment_batches
WHEN OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'ready')
BEGIN
  SELECT RAISE(ABORT, 'payment_err:not_confirmed')
  WHERE NEW.confirmed_at IS NULL OR NEW.requester_auth_at IS NULL;
  SELECT RAISE(ABORT, 'payment_err:approval_required')
  WHERE NEW.status = 'ready' AND NEW.approvals_required <> '[]';
  SELECT RAISE(ABORT, 'payment_err:bad_transition')
  WHERE NEW.status = 'pending_approval' AND NEW.approvals_required = '[]';
END;

-- pending_approval -> ready only with an approval of someone other than the requester, for this
-- exact payload, by a person who still holds the approver role (four-eyes at the database).
CREATE TRIGGER payment_batches_guard_approved BEFORE UPDATE OF status ON payment_batches
WHEN OLD.status = 'pending_approval' AND NEW.status = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'payment_err:not_approved')
  WHERE NOT EXISTS (SELECT 1 FROM payment_approvals a
                  JOIN users u ON u.email = a.decided_by
                  JOIN user_roles r ON r.user_id = u.id AND r.role = 'approver'
                 WHERE a.batch_id = NEW.id AND a.decision = 'approved'
                   AND a.payload_hash = NEW.payload_hash
                   AND a.decided_by <> lower(NEW.requested_by)
                   AND u.disabled_at IS NULL);
END;

-- ready -> submitting: the switch is on, a single-writer claim exists, and an approval that was
-- needed is still good (role not removed, payload unchanged).
CREATE TRIGGER payment_batches_guard_submitting BEFORE UPDATE OF status ON payment_batches
WHEN OLD.status = 'ready' AND NEW.status = 'submitting'
BEGIN
  SELECT RAISE(ABORT, 'payment_err:payments_disabled')
  WHERE NOT COALESCE((SELECT value_json FROM settings WHERE key = 'payments.enabled') = 'true', 0);
  SELECT RAISE(ABORT, 'payment_err:no_claim')
  WHERE NOT EXISTS (SELECT 1 FROM payment_claims c WHERE c.batch_id = NEW.id AND c.released_at IS NULL);
  SELECT RAISE(ABORT, 'payment_err:not_approved')
  WHERE NEW.approvals_required <> '[]' AND NOT EXISTS (SELECT 1 FROM payment_approvals a
                  JOIN users u ON u.email = a.decided_by
                  JOIN user_roles r ON r.user_id = u.id AND r.role = 'approver'
                 WHERE a.batch_id = NEW.id AND a.decision = 'approved'
                   AND a.payload_hash = NEW.payload_hash
                   AND a.decided_by <> lower(NEW.requested_by)
                   AND u.disabled_at IS NULL);
END;


-- ---- inserts ---------------------------------------------------------------------------------------
CREATE TRIGGER payment_batches_guard_insert BEFORE INSERT ON payment_batches
BEGIN
  SELECT RAISE(ABORT, 'payment_err:bad_insert')
  WHERE NEW.status <> 'draft' OR NEW.submit_attempts <> 0 OR NEW.provider_id IS NOT NULL
     OR NEW.confirmed_at IS NOT NULL OR NEW.requester_auth_at IS NOT NULL;
  SELECT RAISE(ABORT, 'payment_err:payments_disabled')
  WHERE NOT COALESCE((SELECT value_json FROM settings WHERE key = 'payments.enabled') = 'true', 0);
END;

CREATE TRIGGER payments_guard_insert BEFORE INSERT ON payments
BEGIN
  SELECT RAISE(ABORT, 'payment_err:bad_insert')
  WHERE NEW.status <> 'draft' OR NEW.submit_attempts <> 0 OR NEW.provider_id IS NOT NULL
     OR NEW.confirmed_at IS NOT NULL OR NEW.requester_auth_at IS NOT NULL;
  SELECT RAISE(ABORT, 'payment_err:payments_disabled')
  WHERE NOT COALESCE((SELECT value_json FROM settings WHERE key = 'payments.enabled') = 'true', 0);
  -- The payable must exist, be a bill and match division and currency; the source account must be
  -- in the same currency.
  SELECT RAISE(ABORT, 'payment_err:bad_insert')
  WHERE NOT EXISTS (SELECT 1 FROM open_items oi
                     WHERE oi.id = NEW.open_item_id AND oi.kind = 'bill' AND oi.division_id = NEW.division_id
                       AND oi.currency = NEW.currency AND oi.open_minor >= NEW.amount_minor);
  SELECT RAISE(ABORT, 'payment_err:bad_insert')
  WHERE NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.id = NEW.bank_account_id AND b.currency = NEW.currency);
  -- A batch item joins a batch that is still a draft with the same account, currency, mode and requester.
  SELECT RAISE(ABORT, 'payment_err:bad_insert')
  WHERE NEW.batch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_batches b
     WHERE b.id = NEW.batch_id AND b.status = 'draft' AND b.bank_account_id = NEW.bank_account_id
       AND b.currency = NEW.currency AND b.mode = NEW.mode AND b.requested_by = NEW.requested_by
       AND b.division_id = NEW.division_id);
END;

-- A batch item follows its batch: before the bank has answered it only moves WITH the batch; the
-- bank's answers (paid, failed) arrive per item once the batch was submitted.
CREATE TRIGGER payments_guard_batch_item BEFORE UPDATE OF status ON payments
WHEN NEW.batch_id IS NOT NULL AND NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'payment_err:batch_item')
  WHERE NOT (
       (NEW.status IN ('pending_approval', 'ready', 'submitting', 'submitted', 'outcome_unknown', 'rejected', 'cancelled', 'expired')
        AND (SELECT b.status FROM payment_batches b WHERE b.id = NEW.batch_id) = NEW.status)
    OR (NEW.status IN ('paid', 'failed')
        AND (SELECT b.status FROM payment_batches b WHERE b.id = NEW.batch_id)
            IN ('submitted', 'outcome_unknown', 'paid', 'failed')));
END;

-- ---- approvals -------------------------------------------------------------------------------------
CREATE TRIGGER payment_approvals_guard_insert BEFORE INSERT ON payment_approvals
BEGIN
  -- the subject is waiting, the hash is the one stored, the requester is the stored requester
  SELECT RAISE(ABORT, 'payment_err:approval_subject')
  WHERE NOT (
    (NEW.payment_id IS NOT NULL AND EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id
        AND p.status = 'pending_approval' AND p.batch_id IS NULL AND p.payload_hash = NEW.payload_hash
        AND p.requested_by = NEW.requested_by))
    OR (NEW.batch_id IS NOT NULL AND EXISTS (SELECT 1 FROM payment_batches b WHERE b.id = NEW.batch_id
        AND b.status = 'pending_approval' AND b.payload_hash = NEW.payload_hash
        AND b.requested_by = NEW.requested_by)));
  -- the decider holds the approver role right now and is not disabled
  SELECT RAISE(ABORT, 'payment_err:approver_role')
  WHERE NOT EXISTS (SELECT 1 FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'approver'
                     WHERE u.email = NEW.decided_by AND u.disabled_at IS NULL);
END;

CREATE TRIGGER payment_approvals_guard_update BEFORE UPDATE ON payment_approvals
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;
CREATE TRIGGER payment_approvals_guard_delete BEFORE DELETE ON payment_approvals
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;

-- ---- append-only tables ---------------------------------------------------------------------------
CREATE TRIGGER supplier_iban_verifications_guard_update BEFORE UPDATE ON supplier_iban_verifications
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;
CREATE TRIGGER supplier_iban_verifications_guard_delete BEFORE DELETE ON supplier_iban_verifications
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;
CREATE TRIGGER payment_events_guard_update BEFORE UPDATE ON payment_events
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;
CREATE TRIGGER payment_events_guard_delete BEFORE DELETE ON payment_events
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;

-- ---- claims ----------------------------------------------------------------------------------------
CREATE TRIGGER payment_claims_guard_insert BEFORE INSERT ON payment_claims
BEGIN
  SELECT RAISE(ABORT, 'payment_err:claim_subject')
  WHERE NOT (
    (NEW.payment_id IS NOT NULL AND EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id
        AND p.status = 'ready' AND p.batch_id IS NULL))
    OR (NEW.batch_id IS NOT NULL AND EXISTS (SELECT 1 FROM payment_batches b WHERE b.id = NEW.batch_id
        AND b.status = 'ready')));
END;
-- A claim keeps its facts: only the release may be written, once.
CREATE TRIGGER payment_claims_guard_update BEFORE UPDATE ON payment_claims
WHEN NEW.payment_id IS NOT OLD.payment_id OR NEW.batch_id IS NOT OLD.batch_id OR NEW.owner IS NOT OLD.owner
  OR NEW.claimed_at IS NOT OLD.claimed_at OR OLD.released_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;
CREATE TRIGGER payment_claims_guard_delete BEFORE DELETE ON payment_claims
BEGIN
  SELECT RAISE(ABORT, 'payment_err:append_only');
END;
