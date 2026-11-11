# 0022 Open items read model (Phase 4)

Status: accepted. Code: `packages/core/src/{ageing,kpis,search,api-types}.ts`, `apps/worker/src/read/`.

- **What totals mean.** Every figure is the sum of `open_items.open_minor` of rows matching the filters, in integer minor units. Credit notes are negative and reduce a total. Totals cover all matching rows, not just the page.
- **Per currency, never across.** Lists, ageing and KPIs report each ISO currency separately (`totalsByCurrency`). No FX conversion happens in Phase 4; EUR-equivalents at the ECB rate arrive in Phase 6.
- **Division currency (DC).** `dcMinor` is the stored `open_dc_minor` when its currency is the division currency (or unstated). An item already in the division currency uses its own open balance, but only once the division currency was read from Exact (`currencyVerified`). Otherwise `dcMinor` is null. Sums add the known amounts and carry `dcComplete: false` (with `dcMissing`) when any row lacks one, so a UI must show "incomplete" rather than a total.
- **Ageing basis is the due date**, not the invoice date. Days overdue = `asOf - due` in Amsterdam calendar days; due today is not overdue. Buckets: not due, 1-30, 31-60, 61-90, 90+, and `no_due_date` for unknown dates.
- **`asOf`** may be today or later. The tables hold today's balances, so a past date would silently omit items paid since; it is refused (400 `as_of_in_past`). A true historical ageing needs ledger data from Exact.
- **`amount_minor` caveat (review N4).** `open_items.amount_minor` equals the open balance when Exact did not tell us the invoice total. The API therefore exposes `originalMinor` (null when unknown) and never presents `amount_minor` as an invoice total; only the detail endpoint shows it, labelled as stored. Phase 7 must use `originalMinor`.
- **KPIs.** "Due in 7/30 days" means due from today up to and including today + N (30 includes 7). Average days overdue is weighted by amount, integer math (BigInt), rounded half up, over overdue items with a positive balance.
- **Lists.** Order is (due date, id), unknown due dates last, keyset cursor (opaque, bound to the sort direction), page size at most 100. Text search folds case and diacritics in code, because SQLite cannot; it reads up to 20,000 candidate rows after the other filters, and refuses broader searches (400 `search_too_broad`). Indexes: migration 0009; a test checks the plan with EXPLAIN QUERY PLAN.
- **Freshness.** `stale` is true when the last complete sync run (`sync_state` entity `run`, `last_completed_at`) is older than 36 hours or missing.
- **Privacy.** Lists and details never return IBANs or email addresses; relations expose presence flags only.
- **Exact deep link** is `null`: the URL pattern for opening an entry in Exact is not verified. Verify with credentials, then fill `exactDeepLink()`.
- **Division visibility.** A division is readable when its Exact connection is not disabled (as in the switcher). All signed-in roles see all such divisions.
