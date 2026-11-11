-- ECB history backfill after a shortened first import (Phase 6 review N2, ADR 0036 addendum).
-- When the 400-day first import is too large and a shorter window is used instead, the older
-- history is fetched afterwards in bounded steps, one extra request per run, until it reaches the
-- target:
--   backfill_target  the oldest date wanted (the 400-day floor of the first import); NULL = done
--   backfill_cursor  the oldest date covered so far; the next step ends the day before it
-- Both are set together and cleared together.

ALTER TABLE fx_import_state ADD COLUMN backfill_target TEXT;
ALTER TABLE fx_import_state ADD COLUMN backfill_cursor TEXT;
