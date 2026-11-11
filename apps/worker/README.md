# apps/worker

Cloudflare Worker: HTTP API, webhooks, cron handler, queue consumers, Durable Objects.
Deploying and operating it: [docs/DEPLOY.md](../../docs/DEPLOY.md).

## Sign-in configuration (CLAUDE.md 4.0, ADR 0002)

| Name                   | Kind                  | Purpose                                                                                                                                                             |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | var (`wrangler.toml`) | OAuth client ID. Empty placeholder until the Google Cloud project exists.                                                                                           |
| `OAUTH_REDIRECT_URI`   | var                   | Absolute callback URL, `https://<app host>/api/auth/callback`. Must be registered on the OAuth client. Its origin is the app origin used for the CSRF Origin check. |
| `ALLOWED_HD`           | var                   | Google Workspace domain (`camelthorncapital.com`). Enforced server-side on the ID token `hd` claim.                                                                 |
| `INITIAL_ADMIN_EMAIL`  | var                   | Seeded admin (idempotent).                                                                                                                                          |
| `GOOGLE_CLIENT_SECRET` | secret                | `wrangler secret put GOOGLE_CLIENT_SECRET`                                                                                                                          |
| `SESSION_SECRET`       | secret                | HMAC key (at least 32 random characters) for the sign-in round-trip cookie: `openssl rand -base64 48 \| wrangler secret put SESSION_SECRET`                         |

If any of these is missing or malformed, every route except `/api/health` answers
`500 server_misconfigured` (the log names the missing variables, never values).

## Exact connection configuration (ADR 0015, 0016)

| Name                     | Kind                  | Purpose                                                                                                      |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `EXACT_CLIENT_ID`        | var (`wrangler.toml`) | Client ID of the Exact app registration. Empty placeholder until it exists.                                  |
| `EXACT_REDIRECT_URI`     | var                   | `https://<app host>/api/connections/exact/callback`; must share the origin of `OAUTH_REDIRECT_URI`.          |
| `EXACT_CLIENT_SECRET`    | secret                | `wrangler secret put EXACT_CLIENT_SECRET`                                                                    |
| `TOKEN_ENC_KEY`          | secret                | 32-byte base64 AES-GCM key for stored tokens: `openssl rand -base64 32 \| wrangler secret put TOKEN_ENC_KEY` |
| `TOKEN_ENC_KEY_PREVIOUS` | secret, optional      | Old key, accepted for decryption while rotating.                                                             |

Revolut Business (ADR 0031) adds `REVOLUT_CLIENT_ID`, `REVOLUT_REDIRECT_URI` (https, on the app
origin, path `/api/connections/revolut/callback`) and `REVOLUT_ISSUER` (vars; the issuer is the host
of the redirect URI) and the secret `REVOLUT_PRIVATE_KEY` (unencrypted PKCS#8 PEM, RSA 2048 bits or
more). If any is missing, `/api/connections/revolut/start` and `/callback` answer
`500 server_misconfigured` and `GET /api/connections` reports `revolutConfigured: false`.

If any is missing, `/api/connections/exact/start` and `/callback` answer
`500 server_misconfigured`; `GET /api/connections` still works and reports `exactConfigured: false`.

- `GET /api/connections` (any role): status, expiry, last error code, divisions. Never tokens.
- `GET /api/connections/exact/start` (admin, step-up): redirects to Exact with a signed single-use
  state cookie. `GET .../callback` (admin session that started the flow): exchanges the code,
  stores AES-GCM encrypted tokens, reads `/current/Me` through the gate, stores the division.
- `POST /api/connections/exact/disconnect` (admin, step-up): wipes the tokens.
- Workers code calls Exact only through `createGateTransport(env, division)` (an `ExactTransport`
  backed by the `ExactGate` Durable Object).

## Scheduler configuration (ADR 0020, 0021)

| Name                             | Kind                              | Purpose                                                                                  |
| -------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `[triggers] crons`               | `wrangler.toml`, `* * * * *`      | Scheduler tick. Schedules are edited in Settings, Schedules, never here.                 |
| `JOBS_QUEUE`                     | queue producer, `camelthorn-jobs` | Cron tick and "Run now" enqueue runs; the Worker consumes them (`queue()`).              |
| `camelthorn-jobs-dlq`            | dead-letter queue                 | Runs that could not be started after 3 retries. Nothing consumes it; see docs/DEPLOY.md. |
| `JOB_LOCK` (`JobLock`, tag `v2`) | Durable Object, EU                | One no-overlap lease per job name.                                                       |

Create both queues before the first deploy, in the EU (`wrangler queues create <name> --jurisdiction
eu`, ADR 0028). `wrangler.toml` also has an `[env.staging]` block with its own Worker, database,
queues and objects: `pnpm run check:deploy:staging` and `pnpm run deploy:staging` (ADR 0029,
docs/DEPLOY.md "Staging first"). The Exact sync jobs are off after install; switch them
on in Settings, Schedules after the first-live-connection checks pass (docs/DEPLOY.md step 10).

## Auth API

- `GET /api/auth/login[?step_up=1&return_to=/path]` redirects to Google (PKCE S256, state, nonce;
  `step_up=1` adds `prompt=login&max_age=0`).
- `GET /api/auth/callback` verifies state, exchanges the code, verifies the ID token
  (RS256 only via Google JWKS, iss, aud = our client only, azp, exp/iat with 60 s skew, nonce,
  `email_verified === true`, `hd`, email in the `ALLOWED_HD` domain), requires an enabled user
  or open invite, then sets the `__Host-session` cookie. Each round trip is single-use (claimed in
  `idempotency_keys`, scope `auth.flow`): replaying a callback is denied. Every failure redirects
  to `/?auth=denied`; only a reason code is logged.
- Step-up freshness comes from the ID token's `auth_time`, never from "now": the session's
  `last_auth_at` is set to `auth_time` (or to 1970 if Google sends none), so a silent SSO login
  cannot refresh the 15-minute window. A `step_up=1` callback is denied unless `auth_time` is
  present and at most 5 minutes old. OIDC requires `auth_time` whenever `max_age` is requested;
  if Google ever omits it, step-up fails closed (re-check against Google's docs before go-live).
- `POST /api/auth/logout` (public so a stale cookie is always cleared, CSRF-checked),
  `GET /api/auth/me` (`email`, `roles`, `stepUpFresh`).
- `GET /api/users`, `POST /api/users/invite`, `PATCH /api/users/:id/roles`, `DELETE /api/users/:id`
  (admin only; changes need a sign-in within the last 15 minutes, else `401 step_up_required`).

## Access rules

- Default deny: a route is public only if it says so (`/api/health`, `/api/auth/login`,
  `/api/auth/callback`).
- Roles are not hierarchical. A user holds exactly the roles granted; `admin` does not imply
  `finance`, `approver` or `viewer`. Routes list every role allowed.
- Unsafe methods (anything but GET/HEAD/OPTIONS) need the header `X-Requested-With` (any
  non-empty value), and an `Origin` header, if sent, must equal the app origin.
- Sessions: 12 h idle (sliding), 7 days absolute; only the SHA-256 of the token is stored.
