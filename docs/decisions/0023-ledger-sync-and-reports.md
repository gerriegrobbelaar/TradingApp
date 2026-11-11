# 0023 Ledger sync and the balance sheet / profit and loss reports (Phase 4, task K2)

Status: accepted for the code, **provisional for every Exact name and meaning below: verify with credentials.** Nothing here has run against a real Exact division. Code: `packages/exact/src/client.ts` (`listGlAccountsChunk`, `listReportingBalancesChunk`, `listBudgetsChunk`), `apps/worker/src/exact/ledger-sync.ts`, `apps/worker/migrations/0010_ledger.sql`, `packages/core/src/reports/`, `apps/worker/src/read/ledger-routes.ts`. Supersedes the "per-period, caller sums" remark of ADR 0014 item 8 for the reports.

## What was built

- **Tables** (migration 0010): `gl_accounts` (the chart, `is_active`, never deleted), `gl_balances` (per account, year, period and `dimension`), `gl_budgets` (per account, year, period, `scenario`, `dimension`), `gl_sync_years` (last complete read per entity and year), and `sync_state.unavailable_until`. All money is integer minor units at the scale of the division currency (`currencyScale`; JPY 0, EUR 2, KWD 3), signed. The unique key of balances and budgets has a `dimension` (and `scenario`) on top of the requested `(division, account, year, period)`, because Exact may split a period over status or cost centre and keeping one row would silently under-count.
- **Sync** as three more entities after open items, relations and IBANs: `gl_accounts`, `gl_balances`, `gl_budgets`. FULL runs only; the hourly incremental run never reads ledger data (tested). A manual "Sync now" full covers them too (`readLedger: false` exists as a test/ops switch). They are part of the cycle: a cycle is complete, and `last_full_completed_at` is set, only when they are done.
- **Reports** as pure functions in `packages/core/src/reports/` and four read endpoints (below).

## Exact resources and fields (all to verify with credentials)

| Use | Resource | `$select` fields |
|---|---|---|
| Chart of accounts | `financial/GLAccounts` | `ID, Code, Description, Type, TypeDescription, BalanceSide, BalanceType, Blocked` |
| Reporting balances | `financial/ReportingBalance`, `$filter=ReportingYear eq <year>` | `GLAccount, GLAccountCode, ReportingYear, ReportingPeriod, Amount, AmountDebit, AmountCredit, BalanceType, Status, CostcenterCode` |
| Budgets | `budget/Budgets`, `$filter=ReportingYear eq <year>` | `GLAccount, GLAccountCode, ReportingYear, ReportingPeriod, AmountDC, BudgetScenario, Costcenter` |

A 400 on a `$select` means a name is wrong (for budgets that is read as "unavailable", see below, so check `sync_state.last_error` of `gl_budgets` for `budgets_unavailable_400` on the first live run). Specifically unverified: the blocked flag is called `Blocked` here (the brief said `IsBlocked?`); `Type` is a number; `BalanceSide` is `D`/`C` and `BalanceType` is `B`/`W`; `Status` and `CostcenterCode` exist on ReportingBalance; `Costcenter` and `BudgetScenario` (a GUID) exist on Budgets; `ID` is not selected (it may be 64-bit rather than a GUID); `Division` is in the path. Page size is assumed to be 60 rows (also tested at 1,000); `$skiptoken` paging with a saved token behaves as for the open-item lists (ADR 0017); no `$orderby` is sent. A mapper never fails the whole chart on an odd `Type`, side or balance type (they become null); a row without a GUID, year, period or amount is `BAD_SHAPE`. Rows whose year differs from the requested one are ignored (the filter was not honoured for them).

## Meaning of the numbers (assumptions)

1. **Sign.** `Amount` = debit - credit: assets and costs positive, liabilities, equity and revenue negative. Budgets use the same convention (`BUDGET_SIGN` in `reports/profit-loss.ts` flips it in one place if Exact stores natural amounts).
2. **Movement vs cumulative.** `LEDGER_BALANCE_SEMANTICS = "movement"` (`reports/ledger.ts`): a reporting balance row is the net movement of its period, and period 0 holds the brought-forward balance of balance sheet accounts. A balance sheet account at period P is the sum of periods 0..P; a profit and loss account year to date is the sum of periods 1..P. The alternative `"cumulative"` (the row already is the balance at that period; take the latest period at or before P) is implemented and tested, so a different finding is a one-line change. If period 0 does not exist the check line shows it (below).
3. **Reporting year** is the Amsterdam calendar year. A non-calendar financial year needs a setting (open question).
4. **Year end** for the comparison is all periods of the compare year (0..99, so extra closing periods 13+ are included). The compare year is the year before, unless `compareYear` is given.
5. **Currency.** Every ledger amount is in the division's base currency; the client reads it at `currencyScale(divisionCurrency)` through the raw-number JSON path, no float anywhere. Amounts beyond the safe integer range are refused (`BAD_SHAPE`), aggregates are summed as BigInt.
6. **Draft entries.** `Status` is kept in the row key but not filtered: whatever Exact includes in ReportingBalance is in the report (open question: only final entries?).
7. **Cost units.** Only status and cost centre are selected. If Exact splits rows over more dimensions (cost unit, item), rows with the same key inside one chunk are added, but across chunks the later row would overwrite: add the missing field to `REPORTING_BALANCE_FIELDS` and the key if the first live read shows more rows than distinct keys.

## Account type to section mapping

Balance sheet (`BalanceType` B), `reports/classify.ts`:

| Source | Section |
|---|---|
| `Type` 10 (cash), 12 (bank), 20 (accounts receivable) | assets |
| `Type` 21, 22 (accounts payable) | liabilities |
| else keywords in `TypeDescription` (English and Dutch), tested in this order: equity (equity, capital, reserve, retained, eigen vermogen, kapitaal, overgedragen), liabilities (payable, creditor, crediteur, loan, lening, liability, schuld, vat, btw, tax, belasting, accrual, provision, voorziening), assets (cash, bank, kas, receivable, debtor, debiteur, stock, inventory, voorraad, fixed assets, vaste activa, asset, activa, prepaid, vooruitbetaald, investment) | as listed |
| anything else | **unclassified** |
| side check: assets expect `BalanceSide` D, liabilities and equity C; a contradiction | **unclassified** |

The type codes are a recollection and wrong ones are survivable: the side check and the "unclassified" line mean a bad guess shows up as its own line instead of moving money between sections. Profit and loss (`BalanceType` W): `BalanceSide` C = revenue, D = costs, none = unclassified. An account that is not in the chart (balances arrived before it, or it is gone) is kept as "Unknown account <id>", unclassified, with its balance type taken from its rows.

## Report builders

- `buildBalanceSheet(accounts, balances, {year, period, compareYear, compareToYearEnd})`: sections Assets, Liabilities, Equity, Unclassified; liabilities and equity are shown as positive balances (credit - debit), assets and unclassified as debit - credit; the year's result (credit - debit of the W accounts, a profit positive) is its own figure on the liabilities and equity side. **Check line** `difference = assets - (liabilities + equity + result) + unclassified`, which equals the plain sum of every account's signed balance: 0 for a complete ledger, and **surfaced, never hidden** otherwise (missing opening balances, a period not yet synced, wrong semantics). Both columns (the year and the comparison) balance on their own because each year's own W accounts form that column's result.
- `buildProfitAndLoss(accounts, balances, budgets, {year, periodTo})`: year to date (periods 1..periodTo) actual, budget, and last year's same periods. **Sign:** every line is credit - debit, so revenue is positive, costs are negative and the result is the plain sum of the lines; a positive variance (`actual - comparison`) is always good for the result. Percentages are integer basis points of the absolute comparison figure, half away from zero, null when the comparison is 0. `budgets: null` (unavailable) makes every budget figure null, not 0. Lines that are zero in every column are omitted; totals are unaffected.
- Properties tested over 40 seeded random ledgers: section totals equal the sum of their lines, the result equals revenue + costs + unclassified, the check line equals the independent plain sum however accounts were classified, no account with a balance is dropped.

## Sync behaviour

- **Resumable like the open-item lists.** Each chunk (default 5 pages) writes its rows, the `$skiptoken` and the progress in one D1 batch, guarded by the sync lease; rows are upserted with the `run_seq` guard. A balances pass carries its year in the token (`<year>:<token>`). Tokens belong to a cycle (`pass_cycle`); a new cycle starts a pass from the first page.
- **Cadence.** Chart: every cycle. Balances of the current year: every cycle. Balances of the previous year: when never read completely, or the last complete read is 7 days old (we cannot see cheaply whether the year-end period changed, so "at most weekly"). Budgets of the current year: same weekly rule. A cycle that crosses the new year reads the new year's balances and budgets at once.
- **Not seen means not gone, until proven.** Only a COMPLETE read counts. Unseen rows get a strike (idempotent per cycle through `strike_cycle`, so a crash between statements cannot double it); after two strikes (one when the pass ran in a single run, or with `allowLargeClose`) an account is set `is_active = 0` (never deleted) and a balance or budget row is deleted. An empty answer changes nothing. The close guard of the open items (more than `max(5, 20 %)` at once) applies; the entity then ends `error` / `close_guard` and an admin runs a full sync with `allowLargeClose`.
- **Budgets are optional.** If the first page of a fresh budget pass answers 400, 403 or 404, the entity ends `skipped` with `budgets_unavailable_<status>`, `sync_state.unavailable_until` is set a week ahead and nothing else is affected (the cycle completes, reports have no budget column). A manual full sync with `restart` tries again at once; a complete read clears the flag. A 400 on a later page (a stale token) or any 5xx is an ordinary failure.
- **Errors** follow the shared classification: budget exhausted, rate limit, time, subrequests and transient failures end `partial` and the next run resumes; auth failures stop with `needs_reauth`.

## Call arithmetic

Reference ledger: 300 accounts x 12 periods = 3,600 balance rows a year, 150 profit and loss accounts x 12 = 1,800 budget rows, 60 rows a page.

| Read | Calls | When |
|---|---|---|
| Chart | 300 / 60 = **5** | every night |
| Balances, current year | 3,600 / 60 = **60** | every night |
| Balances, previous year | **60** | once, then weekly |
| Budgets | 1,800 / 60 = **30** | once, then weekly |

A normal night adds 65 calls; the weekly night 155. With the reference division's open items (50 + 34 pages), IBANs (67), divisions and relations (2), a normal night is 218 calls, inside the 240-call budget of one run; the weekly night is 308, so it needs a second attempt, which the scheduler already gives (4 attempts a day, a partial full sync is retried after 5 minutes). **The scheduled worst case does not move: 4 x 240 + 25 x 40 = 1,960 of 5,000 per administration and day** (`test/ledger-budget.test.ts`; the job budget cap is unchanged). At pages of 1,000 the whole ledger is 1 + 4 + 4 + 2 = 11 calls. A very large ledger (2,000 accounts: 34 + 800 + 200 = 1,034 calls for the first read) spans two nights; a cycle lasts 36 hours (`CYCLE_MAX_AGE_MS`) and the nightly run starts 24 hours after the last, so a pass that needs a second night continues. A pass that needs a third would start a new cycle and never finish: raise the cycle age or the budgets for such a division (open question). The test `ledger-sync.test.ts` runs 300 accounts x 12 periods x 2 years plus budgets through the sync at both page sizes inside a 240-call run.

## API

All GET, any signed-in role, `?division=` validated against the readable divisions (404 for an unknown or disabled one), account ids resolved through their own division (404 otherwise), `no-store`. Types in `packages/core/src/api-types.ts`.

- `/api/reports/balance-sheet?year&period&compare=yearend|period|none[&compareYear]` (defaults: current Amsterdam year; current month, or 12 for another year; `yearend`; year - 1). Periods 1..16.
- `/api/reports/profit-loss?year&periodTo[&scenario=<guid>|none]`. The default scenario is the first (sorted) with rows for the year; `budgetScenarios` lists all. A compare year that was never read completely is excluded from the figures and flagged `compareMissing`.
- `/api/ledger/accounts` (chart with `isBlocked`, `isActive`, statement and section, `unclassifiedCount`) and `/api/ledger/accounts/:id/balances?year` (period rows, rows split by status or cost centre added; debit and credit are null when any row lacks them).
- **Empty state:** the balances of the requested year never read completely: 200 with `status: "not_synced"` and `report: null`. **Freshness** per ledger entity (`lastCompletedAt`, `stale`, `staleAfterHours`): chart from `sync_state`, balances and budgets from `gl_sync_years` for the requested year. Stale means never, or older than 36 hours; **budgets use 8 days** because they are read weekly (a literal 36 hours would always flag them). `budgetsAvailable` is false while `unavailable_until` is in the future.

## Open questions for the first live connection

1. All three resources and every field above; page size; whether `$skiptoken` paging works on them.
2. Sign and movement-versus-cumulative meaning of `Amount`; whether period 0 carries opening balances (the check line shows it if not); which periods exist (0, 1-12, 13+).
3. Whether ReportingBalance includes draft entries and whether more dimensions split its rows.
4. Real `GLAccount.Type` codes and descriptions (fill `BS_TYPE_SECTIONS`); how many accounts land in "unclassified".
5. Budget sign, scenarios and licensing; is 400/403/404 what an unlicensed division answers.
6. Non-calendar financial years.
7. Whether a cycle may last longer than 36 hours for very large ledgers.
8. Add the items above to the live-connection checklist of `docs/DEPLOY.md` once the deploy runbook (task J2) is on the integration branch; they are only listed here until then.
