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
Exact connection, the Revolut connection and the scheduler can run at all.

**Revolut is optional as a whole.** A deployment that leaves `REVOLUT_CLIENT_ID`,
`REVOLUT_REDIRECT_URI` and `REVOLUT_ISSUER` all empty in `wrangler.toml` (as committed) passes the
deploy guard with a printed notice ("Revolut is not configured: ..."). Settings, Connections then
shows "Revolut is not configured on this deployment" instead of a Connect button, the Revolut
connect routes answer `500 server_misconfigured`, the webhook endpoint answers the same plain 401 as
to any unsigned delivery, the Bank screen has no Revolut data (`available: false`), and the
`revolut.sync` and `revolut.backfill` jobs (off by default anyway) skip with
`revolut_not_configured`. If only some of the three are set, or one is not a string, the guard fails
and names them. Values are compared after trimming spaces, as the Worker reads them, so `" "` counts
as empty. The `REVOLUT_GATE` binding and its migration stay mandatory
either way (they cost nothing and keep adding Revolut later a settings-only change). Skip every
"Revolut" row and section below if you do not use Revolut; add it later by doing them then.

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
| 8   | Admin                   | Generate the secrets (step 5): `SESSION_SECRET`, `TOKEN_ENC_KEY`; collect `GOOGLE_CLIENT_SECRET` and `EXACT_CLIENT_SECRET` from items 6 and 7, and `REVOLUT_PRIVATE_KEY` from item 12 (Revolut only).                                                                                                      | Terminal, password manager                            | Step 5        |
| 9   | Admin                   | Back up `TOKEN_ENC_KEY` in the password manager (see "Rotating secrets"). Losing it means reconnecting Exact.                                                                                                                                       | Password manager                                      | Step 5        |
| 10  | Admin                   | Confirm `INITIAL_ADMIN_EMAIL` (and `ALLOWED_HD`) in `wrangler.toml` are right: that Google account becomes the first admin.                                                                                                                         | `apps/worker/wrangler.toml`                           | Step 4        |
| 11  | Revolut account owner (Revolut only) | Have a **Revolut Business** account with API access, and a **sandbox** Revolut Business account for staging. Creating the sandbox account: Revolut's developer docs / Business sandbox sign-up (**UNVERIFIED**: where the sign-up lives and whether it needs a separate email). Production API access may need a plan that includes the Business API and an owner or admin role (**UNVERIFIED**). | Revolut Business web app; developer.revolut.com        | Step 10 (Revolut) |
| 12  | Admin (Revolut only)    | Generate the **API key pair** and public certificate with the commands in "Revolut: key, certificate and registration" below. Keep the private key in the password manager; it becomes the secret `REVOLUT_PRIVATE_KEY`. One pair per Revolut environment (sandbox for staging, production for production) is recommended. | Terminal, password manager                            | Step 5        |
| 13  | Revolut account owner (Revolut only) | In Revolut Business, Settings, APIs: add an API certificate, upload the public certificate (`revolut-public-cert.pem`), enter the OAuth redirect URI `https://<app host>/api/connections/revolut/callback`, and keep the **client ID** it shows. **UNVERIFIED**: the exact menu names, whether the certificate must be `.cer` or PEM, and whether a webhook URL is entered here too (the app registers webhooks itself on confirm). | Revolut Business, Settings, APIs (**UNVERIFIED**)      | Step 4 (Revolut) |
| 14  | Admin (Revolut only)    | Decide, before connecting: **who creates bank entries in Exact** (this app, or Revolut's own Exact integration; open decision 2) and the **payments mode** (drafts, or pay directly on a Company plan; open decision 1). The Connections card does not default who creates bank entries, nor the environment (production or sandbox); the payments mode starts on drafts, the safe choice. | Settings, Connections                                  | Step 10 (Revolut) |
| 15  | Admin (Revolut only)    | Leave **IP allow-listing off** on the Revolut API certificate. Workers have no fixed outgoing IP address, so an allow-list would block the app. It is optional on Revolut's side (CLAUDE.md section 3); **UNVERIFIED** whether your Revolut plan offers or requires it. | Revolut Business, Settings, APIs (**UNVERIFIED**)      | Step 10 (Revolut) |

Order dependency: the app hostname (item 2) is needed to register the redirect URIs (items 6, 7 and
13), and the client IDs from those registrations are needed to fill `wrangler.toml` (step 4). So
decide the hostname first, register Google and Exact (and Revolut, if used), then fill the
variables. The client secrets
only go into Workers secrets (step 5), never into the repo.

Exact app registration and the Exact first-live-connection checks are unverified against the real
service: see step 10. The same holds for everything on the Revolut side (items 11, 13 and 15 are
written from memory of Revolut's documentation, not from a live account): see "Revolut: key,
certificate and registration" and the Revolut first-live checklist.

### Revolut: key, certificate and registration

Revolut Business authenticates the app with a client assertion: a JWT signed with a private RSA
key (RS256); Revolut holds the matching public certificate. The Worker accepts only an
**unencrypted PKCS#8 RSA key of at least 2048 bits** (`BEGIN PRIVATE KEY`). Generate the pair on a
trusted machine, outside the repository and outside any synced folder. These `openssl` commands
were run on OpenSSL 3.0.13 for this document (the output was checked), but Revolut's acceptance of
the certificate is **UNVERIFIED**:

```sh
umask 077
# 1. RSA 2048-bit private key, unencrypted, PKCS#8 (genpkey writes PKCS#8 by default)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out revolut-private-pkcs8.pem
# 2. Self-signed public certificate for that key, valid five years (adjust -days and the name)
openssl req -new -x509 -key revolut-private-pkcs8.pem -out revolut-public-cert.pem -days 1825 \
  -subj "/CN=camelthorn-finance"
# 3. Checks: first line must be "-----BEGIN PRIVATE KEY-----", size must say 2048 bit or more,
#    and both MD5 lines below must be identical (the certificate belongs to this key)
head -1 revolut-private-pkcs8.pem
openssl pkey -in revolut-private-pkcs8.pem -noout -text | head -1
openssl x509 -in revolut-public-cert.pem -noout -pubkey | openssl md5
openssl pkey -in revolut-private-pkcs8.pem -pubout | openssl md5
```

- Upload **only** `revolut-public-cert.pem` to Revolut (item 13). Whether Revolut wants the PEM
  text or a `.cer` (DER) file is **UNVERIFIED**; if it insists on DER, convert with
  `openssl x509 -in revolut-public-cert.pem -outform der -out revolut-public-cert.cer`.
- `revolut-private-pkcs8.pem` goes into the Worker secret `REVOLUT_PRIVATE_KEY` (step 5) and the
  password manager, then delete the file. An old-style `BEGIN RSA PRIVATE KEY` (PKCS#1) key is
  refused: the Revolut routes answer `server_misconfigured` and the log names
  `REVOLUT_PRIVATE_KEY(pkcs8)`. A key under 2048 bits is refused when the first assertion is
  signed. Convert a PKCS#1 key with
  `openssl pkcs8 -topk8 -nocrypt -in old.pem -out revolut-private-pkcs8.pem`.
- **Redirect URI.** Register `https://<app host>/api/connections/revolut/callback` on the
  certificate. It must be https, on the same origin as the app, at exactly that path. The same
  string goes into `REVOLUT_REDIRECT_URI`. `REVOLUT_ISSUER` is that URI's host without `https://`
  (Revolut's rule for the assertion's `iss`). Staging uses its own staging host and, preferably, its
  own sandbox certificate. Local `http://localhost` cannot be used (https only).
- **Sandbox account.** Staging connects to a Revolut **sandbox** business account (the card's
  "Sandbox (test)" environment, hosts `sandbox-b2b.revolut.com` and `sandbox-business.revolut.com`
  in the code). The sandbox has its own certificate and client ID; production credentials do not
  work there and the other way round. Where to create the sandbox account and its certificate is
  **UNVERIFIED** (Revolut developer documentation).
- **IP allow-listing.** Optional on Revolut's side. Workers have no fixed outgoing IP address, so
  leave it off (item 15). If your Revolut plan forces an allow-list, the app cannot be used with it
  without a fixed-IP egress (not built, not planned).

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
| `REVOLUT_CLIENT_ID`                      | **optional as a set:** client ID of the Revolut Business API certificate (item 13). Leave all three Revolut rows empty to run without Revolut | only when some of the three are set: empty or a test value |
| `REVOLUT_REDIRECT_URI`                   | `https://<app host>/api/connections/revolut/callback`, same origin as `OAUTH_REDIRECT_URI`; register it on the certificate | only when some are set: empty, placeholder, not https, or wrong origin or path |
| `REVOLUT_ISSUER`                         | the host of `REVOLUT_REDIRECT_URI`, without `https://` (the `iss` of the client assertion)                         | only when some are set: empty, or not that host                 |
| `routes`                                 | uncomment one of the two examples and set your hostname (same host as the redirect URIs)                           | no routes set, or the redirect URI host is not a route          |
| `[triggers] crons = ["* * * * *"]`       | leave as is                                                                                                        | no cron trigger                                                 |
| `EXACT_GATE` / `JOB_LOCK` / `REVOLUT_GATE` bindings + migrations `v1`, `v2`, `v3` | leave as is                                                               | a gate or lock binding or migration missing                     |
| `JOBS_QUEUE` producer, consumer, `dead_letter_queue` | leave as is (names from step 3)                                                                        | producer, consumer or dead-letter queue missing                 |

All three Revolut rows empty (as committed) is a valid configuration: the guard prints the notice
"Revolut is not configured: ..." and moves on (see the top of this document for what the app does
then). Staging and production are checked on their own: one may use Revolut while the other does
not, but they may not share `REVOLUT_CLIENT_ID` or `REVOLUT_REDIRECT_URI`. The `REVOLUT_PRIVATE_KEY` secret is not
checked by the guard (secrets are not visible to it); a missing or malformed key shows up at
runtime as `server_misconfigured` on the Revolut routes (names of the missing settings in the log,
never values).

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

The Worker uses **five secrets**: `SESSION_SECRET`, `TOKEN_ENC_KEY`, `GOOGLE_CLIENT_SECRET`,
`EXACT_CLIENT_SECRET` and `REVOLUT_PRIVATE_KEY` (plus `TOKEN_ENC_KEY_PREVIOUS` only while rotating).
`REVOLUT_PRIVATE_KEY` is needed only if Revolut is used. The list matches `apps/worker/src/env.ts`
and the deploy guard's refusal list.

Alternative that avoids the prompt per secret: put all the values in a JSON file kept **outside**
the repo and outside any synced folder (for example `~/secrets/camelthorn.json`, mode 600, content
`{"GOOGLE_CLIENT_SECRET":"...","SESSION_SECRET":"...","EXACT_CLIENT_SECRET":"...","TOKEN_ENC_KEY":"..."}`;
add `"REVOLUT_PRIVATE_KEY":"<the PEM with \n for line breaks>"` if you use Revolut)
and run `pnpm exec wrangler secret bulk ~/secrets/camelthorn.json` (`wrangler secret bulk --help`:
JSON or `.env` file, up to 100 secrets, a `null` value deletes; with no file it reads stdin). Delete
the file afterwards. Like `secret put`, `secret bulk` offers to create the missing Worker (same
prompt; read from wrangler 4.160's source, not yet run here). For staging add `--env staging`.

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 48 | pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put EXACT_CLIENT_SECRET
# Revolut only: the unencrypted PKCS#8 private key from "Revolut: key, certificate and
# registration" (step 0); its certificate is the one registered with Revolut. Pipe the file.
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
bindings `EXACT_GATE`, `JOB_LOCK`, `REVOLUT_GATE`, `JOBS_QUEUE`, `DB`, `ASSETS` and the variables.

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
    item out step by step. Mind the budget: the full and incremental sync cost up to 1,960
    of Exact's 5,000 daily calls per administration (ADR 0021). `exact.bank_balances` (D8a) adds up to
    20 calls per run and an hourly run fires 24 times a day (25 on the autumn clock change), so at most
    480 (500) calls per administration and day; in practice one call per mapped bank account per run
    (24 x accounts a day). Both together: at most 2,460 (the scheduler refuses a change that projects
    more than 3,000). `exact.book_matches` is separate and ships off. The gate stops jobs at 4,500.
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

17. **Booked amount of a foreign-currency invoice (Phase 6 review B1; before relying on the
    "Booked" and difference lines on Overview, Invoices and Payables; ADR 0038).** The unrealised
    difference needs `open_items.open_dc_minor`, the open amount in the administration currency
    at the booked rate (`dc_source` says where it came from: `sync`, `list` or `computed`).
    Nothing sets it from the nightly list by default, so **a USD invoice shows no "Booked" line
    and no difference until this is done**. Both switches below are admin only, need a Google
    sign-in from the last 15 minutes (else 401 `step_up_required`: sign in again) and are audited.
    After the first full sync:
    - Find one open USD (or other foreign) invoice that has a part payment in Exact and one that
      has none. In Exact note the open amount in USD and in EUR, and the rate.
    - Turn on the incremental open-item read (Settings, Connections, "Read open receivables and
      payables in the hourly sync", item 9) and wait for an hourly sync. It fills
      `open_dc_minor` (`dc_source` = `sync`) and `rate` from the sync endpoint. Compare both with
      Exact for the two invoices: `open_dc_minor` must be Exact's EUR open amount (for the
      part-paid one: the remainder, not the total).
    - Option 3, the one that needs no guessed field names: if `rate` is right, decide its direction
      from the invoice you noted (0.92 EUR per USD is `base_per_foreign`, 1.087 USD per EUR is
      `foreign_per_base`) and `PUT /api/sync/settings` with `{"rateDirection":"base_per_foreign"}`
      (or `foreign_per_base`; `null` unsets). From then on the nightly list computes the booked
      amount of an item whose open amount changed as open amount times its stored rate
      (`dc_source` = `computed`); an item never seen by the sync read has no rate and stays
      without a booked amount. Do not set it before you have checked one invoice both ways: a
      wrong direction shows wrong money. Changing or unsetting it clears every computed amount at
      once; the next full sync computes them again. Amounts read from Exact are never touched.
    - Option 1, only if you want to test it: `PUT /api/sync/settings` with `{"listDcFields":true}`
      makes the nightly list ask for `AmountDC` and `RateFC` as well. The names are a guess. If
      Exact answers 400 and the same read without them works, the sync carries on without them
      and remembers it for 7 days (`listDcFieldsUnavailableUntil` in `GET /api/sync/settings`);
      nothing fails. If it answers 200, compare `open_dc_minor` (`dc_source` = `list`) of the
      part-paid invoice with Exact's EUR open amount; a total instead of an open amount is the
      likely mistake, and then switch it off again (`{"listDcFields":false}` clears every amount
      it gave).
    - **Done when:** the morning after a full sync, a USD invoice shows "Booked" and the difference
      in the item sheet and the Invoices list, for a part-paid one too (its booked amount is the
      remainder, not the invoice total). A part payment seen only by the nightly list clears the
      stored booked amount until a sync read or the rate computation gives it again (ADR 0038).
      Without option 3 or the incremental read, the criterion is "dormant until verified".

18. **Booking: verify the write path on a TEST division before enabling (Phase 7 M7c and the U1
    final-review fixes; ADR 0044, 0040).** Writing to Exact is switched off in six places: the
    `exact.booking_enabled` switch, the verification mark (tied to `BOOKING_PROTOCOL_VERSION`, to
    the booking mode and to a complete checklist), the division allow-list, the gate (re-checks every
    precondition at call time), the job `exact.book_matches` (ships disabled; switching it on needs
    a fresh sign-in) and the writer guard. NOTHING below has ever run against a real Exact, and the
    tests use a fake that shares our assumptions (A1-A17 are all UNVERIFIED). Do it on a test
    division only, in this order: **preview, compare with a by-hand payload on the test division,
    verify with every check ticked, enable for ONE division with one match per run and the
    watermark at now, book one, check it in the Exact UI, then raise the limits.**
    1. **Prepare.** A test division with a test bank journal, a test debtor with one open invoice
       of EUR 0.01 or more, and a test creditor with one open bill. In Settings, Matching map the
       Revolut account (journal, bank GL account) AND the debtor and creditor control accounts
       (Settings, Matching, Account map: "Debtors control account", "Creditors control account";
       or `receivableGlAccountCode`, `payableGlAccountCode` via `PUT /api/matching/account-map`).
       If the test journal has NO bank entry yet, also give its opening balance ("Opening balance
       of an empty journal", typed in the account currency, a minus sign in front for an overdrawn
       journal; stored as `openingBalanceMinor`, signed minor units): it is used only for the first
       entry (A12b). Decide `creates_bank_entries` on the Revolut connection (does Revolut's own
       Exact integration import the lines?): changing it later switches booking off and clears the
       verification. Make sure the test bank line has NO Revolut fee: lines with a fee are not
       booked in v1 (`fee_not_supported_v1`); on the Revolut sandbox, look at one payment with a fee
       and record whether the leg amount includes it (A17). A line with NO fee field is read as "no
       fee" (Revolut omits a zero fee). Lines stored before migration 0015 never had the fee column
       filled: run the Revolut backfill (Settings, Connections, "Backfill") before enabling so the
       lines the matches point at are refreshed while still unmatched.
    2. **Create the test match** in the app (a test bank line against the test invoice). It shows
       "cannot book yet: <code>" if a control account or the opening balance is missing; `GET
       /api/booking/settings` lists `control_accounts_missing` / `journal_unmapped` as blockers.
    3. **Preview.** "Preview booking" in the Booking card or on the match's own sheet, or `POST
       /api/booking/preview {"matchIds":[<id>]}` (admin, fresh sign-in; works with booking OFF). It reads Exact (probe by YourRef, the journal balance, the item
       read-back) and returns the REAL bank entry body and MatchSet XML with their hashes, and
       `wouldDefer` when the executor would not book it. Nothing is written or stored (one audit
       row `booking.preview`). Expect `reads.preflight = open_as_expected`.
    4. **Check the assumptions by hand and compare** (Exact UI and `curl` against the API),
       recording each answer in ADR 0040 / 0044. This step is the check
       `preview_matches_manual_payload`:
       - Post the preview's bank entry body BY HAND (curl) on the test journal, byte for byte, and
         in the Exact UI confirm one line, the sign, the date and the `YourRef` (A1, A3, A7, A9, A10).
       - **A6/A13, the duplicate probe (this is what prevents a second bank entry):** GET
         `BankEntryLines?$filter=YourRef eq '<that id>' and JournalCode eq '<code>'` must return
         exactly one row; the same with the id in upper case; and a random id that does not
         exist must return ZERO rows in that journal (if it returns lines, the filter is ignored:
         STOP, booking must not be enabled). Same for the amount + date filter if the feed creates
         the lines.
       - A12: GET `BankEntries?$filter=JournalCode eq '<code>'&$orderby=EntryNumber desc&$top=1`
         returns the entry just posted with the closing balance the next entry must open with.
       - A2, A4, A5, A8, A14, A15, A16: upload the preview's MatchSet by hand (replace the
         placeholder `999999999` by the real entry number of the line you just posted) against that
         bank line; check the match in the Exact UI and that the invoice shows paid; read
         `cashflow/Receivables` for the invoice with and without `IsFullyPaid eq true`; check that
         the bank entry alone (before the MatchSet) did not already settle the invoice (A16: if it
         does, every match would end `manual_required` `already_settled_in_exact`).
       - **A15c, the bank line as an item:** before the MatchSet, read `cashflow/Receivables` with
         `Account eq guid'<debtor>' and EntryNumber eq <entry number of the bank line>`: one row,
         open, `AmountFC` = minus the bank amount (the MatchSet line's own amount). After the
         MatchSet the same read (and the `IsFullyPaid eq true` read) shows it closed. The executor
         relies on this ONLY to accept a match as booked after a lost or unclear MatchSet answer;
         if the bank line does not show this way (for example a feed line booked to another
         account), those cases end `manual_required` (`bank_line_readback_inconclusive`), never
         booked: safe, but record it.
       - **A12b, first entry of an empty journal:** if the test journal had no entry, the first
         bank entry opens with the admin's `openingBalanceMinor`. Check in the Exact UI that Exact
         accepted that opening balance, that it equals the bank statement balance before the first
         booked line, and that the next entry opens with the first one's closing balance. If the
         admin changes the opening balance while a row waits, the row ends `bank_balance_changed`.
       - A11: POST the same bank entry body twice: two entries (Exact has no idempotency, which is
         why the probe, the item read-back and the balance check are mandatory). Reverse the test
         entries afterwards.
       - The bytes you posted by hand must equal the preview bodies byte for byte. Fix `EXACT_WRITE_NAMES` / the
         builders where Exact differs (this changes `BOOKING_PROTOCOL_VERSION`; start this item
         again). Then reverse the by-hand test entries in Exact and create a fresh test match.
    5. **Verify.** In the Booking card (Settings): "Verify write path" with a note (10 to 500
       characters) that lists what you checked; the dialog has one tick per check
       (`BOOKING_VERIFY_CHECKS`; the server refuses the verification unless every one is ticked):
       - `probe_zero_for_random_ref`: "The duplicate probe finds nothing for a random reference"
         (A6/A13 above).
       - `bank_entry_sign`: "The bank entry has the right sign" (A1, A3, A7, A9, A10).
       - `matchset_signs_and_control_account`: "The match uses the right signs and control
         account" (A2, A4, A5, A8, A14, A15, A16).
       - `balance_chain`: "The balance chain continues" (A12).
       - `matchset_readback`: "The read-back shows the invoice as paid" (A16).
       - `lost_answer_drill`: "The lost-answer drill passed" (step 8 (a), Lost answer; do it on the
         test division before verifying).
       - `preview_matches_manual_payload`: "Preview booking matches what you sent by hand" (step 4,
         byte for byte).

       It asks for the phrase
       `I VERIFIED THE EXACT WRITE PATH ON A TEST DIVISION`; the note is stored with your email,
       the time, the protocol version, the ticked checks and the booking mode. Verifying always
       leaves booking off.
    6. **Limits, then enable for ONE division.** "Enable booking" in the Booking card (fresh
       sign-in, phrase `ENABLE EXACT BOOKING`): tick ONLY the test administration and keep "Matches
       booked per run" at 1. The dialog reads the settings again (it stops if a blocker appeared
       meanwhile), then sends ONE call that carries the limits with the switch: `PUT
       /api/booking/settings {"enabled":true,"confirm":"ENABLE EXACT BOOKING",
       "divisions":[<our id of the TEST division>],"maxPerRun":1}` (only the limits that differ
       from what is stored are sent). The server checks every precondition against those limits
       and writes them, the switch and the watermark in one batch. Enabling sets the watermark
       `bookingFrom` to now (a value sent along can only move it later), so only matches made from
       now on are booked; the dialog shows how many existing matches stay untouched
       (`backlogIfEnabledNow`) and the card shows the recorded watermark afterwards (`backlogCount`
       then counts the matches older than it). `GET /api/booking/settings` must show no blockers.
       Moving the watermark EARLIER later on re-opens older matches: look first with `GET
       /api/booking/settings?bookingFrom=<ISO>` (`proposed.reopenedCount`), then `PUT
       {"bookingFrom":"<ISO>"}` (fresh sign-in, audited with the count).
    7. **Book one.** Create one real test match in the app (a test bank line against the test
       invoice, made AFTER the switch-on), wait out the 10-minute undo window, and press **Run
       now** on `exact.book_matches` (admin, fresh sign-in; the job itself ships disabled). Expect
       one bank entry (or none when the feed creates the lines), one MatchSet, both outbox rows
       `verified`, the match `matched_in_exact`. **Check both in the Exact UI.**
    8. **Failure drills.** (a) Lost answer: block the network to Exact right after the POST (or
       stop the Worker); the row must be `outcome_unknown`, the next run must NOT post again;
       `retry` must find the entry (probe) and not duplicate it. (b) Switch booking off between
       two runs and mid-run: nothing more is sent; switch it on again. (c) A part payment ends
       `manual_required` (nothing sent; Undo and `retry` both work). (d) Book something by hand in
       the test journal while a row waits: the row must end `manual_required`
       `bank_balance_changed`. (e) Settle the test invoice in Exact by hand AFTER the match was
       made (stale D1): the row must end `manual_required` `already_settled_in_exact` with NOTHING
       posted. (f) Change `createsBankEntries` on the Revolut connection: booking must switch off
       and the verification disappear. (g) Lost MatchSet answer, then somebody settles the invoice
       by hand with ANOTHER payment: after `retry` the row must end `manual_required`
       `already_settled_in_exact` (our bank line is still open), never `matched_in_exact`.
    9. **Production.** Only then on production, with `exact.book_matches` still disabled: repeat
       steps 2 to 7 for ONE real match (division allow-list = the production division, `maxPerRun`
       1, a fresh watermark), check it in Exact, and keep `maxPerRun` at 1 for a few days. Raise
       `maxPerRun` (up to 10, fresh sign-in) and switch the job on (5-minute schedule, 30 calls per
       run, 400 per 25 hours: about 40 matches a day at roughly 10 calls each) only after those
       bookings were checked. Booking stays off after every new verification until you enable it
       again, and every re-enable moves the watermark to now.
    - **Done when:** the Verify note records every check, `GET /api/booking/settings` shows no
      blockers, and one match completed end to end on the test division and on production.

### First-live checklist: Revolut connect, webhook, sync and backfill (ADR 0030, 0031, 0033)

Skip this section if Revolut is not configured on the deployment. **Nothing in it has been run
against a real Revolut account;** every answer below is an assumption in ADR 0030, 0031 or 0033 and
must be recorded there (and the code, fixtures and ADR fixed together) when it turns out different.

**Sandbox first, via staging** (see "Staging first" below): connect the staging Worker to a Revolut
**sandbox** business account and run every item there before production. The production connection
is made only after staging connected, delivered, verified and processed real sandbox webhooks.
Local `wrangler dev` or a tunnel cannot do this: connecting and confirming call `RevolutGate`, a
Durable Object with an EU jurisdiction, which workerd does not implement (see "Local
development"). The webhook URL must be public https and `workers.dev` is off, so staging is the
place.

Before you start: step 0 items 11 to 15 done, the staging Worker has `REVOLUT_CLIENT_ID`,
`REVOLUT_REDIRECT_URI`, `REVOLUT_ISSUER` (vars, sandbox certificate) and the secret
`REVOLUT_PRIVATE_KEY`, and `GET /api/connections` shows `revolutConfigured: true`. The Revolut jobs
are still **off**.

**A. Connect (ADR 0030/0031).** Settings, Connections, Revolut Business card, as an admin with a
fresh sign-in:

1. The card has no preselected environment and Connect stays disabled until you choose the
   environment (Sandbox for staging) and who creates bank entries; check the payments mode (it
   starts on drafts). Choose and press Connect. Check the browser goes to the **consent URL**
   `https://sandbox-business.revolut.com/app-confirm?client_id=...&redirect_uri=...&response_type=code&state=...`
   (production: `business.revolut.com`). Record the real path and parameters if different.
2. Approve in Revolut. Check the redirect back to `/api/connections/revolut/callback` carries
   `state` (**state echo**). If `state` is **not** echoed the flow is bound only by the signed
   cookie and the confirm step is the only defence: note it in ADR 0031 and keep the confirm step.
3. The token exchange succeeds (**assertion claims**: `iss` = `REVOLUT_ISSUER`, `sub` = client id,
   `aud` = `https://revolut.com`, RS256, our extra `iat` and `jti` tolerated). On `invalid_client`
   or `invalid_request` check issuer, client id and that the uploaded certificate matches the key
   (the MD5 check in step 0); the card then says the app credentials were rejected.
4. Check the **`expires_in`** Revolut returns (assumed about 2399 s) and whether a **refresh token**
   comes back on the code exchange. After the first refresh (within the hour, or force it by
   waiting) check whether the refresh token **rotates** (a new value each time) or stays: the gate
   handles both, record which. Look for `needs_reauth` after a day: the refresh token's lifetime
   (**90 days?**, open decision 1) decides how often someone must re-authorise.
5. The **accounts list** and bank details read for the staged connection: the card shows the
   masked summary (account names, currencies, holder, last 4 of each IBAN). Compare with the
   sandbox account. A failure ends in `verification_failed` and wipes the staged tokens.
6. **Confirm step.** The card asks you to confirm the accounts are yours (and, for a changed
   account set, to replace the old ones). Confirm within 15 minutes; an unconfirmed staging expires
   (`pending_expired`, tokens wiped). Check the audit log has `revolut_staged` and
   `revolut_confirmed`, and that a second start while connected is refused (409).

**B. Webhook, sync and backfill (ADR 0033).**

The webhook URL is `<app origin>/api/webhooks/revolut`. It must be **public https**: Revolut calls
it from the internet. No variable to set: it is derived from `REVOLUT_REDIRECT_URI`. The route must
not sit behind Cloudflare Access or any other sign-in (Revolut has no cookie); it authenticates
every request by its HMAC signature and answers one fixed 401 to everything unsigned. Confirming
the connection registers the subscription and queues the 90-day backfill; if Connections says the
webhook is not registered, use "Register webhook" (admin, fresh sign-in).

7. After confirming, `GET /api/connections` shows `revolut.webhookRegistered: true`; `last_error` is
   empty. In Revolut Business (Settings, APIs, Webhooks) one subscription points at the URL above
   (**UNVERIFIED** menu path).
8. Send a test payment (EUR 0.01 between two own accounts, sandbox) and watch `webhook_events`:
   `SELECT id, event_type, status, error_code, received_at, processed_at FROM webhook_events ORDER BY id DESC LIMIT 5`
   (`wrangler d1 execute ... --remote --env staging`). Expect `processed` within seconds and rows in
   `bank_transactions` (`source = 'webhook'`, two rows for a transfer). A 401 in the Revolut
   delivery log means the signature check failed: record the exact header names, the timestamp unit
   (we expect epoch milliseconds in `Revolut-Request-Timestamp`) and the signed-payload format, and
   fix ADR 0030/0033 and `packages/revolut` together.
9. Verify the assumptions of ADR 0033 (payload shape, whether `TransactionStateChanged` fires for
   every state, retry timing, the rate limit) and note the answers there.
10. Run "Run now" on `revolut.backfill`, then switch on `revolut.sync` (Settings, Schedules). Check
    the Bank screen shows balances and that `revolut_sync_state` has `last_status = 'ok'` for
    `accounts` and `transactions`. The daily backfill result reports `missing`: a number above zero
    on ordinary days means webhooks or the poll missed transactions.
11. Dead letters: events that exhaust their retries end as `webhook_events.status = 'error'`; the
    poll and backfill still pick the transaction up.
12. The initial 90-day backfill is a manual run (never retried automatically). If its result is
    `partial` / `initial_backfill_incomplete`, press "Run now" on `revolut.backfill` again (or let
    the daily slot run once it is switched on) until it ends `ok`: each run resumes the stored cursor.
13. While the connection is `needs_reauth` / `expired`, signed deliveries are still accepted and
    recorded (`webhook_events.error_code = 'needs_reauth'`). After re-authorising, "Run now" on
    `revolut.backfill` recovers those transactions.
14. After a day of running on staging, repeat A and B on production with the **production**
    certificate, client ID and environment, starting again with the Revolut jobs off.

## Staging first

`wrangler.toml` has a complete `[env.staging]` block (ADR 0029): Worker `camelthorn-finance-staging`,
its own D1 database `camelthorn-finance-staging`, queues `camelthorn-jobs-staging` and
`camelthorn-jobs-staging-dlq`, its own `ExactGate`, `JobLock` and `RevolutGate` objects (a Durable
Object namespace belongs to its Worker), its own variables and cron. Nothing is shared with production, and the
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
   `EXACT_CLIENT_ID`, `EXACT_REDIRECT_URI` and `routes` inside `[env.staging]`, and, if Revolut is
   used, all three of `REVOLUT_CLIENT_ID` (the **sandbox** certificate's client ID),
   `REVOLUT_REDIRECT_URI` (`https://<staging host>/api/connections/revolut/callback`, registered
   on the sandbox certificate) and `REVOLUT_ISSUER` (the staging host). Then
   `pnpm run check:deploy:staging` (from `apps/worker`). The staging `RevolutGate` binding and
   migration `v3` are already in `[env.staging]`; the guard checks them.
4. Step 5: every secret again for the staging Worker, with a **different** `TOKEN_ENC_KEY`:
   `pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env staging` and so on, including
   `REVOLUT_PRIVATE_KEY` (the sandbox key pair from step 0) when Revolut is used:
   `pnpm exec wrangler secret put REVOLUT_PRIVATE_KEY --env staging < revolut-private-pkcs8.pem`.
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

Where things can run: Durable Object jurisdictions (`ExactGate`, `JobLock`, `RevolutGate`) are
not implemented in workerd, so they can be exercised **only on staging or production**, never in
local `wrangler dev` (nor through a tunnel to it) or with `--remote` aimed at production. This
includes connecting Revolut, confirming it and registering its webhook. Unit tests stub the call.

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
   calls; the sync defaults allow up to 1,960 per administration and day (ADR 0021), 2,460 with
   `exact.bank_balances` switched on (at most 20 calls x 24 hourly runs, usually 24 x mapped accounts).
5. Enable `exact.full_sync` (nightly, 02:00) in Settings, Schedules. Look at the next morning's run.
6. Then enable the hourly `exact.incremental_sync`. Check one day of hourly runs (2 to 4 calls
   each) and the daily total in `exact_usage`.
7. Repeat the whole procedure on production with the real administration, starting again with the
   jobs off and a daytime Run now (commands without `--env staging`, production database name).

---

## Operations

### ECB exchange rates (the one job that is on by default)

`ecb.fx_import` is switched **on** after a fresh install, unlike the Exact and Revolut jobs. It reads
the public ECB reference rates (`data-api.ecb.europa.eu`, no credentials, read-only) on TARGET
working days at 16:15 Amsterdam and retries every 10 minutes until 17:30 (ADR 0036). Nothing needs
configuring. A database seeded before this job existed keeps it off: switch it on in Settings,
Schedules.

- A fresh install has no rates until the first slot (up to about three days over a weekend). Press
  **Import now** on Settings, FX rates, or Run now on the job, once after the first deploy.
- To turn it off: Settings, Schedules, switch the job off, or
  `pnpm exec wrangler d1 execute <database> --remote --command "UPDATE jobs SET enabled = 0 WHERE name = 'ecb.fx_import'"`.
- First-live checks (**unverified**, the sandbox cannot reach the ECB): the response is accepted as
  `text/csv`; the 400-day first import stays under 5 MiB and contains about 30 currencies (if it
  does not, the same run asks again for 120 and then 30 days and later runs fetch the older history
  60 days at a time until 400 days are covered, ADR 0036; the summary's `windowDays` says which
  window was used and `backfillFrom` / `backfillPending` show the steps); three rates compared by hand with the ECB website; Settings, FX rates
  shows the import as OK; one `fx.import` audit row exists.
- A rate the ECB later changes is never overwritten. It shows as a conflict in
  `GET /api/fx/conflicts` (admin, finance) and in `unresolvedConflicts` of `GET /api/fx/rates`; an
  admin with a Google sign-in from the last 15 minutes resolves it with
  `POST /api/fx/conflicts/<id>/resolve` and `{"resolution":"kept"|"accepted","confirm":true}`
  (ADR 0039). The month-end revaluation (Phase 12) refuses a date with an unresolved conflict.
- Do not alert on `fx_import_state.last_status` alone: read the rate age (`fxStaleness`) and the
  `job_runs` of `ecb.fx_import` (ADR 0036 addendum).
- The rates are for information only. Whether your accountant accepts them for revaluation is open
  decision 4.

### Bank matching (Phase 7, M7b; ADR 0042)

`bank.match` is switched **on** after a fresh install (every 10 minutes at :02, :12, ...). It reads
completed Revolut transactions and open invoices and bills from D1 and writes **suggestions** for
the review queue. Matching itself never writes to Exact or Revolut. A separate booking step exists
(job `exact.book_matches`, Settings, Matching, Booking in Exact): it is **OFF by default and fails
closed**, so a fresh or upgraded install writes nothing to Exact until an administrator verifies
the write path and enables it (step 0, item 18). Revolut is never written to by matching or
booking. Existing databases get the job when the new release starts (default jobs version 3).

- **Automatic matching is off.** Turn it on only after reviewing suggestions for a while:
  `PUT /api/matching/config` with `{"autoEnabled":true,"confirm":"ENABLE AUTOMATIC MATCHING"}`
  (admin, sign-in within 15 minutes). An automatic match is only an internal match with an Undo
  while it is not booked in Exact. Turn it off with `POST /api/matching/auto/disable` (admin, no
  fresh sign-in needed) or `{"autoEnabled":false}` on the config route.
- **Every Revolut account must be mapped to an Exact administration** before anything is matched:
  `PUT /api/matching/account-map` with `{"bankAccountId":..,"divisionId":..,"journalCode":"90",
  "bankGlAccountCode":"1210"}` (admin, step-up). Unmapped accounts are counted in the job result
  (`unmapped_accounts`) and in `GET /api/matching/stats`; their lines are never matched.
- Matching settings, patterns and the map are audited (`matching.*` actions). Patterns for bank
  fees and similar ledger postings are suggestions only unless `autoLedgerPatterns` is switched on.
- Emergency stop: `{"enabled":false}` on the same config route, or switch the job off in Settings,
  Schedules. Open matches stay; use `POST /api/matching/matches/<id>/undo` per match.
- `GET /api/matching/stats` `matchesNeedingReview` > 0 means a match no longer agrees with Exact or
  Revolut (an invoice paid elsewhere, a state conflict). Such a match is never booked; open the line
  and undo it. A state conflict is cleared by an admin with a note
  (`POST /api/matching/transactions/<id>/clear-conflict`, fresh sign-in).
- Check after the first live run: the `bank.match` run in Settings, Schedules is `ok` with
  `evaluated` > 0; `GET /api/matching/queue` shows candidates with plain-English explanations;
  no response contains a full IBAN.
- First-live checks of migration 0022 (staging first, then production), because the trigger
  behaviour is only tested on Miniflare:
  1. After `wrangler d1 migrations apply <db> --remote`, `SELECT name FROM sqlite_master WHERE
     type = 'trigger' ORDER BY name` lists exactly the triggers created by migrations
     0022/0023/0024/0025 and not dropped later; the authoritative list and a hash of each body is
     `apps/worker/test/fixtures/trigger-hashes.json` (do not rely on a number written here). If
     wrangler split a trigger body, the migration fails; do not hand-edit.
  2. On staging only: with a test line and an invoice smaller than it, a manual match whose
     allocation passes the open balance returns 409 `item_changed` and leaves NO `matches` row and
     no `match.manual` audit row (D1 batch rollback on a trigger abort).
  3. `PRAGMA foreign_key_check` returns no rows; `SELECT COUNT(*) FROM bank_transactions WHERE
     match_status = 'matched'` equals the number of live matches.
  Residual uncertainty: D1 documents batches as transactions, but not trigger `RAISE(ABORT)`
  explicitly; check 2 is the proof. VIRTUAL generated columns and partial indexes are standard
  SQLite features that D1 supports.

### Data quality (Phase 8, D8a; ADR 0045)

Two jobs, with different risk:

- **`dq.checks`** (hourly at :20) reads **only D1**: it makes no call to Exact or Revolut and writes
  only the data quality tables (`dq_issues`, `dq_rule_status`, `dq_runs`). It is switched **on** after
  a fresh install. A database that already has the job row keeps whatever `enabled` it stored (the
  seeding never flips a row), so after the upgrade an admin switches it on in Settings, Schedules (or
  `UPDATE jobs SET enabled = 1 WHERE name = 'dq.checks'`). **The digest job `dq.digest` is different:
  it does not exist before this release, so the next start inserts it ENABLED, while `dq.checks` stays
  off on an upgraded install.** That is harmless and honest: the digest only records a skipped row until
  an e-mail provider is set, and once it is, it opens with "Data quality checks have never run" (or "have
  not run since <date>") instead of "0 open issues". Switch `dq.checks` on first. Alerts and the digest
  are described in the next section (ADR 0046); there is no screen yet (D8c), read the result through
  the API.
- **`exact.bank_balances`** reads from Exact (one `financial/ReportingBalance` call per mapped bank
  account, at most 20 calls per run and administration) and stores `bank_accounts.exact_balance_minor`.
  It ships **off** (`awaiting_live_verification`). Enable it only after the checks below.
  **Existing installs:** the job was a placeholder until now, so an admin may have switched its row on.
  The release therefore forces it off once: `DEFAULT_JOBS_VERSION` 6 carries a one-off guard
  (`FORCE_OFF_AT_VERSION`) that, at the first start after the upgrade, sets `enabled = 0` on an enabled
  `exact.bank_balances` row and writes the audit row `job.forced_off` (before and after, reason
  `awaiting_live_verification`). No manual SQL is needed. It runs only once; an admin who switches the
  job on afterwards (after check 7) is not overruled by a later start. Look for the audit row to see
  whether it fired. The account tried longest ago is read first (setting
  `exact.bank_balances.attempts`), so an account that never yields a balance cannot starve the others.

First-live checks, on staging first:

1. After migration 0026 (`wrangler d1 migrations apply <db> --remote`): the tables `dq_rules`,
   `dq_issues`, `dq_rule_status`, `dq_runs` exist; the four triggers `dq_issues_identity`,
   `dq_issues_reopen_path`, `dq_issues_counter`, `dq_issues_keep_live` are listed in
   `sqlite_master` (hashes: `apps/worker/test/fixtures/trigger-hashes.json`); `bank_accounts` has
   `exact_balance_minor` and `exact_balance_at`.
2. Press **Run now** on `dq.checks` (Settings, Schedules). Expect `ok` with `rulesEvaluated` > 0.
   `rulesUnavailable` is normally 5 to 9 (bounced e-mails, disputed invoices, VAT code, closed period,
   suspense accounts not configured, Exact balance, ...): that is correct, see the next item. Before the
   first Exact sync (and the first Revolut read) many more rules are unavailable with the reason
   **`source_never_synced`**; once a source's last complete sync is older than 26 hours (4 days for the
   IBAN read and the ledger) the reason is **`source_stale`**. Both are correct and never `ok`: run the
   syncs, then the checks. Old issues stay open meanwhile.
3. `GET /api/dq/summary` lists all 27 rules. Check that every rule that could not be evaluated says
   **`not_available` or `not_configured` with a reason**, never `ok`, and that `never_run` is gone.
   A rule at `error` means a bug: report it (the run is `partial`, `section_failed`).
4. `GET /api/dq/issues`: spot-check five issues against Exact and Revolut (an old unmatched line, a
   duplicate bill, a supplier whose IBAN changed). No response may contain a full IBAN.
5. Run it again: no new issues for the same data, `last_seen_at` moves. Fix a problem in Exact, sync,
   run again: the issue becomes `resolved` by `system`. Snooze one (`POST
   /api/dq/issues/<id>/snooze {"until":"<ISO within 90 days>","note":"..."}`) and run again: it stays
   snoozed.
6. Suspense accounts: `PATCH /api/dq/rules/ledger.suspense_not_zero` with `{"threshold":["1999"],
   "rev":null}` (admin, fresh sign-in) to list your GL codes; until then the rule says
   `not_configured`. Loosening a **critical** rule (switching it off, lowering its severity, a larger
   window) needs `"confirm":"LOOSEN CRITICAL DATA QUALITY RULE"`.
7. **`exact.bank_balances`** (before switching it on): Revolut accounts must be mapped (`PUT
   /api/matching/account-map`) and the chart (`gl_accounts`) synced. Run it once by hand and look at
   the result: `stored` equals the number of mapped accounts, `calls` the same, `empty_answer` and
   `incomplete_read` and `other_account_rows` are 0 (`other_account_rows` > 0 means Exact ignored
   the `GLAccount` filter: A-1 failed, keep the job off). Compare `bank_accounts.exact_balance_minor` with the balance of that
   ledger account in Exact's own balance report. **Verify the A-items of ADR 0045**: the filter
   `GLAccount eq guid'...' and ReportingYear eq <year>` is accepted (a 400 means the filter or a field
   name is wrong), and the sum of the periods equals Exact's balance. Only then enable the job.
8. Housekeeping: resolved issues are deleted after 180 days by the run itself; `dq_runs` has one row
   per run (about 9,000 a year at hourly).

### Data quality notifications: alerts and the daily digest (Phase 8, D8b; ADR 0046)

Two things send e-mail: an **instant alert** for each new or reopened **critical** issue (from
`dq.checks`), and the **daily digest** (`dq.digest`, 08:00 Europe/Amsterdam, default row enabled).
Both are silent until an e-mail provider is configured: they record `skipped_not_configured` in
`email_log` and nothing else. The provider is **provisional** (ADR 0046, open decision 5).

Existing installs: the next Worker start adds the job row `dq.digest` (enabled; it only records a
skipped row until step 3), and migration 0027 replaces the `email_log` table (it was never written).
Note the combination on an upgraded install: **`dq.digest` arrives enabled while `dq.checks` keeps
whatever it had (off on installs that never switched it on)**. Nothing is wrong: with no provider the
digest ends `skipped / email_not_configured`, and the staleness check does not count that as a failure
(a job whose last run is a deliberate skip, `email_not_configured`, `notifications_disabled` or
`no_recipients`, is not judged by `integrations.job_stale`). Once a provider is configured and
`dq.checks` is still off, the digest says "Data quality checks have never run" (or "have not run since
<date>", when the last run is older than 6 hours) instead of a count of zero: switch `dq.checks` on.
Alert keys changed in this release (`dq-alert:<issue id>:<reopen count>`; before, the fingerprint): open
issues that were already alerted keep their `notified_at` and old `email_log` rows are still recognised
for the same issue row, so nobody is alerted twice by the upgrade.

How to enable (staging first, `--env staging` on every command):

1. Pick a transactional e-mail provider with an HTTPS API that accepts `POST /emails` with
   `Authorization: Bearer <key>` and JSON `{from, to[], subject, html, text}` (Resend does). Verify
   the sender address or domain with the provider (SPF/DKIM) so mail from it is delivered.
2. Store the key as a secret, never in `wrangler.toml`: `pnpm exec wrangler secret put EMAIL_API_KEY`.
3. As an admin with a fresh sign-in set the sender and the links:
   `PATCH /api/dq/notifications` with `{"rev": <rev from GET>, "emailProvider": "https", "emailHost":
   "<provider host>", "emailFrom": "<verified sender>", "baseUrl": "https://<app host>"}`.
   `GET /api/dq/notifications` must now say `apiKeyPresent: true`, `senderActive: true` and a
   `recipientCount` equal to your admins and finance users on the camelthorncapital.com domain
   (nobody else ever receives mail: recipients come from the users table only).
4. **Send a test message to yourself**: `POST /api/dq/notifications/test` (fresh sign-in; answer
   `{"status":"sent"}`). It goes to the calling admin only and is limited to one per minute. Check the
   inbox (not spam), the sender, that the link is clickable. A `failed` answer carries a code
   (`http_401` wrong key, `http_403`/`http_422` unverified sender or payload); `unknown` means a
   timeout or a 5xx: check the provider dashboard before trying again.
5. First-live checks: run `dq.digest` once by hand (Settings, Schedules, fresh sign-in). Expect one
   mail per admin or finance user, a subject that starts with the number (or, when the checks have
   not run lately, "Data quality checks have never run" / "have not run since <date>"), counts that
   match `GET /api/dq/summary` **for all administrations** (the digest always covers every
   administration and the global checks; the summary covers the administration you ask for plus the
   global ones, so compare with the sum over administrations; both leave out issues of rules that are
   switched off and show snoozed issues apart), links that open the right screen, and a list of rules
   that were not evaluated with reasons (rules switched off are not listed). Run it again the same day: `sent: 0, already: N` and no second mail.
6. Instant alert: with a harmless critical issue present (for example switch `payables.supplier_iban_changed`
   threshold or wait for a real one), the next `dq.checks` run sends **one** mail and sets
   `dq_issues.notified_at`. Check `SELECT kind, status, recipients_count, error_code FROM email_log`.
   A second run sends nothing. `GET /api/jobs` shows `alertsSent`, `alertsFailed`, `alertsUnknown` in
   the last result.
7. Limits and what to watch: at most 10 mails per run (`maxAlertsPerRun`, 1 to 50; retries and single
   alerts together), everything else that is pending in **one** summary mail (it lists ten and states the
   total). Sends are 300 ms apart. The same issue fingerprint is alerted at most once in 24 hours (a
   problem that resolves and returns inside that time is left to the daily digest). A provider answer
   of 429 (rate limit) ends the run's sending at once; what was not sent stays pending for the next
   hourly run. A summary the provider refuses gives its issues back, so the next run sends them; refused
   single alerts are retried no sooner than 15 minutes later, three attempts in total.
   `alertsSent` in the job result counts mails the provider accepted; `alertsClaimed` counts claims.
   A row with status `unknown` means the provider's answer was unclear
   (timeout, 5xx) or the Worker stopped between claim and send: it is **never** sent again by the code,
   so look at the provider log. If the mail did not go out, the next daily digest still lists the issue.
   `failed` rows are retried up to three times.
8. Switching off: `PATCH ... {"enabled": false}` stops alerts and the digest; `{"emailProvider":
   "disabled"}` stops sending but keeps the pending criticals for later. Removing a user's admin or
   finance role stops mail to them at the next send.
9. Retention: `email_log` rows older than 400 days are deleted by the alert pass and the digest job. The
   log holds no address, subject or body (counts, codes, provider message id).

Also on existing installs: from this release `dq.checks` resolves open issues of administrations that are
no longer synchronised (`sync_enabled = 0`, or the Exact connection disabled) with the note
`division_not_synchronised` and an audit row `dq.unsynced_resolved`, but only after **7 days** without
synchronisation (counted from the first check run that saw it; setting `dq.unsynced_since`). A failed
reconnect or a short switch-off resolves nothing. Expect a one-off batch of resolved issues a week after
this release if you switched an administration off earlier.

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

### Protecting the Revolut webhook path

`POST /api/webhooks/revolut` is public by design (Revolut cannot sign in). A request with a fresh
13-digit timestamp and any well-formed `v1=` signature passes the cheap header check and costs two
database reads plus one HMAC before it is rejected, and the app cannot avoid that because it needs
the secret to verify. The app bounds what it writes (one rejection batch per reason per minute per
isolate, ADR 0033), but the real mitigation is at the edge. Add a Cloudflare rate-limiting rule on
the zone for this path, for example **60 requests per minute per IP, block for 10 minutes**
(Security, WAF, Rate limiting rules; the exact menu names are **unverified**). Do not put Cloudflare
Access in front of this path.

### Rotating secrets

- `TOKEN_ENC_KEY` covers **everything the app encrypts**: the Exact tokens, the Revolut access and
  refresh tokens **and the Revolut webhook signing secrets**. Procedure (**verify on staging
  first**; nothing here has been run on a real deployment):
  1. Put the old value in `TOKEN_ENC_KEY_PREVIOUS` and the new one in `TOKEN_ENC_KEY`
     (`secret put` for both), then deploy.
  2. Wait for a refresh cycle: Exact and Revolut tokens are rewritten with the current key when
     they refresh, within about an hour while the connections are used (a Revolut access token
     lives about 40 minutes). The Revolut webhook signing secrets are rewritten with the current
     key at the Revolut gate's next token refresh and when a delivery is verified with a secret
     still under the previous key (implemented in review S3 / task Q2; **not yet run on a real
     deployment, verify on staging**). Send a EUR 0.01 sandbox payment to have a delivery.
  3. Check before deleting: the Connections screen shows both connections as Connected with no
     error and does not report the Revolut webhook secret as unreadable (admins see this; "unknown"
     is not the same as unreadable), and `webhook_events` has a recent `processed` row. There is no
     count of values still under the old key, so this check is the signal.
  4. Only then `pnpm exec wrangler secret delete TOKEN_ENC_KEY_PREVIOUS`.
  Deleting the previous key too early is recoverable: stored values are never changed by dropping a
  key, so put the old key back as `TOKEN_ENC_KEY_PREVIOUS` and wait for the next refresh or
  delivery. While a webhook secret is unreadable every delivery fails signature verification (the
  poll and the daily backfill still catch up). Only if the key is truly lost without a copy do
  Exact and Revolut need reconnecting (Settings, Connections).
- `GOOGLE_CLIENT_SECRET`: create a new secret on the Google OAuth client, `secret put`, then remove
  the old one in Google.
- `REVOLUT_PRIVATE_KEY`: create a new key pair and certificate (step 0), upload the certificate in
  Revolut Business, `secret put` the new key, update `REVOLUT_CLIENT_ID` if it changed, deploy.
  Existing refresh tokens belong to the old client; whether they survive is **unverified**, be
  ready to re-authorise (Settings, Connections). Remove the old certificate in Revolut afterwards.
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
5. Any migration that rebuilds a guarded table (create new, copy, drop old, rename) must recreate
   that table's triggers in the same file: dropping a table silently drops its triggers, and the
   guards (matching, booking, settlement) then no longer exist. Compare the trigger list with
   `apps/worker/test/fixtures/trigger-hashes.json` after every such migration.

---

## Local development

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars    # git-ignored; fill in
pnpm --filter @camelthorn/worker dev                       # Worker on :8787
pnpm --filter @camelthorn/web dev                          # UI on :5173, proxies /api to :8787
```

- `.dev.vars` holds the secrets (placeholders in the example; `REVOLUT_PRIVATE_KEY` only matters if
  you work on Revolut) and overrides public variables.
  Local sign-in needs `OAUTH_REDIRECT_URI=http://localhost:5173/api/auth/callback` and
  `EXACT_REDIRECT_URI=http://localhost:5173/api/connections/exact/callback` (already in the example),
  and `GOOGLE_CLIENT_ID` (and `EXACT_CLIENT_ID`) set there until the committed values are filled.
  The localhost redirect URI must be registered on the Google OAuth client. The browser uses port
  5173, so cookies and the CSRF origin match the redirect URI.
- Local migrations: `pnpm exec wrangler d1 migrations apply camelthorn-finance --local` (from
  `apps/worker`).
- Durable Object jurisdiction: plain `wrangler dev` (workerd) does not implement jurisdictions, so
  Exact calls and `JobLock` use fail locally with "Jurisdiction restrictions are not implemented in
  workerd". The same holds for `RevolutGate`, so the Revolut connect, confirm and webhook
  registration cannot be tried locally or through a tunnel either (Revolut also needs an https
  redirect URI). There is no local way around it (no switch exists, by design, ADR 0018).
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

## Today queue and Data health (Phase 8, D8c)

No new migration, secret or variable. `GET /api/today` reads D1 only. The home route is now Today; Data health is at `/data-health` (footer and Overview link). "Later" on the Today queue is stored in the browser only (ADR 0047). The queue shows data issues only after the `dq.checks` job has run (see the data quality section).
