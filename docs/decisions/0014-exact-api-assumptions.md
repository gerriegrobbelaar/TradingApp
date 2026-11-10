# 0014 Exact Online API assumptions (verify with real credentials)

Status: accepted, provisional. Written from memory of Exact's API with no network access and no
credentials. Every item below must be checked against a real division and the current docs
(https://start.exactonline.nl/docs/HlpRestAPIResources.aspx) before relying on it. Fixtures in
`packages/exact/test/fixtures` encode these guesses, so fix both together.

Items marked **DOUBTFUL** are ones where the reviewer's recollection disagrees with or is
weaker than the builder's guess; they are blockers for the feature that depends on them
(3, 4 and 13 block matching and booking; 8 blocks reports).

## Transport conventions (ours, not Exact's)

- The transport interface (`packages/exact/src/transport.ts`) is the fixed file shared with the
  `ExactGate` task (E2); keep it identical in both places.
- REST path excludes host, `/api/v1` and division. `division: 0` means the literal `current`
  segment and is allowed only for path `/Me`, i.e. `/api/v1/current/Me`.
- XML path is host-relative (`/docs/XMLUpload.aspx`, query `Topic`); the transport must add
  `_Division_=<division>`.
- Money and 64-bit numbers are read from raw JSON text (numbers are rewritten to strings before
  parsing), so no float is ever involved. Number tokens must match the strict JSON grammar
  (leading zeros, `1.`, `.5`, `+1` are refused). Invalid JSON raises `BAD_JSON` with no body
  text (engine `SyntaxError` messages quote the input, which may hold IBANs).
- Amounts become integer minor units at the currency's ISO 4217 exponent (`currencyScale` in
  core: JPY 0, EUR 2, KWD 3). Extra decimals round half away from zero.
- The gate encodes query values with `URLSearchParams` (space as `+`, `$` as `%24`). Exact runs
  on IIS/ASP.NET, which decodes both; verify once with a `$filter` containing spaces.

## Endpoints and fields to verify

1. `GET /current/Me` fields: `UserID, UserName, FullName, Email, CurrentDivision`.
2. `GET /{div}/system/Divisions` fields: `Code, Description, Country, Status, Main` (the
   `hrm/Divisions` resource is the older alternative). `system/Divisions` may list only the
   divisions of the current licence/company; `system/AllDivisions` may be the one the
   administration switcher needs. Verify.
3. `GET /{div}/read/financial/ReceivablesList` and `PayablesList` fields: `ID, AccountId,
   AccountCode, AccountName, Amount, CurrencyCode, Description, DueDate, EntryNumber,
   InvoiceDate, InvoiceNumber`. Open question: is `Amount` in the invoice currency or the
   division currency, and is it the open balance or the invoice total? The matching engine needs
   the open balance in the invoice currency. **DOUBTFUL:** the key of these list resources may
   be `HID` (64-bit) rather than a GUID `ID`, and there may be an `AmountInTransit` field. We
   currently require `ID` and `AccountId` to be GUIDs; a 400 on `$select` or a `BAD_SHAPE` on
   the first real call means this guess is wrong.
4. Sync endpoints `/sync/Cashflow/Receivables` and `/sync/Cashflow/Payables`: endpoint names,
   field names (`Account`, `Currency`, ...) and whether they expose open amount and invoice
   number at all are guesses. **DOUBTFUL:** the payables side is more likely
   `/sync/Cashflow/Payments`, and the amount fields are more likely `AmountDC` / `AmountFC`
   (division vs foreign currency) than a single `Amount`. If not, fall back to the Receivables/PayablesList plus a nightly
   full read. `/sync/CRM/Accounts` is believed correct.
5. Sync pattern: `$filter=Timestamp gt <n>L` and `$orderby=Timestamp`; `Timestamp` is a 64-bit
   integer (kept as a digit string). Page size and whether `$orderby` is honoured on sync
   endpoints: verify. Sync endpoints may also reject `$select` on some resources. A sync read
   that stops at the page cap returns `complete: false` with the highest Timestamp seen; that is
   only safe if rows arrive in ascending Timestamp order, so the client refuses
   (`SYNC_ORDER`) a partial read whose rows are out of order. Cursors are unsigned 64-bit digit
   strings; every sync row must carry a Timestamp.
6. `GET /crm/Accounts` fields: `ID, Code, Name, Email, VATNumber, Country, IsSupplier, IsSales,
   Status`. Codes are left-padded with spaces (we trim).
7. `GET /crm/BankAccounts` fields: `ID, Account, BankAccount, BICCode, BankName, Main`. The IBAN
   may live in `IBAN` rather than `BankAccount`; verify.
8. `GET /financial/ReportingBalance` for GL balances: fields `GLAccount, GLAccountCode,
   GLAccountDescription, ReportingYear, ReportingPeriod, BalanceType, Amount`, and whether a
   filter on `ReportingYear` is mandatory. Whether it is cumulative or per period: verify.
   Cheaper alternatives (`read/financial/...`) may exist. The client assumes per-period rows
   (not cumulative) and returns them as sent; the caller sums. `ID` is not used (it may be a
   64-bit integer, not a GUID).
9. Dates: `/Date(ms)/`, assumed UTC epoch; date-only fields may be midnight in the division's
   local time, which would shift the calendar day. Verify and convert in the mapper if so.
10. OData envelope: `d.results` and `d.__next` (full https URL on the same host and division).
    Links are accepted only if scheme, host, port, division and endpoint match and there is
    exactly one `$skiptoken`. Only `$skiptoken` is taken from the link; `$select`, `$filter`
    and `$orderby` are always re-sent from our own query, so a link cannot widen the read.
11. Error body: `{"error":{"code":"","message":{"lang":"","value":"..."}}}`.
12. Rate limit headers: `X-RateLimit-Limit/Remaining/Reset` (daily) and
    `X-RateLimit-Minutely-*`. Reset is assumed to be epoch milliseconds; `Retry-After` in
    seconds. 429 body and whether Exact sends `Retry-After` at all: verify.
13. XML upload: `POST /docs/XMLUpload.aspx?Topic=<Topic>&_Division_=<n>`; envelope `eExact` with
    `xsi:noNamespaceSchemaLocation="eExact-XML.xsd"`; response messages
    `<Message type="n"><Description>`. **DOUBTFUL, blocks MatchSets:** the builder guessed
    0 info / 2 error; the reviewer recalls Exact answering `type="2"` with "Aangemaakt"
    (created), i.e. 0 error, 1 warning, 2 success, 3 fatal, and the code now uses that
    (`XML_MESSAGE_SEVERITY`). Either way a wrong mapping turns failures into successes, so
    `ok: true` is not proof of a booking: the MatchSet task must read the match back before
    marking anything paid. Responses that are not an `eExact` document (HTML login/error pages
    with status 200) or that declare a DOCTYPE/ENTITY are refused (`BAD_XML`).
14. Retry rule: 5xx on GET retried twice (500 ms, 1500 ms). A 401 reaching the client is fatal
    because the gate refreshes once itself. 429 and every other status are never retried by
    the client (the gate owns timing); non-GET calls are never retried.
