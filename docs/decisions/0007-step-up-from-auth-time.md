# ADR 0007: Step-up uses Google `auth_time`
Status: accepted 2026-11-10; go-live verification gate open

## Context
Paying, approving, changing bank details, connecting Revolut or Exact, locking periods and all user changes need a Google sign-in within 15 minutes (CLAUDE.md 4.0).

## Decision
A step-up login sends `prompt=login` and `max_age=0`. The callback requires `auth_time` in the ID token with `now - auth_time <= 5 minutes` (and not in the future beyond clock skew). The session stores `last_auth_at = auth_time`; step-up routes require it within 15 minutes. A normal login whose token lacks `auth_time` gets `last_auth_at = 0`, so it never counts as fresh. A step-up token without `auth_time` is refused.

## Go-live gate
Before production, verify against the real OAuth client that Google returns `auth_time` when `max_age` is sent and that `prompt=login` forces re-authentication. Until then the app fails closed: a step-up token without `auth_time` is refused (`step_up_no_auth_time`), so no step-up action is possible.

## Fallback if Google omits `auth_time`
`iat` alone is not equivalent: it proves Google issued a token just now, not that the person re-entered their password or 2-step code, because the browser user can strip `prompt=login` from the redirect and Google then re-issues silently. So:
1. Payments, approvals, bank-detail changes, connections and period locks: step-up moves to a WebAuthn assertion with user verification required (passkey or platform authenticator), checked in the Worker against credentials enrolled per user in a new `webauthn_credentials` table during a fresh session. A successful assertion sets `last_auth_at`. These actions stay blocked until this ships.
2. Interim, admin user changes only (so the first invites are possible): accept a step-up token whose `iat` is within 60 seconds of the callback, whose `nonce` matches the flow and whose `sub` equals the session user. Recorded as `auth.step_up` with `method: "iat"` in the audit entry, and removed once item 1 ships. This needs a short sign-off from the user, recorded here.

## Consequences
- Fail closed means a change in Google's behaviour blocks payments rather than weakening them.
- Admin user changes are blocked in the same way, so the verification must be done before the first real invite.
