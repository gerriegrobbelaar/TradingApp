-- 0015 Revolut data for matching and booking, and quarantine (Phase 5 review Q1: S2, S6, S7, S9, N4).
--
--  (a) bank_transactions: what matching (Phase 7) and booking will need, all nullable (a row
--      stored before this migration is filled by the next refresh while it is still unmatched).
--      Amounts are signed minor units like amount_minor; currencies are ISO codes.
--        fee_minor / fee_currency          the leg's fee (Revolut: in the leg currency, assumed)
--        balance_minor                     the account balance after this leg
--        counterparty_ref                  Revolut counterparty id (the leg carries ids, not IBANs)
--        counterparty_account_ref          the counterparty's account id
--        counterparty_account_type         'self' | 'revolut' | 'external' as sent
--        reason_code                       why a transaction was declined / failed / reverted
--        bill_amount_minor / bill_currency the card bill amount in the merchant's currency
--        card_last4                        the last four digits ONLY (masked at parse time)
--        merchant_name                     card merchant, kept apart from counterparty_name
--      counterparty_iban_cached = 1 when counterparty_iban came from the lookup cache (c), not from
--      the leg itself: such a value follows the cache when a refresh finds a changed IBAN (only on
--      unmatched rows), a value Revolut sent on the leg never does.
--      Ingest flags (review S7, S9): skipped_legs (legs of the transaction without our account id,
--      same value on every stored leg) and state_conflict (1 = a state change was refused, or a
--      matched final row received different money data / a reversal: Phase 7/8 alert on it).
--  (b) revolut_quarantine: transactions of a page that could not be stored (review S2). IDs and a
--      fixed code only, never a payload. attempts is bounded by the sync (gave_up = 1). Bounded:
--      at most 1,000 rows per connection (least recently seen go first) and a gave_up row is
--      deleted 30 days after it was last seen (quarantine.ts pruneQuarantine, ADR 0034).
--  (c) revolut_counterparties: a bounded cache of GET /counterparty/{id} so a leg that carries only
--      a counterparty id can still get the counterparty's IBAN (review S6, ADR 0034). The IBAN is
--      stored in full, never returned by an API, never logged. accounts_json holds
--      [{"a": <counterparty account id>, "i": <IBAN>, "c": <currency>}] (at most 10). fetched_at =
--      last answer from Revolut (ok / not_found), checked_at = last attempt; attempts = failed
--      attempts since the last answer. Answers are refreshed after 7 days (ADR 0034).
--  (d) bank_accounts: bank-details lookup bookkeeping (review N4). details_status 'ok' (IBAN
--      stored), 'no_iban' (Revolut answered and the account has none), 'error' (the lookup failed;
--      retried after 24 hours, at most 5 attempts). Accounts looked up before this migration without
--      an IBAN (bic = '') were 'error' or 'no_iban' at the time and are checked once more.
--  (e) revolut_sync_state.pending_replacement (entity 'accounts'): JSON list of the account ids
--      known before a complete accounts read that contained none of them (review N3). A second
--      such read confirms the replacement; a read that lists one of them again clears it.
--
-- Additive only (no rebuild), so a populated database migrates in place.

-- (a) -------------------------------------------------------------------------------------------
ALTER TABLE bank_transactions ADD COLUMN fee_minor INTEGER;
ALTER TABLE bank_transactions ADD COLUMN fee_currency TEXT;
ALTER TABLE bank_transactions ADD COLUMN balance_minor INTEGER;
ALTER TABLE bank_transactions ADD COLUMN counterparty_ref TEXT;
ALTER TABLE bank_transactions ADD COLUMN counterparty_account_ref TEXT;
ALTER TABLE bank_transactions ADD COLUMN counterparty_account_type TEXT;
ALTER TABLE bank_transactions ADD COLUMN reason_code TEXT;
ALTER TABLE bank_transactions ADD COLUMN bill_amount_minor INTEGER;
ALTER TABLE bank_transactions ADD COLUMN bill_currency TEXT;
ALTER TABLE bank_transactions ADD COLUMN card_last4 TEXT
  CHECK (card_last4 IS NULL OR (length(card_last4) = 4 AND card_last4 NOT GLOB '*[^0-9]*'));
ALTER TABLE bank_transactions ADD COLUMN merchant_name TEXT;
ALTER TABLE bank_transactions ADD COLUMN counterparty_iban_cached INTEGER NOT NULL DEFAULT 0
  CHECK (counterparty_iban_cached IN (0, 1));
ALTER TABLE bank_transactions ADD COLUMN skipped_legs INTEGER NOT NULL DEFAULT 0
  CHECK (skipped_legs >= 0);
ALTER TABLE bank_transactions ADD COLUMN state_conflict INTEGER NOT NULL DEFAULT 0
  CHECK (state_conflict IN (0, 1));

CREATE INDEX idx_bank_tx_cp_ref ON bank_transactions (connection_id, counterparty_ref)
  WHERE counterparty_ref IS NOT NULL;
CREATE INDEX idx_bank_tx_conflict ON bank_transactions (connection_id)
  WHERE state_conflict = 1;

-- (b) -------------------------------------------------------------------------------------------
CREATE TABLE revolut_quarantine (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id  INTEGER NOT NULL REFERENCES connections (id),
  external_id    TEXT NOT NULL,
  -- Fixed lower-case code (bad_shape, bad_timestamp, bad_amount, too_many_legs, ...).
  code           TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  -- Retries (single-transaction reads) that failed again; the walk seeing the row again is not one.
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at TEXT,
  -- 1 after the attempts ran out: no more retries, still counted and reported.
  gave_up        INTEGER NOT NULL DEFAULT 0 CHECK (gave_up IN (0, 1)),
  UNIQUE (connection_id, external_id)
);

-- (c) -------------------------------------------------------------------------------------------
CREATE TABLE revolut_counterparties (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id    INTEGER NOT NULL REFERENCES connections (id),
  counterparty_ref TEXT NOT NULL,
  -- 'ok' (read), 'not_found' (Revolut has no such counterparty), 'error' (retried later, bounded).
  status           TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'error')),
  name             TEXT,
  -- Full IBAN of the preferred account (EUR first): never logged, never returned.
  iban             TEXT,
  type             TEXT,
  accounts_json    TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  fetched_at       TEXT NOT NULL,
  checked_at       TEXT NOT NULL,
  UNIQUE (connection_id, counterparty_ref)
);
CREATE INDEX idx_revolut_cp_fetched ON revolut_counterparties (connection_id, fetched_at);
CREATE INDEX idx_revolut_quarantine_seen ON revolut_quarantine (connection_id, last_seen_at);

-- (d) -------------------------------------------------------------------------------------------
ALTER TABLE bank_accounts ADD COLUMN details_status TEXT
  CHECK (details_status IS NULL OR details_status IN ('ok', 'no_iban', 'error'));
ALTER TABLE bank_accounts ADD COLUMN details_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (details_attempts >= 0);
ALTER TABLE bank_accounts ADD COLUMN details_checked_at TEXT;

UPDATE bank_accounts SET details_status = 'ok', details_attempts = 1
  WHERE iban IS NOT NULL;
UPDATE bank_accounts SET details_status = 'error', details_attempts = 1,
                         details_checked_at = COALESCE(updated_at, created_at)
  WHERE iban IS NULL AND bic = '';

-- (e) -------------------------------------------------------------------------------------------
ALTER TABLE revolut_sync_state ADD COLUMN pending_replacement TEXT;
