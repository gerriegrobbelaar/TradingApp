# 0031 Revolut Business connection: gate, tokens, connect flow

Status: accepted for Phase 5 (task R2). Everything marked **verify with credentials** is an
assumption about the Revolut Business API that has not been checked against a live sandbox.
Re-check Revolut's current docs before the first connection and amend this ADR.

## Context

Phase 5 connects Revolut Business (CLAUDE.md section 3): OAuth with a client assertion (JWT signed with
our private key), short-lived access tokens, webhooks, and later payments. The Exact side already has
the pattern (ADRs 0013, 0015, 0016, 0018, 0019, 0021, 0029). This task adds the storage, the
`RevolutGate` Durable Object, the connect flow and the Connections screen. The typed client, auth
helpers and webhook verification are task R1 (ADR 0030, Revolut API assumptions); sync, webhook
route and the Bank screen are R3.

## Decisions

### Data

- Migration `0013`. `connections` gets `revolut_environment` (`production`|`sandbox`),
  `payments_mode` (`drafts`|`pay`, default `drafts`), `bank_entries_decided_at`, `webhook_id`,
  `webhook_secret_enc`, `webhook_secret_prev_enc`, and for a staged connection `pending_until`,
  `pending_ref`, `pending_by`, `pending_summary` (all `ADD COLUMN`, no rebuild). The Revolut client id
  is configuration (a Workers var), not per connection.
- `creates_bank_entries` (`NOT NULL DEFAULT 0` since 0012, so "undecided" cannot live in that
  column) is written **explicitly** at connect time from the admin's choice;
  `bank_entries_decided_at` records when. `bank_entries_decided_at IS NULL` means never decided (the
  API reports `createsBankEntries: null`): later phases must refuse to book bank entries for such a
  connection. `1` = this app creates the bank entries in
  Exact; `0` = Revolut's own Exact integration (or someone else) does, and this app only matches.
- `bank_transactions` is rebuilt (review S11): unique `(connection_id, external_id, leg_id)` with
  `leg_id TEXT NOT NULL DEFAULT ''`, because one Revolut transaction (a transfer between own accounts,
  an exchange) has several legs with the same transaction id. The state CHECK also allows `unknown`
  (a state we do not know is stored, not dropped). Added: `type`, `request_id`, `completed_at`,
  `updated_at`, `raw_state_changed_at`, `first_seen_at`, `last_event_at`, `source`
  (`webhook`|`poll`|`backfill`), and `is_final` as a generated column (it can never disagree with
  `state`; named `is_final`, not `final`, to stay clear of SQL keywords). `created_at` now means the
  bank-side creation time (for migrated rows: `booked_at`); the old row-creation time moved to
  `first_seen_at`. `match_suggestions` (`ON DELETE CASCADE`) and `matches` reference the table, and
  `DROP TABLE` fires foreign key actions even with `defer_foreign_keys`, so both children are copied
  aside and recreated (tested on a populated database).
- `bank_accounts` gets `bic`, `state`, `is_active`, `created_at`, `updated_at` (nullable or constant
  defaults: `ADD COLUMN` cannot use `strftime`). IBANs are full in D1, masked in audit rows, never
  logged.
- `webhook_events` (idempotency and audit without bodies): SHA-256 of the body plus ids and a status,
  unique `(connection_id, event_hash)`. R3 fills it.

### Tokens and secrets

- Access and refresh tokens and the webhook signing secrets are AES-GCM encrypted with the existing
  helper; the AAD is `revolut:<connection id>:<access|refresh|webhook_secret|webhook_secret_prev>`.
  A refresh always re-encrypts the refresh token with the current `TOKEN_ENC_KEY` (even when Revolut did
  not rotate it), so a key rotation completes after one refresh cycle. The webhook signing secrets are re-encrypted
  with the current key at the same moment (the gate's refresh calls `reencryptWebhookSecrets`) and
  lazily when a delivery had to be verified with a secret still under the previous key; each rewrite
  is a compare-and-swap on the old ciphertext and is not audited (the plaintext does not change).
  Without this, dropping `TOKEN_ENC_KEY_PREVIOUS` would make every delivery fail verification.
  A secret that cannot be decrypted with either key is reported to admins as
  `webhookSecretReadable: false` in `GET /api/connections`; "Register webhook again" replaces it
  (the unreadable value is discarded instead of kept as the previous secret).
- Config: vars `REVOLUT_CLIENT_ID`, `REVOLUT_REDIRECT_URI`, `REVOLUT_ISSUER`; secret
  `REVOLUT_PRIVATE_KEY` (PKCS#8 PEM). `REVOLUT_ISSUER` must be the host of `REVOLUT_REDIRECT_URI` and the
  redirect URI must be on the app origin at `/api/connections/revolut/callback` (checked at runtime
  and by the deploy guard, both environments). The webhook URL is **derived**
  (`<app origin>/api/webhooks/revolut`), not a variable.
- Only the connect callback and the gate talk to the token endpoint. Callers cannot (not on the
  path allow-list).

### RevolutGate

- One Durable Object per connection, `revolut:<connectionId>`, EU jurisdiction through `getEuObject`
  (ADR 0018), migration tag `v3`, binding `REVOLUT_GATE`. Unlike Exact, Revolut has one API host and one
  rate-limit scope per connection, so the instance is **also the token authority**: single-flight
  refresh follows from there being exactly one instance per connection. The instance pins itself to
  its connection id on first use and refuses any other id (for calls and for refreshes), the same
  role-pinning idea as Exact's.
- Refresh: `grant_type=refresh_token` with a client assertion; access token lifetime assumed 40 minutes
  (the real expiry comes from `expires_in`), refresh when 60 s or less are left, never earlier without a
  reason (a 401 on the stored token is one; it forces one refresh and one retry). If a new refresh token
  comes back it is persisted **before** the new access token is used; after two failed D1 writes a
  rotated pair is stashed (ciphertext) in Durable Object storage and retried by an alarm. Without
  rotation a failed write only costs a repeat refresh.
- Failure classes as for Exact: only a clear `invalid_grant` wipes the tokens and sets
  `needs_reauth` (audited); `invalid_client` / 401 from the token endpoint repeated 3 times over a
  minute sets `last_error = token_endpoint_rejected_credentials` (status stays `active`, tokens kept, one
  audit row; the UI shows "Configuration problem"); every other failure (5xx, unclassifiable, malformed
  2xx) is retryable (503) and keeps the tokens.
- Rate limit: sliding window, **60 requests per minute** (assumption; configurable `limits.perMinute`),
  user priority before job priority with a burst bound so jobs are delayed, never starved, per-job
  budgets (`startJob`/`endJob`, default 200 per run, explicit budget from the job), 429 handling
  (`Retry-After` seconds or date, default 60 s, capped at 1 h). There is no daily budget: Revolut
  documents none that we know of. A queued request that would wait over 90 s fails with a retryable
  error.
- Request validation: a strict allow-list of method + path + API version, anchored regexes, no
  trailing slash, no percent-encoding, UUID account ids (`GET /accounts`, `/accounts/{uuid}`,
  `/accounts/{uuid}/bank-details`, `/transactions`, `/transaction/{id}`, `/counterparties`; on API
  2.0 `POST /webhooks`, `DELETE /webhooks/{uuid}` and, only for the job id `revolut-webhook-recover`,
  `GET /webhooks` (a list can hold signing secrets, so it is never stored or logged). Listing, recovery
  and rotation ("Register webhook" with `replace: true`) are built, see ADR 0033). A created subscription must point at this app's own
  webhook URL (`<redirect URI origin>/api/webhooks/revolut`), checked in the gate. The host is fixed by the connection's environment
  (`b2b.revolut.com` or `sandbox-b2b.revolut.com`), redirects are never followed, caller headers are
  limited to `content-type` and `accept`. **Payment endpoints (`/pay`, `/payment-drafts`, `/transfer`,
  counterparty creation) are not on the list in this phase**; Phase 9 adds them behind four-eyes
  controls. A test asserts they are refused.
- A `pending` (staged, unconfirmed) connection serves only `GET /accounts` and
  `GET /accounts/{uuid}/bank-details` on API 1.0, only for the connect call (`priority: user`,
  `jobId: revolut-connect`) and only while `pending_until` is in the future. No job, no webhook, no
  refresh.
- The token authority (`#refreshAccessToken`) is a JS-private method: Workers RPC exposes every
  public Durable Object method, and this one returns a plaintext access token. A token Revolut
  issued with a short `expires_in` (two margins or less) is refreshed at half its lifetime, not on
  every call. While a rotated pair is stashed after a D1 failure, calls take the token from the
  stash, not D1's stale one.

### Connect flow

- `GET /api/connections/revolut/start?environment=&creates_bank_entries=&payments_mode=`: admin +
  step-up. `environment` and `creates_bank_entries` are **required** (400 otherwise; no default),
  `payments_mode` defaults to `drafts`. The choices travel in the signed flow cookie
  (`__Host-revolut-oauth`, bound to the admin's email, 10 minutes). Switching environment while a
  connection exists is refused (409): disconnect first (the webhook subscription and the data belong
  to one Revolut account).
- Callback: admin; same session as started the flow; single-use `state` claimed (scope `revolut.flow`)
  before the code is spent; the exchange uses the client assertion; tokens are **staged** as `pending`
  together with the audit row (ADR 0013), then the gate reads the account list and bank details and
  stores a summary of masked facts (account names, currencies, account holder names, last 4 of each
  IBAN, how many accounts match the ones connected before; never a full IBAN, balance or id). If the
  read fails, the staged tokens are wiped (`disabled`, `last_error = verification_failed`).
- **Account substitution defence (review R2).** Whether Revolut echoes `state` on the consent
  redirect is unverified. Without it the callback cannot prove the code came from the flow this
  browser started: an attacker could make an admin's browser deliver the attacker's code and connect
  the attacker's Revolut account. So: when `state` is echoed it must match (else refused); when it is
  missing the flow is bound by the signed cookie only, which is allowed **only because** a staged
  connection is useless until `POST /api/connections/revolut/confirm` (admin + step-up, body
  `{ref, ownAccount: true}`; `ref` is a random id of the staging the admin saw, so a newer staging is
  never confirmed blindly; `replacesAccounts: true` is also required when none of the accounts match
  the ones connected before). Unconfirmed stagings expire after **15 minutes**: tokens wiped,
  `last_error = pending_expired`, audited (`connection.revolut_pending_expired`), swept lazily by the
  connections list, start, callback and confirm; the gate refuses an expired staging on its own.
  "Cancel, not our account" is a disconnect. Start is refused (409 `already_connected`) while a
  connection is active, so a substituted code can never replace a working connection; re-authorising
  is for `needs_reauth` / `expired`. Audit actions: `revolut_staged`, `revolut_verification_failed`,
  `revolut_confirmed`, `revolut_pending_expired`, `revolut_disconnected` (`wasStaged`).
- `POST .../disconnect`: admin + step-up, idempotent, deletes the webhook subscription best effort while
  the tokens still work (outcome in the audit row), then wipes tokens and webhook secrets.
- `PATCH .../settings`: admin; changing `creates_bank_entries` or `payments_mode` needs a fresh
  sign-in (a no-op does not); audited with before and after. `payments_mode = pay` is stored but has no
  effect until Phase 9; the UI says so.
- `GET /api/connections` carries `revolutConfigured` and, for the Revolut row, `environment`,
  `createsBankEntries` (`null` = undecided) and `paymentsMode`. Never a token, key or secret.

## Assumptions to verify with credentials

1. Access token lifetime about 40 minutes; `expires_in` is present and in seconds.
2. A refresh does not return a new refresh token (we handle one if it does).
3. Rate limit: no documented figure; 60 per minute is a guess. 429 carries `Retry-After`.
4. Client assertion claims: `iss` = host of the redirect URI, `sub` = client id, `aud` =
   `https://revolut.com`, RS256, short expiry (R1 builds it).
5. Consent URL `https://business.revolut.com/app-confirm` (sandbox `sandbox-business.revolut.com`)
   with `client_id`, `redirect_uri`, `response_type=code`; whether Revolut echoes a `state` parameter
   back is **unverified**. Handled either way by the staged-then-confirmed flow above.
6. Token endpoint `POST https://<api host>/api/1.0/auth/token` with form fields `grant_type`, `code` /
   `refresh_token`, `client_id`, `client_assertion_type`, `client_assertion`; error bodies follow RFC
   6749 (`invalid_grant`, `invalid_client`).
7. `GET /accounts` on API 1.0 returns a JSON array of objects with a string `id`.
8. Webhook management paths and payloads on API 2.0 as listed in the allow-list (R3 verifies).
9. Whether a `TransactionStateChanged` for a transfer carries leg ids (the schema allows both).

## Refresh-token expiry (review N8)

`connections.refresh_expires_at` (nullable, migration 0016) is set when a token response carries a
refresh lifetime (`refresh_token_expires_in`, whole seconds, 1 s to 10 years; anything else is
ignored) and kept when a later response omits it. `GET /api/connections` returns it as
`refreshExpiresAt` (null = unknown) for Phase 8's "expiring connection" rule.
**Open item:** Revolut's documentation we have names no refresh-token lifetime; the often-quoted
90-day re-consent for Business API access is unverified. Until a live sandbox connection shows
whether the answer carries a lifetime, the field stays null and the only signal is a
`needs_reauth` after `invalid_grant`. Ask Revolut / check in the sandbox before Phase 8.

## Consequences

- One more Durable Object class and migration tag; the deploy guard checks the binding, `v3`, the
  three vars and that the private key is not in `[vars]`, in both environments.
- R1's `packages/revolut` (`buildClientAssertion`, `buildAuthorizeUrl`, `buildTokenRequestBody`,
  `parseTokenResponse` returning `expiresInSeconds` and an optional `refreshToken`) is used through one
  adapter, `apps/worker/src/revolut/oauth.ts`; the account check uses R1's client through the gate.
- `REVOLUT_REDIRECT_URI` must be https (R1's consent URL builder and Revolut require it), so local
  development of the connect flow needs an https tunnel.
