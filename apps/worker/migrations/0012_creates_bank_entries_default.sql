-- 0012 connections.creates_bank_entries: the default for NEW rows becomes 0 (review S11).
--
-- The column says whether OUR app creates bank entries in Exact (1) or Revolut's own Exact
-- integration already imports the bank lines and we only match (0, CLAUDE.md 3, open decision 2).
-- A default of 1 would silently create duplicate bank entries if Phase 5 forgot to set it, so a
-- new connection must now say so explicitly; Phase 5 sets it per connection. Existing rows keep
-- their value.
--
-- SQLite cannot change a column default in place, so `connections` is rebuilt with the same
-- FK-safe copy-aside pattern as 0004 (copy rows aside, drop, create under the SAME name, insert the
-- rows back; defer_foreign_keys lets the children's violations resolve as the parents come back).
-- exact_identity was added by 0007 and is carried over. The AUTOINCREMENT sequence restarts at the
-- highest kept id (no connection has ever been deleted).

PRAGMA defer_foreign_keys = true;

CREATE TABLE connections_0012_copy AS SELECT * FROM connections;

DROP TABLE connections;

CREATE TABLE connections (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT NOT NULL CHECK (kind IN ('exact', 'revolut')),
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'expired', 'disabled', 'needs_reauth')),
  token_ref            TEXT,
  expires_at           TEXT,
  creates_bank_entries INTEGER NOT NULL DEFAULT 0 CHECK (creates_bank_entries IN (0, 1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  access_token_enc     TEXT,
  refresh_token_enc    TEXT,
  region_host          TEXT NOT NULL DEFAULT 'start.exactonline.nl',
  last_error           TEXT,
  connected_by         TEXT,
  connected_at         TEXT,
  updated_at           TEXT,
  exact_identity       TEXT,
  UNIQUE (kind, name)
);

INSERT INTO connections (id, kind, name, status, token_ref, expires_at, creates_bank_entries,
                         created_at, access_token_enc, refresh_token_enc, region_host, last_error,
                         connected_by, connected_at, updated_at, exact_identity)
  SELECT id, kind, name, status, token_ref, expires_at, creates_bank_entries,
         created_at, access_token_enc, refresh_token_enc, region_host, last_error,
         connected_by, connected_at, updated_at, exact_identity
  FROM connections_0012_copy;

DROP TABLE connections_0012_copy;
