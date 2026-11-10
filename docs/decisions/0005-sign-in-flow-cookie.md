# ADR 0005: Sign-in round trip lives in a signed cookie, single use via idempotency_keys
Status: accepted 2026-11-10

## Context
The OIDC round trip needs `state`, `nonce` and the PKCE verifier between redirect and callback. A D1 table would let anonymous traffic grow the database.

## Decision
`/api/auth/login` seals `{state, nonce, verifier, stepUp, returnTo, exp}` with HMAC-SHA-256 (key `SESSION_SECRET`) into the `__Host-oauth` cookie (HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes). The callback verifies signature, expiry and `state` (constant time), then the ID token. Only after a verified token does it claim `sha256(state)` in `idempotency_keys` scope `auth.flow` (`claimOnceAndPurge`); a second claim fails as `flow_replayed`. The cookie is cleared on every outcome.

## Consequences
- No table, migration or write before the user is authenticated. The cookie binds the flow to the browser that started it.
- The payload is signed, not encrypted: the PKCE verifier is readable by that same browser, which is acceptable. Rotating `SESSION_SECRET` only invalidates in-flight sign-ins.
- `return_to` is sanitised at login with `safeReturnTo` from `packages/core`, and the web client applies the same function.
- Claims are kept 24 hours, then purged in bounded batches (ADR 0011).
