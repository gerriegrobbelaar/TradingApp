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
  When a replacement is stored but deleting the OLD subscription failed, that subscription keeps delivering
  until a delivery verifies with the new secret: both the new and the old secret verify during that time, and
  after the first delivery signed with the new secret the old secret is retired (no longer valid here). An old
  subscription that was never deleted at Revolut then still delivers, but its deliveries are rejected (counted
  as `bad_signature`) until an admin removes it in Revolut.

## Channel health and housekeeping (review S4, N1, N2)

- Header-first: both headers must be present, the timestamp 13 digits and inside the 5-minute window, and the
  signature header well formed (at most 5 entries, at least one `v1=<64 hex>`) BEFORE the body is read or D1 is
  asked anything. The route calls R1's own `checkRevolutWebhookHeaders`, which `verifyRevolutWebhook` itself
  runs first, so the pre-check can never refuse a delivery the verifier accepts (a randomised differential test
  checks this too). The uniform 401 is unchanged; a well-formed but oversized request is now 413 only after the
  header check.
- `connections.last_webhook_verified_at` (stamped at most once a minute), `last_webhook_rejected_at`,
  `webhook_rejected_total` and the table `webhook_rejections` (per UTC minute and reason from a closed list,
  else `other`). The route is public, so writes are bounded: one upsert per reason per minute per isolate, the
  counts in between are carried in memory (a lower bound under a flood; the first rejection of a minute is
  always written). The rejection log line is sampled (10 per minute per isolate, then one "suppressed" line).
  `GET /api/connections` returns `revolut.webhook = { registered, lastVerifiedAt, lastRejectedAt,
  rejectedLast24h, rejectedTotal, secretReadable (admins only) }`; Phase 8's "webhook failures" rule reads these.
  `secretReadable` is true / false, or null when it could not be checked (a D1 or configuration error is never
  reported as "register again"). An unreadable PREVIOUS (overlap) secret does not block the current one: it is
  ignored and retired by the first delivery verified with the current secret. Rejections are counted only while
  a connection is active / needs_reauth / expired, and `rejectedLast24h` never counts buckets from before
  `connected_at`, so a reconnect starts at zero. Disconnecting resets the connection counters; registering a new
  subscription clears `last_webhook_verified_at`.
- Residual risk (unauthenticated write and read amplification). Per isolate, rejections cost at most one write
  batch (upsert + counter update) per reason code per minute: 11 codes, so at most 11 batches a minute, and in
  practice 1 to 3 (an attacker without the secret reaches `missing_header`, `bad_timestamp`,
  `timestamp_out_of_range`, `malformed` and `bad_signature`). A distributed flood that keeps N isolates busy
  causes at most about 11 x N batches a minute (for example 300 isolates: about 3,300 a minute, 55 a second),
  each touching one row of a table bounded to (reasons x minutes) rows. That is bounded but scales with N, and a
  global guard in D1 cannot help: deciding "already written this minute" is itself a statement per request.
  More important: a request with well-formed headers (a fresh 13-digit timestamp and any `v1=<64 hex>`) passes
  the pre-check and costs two D1 reads (connection, secrets) plus one HMAC per request, unbounded by the app;
  that is inherent (the secret is needed to verify). Mitigation outside the app: a Cloudflare WAF rate-limiting
  rule on `POST /api/webhooks/revolut` (Revolut sends a handful a minute; for example 60 requests per minute per
  IP, block for 10 minutes), recommended in docs/DEPLOY.md.
- `housekeepWebhookEvents` (scheduler tick of minute 3, 13, 23, ... only, so nine idle ticks in ten send no
  statement; on that tick a `settings` claim lets one isolate win and the winner asks one "anything due" query
  first; its failure is caught and never affects job claiming): a `queued` row older than 15 minutes is
  re-enqueued (same MAX_REQUEUES budget as redeliveries) and then ends as `error` (`requeue_exhausted`,
  `never_parsed` for a body that was never parsed, `enqueue_failed` when the queue refuses); finished rows are
  deleted after 30 days (ADR 0011).
- An `unparsed` row is only taken over by a redelivery when it is older than 60 seconds, so two overlapping
  deliveries of one body cannot both enqueue it.

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
6. `/transactions` honours `from`/`count`; a server that caps below seen+1 rows ends a walk early (a known limit of the paging cursor; the daily backfill walk is the safety net).

## Audit and result masking
`maskDeep` (audit before/after and job results) no longer redacts a bare `code` key: it is the machine code of every
job result, and redacting it hid every failure reason. OAuth codes are caught by qualified names (`authorization_code`,
`auth_code`, `oauth_code`, `grant_code`, `code_verifier`); no caller stores a raw OAuth `code`.

## Bank read API (agreed with R3b, ADR 0032)
`legCount` per row (all stored legs of the Revolut transaction, whatever the filter), totals `inMinor`/`outMinor` as
positive magnitudes over pending + completed rows only, `connection` returned for every status, keyset paging on the
index `(connection_id, created_at, id)` (no temp sort; EXPLAIN pinned in a test).
