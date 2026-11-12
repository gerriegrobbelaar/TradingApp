# 0047 Today queue ranking, client-side Later, Data health placement (Phase 8, D8c)

Status: accepted. Code: `packages/core/src/today.ts`, `apps/worker/src/today/routes.ts`, `apps/web/src/pages/Today.tsx`, `pages/DataHealth.tsx`, `components/dq/*`, `lib/later.ts`. No migration.

## Today queue API

`GET /api/today?division=&limit=&cursor=` (any role, read only). Sources, each read with one index-backed query of at most 101 rows (100 kept, one to detect a cut) plus an exact count, all in one D1 batch (one transaction, so counts and rows agree):

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

Order: priority, then longest waiting (`since`), then id text. The order is total, so the cursor is the last item's key and paging is stable for any page size (core tests). `since` is normalised to one spelling (`toISOString`, years 0000..9999, else null) before it is compared or put in a cursor (core `canonicalSince`), so instants written as `...Z` and `...000Z` sort correctly and every cursor we issue decodes. Because the cursor is a key, not an offset, an item handled between two pages never makes the next page skip or repeat anything; an item that becomes MORE urgent between pages (an approval crossing 3 days) may move above the cursor and shows on the next load of the first page; the web list also drops repeated ids. Snoozed, resolved, info and disabled-rule issues are left out; DQ rules that a better source already shows (`bank.booking_outcome_unknown`, `bank.booking_manual_required`, `payables.approvals_overdue`) are skipped to avoid duplicates. Approvals and booking items are per administration; bank lines and issues are global or per administration plus global, as the other screens. `capped` says a source had more than 100 rows. `approvalMappingVerified` false makes the page say the approval list may be off (ADR 0025). Items carry amounts as minor units, names already shown elsewhere, and masked text; no IBAN. Actions per role (`todayActions`): everyone may open; finance and admin may snooze and resolve data issues; booking items are for admins only (others get no action and the page says so). Query plans are asserted in `today-api.test.ts` (an index search on every query, no scan of the big tables).

Each source is read **in queue order** (review D8c): approvals by `since` (submitted, else entry date; priority only grows with age), matches by `created_at`, bookings by status (unknown first) then `updated_at`, issues by the item priority (stale settlements 75, critical 90, warning 60) then `first_seen_at`, each with the id as text last. So a source's first 100 rows are its 100 most urgent. This costs a sort over the open rows of that source only (pending approvals of one administration, suggested lines, open issues of one scope), found through the same indexes; the earlier "no sort" plan read rows in id order and could leave the most urgent row out (an oldest issue with a low id, a stale settlement among 100 warnings, an `outcome_unknown` row behind 100 `manual_required`).

Cap: when a source is cut, nothing that ranks after its last read row is served (core `cappedHorizon`), so the list is always a true prefix of the full queue, never 100 rows of one kind followed by lower-ranked rows of others while unread rows of the cut kind would rank in between. `capped` is set and `cappedKinds` names the cut kinds (exact: count above rows read); the page says "More than 100 ... are waiting" and that the rest appear as these are handled.

Honesty fields: `notChecked` lists kinds not looked at (no administration chosen: approvals and bookings); `dqLastRun` is the last data-check run (`null` = never). The page lists these limits (never run, failed or partial run, checks older than 3 hours, unverified approval mapping even when 0 approvals are listed) and an empty queue with any of them says "0 items found, but not everything was checked", never "0 items need you".

## Later is client-side

A per-user snooze table would need a migration, which this task may not add. "Later" (key L) hides an item for 24 hours in `localStorage` (key `camelthorn.today.later.v2:<email>`), every access in try/catch. It is not shared between devices or people and is lost when the browser clears storage; a blocked write says so and leaves the item in the queue; unreadable or corrupted storage reads as empty. Undo works through the toast and Z. Decision (review D8c): each entry stores the item's priority when postponed, and the item **comes back at once when its priority rises** (a warning that became critical, an approval that became late); otherwise after 24 hours. Entries more than 24 hours (plus one minute) in the future, with an unknown id shape or a malformed value are ignored, so no stored value can hide an item longer. A held key does not repeat L, A or Z; the shortcuts are off while typing, inside a dialog, menu or combobox. Focus goes to the next item after L, to the summary heading when the last one went, and back to the queue after a snooze or resolve (once the new list is in). The toast is the only announcement for L (no second live-region message). Server-side snooze exists only for data issues (`/api/dq/issues/:id/snooze`, 90 days, note, audited).

## Undo for snooze and resolve

The D8a API has no unsnooze or reopen action, so there is **no Undo toast** for them. The sheet says before sending that it cannot be taken back; the toast says what happens next (a snooze ends by itself; a resolved issue that is still true is reopened by the next check). A future task may add a reopen endpoint.

## Data health placement

CLAUDE.md 4.8 fixes the top menu, so Data health is **not** a menu entry. Route `/data-health` (lazy), linked from the Overview header, the Today header and the footer. Today is the home route (`/` redirects to `/today`). Rules that cannot run show their reason and are never green; unknown reason codes are shown plainly. `not_available`, `not_configured`, `error` and `never_run` count in the "could not run" tile; the empty issue list names them, a failed/partial/old run, or (summary failed) that nothing is known, and says "0 open issues." only when every switched-on check ran.

Fix links: Data health maps the issue's `fix` key through `DQ_FIX_PATHS` (own keys only). Today does the same with `todayFixPath`: the server's `fixPath` is used only when it is exactly that screen plus a plain query (the suggested-matches tab); anything else, including another in-app path, goes to the screen of the key, an unknown key to the Overview. The worker also checks own keys (`"constructor" in DQ_FIX_PATHS` is true).

Snooze: choices up to 90 days; the request stays 5 minutes inside the server's 90-day limit so a browser clock slightly ahead is not refused.

Contrast: queue items have no background fill; with one, the severity chips inside fell below 4.5:1 in the dark theme (3.6 to 4.1). Selection is a thicker accent border. `health-contrast.test.ts` checks the chips inside items, the focus ring and that no fill comes back. Rule settings are admin only (step-up; typed phrase when a critical rule is loosened, decided locally with core `isLooseningChange` and again by the server).
