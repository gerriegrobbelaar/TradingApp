# Deploying Camelthorn Finance

Ordered runbook for the first deploy of the Worker (API plus static web app). Needs a Cloudflare
account on the Workers **paid** plan and the app hostname on a zone in that account.

Run `wrangler` through the workspace copy so the version matches the lockfile (checked with
wrangler 4.160): from the repo root, `pnpm --filter @camelthorn/worker exec wrangler <command>`,
or `cd apps/worker && pnpm exec wrangler <command>`. The commands below assume you are in
`apps/worker` and write `pnpm exec wrangler`. Sign in once with `pnpm exec wrangler login`.

## 1. Create the EU D1 database

```sh
pnpm exec wrangler d1 create camelthorn-finance --jurisdiction eu
```

The jurisdiction cannot be changed afterwards. Keep the printed output: it shows the new
`database_id`.

Verify the jurisdiction (**unverified procedure**: `wrangler d1 info` prints whatever fields the
Cloudflare API returns, and we have not yet confirmed against a real account that the API includes
the jurisdiction):

```sh
pnpm exec wrangler d1 info camelthorn-finance --json
```

- If the JSON has `"jurisdiction": "eu"`, you are done.
- If there is no `jurisdiction` field, check the database in the dashboard (Storage and
  databases, D1, the database's settings / overview) for jurisdiction or location "EU". If you
  cannot confirm EU from either, ask Cloudflare support before storing any data.
- If it shows anything other than EU: delete the database
  (`pnpm exec wrangler d1 delete camelthorn-finance`) and recreate it before any data exists.

Record what you saw (command output or screenshot, date) in `docs/decisions/` and replace the
"unverified" label here with the confirmed procedure.

Paste the `database_id` into `apps/worker/wrangler.toml`, replacing the all-zero placeholder.

## 2. Create the Google OAuth client

In the Google Cloud project that owns the OAuth client (open decision 8 in CLAUDE.md): create an
OAuth client of type Web application with the authorised redirect URI
`https://<app host>/api/auth/callback`. For local development also add
`http://localhost:5173/api/auth/callback`. Keep the client ID and client secret for steps 3 and 4.

## 3. Set the public variables and route

In `apps/worker/wrangler.toml`:

- `GOOGLE_CLIENT_ID`: the client ID from step 2.
- `OAUTH_REDIRECT_URI`: exactly the redirect URI registered in step 2. Its origin is also the
  CSRF origin.
- `INITIAL_ADMIN_EMAIL`, `ALLOWED_HD`: check they are right.
- `EXACT_CLIENT_ID` and `EXACT_REDIRECT_URI`: from the Exact Online app registration (see
  "Exact Online app" below). The redirect URI must be `https://<app host>/api/connections/exact/callback`,
  on the same origin as `OAUTH_REDIRECT_URI`.
- Uncomment one `routes` line and set your hostname (same host as `OAUTH_REDIRECT_URI`).
  `workers_dev` and `preview_urls` stay `false`.

Check nothing is left over, then commit:

```sh
pnpm run check:deploy
```

It fails while the all-zero `database_id`, an empty `GOOGLE_CLIENT_ID` or `EXACT_CLIENT_ID`, an
`app.example.com` redirect URI (Google or Exact) or a missing route remain.

## 4. Set the secrets

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 48 | pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put EXACT_CLIENT_SECRET
# 32 random bytes, base64: encrypts the stored Exact tokens (AES-256-GCM). Keep a copy in your
# password manager; losing it means reconnecting Exact.
openssl rand -base64 32 | pnpm exec wrangler secret put TOKEN_ENC_KEY
```

Rotating `TOKEN_ENC_KEY`: put the old value in `TOKEN_ENC_KEY_PREVIOUS`, set the new
`TOKEN_ENC_KEY`, deploy. Tokens are rewritten with the new key at their next refresh (within
minutes while the connection is used); then delete `TOKEN_ENC_KEY_PREVIOUS`.

### Exact Online app

Register an app at the Exact App Center (apps.exactonline.com, "Register API keys") with the
redirect URI above. Copy its client ID into `EXACT_CLIENT_ID` and its secret into
`EXACT_CLIENT_SECRET`. Then, signed in as an admin with a fresh Google sign-in, use Settings,
Connections, "Connect Exact Online". The first real connection is unverified: see
`docs/decisions/0015-exact-oauth-assumptions.md` for what to check.
Secrets live only in Workers secrets, never in the repo. If the Worker does not exist yet,
`wrangler secret put` offers to create it; accept.

## 5. Apply migrations

```sh
pnpm exec wrangler d1 migrations apply camelthorn-finance --remote
```

## 6. Build and deploy

From the repo root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @camelthorn/web build
pnpm --filter @camelthorn/worker run deploy
```

`run deploy` runs the placeholder check, then `wrangler deploy`. Do not call `wrangler deploy`
directly: it skips the check. `wrangler deploy --dry-run` (also run in CI) checks bundle and
config without publishing; it does not check for placeholders.

## 7. First sign-in with the seeded admin

1. Open `https://<app host>/api/health`: expect 200 `{"ok":true}`.
2. Open the app and sign in with the Google account of `INITIAL_ADMIN_EMAIL`. The admin is seeded
   when the Worker first handles a request (after the migrations of step 5), once per database.
3. Check Settings, Users shows that account with role `admin`.
4. Check the audit log has a `user.seed_admin` entry:
   `pnpm exec wrangler d1 execute camelthorn-finance --remote --command "SELECT actor_email, action, at FROM audit_log WHERE action = 'user.seed_admin'"`.

## 8. Verification checklist

Security headers (static assets from `apps/web/public/_headers`; API JSON from the Worker):

- [ ] `curl -sI https://<app host>/` and `curl -sI https://<app host>/some/deep/link` (SPA
      fallback) show Content-Security-Policy, Strict-Transport-Security, X-Content-Type-Options,
      Referrer-Policy, Permissions-Policy.
- [ ] `curl -sI https://<app host>/api/health` shows `cache-control: no-store` and
      `x-content-type-options: nosniff` (set by the Worker JSON helper, added in task F1; not covered by `_headers`).
- [ ] The browser console shows no CSP violations on first load, in light and dark.

Step-up and `auth_time` (CLAUDE.md 4.0, apps/worker/README.md):

- [ ] Sign in, wait until the last interactive Google sign-in is more than 15 minutes old, then
      try an admin change such as inviting a user: expect `401 step_up_required`, and the app
      offers a fresh Google sign-in (`prompt=login`).
- [ ] After the re-prompt the same change succeeds.
- [ ] A silent single-sign-on login (no password prompt) does not refresh the step-up window.
- [ ] Google actually returns `auth_time` in the ID token when `max_age` is requested. If it does
      not, step-up fails closed (every step-up is denied); stop and re-check Google's docs.
- [ ] A sign-in from an account outside `ALLOWED_HD`, or not invited, is denied
      (`/?auth=denied`).
- [ ] Removing a user ends their sessions immediately.
- [ ] `https://camelthorn-finance.<account>.workers.dev` does not answer (workers_dev is off).

Observability: `pnpm exec wrangler tail` shows request logs; logs contain no tokens, keys, full
IBANs or email bodies.
