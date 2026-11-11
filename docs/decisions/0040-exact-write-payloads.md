# 0040 Exact write payloads (bank entry + MatchSet)

Status: provisional, verify with credentials. Written from memory, no network. Code:
`packages/exact/src/write-payloads.ts` (pure) and `writer.ts` (transport only). All names live in
one table, `EXACT_WRITE_NAMES`; fix it and the fixtures together.

## What is built
- Bank entry: `POST /financialtransaction/BankEntries` (the brief said `/bookkeeping/...`; see 1).
  Body: `Journal, Currency, [FinancialYear, FinancialPeriod], OpeningBalanceFC, ClosingBalanceFC,
  BankEntryLines[{GLAccount, Account, AmountFC, [AmountDC], Date, Description, [OurRef], YourRef}]`.
  Amounts are written as exact JSON number text from minor units at the currency scale (JPY 0,
  KWD 3). Closing minus opening must equal the sum of lines, else `balance_mismatch`.
- MatchSet: `POST /docs/XMLUpload.aspx?Topic=MatchSets`, `MatchSet > GLAccount, Account, Currency,
  Description, MatchLines > MatchLine > EntryNumber|TransactionLineID, Amount`. Lines sorted by
  key so output is byte-identical for hashing. No DOCTYPE; all text escaped; codes restricted.
- Text from the bank (description, reference) is IBAN-masked, accent-folded, reduced to
  `A-Za-z0-9 .,:/()#&+*_'-`, capped at 60 including a ` #<8 hex>` idempotency marker.

## Partial matches
v1 builds full matches only: line amounts must sum to exactly zero, else
`partial_match_not_supported_v1`. For a part payment, book the bank line split in two bank entry
lines (matched part and remainder to the debtor/creditor account), then match only the matched
part against the invoice. Whether MatchLine can carry a partial `Amount` or a difference is
unknown (see 5).

## Idempotency and read-back
- Keys: `bankEntryIdempotencyKey(connectionId, externalId, legId)` and `matchSetIdempotencyKey(txId,
  itemIds, allocations)`: sha-256 of canonical JSON. Stored by the worker BEFORE the call.
- Before every bank entry POST the worker runs the probe (`findBankEntryLineByRef`: YourRef =
  Revolut transaction id, plus journal) and posts only if it finds nothing. After a thrown
  error or lost response the outcome is unknown: probe again, never re-post blind.
- The writer never retries POST. A MatchSet answer is never proof (message codes unverified,
  ADR 0014 item 13): `parseMatchSetResponse` returns `accepted` plus `readBackRequired: true`,
  and the match counts only when `verifyMatchSetApplied` finds every line once with open
  amount 0 (missing or duplicate rows fail).
- Guard: `createExactWriter(transport, { writeEnabled })` throws `ExactWriteDisabledError` from
  both write methods unless `writeEnabled === true`. Reads (probe, read-back) work either way.

## Assumptions to verify on a test division (ranked)
1. Bank entry resource path and that nested `BankEntryLines` in one POST work (try
   `/financialtransaction/BankEntries`, else `/bookkeeping/...`); a 404 or 400 tells.
2. MatchSet element and attribute names, and how a line is identified (entry number alone may be
   ambiguous across journals/years; maybe journal and year are needed). Upload a match by hand
   in Exact, export it, compare.
3. XML message type codes (ADR 0014 item 13): post a valid and an invalid MatchSet, record codes.
4. Read-back resource: `cashflow/Receivables|Payables` fields `AmountFC`, `Currency`,
   `IsFullyPaid`, `EntryNumber`, and that a fully matched item still appears (else a missing row
   is a failure and we need `financialtransaction/TransactionLines`).
5. Partial match: does MatchLine accept a partial `Amount`, or does Exact need a difference line.
6. Sign convention of `AmountFC` (money in positive?) and of MatchLine amounts.
7. Date format on POST (ISO `YYYY-MM-DD` default, `/Date(ms)/` via `dateFormat: "msdate"`), and
   whether entry-level `FinancialYear/Period` are required or derived from `Date`.
8. `YourRef` max length and charset (Revolut ids are 36 chars), `Description` cap (60 guessed),
   `OurRef` integer, and whether `JournalCode` is filterable on `BankEntryLines` (the probe
   needs it; a 400 means drop it and filter on `YourRef` alone).
9. Required bank entry fields (opening/closing balance mandatory? one entry per statement day?).
10. Exact ignores the `X-Idempotency-Key` header (it is a marker only, no dedupe by Exact).
