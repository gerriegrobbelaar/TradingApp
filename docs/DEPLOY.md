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

**Durable Objects are EU-only too.** The code creates every `ExactGate` object through
`env.EXACT_GATE.jurisdiction("eu")` (docs/decisions/0018). Object ids depend on the jurisdiction,
so this is fixed from the first deploy: do not remove it later. There is no variable or binding
that switches the jurisdiction off (only the vitest setup file can, in code); the deploy check also
refuses a leftover `DO_JURISDICTION_DISABLED`. After the first deploy, confirm in the dashboard
(Workers, Durable Objects) that the `ExactGate` objects are listed under the EU jurisdiction.
Local `wrangler dev` (workerd) does not implement jurisdictions, so Exact calls fail there with
"Jurisdiction restrictions are not implemented in workerd"; use `wrangler dev --remote` to try the
Exact connection before deploying (it runs on Cloudflare's network against the real D1 and
Durable Objects of the account, so use a test deployment or a throwaway database, not production
data).

**Durable Object migration tag.** `wrangler.toml` declares the class once, in `[[migrations]]` with
`tag = "v1"` and `new_sqlite_classes = ["ExactGate"]`. Never edit or reuse a tag that has been
deployed: a new Durable Object class or a rename needs a new `[[migrations]]` entry with the next
tag (`v2`). The deploy check refuses a config without the `ExactGate` binding or its migration.

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

- `[triggers] crons = ["0 * * * *"]` must stay. It is the only thing that refreshes Exact data
  (an hourly tick; the handler decides from the Amsterdam clock which tick is the 02:00 full
  sync, see `apps/worker/src/exact/scheduled.ts`). Cron Triggers run on the deployed Worker only,
  never in `wrangler dev` unless started with `--test-scheduled`. Phase 3 replaces this stopgap
  with the jobs table and Queues.

Check nothing is left over, then commit:

```sh
pnpm run check:deploy
```

It fails while the all-zero `database_id`, an empty `GOOGLE_CLIENT_ID` or `EXACT_CLIENT_ID`, an
`app.example.com` redirect URI (Google or Exact), a missing route, a missing `[triggers]` cron or
a missing `ExactGate` binding or migration remain.

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
`docs/decisions/0016-exact-oauth-assumptions.md` for what to check.
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

## 9. Exact first-live-connection checklist

Nothing in the Exact integration has run against the real service yet. Do these in order on a TEST
division (or an administration you can afford to get wrong) before relying on any Exact data. Each
item names the ADR that lists what was assumed; record the real answer next to the assumption and
fix the constant or parser it names.

1. **Jurisdictions.** D1 created with `--jurisdiction eu` and the `ExactGate` objects listed under
   EU (step 1, ADR 0018).
2. **OAuth endpoints.** Authorize and token endpoints, secret in the form body, `expires_in` (600,
   a string), redirect URI match (ADR 0016 items 1-3, 13).
3. **Refresh.** Rotation, the minimum token age (refresh at age 540 s, 570 s and 580 s; record the
   early answer's status and body), the `invalid_grant` body, the 30-day refresh lifetime
   (ADR 0016 items 4, 5, 16, 17, checklist 1-4).
4. **`/current/Me`** fields `UserID, CurrentDivision, DivisionCustomer, DivisionCustomerName`, and
   `system/Divisions` incl. the `Currency` field. A 400 on `$select` means a wrong field name
   (ADR 0014 items 1-2). Check that `divisions.base_currency` and `base_currency_read_at` were
   filled after the first sync, and that only the `/Me` division has `sync_enabled = 1`.
5. **Rate-limit headers.** Names, reset unit (ms or s), whether the minute window is rolling or
   clock-aligned, the daily reset time, the 429 body, whether `Retry-After` is sent, and whether
   429 answers count against the limit. Watch a full minute under load (ADR 0014 item 12,
   ADR 0016 items 8, 18, ADR 0017 verify 12).
6. **`/sync/CRM/Accounts`.** `$select`, `Timestamp gt <n>L`, `$orderby`, page size and order.
7. **`crm/BankAccounts`.** The IBAN field (`BankAccount` or `IBAN`), page size, that the `Main`
   flag is what we think. Check `relation_bank_accounts` after the nightly run: every account of a
   relation present, `iban_added_at` / `iban_changed_at` empty after the very first IBAN pass
   (ADR 0014 item 7, ADR 0019).
8. **`ReceivablesList` / `PayablesList`.** `ID` versus `HID`, what `Amount` means and in which
   currency, page size (60?), dates and their time zone (ADR 0014 items 3, 9).
9. **`/sync/Cashflow/*`.** Do the endpoints exist (the payables one may be `Payments` or
   `PaymentTerms`), their fields, whether paid rows come back, and **whether an item has the same
   `ID` in the list and in the sync endpoint**. Until that is confirmed, leave Settings,
   Connections, "Read open receivables and payables in the hourly sync" **off** (the default); with
   it off, only the nightly full pass refreshes open items (ADR 0017 verify 1, 2, 13). Compare
   `open_items.source` (`list` / `sync`) for the same invoice before switching it on.
10. **One scheduled-style full sync** on the test division with the close guard at its default:
    compare the counts and totals of `open_items` with Exact's own creditors and debtors ageing,
    and `exact_usage` with the remaining-calls header.
11. **Subrequest limit and D1 batches.** Which per-invocation subrequest limit the account has
    (we assume 1,000, `SUBREQUEST_LIMIT`), and whether one `db.batch` of up to 100 statements
    counts as one subrequest (we count it as one). Run a nightly pass on the largest division and
    read the Worker's subrequest count from the invocation logs (ADR 0017 verify 8).
12. **Logs.** `wrangler tail` during a sync and a connect: no tokens, no IBANs, no response
    bodies.
13. **Reconnect to another account.** On a throwaway deployment, connect, then connect with a
    different Exact account: expect `?exact=different_exact_account`, the connection disabled and
    the original divisions untouched; then repeat with "Replace with the other account" and check
    the old divisions are switched off and the audit rows `connection.exact_account_mismatch` /
    `connection.exact_account_replaced` (ADR 0019).
14. **Before Phase 7 (matching):** XML upload with bearer auth, the `_Division_` parameter, the
    message type codes, and that a MatchSet can be read back (ADR 0014 item 13).
