-- 0010 Ledger data for the balance sheet and profit and loss reports (Phase 4, task K2, ADR 0023).
--
-- Three tables filled by the nightly full sync (apps/worker/src/exact/ledger-sync.ts):
--   gl_accounts   the chart of accounts (financial/GLAccounts). Accounts that Exact stops returning
--                 are marked is_active = 0 after two complete reads; they are never deleted.
--   gl_balances   reporting balances (financial/ReportingBalance) per account, reporting year and
--                 period, in the DIVISION currency. amount_minor is signed: debit - credit
--                 (assumption, ADR 0023). `dimension` is Exact's Status / cost centre of the row
--                 ("" when none); Exact may split one period over them and the reports add the
--                 parts, so it is part of the key.
--   gl_budgets    budgets (budget/Budgets), optional data. `scenario` is the budget scenario GUID
--                 ("" when none); `dimension` the cost centre.
-- The ledger account of a balance or budget row is kept as Exact's GUID (gl_account_exact_id), not
-- as a foreign key: a balance may arrive before its account, and an account that Exact no longer
-- returns keeps its history.
-- Every table carries the sync bookkeeping of open_items (last_seen_sync_id = run_seq of the run
-- that last saw the row, missed_cycles and strike_cycle for the two-strike rule, ADR 0017).
-- All money is integer minor units at the scale of `currency` (currencyScale), never a float.
--
-- Additive only: nothing existing is rebuilt, so the migration is safe on a populated database
-- (test/migration-0010.test.ts).

CREATE TABLE gl_accounts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id       INTEGER NOT NULL REFERENCES divisions (id),
  exact_id          TEXT NOT NULL,
  code              TEXT,
  name              TEXT NOT NULL,
  type              INTEGER,
  type_description  TEXT,
  balance_side      TEXT CHECK (balance_side IS NULL OR balance_side IN ('D', 'C')),
  balance_type      TEXT CHECK (balance_type IS NULL OR balance_type IN ('B', 'W')),
  is_blocked        INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0, 1)),
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_seen_sync_id INTEGER,
  missed_cycles     INTEGER NOT NULL DEFAULT 0,
  strike_cycle      INTEGER,
  updated_at        TEXT NOT NULL,
  UNIQUE (division_id, exact_id)
);
CREATE INDEX idx_gl_accounts_code ON gl_accounts (division_id, code);

CREATE TABLE gl_balances (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id        INTEGER NOT NULL REFERENCES divisions (id),
  gl_account_exact_id TEXT NOT NULL,
  year               INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2200),
  period             INTEGER NOT NULL CHECK (period BETWEEN 0 AND 99),
  dimension          TEXT NOT NULL DEFAULT '',
  amount_minor       INTEGER NOT NULL,
  debit_minor        INTEGER,
  credit_minor       INTEGER,
  currency           TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  balance_type       TEXT CHECK (balance_type IS NULL OR balance_type IN ('B', 'W')),
  last_seen_sync_id  INTEGER,
  missed_cycles      INTEGER NOT NULL DEFAULT 0,
  strike_cycle       INTEGER,
  updated_at         TEXT NOT NULL,
  UNIQUE (division_id, gl_account_exact_id, year, period, dimension)
);
-- The reports read one division and year (and a period range) at a time.
CREATE INDEX idx_gl_balances_year ON gl_balances (division_id, year, period);

CREATE TABLE gl_budgets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id        INTEGER NOT NULL REFERENCES divisions (id),
  gl_account_exact_id TEXT NOT NULL,
  year               INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2200),
  period             INTEGER NOT NULL CHECK (period BETWEEN 0 AND 99),
  scenario           TEXT NOT NULL DEFAULT '',
  dimension          TEXT NOT NULL DEFAULT '',
  amount_minor       INTEGER NOT NULL,
  currency           TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  last_seen_sync_id  INTEGER,
  missed_cycles      INTEGER NOT NULL DEFAULT 0,
  strike_cycle       INTEGER,
  updated_at         TEXT NOT NULL,
  UNIQUE (division_id, gl_account_exact_id, year, period, scenario, dimension)
);
CREATE INDEX idx_gl_budgets_year ON gl_budgets (division_id, year, period);

-- One row per (entity, reporting year) with the last COMPLETE read of that year and the full-sync
-- cycle it happened in. The balances of the current year are read every cycle; the previous year
-- and the budgets only when this is missing or older than a week. Freshness in the API reads it.
CREATE TABLE gl_sync_years (
  division_id  INTEGER NOT NULL REFERENCES divisions (id),
  entity       TEXT NOT NULL,
  year         INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  cycle        INTEGER,
  rows_read    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (division_id, entity, year)
);

-- Budgets are optional data (the module may not be licensed): when the first page of the budget
-- read answers 400/403/404 the entity is not tried again until this moment (one week later).
-- sync_state.last_error then holds budgets_unavailable_<http status>.
ALTER TABLE sync_state ADD COLUMN unavailable_until TEXT;
