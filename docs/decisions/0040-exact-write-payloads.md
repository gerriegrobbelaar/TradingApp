# 0040 Exact write payloads (bank entry + MatchSet)

Status: provisional, verify with credentials. Written from memory, no network. Code:
`packages/exact/src/write-payloads.ts` (pure), `writer.ts` (transport only) and
`write-brand.ts` (internal). All Exact names live in one table, `EXACT_WRITE_NAMES`; fix it and
the fixtures together. Nothing is wired yet: no worker code holds a writer (enforced, see Guard).

## What is built
- Bank entry: `POST /financialtransaction/BankEntries` (the brief said `/bookkeeping/...`; see A1).
  Body: `Journal, Currency, [FinancialYear, FinancialPeriod], OpeningBalanceFC, ClosingBalanceFC,
  BankEntryLines[{GLAccount, Account, AmountFC, [AmountDC], Date, Description, [OurRef], YourRef}]`.
  Built with a small JSON writer: every string and key goes through `JSON.stringify`, amounts are
  exact decimal text from integer minor units at the currency scale (JPY 0, KWD 3), never a float.
  Closing minus opening must equal the sum of lines, compared in BigInt (`balance_mismatch`).
  Every line needs a GL account or a relation; external ids are unique within the entry
  (case-insensitive). Uniqueness ACROSS entries is the worker's job: the probe below plus a unique
  key on the bank transaction in D1.
- Sign convention (`BANK_ENTRY_SIGN`): money in to the bank account positive, money out negative;
  the builder passes the bank transaction's own sign through. Unverified (A3).
- Revolut's own Exact feed (CLAUDE.md 3): when the per-connection setting says Revolut already
  imports bank lines, the worker must NOT build a bank entry; it only probes for the line the feed
  created and matches it. The builders do not know about the setting; the booker must.
- MatchSet: `POST /docs/XMLUpload.aspx?Topic=MatchSets`, `MatchSet > GLAccount@code,
  Account@code, Currency@code, Description, MatchLines > MatchLine > EntryNumber|TransactionLineID,
  Amount`. At least 2 lines; one currency (every line states its currency; a mix is refused);
  each line once (entry number, or transaction line GUID compared case-insensitively); sum exactly
  zero in BigInt (v1: full matches only). Codes are restricted to `[A-Za-z0-9._ -]`, entry numbers
  to 32-bit positive integers, line ids to GUIDs, so no input can shape the XML. Lines are sorted
  by identity: the document is byte-identical under any input order. No DOCTYPE; all text
  escaped; `xmlEscape` refuses C0 controls, U+FFFE/FFFF and lone surrogates.
- Text from the bank (description, reference): NFKC-normalised (full-width digits become ASCII),
  control characters removed, IBANs masked (`maskIbans`: spaced and lower case; plus a second
  pass for IBANs joined by `-./_` or glued to a word, by mod-97 on 15-34 character windows; over-
  masking is the safe direction), accents folded, reduced to `A-Za-z0-9 .,:/()#&+*_'-`, cut after
  masking. Descriptions are capped at 60 including a ` #<8 hex>` marker.
- The 8-hex marker (32 bits of the idempotency key) is a hint for a person reading Exact only. It
  is never used to decide anything: collisions are likely at scale.
- YourRef: the Revolut transaction id (36 chars) by default. If Exact's field is shorter (A7),
  `yourRefMode: "short"` sends `bankLineShortRef(id)` = `CT` + base36 of 48 bits of sha-256 of the
  id (at most 12 chars). The built entry exposes both (`lines[].yourRef` as sent, `shortRef`), and
  the probe uses the one sent. A short-ref collision makes the probe report a line that is not
  ours: the booker stops for a manual check; it can never cause a double booking.

## Guard and type separation
- The read client (`createExactClient`) is GET-only: `xmlUpload` was removed and `send` refuses any
  other method. The only write path in `packages/exact` is `createExactWriter`.
- `createExactWriter(transport, { writeEnabled })`: writes need `writeEnabled === true` (strict
  boolean) both when the writer is created AND at every write call. A writer created disabled
  stays disabled even if the options object is flipped to `true` later; flipping it to anything
  but `true` disables it. Division, job id and priority are snapshotted at creation.
- The writer sends only payloads produced by `buildBankEntryPayload` / `buildMatchSetXml`: they are
  frozen and registered in a module-private WeakSet (`write-brand.ts`, not exported), and must
  carry the writer's division (`ExactWritePayloadError` otherwise). No raw XML or JSON is accepted.
- `apps/worker/test/exact-write-guard.test.ts` scans the worker sources: the write API names
  (`createExactWriter`, `createBankEntry`, `submitMatchSet`, `xmlUpload`, the resource names) may
  appear only in allow-listed files (none yet), and no Exact-area file may contain a non-GET request
  literal except the OAuth token exchange. The future matching booker adds itself, with a reason.
- Done in M7c (ADR 0044): `ExactGate` refuses every non-GET request except the two booking writes, and
  those only while the fail-closed switch and the verification mark say so; the booker is the one
  allow-listed caller of the writer.
- The idempotency key is NOT sent as a header: the gate only allows `content-type`, `accept`,
  `prefer`, `if-match`, `if-none-match`, and Exact has no idempotency support we know of. The
  worker stores the key in `idempotency_keys` before the call.

## Idempotency and read-back
- Keys: `bankEntryIdempotencyKey(connectionId, externalId, legId)` and `matchSetIdempotencyKey(txId,
  itemIds, allocations)`: core `sha256Hex` of a canonical JSON array (no delimiter ambiguity).
  Item and allocation order do not matter; any amount change gives a new key. Non-integer amounts
  (NaN and Infinity would both serialise as `null`) and empty ids are refused.
- Probe: before every bank entry POST the booker runs `findBankEntryLineByRef` (YourRef as sent,
  plus journal; OData quotes doubled, ids restricted to `[A-Za-z0-9_-]{1,64}`, journal codes to the
  code set) and posts only if it finds nothing. Any hit, even one with unreadable fields, means
  "do not post".
- The writer never retries and re-throws transport errors untouched. After a thrown error, a lost
  answer, or a 2xx it cannot read (`ok: false, outcomeUnknown: true`), the outcome is unknown:
  probe again, never re-post blind. A 2xx whose line refs differ from those sent is
  `line_mismatch` (also unknown outcome: something was booked).
- MatchSet answers are never proof (message codes unverified, ADR 0014 item 13).
  `parseMatchSetResponse` accepts only answers with at least one success message and no warning,
  error, fatal or unknown one; HTML, empty, DOCTYPE and >1 MB bodies are `bad_xml`; it never
  throws and descriptions are redacted. It always returns `readBackRequired: true`.
- `verifyMatchSetApplied(primary, expected, fullyPaid?)` returns one of three outcomes; anything
  not provable is `inconclusive` (manual check):
  - `verified`: every expected line found exactly once with open amount 0 AND flagged fully paid,
    in `primary` or, when absent there, in the second read `fullyPaid`.
  - `not_applied`: every expected line found exactly once in `primary`, not flagged paid, with
    exactly its open amount from before the MatchSet (`openBeforeMinor`). Only then may the
    booker try again, with the SAME key.
  - `inconclusive`: missing rows, an absent row without the second read
    (`missing_needs_second_query`), duplicate rows, currency mismatch, flag/amount contradictions,
    an open amount that moved, or some lines closed and others not (`partially_applied`).
  A fully matched item may drop out of the open-items list, so absence is never read as success or
  failure: the booker runs `readOpenItemLines({ fullyPaidOnly: true })` for the absent lines and
  passes the rows as `fullyPaid`.

## Assumptions to verify on a test division (ranked by money risk)
Each with the concrete check. Record the answers in this ADR and fix `EXACT_WRITE_NAMES`.
1. **A1 Bank entry resource and nested lines.** POST a one-line EUR entry (+0.01, test journal)
   to `/financialtransaction/BankEntries`; a 404 means try `/bookkeeping/...`. Then GET
   `BankEntryLines?$filter=EntryID eq guid'..'` and confirm one line was created, not zero or two.
2. **A2 MatchSet XML names and line identity.** In the Exact UI match an invoice to a bank line,
   then `XMLDownload.aspx?Topic=MatchSets` for that relation and compare element/attribute names.
   Check whether `EntryNumber` alone is unique enough (an entry number can repeat across journals
   and years; a relation can have two lines in one entry) or whether journal/year/line id is needed.
3. **A3 Sign of `AmountFC` on bank entry lines.** Post +1.00 with a debtor account; confirm the
   bank journal balance goes up by 1.00 and the debtor's open item goes down. Repeat with -1.00
   for a creditor. Also record the sign of MatchLine `Amount` for invoice vs payment from the A2
   download.
4. **A4 XML message type codes** (ADR 0014 item 13). Upload a valid and an invalid MatchSet (an
   unknown entry number); record every `Message type` and text. Until then `accepted` is a hint.
5. **A5 Read-back resource.** After a full match from A2, GET `cashflow/Receivables` with
   `Account eq guid'..' and EntryNumber eq ..` with and without `and IsFullyPaid eq true`. Record
   whether the fully paid item still appears, whether `AmountFC` is the OPEN amount (part-pay an
   invoice and compare) and whether `IsFullyPaid` is filterable. If the item vanishes in both,
   switch the second read to `financialtransaction/TransactionLines` and add a matched-state field.
6. **A6 Duplicate probe.** GET `BankEntryLines?$filter=YourRef eq '<id>' and JournalCode eq
   '<code>'` for the line from A1: one hit expected. A 400 means `JournalCode` is not filterable:
   drop it (YourRef alone is still safe, only wider). Also try upper-case vs lower-case YourRef to
   confirm the comparison is case-insensitive.
7. **A7 Field limits.** POST lines with YourRef of 36 and 40 characters and a 60-character
   Description; record truncation or 400s. If YourRef is shorter than 36, set `yourRefMode:
   "short"`. Check `OurRef` accepts an integer only.
8. **A8 Partial match.** Can a MatchLine carry a partial `Amount`, or does Exact need a difference
   line or a split bank line? Try both on a test invoice. v1 refuses non-zero sums.
9. **A9 Date and period.** POST with ISO `YYYY-MM-DD` and with `/Date(ms)/`
   (`dateFormat: "msdate"`); check whether `FinancialYear/Period` are required or derived from the
   date, and that a date in a closed period is refused.
10. **A10 Required entry fields.** Are opening/closing balances mandatory and checked against the
    previous entry? Is one entry per statement day expected? POST two entries for the same day.
11. **A11 Retry behaviour of Exact.** Exact has no idempotency header we know of; confirm by
    POSTing the same body twice on the test division (two entries expected). This is why the probe
    and the D1 unique key are mandatory.
