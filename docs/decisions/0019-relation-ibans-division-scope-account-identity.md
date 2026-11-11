# 0019 Relation bank accounts, division scope, account identity, incremental open items

Status: accepted (design). Field names it relies on (`Currency` on `system/Divisions`,
`DivisionCustomer` / `DivisionCustomerName` on `current/Me`) are provisional: verify with
credentials (docs/DEPLOY.md section 9). Phase 2 review fixes S4, S7, S8, S9 and N1; migration 0007.

## S9 Naming: the sync entity is `relation_ibans`

The sync entity for the IBANs of customers and suppliers was called `bank_accounts`, the name of
the table that will hold OUR bank accounts (Revolut, ING, Rabobank). It is now `relation_ibans`
everywhere (code, `sync_state.entity`, tests, ADRs). `sync_state.entity` no longer has a CHECK:
the allowed values are `SYNC_ENTITIES` in `apps/worker/src/exact/sync.ts` (the entities plus
`run`), enforced by `assertSyncEntity` before every write to the table, so a new entity never needs
a table rebuild again. SQLite cannot drop a CHECK, so migration 0007 rebuilds `sync_state` (create
new, copy with the entity renamed, drop, rename). Nothing references `sync_state` (it is only a
child of `divisions`), so the plain pattern is safe with foreign keys on, unlike the `connections`
rebuild of migration 0004 (ADR 0015); `test/migration-0007.test.ts` runs it on a populated
database and checks `PRAGMA foreign_key_check`.

## S8 Every bank account of a relation: `relation_bank_accounts`

- One row per `(relation, IBAN)`: `iban` (normalised: upper case, no spaces), `bic`, `is_main`,
  `exact_id` (the Exact bank account GUID), `first_seen_at`, `last_seen_at`, `removed_at`. Unique
  on `(relation_id, iban)`, `relation_id` is `relations.id` with `ON DELETE CASCADE`. IBANs that do
  not look like an IBAN (2 letters, 2 digits, 1-30 alphanumerics) are skipped.
- `relations.iban` stays the one IBAN to show and to pay to: the account Exact marks main, else the
  lowest active IBAN (stable, independent of the order Exact returns rows in).
- The nightly full run reads `crm/BankAccounts` completely or fails (the client throws on an
  incomplete read). Only such a complete read upserts rows (`last_seen_at` moves for all active
  rows with one statement at the end) and sets `removed_at` on rows it no longer returns; a row that
  returns is active again (`removed_at` cleared, `first_seen_at` kept).
- Normalisation (`normalizeIban` in `packages/core`): NFKC (full-width letters and digits, a
  non-breaking space become ASCII), all whitespace and invisible format characters (U+200B, BOM)
  dropped, upper case. Lookalikes from another script (Cyrillic "А") are not folded and fail the
  shape check, so they are skipped like any non-IBAN. The mod-97 check digits are NOT a filter:
  an IBAN with a wrong check digit is still what Exact holds and still a new place a payment could
  be pointed at, so it is stored and flagged like any other; Phase 9 must refuse to pay to an
  IBAN that fails `hasValidIbanChecksum`. Simple on purpose: one
  complete read is enough to remove (a removed account only makes the app more cautious), but an
  answer with no usable account at all changes nothing (a wrong division or licence is far more
  likely than every supplier losing every account). Every write is guarded by the sync lease
  (`sync_locks` holder and `run_seq`), so a run that outlived its lease writes nothing.
- **Two flags for payment safety**, both set only after a first IBAN pass has completed (the first
  pass is the baseline), both with a masked audit row in the same batch as the change:
  - `relations.iban_added_at` + audit `relation.iban_added`: the set of active IBANs gained an
    IBAN it did not have (new, or one that had been removed and came back). Any new IBAN is a
    payment-safety event whether or not it is main: it is a new place money can go.
  - `relations.iban_changed_at` + audit `relation.iban_changed` (before and after, masked): the
    IBAN we would pay to changed because the **main account changed**, or the old one is **no
    longer returned** (removed, or swapped for another in the same read, with or without a main
    flag), or a relation got its first IBAN. A display IBAN that moves only because a new lowest
    IBAN joined a relation without a main account (the old one still there) is an addition, not a
    change; reordering, case, spacing and invisible characters are neither. A swap therefore sets
    both flags.
  - Phase 9 must treat either flag as "new or changed bank details" for the second-approver rule
    (CLAUDE.md 4.4) and must re-read the supplier's accounts (`listBankAccounts({ accountId })`)
    when it prepares a payment, because the nightly read can be a day old (since M2 up to 3 days:
    the IBAN read runs after the ledger and is only forced ahead of it once the last complete read
    is older than 3 days, ADR 0024 addendum S10). This is a hard requirement of the payment
    pre-check, also noted at `hasValidIbanChecksum` in `packages/core/src/iban.ts`.
- The baseline is the first COMPLETED pass of a division, even one that found nothing: a division
  that really had no IBANs must flag its first one. The price: a faulty empty first answer makes
  the next real one flag every relation once (the cautious direction).
- Relations that already had an IBAN before migration 0007 have no rows yet. The one IBAN the old
  sync stored (`relations.iban`) is their baseline; any OTHER IBAN the first pass after the
  migration finds is flagged as added, because it may have appeared after the last pre-0007 pass
  and nothing older can tell. This flags relations with several accounts once (review them after
  the upgrade) instead of silently accepting an account nobody has seen; a different display IBAN
  still counts as changed (the old rule).
- Known limit: one complete read that lacks many accounts (an Exact fault) marks them removed, and
  the next normal read flags all of them as added again. That is the cautious direction; a removal
  guard like the open-items close guard can be added if it happens in practice.
- `open_items.relation_iban` (migration 0003) is unused and stays unused: matching joins
  `open_items.relation_id` to `relations` and `relation_bank_accounts` instead of copying an IBAN
  onto every invoice (which would go stale). Treat the column as dead; a later migration can drop it.
- Not done: no `relation.iban_removed` audit row (removal is visible as `removed_at`), and Exact
  deleting a bank account is seen the same way as any other absence from a complete read.

## S7 Which divisions sync, which currency, which account

- **`divisions.sync_enabled`** (default 0). The connect callback enables the division
  `/current/Me` returned (the first division of a connection with none enabled); the divisions list
  read by the sync adds the others **disabled**. A reconnect to the same account never re-enables
  anything an admin switched off. Migration 0007 enables the lowest id per connection, which is
  the `/Me` division (the callback inserted it first). The scheduler and the manual sync only handle
  enabled divisions (manual: 409 `sync_disabled`). `PUT /api/divisions/:id/sync-enabled
  {"enabled": boolean}` is admin only, **no step-up** (it changes cost, not money or bank details),
  idempotent and audited as `division.sync_enabled_changed`. The switcher still lists disabled
  divisions (an empty administration is better than a missing one); Settings, Connections has the
  switch, Data sync shows "Sync is off".
- **Division currency.** The divisions read now selects `Currency` and writes it to
  `divisions.base_currency` (and `base_currency_read_at`); when Exact sends none, the stored value
  stays (EUR until read). The same run switches the client to the division's currency right after
  the divisions step, so division-currency amounts (`AmountDC`) get the right scale. Field name
  provisional.
- **Reconnecting to a different Exact account.** The callback stores the new tokens with status
  **`pending`**: the scheduler, the manual sync and every division gate refuse a pending
  connection, and the gate serves it for `GET /current/Me` (division 0) only, so no call for our
  divisions can run with tokens of an unchecked account. `/current/Me` is read through the gate
  (`fetchCurrentMe` over `createCurrentGateTransport`; the gate's own validation also allows
  division 0 for `GET /Me` only). The stored identity (`connections.exact_identity`) is
  `id:<sha256>` of the `DivisionCustomer` GUID (stable), else `name:<sha256>` of the lower-cased
  customer name (changes on a rename); audit rows carry the kind and 12 hex characters. A later
  connect never downgrades an `id:` identity to `name:`. "Different" (`isDifferentAccount`):
  never for a connection with no history; never when the `/Me` division is one we already know
  (the same data whatever the identity says, so a **company rename never locks the admin out**);
  otherwise (an unknown division) different unless both identities are known and equal. If
  `/current/Me` cannot be read for a connection with history, the staged sign-in is removed
  (`last_error = 'account_unverified'`, audit `connection.exact_account_unverified`,
  `?exact=unverified`); a first connection is activated as before (`connected_no_division`).
  Every statement after staging is guarded by the staged refresh-token ciphertext, so a second
  callback running at the same time can never have its tokens activated by this one (it answers
  `?exact=error`). If different and the flow was **not** started
  with `confirm_replace=1`: the callback removes the new sign-in again (connection `disabled`,
  `last_error = 'different_exact_account'`, tokens wiped, old identity and divisions kept) and
  redirects with `?exact=different_exact_account`; audit `connection.exact_account_mismatch`.
  Reconnecting with the original account then just works. With `confirm_replace=1` (a link
  in Settings, Connections that needs the usual step-up; carried in the signed flow cookie, never
  in the callback URL) the old divisions are switched off, the new `/Me` division is enabled and
  the identity replaced; audit `connection.exact_account_replaced` (old and new identity prefix,
  divisions). Data of the old account stays in D1, disabled. Why remove the new sign-in instead of
  keeping it: the new tokens were already stored (the gate reads them from D1 to call `/Me`), and a
  connection that silently points at another company is worse than one the admin must confirm.
  The cost is that an accidental wrong login disconnects the connection until the right account
  signs in again.

## S4 Incremental open items are off by default

The same-ID assumption between the bulk lists and the Timestamp sync endpoints (ADR 0017 verify
13) is unverified. If an invoice has one ID in `ReceivablesList` and another in
`/sync/Cashflow/Receivables`, an hourly incremental read would insert a second row for every
changed invoice and the nightly close would then close the first. So:

- The admin setting `exact.incremental_open_items` (`settings` row, JSON boolean, default **false**;
  `GET`/`PUT /api/sync/settings`, PUT admin only, audited as
  `settings.exact_incremental_open_items`, toggle in Settings, Connections) decides whether
  INCREMENTAL runs read open receivables and payables. Off: the hourly tick and "Sync now" refresh
  divisions and relations only (about 2 calls); the nightly full list pass refreshes open items.
  On: as before.
- `open_items.source` (`list` | `sync`) records which kind of read last wrote the row, so the live
  check can compare the same invoice from both sources before the setting is switched on.
- Worst case per division and day stays 2,000 calls (the budgets are upper bounds; the incremental
  budget is simply not used up). The payables sync resource may turn out to be `Payments` or
  `PaymentTerms` rather than `Payables` (ADR 0014 item 4); that is a second reason to keep the
  setting off until the endpoint is confirmed.

## N1 Relations continue from their cursor

A nightly full run used to start the relations read at Timestamp 0 every night (the whole
accounts table). Relations now continue from the saved cursor in every mode (`restart` still reads
from 0). The Timestamp endpoint returns everything changed since the cursor, so this is complete
for new and changed accounts. **Deletions in Exact are not detected for relations**: the Timestamp
read never reports them (`sync/Deleted` is not used either), so a deleted account stays in
`relations`. Impact: low for matching (a deleted relation has no open items), but a deleted
supplier would still be offered; Data health (Phase 8) or a periodic `restart` can reconcile.

## Consequences

- `apps/worker/test/exact-g3.test.ts`, `exact-sync-routes-g3.test.ts`, `migration-0007.test.ts`
  and the changed connect tests cover the above.
- Settings, Connections gains a per-division sync switch, the open-items switch and the replace
  notice; Data sync says when sync is off.
