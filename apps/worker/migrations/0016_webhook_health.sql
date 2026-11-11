-- 0016 Webhook channel health and refresh-token expiry (Phase 5 review fixes S4 and N8).
--
--  (a) connections: when a webhook delivery last verified, when one was last rejected, how many
--      were rejected since the connection was made (a lower bound under a flood, see (b)), and the
--      refresh-token expiry when Revolut told us one (NULL = unknown). Additive only.
--  (b) webhook_rejections: rejected deliveries counted per (connection, UTC minute, reason code).
--      The route is public, so an unauthenticated caller can cause these writes: the app writes
--      at most one upsert per reason per minute per isolate (webhook-health.ts), and the key
--      bounds the table to (reasons x minutes) rows, never one row per request. No body, header,
--      address or signature is stored. Kept 7 days (housekeepWebhookEvents).

ALTER TABLE connections ADD COLUMN last_webhook_verified_at TEXT;
ALTER TABLE connections ADD COLUMN last_webhook_rejected_at TEXT;
ALTER TABLE connections ADD COLUMN webhook_rejected_total INTEGER NOT NULL DEFAULT 0
  CHECK (webhook_rejected_total >= 0);
ALTER TABLE connections ADD COLUMN refresh_expires_at TEXT;

CREATE TABLE webhook_rejections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES connections (id),
  -- Start of the UTC minute (ISO-8601, seconds and milliseconds zero).
  bucket_at     TEXT NOT NULL,
  -- One of a fixed list of short codes (webhook-health.ts REJECT_REASONS), else 'other'.
  reason_code   TEXT NOT NULL,
  count         INTEGER NOT NULL CHECK (count >= 1),
  UNIQUE (connection_id, bucket_at, reason_code)
);
CREATE INDEX idx_webhook_rejections_bucket ON webhook_rejections (bucket_at);
