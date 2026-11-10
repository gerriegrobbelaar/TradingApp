# 0014 Exact Online API assumptions (verify with real credentials)

Status: accepted, provisional. Written from memory of Exact's API with no network access and no
credentials. Every item below must be checked against a real division and the current docs
(https://start.exactonline.nl/docs/HlpRestAPIResources.aspx) before relying on it. Fixtures in
`packages/exact/test/fixtures` encode these guesses, so fix both together.

## Transport conventions (ours, not Exact's)

- REST path excludes host, `/api/v1` and division; `division: 0` means no division segment
  (`/api/v1/current/Me`).
- XML path is host-relative (`/docs/XMLUpload.aspx`, query `Topic`); the transport must add
  `_Division_=<division>`.
- Money and 64-bit numbers are read from raw JSON text (numbers are rewritten to strings before
  parsing), so no float is ever involved.

## Endpoints and fields to verify

1. `GET /current/Me` fields: `UserID, UserName, FullName, Email, CurrentDivision`.
2. `GET /{div}/system/Divisions` fields: `Code, Description, Country, Status, Main` (the
   `hrm/Divisions` resource is the older alternative).
3. `GET /{div}/read/financial/ReceivablesList` and `PayablesList` fields: `ID, AccountId,
   AccountCode, AccountName, Amount, CurrencyCode, Description, DueDate, EntryNumber,
   InvoiceDate, InvoiceNumber`. Open question: is `Amount` in the invoice currency or the
   division currency, and is it the open balance or the invoice total? The matching engine needs
   the open balance in the invoice currency.
4. Sync endpoints `/sync/Cashflow/Receivables` and `/sync/Cashflow/Payables`: endpoint names,
   field names (`Account`, `Currency`, ...) and whether they expose open amount and invoice
   number at all are guesses. If not, fall back to the Receivables/PayablesList plus a nightly
   full read. `/sync/CRM/Accounts` is believed correct.
5. Sync pattern: `$filter=Timestamp gt <n>L` and `$orderby=Timestamp`; `Timestamp` is a 64-bit
   integer (kept as a digit string). Page size and whether `$orderby` is honoured on sync
   endpoints: verify. Sync endpoints may also reject `$select` on some resources.
6. `GET /crm/Accounts` fields: `ID, Code, Name, Email, VATNumber, Country, IsSupplier, IsSales,
   Status`. Codes are left-padded with spaces (we trim).
7. `GET /crm/BankAccounts` fields: `ID, Account, BankAccount, BICCode, BankName, Main`. The IBAN
   may live in `IBAN` rather than `BankAccount`; verify.
8. `GET /financial/ReportingBalance` for GL balances: fields `GLAccount, GLAccountCode,
   GLAccountDescription, ReportingYear, ReportingPeriod, BalanceType, Amount`, and whether a
   filter on `ReportingYear` is mandatory. Whether it is cumulative or per period: verify.
   Cheaper alternatives (`read/financial/...`) may exist.
9. Dates: `/Date(ms)/`, assumed UTC epoch; date-only fields may be midnight in the division's
   local time, which would shift the calendar day. Verify and convert in the mapper if so.
10. OData envelope: `d.results` and `d.__next` (full https URL on the same host and division).
    Links are accepted only if scheme, host, port, division and endpoint match.
11. Error body: `{"error":{"code":"","message":{"lang":"","value":"..."}}}`.
12. Rate limit headers: `X-RateLimit-Limit/Remaining/Reset` (daily) and
    `X-RateLimit-Minutely-*`. Reset is assumed to be epoch milliseconds; `Retry-After` in
    seconds. 429 body and whether Exact sends `Retry-After` at all: verify.
13. XML upload: `POST /docs/XMLUpload.aspx?Topic=<Topic>&_Division_=<n>`; envelope `eExact` with
    `xsi:noNamespaceSchemaLocation="eExact-XML.xsd"`; response messages
    `<Message type="0|1|2|3"><Description>` (info, warning, error, fatal) is a guess.
14. Retry rule: 5xx on GET retried twice (500 ms, 1500 ms). A 401 reaching the client is fatal
    because the gate refreshes once itself.
