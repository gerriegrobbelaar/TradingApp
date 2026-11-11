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
- Amounts: positive is money in ("+"), negative is money out (minus sign). Only a completed row is
  announced "Received" / "Paid" and only completed money in is green; pending and unknown rows are
  "Incoming" / "Outgoing, not final" in ink; declined, failed and reverted rows say they did not go
  through (were reversed) and are muted. The direction filter reads "Money in" / "Money out". The
  shared Money component is not used, its "credit" wording is for invoices.
- Pending and unknown states are "not final — not used for matching"; an unrecognised state is
  shown as Unknown, never Completed. Declined and failed say "did not go through", reverted
  "reversed by Revolut", both "not counted in totals".
- The totals footer is the server's per-currency sum over the whole filter of PENDING AND COMPLETED
  rows (contract in api-types): it says so, labels the columns "In" / "Out" (never received /
  paid, since pending rows are included), and explains when a filter (Failed, say) leaves nothing
  to total.
- The Date column is the Amsterdam day of `createdAt`: the list is sorted by it and From / To
  filter on it. The completion time is in the sheet. Dates outside 2000-01-01..2099-12-31 are
  dropped from the address and bounded in the pickers.
- A connection that is not active is its own state with its own words (waiting for confirmation,
  needs renewing, switched off), whether or not anything was read yet; "Waiting for the first
  sync" is only for an active connection.
- Only the last four characters of any IBAN are rendered, whatever the server sends.
- Freshness uses its own stamp (wording is about Revolut, not Exact). Never synced, out of date and
  not connected are distinct states. Waiting for the first sync points admins to Settings,
  Schedules: the Revolut sync job stays off until the connection is verified.
- Leg notes ("One of 2 legs") use the optional `legCount` from the server when present. Without
  it they are counted over the rows loaded and say "at least" whenever a filter is on or more pages
  remain (an account filter hides the other leg of an own-account transfer). No leg index is
  shown in the list (load order is not leg order); the sheet lists the true legs.

## Contract with R3a (doc comments in api-types)

`amountMinor` is signed (negative is money out); `inMinor` and `outMinor` are positive magnitudes
over pending and completed rows only (the UI shows absolute values either way); `count` counts
those rows; `legs` includes the opened leg; `q` searches reference, description and counterparty
name, never the IBAN; `state` takes one value; `legCount` is optional.
