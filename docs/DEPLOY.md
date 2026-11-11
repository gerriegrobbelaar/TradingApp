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

**Staging first.** Steps 2 to 10 are written for production. Because nothing here has run against a
real Cloudflare, Google or Exact account, do them once on the staging environment first (own Worker,
database, queues and objects; see "Staging first" below) and only then repeat them on production.
Durable Object jurisdictions do not work in local `wrangler dev`, so staging is the first place the
Exact connection and the scheduler can run at all.

## Step 0. What a human must do

Most of these cannot be scripted. Do them first, because later steps need their output (client IDs,
database id, hostname).

| #   | Owner                   | What                                                                                                                                                                                                                                                 | Where                                                 | Needed before |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------- |
| 1   | Cloudflare account owner | Put the account on the **Workers paid plan** (the free plan's CPU and cron limits are too small; Queues and Durable Objects need it).                                                                                                                | Cloudflare dashboard, Billing                         | Step 2        |
| 2   | Cloudflare account owner | Choose the app hostname (for example `finance.<your domain>`) on a zone in the same account. It becomes the `routes` line and the origin of every redirect URI.                                                                                      | Dashboard, DNS / Workers routes                       | Step 4        |
| 3   | Admin                   | Create the **EU D1 database** (jurisdiction cannot change later). Done by command in step 2.                                                                                                                                                         | Terminal                                              | Step 2        |
| 4   | Admin                   | Create **two queues** in the EU, main and dead-letter. Done by command in step 3.                                                                                                                                                                              | Terminal                                              | Step 3        |
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
no-overlap lease) with `tag = "v2"`, and `RevolutGate` (binding `REVOLUT_GATE`, one per Revolut
connection, ADR 0031) with `tag = "v3"`, all in `new_sqlite_classes`. Never edit or reuse a deployed
tag: a new class or a rename needs a new `[[migrations]]` entry with the next tag (`v4`).

## Step 3. Create the queues

Job runs travel through a Cloudflare Queue. Create the queue and its dead-letter queue once, before
the first deploy, **in the EU**; the names must match `wrangler.toml`:

```sh
pnpm exec wrangler queues create camelthorn-jobs --jurisdiction eu
pnpm exec wrangler queues create camelthorn-jobs-dlq --jurisdiction eu
pnpm exec wrangler queues list
```

`--jurisdiction` (choices `eu`, `us`, `fedramp`) is in `wrangler queues create --help` of wrangler
4.160. Assume it cannot be changed afterwards (ADR 0028). `[[queues.producers]]` and
`[[queues.consumers]]` have no jurisdiction field in wrangler's schema and need nothing extra: they
name the queue only. **Unverified:** that a Worker bound by name reaches a queue created with a
jurisdiction. This is on the first-deploy checklist: if `wrangler deploy` (step 7) or the Run now in
step 9 cannot find the queue, stop and record the error in ADR 0028.

The Worker is both producer (binding `JOBS_QUEUE`, used by the cron tick and "Run now") and consumer
(`queue()`), configured under `[[queues.producers]]` and `[[queues.consumers]]`: one run per
invocation (`max_batch_size = 1`), 3 retries 60 s apart, then the dead-letter queue
`camelthorn-jobs-dlq`. Messages carry only ids (`runId`, `jobId`), never customer data.
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
| `REVOLUT_CLIENT_ID`                      | client ID of the Revolut Business API certificate (Revolut Business, Settings, APIs)                               | empty or a test value                                           |
| `REVOLUT_REDIRECT_URI`                   | `https://<app host>/api/connections/revolut/callback`, same origin as `OAUTH_REDIRECT_URI`; register it on the certificate | placeholder, not https, or wrong origin or path          |
| `REVOLUT_ISSUER`                         | the host of `REVOLUT_REDIRECT_URI`, without `https://` (the `iss` of the client assertion)                         | empty, or not that host                                         |
| `routes`                                 | uncomment one of the two examples and set your hostname (same host as the redirect URIs)                           | no routes set, or the redirect URI host is not a route          |
| `[triggers] crons = ["* * * * *"]`       | leave as is                                                                                                        | no cron trigger                                                 |
| `EXACT_GATE` / `JOB_LOCK` / `REVOLUT_GATE` bindings + migrations `v1`, `v2`, `v3` | leave as is                                                               | a gate or lock binding or migration missing                     |
| `JOBS_QUEUE` producer, consumer, `dead_letter_queue` | leave as is (names from step 3)                                                                        | producer, consumer or dead-letter queue missing                 |

The guard only checks that `INITIAL_ADMIN_EMAIL` looks like an email address and `ALLOWED_HD` is
set: check by eye that they are the right ones. It also refuses `workers_dev` or `preview_urls`
other than `false`, a secret name or a `TEST_*` name in `[vars]`, test values left from the
vitest config (`test-…` client IDs, `*.test` hosts), a Durable Object binding with `script_name`,
and a `wrangler.toml` that does not parse. `[observability]` must be written out (wrangler leaves the
dashboard setting alone when the key is missing): it keeps application logs but turns off
invocation logs and redacts query strings, and the guard refuses invocation logs at sampling above
0.05 or logging without `redact_query_string = true` (see "Log hygiene"). `[limits] cpu_ms = 30000`
is the CPU time allowed per invocation (Cloudflare's default, written out; step 10 item 11 says when
to raise it).

Staging has its own copy of every row of this table inside `[env.staging]` (see "Staging first").
The guard reads the file with the TOML parser wrangler uses and applies wrangler's inheritance
rules: an environment inherits `routes`, `triggers`, `observability`, `limits`, `assets`,
`migrations`, `workers_dev` and `preview_urls` from the top level when it leaves them out, and never
inherits `vars` or bindings. It checks the resolved configs, so a staging that would inherit the
production route, or whose Durable Object migrations differ from production's, is refused.

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

Secrets live only in Workers secrets. The Worker does not exist yet before the first deploy (step
7), and `wrangler secret put` on a missing Worker asks "There doesn't seem to be a Worker called
... Do you want to create a new Worker with that name and add secrets to it?" Answer yes **once**:
run the first `secret put` below by hand (interactive prompt) and accept; the later ones then find
the Worker. The placeholder Worker it creates has no code until step 7.

Alternative that avoids the prompt per secret: put all four values in a JSON file kept **outside**
the repo and outside any synced folder (for example `~/secrets/camelthorn.json`, mode 600, content
`{"GOOGLE_CLIENT_SECRET":"...","SESSION_SECRET":"...","EXACT_CLIENT_SECRET":"...","TOKEN_ENC_KEY":"..."}`)
and run `pnpm exec wrangler secret bulk ~/secrets/camelthorn.json` (`wrangler secret bulk --help`:
JSON or `.env` file, up to 100 secrets, a `null` value deletes; with no file it reads stdin). Delete
the file afterwards. Like `secret put`, `secret bulk` offers to create the missing Worker (same
prompt; read from wrangler 4.160's source, not yet run here). For staging add `--env staging`.

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 48 | pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put EXACT_CLIENT_SECRET
# Revolut Business API private key, PKCS#8 PEM (`openssl pkcs8 -topk8 -nocrypt`); its certificate
# is the one registered with Revolut. Paste the whole PEM, or pipe the file.
pnpm exec wrangler secret put REVOLUT_PRIVATE_KEY < revolut-private-pkcs8.pem
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

This applies **all migrations in `apps/worker/migrations`** in order (the file count grows with each
phase, so do not rely on a number written here). Verify:

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

`run deploy` runs the placeholder check, then `wrangler deploy --env=""` (the empty environment
names the top level explicitly; without it wrangler warns that several environments are defined).
Do not call `wrangler deploy` directly: it skips the check. `wrangler deploy --dry-run --env=""`
(and `--env staging`, both run in CI) checks bundle and config without publishing and does not check
placeholders. A dry run on this repo needs `apps/web/dist` to exist (build first) and lists the
bindings `EXACT_GATE`, `JOB_LOCK`, `JOBS_QUEUE`, `DB`, `ASSETS` and the variables.

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
- [ ] ADR 0028 (unverified): the queues were created with `--jurisdiction eu`, and the Worker
      (producer and consumer, bound by name only) works with them. Check the dashboard, Queues, for
      the jurisdiction if `wrangler queues info` does not print it.
- [ ] Logs (ADR 0029, unverified): after a few requests with a query string (for example
      `/api/invoices?q=test`) open Workers Logs and confirm no stored URL contains `?q=` or an OAuth
      `code`, and that no per-request invocation line is kept.

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
   currency, page size (60?), dates and their time zone (ADR 0014 items 3, 9). Also: the **sign**
   of payables (are bills positive and credit notes negative, as for receivables? the app reads
   credit notes as negative on both sides) and the **spelling of the key field**: Exact resources
   differ between `ID` and `Id` (`$select` is case-sensitive about names), so a 400 on the lists
   may just be this.
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
    re-run the Run now check of step 9 (expect `OK`). The "First sync procedure" below spells this
    item out step by step. Mind the budget: the defaults cost up to 1,960
    of Exact's 5,000 daily calls per administration (ADR 0021); the gate stops jobs at 4,500.
11. **Subrequest limit and D1 batches.** Which per-invocation subrequest limit the account has
    (we assume 1,000, `SUBREQUEST_LIMIT`), and whether one `db.batch` of up to 100 statements
    counts as one subrequest (we count it as one). Run a full pass on the largest division and
    read the Worker's subrequest count from the invocation logs (ADR 0017 verify 8; invocation
    logs are off in `wrangler.toml`, so use `wrangler tail --env staging`, which does not need
    them; switching them on, even on staging, means bypassing the deploy guard and is not
    recommended). The queue runner's own heartbeats and
    finish writes are not in that meter (review S7). Also check the **CPU limit**: Workers allow
    30 s of CPU per invocation by default and `[limits] cpu_ms = 30000` in `wrangler.toml` states
    it. A full pass is bounded by calls, not CPU, but JSON parsing of a large division is the
    likeliest thing to hit it: look for "exceeded CPU" errors in the dashboard (or `wrangler tail`)
    and raise `cpu_ms` (maximum 300000) with a note in ADR 0029 only if you see one.
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
    Run a full sync on the test division until the cycle completes, then check, in this order.
    Two ways exist (ADR 0023): **Run now** on `exact.full_sync` in Settings, Schedules (every
    administration with sync on; reads IBANs; budget per job), or the **Full sync** button in
    Settings, Connections, Data sync (one administration; the other button there is "Sync now",
    the incremental one). The **manual button path never reads IBANs**, so item 7 needs Run now.
    Each press of "Full sync" is a slice of up to 60 Exact calls and 20 s: press it again (after the
    one-minute wait the card shows) until it reports the cycle complete. There is no button for
    `restart`. When this list says "a full sync with restart", send the request yourself, as an
    admin or finance user, with your session cookie from the browser (developer tools, Application,
    Cookies, `__Host-session`):

    ```sh
    curl -sS -X POST "https://<app host>/api/divisions/<division id>/sync" \
      -H "Cookie: __Host-session=<value>" \
      -H "X-Requested-With: fetch" -H "Content-Type: application/json" \
      -d '{"mode":"full","restart":true}'
    ```

    (`X-Requested-With` is the CSRF header; the division id is the one shown in `GET
    /api/divisions`.) `restart` is accepted in full mode only. Repeat the call without `restart`
    until `GET /api/sync/status` (or the Data sync card) shows the cycle complete. The exact
    response fields are not recorded here (**unverified**); read them on first use. Treat the cookie like a password and sign out
    afterwards.
    - `financial/GLAccounts`, `financial/ReportingBalance` and `budget/Budgets` answer to the
      `$select` lists in `packages/exact/src/client.ts` (`GL_ACCOUNT_FIELDS`,
      `REPORTING_BALANCE_FIELDS`, `BUDGET_FIELDS`). A 400 names a wrong field. For balances it
      shows as `gl_balances` with `last_error = http_400` and no report; the cost centre / cost
      unit fields are the likeliest culprits (`CostCenterCode` / `CostUnitCode` on ReportingBalance
      against `Costcenter` / `Costunit` on Budgets: try the other spelling). **For budgets a 400 is
      read as "not licensed"**: `gl_budgets` then has `last_error = budgets_unavailable_400` and
      the reports silently have no budget column for a week. So check `sync_state.last_error` of
      `gl_budgets` on the first live run even when budgets are expected to be unavailable, and
      fix a wrong field before accepting "unavailable"; a full sync with "restart" tries again at
      once. Also: page size (60?), `$skiptoken` paging (an ID keyset or an offset?), `Blocked` as
      the blocked flag, `Type` numeric, `BalanceSide` D/C, `BalanceType` B/W, `Status` 20/50.
    - **Sign and meaning of `Amount`.** Open the balance sheet for the last closed month and
      compare it with Exact's own balance sheet / trial balance, line by line: if every figure has
      the wrong sign, adjust the debit - credit assumption; if balance sheet figures look like
      movements, or a double-counted year, set `LEDGER_BALANCE_SEMANTICS`
      (`packages/core/src/reports/ledger.ts`) to `"cumulative"`. The **check line**
      (`difference`) must be 0, **but 0 alone does not prove the opening balances are there**:
      when period 0 is missing altogether the movements still balance. `hasOpeningBalances` must
      be `true` for every year after the first, and the bank line must equal the bank balance in
      Exact. A non-zero difference usually means the opening of the year does not include last
      year's result (year not closed in Exact) or the semantics are wrong.
    - **Unclassified accounts.** `GET /api/ledger/accounts` lists `section: "unclassified"` and
      `unclassifiedCount`. Fill the real `GLAccount.Type` codes into `BS_TYPE_SECTIONS`
      (`reports/classify.ts`; only 10, 12, 20 and 22 are mapped now, 21 is deliberately not) and
      list the type descriptions seen. An account whose `BalanceSide` is empty is never placed by
      a keyword alone.
    - **Split keys.** `splitKeys` in the report responses (and `gl_sync_years.split_keys`) must be
      0. A non-zero value means Exact returned the same account, period, status, cost centre and
      cost unit twice in one read: another field splits the figure (item, project, ...), the
      stored amount is the last part only and is too low. Add that field to
      `REPORTING_BALANCE_FIELDS` / `BUDGET_FIELDS` and to the dimension.
    - Whether ReportingBalance includes draft entries (status 20) and whether the reports should
      (ADR 0024 open question 3), the budget sign and scenarios, and the reporting year when the
      financial year is not the calendar year.
    - Call arithmetic: a normal night adds about 65 calls for 300 accounts (70 with an opening
      row for every account), the weekly night about 155; read `exact_usage` after the first full
      cycle. A ledger that needs more than one night continues for up to 5 days
      (`LEDGER_PASS_MAX_AGE_MS`); if `gl_balances` is still `partial` after that, raise the
      job's `exact_budget` or the page size question first.
16. **Purchase-entry approvals (before relying on the Approvals screen, and BEFORE Phase 9 enables
    any Pay button; ADR 0025).** Run a full sync until the cycle completes, then check:
    - **Resource and fields.** `purchaseentry/PurchaseEntries` answers to the 13 `$select` names
      of `PURCHASE_ENTRY_FIELDS` (`EntryID, EntryNumber, Supplier, SupplierName, Currency,
      AmountFC, AmountDC, EntryDate, DueDate, Status, Created, Modified, Document`). **A 400, 403
      or 404 on the first page is read as "not available"**: `purchase_entries` then has
      `last_error = purchase_entries_unavailable_<status>` in `GET /api/sync/status` and the
      Approvals screen says "not available" for a day. Check that error on the first live run and
      fix a wrong name (`DueDate` is the likeliest; drop it if the header has none) before
      accepting "unavailable"; a full sync with "restart" tries again at once.
    - **Status codes: the mapping allows payments, so it must be verified.** As an admin call
      `GET /api/approvals/status-codes?division=<id>`: it lists the cached entries per raw Exact
      `Status` code, the stored status and what the table maps it to. Open, in Exact's own UI, at
      least two entries of every code listed (and one entry each that is waiting for approval,
      approved, rejected and processed) and compare. Only then correct or confirm
      `PURCHASE_ENTRY_STATUS_TABLE` (`packages/core/src/approvals.ts`; today 5 = waiting and
      50 = approved, both guesses) and record the result in ADR 0025. **Until this is recorded,
      Phase 9 must not enable paying on the basis of `isInvoiceApprovedForPayment`.** After a
      table change, run a full sync with "restart" so stored rows are re-derived. Then, as admin
      with a Google sign-in from the last 15 minutes, open Approvals → "Check and verify the
      mapping", type the confirmation sentence and confirm. The mark stores a SHA-256 of the
      table and join rule: any later change to either voids it automatically and the screen says
      "The status mapping changed since it was verified" until it is verified again.
    - **Filters.** `EntryDate ge datetime'...'`, `Modified ge datetime'...'` and `Status eq 5`
      joined with `or` are accepted, and `$orderby=Modified` is honoured (rows come back in
      ascending Modified order; otherwise the hourly cursor never moves and the hourly read
      re-reads the same rows: `GET /api/sync/status` shows `purchase_entries` rows not falling).
      Change one entry's status in Exact and check that its `Modified` changes and that the next
      hourly run picks it up (`GET /api/approvals/:id`, `modifiedAt` and `statusCode`): the
      status of an entry older than 120 days is only refreshed through `Modified`.
    - **Time zone.** Whether `Modified` / `Created` (`/Date(ms)/`) are UTC or Amsterdam wall
      clock, and whether a `datetime'...'` literal in `$filter` is read as UTC. We assume UTC; if
      Exact uses Amsterdam time the cursor and window are 1 to 2 hours early (reads a little more,
      safe), and `submittedAt` / `ageDays` can be one day off around midnight. Record it.
    - `$skiptoken` paging with this filter and order, the page size (60?), and that `Document`
      holds a GUID when a PDF is attached.

### First-live checklist: Revolut webhook, sync and backfill (task R3a, ADR 0033)

The webhook URL is `<app origin>/api/webhooks/revolut`. It must be **public https** (Revolut calls
it from the internet; a `wrangler dev` or tunnel URL works for tests, `workers.dev` is off). No
variable to set: it is derived from `REVOLUT_REDIRECT_URI`. Confirming the connection (Settings,
Connections) registers the subscription and queues the 90-day backfill; if Connections says the
webhook is not registered, use "Register webhook" (admin, fresh sign-in).

1. After confirming, `GET /api/connections` shows `revolut.webhookRegistered: true`; `last_error` is
   empty. In Revolut Business (Settings, APIs, Webhooks) one subscription points at the URL above.
2. Send a test payment (EUR 0.01 between two own accounts) and watch `webhook_events`:
   `SELECT id, event_type, status, error_code, received_at, processed_at FROM webhook_events ORDER BY id DESC LIMIT 5`
   (`wrangler d1 execute ... --remote`). Expect `processed` within seconds and rows in
   `bank_transactions` (`source = 'webhook'`, two rows for a transfer). A 401 in the Revolut
   delivery log means the signature check failed: record the exact header names, the timestamp unit
   (we expect epoch milliseconds in `Revolut-Request-Timestamp`) and the signed-payload format, and
   fix ADR 0030/0033 and `packages/revolut` together.
3. Verify the assumptions of ADR 0033 (payload shape, whether `TransactionStateChanged` fires for
   every state, retry timing, the rate limit) and note the answers there.
4. Run "Run now" on `revolut.backfill`, then switch on `revolut.sync` (Settings, Schedules). Check
   the Bank screen shows balances and that `revolut_sync_state` has `last_status = 'ok'` for
   `accounts` and `transactions`. The daily backfill result reports `missing`: a number above zero
   on ordinary days means webhooks or the poll missed transactions.
5. Dead letters: events that exhaust their retries end as `webhook_events.status = 'error'`; the
   poll and backfill still pick the transaction up.

## Staging first

`wrangler.toml` has a complete `[env.staging]` block (ADR 0029): Worker `camelthorn-finance-staging`,
its own D1 database `camelthorn-finance-staging`, queues `camelthorn-jobs-staging` and
`camelthorn-jobs-staging-dlq`, its own `ExactGate` and `JobLock` objects (a Durable Object namespace
belongs to its Worker), its own variables and cron. Nothing is shared with production, and the
deploy guard refuses a staging that reuses the production Worker name, D1 id or name, a queue, a
route or a redirect URI. `routes = []` is committed in `[env.staging]` on purpose: without the key
staging would inherit the production route, and a plain `wrangler deploy --env staging` would move
the production hostname to the staging Worker (wrangler only warns).

Procedure: do steps 0 to 7 for staging, then 8 to 10 and the "First sync procedure" on staging
**before** touching production.

1. Step 0: pick a staging hostname (for example `staging.<your domain>`). Either create a second
   Google OAuth client for it, or reuse the production client and add the staging redirect URI
   `https://<staging host>/api/auth/callback` to it. Same for the Exact app registration: add
   `https://<staging host>/api/connections/exact/callback` (or register a second app). Staging
   connects to a **test Exact division**, not the real administration.
2. Step 2 and 3 with staging names, queues in the EU:

   ```sh
   pnpm exec wrangler d1 create camelthorn-finance-staging --jurisdiction eu
   pnpm exec wrangler queues create camelthorn-jobs-staging --jurisdiction eu
   pnpm exec wrangler queues create camelthorn-jobs-staging-dlq --jurisdiction eu
   ```

3. Step 4: fill the staging `database_id`, `GOOGLE_CLIENT_ID`, `OAUTH_REDIRECT_URI`,
   `EXACT_CLIENT_ID`, `EXACT_REDIRECT_URI` and `routes` inside `[env.staging]`, then
   `pnpm run check:deploy:staging` (from `apps/worker`).
4. Step 5: every secret again for the staging Worker, with a **different** `TOKEN_ENC_KEY`:
   `pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env staging` and so on.
5. Step 6: `pnpm exec wrangler d1 migrations apply camelthorn-finance-staging --remote --env
   staging`.
6. Step 7: `pnpm --filter @camelthorn/web build`, then `pnpm --filter @camelthorn/worker run
   deploy:staging` (guard first, then `wrangler deploy --env staging`).
7. Steps 8, 9 and 10 against the staging hostname, with `--env staging` and the staging database
   name in every `wrangler` command. Record the answers to the step 10 checklist in the ADRs it
   names.
8. Only when step 10 and the "First sync procedure" below pass on staging, repeat steps 2 to 10
   for production with production names (step 10 there on the real administration, with the Exact
   jobs off until the "First sync procedure" passes on production too).

What differs on staging: Worker name, hostname, D1 database, queues, objects, secrets and
`TOKEN_ENC_KEY`, the Exact division (test data) and, if you made one, the Google client. What must
not differ: the code and `wrangler.toml` structure, which is why staging is deployed from the same
commit as production. Staging has its own copy of every job: jobs are off after install there too.

Where things can run: Durable Object jurisdictions (`ExactGate`, `JobLock`) are not implemented in
workerd, so they can be exercised **only on staging or production**, never in local `wrangler dev`
or with `--remote` aimed at production. Unit tests stub the call.

## First sync procedure

Proposed by the Phase 4 final review. Follow it on staging, then on production.

1. Finish step 10 items 1 to 9 on the test division (staging) with the Exact jobs still **off**.
2. In daytime (so someone can watch and the day's budget is not at risk), press **Run now** on
   `exact.full_sync` in Settings, Schedules. Expect several runs for a big division (the pass
   resumes; ADR 0021). Watch `wrangler tail --env staging` for status codes: no 400, 403 or 429
   other than expected.
3. Compare with Exact itself: counts and totals of open receivables and payables against Exact's
   debtors and creditors ageing; the balance sheet for the last closed month against Exact's trial
   balance (step 10 item 15); the HTTP status codes in `sync_state.last_error` for every entity
   (none left over); `GET /api/approvals/status-codes` against Exact's UI (item 16).
4. Read `exact_usage` (`wrangler d1 execute <db> --remote --env staging --command "SELECT * FROM exact_usage ORDER
   BY 1 DESC LIMIT 20"`) and the remaining-calls header. A first full cycle costs a few hundred
   calls; the defaults allow up to 1,960 per administration and day (ADR 0021).
5. Enable `exact.full_sync` (nightly, 02:00) in Settings, Schedules. Look at the next morning's run.
6. Then enable the hourly `exact.incremental_sync`. Check one day of hourly runs (2 to 4 calls
   each) and the daily total in `exact_usage`.
7. Repeat the whole procedure on production with the real administration, starting again with the
   jobs off and a daytime Run now (commands without `--env staging`, production database name).

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
3. Remove the cron: set `crons = []` in `[triggers]` and deploy with
   `pnpm exec wrangler deploy --env=""` (the guard would refuse, so this bypasses `run deploy` on
   purpose); put it back afterwards. Do **not** delete the `[triggers]` block instead: wrangler 4.160
   only sends the schedules when `crons` is set, so a missing block leaves the deployed cron running.
   Manual "Run now" still works.

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

- Request URLs can carry personal data. Endpoints with query strings: the lists and search
  (`?q=<customer or supplier name>` on invoices, payables, approvals and reports; also `division`,
  `cursor`, `status` and date filters), and the Google and Exact OAuth callbacks
  (`/api/auth/callback`, `/api/connections/exact/callback`, which carry the authorization `code`
  and `state`). Names in the page address of the web app can leak through the `Referer` header
  (task M2 removes relation names from it).
- What `wrangler.toml` does about it (ADR 0029): `[observability] redact_query_string = true`
  (query strings removed from URLs in logs and traces) and `[observability.logs] invocation_logs =
  false` (no automatic per-request line). Both keys are accepted by wrangler 4.160
  (`wrangler deploy --dry-run` passes). The deploy guard refuses invocation logs left on at sampling
  above 0.05. **Unverified:** that Cloudflare really drops query strings and the invocation line;
  confirm with the step 9 log check on staging. If it does not, treat URLs as logged: lower
  `head_sampling_rate` to 0.05 or turn `[observability]` off, and limit who can read the dashboard.
  An OAuth `code` is single-use and short-lived and needs the signed state cookie, so a stored code
  is low risk. Names in URL **paths** are not redacted by either key; the app keeps them out of paths.
- Application code logs reason codes only, never tokens, keys, full IBANs or email bodies
  (checklist item 12 verifies this).
- Queues are created in the EU (ADR 0028). Messages carry ids only (`runId`, `jobId`), never
  customer data.
- `wrangler tail` is for short sessions only.

### Rotating secrets

- `TOKEN_ENC_KEY`: put the old value in `TOKEN_ENC_KEY_PREVIOUS`, set the new `TOKEN_ENC_KEY`,
  deploy. Tokens are rewritten with the new key at their next refresh (within minutes while the
  connection is used); then `pnpm exec wrangler secret delete TOKEN_ENC_KEY_PREVIOUS`. If the key is
  lost without a previous copy, reconnect Exact (Settings, Connections).
- `GOOGLE_CLIENT_SECRET`: create a new secret on the Google OAuth client, `secret put`, then remove
  the old one in Google.
- `REVOLUT_PRIVATE_KEY`: create a new certificate in Revolut Business, `secret put` the new key, update
  `REVOLUT_CLIENT_ID` if it changed, deploy. Existing refresh tokens belong to the old client;
  whether they survive is **unverified**, be ready to re-authorise (Settings, Connections).
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
3. If `migrations apply` fails part way, run `migrations list` and read the error. `wrangler d1
   migrations apply --help` (4.160) says it prompts first (skipped when not interactive), captures a
   backup, and that a migration that errors "will be rolled back, and the previous successful
   migration will remain applied". Still check the tables the file touches before re-running
   (**unverified** on this account).
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
  workerd". There is no local way around it (no switch exists, by design, ADR 0018).
  **Do not use `wrangler dev --remote` for the scheduler or the Exact connection**: it runs against
  the real D1 and Durable Objects of the account the config points at, which is production unless
  you deliberately aim it at staging, and the Durable Object classes would run there with the
  local code. Use staging (below).
- What does work locally: the unit and integration tests (`pnpm test`; the vitest pool stubs the
  jurisdiction call); the web app and the API routes that do not touch a Durable Object (sign-in,
  users, settings, the read screens over data you insert into the local D1) through `wrangler dev`
  and `pnpm --filter @camelthorn/web dev`. What works only on staging or production: Exact connect
  and sync, the Exact gate and rate limit, the scheduler (cron tick, `JobLock`, Run now), and the
  Queue consumer in its real setup. Queues are simulated by workerd locally and Cron Triggers do not
  fire unless wrangler is started with `--test-scheduled`; the app has not been tried that way
  (**unverified**), and even then `JobLock` fails locally.
- Tests: `pnpm typecheck && pnpm lint && pnpm test` from the repo root. Worker tests run in the
  Workers Vitest pool (Miniflare), where the jurisdiction call is stubbed by the setup file. CI
  also runs `wrangler deploy --dry-run` for production and for `--env staging`.
- Browser checks of the reporting screens (`apps/web/scripts/k3b-screens.e2e.ts`) are **not** part
  of `pnpm test`. Run them locally with Playwright, Google Chrome and poppler's `pdfinfo`,
  `pdftoppm`, `pdftotext` installed: `pnpm --filter @camelthorn/web build`, then
  `PLAYWRIGHT_PATH=<path to playwright/index.mjs> pnpm --filter @camelthorn/web exec vitest run
  --config scripts/vitest.screens.config.ts` (`CHROME_PATH` defaults to `/usr/bin/google-chrome`;
  `OUT_DIR` sets where the screenshots go, default `docs/design/screens`). In CI the same suite is
  the optional `screens` job of `.github/workflows/ci.yml`: start it by hand (Actions, CI, Run
  workflow); it never blocks a merge and uploads the screenshots as an artifact (**unverified** on
  GitHub's runners until its first run).
