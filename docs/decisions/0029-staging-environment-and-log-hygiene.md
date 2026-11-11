# ADR 0029: Staging environment, log hygiene and the CPU limit
Status: accepted (Phase 4 review S6, S7, S5)

## Context
Nothing has run against real Exact, Cloudflare or Google. Durable Object jurisdictions are not
implemented in workerd, so the Exact gate and the scheduler lock cannot run locally at all (ADR
0018). `wrangler dev --remote` would use the production account's real D1 and objects. We need a
place to run the first-live checklist (docs/DEPLOY.md step 10) without touching production data.

## Decision
### Staging environment
- `wrangler.toml` has an `[env.staging]` block: Worker `camelthorn-finance-staging`, its own D1
  database (`camelthorn-finance-staging`, EU), queues `camelthorn-jobs-staging` and
  `camelthorn-jobs-staging-dlq` (EU), the same two Durable Object classes and migrations (a
  namespace belongs to its Worker, so a separate Worker name means separate objects), its own
  variables (hostname, redirect URIs) and cron. Wrangler environments inherit no bindings, so
  everything is written out.
- Secrets are per Worker: staging gets its own (`--env staging`), including its own `TOKEN_ENC_KEY`.
- Wrangler 4.160's inheritance rules (read from its `normalizeAndValidateEnvironment` and checked
  with `unstable_readConfig`): a named environment does **not** inherit `vars`, `d1_databases`,
  `queues` or `durable_objects` (wrangler warns), but **does** inherit `routes`, `triggers`,
  `observability`, `limits`, `assets`, `migrations`, `workers_dev` and `preview_urls` when it leaves
  them out, and a missing `name` becomes `<top name>-<env>`. A table set in the environment
  replaces the top-level one as a whole (no deep merge of `[observability]`). Because routes
  inherit, `[env.staging]` carries `routes = []` until its hostname is known: without the key a
  plain `wrangler deploy --env staging` would move the production custom domain to the staging
  Worker (wrangler only warns). Every inheritable key is written out in `[env.staging]` anyway.
- `scripts/deploy-config.mjs` parses `wrangler.toml` with `smol-toml` 1.9.0, the parser and version
  wrangler 4.160 uses (so comments, quoting, inline tables, dotted keys and table order are read
  the same way), resolves the environment with the rules above and checks the result (`--env
  staging`, default production). In both modes it compares every named environment with
  production and refuses a shared Worker name, D1 database id or name, queue name, route host or
  redirect URI, and Durable Object migrations that differ from production's. `pnpm run
  check:deploy:staging` and `pnpm run deploy:staging` use it; `pnpm run deploy` passes `--env=""`
  so wrangler targets the top level explicitly (without it wrangler warns because several
  environments are defined).
- Staging is where the Exact-facing checklist and the first sync run first, with a test Exact
  division (docs/DEPLOY.md, "Staging first"). Durable Object jurisdictions can only be exercised on
  staging or production, never locally.

### Log hygiene
- `[observability]` sets `redact_query_string = true` (removes query strings from logged URLs, so
  `?q=<customer name>` and OAuth `code` are not stored) and `[observability.logs]
  invocation_logs = false` (no automatic per-request line). Application console output stays: it
  carries reason codes only. Both keys are accepted by wrangler 4.160 (`deploy --dry-run`).
- The guard refuses a missing `[observability]` (wrangler sends the setting only when the key is
  present, so the dashboard's value would stay), invocation logs on at sampling above 0.05, and
  logs or traces without `redact_query_string = true`.
- **UNVERIFIED:** that Cloudflare honours these keys the way their descriptions say (check in the
  dashboard on first deploy that no logged URL carries a query string). Names in URL **paths** are
  not redacted; the web app must not put them there (task M2 removes relation names from the
  address bar).

### CPU limit
- `[limits] cpu_ms = 30000`, Cloudflare's default, written out so a change is a reviewed diff. A
  full pass is bounded by subrequests and Exact's rate limit and runs in resumable chunks. Raise
  (maximum 300000) only if a live run shows CPU-limit errors.
