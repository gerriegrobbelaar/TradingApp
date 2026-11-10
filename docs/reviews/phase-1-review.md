# Phase 1 (Foundation) final review — condensed
Reviewed at cb43343. Typecheck, lint, tests (worker 114, ui 146, web 63), web build and `wrangler deploy --dry-run` all pass. **No blocking findings.**

## Should fix
- S1 Step-up depends on Google returning `auth_time` (needs a real OAuth client; record result in an ADR; go-live gate).
- S2 No revoke-invite or restore-user; removed users can never be re-added.
- S3 Audit not atomic with the change; PATCH roles runs in two steps; concurrent same-role add gives 500. Add `auditStatement()` and batch it with every mutation (pattern for Phase 2+).
- S4 No top-level error handler in the worker.
- S5 No security headers (`_headers`: CSP, frame-ancestors, HSTS, nosniff, referrer) and no `no-store` on API JSON.
- S6 Deploy readiness: workers_dev/preview_urls off, route, observability, docs/DEPLOY.md, `.dev.vars.example`, dry-run in CI, fix seed comment in wrangler.toml.
- S7 Missing ADRs: Cloudflare Access, seed at startup, flow cookie, session model, step-up from auth_time, non-hierarchical roles, remove=disable, CSRF, retention/cleanup, hand-rolled router. Reconcile CLAUDE.md §4.0 "first migration" wording.
- S8 Duplicated Role/EMAIL_RE/safeReturnTo/allowed domain across web and worker; auth.flow uses raw SQL instead of the idempotency helper.
- S9 No cleanup of `idempotency_keys` (auth.flow), dead sessions; `sessions.revoked_at` unused.
- S10 Non-text contrast: control border and light off-switch below 3:1.
- S11 Schema hazards, fix in the owning phase: bank_transactions needs a leg id (Phase 5); payments states/provider id/approver and match-total bounds (Phases 7, 9); idempotency fingerprint + lease (Phase 9); one pending approval per subject; open_items.status CHECK.

## Nice to have
N1 skip seed batch when marker exists; N2 audit denied sign-ins; N3 nullable Ctx.config; N4 prompt step-up before form; N5 rename "Send invite" (no email is sent); N6 salted IBAN fingerprint in audit; N7 pin CI actions by SHA; N8 PROGRESS status.
