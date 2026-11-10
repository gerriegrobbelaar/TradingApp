-- 0004 Exact connection: encrypted OAuth tokens on `connections`, plus a daily usage summary.
-- Tokens are AES-GCM ciphertext (apps/worker/src/crypto/token-crypto.ts), never plaintext.
-- SQLite cannot change a CHECK constraint, so `connections` is rebuilt to allow status
-- 'needs_reauth'. Child tables keep referencing it by name; no data exists yet in a fresh deploy
-- and existing rows are copied over.

PRAGMA defer_foreign_keys = true;

CREATE TABLE connections_new (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT NOT NULL CHECK (kind IN ('exact', 'revolut')),
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'expired', 'disabled', 'needs_reauth')),
  token_ref            TEXT,
  expires_at           TEXT,
  creates_bank_entries INTEGER NOT NULL DEFAULT 1 CHECK (creates_bank_entries IN (0, 1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Exact: encrypted access/refresh token (format v1.<keyid>.<iv>.<ciphertext>), access expiry in expires_at.
  access_token_enc     TEXT,
  refresh_token_enc    TEXT,
  region_host          TEXT NOT NULL DEFAULT 'start.exactonline.nl',
  -- Short machine code (for example invalid_grant), never a provider message.
  last_error           TEXT,
  connected_by         TEXT,
  connected_at         TEXT,
  updated_at           TEXT,
  UNIQUE (kind, name)
);

INSERT INTO connections_new (id, kind, name, status, token_ref, expires_at, creates_bank_entries, created_at)
  SELECT id, kind, name, status, token_ref, expires_at, creates_bank_entries, created_at FROM connections;

DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;

-- One row per Exact division and UTC day, written by ExactGate (hot counters live in the DO).
CREATE TABLE exact_usage (
  division     INTEGER NOT NULL,
  day          TEXT NOT NULL,
  calls        INTEGER NOT NULL DEFAULT 0,
  user_calls   INTEGER NOT NULL DEFAULT 0,
  job_calls    INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  -- Last X-RateLimit-Remaining Exact reported for the day (null if never seen).
  remaining    INTEGER,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (division, day)
);
