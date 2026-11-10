# 0018 Durable Objects use the EU jurisdiction
Status: accepted 2026-11-10 (review S6)

## Context
CLAUDE.md 2 puts D1 and R2 in the EU. Durable Objects hold Exact limiter state, job budgets and (briefly, encrypted) a stashed token pair, so they should stay in the EU too. A Durable Object namespace can restrict objects to a jurisdiction with `env.EXACT_GATE.jurisdiction("eu")`. The jurisdiction is part of the object id: the same name under `eu` and under no jurisdiction are two different objects, and an object cannot be moved.

## Decision
- Every `ExactGate` stub (division gates `exact:<n>`, token authorities `exact-token:<connectionId>`) is created by one helper, `getExactGate(env, name)` in `apps/worker/src/exact/gate-transport.ts`, which calls `env.EXACT_GATE.jurisdiction("eu").idFromName(name)`. No other code may call `EXACT_GATE.idFromName` or `EXACT_GATE.get`.
- This must be decided before the first deploy. After objects exist under one jurisdiction, switching creates fresh empty objects: daily counters and job budgets reset (a one-time loss of a day's accounting, so a budget could be spent twice) and any stashed token pair is orphaned. Token authority state is otherwise reconstructible from D1.
- `@cloudflare/workers-types` 4.20260702.1 types `jurisdiction()` and `idFromName` on the returned namespace. The Workers runtime supports it; **workerd (Miniflare, used by the vitest pool) does not** and throws "Jurisdiction restrictions are not implemented in workerd".

## Consequences for tests and local development
- A test-only variable `DO_JURISDICTION_DISABLED="1"` (set in `apps/worker/vitest.config.ts` miniflare bindings only) makes the helper use the plain namespace. Only the exact value `"1"` disables the jurisdiction; anything else, including absent, means EU. `scripts/deploy-config.mjs` refuses to deploy a `wrangler.toml` that mentions the variable.
- `wrangler dev` has the same limitation as workerd. Local runs need the same variable in `.dev.vars` (never in `wrangler.toml`). Object names are identical in tests and production; the ids differ, so nothing persisted locally carries over.
- A unit test asserts the helper calls `jurisdiction("eu")` and never the global namespace.
- `apps/worker/src/exact/sync.ts` (`defaultGate`) must call `getExactGate(env, gateName(division))` too; otherwise job budgets would be set on a different object than the one serving the calls.

## Verify on first deploy
After the first deploy check in the dashboard (Workers, Durable Objects, `ExactGate`) that objects are listed with jurisdiction EU, and that a sync's job budget shows up on the same object that served the calls.
