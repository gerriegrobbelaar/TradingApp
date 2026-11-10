# ADR 0010: CSRF defence by custom header plus Origin
Status: accepted 2026-11-10

## Context
Sessions are cookie based (SameSite=Lax). Lax already stops most cross-site POSTs, but we want a second control that does not depend on browser behaviour alone.

## Decision
Every unsafe method (anything but GET, HEAD, OPTIONS), logout included, must carry a non-empty `X-Requested-With` header (the web client always sends it). If the request has an `Origin`, it must equal the origin of `OAUTH_REDIRECT_URI`. Failure is `403 csrf` before any session or handler work. We never send CORS allow headers, so a cross-site page cannot add the header, because its preflight fails.

## Consequences
- Non-browser clients must send the header. Webhooks (Revolut) are authenticated by their HMAC signature and need their own route handling.
- A request without `Origin` passes the Origin test but still needs the header.
- Safe methods must never change state; reviewers reject any GET that writes.
