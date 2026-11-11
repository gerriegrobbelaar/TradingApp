# 0043 Matching screens: rules (Phase 7, M7d)
Status: accepted (reviewed). Code: `apps/web/src/components/matching/`, `lib/matching-*.ts`, `lib/allocation.ts`, `lib/mask.ts`,
`pages/MatchingSettings.tsx`.

- Nothing is booked in Exact from the UI. A match is recorded in the app; booking is the backend's job (M7c) and is switched on
  only in Settings, Matching, by an admin (verify the write path on a test division, then enable: typed phrases and a fresh sign-in).
  Switching booking OFF sends `PUT /api/booking/settings {enabled:false}`: no phrase, no step-up (the safe direction).
- Every change is explicit: choose, then a confirmation that states exactly what will be recorded and what happens in Exact.
  `bookingState` (off / blocked / ready / unknown, from the real `enabled` + `blockers` + `protocolChanged`) picks the sentence;
  only `ready` says "booked in Exact automatically afterwards and cannot be undone here". Every confirmation ends with "No money
  is paid or moved." A ledger-account match is worded "Match ... to ledger account", never "Book". The booking settings and the
  booking queue are readable by every signed-in role, so viewers get the same wording; only admins see the buttons.
- No optimistic UI: the sheet waits for the server, then the queue and the tab counts are refreshed QUIETLY (`useCursorList.refresh`
  re-reads as many rows as are shown and swaps them in; `useResource.refresh` keeps what is shown): the changed row disappears
  without a skeleton flash or a jump back to page one. A 409/422/404 shows one plain sentence and refreshes the sheet.
- Manual allocation: the picker is scoped to the line's own administration (`MatchTxDto.divisionId`, null exactly when the account
  is unmapped); there is no administration selector. The free balance of each picked item (Exact open minus live in-app matches)
  comes from `GET /api/matching/items?ids=` (the number the server checks), is re-read right before the confirmation, and an
  amount/item refusal on submit goes back to the editor with the typed amounts kept and the balances re-read.
- Amount text rule: ASCII digits with at most ONE decimal separator, `,` or `.` (the prefill writes `.`); no grouping, inner spaces,
  signs, exponents, other digit systems or direction marks; at most 24 characters; more decimals than the currency has is refused
  (never rounded): "1,500" is refused for EUR and JPY and is 1.500 for KWD. The total must equal the bank amount exactly (BigInt), so
  a misread grouping cannot be submitted unnoticed. Amounts above 2^53 are refused.
- Sheets: only the top sheet reacts to Escape/Tab (stack in packages/ui). A sheet with typed, unsaved input (allocations, ledger code,
  ignore note, typed phrase, pattern form) asks "Discard what you typed?" on Escape, the scrim or Close; a second Escape keeps editing.
- Privacy: every string of every matching/booking answer is IBAN-masked at the API boundary (`maskDeep`, core `maskIbans`) on top of
  the worker's own masking; a DOM test feeds full IBANs in every text field and scans HTML, attributes, inputs, the address and storage.
- Roles: viewers and approvers read; finance and admins match, ignore, unignore, undo (the same FINANCE rule as the worker, checked
  against its source in a test); admins clear conflicts (note, fresh sign-in) and edit Settings, Matching.
- Wording lives in `lib/matching-labels.ts`; tests fail when core adds a block or reason code, when the worker routes return a code
  without its own sentence, or when the booking blocker list differs from the fixed five (`not_verified`, `protocol_changed`,
  `bank_entries_undecided`, `no_exact_connection`, `writes_disabled`; anything else gets one fixed sentence, never the server's text).
- Typed phrases come from core `confirm-phrases.ts` (worker, web and tests share them; the auto phrase sent by the server wins);
  the match is exact: case-sensitive, not trimmed.
- Settings forms reuse core `validateMatchConfig`, `unsafeRegexReason` and `safeRegexTest`. Review M7d added a backtracking budget to
  the safe regex subset (`too_complex`: product of bounded choices and alternations at most 2^(12 - 5 x unbounded)), because
  `a?a?...aaa` and `(?:a|aa)(?:a|aa)...b` passed the old rules and took seconds to minutes; the "test against this text" box is capped
  at the same 256 characters the server tests.
