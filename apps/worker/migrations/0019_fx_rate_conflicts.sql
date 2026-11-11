-- ECB rate conflicts with a resolution path (Phase 6 review S9, ADR 0039).
--
-- The importer never overwrites a stored rate (published rates are final, ADR 0036). When the ECB
-- later shows a different value for a stored (currency, date) it wrote one `fx.rate_conflict`
-- audit row and nothing else. This table makes that actionable: one row per (currency, date, ECB
-- value) with an open/resolved state, so an admin can keep the stored rate or accept the ECB value
-- (audited), Phase 8 can alert on unresolved rows and Phase 12 can refuse a month-end date with an
-- unresolved conflict.
--
-- The audit_log stays the history; this table is the working state. Existing conflict audit rows
-- are copied in as unresolved (entity_id is 'USD@2026-11-09', after_json {"stored","ecb"}), the
-- oldest first_seen_at wins when the same value was audited twice. New table, nothing else moves.

CREATE TABLE fx_rate_conflicts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  currency      TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  rate_date     TEXT NOT NULL CHECK (length(rate_date) = 10 AND rate_date NOT GLOB '*[^0-9-]*'),
  -- Decimal text as in fx_rates: the stored value when the conflict was seen, and the ECB's.
  stored_rate   TEXT NOT NULL,
  ecb_rate      TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at   TEXT,
  resolved_by   TEXT,
  resolution    TEXT CHECK (resolution IS NULL OR resolution IN ('kept', 'accepted')),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL) AND (resolved_at IS NULL) = (resolved_by IS NULL)),
  UNIQUE (currency, rate_date, ecb_rate)
);
-- "Is anything unresolved, and for which dates": a partial index over the (few) open rows.
CREATE INDEX idx_fx_rate_conflicts_open ON fx_rate_conflicts (rate_date) WHERE resolved_at IS NULL;

INSERT OR IGNORE INTO fx_rate_conflicts (currency, rate_date, stored_rate, ecb_rate, first_seen_at)
SELECT substr(entity_id, 1, 3), substr(entity_id, 5, 10),
       json_extract(after_json, '$.stored'), json_extract(after_json, '$.ecb'), MIN(at)
FROM audit_log
WHERE action = 'fx.rate_conflict' AND entity = 'fx_rate'
  AND length(entity_id) = 14 AND substr(entity_id, 4, 1) = '@'
  AND substr(entity_id, 1, 3) NOT GLOB '*[^A-Z]*'
  AND substr(entity_id, 5, 10) NOT GLOB '*[^0-9-]*'
  -- Only well-formed rows; json_type is reached only for valid JSON (CASE, not AND, so the
  -- planner cannot evaluate it on malformed text and fail the migration).
  AND CASE WHEN json_valid(after_json)
           THEN json_type(after_json, '$.stored') = 'text' AND json_type(after_json, '$.ecb') = 'text'
           ELSE 0 END
GROUP BY substr(entity_id, 1, 3), substr(entity_id, 5, 10), json_extract(after_json, '$.ecb');
