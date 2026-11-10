-- 0003 starting domain model (CLAUDE.md 5). Money = integer minor units + ISO currency code.
-- Timestamps: UTC ISO-8601 text. Later phases add columns via new migrations.

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE connections (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT NOT NULL CHECK (kind IN ('exact', 'revolut')),
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'expired', 'disabled')),
  token_ref            TEXT,
  expires_at           TEXT,
  creates_bank_entries INTEGER NOT NULL DEFAULT 1 CHECK (creates_bank_entries IN (0, 1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (kind, name)
);

CREATE TABLE divisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id  INTEGER NOT NULL REFERENCES connections (id),
  exact_division INTEGER NOT NULL,
  name           TEXT NOT NULL,
  base_currency  TEXT NOT NULL DEFAULT 'EUR',
  UNIQUE (connection_id, exact_division)
);

CREATE TABLE bank_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES connections (id),
  division_id   INTEGER REFERENCES divisions (id),
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  iban          TEXT,
  currency      TEXT NOT NULL,
  balance_minor INTEGER,
  balance_at    TEXT,
  UNIQUE (connection_id, external_id)
);

CREATE TABLE bank_transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id     INTEGER NOT NULL REFERENCES connections (id),
  bank_account_id   INTEGER NOT NULL REFERENCES bank_accounts (id),
  external_id       TEXT NOT NULL,
  state             TEXT NOT NULL,
  amount_minor      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  counterparty_name TEXT,
  counterparty_iban TEXT,
  reference         TEXT,
  booked_at         TEXT NOT NULL,
  exact_entry_id    TEXT,
  match_status      TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched', 'suggested', 'matched', 'ignored')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (connection_id, external_id)
);
CREATE INDEX idx_bank_tx_account_date ON bank_transactions (bank_account_id, booked_at);
CREATE INDEX idx_bank_tx_match ON bank_transactions (match_status);

CREATE TABLE open_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id    INTEGER NOT NULL REFERENCES divisions (id),
  exact_id       TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('invoice', 'bill')),
  relation_id    TEXT,
  relation_name  TEXT,
  relation_iban  TEXT,
  invoice_number TEXT,
  reference      TEXT,
  currency       TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL,
  open_minor     INTEGER NOT NULL,
  rate           TEXT,
  invoice_date   TEXT,
  due_date       TEXT,
  status         TEXT NOT NULL DEFAULT 'open',
  synced_at      TEXT NOT NULL,
  UNIQUE (division_id, exact_id)
);
CREATE INDEX idx_open_items_due ON open_items (division_id, kind, due_date);
CREATE INDEX idx_open_items_number ON open_items (invoice_number);

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
CREATE INDEX idx_suggestions_tx ON match_suggestions (bank_transaction_id, score DESC);

CREATE TABLE matches (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id),
  open_item_id        INTEGER REFERENCES open_items (id),
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
  score               INTEGER,
  exact_matchset_id   TEXT,
  matched_by          TEXT NOT NULL,
  matched_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  undone_at           TEXT,
  undone_by           TEXT
);
CREATE INDEX idx_matches_tx ON matches (bank_transaction_id);
CREATE INDEX idx_matches_item ON matches (open_item_id);

CREATE TABLE payment_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_approval', 'paying', 'paid', 'failed')),
  total_minor INTEGER NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  open_item_id     INTEGER NOT NULL REFERENCES open_items (id),
  batch_id         INTEGER REFERENCES payment_batches (id),
  bank_account_id  INTEGER REFERENCES bank_accounts (id),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_approval', 'paying', 'paid', 'failed')),
  amount_minor     INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  beneficiary_iban TEXT NOT NULL,
  reference        TEXT,
  request_id       TEXT NOT NULL UNIQUE,
  failure_reason   TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT
);
CREATE INDEX idx_payments_item ON payments (open_item_id);
CREATE INDEX idx_payments_status ON payments (status);

CREATE TABLE approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('payment', 'batch', 'bank_details')),
  subject_id   TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by   TEXT,
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- An approver can never approve their own request.
  CHECK (status <> 'approved' OR (decided_by IS NOT NULL AND lower(decided_by) <> lower(requested_by)))
);
CREATE INDEX idx_approvals_subject ON approvals (subject_type, subject_id);
CREATE INDEX idx_approvals_status ON approvals (status);

CREATE TABLE fx_rates (
  currency   TEXT NOT NULL,
  rate_date  TEXT NOT NULL,
  rate       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'ECB',
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (currency, rate_date)
);

CREATE TABLE fx_revaluations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id      INTEGER NOT NULL REFERENCES divisions (id),
  period           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'booked', 'reversed')),
  difference_minor INTEGER NOT NULL DEFAULT 0,
  exact_journal_id TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (division_id, period)
);

CREATE TABLE jobs (
  name         TEXT PRIMARY KEY,
  cron         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  exact_budget INTEGER NOT NULL DEFAULT 0,
  last_run_at  TEXT,
  last_result  TEXT,
  next_run_at  TEXT
);

CREATE TABLE job_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name     TEXT NOT NULL REFERENCES jobs (name),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'skipped')),
  trigger      TEXT NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron', 'manual')),
  triggered_by TEXT,
  calls_used   INTEGER NOT NULL DEFAULT 0,
  result_json  TEXT
);
CREATE INDEX idx_job_runs_job ON job_runs (job_name, started_at DESC);

CREATE TABLE dq_rules (
  code      TEXT PRIMARY KEY,
  area      TEXT NOT NULL,
  severity  TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  threshold INTEGER,
  enabled   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE dq_issues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code     TEXT NOT NULL REFERENCES dq_rules (code),
  subject       TEXT NOT NULL,
  message       TEXT NOT NULL,
  fix_link      TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  resolved_at   TEXT,
  UNIQUE (rule_code, subject)
);
CREATE INDEX idx_dq_issues_open ON dq_issues (resolved_at, rule_code);

CREATE TABLE reminders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  open_item_id INTEGER NOT NULL REFERENCES open_items (id) ON DELETE CASCADE,
  step         TEXT NOT NULL,
  due_on       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'skipped', 'paused', 'cancelled')),
  sent_at      TEXT,
  UNIQUE (open_item_id, step)
);
CREATE INDEX idx_reminders_due ON reminders (status, due_on);

CREATE TABLE email_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER REFERENCES reminders (id),
  recipient   TEXT NOT NULL,
  subject     TEXT,
  provider_id TEXT,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'failed')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT
);
CREATE INDEX idx_email_log_reminder ON email_log (reminder_id);
