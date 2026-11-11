-- 0013 Revolut connection (Phase 5, task R2).
--
--  (a) connections: per-connection Revolut settings and the webhook subscription, all ADD COLUMN
--      (no rebuild: constant defaults only). Tokens reuse access_token_enc / refresh_token_enc /
--      expires_at / last_error / status exactly like Exact. `creates_bank_entries` already exists
--      (default 0 since 0012); Phase 5 sets it explicitly at connect time and records WHEN the
--      admin decided in bank_entries_decided_at (NULL = never decided, later phases must not book).
--      The Revolut client id is configuration (Workers var), not per connection.
--  (b) bank_accounts: columns for Revolut accounts (state, bic, is_active, created/updated). IBAN
--      stays full here and must never be logged.
--  (c) bank_transactions is REBUILT (review S11): the unique key becomes (connection_id,
--      external_id, leg_id) because one Revolut transaction (a transfer between own accounts, an
--      exchange) has several legs that share the transaction id. The state CHECK also allows
--      'unknown' (a state we do not recognise is stored, never dropped), and ingestion metadata
--      is added. `is_final` is derived from state (generated column), so it can never disagree.
--      Existing rows keep every value; their new created_at is booked_at (the bank-side time
--      best known) and first_seen_at is the old row creation time.
--      match_suggestions (ON DELETE CASCADE) and matches reference bank_transactions. DROP TABLE
--      runs an implicit DELETE that fires foreign key ACTIONS (defer_foreign_keys only defers
--      violations, not cascades), so both children are copied aside, dropped, and recreated with
--      their rows after the parent (same definitions and indexes as 0003).
--  (d) webhook_events: idempotency and audit of received webhooks WITHOUT bodies (SHA-256 of the
--      body and ids only).

-- (a) -------------------------------------------------------------------------------------------
ALTER TABLE connections ADD COLUMN revolut_environment TEXT
  CHECK (revolut_environment IS NULL OR revolut_environment IN ('production', 'sandbox'));
ALTER TABLE connections ADD COLUMN payments_mode TEXT NOT NULL DEFAULT 'drafts'
  CHECK (payments_mode IN ('drafts', 'pay'));
ALTER TABLE connections ADD COLUMN bank_entries_decided_at TEXT;
ALTER TABLE connections ADD COLUMN webhook_id TEXT;
-- AES-GCM ciphertext (crypto/token-crypto.ts), AAD revolut:<connection id>:webhook_secret[_prev].
ALTER TABLE connections ADD COLUMN webhook_secret_enc TEXT;
ALTER TABLE connections ADD COLUMN webhook_secret_prev_enc TEXT;
-- Staged (not yet confirmed) Revolut connection, review R2: the callback stores new tokens as
-- status 'pending' with these, and an admin must confirm what was connected before the app uses
-- it. pending_until: staging expiry (UTC ISO); after it the tokens are wiped. pending_ref: random
-- id the confirm request must echo (binds the confirmation to the summary the admin saw).
-- pending_summary: JSON of masked facts only (account names, currencies, last 4 of IBANs).
ALTER TABLE connections ADD COLUMN pending_until TEXT;
ALTER TABLE connections ADD COLUMN pending_ref TEXT;
ALTER TABLE connections ADD COLUMN pending_by TEXT;
ALTER TABLE connections ADD COLUMN pending_summary TEXT;

-- (b) -------------------------------------------------------------------------------------------
ALTER TABLE bank_accounts ADD COLUMN bic TEXT;
ALTER TABLE bank_accounts ADD COLUMN state TEXT;
ALTER TABLE bank_accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1
  CHECK (is_active IN (0, 1));
ALTER TABLE bank_accounts ADD COLUMN created_at TEXT;
ALTER TABLE bank_accounts ADD COLUMN updated_at TEXT;

-- (c) -------------------------------------------------------------------------------------------
PRAGMA defer_foreign_keys = true;

CREATE TABLE bank_transactions_0013_copy AS SELECT * FROM bank_transactions;
CREATE TABLE match_suggestions_0013_copy AS SELECT * FROM match_suggestions;
CREATE TABLE matches_0013_copy AS SELECT * FROM matches;

DROP TABLE match_suggestions;
DROP TABLE matches;
DROP TABLE bank_transactions;

CREATE TABLE bank_transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id       INTEGER NOT NULL REFERENCES connections (id),
  bank_account_id     INTEGER NOT NULL REFERENCES bank_accounts (id),
  external_id         TEXT NOT NULL,
  -- Revolut leg id; '' for a transaction without legs we track. Part of the unique key.
  leg_id              TEXT NOT NULL DEFAULT '',
  type                TEXT,
  request_id          TEXT,
  -- Revolut transaction state; only final states (completed/failed/reverted/declined) are booked.
  state               TEXT NOT NULL
                      CHECK (state IN ('created', 'pending', 'completed', 'declined', 'failed', 'reverted', 'unknown')),
  is_final            INTEGER GENERATED ALWAYS AS
                      (CASE WHEN state IN ('completed', 'declined', 'failed', 'reverted') THEN 1 ELSE 0 END) STORED,
  -- Signed minor units of the leg (negative = money out).
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  counterparty_name   TEXT,
  -- Full IBAN: never logged, masked in audit rows.
  counterparty_iban   TEXT,
  reference           TEXT,
  booked_at           TEXT NOT NULL,
  -- Bank-side timestamps (UTC ISO-8601).
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT,
  completed_at        TEXT,
  raw_state_changed_at TEXT,
  exact_entry_id      TEXT,
  match_status        TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched', 'suggested', 'matched', 'ignored')),
  -- Ingestion metadata.
  first_seen_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_event_at       TEXT,
  source              TEXT NOT NULL DEFAULT 'poll' CHECK (source IN ('webhook', 'poll', 'backfill')),
  UNIQUE (connection_id, external_id, leg_id)
);

INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, state, amount_minor,
                               currency, counterparty_name, counterparty_iban, reference, booked_at,
                               created_at, exact_entry_id, match_status, first_seen_at)
  SELECT id, connection_id, bank_account_id, external_id, state, amount_minor, currency,
         counterparty_name, counterparty_iban, reference, booked_at, booked_at, exact_entry_id,
         match_status, created_at
  FROM bank_transactions_0013_copy;

CREATE INDEX idx_bank_tx_account_date ON bank_transactions (bank_account_id, booked_at);
CREATE INDEX idx_bank_tx_match ON bank_transactions (match_status);
CREATE INDEX idx_bank_tx_conn_state ON bank_transactions (connection_id, state, created_at);
CREATE INDEX idx_bank_tx_cp_iban ON bank_transactions (counterparty_iban)
  WHERE counterparty_iban IS NOT NULL;
CREATE INDEX idx_bank_tx_request ON bank_transactions (connection_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE TABLE match_suggestions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
  open_item_id        INTEGER REFERENCES open_items (id) ON DELETE CASCADE,
  ledger_account      TEXT,
  score               INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  reason              TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (open_item_id IS NOT NULL OR ledger_account IS NOT NULL)
);
INSERT INTO match_suggestions (id, bank_transaction_id, open_item_id, ledger_account, score, reason, created_at)
  SELECT id, bank_transaction_id, open_item_id, ledger_account, score, reason, created_at
  FROM match_suggestions_0013_copy;
CREATE INDEX idx_suggestions_tx ON match_suggestions (bank_transaction_id, score DESC);

CREATE TABLE matches (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id),
  open_item_id        INTEGER REFERENCES open_items (id),
  ledger_account      TEXT,
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  mode                TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
  score               INTEGER,
  exact_matchset_id   TEXT,
  matched_by          TEXT NOT NULL,
  matched_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  undone_at           TEXT,
  undone_by           TEXT,
  CHECK (open_item_id IS NOT NULL OR ledger_account IS NOT NULL)
);
INSERT INTO matches (id, bank_transaction_id, open_item_id, ledger_account, amount_minor, currency,
                     mode, score, exact_matchset_id, matched_by, matched_at, undone_at, undone_by)
  SELECT id, bank_transaction_id, open_item_id, ledger_account, amount_minor, currency, mode, score,
         exact_matchset_id, matched_by, matched_at, undone_at, undone_by
  FROM matches_0013_copy;
CREATE INDEX idx_matches_tx ON matches (bank_transaction_id);
-- No double booking: one live match per (bank line, open item).
CREATE UNIQUE INDEX idx_matches_live ON matches (bank_transaction_id, open_item_id)
  WHERE undone_at IS NULL AND open_item_id IS NOT NULL;
CREATE INDEX idx_matches_item ON matches (open_item_id);

DROP TABLE bank_transactions_0013_copy;
DROP TABLE match_suggestions_0013_copy;
DROP TABLE matches_0013_copy;

-- (d) -------------------------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES connections (id),
  -- SHA-256 (hex) of the raw request body; the body itself is never stored.
  event_hash    TEXT NOT NULL CHECK (length(event_hash) = 64),
  event_type    TEXT NOT NULL,
  external_id   TEXT,
  received_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processed', 'ignored', 'error')),
  -- Short machine code, never a provider message.
  error_code    TEXT,
  processed_at  TEXT,
  UNIQUE (connection_id, event_hash)
);
CREATE INDEX idx_webhook_events_status ON webhook_events (status, received_at);
