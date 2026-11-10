# apps/worker

Cloudflare Worker: HTTP API, webhooks, cron handler, queue consumers, Durable Objects.

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

## Auth API

- `GET /api/auth/login[?step_up=1&return_to=/path]` redirects to Google (PKCE S256, state, nonce;
  `step_up=1` adds `prompt=login&max_age=0`).
- `GET /api/auth/callback` verifies state, exchanges the code, verifies the ID token
  (RS256 via Google JWKS, iss, aud, exp, nonce, `email_verified`, `hd`), requires an enabled user
  or open invite, then sets the `__Host-session` cookie. Every failure redirects to `/?auth=denied`.
- `POST /api/auth/logout`, `GET /api/auth/me` (`email`, `roles`, `stepUpFresh`).
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
