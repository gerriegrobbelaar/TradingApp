# Deploying Camelthorn Finance

One ordered runbook, steps 0 to 10, for the first deploy of the Worker (API plus static web app),
followed by operations and local development. Do the steps in order; each step lists how to check
it. Nothing here has been run against a real Cloudflare, Google or Exact account yet. Anything marked
**unverified** is written from the tool help or the vendor docs and must be confirmed on first use;
when you confirm it, record the result in `docs/decisions/` and drop the label.

Run `wrangler` through the workspace copy so the version matches the lockfile (checked with
wrangler 4.160). From `apps/worker` the commands below read `pnpm exec wrangler <command>`; from the
repo root use `pnpm --filter @camelthorn/worker exec wrangler <command>`. Sign in once with
`pnpm exec wrangler login`.

## Step 0. What a human must do

Most of these cannot be scripted. Do them first, because later steps need their output (client IDs,
database id, hostname).

| #   | Owner                   | What                                                                                                                                                                                                                                                 | Where                                                 | Needed before |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------- |
| 1   | Cloudflare account owner | Put the account on the **Workers paid plan** (the free plan's CPU and cron limits are too small; Queues and Durable Objects need it).                                                                                                                | Cloudflare dashboard, Billing                         | Step 2        |
| 2   | Cloudflare account owner | Choose the app hostname (for example `finance.<your domain>`) on a zone in the same account. It becomes the `routes` line and the origin of every redirect URI.                                                                                      | Dashboard, DNS / Workers routes                       | Step 4        |
| 3   | Admin                   | Create the **EU D1 database** (jurisdiction cannot change later). Done by command in step 2.                                                                                                                                                         | Terminal                                              | Step 2        |
| 4   | Admin                   | Create **two queues**, main and dead-letter. Done by command in step 3.                                                                                                                                                                              | Terminal                                              | Step 3        |
| 5   | Google Cloud admin      | Pick the Google Cloud project that owns the OAuth client (open decision 8 in CLAUDE.md; ADR 0002: only `camelthorncapital.com`). Set the OAuth consent screen to **Internal** (Workspace users only). Create an OAuth client of type Web application. | Google Cloud console, APIs and services, Credentials  | Step 4 and 5  |
| 6   | Google Cloud admin      | On that client add the authorised redirect URI `https://<app host>/api/auth/callback`. For local work also `http://localhost:5173/api/auth/callback`. Keep the client ID and secret.                                                                  | Same                                                  | Step 4 and 5  |
| 7   | Exact administrator     | Register the app in the Exact App Center ("Register API keys") with the redirect URI `https://<app host>/api/connections/exact/callback`. Keep the client ID and secret.                                                                             | apps.exactonline.com (Dutch instance: start.exactonline.nl) | Step 4 and 5  |
| 8   | Admin                   | Generate the secrets (step 5): `SESSION_SECRET`, `TOKEN_ENC_KEY`; collect `GOOGLE_CLIENT_SECRET` and `EXACT_CLIENT_SECRET` from items 6 and 7.                                                                                                      | Terminal, password manager                            | Step 5        |
| 9   | Admin                   | Back up `TOKEN_ENC_KEY` in the password manager (see "Rotating secrets"). Losing it means reconnecting Exact.                                                                                                                                       | Password manager                                      | Step 5        |
| 10  | Admin                   | Confirm `INITIAL_ADMIN_EMAIL` (and `ALLOWED_HD`) in `wrangler.toml` are right: that Google account becomes the first admin.                                                                                                                         | `apps/worker/wrangler.toml`                           | Step 4        |

Order dependency: the app hostname (item 2) is needed to register both redirect URIs (items 6 and
7), and the client IDs from those registrations are needed to fill `wrangler.toml` (step 4). So
decide the hostname first, register Google and Exact, then fill the variables. The client secrets
only go into Workers secrets (step 5), never into the repo.

Exact app registration and the Exact first-live-connection checks are unverified against the real
service: see step 10.

## Step 1. Check out and install

```sh
git clone <repo> && cd <repo>      # Node 22 (.nvmrc) and pnpm
pnpm install --frozen-lockfile
```

## Step 2. Create the EU D1 database

```sh
cd apps/worker
pnpm exec wrangler d1 create camelthorn-finance --jurisdiction eu
```

The jurisdiction cannot be changed afterwards. Keep the printed output: it shows the new
`database_id`. Paste it into `apps/worker/wrangler.toml` (`[[d1_databases]]`, replacing the all-zero
placeholder; the binding is `DB`, the name must stay `camelthorn-finance`).

Verify the jurisdiction (**unverified procedure**: `wrangler d1 info` prints whatever fields the
Cloudflare API returns, and we have not confirmed that the API includes the jurisdiction):

```sh
pnpm exec wrangler d1 info camelthorn-finance --json
```

- If the JSON has `"jurisdiction": "eu"`, you are done.
- If there is no `jurisdiction` field, check the database in the dashboard (Storage and databases,
  D1, the database's settings / overview) for jurisdiction or location "EU". If you cannot confirm
  EU from either, ask Cloudflare support before storing any data.
- If it shows anything other than EU: delete it (`pnpm exec wrangler d1 delete camelthorn-finance`)
  and recreate it before any data exists.

Record what you saw (output or screenshot, date) in `docs/decisions/`.

**Durable Objects are EU-only too.** The code creates every `ExactGate` and `JobLock` object through
`jurisdiction("eu")` (ADR 0018, ADR 0021; one helper, `getEuObject`). Object ids depend on the
jurisdiction, so this is fixed from the first deploy. No variable or binding switches it off, and
the deploy check refuses a leftover `DO_JURISDICTION_DISABLED`. Step 9 confirms it in the dashboard.

**Durable Object migration tags.** `wrangler.toml` declares `ExactGate` (binding `EXACT_GATE`) in
`[[migrations]]` with `tag = "v1"` and `JobLock` (binding `JOB_LOCK`, the scheduler's per-job
no-overlap lease) with `tag = "v2"`, both in `new_sqlite_classes`. Never edit or reuse a deployed
tag: a new class or a rename needs a new `[[migrations]]` entry with the next tag (`v3`).

## Step 3. Create the queues

Job runs travel through a Cloudflare Queue. Create the queue and its dead-letter queue once, before
the first deploy; the names must match `wrangler.toml`:

```sh
pnpm exec wrangler queues create camelthorn-jobs
pnpm exec wrangler queues create camelthorn-jobs-dlq
pnpm exec wrangler queues list
```

The Worker is both producer (binding `JOBS_QUEUE`, used by the cron tick and "Run now") and consumer
(`queue()`), configured under `[[queues.producers]]` and `[[queues.consumers]]`: one run per
invocation (`max_batch_size = 1`), 3 retries 60 s apart, then the dead-letter queue
`camelthorn-jobs-dlq`. Queues have no EU jurisdiction; messages carry only ids (`runId`, `jobId`).
Nothing consumes the dead-letter queue; see "Inspecting the dead-letter queue".

## Step 4. Fill in `wrangler.toml`

Edit `apps/worker/wrangler.toml`. The deploy guard (`check:deploy`) refuses while any of these is
left:

| Setting                                  | Fill with                                                                                                          | Guard message when wrong                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `database_id`                            | id from step 2                                                                                                     | all-zero placeholder                                            |
| `GOOGLE_CLIENT_ID`                       | Google OAuth client ID (item 6)                                                                                    | empty                                                           |
| `OAUTH_REDIRECT_URI`                     | exactly the redirect URI registered on Google, `https://<app host>/api/auth/callback`; its origin is the CSRF origin | `app.example.com` placeholder or not https                      |
| `EXACT_CLIENT_ID`                        | Exact app client ID (item 7)                                                                                       | empty                                                           |
| `EXACT_REDIRECT_URI`                     | `https://<app host>/api/connections/exact/callback`, same origin as `OAUTH_REDIRECT_URI`                            | placeholder, not https, or wrong origin or path                 |
| `routes`                                 | uncomment one of the two examples and set your hostname (same host as the redirect URIs)                           | no routes set                                                   |
| `[triggers] crons = ["* * * * *"]`       | leave as is                                                                                                        | no cron trigger                                                 |
| `EXACT_GATE` / `JOB_LOCK` bindings + migrations `v1`, `v2` | leave as is                                                                                      | ExactGate or JobLock binding or migration missing               |
| `JOBS_QUEUE` producer, consumer, `dead_letter_queue` | leave as is (names from step 3)                                                                        | producer, consumer or dead-letter queue missing                 |

`INITIAL_ADMIN_EMAIL` and `ALLOWED_HD` are not guarded: check them by eye. `workers_dev` and
`preview_urls` stay `false`. `[observability]` is on with `head_sampling_rate = 1` (see "Log
hygiene").

The cron `* * * * *` is the scheduler tick: every minute the Worker works out from each job's own
schedule (Settings, Schedules; Europe/Amsterdam, daylight saving aware) which jobs are due and puts
them on the queue. Change a schedule in the app, never the cron expression. Cron Triggers run on the
deployed Worker only.

Run the guard (it is also run by `pnpm run deploy` in step 7):

```sh
pnpm run check:deploy
```

It prints "no placeholders left" or lists what remains. Commit the file once it passes (no secrets
are in it).

## Step 5. Set the secrets

Secrets live only in Workers secrets. If the Worker does not exist yet, `wrangler secret put` offers
to create it; accept.

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 48 | pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put EXACT_CLIENT_SECRET
# AES-256-GCM key for stored Exact tokens: exactly 32 random bytes as standard, padded base64
# (44 characters ending in "="). Anything else is rejected at startup.
openssl rand -base64 32 | pnpm exec wrangler secret put TOKEN_ENC_KEY
pnpm exec wrangler secret list
```

`SESSION_SECRET` needs at least 32 characters (the command above gives 64). Store a copy of
`TOKEN_ENC_KEY` in the password manager before you pipe it: the command above prints nothing, so
generate it into a variable or file first if you want the copy
(`KEY=$(openssl rand -base64 32); printf %s "$KEY" | pnpm exec wrangler secret put TOKEN_ENC_KEY`).
Never commit or log it.

## Step 6. Apply the migrations

```sh
pnpm exec wrangler d1 migrations apply camelthorn-finance --remote
```

This applies `apps/worker/migrations/0001_auth.sql` through the latest file (`0008_scheduler.sql` at
the time of writing) in order. Verify:

```sh
pnpm exec wrangler d1 migrations list camelthorn-finance --remote
pnpm exec wrangler d1 execute camelthorn-finance --remote --command "SELECT name FROM d1_migrations ORDER BY id"
```

The first must report no unapplied migrations; the second must list every file in the
`migrations/` directory (the `d1_migrations` table is wrangler's default tracking table;
**unverified** on this account). Always apply migrations before deploying code that needs them.

## Step 7. Build and deploy

From the repo root:

```sh
pnpm --filter @camelthorn/web build
pnpm --filter @camelthorn/worker run deploy
```

`run deploy` runs the placeholder check, then `wrangler deploy`. Do not call `wrangler deploy`
directly: it skips the check. `wrangler deploy --dry-run` (also run in CI) checks bundle and config
without publishing and does not check placeholders. A dry run on this repo needs `apps/web/dist` to
exist (build first) and lists the bindings `EXACT_GATE`, `JOB_LOCK`, `JOBS_QUEUE`, `DB`, `ASSETS` and
the variables.

After the first deploy, `https://camelthorn-finance.<account>.workers.dev` must not answer
(`workers_dev` is off).

## Step 8. First sign-in and sign-in checks

1. Open `https://<app host>/api/health`: expect 200 `{"ok":true}`.
2. Open the app and sign in with the Google account of `INITIAL_ADMIN_EMAIL`. The admin is seeded
   (and the default jobs are written) when the Worker first handles a request, once per database.
3. Settings, Users shows that account with role `admin`.
4. The audit log has a `user.seed_admin` entry:
   `pnpm exec wrangler d1 execute camelthorn-finance --remote --command "SELECT actor_email, action, at FROM audit_log WHERE action = 'user.seed_admin'"`.

Security headers (static assets from `apps/web/public/_headers`; API JSON from the Worker):

- [ ] `curl -sI https://<app host>/` and `curl -sI https://<app host>/some/deep/link` (SPA fallback)
      show Content-Security-Policy, Strict-Transport-Security, X-Content-Type-Options,
      Referrer-Policy, Permissions-Policy.
- [ ] `curl -sI https://<app host>/api/health` shows `cache-control: no-store` and
      `x-content-type-options: nosniff` (set by the Worker, not by `_headers`).
- [ ] The browser console shows no CSP violations on first load, in light and dark.

Step-up and `auth_time` (CLAUDE.md 4.0, apps/worker/README.md; ADR 0007). This is an open go-live
gate:

- [ ] Wait until the last interactive Google sign-in is more than 15 minutes old, then try an admin
      change such as inviting a user: expect `401 step_up_required`, and the app offers a fresh
      Google sign-in (`prompt=login`).
- [ ] After the re-prompt the same change succeeds.
- [ ] A silent single-sign-on login (no password prompt) does not refresh the step-up window.
- [ ] Google actually returns `auth_time` in the ID token when `max_age` is requested. If it does
      not, step-up fails closed (every step-up is denied); stop and re-check Google's docs.
- [ ] A sign-in from an account outside `ALLOWED_HD`, or not invited, is denied (`/?auth=denied`).
- [ ] Removing a user ends their sessions immediately.

## Step 9. Verify the scheduler

Do this before connecting Exact. All Exact jobs and the not-yet-built jobs ship **disabled**; the
scheduler itself is checked with a harmless manual run.

- [ ] Within 2 minutes of the first request Settings, Schedules shows **no warning banner**. The
      banner "The job queue is not set up" means the `JOBS_QUEUE` binding or queue is missing; "The
      scheduler last ran N min ago" means the cron is not ticking (the Worker stores the tick time at
      most every 4 minutes, and the banner appears after 10). Check the Cron Triggers tab of the Worker
      in the dashboard.
- [ ] `JobLock` objects are in the **EU jurisdiction**: after the Run now below, open the dashboard,
      Workers, Durable Objects, the `JobLock` namespace, and confirm its objects are listed under EU
      (`ExactGate` objects appear after step 10). The dashboard path is **unverified**.
- [ ] Press **Run now** on `exact.incremental_sync`. With no Exact connection yet it must end
      `skipped` with code `no_connection` (not `error`; the code shows in the run history): that proves queue, consumer, lock and
      run history end to end. Repeat it after step 10; it should then end `OK`. (Run now works on a
      disabled job. Jobs whose phase is not built refuse Run now with a 409 message.)
- [ ] The default jobs listed in Settings, Schedules match `apps/worker/src/jobs/defaults.ts`, and
      `exact.full_sync` and `exact.incremental_sync` are **off after install**:
      `pnpm exec wrangler d1 execute camelthorn-finance --remote --command "SELECT name, enabled FROM jobs ORDER BY name"`.
      You switch them on in step 10, not before.
- [ ] The dead-letter queue is empty: `pnpm exec wrangler queues info camelthorn-jobs-dlq` (shows
      producers, consumers and, **unverified**, a message count) or the queue's page in the
      dashboard.
- [ ] ADR 0021 "verify on first deploy": queue and dead-letter queue exist; no warning within 2
      minutes; Run now ends as above; `JobLock` objects under the EU jurisdiction.

## Step 10. Connect Exact and run the first-live-connection checklist

As an admin with a fresh Google sign-in use Settings, Connections, "Connect Exact Online". Nothing in
the Exact integration has run against the real service yet. Do the checklist below in order on a TEST
division (or an administration you can afford to get wrong) before relying on any Exact data. Each
item names the ADR that lists what was assumed; record the real answer next to the assumption and
fix the constant or parser it names. Background: `docs/decisions/0014`, `0016`, `0017`, `0019`.

**Exact jobs are off until checklist item 10 passes.** `exact.full_sync` and
`exact.incremental_sync` are off after install; switch them on in Settings, Schedules only after
the live-connection checks pass (item 10 at the latest). Before that, use Run now or the Connections
sync panel on the test division.

1. **Jurisdictions.** D1 created with `--jurisdiction eu` (step 2) and the `ExactGate` objects
   listed under EU in the dashboard, Workers, Durable Objects (ADR 0018).
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
   flag is what we think. Check `relation_bank_accounts` after the first full run: every account of
   a relation present, `iban_added_at` / `iban_changed_at` empty after the very first IBAN pass
   (ADR 0014 item 7, ADR 0019). On a database that already synced IBANs before migration 0007,
   the first pass after it flags (once) every relation whose Exact record has an IBAN besides the
   one stored before: expected, review them with the accountant. An IBAN with a wrong check digit
   (`hasValidIbanChecksum`) is stored and flagged like any other.
8. **`ReceivablesList` / `PayablesList`.** `ID` versus `HID`, what `Amount` means and in which
   currency, page size (60?), dates and their time zone (ADR 0014 items 3, 9).
9. **`/sync/Cashflow/*`.** Do the endpoints exist (the payables one may be `Payments` or
   `PaymentTerms`), their fields, whether paid rows come back, and **whether an item has the same
   `ID` in the list and in the sync endpoint**. Until that is confirmed, leave Settings,
   Connections, "Read open receivables and payables in the hourly sync" **off** (the default); with
   it off, only the full pass refreshes open items (ADR 0017 verify 1, 2, 13). Compare
   `open_items.source` (`list` / `sync`) for the same invoice before switching it on.
10. **One scheduled-style full sync** on the test division with the close guard at its default
    (Run now on `exact.full_sync`): compare the counts and totals of `open_items` with Exact's own
    creditors and debtors ageing, and `exact_usage` with the remaining-calls header. When this
    passes, enable `exact.full_sync` and then `exact.incremental_sync` in Settings, Schedules, and
    re-run the Run now check of step 9 (expect `OK`). Mind the budget: the defaults cost up to 1,960
    of Exact's 5,000 daily calls per administration (ADR 0021); the gate stops jobs at 4,500.
11. **Subrequest limit and D1 batches.** Which per-invocation subrequest limit the account has
    (we assume 1,000, `SUBREQUEST_LIMIT`), and whether one `db.batch` of up to 100 statements
    counts as one subrequest (we count it as one). Run a full pass on the largest division and
    read the Worker's subrequest count from the invocation logs (ADR 0017 verify 8). The queue
    runner's own heartbeats and finish writes are not in that meter (review S7).
12. **Logs.** `pnpm exec wrangler tail` during a sync and a connect: no tokens, no IBANs, no
    response bodies.
13. **Reconnect to another account.** On a throwaway deployment, connect, then connect with a
    different Exact account: expect `?exact=different_exact_account`, the connection disabled and
    the original divisions untouched; then repeat with "Replace with the other account" and check
    the old divisions are switched off and the audit rows `connection.exact_account_mismatch` /
    `connection.exact_account_replaced` (ADR 0019). Check `connections.exact_identity` starts with
    `id:` (Exact sent `DivisionCustomer`); `name:` means only the name came back, so a rename in
    Exact is then recognised through the known divisions only. During the callback the connection
    is `pending` and only `GET /current/Me` may run (`wrangler tail` shows no other call).
14. **Before Phase 7 (matching):** XML upload with bearer auth, the `_Division_` parameter, the
    message type codes, and that a MatchSet can be read back (ADR 0014 item 13).
15. **Ledger and reports (before relying on the balance sheet and profit and loss; ADR 0024).**
    Run a full sync on the test division (Run now on `exact.full_sync`, or "Sync now" in full mode)
    until the cycle completes, then check, in this order:
    - `financial/GLAccounts`, `financial/ReportingBalance` and `budget/Budgets` answer to the
      `$select` lists in `packages/exact/src/client.ts` (`GL_ACCOUNT_FIELDS`,
      `REPORTING_BALANCE_FIELDS`, `BUDGET_FIELDS`). A 400 names a wrong field; for budgets it shows
      as `gl_budgets` with `last_error = budgets_unavailable_400` (budgets are optional and tried
      again after a week, or at once with a full sync that restarts). Also: page size (60?),
      `$skiptoken` paging, `Blocked` as the blocked flag, `Type` numeric, `BalanceSide` D/C,
      `BalanceType` B/W.
    - **Sign and meaning of `Amount`.** Open Reporting, Balance sheet for the last closed month and
      compare with Exact's own trial balance: if every figure has the wrong sign or the totals are
      off, adjust the debit - credit assumption; if balance sheet figures look like movements, or
      a double-counted year, set `LEDGER_BALANCE_SEMANTICS` (`packages/core/src/reports/ledger.ts`)
      to `"cumulative"`. The **check line** (`difference`) must be 0; a non-zero value usually means
      period 0 (brought-forward balances) is missing or the semantics are wrong.
    - **Unclassified accounts.** `GET /api/ledger/accounts` lists `section: "unclassified"` and
      `unclassifiedCount`. Fill the real `GLAccount.Type` codes into `BS_TYPE_SECTIONS`
      (`reports/classify.ts`) and list the type descriptions seen.
    - Whether ReportingBalance includes draft entries, whether rows are split over more than
      status and cost centre (compare `gl_balances` row counts per account and period with the
      distinct keys in Exact), the budget sign and scenarios, and the reporting year when the
      financial year is not the calendar year.
    - Call arithmetic: a normal night adds about 65 calls for 300 accounts, the
      weekly night about 155; read `exact_usage` after the first full cycle.

---

## Operations

### Emergency stop of all jobs

Pick the first that works:

1. Settings, Schedules: switch each job off (a job already queued is recorded `skipped` /
   `disabled` when it reaches the consumer; a run already working finishes).
2. In SQL, no deploy needed:
   `pnpm exec wrangler d1 execute camelthorn-finance --remote --command "UPDATE jobs SET enabled = 0"`.
   Nothing new is claimed afterwards. To also drop what is queued, pause or purge the queue:
   `pnpm exec wrangler queues pause-delivery camelthorn-jobs` (resume with `resume-delivery`) or
   `pnpm exec wrangler queues purge camelthorn-jobs`. Commands exist in wrangler 4.160 help;
   behaviour **unverified**. A paused queue builds up messages that run when delivery resumes.
3. Remove the cron: delete the `[triggers]` block, deploy with `pnpm exec wrangler deploy` (the
   guard would refuse, so this bypasses `run deploy` on purpose), and put it back afterwards. Manual
   "Run now" still works.

Re-enabling: switch jobs back on in the app. A job switched on starts counting from that moment;
missed slots are not replayed (ADR 0021).

### Inspecting the dead-letter queue

Nothing consumes `camelthorn-jobs-dlq`; messages sit there until retention expires. They are runs
that could not be started after 3 retries. The scheduler itself marks such a run `error` /
`abandoned` after about 20 minutes, so look in the dead-letter queue only when a job keeps failing
that way. A duplicate delivery for a run that is still working also ends there; that is harmless.

- Depth and consumers: `pnpm exec wrangler queues info camelthorn-jobs-dlq` (message count in the
  output **unverified**), or the dashboard, Queues, `camelthorn-jobs-dlq`.
- Reading message bodies: wrangler has no peek command. The dashboard may offer to view messages
  (**unverified**). Otherwise the body is `{runId, jobId}`; find the run in D1:
  `pnpm exec wrangler d1 execute camelthorn-finance --remote --command "SELECT id, job_id, status, error_code, scheduled_for FROM job_runs WHERE status IN ('error','skipped') ORDER BY id DESC LIMIT 20"`.
- Clearing it once understood: `pnpm exec wrangler queues purge camelthorn-jobs-dlq` (**unverified**).

No alert exists yet for dead-letter depth or abandoned runs (review N10, Phase 8): check it after
each deploy and when Settings, Schedules shows repeated failures.

### Log hygiene

- Workers Logs (`[observability]`) may store request URLs. The Google and Exact OAuth callbacks put
  the authorization `code` in the URL. The code is single-use and short-lived, and the app also
  needs the signed state cookie, so a stored code is low risk, but whether URLs with query strings
  are kept at `head_sampling_rate = 1` is **unverified**. Recommendation: lower the sampling rate
  (for example `head_sampling_rate = 0.1`) once the first deploy checks are done, and limit who can
  read the logs. Application code logs reason codes only, never tokens, keys, full IBANs or email
  bodies (checklist item 12 verifies this).
- Queues have no EU jurisdiction. Messages carry ids only (`runId`, `jobId`), never customer data.
- `wrangler tail` is for short sessions only.

### Rotating secrets

- `TOKEN_ENC_KEY`: put the old value in `TOKEN_ENC_KEY_PREVIOUS`, set the new `TOKEN_ENC_KEY`,
  deploy. Tokens are rewritten with the new key at their next refresh (within minutes while the
  connection is used); then `pnpm exec wrangler secret delete TOKEN_ENC_KEY_PREVIOUS`. If the key is
  lost without a previous copy, reconnect Exact (Settings, Connections).
- `GOOGLE_CLIENT_SECRET`: create a new secret on the Google OAuth client, `secret put`, then remove
  the old one in Google.
- `EXACT_CLIENT_SECRET`: regenerate it in the Exact App Center, `secret put`. Whether existing
  refresh tokens survive a secret change is **unverified**; be ready to reconnect.
- `SESSION_SECRET`: `secret put` a new value. It signs only the short sign-in round-trip cookie;
  anyone mid-sign-in must start again. Sessions are stored in D1 and are not affected.
- Whether `secret put` creates and deploys a new Worker version immediately is **unverified**;
  check `pnpm exec wrangler versions list` after the first rotation.

### Backup and restore

D1 Time Travel keeps point-in-time history (30 days on the paid plan; **unverified** for an EU
database). Commands exist in wrangler 4.160; behaviour **unverified**:

```sh
pnpm exec wrangler d1 time-travel info camelthorn-finance --timestamp <RFC3339 or unix seconds>
pnpm exec wrangler d1 time-travel restore camelthorn-finance --timestamp <RFC3339 or unix seconds>
pnpm exec wrangler d1 export camelthorn-finance --remote --output backup.sql   # keep it private
```

A restore rewinds the whole database, including `audit_log`, sessions and job history; record in
`docs/decisions/` that you did it and when. Take an export before any risky change. Exports contain
encrypted Exact tokens, IBANs and the audit log: store them as sensitive.

### A bad migration

1. Do not edit an applied migration file. Fix forward with a new numbered file in
   `apps/worker/migrations/`.
2. Apply migrations before the code that needs them, and keep each migration compatible with the
   previous release, so `pnpm exec wrangler rollback` (code only; does not touch D1 or Durable
   Object migrations; **unverified** here) stays possible.
3. If `migrations apply` fails part way, run `migrations list` and read the error. D1 is documented
   to apply each migration file atomically (**unverified**); check the tables the file touches
   before re-running.
4. If data is damaged, stop the jobs (above), take an export, then use Time Travel (above) to
   restore to just before the apply.

---

## Local development

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars    # git-ignored; fill in
pnpm --filter @camelthorn/worker dev                       # Worker on :8787
pnpm --filter @camelthorn/web dev                          # UI on :5173, proxies /api to :8787
```

- `.dev.vars` holds the four secrets (placeholders in the example) and overrides public variables.
  Local sign-in needs `OAUTH_REDIRECT_URI=http://localhost:5173/api/auth/callback` and
  `EXACT_REDIRECT_URI=http://localhost:5173/api/connections/exact/callback` (already in the example),
  and `GOOGLE_CLIENT_ID` (and `EXACT_CLIENT_ID`) set there until the committed values are filled.
  The localhost redirect URI must be registered on the Google OAuth client. The browser uses port
  5173, so cookies and the CSRF origin match the redirect URI.
- Local migrations: `pnpm exec wrangler d1 migrations apply camelthorn-finance --local` (from
  `apps/worker`).
- Durable Object jurisdiction: plain `wrangler dev` (workerd) does not implement jurisdictions, so
  Exact calls and `JobLock` use fail locally with "Jurisdiction restrictions are not implemented in
  workerd". To try the Exact connection or the scheduler, use `wrangler dev --remote`. It runs on
  Cloudflare's network against the **real** D1 and Durable Objects of the account, so use a test
  deployment or a throwaway database, never production data.
- Cron Triggers do not fire locally unless wrangler is started with `--test-scheduled`. Queues are
  simulated locally; the app has not been tried that way (**unverified**).
- Tests: `pnpm typecheck && pnpm lint && pnpm test` from the repo root. Worker tests run in the
  Workers Vitest pool (Miniflare), where the jurisdiction call is stubbed by the setup file. CI
  also runs `wrangler deploy --dry-run`.
