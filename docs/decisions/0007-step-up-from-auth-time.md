# ADR 0007: Step-up uses Google `auth_time`
Status: accepted 2026-11-10; go-live verification gate open

## Context
Paying, approving, changing bank details, connecting Revolut or Exact, locking periods and all user changes need a Google sign-in within 15 minutes (CLAUDE.md 4.0).

## Decision
A step-up login sends `prompt=login` and `max_age=0`. The callback requires `auth_time` in the ID token with `now - auth_time <= 5 minutes` (and not in the future beyond clock skew). The session stores `last_auth_at = auth_time`; step-up routes require it within 15 minutes. A normal login whose token lacks `auth_time` gets `last_auth_at = 0`, so it never counts as fresh. A step-up token without `auth_time` is refused.

## Go-live gate
Before production, verify against the real OAuth client that Google returns `auth_time` when `max_age` is sent and that `prompt=login` forces re-authentication. If Google omits it, the app fails closed (no step-up possible). Fallbacks, in order:
1. A separate short-lived step-up flow: `prompt=login` plus a check on `iat` of the fresh ID token (issued seconds ago, same nonce, `sub` equals the session user).
2. WebAuthn/passkey confirmation for the highest-risk actions, later.

## Consequences
- Fail closed means a change in Google's behaviour blocks payments rather than weakening them.
- Admin user changes are blocked in the same way, so the verification must be done before the first real invite.
