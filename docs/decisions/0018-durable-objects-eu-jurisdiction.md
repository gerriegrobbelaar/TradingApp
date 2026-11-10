# 0018 Durable Objects use the EU jurisdiction
Status: accepted (review S6)

## Context
CLAUDE.md 2 puts D1 and R2 in the EU. Durable Objects hold Exact limiter state, job budgets and (briefly, encrypted) a stashed token pair, so they should stay in the EU too. A Durable Object namespace can restrict objects to a jurisdiction with `env.EXACT_GATE.jurisdiction("eu")`. The jurisdiction is part of the object id: the same name under `eu` and under no jurisdiction are two different objects, and an object cannot be moved.

## Decision
- Every `ExactGate` stub (division gates `exact:<n>`, token authorities `exact-token:<connectionId>`) is created by one helper, `getExactGate(env, name)` in `apps/worker/src/exact/gate-transport.ts`, which calls `env.EXACT_GATE.jurisdiction("eu").idFromName(name)`. No other code may call `EXACT_GATE.idFromName` or `EXACT_GATE.get`.
- This must be decided before the first deploy. After objects exist under one jurisdiction, switching creates fresh empty objects: daily counters and job budgets reset (a one-time loss of a day's accounting, so a budget could be spent twice) and any stashed token pair is orphaned. Token authority state is otherwise reconstructible from D1.
- `@cloudflare/workers-types` 4.20260702.1 types `jurisdiction()` and `idFromName` on the returned namespace. The Workers runtime supports it; **workerd (Miniflare, used by the vitest pool) does not** and throws "Jurisdiction restrictions are not implemented in workerd".

## Consequences for tests and local development
- There is **no environment variable, binding or flag** that switches the jurisdiction off, so nothing set in the dashboard, `wrangler.toml` or a secret can move production objects out of the EU. The test seam is code: `setGateNamespaceResolverForTests` in `gate-transport.ts`, called only from `apps/worker/test/do-namespace.ts` (a vitest setup file) to use the plain namespace, because workerd does not implement jurisdictions. A test scans every file under `apps/worker/src` and fails if any of them calls the seam, mentions `DO_JURISDICTION_DISABLED`, or calls `EXACT_GATE.idFromName` / `.get` / `.idFromString` / `.newUniqueId` outside `gate-transport.ts`. (Review G2 replaced an earlier `DO_JURISDICTION_DISABLED="1"` variable, which a Workers variable or secret could have set in production.) `scripts/deploy-config.mjs` still refuses a `wrangler.toml` that mentions the old variable.
- `wrangler dev` (workerd) has the same limitation: Exact calls fail locally with "Jurisdiction restrictions are not implemented in workerd". Use `wrangler dev --remote` to try the Exact connection. Object names are identical in tests and production; the ids differ, so nothing persisted locally carries over.
- Unit tests assert that the production resolver calls `jurisdiction("eu")` and never the global namespace, whatever variables are set.
- The sync's job budgets (`startJob` / `endJob` in `apps/worker/src/exact/sync.ts`) use `getExactGate(env, gateName(division))` too (task G1), so budgets are set on the same EU object that serves the calls. The source scan has no exceptions.

## Verify on first deploy
After the first deploy check in the dashboard (Workers, Durable Objects, `ExactGate`) that objects are listed with jurisdiction EU, and that a sync's job budget shows up on the same object that served the calls.
