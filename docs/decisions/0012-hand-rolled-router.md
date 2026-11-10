# ADR 0012: Hand-rolled router
Status: accepted 2026-11-10

## Context
The Worker needs a few dozen routes in v1, each with an access rule (public, role list, step-up) and shared CSRF and session handling.

## Decision
A small `Router` class (`apps/worker/src/router.ts`) matches `METHOD /path/:param`, then applies in a fixed order: config check, CSRF (ADR 0010), session load, role check, step-up check, handler. Access is a required argument of `add`, so a route cannot be added without deciding who may call it. Errors are JSON with a short code and never include internals.

## Consequences
- No framework dependency, a small bundle, and behaviour fully covered by our own tests.
- We own bugs in path matching and must not grow features (middleware chains, regex routes) casually. If route count or complexity grows a lot, move to Hono and keep the same `Access` model.
- Webhook routes (Revolut) will be `public: true` plus their own signature check before any parsing.
