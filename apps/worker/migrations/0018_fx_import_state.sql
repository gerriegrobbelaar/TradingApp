-- ECB FX import (Phase 6, task F2, ADR 0035).
-- fx_rates (0003) already has what is needed: currency CHAR(3) uppercase, rate_date, rate as a
-- decimal TEXT with a CHECK, source, fetched_at and PRIMARY KEY (currency, rate_date). This adds
-- the single-row import state (health of the import, read by the rates API and, later, by the
-- data quality rules) and an index for "newest rate on or before a date" lookups.

CREATE TABLE fx_import_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at  TEXT,
  last_success_at  TEXT,
  last_status      TEXT,
  last_error_code  TEXT,
  newest_rate_date TEXT,
  rows_inserted    INTEGER NOT NULL DEFAULT 0
);
INSERT INTO fx_import_state (id) VALUES (1);

CREATE INDEX idx_fx_rates_date ON fx_rates (rate_date);
