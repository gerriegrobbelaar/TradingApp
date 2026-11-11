# 0043 Matching screens: rules (Phase 7, M7d)
Status: accepted. Code: `apps/web/src/components/matching/`, `lib/matching-*.ts`, `lib/allocation.ts`, `pages/MatchingSettings.tsx`.

- Nothing is booked in Exact from the UI. A match is recorded in the app; booking is the backend's job (M7c) and is switched on
  only in Settings, Matching, by an admin (verify the write path on a test division, then enable: typed phrases and a fresh sign-in).
- Every change is explicit: choose, then a confirmation that states exactly what will be recorded and what happens in Exact
  (`bookingSentence`: off, on, blocked, or unreadable setting). No optimistic UI: the sheet waits for the server, then the queue
  and the tab counts are refetched. A 409/422/404 shows a plain sentence and refreshes the sheet.
- Nothing is preselected: a candidate must be picked. An overpayment candidate cannot be matched as it is (the server needs the
  sum to equal the bank amount); the person adds the rest to another invoice by hand.
- Manual allocation maths is BigInt minor units; typed amounts are decimal text at the currency's scale (JPY 0, KWD 3), refused
  above 2^53. Credit notes follow the server's direction rule. A source scan forbids floats in the matching files.
- The "different customer/supplier" checkbox is shown when the candidate says the sender's account belongs to another relation,
  or after the server answers 409 `different_relation`.
- Roles: viewers and approvers read; finance and admins match, ignore, unignore, undo; admins clear conflicts (note, fresh
  sign-in) and edit Settings, Matching. Non-admins see a read-only summary from `/api/matching/stats` (the settings routes are admin-only).
- Wording lives in `lib/matching-labels.ts`; a test fails when core adds a block or reason code without a label.
- Settings forms reuse core `validateMatchConfig`, `unsafeRegexReason` and `safeRegexTest`; the server validates again.
- Turning automatic matching off is immediate; turning it on needs the phrase from the server and a fresh sign-in.
- Known gaps: the match sheet does not know the line's administration (`MatchTxDto` has no division), so the picker uses the
  administration switcher with a selector and the server rejects other divisions; booking blocker codes are mapped by guess until M7c fixes them.
