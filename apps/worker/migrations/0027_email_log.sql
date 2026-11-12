-- 0027 E-mail log (Phase 8, task D8b, ADR 0046).
--
-- email_log from 0003 was a placeholder that nothing ever wrote (it kept the recipient address and the
-- subject). It is replaced, not altered. The new table is a CLAIM-THEN-SEND ledger:
--   * one row per e-mail, with a unique idempotency_key (for example dq-alert:<fingerprint>:<reopen
--     count>). The row is inserted (claimed) in the same D1 batch that marks the thing it is about
--     (dq_issues.notified_at), BEFORE the provider is called; only the writer whose insert changed a
--     row may send.
--   * a crash between claim and send leaves status 'claimed'; a sweep turns a stale claim into
--     'unknown' and an unknown e-mail is NEVER sent again by the code (a duplicate flood is worse than
--     a missing alert that the log shows).
--   * 'failed' means the provider definitely did not accept it (4xx); only then may the row be claimed
--     again (attempts + 1, at most 3).
-- It stores NO address, NO subject and NO body: kind, template id, recipient COUNT, status, provider
-- message id and a short error code. Who got a digest follows from the users table and the audit row.
--
-- Guards (hashes in test/fixtures/trigger-hashes.json):
--   email_log_identity     key, kind, template, recipient count, issue, reminder and created_at never change
--   email_log_status_path  claimed -> sent | failed | unknown | skipped_not_configured; failed -> claimed
--                          (attempts + 1); sent -> delivered | bounced; nothing else
--   email_log_attempts     attempts only go up, and only with failed -> claimed
--   email_log_keep_recent  a row younger than 365 days cannot be deleted (retention is 400 days)

DROP TABLE email_log;

CREATE TABLE email_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key     TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 5 AND 300),
  kind                TEXT NOT NULL CHECK (kind IN ('dq_alert', 'dq_alert_summary', 'dq_digest', 'test')),
  -- Template id and version, for example dq.alert.v1.
  template            TEXT NOT NULL CHECK (length(template) BETWEEN 3 AND 60),
  recipients_count    INTEGER NOT NULL CHECK (recipients_count BETWEEN 0 AND 1000),
  status              TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN
                        ('claimed', 'sent', 'delivered', 'bounced', 'failed', 'unknown', 'skipped_not_configured')),
  attempts            INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 3),
  -- No foreign key on the issue: resolved issues are deleted after 180 days, the log is kept longer.
  dq_issue_id         INTEGER,
  reminder_id         INTEGER REFERENCES reminders (id),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
  -- Short machine code (lower case), never a provider message.
  error_code          TEXT CHECK (error_code IS NULL OR (length(error_code) <= 64 AND error_code NOT GLOB '*[^a-z0-9_]*')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_email_log_status ON email_log (status, updated_at);
CREATE INDEX idx_email_log_kind ON email_log (kind, created_at);
CREATE INDEX idx_email_log_reminder ON email_log (reminder_id);

CREATE TRIGGER email_log_identity
BEFORE UPDATE OF idempotency_key, kind, template, recipients_count, dq_issue_id, reminder_id, created_at ON email_log
WHEN NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.kind IS NOT OLD.kind
  OR NEW.template IS NOT OLD.template OR NEW.recipients_count IS NOT OLD.recipients_count
  OR NEW.dq_issue_id IS NOT OLD.dq_issue_id OR NEW.reminder_id IS NOT OLD.reminder_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'email_err:identity_immutable');
END;

CREATE TRIGGER email_log_status_path
BEFORE UPDATE OF status ON email_log
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'claimed' AND NEW.status IN ('sent', 'failed', 'unknown', 'skipped_not_configured'))
  OR (OLD.status = 'failed' AND NEW.status = 'claimed' AND NEW.attempts = OLD.attempts + 1)
  OR (OLD.status = 'sent' AND NEW.status IN ('delivered', 'bounced'))
)
BEGIN
  SELECT RAISE(ABORT, 'email_err:status_path');
END;

CREATE TRIGGER email_log_attempts
BEFORE UPDATE OF attempts ON email_log
WHEN NEW.attempts <> OLD.attempts AND NOT (
  OLD.status = 'failed' AND NEW.status = 'claimed' AND NEW.attempts = OLD.attempts + 1
)
BEGIN
  SELECT RAISE(ABORT, 'email_err:attempts');
END;

CREATE TRIGGER email_log_keep_recent
BEFORE DELETE ON email_log
WHEN OLD.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days')
BEGIN
  SELECT RAISE(ABORT, 'email_err:delete_recent');
END;
