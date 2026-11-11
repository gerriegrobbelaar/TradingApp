# Camelthorn Finance

A web front end for Exact Online for Camelthorn Advisory B.V.: faster UI, Revolut Business
matching and payments, scheduled jobs, ECB FX, data quality checks and reports. Exact stays the
system of record. The full brief is in [CLAUDE.md](CLAUDE.md); progress is in
[docs/PROGRESS.md](docs/PROGRESS.md).

Runs on Cloudflare Workers (D1 in the EU, R2, Queues, Durable Objects). Front end: React, TypeScript
and Vite, served as Workers static assets. Sign-in is Google only and invite-only.

## Layout

- `apps/web`: React UI
- `apps/worker`: Worker (API, webhooks, cron, queues, Durable Objects)
- `packages/core`: pure domain logic (money, FX, matching, forecast)
- `packages/ui`: design tokens and shared components
- `docs/`: decisions (ADRs), design, deploy runbook

## Development

Needs Node 22 (see `.nvmrc`) and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @camelthorn/web build
```

Run locally (two terminals):

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # fill in; see the file
pnpm --filter @camelthorn/worker dev                      # Worker on :8787
pnpm --filter @camelthorn/web dev                         # UI on :5173, proxies /api
```

Local sign-in needs `OAUTH_REDIRECT_URI=http://localhost:5173/api/auth/callback` (set in
`.dev.vars`, which overrides `wrangler.toml`) and that URI registered on the Google OAuth client.

Deploying, operations (emergency stop, dead-letter queue, restore) and local-development caveats:
[docs/DEPLOY.md](docs/DEPLOY.md), one ordered runbook with a checklist of what a human must do first.
