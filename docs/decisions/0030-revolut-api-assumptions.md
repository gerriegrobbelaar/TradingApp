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
  tolerated and the maximum lifetime (we use 300 s). Key must be PKCS#8; PKCS#1 gets a convert message.
- Consent URL `https://business.revolut.com/app-confirm?client_id&redirect_uri&response_type=code`;
  we add `state`. Revolut may not echo `state`: if so, bind the flow to the signed-in session instead.
- 401 means re-authorise (the gate refreshes once before it gets here). 429 with optional
  `Retry-After` (seconds or HTTP date), default wait 60 s. Real limits (reportedly about 60 per minute) are unknown.

## Endpoints and fields
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
- Headers `Revolut-Signature: v1=<hex>[,v1=<hex>...]` and `Revolut-Request-Timestamp` (epoch ms; seconds tolerated).
  Signed string `v1.{timestamp}.{rawBody}`, HMAC-SHA256 with the signing secret, hex. Verify the exact header
  names, hex vs base64 and the separator. Tolerance 5 minutes both ways, body limit 1 MB.
- Body `{event, timestamp, data}`; `TransactionCreated` data is the transaction (`id, request_id, state`);
  `TransactionStateChanged` data has `id, old_state, new_state`. Verify field names.

## Paging algorithm (transactions)
Each chunk asks for `count + seen` rows with `to` = end of the oldest row's millisecond (inclusive), then
drops ids already seen in that window. A short page means the end. A full page with no new rows throws
`PAGING_STUCK` (more than 1000 rows in one millisecond) instead of skipping. This holds only if `to` is
inclusive and the newest rows come first.

## What the sandbox can verify
Token exchange and refresh, account and transaction field names, state names, counterparty creation,
`from/to/count` semantics, webhook registration and signature format (sandbox can send test events), 429 headers.
It cannot show production rate limits, real card or merchant data, or multi-currency exchange legs reliably.
