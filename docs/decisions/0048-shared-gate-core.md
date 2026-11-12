# 0048: One shared core for the Exact gate and the Revolut gate

Status: accepted (task G9, from Phase 5 S11, Phase 6 N7, Phase 7 N8).

## Context

`ExactGate` (ADR 0015, 0016, 0044) and `RevolutGate` (ADR 0031) were two copies of the same
machinery: roughly 450 lines of queueing, budgets, the sliding window, the token refresh and the
stash of a rotated token pair. A fix to a safeguard had to be made twice, and had been applied to
one gate only more than once (see the divergences below). Phase 9 adds the first payment path
(`/pay`, payment drafts, bulk payments). A payment safeguard must live in one place.

## Decision

`apps/worker/src/gate/core.ts` holds `GateCore`, an abstract Durable Object class. `ExactGate` and
`RevolutGate` extend it. Nothing else changed: the class names, the Durable Object ids and names
(`exact:<division>`, `exact-token:<id>`, `revolut:<id>`), the storage keys (`rl`, `role`, `job:*`,
`pending:*`, `client-rejects:*`, `issued:*`), the migrations, the wrangler bindings, the alarm and
the RPC shapes are the same. Existing gate tests pass unmodified except one source scan that read
the text of `exact/gate.ts` for `redirect: "manual"` (the fetch moved into the core; the scan now
reads the core and also asserts that the Exact gate no longer calls `fetch`).

### Shared (one implementation, in `GateCore`)

| Safeguard | Where |
|---|---|
| Queue: user priority, FIFO inside a priority, after 5 user calls in a row a waiting job goes (no starvation), calls queued longer than `maxQueueWaitMs` fail with a retryable rate-limit error | `pickNext`, `noteDispatch`, `expireWaiting`, `pump` |
| Sliding 60 s window (an entry exactly 60 s old is out; a clock that goes backwards cannot grow it), persisted so an eviction does not reset it | `pruneWindow`, `minuteWait`, `persist` |
| UTC day rollover of the counters | `rollover` |
| Per-job budgets: checked at the door and again before every dispatch, counted when the call is spent (a 401 retry costs a second call), persisted, a job that never started still gets a budget, a budget is validated (1..100000) | `request`, `waitFor`, `spend`, `startJob`, `ensureJob` |
| 429: the block is clamped to at least 1 s and at most the gate's maximum, the call is failed (never retried by the gate), later calls wait | `blockAfter429` |
| Role pin: an instance serves exactly one identity, persisted on first use | `claimRole` |
| Single-flight token refresh per connection | `#refreshOnce` (JS-private, reached through the instance property `refreshShared`) |
| Refresh skeleton: a still-fresh token is not refreshed again; no refresh token means `needs_reauth`; client-credential rejection backs off; only a clear `invalid_grant` wipes tokens; the new pair is stored before the new access token is used, retried once, then stashed (ciphertext only) in Durable Object storage and written by the alarm; a failure in the bookkeeping afterwards never wipes tokens; a wrong `TOKEN_ENC_KEY` is `token_unreadable`, not a revoked grant | `#doRefresh`, `flushPending`, `retryStash` |
| One alarm per object, only ever moved earlier | `armAlarm` |
| The one outbound `fetch`: timeout, `redirect: "manual"` (the bearer token never follows a redirect), every failure is a retryable 502 `network` without details | `send` |
| Error classification at the RPC edge: the gate answers with a plain envelope, an unknown error is 503 `gate_unavailable` | `call` |

### Configurable (a hook or a constant of the subclass, never a fork of the logic)

| Difference | Exact | Revolut |
|---|---|---|
| Request validation (SSRF, paths, headers) | `validateRequest` (exact/request.ts) | `validateRequest` (revolut/request.ts) |
| Write policy | `authorize`: every non-GET is refused unless it is one of the two booking writes AND the fail-closed switch, the verification mark, the connection and the division allow-list say so, re-read from D1 at the door and twice more before the call (ADR 0044) | `authorize` is a no-op: the policy is the static allow-list in `validateRequest` (default deny; every payment endpoint refused) |
| Role | `division:<n>` or `authority:<id>` | `connection:<id>` |
| Limits | 60/min, 5,000/day, 10 % user reserve, job budget from `jobs.exact_budget` (default 500) | 60/min, no daily cap, default job budget 200 |
| Daily budget and provider headers | `checkDaily`, `onSpend`, `extraMinuteWait`: Exact's headers can only tighten the limiter | none |
| 429 | maximum block 24 h, wait from Retry-After and reset headers | maximum block 1 h, Retry-After or 60 s |
| Token timing | minimum token age (never refresh a token younger than about 570 s), margin 30 s (`throttle`, `freshMargin`) | margin 60 s, half the lifetime for a short-lived token |
| Token endpoint and failure vocabulary | `openEndpoint`, `classifyFailure` (`bad_host`) | `openEndpoint`, `classifyFailure` (`bad_config`) |
| What is persisted for a pair | `persistPair` (no refresh-token expiry) | `persistPair` (refresh-token expiry, rotation flag; the stash records the expiry) |
| After a refresh | record the issue time | remember the token's lifetime; re-encrypt webhook signing secrets |
| 401 | division gate asks the connection's authority (another object); a token too young to refresh waits and retries once | the gate is its own authority |
| Usage | flushed to `exact_usage` by the alarm | in memory and storage only |

## Invariants any payment path must satisfy

These hold today for every Exact and Revolut call. A payment endpoint (Revolut `/pay`, payment
drafts, bulk payments, an Exact write) may only be added if all of them still hold, and a change
that weakens one is an ADR first.

1. **Idempotency key stored before the call.** The caller writes the idempotency key (and its
   request body hash) to `idempotency_keys` before it sends the request to the gate. The gate
   never generates, changes or drops a key. A payment carries one `request_id` for its whole life.
2. **Never retried with a new key.** The gate never re-sends a write: a 401 on a write heals the
   token and fails the call with a typed, retryable refusal (`ExactWriteAuthRetryRefused`,
   Revolut 503 `write_auth_retry_refused`), a 429 or a network failure is reported, not retried.
   Only a read is re-queued once, after a forced refresh. A caller that retries a payment sends
   the same `request_id` or first reads the outcome.
3. **Write policy is default deny and checked in the gate.** A request the policy does not name is
   refused before it is queued, spends nothing and touches no state (no role claim, no budget).
   For a write whose preconditions live in D1 (switch, verification mark, limits), the gate reads
   them itself at the door and again right before the network call; it never trusts the caller.
   A payment endpoint is added to the allow-list of the gate, never to a caller.
4. **Budget and hard stop.** A job has a finite call budget, enforced twice (at the door and at
   dispatch), counted on spend and persisted. User priority is not subject to a job budget but is
   subject to the per-minute window and the daily cap. When a budget or limit is exhausted the call
   fails with a typed error and nothing is sent; there is no "just this once".
5. **Rate limit.** No more than the per-minute cap in any 60 s span, across restarts.
6. **One token refresh at a time per connection**, and a refresh never runs in an instance that
   is not that connection's authority. The result carries a plaintext access token, so it is never
   an RPC-callable method (instance property and a JS-private flow).
7. **Nothing sensitive leaves the gate.** No token, key, IBAN or body in a log, an error message or
   a wire envelope.

The tests that pin these: `test/gate-characterization.test.ts` (both gates, same scenarios),
`test/gate-core.test.ts` (structure and the fixes below), `test/exact-gate.test.ts`,
`test/revolut-gate.test.ts`, `test/exact-write-guard.test.ts`, `test/booking-gate.test.ts`.

## Divergences found in the history of the two gates

Found by reading both files and `git log` of each (Exact: 9 commits, Revolut: 4).

1. **A write was re-sent after a 401 (Revolut only). Fixed.** ExactGate never re-sends a write
   (M7c). RevolutGate re-queued any 401, including `POST /webhooks`. Now a write that gets a 401
   heals the token and fails with 503 `write_auth_retry_refused`; the caller retries. A payment
   path must not inherit the old behaviour. Test: `gate-core.test.ts`.
2. **Alarm could be pushed back (Revolut only). Fixed.** The G2 review made ExactGate arm its one
   alarm only ever earlier (`armAlarm`); RevolutGate called `setAlarm` directly and could replace
   an earlier alarm with a later one. Both now use `armAlarm`. Test: `gate-core.test.ts`.
3. **Token and reauth writes were not scoped to the provider (Exact only). Fixed.** RevolutGate's
   `UPDATE connections` statements all carry `kind = 'revolut'`; ExactGate's `persistTokens`,
   `markNeedsReauth` and the credentials-rejected mark did not carry `kind = 'exact'`. The loads
   are scoped and the AAD binds ciphertext to the provider, so this was defence in depth only, but
   it is now the same. Test: `gate-core.test.ts`.
4. **Clock read twice in one decision (Exact fix e70f782, "load flake").** The same hazard does not
   exist in RevolutGate (no minimum-age comparison), and the shared refresh passes one clock
   reading (`ThrottleContext.now`) to the provider hook. No code change needed.
5. **Not fixed, recorded.** `JOB_ID_RE` exists three times (`@camelthorn/exact`,
   `@camelthorn/revolut`, `revolut/request.ts`) plus the core's copy; a test pins that the core's
   equals both packages'. `exact/wire.ts` and `revolut/wire.ts` are near copies (`toWire`,
   `fromWire`, `unwrap`) and must stay in step until a shared envelope is worth a package change.
   The 429 maximum block (24 h vs 1 h) and the default 429 wait are intentional differences.

## Consequences

- A change to the queue, the limiter, budgets or token refresh is made once, in `gate/core.ts`,
  and both gates' tests exercise it. The two gate files keep only provider-specific code.
- A subclass must call `this.load()` from its constructor after `super()` (the core cannot,
  because subclass fields are not initialised yet) and must not re-implement a core rule; a source
  scan in `gate-core.test.ts` fails if it does.
- Line counts (worker gates): before 1,210 + 929 = 2,139; after core 912 + Exact 718 +
  Revolut 440 = 2,070. The saving is small because the hook surface is explicit; the point is that
  the safeguards exist once.
