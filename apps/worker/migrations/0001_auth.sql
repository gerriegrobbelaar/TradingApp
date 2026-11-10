-- 0001 auth: users, roles, invites, sessions (CLAUDE.md 4.0). Timestamps are UTC ISO-8601 text.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub    TEXT UNIQUE,
  email         TEXT NOT NULL CHECK (email = lower(email) AND length(email) > 0),
  display_name  TEXT,
  is_external   INTEGER NOT NULL DEFAULT 0 CHECK (is_external IN (0, 1)),
  disabled_at   TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_users_email ON users (email);

CREATE TABLE user_roles (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'approver', 'finance', 'viewer')),
  granted_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, role)
);
CREATE INDEX idx_user_roles_role ON user_roles (role);

CREATE TABLE invites (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL CHECK (email = lower(email) AND length(email) > 0),
  roles          TEXT NOT NULL,
  allow_external INTEGER NOT NULL DEFAULT 0 CHECK (allow_external IN (0, 1)),
  invited_by     TEXT NOT NULL,
  accepted_at    TEXT,
  revoked_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_invites_pending_email ON invites (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- The cookie carries a random token; only its SHA-256 (lowercase hex) is stored, never the raw token.
-- last_auth_at = time of the last Google sign-in, used for the 15-minute step-up check.
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_auth_at TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
