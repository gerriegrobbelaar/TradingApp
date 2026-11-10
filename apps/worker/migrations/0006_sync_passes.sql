-- 0006 Resumable full syncs (review G1, ADR 0017).
--
-- Columns are added to sync_state; the table is not rebuilt (nothing references it, but a rebuild
-- is also not needed). All new columns are nullable or have a default, so existing rows stay valid.
--
-- A FULL "cycle" spans as many runs as it takes. It is recorded on the 'run' row:
--   cycle_seq         sync_locks.run_seq of the run that started the cycle; NULL = no cycle open.
--                     It is also the closing marker: when the open receivables (or payables) list
--                     has been read completely, open items last seen BEFORE this run_seq are closed.
--   cycle_started_at  when it started; a cycle older than 36 hours is abandoned and restarted.
-- Per entity row:
--   pass_cycle        the cycle the saved pass_token / cursor belongs to (ignored for any other)
--   pass_token        Exact $skiptoken to resume the open-item list read from (NULL = from the start)
--   pass_rows         rows read in this pass so far (progress shown to the user)
--   pass_total        estimate of the rows to read (open items of that kind before the pass), or NULL
--   done_cycle        the cycle in which this entity's full read completed (skipped by later runs
--                     of the same cycle)
-- Transient failures (retry bound per Amsterdam day), on the 'run' row:
--   retry_count, retry_day

ALTER TABLE sync_state ADD COLUMN cycle_seq INTEGER;
ALTER TABLE sync_state ADD COLUMN cycle_started_at TEXT;
ALTER TABLE sync_state ADD COLUMN pass_cycle INTEGER;
ALTER TABLE sync_state ADD COLUMN pass_token TEXT;
ALTER TABLE sync_state ADD COLUMN pass_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN pass_total INTEGER;
ALTER TABLE sync_state ADD COLUMN done_cycle INTEGER;
ALTER TABLE sync_state ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN retry_day TEXT;
