# apps/web

React front end (Vite). Shared pieces live in `packages/ui` and `packages/core`.

## Tests

```
pnpm --filter @camelthorn/web test        # Vitest + Testing Library, part of `pnpm test`
```

## Screens suites (run before every phase review)

The browser suites in `scripts/*.e2e.ts` are NOT part of `pnpm test`. They drive the production
build in Chrome with the API mocked, take the screenshots in `docs/design/screens/`, check phone
width (no sideways page scroll), axe, console and CSP errors, and the print stylesheet. A screen
that starts a new request (the ECB rates in Phase 6 added `GET /api/fx/rates` to every signed-in
screen) must add that request to the `api()` mock of EVERY script. Answers go through
`scripts/api-mock.ts` (matching and booking endpoints: `scripts/matching-mock.ts`, called from every suite's default branch): a path no mock knows gets a 404 and is recorded, and every suite fails a
test that hit one ("GET /api/x" in the assertion). Phase 6 shipped with seven failing K3b tests for
exactly that reason.

```
pnpm install --frozen-lockfile
pnpm --filter @camelthorn/web build
cd apps/web
PLAYWRIGHT_PATH=/opt/node22/lib/node_modules/playwright/index.mjs \
  pnpm exec vitest run --config scripts/vitest.screens.config.ts
```

Needs Playwright (`PLAYWRIGHT_PATH`, default `playwright`), Chrome (`CHROME_PATH`, default
`/usr/bin/google-chrome`) and poppler's `pdfinfo`, `pdftoppm`, `pdftotext`. Expect all six files
(K3b, R2, R3b, Q2, F3, M7d) to pass. Set `OUT_DIR` to write the
screenshots elsewhere. Commit the regenerated screenshots only for the screens a change touched.
