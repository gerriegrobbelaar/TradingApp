# 0030 Revolut Business API assumptions (verify with credentials)

Status: provisional. Written from memory with no network access and no credentials. Every item is
**verify with credentials** (https://developer.revolut.com/docs/business/business-api). Fixtures in
`packages/revolut/test` encode these guesses; fix both together.

## Transport and auth
- Base `https://b2b.revolut.com/api/1.0` (sandbox `sandbox-b2b.revolut.com`); webhooks under `/api/2.0`.
  The client paths exclude host and version prefix; `apiVersion: '2.0'` selects webhooks.
- Token: `POST /auth/token`, form body, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`.
  Response `access_token`, `token_type=bearer`, `expires_in` (about 2399 s, 40 min), `refresh_token`
  only on the code exchange. Whether the refresh token rotates or expires: verify.
- Client assertion: RS256 JWT, claims `iss` (host of the registered redirect URI, no scheme),
  `sub` (client id), `aud` `https://revolut.com`, `exp`; we also send `iat` and `jti`. Verify the extras are
  tolerated and the maximum lifetime (we use 300 s, allow 1..3600). Key must be unencrypted RSA PKCS#8 of at
  least 2048 bits; PKCS#1 gets a convert message, EC/Ed25519/encrypted keys a clear refusal. PEM parsing
  accepts CRLF and literal `\n` / `\r\n` (one-line secrets). Errors never quote key material.
- `client_id`, `jti` and tokens must be printable ASCII (they go into JSON claims, URLs and headers); a token
  with spaces or CR/LF is refused (header injection). `expires_in` must be an integer 1..604800; a missing
  `token_type` is read as bearer (lenient, verify), any other value is refused.
- Consent URL: `redirect_uri` must be https without credentials or fragment; all parameters are
  percent-encoded, so nothing in `redirect_uri` or `state` can add parameters.
- Consent URL `https://business.revolut.com/app-confirm?client_id&redirect_uri&response_type=code`;
  we add `state`. Revolut may not echo `state`: if so, bind the flow to the signed-in session instead.
- 401 means re-authorise (the gate refreshes once before it gets here). 429 with optional
  `Retry-After` (delta-seconds or IMF-fixdate), default wait 60 s, clamped to 0..15 min; garbage, negative
  or fractional values give the default. 429 is never retried inside the client (the gate decides); GET 5xx
  is retried twice (500 ms, 2 s); POST/DELETE/PATCH never. Error messages quote only a JSON `message`
  field, redacted; non-JSON error bodies are never quoted. Real limits (reportedly about 60 per minute) are unknown.

## Endpoints and fields
- Amounts are exact decimals in major units (JSON number or string). They are converted to integer minor
  units at the ISO 4217 scale from core `currencyScale` (codes without an exception, including unknown
  ones, use 2). More decimals than the scale ("0.005" EUR, "1.5" JPY, "1e-7") is an error, never rounded:
  Revolut should not send them, and if it does we want to know. Beyond `Number.MAX_SAFE_INTEGER` minor
  units is an error. Verify Revolut's scale for JPY/HUF-style currencies (HUF is 2 in ISO 4217, but some
  providers send 0 decimals; 0 decimals parse fine at scale 2).
- `GET /accounts`: `id, name, balance (decimal, major units), currency, state (active|inactive), public, created_at, updated_at`.
- `GET /accounts/{id}/bank-details`: list with `iban, bic, account_no, sort_code, routing_number, beneficiary, bank_country, pooled, unique_reference, schemes[]`.
- `GET /transactions`: query `from, to` (on `created_at`, both **inclusive**), `count` (max 1000, default
  100), `account`, `type`. Returns a plain array, **newest first**, no page token. Timestamps may carry
  microseconds. Verify inclusivity, ordering, that fewer than `count` rows means the end, and the precision.
- `GET /transaction/{id}` (singular), `?id_type=request_id` for our idempotency key.
- Transaction: `id, type, request_id, state, reason_code, created_at, updated_at, completed_at, reference,
  merchant{name,city,category_code,country}, card{card_number}`, `legs[]{leg_id, account_id, amount (signed),
  fee, currency, bill_amount, bill_currency, balance, description, counterparty{id,type|account_type,account_id,name,iban}, card}`.
  Transfers between own accounts and exchanges have two legs; (transaction id, leg id) is the unique key.
- States: `pending, completed, declined, failed, reverted`. Anything else maps to `unknown` (never booked).
  Verify there is no other state (for example `created`) and that `pending` is non-final.
- `GET /counterparties`: `id, name, profile_type, country, state, created_at, updated_at, accounts[]{id,currency,type,iban,bic,account_no,sort_code}`;
  paging by `count` (max 1000) and `created_before` (assumed strict). Verify both.
- Webhooks v2: `GET|POST /webhooks`, `DELETE /webhooks/{id}`; create body `{url, events}`, response includes
  `signing_secret`. List shape may be an array or `{webhooks: []}`; both are accepted.

## Webhook signature and body
- Headers `Revolut-Signature: v1=<hex>[,v1=<hex>...]` and `Revolut-Request-Timestamp` (epoch **milliseconds**).
  Signed string `v1.{timestamp}.{rawBody}` (timestamp = trimmed header text, body = raw bytes), HMAC-SHA256
  keyed with the UTF-8 bytes of the signing secret, hex (either case). Verify the exact header names, hex vs
  base64, the separator and whether the key is the secret string as is (with any `wsk_` prefix).
- Unit rule: only a 13-digit millisecond timestamp is accepted. A seconds value (10 digits) or microseconds
  is `bad_timestamp`, not guessed at. If the sandbox shows seconds, change `TS_MS_RE` and this ADR together.
- Tolerance 5 minutes both ways (callers may tighten, never widen); body limit 1 MB, checked before hashing;
  at most 5 signature candidates (rotation); a malformed `v1=` entry next to a good one is skipped. A
  repeated header joined by `Headers.get()` (", ") is handled; a repeated timestamp header is refused.
  Empty or blank signing secret throws (fail closed). Non-finite clock or tolerance throws.
- The verifier never parses the body. The HTTP layer (R3) must pass `request.arrayBuffer()` (text() drops a
  BOM and replaces invalid UTF-8, which changes the signed bytes), return the same plain 401 for every
  failure reason (reasons go to internal logs only), and only then enqueue.
- Replays inside the 5-minute window cannot be detected by the verifier: the ingest dedupes (transaction id
  + state, idempotent upsert), which also absorbs Revolut's own retries (3 more, 10 minutes apart).
- Body `{event, timestamp, data}`; `TransactionCreated` data is the transaction (`id, request_id, state`);
  `TransactionStateChanged` data has `id, old_state, new_state`. Verify field names.

## Paging algorithm (transactions)
Each chunk asks for `count + seen` rows (max 1000) with `to` = one millisecond past the oldest row of the
previous page (never above the caller's `to`), then drops ids already seen. Why it is complete:
- Revolut returns the newest `requested` rows with `created_at <= to`, newest first (assumed; a page that is
  not in non-increasing `created_at` order is `PAGING_ORDER`). So every row strictly newer than the page's
  oldest row is in this page or an earlier one.
- The rows sharing the oldest row's millisecond come back on the next call whether `to` is inclusive or
  exclusive and whatever their microseconds, because the bound is one millisecond past them. The ones already
  returned are known by id; the cursor carries only ids at or below the next bound (bounded, JSON-safe).
- A full page with no new row means more rows share two adjacent milliseconds than a call can carry:
  `PAGING_STUCK`, never a silent skip. A walk stops after `maxChunks` (default 1000) with `PAGING_LIMIT`.
- By default the walk ends only on a short page with **no new rows**: one extra call per walk, but complete if
  Revolut caps `count` below 1000 or returns short pages before the end (as long as a page still holds more
  rows than share one boundary). `trustShortPage: true` ends on the first short page; switch it on only after
  the sandbox confirms short means end.
- Not a snapshot: a row returned again at the boundary with a newer state is dropped as seen; within one
  response the later `updated_at` wins. Consumers upsert by (transaction id, leg id) keeping the newest
  `updated_at`; webhooks and the next run deliver state changes. Rows created during a walk above its first
  page are picked up by the next walk. `from` inclusivity is assumed: overlap consecutive windows.
- Bounds: `from`/`to` are `YYYY-MM-DD` (midnight UTC, verify how Revolut reads a date-only value) or an ISO
  date-time with zone; `from > to` is refused. Not defended: a server that truncates `to` to whole seconds,
  or that returns a page with only already-seen rows before the end (indistinguishable from the end).

## Redaction
One `sanitizeForMessage` / `maskIbans` in `packages/core/src/redact.ts`, used by Exact and Revolut. IBANs are
matched case-insensitively with optional single spaces and masked to the registry length of their country, so
following words are kept and adjacent IBANs are masked separately (the old Exact regex swallowed up to 30
characters of following text). A candidate must not start inside a longer token, so an IBAN glued to a
preceding letter or digit ("x1NL91...") is not masked: accepted, because such text does not come from
Revolut or Exact fields. Also redacted: PEM blocks, long mixed-case base64 runs, bearer tokens, JWTs,
`v1=` signatures and token/secret/code key-value pairs.

## What the sandbox can verify
Token exchange and refresh, account and transaction field names, state names, counterparty creation,
`from/to/count` semantics, webhook registration and signature format (sandbox can send test events), 429 headers.
It cannot show production rate limits, real card or merchant data, or multi-currency exchange legs reliably.
