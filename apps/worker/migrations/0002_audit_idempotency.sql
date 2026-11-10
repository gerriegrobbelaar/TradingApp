-- 0002 audit log (append-only) and idempotency keys (CLAUDE.md 5).

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json  TEXT CHECK (after_json IS NULL OR json_valid(after_json))
);
CREATE INDEX idx_audit_entity ON audit_log (entity, entity_id);
CREATE INDEX idx_audit_actor ON audit_log (actor_email, at);
CREATE INDEX idx_audit_at ON audit_log (at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- A key is unique within its scope (for example 'revolut.pay' + request_id). The row is inserted
-- before the external call; INSERT ... ON CONFLICT DO NOTHING makes the claim atomic.
CREATE TABLE idempotency_keys (
  scope        TEXT NOT NULL,
  key          TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  result_json  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  PRIMARY KEY (scope, key)
);
CREATE INDEX idx_idempotency_created ON idempotency_keys (created_at);
