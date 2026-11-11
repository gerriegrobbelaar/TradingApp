# 0033 Revolut webhooks, ingest, poll and backfill

Status: accepted for Phase 5 (task R3a). Items under "Assumptions" are **verify with credentials**.

## Webhook flow (`POST /api/webhooks/revolut`)
- Public route, CSRF-header rule skipped for this path only (`Access.csrfExempt`, public routes only; a test pins it).
  Body capped at 1 MB (413 before parsing). Raw bytes -> R1 `verifyRevolutWebhook` with the current, then the previous secret
  -> every failure is one fixed plain 401 (no reason in the response; reason code logged). Only an `active` connection
  accepts events (`needs_reauth` is 401; the poll and backfill recover after re-authorisation).
- SHA-256 of the body into `webhook_events` (unique per connection): duplicates answer 200 without enqueueing. A row that
  never reached the queue (`enqueue_failed`, or never parsed) or sat `queued` for 5 minutes is enqueued again by the next
  delivery. Queue refusal = 500, so Revolut retries. Unknown event type = `ignored`, bad payload = `error`, both 200.
- Queue message `{type:'revolut_event', webhookEventId}` (ids only; strict shape, others acked and logged by type name).
  `processRevolutEvent` loads the row, calls `GET /transaction/{id}` through the gate (job priority, 3-call budget) and upserts.
  Payload data is never trusted. 404 = `processed` / `transaction_not_found`. Retryable errors retry via the queue (max 4
  deliveries, then `error`); permanent errors are `error` at once. The unrecovered DLQ path stays the queue's (`max_retries = 3`).
- Rotation: a delivery verified with the new secret retires the previous one (audited). Subscription lifecycle: created at
  confirm (secret encrypted, never logged), `last_error = 'webhook_not_registered'` + `webhookRegistered:false` on failure,
  admin "Register webhook" (`replace:true` rotates: create new, keep old secret as previous, delete old subscription).
  Recovery of a lost creation response: `GET /webhooks` (gate allows it only for job id `revolut-webhook-recover`, priority
  user) -> delete our-URL subscriptions -> create. List responses (may hold secrets) are never stored or logged.

## Ingest transition table (`packages/core/bank-tx.ts`)
One row per leg, unique (connection, transaction id, leg id); decided in TypeScript, applied as compare-and-swap on
(state, updated_at), one batch per transaction. Unknown never replaces a known state; pending never replaces a final state;
pending -> any final; same state refreshes if `updated_at` is not older; **completed -> reverted is the only legal
final -> final move** (needs a not-older timestamp); failed/declined/reverted -> anything else is refused and counted
(`state_change_blocked`). `source` keeps the first source. Counterparty IBAN is stored compact and full, never returned.

## Polling, backfill and call arithmetic (rate limit assumed 60/min, no daily cap)
- `revolut.sync` (every 10 min, 5-15 allowed): accounts (1 call; retires accounts only after a non-empty complete read),
  bank details for accounts never looked up (<= 2), transaction pages (<= 4 of 200, from watermark - 2 h; resumable cursor in
  `revolut_sync_state`), refresh of <= 2 old pending rows. Budget 10; quiet run 3-4. Day: 144 x 10 = 1,440 worst case (5-minute
  schedule 2,880), typical ~600. A run audits only when it changed something or did not end ok.
- `revolut.backfill` (03:15 daily, >= 12 h apart): last 35 days from the slot, pages of 500, <= 10 pages, budget 12, resumes a
  stored cursor (retry in 2 min, up to 6 attempts). Result `missing` = transactions at Revolut that D1 never had; the last
  complete ordinary walk is `revolut_sync_state.last_missing` (data-quality signal, Phase 8). The one-off 90-day backfill is
  requested at confirm (`requested_days = 90`, manual run), flagged `initial`, and excluded from the signal. Both jobs ship
  disabled (`awaiting_live_verification`); a manual run works regardless.

## Assumptions to verify
1. Payload `{event, timestamp, data:{id, request_id, state | old_state/new_state}}`; header names `Revolut-Signature`,
   `Revolut-Request-Timestamp` (ms). 2. `TransactionStateChanged` fires for every state change. 3. Retries: 3 more, 10 min
   apart. 4. `GET /webhooks` lists our subscription; a second subscription for one URL is allowed. 5. 60 calls/minute.
6. `/transactions` honours `from`/`count`; a server that caps below seen+1 rows ends a walk early (R1 limit, see report).
