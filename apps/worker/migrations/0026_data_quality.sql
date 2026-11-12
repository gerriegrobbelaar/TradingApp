-- 0026 Data quality (Phase 8, task D8a, ADR 0045).
--
--  (a) dq_rules / dq_issues from 0003 were placeholders that nothing ever wrote (the Phase 1 schema
--      sketch). They are replaced, not altered: dq_rules becomes a table of OVERRIDES keyed by the rule
--      id that lives in code (packages/core/src/dq), dq_issues gets a division, a fingerprint and a
--      lifecycle. Both are empty on every deployment, so nothing is copied.
--  (b) dq_rule_status: what the last run said about each rule and division (ok / issues /
--      not_available / not_configured / disabled / error + a reason code). A rule that cannot be
--      evaluated is stored as such, never as ok.
--  (c) dq_runs: one summary row per run of the dq.checks job (job_run_id is unique so a repeated
--      execution of the same job run updates its row instead of adding one).
--  (d) bank_accounts.exact_balance_minor / exact_balance_at: the balance of the mapped bank ledger
--      account in Exact, written by the exact.bank_balances job; the rule "Exact balance differs from
--      the bank balance" compares it with bank_accounts.balance_minor.
--  (e) Guard triggers for the issue lifecycle (hashes pinned in test/fixtures/trigger-hashes.json):
--        dq_issues_identity     rule, division, fingerprint and first_seen_at never change
--        dq_issues_reopen_path  a resolved issue becomes open/snoozed again only through the explicit
--                               path: the same statement raises reopen_count by exactly one
--        dq_issues_counter      reopen_count never goes down
--        dq_issues_keep_live    an open or snoozed issue cannot be deleted (only resolved history)
--
-- division_id 0 means "global" (job freshness, webhook health, the Exact connection, ECB rates): it has
-- no foreign key on purpose. Payloads hold masked labels and small counts only, never a full IBAN or a
-- message body; the Worker masks before writing and a source scan guards it.

DROP TABLE dq_issues;
DROP TABLE dq_rules;

CREATE TABLE dq_rules (
  id             TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 80 AND id NOT GLOB '*[^a-z0-9_.]*'),
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- NULL = the default severity of the rule in code.
  severity       TEXT CHECK (severity IS NULL OR severity IN ('info', 'warning', 'critical')),
  -- {"value": 5} for a number, {"codes": ["1999"]} for a list; NULL = the default of the rule.
  threshold_json TEXT CHECK (threshold_json IS NULL OR json_valid(threshold_json)),
  -- Changes with every edit: lets a PATCH detect a concurrent edit.
  rev            TEXT NOT NULL,
  updated_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE dq_issues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id     INTEGER NOT NULL CHECK (division_id >= 0),
  rule_id         TEXT NOT NULL CHECK (length(rule_id) BETWEEN 3 AND 80),
  -- rule id + ':' + subject key (core dq): the identity of the issue across runs.
  fingerprint     TEXT NOT NULL CHECK (length(fingerprint) BETWEEN 5 AND 200),
  area            TEXT NOT NULL CHECK (area IN
                    ('bank', 'payables', 'receivables', 'master_data', 'fx', 'ledger', 'integrations')),
  severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  severity_rank   INTEGER GENERATED ALWAYS AS
                    (CASE severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END) STORED,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'snoozed')),
  subject         TEXT NOT NULL CHECK (length(subject) <= 400),
  message         TEXT NOT NULL CHECK (length(message) <= 1200),
  fix             TEXT NOT NULL CHECK (length(fix) BETWEEN 1 AND 30),
  amount_minor    INTEGER CHECK (amount_minor IS NULL OR typeof(amount_minor) = 'integer'),
  currency        TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
  -- Small non-secret facts (core DqDetails): counts, ids, codes. No IBAN, no e-mail body.
  payload_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND length(payload_json) <= 4000),
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  resolved_at     TEXT,
  -- 'system' when a run stopped seeing the problem, else the person's email.
  resolved_by     TEXT,
  resolution_note TEXT CHECK (resolution_note IS NULL OR length(resolution_note) <= 200),
  snoozed_until   TEXT,
  snoozed_by      TEXT,
  snooze_note     TEXT CHECK (snooze_note IS NULL OR length(snooze_note) <= 200),
  reopen_count    INTEGER NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  -- Set by the alerting phase when a notification went out; D8a only stores it.
  notified_at     TEXT,
  UNIQUE (division_id, fingerprint),
  CHECK ((status = 'snoozed') = (snoozed_until IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX idx_dq_issues_list ON dq_issues (division_id, status, severity_rank DESC, id DESC);
CREATE INDEX idx_dq_issues_rule ON dq_issues (rule_id, status);

CREATE TABLE dq_rule_status (
  division_id  INTEGER NOT NULL CHECK (division_id >= 0),
  rule_id      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN
                 ('ok', 'issues', 'not_available', 'not_configured', 'disabled', 'error')),
  -- Short machine code (lower case), never a message from data.
  reason       TEXT CHECK (reason IS NULL OR (length(reason) <= 64 AND reason NOT GLOB '*[^a-z0-9_]*')),
  checked      INTEGER NOT NULL DEFAULT 0 CHECK (checked >= 0),
  issue_count  INTEGER NOT NULL DEFAULT 0 CHECK (issue_count >= 0),
  evaluated_at TEXT NOT NULL,
  run_id       INTEGER,
  PRIMARY KEY (division_id, rule_id),
  -- Not evaluated means no issue count and a reason.
  CHECK (status IN ('ok', 'issues') OR (issue_count = 0 AND reason IS NOT NULL))
);

CREATE TABLE dq_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_run_id       INTEGER UNIQUE,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  status           TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'partial', 'error')),
  divisions        INTEGER NOT NULL DEFAULT 0 CHECK (divisions >= 0),
  rules_evaluated  INTEGER NOT NULL DEFAULT 0 CHECK (rules_evaluated >= 0),
  rules_unavailable INTEGER NOT NULL DEFAULT 0 CHECK (rules_unavailable >= 0),
  new_issues       INTEGER NOT NULL DEFAULT 0 CHECK (new_issues >= 0),
  reopened_issues  INTEGER NOT NULL DEFAULT 0 CHECK (reopened_issues >= 0),
  resolved_issues  INTEGER NOT NULL DEFAULT 0 CHECK (resolved_issues >= 0),
  open_issues      INTEGER NOT NULL DEFAULT 0 CHECK (open_issues >= 0),
  engine_version   TEXT NOT NULL,
  error_code       TEXT CHECK (error_code IS NULL OR (length(error_code) <= 64 AND error_code NOT GLOB '*[^a-z0-9_]*'))
);
CREATE INDEX idx_dq_runs_recent ON dq_runs (id DESC);

ALTER TABLE bank_accounts ADD COLUMN exact_balance_minor INTEGER
  CHECK (exact_balance_minor IS NULL OR typeof(exact_balance_minor) = 'integer');
ALTER TABLE bank_accounts ADD COLUMN exact_balance_at TEXT;

-- (e) Lifecycle guards ------------------------------------------------------------------------------
CREATE TRIGGER dq_issues_identity BEFORE UPDATE OF division_id, rule_id, fingerprint, first_seen_at ON dq_issues
WHEN NEW.division_id IS NOT OLD.division_id OR NEW.rule_id IS NOT OLD.rule_id
  OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.first_seen_at IS NOT OLD.first_seen_at
BEGIN
  SELECT RAISE(ABORT, 'dq_err:identity_immutable');
END;

CREATE TRIGGER dq_issues_reopen_path BEFORE UPDATE OF status ON dq_issues
WHEN OLD.status = 'resolved' AND NEW.status <> 'resolved' AND NEW.reopen_count <> OLD.reopen_count + 1
BEGIN
  SELECT RAISE(ABORT, 'dq_err:reopen_path');
END;

CREATE TRIGGER dq_issues_counter BEFORE UPDATE OF reopen_count ON dq_issues
WHEN NEW.reopen_count < OLD.reopen_count
BEGIN
  SELECT RAISE(ABORT, 'dq_err:counter_down');
END;

CREATE TRIGGER dq_issues_keep_live BEFORE DELETE ON dq_issues
WHEN OLD.status <> 'resolved'
BEGIN
  SELECT RAISE(ABORT, 'dq_err:delete_live');
END;
