# 0033 Revolut webhooks, ingest, poll and backfill

Status: accepted for Phase 5 (task R3a). Items under "Assumptions" are **verify with credentials**.

## Webhook flow (`POST /api/webhooks/revolut`)
- Public route, CSRF-header rule skipped for this path and method only (`Access.csrfExempt`, public routes only; a test
  over the Worker's real router, `src/app-router.ts`, pins that it is the only one). Body capped at 1 MB: 413 when
  Content-Length says more, and the body is ALWAYS read as a counted stream cancelled past the cap (absent or lying
  Content-Length). Raw bytes -> R1 `verifyRevolutWebhook` with the current, then the previous secret -> every failure
  before or in verification is one fixed plain 401 (same status, headers and body; reason code logged only), including
  no connection, a `pending` or `disabled` connection, no secret, and a database or decryption error while loading the
  connection or its secrets (no 500 vs 401 oracle for unauthenticated callers). Errors AFTER a valid signature
  (D1 insert, queue) may be 500 so Revolut retries.
- **Decision (review R3a):** `active`, `needs_reauth` and `expired` connections accept correctly signed deliveries:
  recorded and enqueued, 200. Processing then ends `error` with the status as code (no tokens); the backfill after
  re-authorisation recovers the transactions. `pending` / `disabled` / none: the uniform 401.
- SHA-256 of the body BYTES only into `webhook_events` (unique per connection). **Decision:** the same body with a different
  timestamp (and so a different signature) is the same event: that is exactly what a Revolut retry looks like. A valid
  replay inside the 5-minute window after processing is a 200 no-op. A row that never reached the queue
  (`enqueue_failed`, or never parsed) or sat `queued` for 5 minutes is enqueued again by a later delivery, claimed
  atomically and counted in `requeue_count`, at most `MAX_REQUEUES` = 5 times (then 200 no-op; poll and backfill
  recover). Queue refusal = 500, so Revolut retries. Unknown event type = `ignored`, bad payload = `error`, both 200.
- Queue message `{type:'revolut_event', webhookEventId}` (ids only; strict shape, others acked and logged by type name).
  `processRevolutEvent` loads the row, calls `GET /transaction/{id}` through the gate (job priority, 3-call budget) and upserts.
  Payload data is never trusted. 404 = `processed` / `transaction_not_found`. Retryable errors retry via the queue (max 4
  deliveries, then `error`); permanent errors are `error` at once. The unrecovered DLQ path stays the queue's (`max_retries = 3`).
- Rotation: a delivery verified with the CURRENT secret retires the previous one (audited); one verified with the previous
  secret changes nothing, so a holder of the old secret can never retire or restore anything. Subscription lifecycle: created at
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
Why failed/declined -> completed is refused: Revolut documents states as terminal except pending -> *, and completed ->
reverted as the one later change; anything else is a provider fault or a stale read, surfaced (count in job results and
the event's `state_change_blocked` code), not booked. The CAS is atomic per statement inside ONE batch; a lost swap
re-reads and decides again (tests interleave a webhook writer and a poll writer); losing every pass (3) throws a
retryable error, never a silent success. Equal `updated_at` counts as not older (refresh applies).
Timestamps must carry a zone (Z or +hh:mm); fractions of any length are truncated to milliseconds and stored as
`toISOString()` UTC. Ids are validated strictly (transaction and account ids `[A-Za-z0-9_-]{1,100}`, the same alphabet
the gate path accepts), duplicate leg ids and more than 20 legs are refused (`bad_leg`, `too_many_legs`). Accounts are
created only from a leg's OWN `account_id` (Revolut legs are always ours); a counterparty's account id never becomes an
account row.

## Polling, backfill and call arithmetic (rate limit assumed 60/min, no daily cap)
- `revolut.sync` (every 10 min, 5-15 allowed): accounts (1 call; retires accounts only after a non-empty complete read),
  bank details for accounts never looked up (<= 2), transaction pages (<= 4 of 200, from watermark - 2 h; resumable cursor in
  `revolut_sync_state`), refresh of <= 2 old pending rows. Budget 10; quiet run 3-4. Day: 144 x 10 = 1,440 worst case (5-minute
  schedule 2,880), typical ~600. A run audits only when it changed something or did not end ok.
- `revolut.backfill` (03:15 daily, >= 12 h apart): last 35 days from the slot, pages of 500, <= 10 pages, budget 12, resumes a
  stored cursor (retry in 2 min, up to 6 attempts). Result `missing` = transactions at Revolut that D1 never had (neither
  webhook nor poll) and that were created more than `MISS_GRACE_MS` = 10 minutes before the walk, so a webhook still in
  flight is not counted as a miss; the last
  complete ordinary walk is `revolut_sync_state.last_missing` (data-quality signal, Phase 8). The one-off 90-day backfill is
  requested at confirm (`requested_days = 90`, manual run), flagged `initial`, and excluded from the signal. A manual run is
  never retried by the runner: a stopped initial walk ends `partial` with code `initial_backfill_incomplete` (visible in
  Settings, Schedules) and the next run of the job, scheduled or manual, resumes its cursor and window. Both jobs ship
  disabled (`awaiting_live_verification`); a manual run works regardless.

## Assumptions to verify
1. Payload `{event, timestamp, data:{id, request_id, state | old_state/new_state}}`; header names `Revolut-Signature`,
   `Revolut-Request-Timestamp` (ms). 2. `TransactionStateChanged` fires for every state change. 3. Retries: 3 more, 10 min
   apart. 4. `GET /webhooks` lists our subscription; a second subscription for one URL is allowed. 5. 60 calls/minute.
6. `/transactions` honours `from`/`count`; a server that caps below seen+1 rows ends a walk early (R1 limit, see report).

## Audit and result masking
`maskDeep` (audit before/after and job results) no longer redacts a bare `code` key: it is the machine code of every
job result, and redacting it hid every failure reason. OAuth codes are caught by qualified names (`authorization_code`,
`auth_code`, `oauth_code`, `grant_code`, `code_verifier`); no caller stores a raw OAuth `code`.

## Bank read API (agreed with R3b, ADR 0032)
`legCount` per row (all stored legs of the Revolut transaction, whatever the filter), totals `inMinor`/`outMinor` as
positive magnitudes over pending + completed rows only, `connection` returned for every status, keyset paging on the
index `(connection_id, created_at, id)` (no temp sort; EXPLAIN pinned in a test).
