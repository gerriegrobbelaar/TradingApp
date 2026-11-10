# Deploying Camelthorn Finance

Ordered runbook for the first deploy of the Worker (API plus static web app). Run commands from
`apps/worker` unless noted. Needs a Cloudflare account on the Workers **paid** plan.

## 1. Create the EU D1 database

```sh
wrangler d1 create camelthorn-finance --jurisdiction eu
```

The jurisdiction cannot be changed afterwards. Verify:

```sh
wrangler d1 info camelthorn-finance
```

The output must show jurisdiction `eu` (also visible in the dashboard under Workers & Pages, D1).
If it does not, delete the database and recreate it before any data exists.

Paste the printed id into `database_id` in `apps/worker/wrangler.toml` (replacing the all-zero
placeholder) and commit.

## 2. Set the public variables and route

In `apps/worker/wrangler.toml`:

- `GOOGLE_CLIENT_ID`: from step 4.
- `OAUTH_REDIRECT_URI`: `https://<app host>/api/auth/callback`. Its origin is also the CSRF origin.
- `INITIAL_ADMIN_EMAIL`, `ALLOWED_HD`: check they are right.
- Uncomment and set `routes` for your hostname. `workers_dev` and `preview_urls` stay `false`.

## 3. Set the secrets

```sh
wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 48 | wrangler secret put SESSION_SECRET
```

Secrets live only in Workers secrets, never in the repo. If the Worker does not exist yet,
`wrangler secret put` offers to create it; accept.

## 4. Register the redirect URI in Google Cloud

In the Google Cloud project that owns the OAuth client (open decision 8 in CLAUDE.md): create an
OAuth client of type Web application and add the authorised redirect URI exactly equal to
`OAUTH_REDIRECT_URI`. Copy the client ID into `wrangler.toml` (step 2) and the client secret into
step 3. For local development also register `http://localhost:5173/api/auth/callback`.

## 5. Apply migrations

```sh
wrangler d1 migrations apply camelthorn-finance --remote
```

## 6. Build and deploy

```sh
pnpm install --frozen-lockfile
pnpm --filter @camelthorn/web build
cd apps/worker && wrangler deploy
```

`wrangler deploy --dry-run` (also run in CI) checks the bundle and config without publishing.

## 7. First sign-in with the seeded admin

1. Open `https://<app host>/api/health`: expect 200.
2. Open the app and sign in with the Google account of `INITIAL_ADMIN_EMAIL`. The admin is seeded
   when the Worker first handles a request, once per database.
3. Check Settings, Users shows that account with role `admin`.
4. Check the audit log has a `user.seed_admin` entry.

## 8. Verification checklist

Security headers (served from `apps/web/public/_headers`):

- [ ] `curl -sI https://<app host>/` shows Content-Security-Policy, Strict-Transport-Security,
      X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
- [ ] The browser console shows no CSP violations on first load, in light and dark.

Step-up and `auth_time` (CLAUDE.md 4.0, apps/worker/README.md):

- [ ] Sign in, wait until the last interactive Google sign-in is older than 15 minutes (or edit
      nothing and simply wait), then try an admin change such as inviting a user: expect
      `401 step_up_required`, and the app re-prompts with Google (`prompt=login`).
- [ ] After the re-prompt the same change succeeds.
- [ ] A silent single-sign-on login (no password prompt) does not refresh the step-up window.
- [ ] Google actually returns `auth_time` in the ID token when `max_age` is requested. If it does
      not, step-up fails closed (every step-up is denied); stop and re-check Google's docs.
- [ ] A sign-in from an account outside `ALLOWED_HD`, or not invited, is denied
      (`/?auth=denied`).
- [ ] Removing a user ends their sessions immediately.

Observability: `wrangler tail` shows request logs; logs contain no tokens, keys, full IBANs or
email bodies.
