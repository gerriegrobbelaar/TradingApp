# Phase 3 (Scheduler) final review — condensed
Reviewed at 4c0b581. Typecheck, lint, 1,305 tests x3 (no flakes), web build and `wrangler deploy --dry-run` pass. Nothing has run on real Cloudflare Queues/DOs/Exact. **No blocking findings; ready for Phase 4** (read-only). S1-S4 must land before the first job that writes to Exact/Revolut or sends email (Phase 5 at the latest); S5-S7 before first deploy.

Guarantee: at-least-once execution, at-most-one concurrent run (best effort; overlap needs ~90 s of failed lock heartbeats).

## Should fix
- S1 Handler contract undocumented/unenforced (types.ts, ADR 0021). Contract: runs may execute more than once and briefly alongside a zombie; every external write claims an idempotency key derived from the business object (never run.id/attempt); derive periods from run.scheduledFor not the clock; per-handler lateness limit; check ctx.signal between items; retry only by returning partial/skipped with `retry`; audit each external write; summaries hold counts/codes only; add `runRoles`/`stepUp` to HandlerDef (today finance can Run now any implemented job). Test: run each handler twice.
- S2 A retry can be lost: attempt n+1 row inserted after the finish batch (runner.ts finishRun); put it in the finish batch guarded by runner_token; test with failing insert.
- S3 Schedule/budget edits unbounded per job (`* * * * *` accepted; Exact budgets up to 1,000 break the 1,960/day figure; Revolut 5-15 min not enforced): per-handler schedule constraints + projected-calls cap (~3,000).
- S4 Full sync can show OK while an administration failed today (exact-handlers.ts roll-up): count failed_today/retries_used as errors → partial with code.
- S5 DEPLOY.md is not one ordered runbook: human checklist up front (Cloudflare paid plan, zone/hostname, EU D1, two queues, Google project/client (decision 8), Exact app registration, four secrets, key backup), scheduler checks (ADR 0021 'verify on first deploy'), emergency stop of all jobs, DLQ inspection, Queues have no EU jurisdiction (ids only), unverified: Workers Logs may store URLs incl. OAuth callback `code` at sampling 1.
- S6 Exact jobs enabled by default before Exact verified: ship disabled; enable after checklist item 10.
- S7 Runner subrequests (heartbeats, finish) not counted in the sync meter: pre-charge; confirm real limit.
- S8 Two manual sync paths (inline slice vs Run now) with different budgets/cooldowns/IBAN behaviour: unify on the job path or ADR.

## Nice to have
N1 job can stick on a slot conflict (advance baseline when a row for the slot exists; one `dueSlot()` in core); N2 record lost lease as `lock_lost`; N3 fx.revaluation 16:30 vs late ECB rate (Phase 12); N4 ExactGate.defaultBudget dead code; N5 real 30-120 ms sleeps in jobs-runner tests; N6 stale migration test name/legacy jobs; N7 CI doesn't run on pushes to this branch; N8 PROGRESS out of order, wrangler.toml header; N10 no alert on abandoned runs / DLQ depth, exact_usage shown nowhere (Phase 8).

## Exact budget (default jobs per administration per day)
Full 4x240=960 + incremental 25x40=1,000 = 1,960; with later default jobs ~2,560. Gate hard-stops jobs at 4,500 of 5,000 (10% user reserve). Phase 2 B1 livelock gone for realistic volumes.

## Still open from earlier phases
First-live-connection checklist; Google auth_time check; open decisions 1-6 (1 and 2 needed before Phase 5); amount_minor falls back to open balance (Phase 7 must not read as invoice total); Phase 5: bank_transactions leg id; Phase 7: match total bounds; Phase 9: payment provider id/approver/states, idempotency fingerprint+lease, one pending approval per subject.
