# 0040 Matching engine scoring
Status: accepted (Phase 7, M7a). Code: `packages/core/src/matching/`. Pure, deterministic, no I/O.

## Rules and scores (integers 0-100; score = clamped sum of reason weights)
| Rule | Evidence | Kind | Score |
|---|---|---|---|
| 1 | invoice number in reference + amount = open | full | 99 (60 + 39) |
| 1 | invoice number, amount < open | partial (remainder stays open) | 88 |
| 1 | invoice number, amount > open | overpayment (allocate open, flag surplus) | 70 |
| 1 | reference lists 2-5 invoices whose open balances sum exactly to the amount | full, one candidate with `groupId` and `allocations` | 97 |
| 1 | invoice number, other currency | partial, allocates 0 | 55, review only |
| 2 | IBAN of the relation + amount = open of exactly one of its items | full | 96 |
| 2 | same, amount fits several items | full, all listed | 80 |
| 2 | IBAN matches, amount fits none | partial / overpayment | 60 / 55 |
| 3 | amount = open of exactly one item (no other signal) | suggestion | 70 (cap), never auto |
| 3 | amount fits several items | suggestion | 50 each |
| 4 | LedgerPattern | ledger | 90 (95 if `autoLedgerPatterns`) |
Bonuses: IBAN with a reference hit +1, name similarity +1..5 (token Jaccard >= 0.5, diacritics and legal forms ignored; never creates a candidate), due date within 7 days +2 (rules 1-2). Direction: money in settles receivables and payable credit notes, money out settles payables and receivable credit notes.

## Auto-match: all must hold
Top score >= 95; second best <= top - 20; tx final, `completed`, not frozen, no state conflict; item not closed, no live match, not claimed earlier in the same `matchBatch`; same currency (FX is never automatic in v1); kind full; amount within tolerance (default 0); payables: supplier IBAN not added or changed within 90 days of `bookedAt` (a malformed date blocks), and a tx IBAN, if present, must be one of the supplier's IBANs (otherwise a fraud signal, never auto). Each failure is a `blockedReasons` code with an English sentence. Non-final, declined, failed, reverted or unknown transactions give `none`.

## Decisions
- A group is ONE candidate (lowest item id as `itemId`, all `allocations`); single-item candidates for its members are dropped. Equal alternative groups tie and go to review. Groups need at most 8 reference hits.
- Invoice numbers match token-aware after NFKC and upper-casing: start and end must sit at a separator or the edge. Digit-only numbers under 4 digits never match; a Latin-prefixed number may also match by its digit run of 5 or more. Cyrillic look-alikes never match a Latin prefix.
- `openMinor` already includes earlier live matches; the engine does not subtract them. One call = one division. Inside `matchBatch` (order: bookedAt, id) an auto-claimed item is blocked for later transactions, whose candidate stays as review.
- Ledger patterns are review only unless `autoLedgerPatterns`. Regexes run on at most 500 characters; invalid ones are skipped; a pattern with no test field never matches.

## Not automated in v1
FX matches, part payments, overpayments, amount-only matches, ledger patterns (opt-in only), reverted transactions after a match (Phase 8), matching across divisions.

## Tuning
Raise `autoMatchMinGap` or `blockAutoOnRecentIbanChangeDays` to be stricter; use `amountToleranceMinor` only for known rounding. Keep `autoMatchMinScore` above 88 so part payments can never qualify, and review the scores in this table before changing it.
