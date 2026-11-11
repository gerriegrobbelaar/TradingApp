# 0032 Treasury, Bank screen (read-only)

Status: accepted for Phase 5 (task R3b). The worker endpoints are R3a; shapes are in
`packages/core/src/api-types.ts` (`Bank*`).

## Decisions

- `/treasury/bank` shows account cards, a per-currency balance strip (never summed across
  currencies) and a filterable, cursor-paged transaction list with a detail sheet. No pay, match
  or bank-entry action exists on the page or sheet; a test fails if one appears.
- Filters `account`, `state`, `direction`, `from`, `to` live in the address; the search text does
  not (same rule as the other lists). Invalid values are dropped. An inverted date range is
  explained and not requested.
- The status filter offers Failed and Declined separately: the API takes one `state` value.
- Amounts: positive is received ("+", announced "Received"), negative is paid (minus sign,
  announced "Paid"). The shared Money component is not used, its "credit" wording is for invoices.
- Only pending and unknown states are "not final — not used for matching"; an unrecognised state
  is shown as Unknown, never Completed.
- Only the last four characters of any IBAN are rendered, whatever the server sends.
- Freshness uses its own stamp (wording is about Revolut, not Exact). Never synced, out of date and
  not connected are distinct states. Waiting for the first sync points admins to Settings,
  Schedules: the Revolut sync job stays off until the connection is verified.
- Leg notes ("Leg 1 of 2") are counted over the rows loaded and say "so far" while more pages
  remain; the sheet lists the true legs.

## Assumptions to confirm with R3a

`amountMinor` is signed (negative is paid); `outMinor` in totals is a magnitude (the UI shows its
absolute value either way); `legs` includes the opened leg.
