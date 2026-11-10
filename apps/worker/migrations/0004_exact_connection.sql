-- 0004 Exact connection: encrypted OAuth tokens on `connections`, plus a daily usage summary.
-- Tokens are AES-GCM ciphertext (apps/worker/src/crypto/token-crypto.ts), never plaintext.
--
-- SQLite cannot change a CHECK constraint, so `connections` is rebuilt to allow status
-- 'needs_reauth'. divisions, bank_accounts and bank_transactions reference it (no ON DELETE
-- actions, no indexes or triggers on connections). D1 cannot turn foreign keys off, so:
--   1. copy the rows aside, 2. drop the table (with defer_foreign_keys the implicit delete only
--   counts deferred violations instead of failing), 3. create the new table under the SAME name,
--   4. insert the rows back: each insert into the parent resolves its children's violations, so the
--   counter is zero again at commit. Building `connections_new` and renaming it does NOT work: the
--   rows go into a table no child references yet, the counter never goes down and the commit fails
--   with FOREIGN KEY constraint failed (test/migration-0004.test.ts).
-- The AUTOINCREMENT sequence restarts at the highest kept id; Phase 1 never deleted connections.

PRAGMA defer_foreign_keys = true;

CREATE TABLE connections_0004_copy AS SELECT * FROM connections;

DROP TABLE connections;

CREATE TABLE connections (
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

INSERT INTO connections (id, kind, name, status, token_ref, expires_at, creates_bank_entries, created_at)
  SELECT id, kind, name, status, token_ref, expires_at, creates_bank_entries, created_at
  FROM connections_0004_copy;

DROP TABLE connections_0004_copy;

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
