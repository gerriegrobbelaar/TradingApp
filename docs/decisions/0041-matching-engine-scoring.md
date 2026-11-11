# 0041 Matching engine scoring
Status: accepted (Phase 7, M7a; revised in review). Code: `packages/core/src/matching/`. Pure, deterministic, no I/O,
no clock, no randomness, no locale. (Renumbered from 0040, which is the Exact write payloads ADR.)

## Rules and scores (integers 0-100; score = clamped sum of reason weights)
The table below is rendered by `renderScoreTable()` in `scores.ts` (`MATCH_WEIGHTS`, `MATCH_CAPS`); a test fails if
this copy drifts from the code.

| Rule | Evidence | Kind | Score |
|---|---|---|---|
| 1 | invoice number (exact) in reference + amount = open | full | 99 (60 + 39) |
| 1 | invoice number (exact), amount < open | partial (remainder stays open) | 88 |
| 1 | invoice number (exact), amount > open | overpayment (allocate open, surplus flagged) | 70 |
| 1 | reference lists 2-5 invoices of one relation whose open balances sum to the amount | full, one candidate with `groupId` | 97 |
| 1 | invoice number not exact (Unicode folding or digit run only) | as above | 50 + amount weight, capped at 90, never auto |
| 1 | invoice number, other currency | partial, allocates 0 | 55, never auto |
| 2 | IBAN of the relation + amount = open of exactly one of its items | full | 96 |
| 2 | same, amount fits several items | full, all listed | 80 |
| 2 | IBAN matches, amount fits none | partial / overpayment | 60 / 55 |
| 3 | amount = open of exactly one item (no other signal) | suggestion | 70 (cap 70), never auto |
| 3 | amount fits several items | suggestion | 50 each |
| 4 | ledger pattern | ledger | 90 (95 if `autoLedgerPatterns`) |

Bonuses: IBAN with a reference hit +1, name similarity +1..5 (token Jaccard >= 0.5, diacritics and legal forms
ignored; never creates a candidate), due date within 7 days +2 (rules 1-2). Penalty: the transaction IBAN is a known
IBAN of ANOTHER relation (and not of this one) -20 (`iban_belongs_to_other_relation`). Direction: money in settles
receivables and payable credit notes, money out settles payables and receivable credit notes.

## Invoice numbers in references (`reference.ts`)
Reference and description are compacted to letters and digits (NFKC, upper case). A hit must start and end at a
separator or the edge, have separators inside only where the invoice number has one or between a letter and a digit
(so `12-10-2024` never contains `1210`, `210234` and `10234567` never contain `10234`, `INV-10` never contains
`INV-1`), and be at least 4 characters with a digit. Levels:
- `exact`: the whole number, every character and separator in and next to it printable ASCII. Only this level can be
  automatic.
- `not_exact`: the whole number only after Unicode folding (full-width digits, zero-width or bidi marks, look-alike
  dashes, control characters, combining marks).
- `digits`: only the digit run (5 or more digits) of a letter-prefixed number (`2024001` for `INV-2024001`,
  `2024-0001` for `F2024-0001`). A Cyrillic or Greek look-alike prefix lands here.
`not_exact` and `digits` weigh 50 instead of 60, are capped at 90 and carry `reference_not_exact`. Reasoning: the
reference is written by the payer. For incoming money a crafted reference only misattributes a receipt, but that
still marks the wrong customer's invoice paid and stops their reminders, so a person must look.

## Auto-match: all must hold (each failure is a `blockedReasons` code with an English sentence)
- Score >= `autoMatchMinScore` (`score_below_threshold`); second best <= top - `autoMatchMinGap`
  (`close_second_candidate`); only the top candidate (`not_top_candidate`).
- Transaction: final and `completed` (otherwise decision `none`), positive amount (`none`), not `tx_frozen`, not
  `tx_state_conflict`; type in `autoTxTypes` (default `transfer`, `topup`, `card_payment`; any other or missing type is
  `tx_type_not_auto`, e.g. `refund`, `fee`, `card_refund`).
- Never matched at all (`none`): counterparty account type in `internalAccountTypes` (default `self`), counterparty IBAN
  in `ownIbans`, type in `noMatchTxTypes` (default `exchange`). `revolut` is NOT internal: it is another Revolut
  customer, often a real payer.
- Items: not `item_closed`, no `item_has_live_match`, not `claimed_by_earlier_transaction` in the same `matchBatch`,
  same currency (`currency_mismatch`, FX is never automatic in v1), kind full (`not_full_payment`).
- Amount: exactly equal. `amountToleranceMinor` (default 0, max 100) only widens what is OFFERED as full; a difference
  always adds `amount_difference`, allocates `min(amount, open)` and shows the shortfall (`remainingMinor`) or surplus
  (`surplusMinor`). A bank fee is never written off silently.
- Reference: exact level (`reference_not_exact`); and the reference names no other open item that the candidate
  leaves out (`reference_names_other_item`, any level, any direction) - e.g. rule 2 points at A while the payer wrote
  B's number.
- IBAN: a receivable's payer IBAN, if it is a known IBAN of some relation, must be one of this relation's
  (`iban_belongs_to_other_relation`). Payables: the transaction IBAN must be present and one of the supplier's IBANs
  (`iban_not_known_for_supplier`), and the supplier's IBAN not added or changed within
  `blockAutoOnRecentIbanChangeDays` (90) of `bookedAt`; a malformed stamp blocks (`iban_recently_changed`).
- Rule 3 is `suggestion_only`; rule 4 is `ledger_auto_disabled` unless `autoLedgerPatterns`.

## Groups
One candidate (lowest item id as `itemId`, all `allocations`, `groupId` = `g:` + sorted ids), 2-5 invoices from at most
8 reference hits, exact sum. Members must share one relation, unless the payer IBAN belongs to every member's
relation (a group company paying for several). Every member passes the item checks; one inexact member makes the
group inexact. A member's single overpayment candidate is dropped (the group explains it); equal alternative groups,
or a group next to an exact single invoice, tie or come close and go to review.

## Batch and performance
`matchBatch` processes transactions in (`bookedAt`, id) order, returns results in input order, and gives the same
per-transaction result for any input order (seeded shuffle test). Duplicate transaction or item ids throw. Only automatic
matches claim, and they always settle the whole open balance, so a claimed item has nothing left: later transactions
see it as review with `claimed_by_earlier_transaction` (this also surfaces duplicate payments). Items are indexed once
per call by invoice-number key, IBAN and (currency, amount); per transaction only the reference's token spans (up to
the longest key) are looked up. 2,000 transactions x 3,000 items run in well under a second (test).

## Configuration (`config.ts`)
`validateMatchConfig` lists every problem; `matchTransaction` and `matchBatch` throw a RangeError on any (no matching on
an unsafe config). Limits: `autoMatchMinScore` 95-100 (CLAUDE.md 4.2), gap 1-100, `suggestMinScore` 1..auto,
`maxCandidates` 1-50, tolerance 0-100 minor units, IBAN-change days 0-3650, an auto type cannot also be a no-match type.
Ledger patterns need an id (unique), a ledger account code, at least one test, positive `maxAmountMinor`, and regexes
from the safe subset: at most 200 characters, flags `iu`, no backreferences or lookaround, no quantified group that
contains a quantifier or an alternation (`(a+)+`, `(a|b)*`), at most 2 unbounded quantifiers, repeats up to 50. Inputs
are cut to 256 characters. A regex outside the subset never matches. Amended by review M7d (ADR 0043): a backtracking
budget, the product of the choices of every bounded quantifier and alternation at most 2^(12 - 5 x unbounded quantifiers)
(`too_complex`), because long runs of optional atoms or alternations stayed inside the rules and were exponential.

## Explanations
Plain English, amount first. Invoice numbers, pattern descriptions and codes from outside are cleaned (control and
format characters removed, IBAN-like strings masked, cut to 60 characters). The counterparty IBAN and the raw
reference are never included. `formatAmount` is exact for any bigint and scale (JPY 0, EUR 2, KWD 3).

## Not automated in v1
FX matches, part payments, overpayments, tolerance differences, amount-only matches, ledger patterns (opt-in only),
references that are not exact, reverted transactions after a match (Phase 8), matching across divisions.

## Tuning
Raise `autoMatchMinGap` or `blockAutoOnRecentIbanChangeDays` to be stricter. Keep `amountToleranceMinor` at 0 unless
there is a known rounding source; it never makes anything automatic. Change weights only in `scores.ts`, then paste
`renderScoreTable()` here; keep partial (88) and inexact (cap 90) below 95 so they can never qualify.
