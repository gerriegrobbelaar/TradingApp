# ADR 0003: Cloudflare Access is not used in v1
Status: accepted 2026-11-10

## Context
CLAUDE.md 4.0 asks us to evaluate Cloudflare Access with Google as identity provider in front of the app, in addition to the in-app role checks.

## Decision
v1 relies on in-app Google OIDC (code flow, PKCE, state, nonce, server-side `hd` check, invite-only users) as the single gate. Access is not deployed. Revisit as defence in depth after go-live.

## Consequences
- For Access: blocks anonymous traffic before it reaches our code (smaller attack surface, no unauthenticated login/callback endpoints exposed), policy changes without a deploy, a second independent audit trail.
- Against Access: a second identity layer that can disagree with ours (two sign-ins, two session lifetimes, two places to remove a leaver); the app still has to verify the user itself, because it needs the Google `sub`, `auth_time` and step-up, which Access does not give us in the form we need; webhook and cron paths need bypass rules, which are a misconfiguration risk; extra cost and a dependency on the critical path.
- The in-app checks stay authoritative even if Access is added later. Access would only narrow who can reach the login page.
- Residual risk accepted for v1: login, callback and webhook routes are reachable by anyone. They rely on Cloudflare's default protections. Login writes nothing to D1 (it only sets the signed flow cookie); the callback writes nothing before the flow cookie, `state` and the ID token are verified; webhooks will verify their signature before parsing. The one-time admin seed (ADR 0004) is the only write an anonymous request can trigger.
