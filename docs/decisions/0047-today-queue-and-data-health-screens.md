# 0047 Today queue ranking, client-side Later, Data health placement (Phase 8, D8c)

Status: accepted. Code: `packages/core/src/today.ts`, `apps/worker/src/today/routes.ts`, `apps/web/src/pages/Today.tsx`, `pages/DataHealth.tsx`, `components/dq/*`, `lib/later.ts`. No migration.

## Today queue API

`GET /api/today?division=&limit=&cursor=` (any role, read only). Sources, each read with one index-backed query of at most 100 rows plus an exact count:

| Kind | Source | Priority |
|---|---|---|
| booking | outbox `outcome_unknown` | 100 |
| dq | open critical issues | 90 |
| booking | outbox `manual_required` | 80 |
| booking | DQ issue `bank.stale_settlements` | 75 |
| dq | open warning issues | 60 |
| approval | pending approvals older than 3 days | 55 |
| match | bank lines with status `suggested` | 45 |
| approval | other pending approvals | 40 |

Order: priority, then longest waiting (`since`), then id text. The order is total, so the cursor is the last item's key and paging is stable for any page size (core tests). Snoozed, resolved, info and disabled-rule issues are left out; DQ rules that a better source already shows (`bank.booking_outcome_unknown`, `bank.booking_manual_required`, `payables.approvals_overdue`) are skipped to avoid duplicates. Approvals and booking items are per administration; bank lines and issues are global or per administration plus global, as the other screens. `capped` says a source had more than 100 rows. `approvalMappingVerified` false makes the page say the approval list may be off (ADR 0025). Items carry amounts as minor units, names already shown elsewhere, and masked text; no IBAN. Actions per role (`todayActions`): everyone may open; finance and admin may snooze and resolve data issues; booking items are for admins only (others get no action and the page says so). Query plans are asserted in `today-api.test.ts` (no scan of the big tables, no sort for the three ordered sources).

Limit: because each source is cut at 100 in its own order, an extreme backlog of one kind shows its first 100; the rest appear as these are handled (flagged by `capped`).

## Later is client-side

A per-user snooze table would need a migration, which this task may not add. "Later" (key L) hides an item for 24 hours in `localStorage` (key per email), every access in try/catch. It is not shared between devices or people and is lost when the browser clears storage; a blocked write says so and leaves the item in the queue. Undo works through the toast and Z. Server-side snooze exists only for data issues (`/api/dq/issues/:id/snooze`, 90 days, note, audited).

## Undo for snooze and resolve

The D8a API has no unsnooze or reopen action, so there is **no Undo toast** for them. The sheet says before sending that it cannot be taken back; the toast says what happens next (a snooze ends by itself; a resolved issue that is still true is reopened by the next check). A future task may add a reopen endpoint.

## Data health placement

CLAUDE.md 4.8 fixes the top menu, so Data health is **not** a menu entry. Route `/data-health` (lazy), linked from the Overview header, the Today header and the footer. Today is the home route (`/` redirects to `/today`). Rules that cannot run show their reason and are never green; unknown reason codes are shown plainly. Rule settings are admin only (step-up; typed phrase when a critical rule is loosened, decided locally with core `isLooseningChange` and again by the server).
