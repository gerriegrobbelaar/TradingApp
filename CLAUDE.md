# CLAUDE.md — Camelthorn Finance (Exact Online front end)

This file is the project brief for Claude Code. Read it fully before planning or writing code.
It covers what we are building, the architecture, the rules that keep money safe, the build
order, and **how work is split across agents** (Sonnet builders → Opus 5.5 review-and-fix →
Fable full review).

---

## 1. What we are building

A modern web front end for **Exact Online** for Camelthorn Advisory B.V. (Netherlands). Exact
stays the system of record (ledger, invoices, VAT). Our app adds:

- A faster, cleaner UI in an Apple-style "glass" design (dark and light mode).
- **Revolut Business** connection: live balances and transactions, automatic and manual matching
  of payments to invoices/bills, and one-click supplier payments.
- **Scheduling**: bank balance refreshes, daily ECB FX rates, data quality checks, reminders.
- **FX**: live revaluation in the UI at today's ECB rate; booked in Exact **monthly only**.
- **Data quality monitor**, **payment reminders / resend emails**, **cash forecast**, **Today
  queue**, **month-end close checklist**, **four-eyes payment controls** (optional toggle), and
  **reports** (balance sheet, P&L, creditors and receivables age analysis).

Design reference: the "Exact Online UI demo" canvas (claude.ai artifact
`https://claude.ai/artifact/Kf22HmEkbUkKzSRFQ3L5mu`, private — export screenshots into
`docs/design/` and keep the shared stylesheet as `docs/design/app.css`). The demo uses sample
data only; every figure in the real app comes from Exact, Revolut or the ECB.

---

## 2. Stack and hosting

| Concern | Choice |
|---|---|
| Runtime | **Cloudflare Workers (paid plan)** — the free plan's 10 ms CPU and 5 cron limit are too small |
| Scheduler | Cron Triggers → enqueue jobs on **Cloudflare Queues** |
| Per-connection locking & rate limits | **Durable Objects**: one `ExactGate` per Exact division, one `RevolutGate` per Revolut connection |
| Database | **D1, created with EU jurisdiction** (cannot be changed later) |
| Files (invoice PDFs, exports) | **R2** (EU) |
| Front end | React + TypeScript + Vite, served as Workers static assets |
| Sign-in | Google (OpenID Connect), invite-only, sessions in D1 — see §4.0 |
| Language | TypeScript, `strict: true`, no `any` in domain code |
| Tests | Vitest; Workers code tested with the Workers Vitest pool (Miniflare) |
| Repo | pnpm workspaces |

Alternative kept open: a small EU VPS with PostgreSQL for heavy reporting, reached from Workers
via Hyperdrive. Do **not** build for it unless the orchestrator is told to.

### Repo layout

```
apps/web/            React UI (screens from the design canvas)
apps/worker/         Worker: HTTP API, webhooks, cron handler, queue consumers, Durable Objects
packages/core/       Pure domain logic: money, FX, matching engine, rules, forecast (no I/O)
packages/exact/      Exact Online client (REST + XML), typed
packages/revolut/    Revolut Business client, typed
packages/ui/         Design tokens + shared components (ported from docs/design/app.css)
docs/design/         Screenshots, app.css, notes
docs/decisions/      Short ADRs for anything non-obvious
```

---

## 3. Integrations — rules that must hold

Re-check each API's current docs before implementing; note any difference in an ADR.

### Exact Online
- OAuth 2.0. Access tokens are short-lived (about 10 minutes); refresh **only inside the
  `ExactGate` Durable Object** so two refreshes never run at once (a double refresh logs us out).
- Rate limits: about **60 calls/minute and 5,000/day per division**. All calls go through
  `ExactGate`, which queues and spends a budget per job. User actions in the UI jump the queue.
- Prefer bulk/sync endpoints and `$select` for large reads; never page large result sets call by
  call when a bulk endpoint exists.
- Every URL carries a **division**. The UI has an administration switcher.
- **Matching a bank line to an open invoice uses the XML API (MatchSets)**; the REST API cannot
  do it. Both the bank entry and the invoice must exist in Exact first.
- If Revolut's own Exact integration already imports Revolut bank lines, **do not also create
  bank entries** (duplicates). We then only match. This is a setting, decided per connection.
- Dutch instance: `start.exactonline.nl`.

### Revolut Business
- Auth with the Business API's certificate / JWT client-assertion flow; private key lives in
  Workers secrets only. IP allow-listing is optional (Workers has no fixed IP).
- Webhooks v2: `TransactionCreated`, `TransactionStateChanged`.
  - Verify the HMAC SHA-256 signature (`Revolut-Signature`) **before** parsing the body.
  - Reject timestamps more than 5 minutes from now.
  - Handlers must be **idempotent** (Revolut retries failed deliveries 3 more times, 10 minutes
    apart). A nightly backfill job catches anything missed.
- Only book transactions in a **final state** (completed / failed / reverted / declined).
- Payments: `/pay` needs a **Company** plan (SCA rules). On other plans create **payment
  drafts** that the user approves in the Revolut app. Always send a unique `request_id`
  (idempotency); never retry a payment with a new `request_id`.
- Counterparty is created once from the supplier IBAN in Exact. New or changed IBANs always need
  a second approver (see §4.4).

### ECB exchange rates
- EXR dataset from the ECB Data Portal. Published around **16:00 CET on TARGET working days**.
- Import at 16:15, retry until 17:30. Weekends/holidays reuse the last rate and show its date.
- Alert if the latest rate is older than one working day.
- ECB rates are "for information only": the accountant must confirm them as the source for
  revaluation (open decision, §9).

---

## 4. Features and acceptance criteria

### 4.0 Sign-in, users and roles
- **Google sign-in only** (OAuth 2.0 / OpenID Connect, authorization code flow with PKCE and
  `state`/`nonce`). No passwords are stored in the app.
- Verify the Google ID token on the server: signature (Google's published keys), `iss`, `aud`
  (our client ID), `exp`, `nonce` and `email_verified = true`.
- **Initial administrator: `gerrie.grobbelaar@camelthorncapital.com`.** Seed it at the first
  Worker start from the `INITIAL_ADMIN_EMAIL` Workers variable (not hard-coded in source; D1
  migrations cannot read variables), with role `admin`. Seeding is idempotent, marked once in
  `settings`, and never creates a second admin on re-run (docs/decisions/0004).
- Access is **invite-only**: a Google account can sign in only if an admin has added its email in
  Settings → Users. Additionally restrict to the `camelthorncapital.com` Google Workspace domain
  (`hd` claim checked server-side, not only as a login hint) unless the admin allows an external
  email explicitly (for example an outside accountant).
- Roles: `admin` (users, settings, connections), `approver` (second approver for payments and
  bank-detail changes), `finance` (book, match, pay within limits), `viewer` (read-only). A user
  can hold several roles. Everyone's actions are in the audit log under their Google email.
- Sessions: server-side session in D1, `HttpOnly; Secure; SameSite=Lax` cookie, 12-hour idle
  timeout. **Step-up:** paying, approving, changing bank details, connecting Revolut or Exact, and
  locking a period require a Google sign-in within the last 15 minutes (re-prompt with
  `prompt=login` / `max_age`).
- Removing a user or a role ends their sessions immediately.
- Option to evaluate in an ADR: Cloudflare Access with Google as identity provider in front of the
  app, in addition to (not instead of) the in-app role checks.

### 4.1 Scheduler (foundation)
- `jobs` table: name, schedule (cron, Europe/Amsterdam), enabled, budget (Exact calls), last
  run, result, next run. `job_runs` table for history.
- Jobs never overlap themselves (lock in Durable Object), are safe to retry, and can be run on
  demand ("Run now") from Settings → Schedules.
- Initial jobs:

| Job | Schedule |
|---|---|
| Revolut balance + transactions | every 10 min (configurable 5–15) |
| Bank balances from Exact (ING, Rabobank) | hourly — the Exact bank feed is daily, faster polling wastes budget |
| ECB FX import | working days 16:15 |
| Data quality checks | hourly |
| Payment reminders | daily 09:00 |
| Full sync from Exact | daily 02:00 |
| FX revaluation (draft journal) | last working day 16:30 |

### 4.2 Bank matching
- Score each transaction against open items, highest first:
  1. Invoice number in reference **and** amount = open balance.
  2. Counterparty IBAN matches the relation in Exact **and** amount matches.
  3. Amount matches with exactly one candidate (suggestion only).
  4. Known pattern → ledger account (bank fees, card payments with receipt).
- **Auto-match only** when the top score ≥ 95% and the next candidate is far behind; log it in
  "Matched automatically" with Undo. Everything else goes to the review queue.
- Part payments keep the remainder open on the invoice.
- Matching writes: bank entry (REST, unless Revolut's feed does it) → MatchSet (XML).

### 4.3 Payables and one-click Pay
- Pay button opens a confirmation sheet (supplier, IBAN, amount, reference, source account).
  The click never pays directly.
- Pre-checks: invoice approved in Exact, not already paid or in a batch, IBAN matches supplier
  record, within limit.
- Statuses: Open → Paying (or Waiting for approval) → Paid / Failed (with reason). "Paid" only
  after the bank confirms **and** the match is booked in Exact.
- Payment batch: select invoices → one SEPA batch (Exact) or one Revolut bulk payment.

### 4.4 Four-eyes controls (optional, on by default)
- Setting: on/off, limit (default €2,500), second approver(s).
- When on: any payment or batch above the limit needs a second user's approval before it is
  sent. **New or changed supplier bank details always need a second approver**, whatever the
  amount (separate toggle, default on).
- An approver can never approve their own request. Every approval is in the audit log.

### 4.5 FX
- UI shows original amount, EUR at today's ECB rate, and unrealised difference vs booked rate.
- Month-end job revalues open foreign-currency items and balances at the month-end ECB rate and
  creates a **draft** journal in Exact for approval; optional reversal on day 1. If the Exact
  package has its own revaluation function, feed it rates instead (decide in an ADR).

### 4.6 Data quality monitor
Rules with severity, threshold and a "Fix" link. Run hourly/nightly; Data health view, daily
digest email, instant alert for critical. Initial rules:
- Bank: Exact balance ≠ bank balance; unmatched lines > 5 days; duplicate bank lines.
- Payables: duplicate supplier invoices; missing PDF; supplier IBAN changed; approvals > 3 days.
- Receivables: customer without email; bounced emails; disputed invoices still chased.
- Master data: supplier without IBAN; EU customer without VAT number; VAT code vs country.
- FX: rate older than 1 working day; foreign item without rate.
- Ledger: suspense account ≠ 0; bookings in a closed period.
- Integrations: last successful run per job; webhook failures; expiring Exact connection;
  remaining daily Exact budget.

### 4.7 Reminders and resend emails
- Default schedule: copy 5 days before due → reminder at +3 → +14 → escalate to user at +30.
- Stop the moment a bank match marks the invoice paid. Pause per customer or invoice (disputes).
- Invoice copies via Exact (email layout in Exact); reminders via Exact debtor management or a
  transactional email service (decide in ADR). Log every email with delivery/bounce status.

### 4.8 Screens (from the design canvas)
Top menu: **Today · Overview · Invoices · Purchases ▾ (Payables, Approvals) · Treasury ▾ (Bank,
Cash forecast) · Reporting ▾ (Balance sheet, Profit and loss, Creditors age analysis,
Receivables age analysis) · Close · Settings (icon)**.

- **Today**: one queue (approvals, matches, reminders, issues); J/K move, A act, L later; undo.
- **Overview**: KPIs; every figure opens a drill-down sheet with the underlying Exact entries.
- **Cash forecast**: 13 weeks; receivables dated by each customer's average days to pay; recurring
  costs (payroll, VAT, rent); lowest point; buffer; scenario switches.
- **Close**: checklist that ticks itself from data; manual review steps; "Lock period" only when
  all green.
- **Reports**: balance sheet (vs last year-end), P&L YTD vs budget vs last year, creditors and
  receivables ageing (not due / 1–30 / 31–60 / 61–90 / 90+), export PDF and Excel.
- **Settings**: payment controls, appearance, connections, schedules.
- Polish on every screen: light/dark (Auto follows system), undo toasts, skeleton loading,
  "Updated x min ago" stamps.

---

## 5. Engineering rules

- **Money is integer minor units + ISO currency code.** Never floats. FX rates are decimal strings
  handled with a decimal library; round only at display or booking, with a documented rule.
- Dates: store UTC, schedule and display in Europe/Amsterdam.
- Every write to Exact or Revolut is **idempotent** (idempotency key stored before the call) and
  **audited** (who, what, when, before/after).
- Secrets only in Workers secrets. Never log tokens, keys, IBANs in full, or email bodies.
- Webhooks: verify signature → enqueue → return 200 fast; process in the queue consumer.
- `packages/core` has no I/O and ≥ 90% test coverage on matching, money, FX and forecast.
- Accessibility: real buttons/links/inputs, 4.5:1 contrast in both themes, keyboard paths for
  everything, `prefers-reduced-motion` honoured.
- UI copy: sentence case, no exclamation marks, lead with the number then what it means.

### Data model (D1, starting point)
`users` (Google `sub` + email), `user_roles`, `invites`, `sessions`, `settings`, `connections` (Exact/Revolut, encrypted token refs),
`divisions`, `bank_accounts`, `bank_transactions`, `open_items` (cache of Exact invoices/bills),
`match_suggestions`, `matches`, `payments`, `payment_batches`, `approvals`, `fx_rates`,
`fx_revaluations`, `jobs`, `job_runs`, `dq_rules`, `dq_issues`, `reminders`, `email_log`,
`audit_log`, `idempotency_keys`.

---

## 6. Agent workflow (how to build)

The main Claude Code session is the **orchestrator**. It plans, splits work into tasks, delegates,
merges, and keeps `docs/PROGRESS.md` up to date. Where possible, all implementation follows this
pipeline:

```
            ┌──────────────────────┐      ┌───────────────────────────┐
 task ───▶  │ builder  (Sonnet)    │ ───▶ │ reviewer  (Opus 5.5)      │ ───▶ merge to main
            │ one per task,        │      │ one per builder: reviews  │
            │ own git worktree     │      │ the diff, FIXES issues,   │
            └──────────────────────┘      │ re-runs tests             │
                                          └───────────────────────────┘
 end of each phase ───▶ final-reviewer (Fable): full review of main ───▶ findings → new tasks
```

### Rules for the orchestrator
1. Break each phase (§7) into tasks small enough for one builder (roughly one package feature or
   one screen, with its tests). Write each task with: goal, files/areas, acceptance criteria
   copied from this file, and "done means".
2. Run independent builders **in parallel** (up to 3 at once); serialise tasks that touch the same
   files or migrations.
3. For every builder, start **exactly one** `reviewer` on that builder's branch/worktree when it
   finishes. The reviewer fixes what it finds; it does not hand problems back unless it cannot
   fix them.
4. Merge only when the reviewer reports PASS and tests, typecheck and lint are green.
5. After each phase, run the `final-reviewer` on `main`. Turn every finding into a task and send
   it back through builder → reviewer. A phase is done when the final review has no blocking
   findings.
6. Do **not** pass a `model` override when spawning these agents — the agent files pin the model.
7. "Where possible" means: skip the pipeline only for trivial edits (docs, copy, config under ~20
   lines), which the orchestrator may make directly and note in `PROGRESS.md`.

### Agent definitions
Live in `.claude/agents/` (`builder.md`, `reviewer.md`, `final-reviewer.md`). They pin
`claude-sonnet-5-5`, `claude-opus-5-5` and `claude-fable-5-2`; you can use the aliases `sonnet`,
`opus` and `fable` instead to always get the latest of each.

---

## 7. Build order (phases)

Each phase ends with a final review (§6).

1. **Foundation** — repo, tooling, CI, D1 schema + migrations, **Google sign-in, seeded admin
   (§4.0), invite-only users and roles**, audit log,
   idempotency table, design tokens in `packages/ui`, app shell with top menu and theme.
2. **Exact connection** — OAuth, `ExactGate` (rate limit + token refresh), typed client, division
   switcher, nightly full sync into `open_items`.
3. **Scheduler** — jobs, job_runs, cron → queue, Settings → Schedules screen.
4. **Read-only screens** — Overview with drill-down, Invoices, Payables (no paying yet),
   Approvals, reports (BS, P&L, ageing).
5. **Revolut connection** — auth, webhooks, backfill, balances; Bank screen with accounts.
6. **ECB FX** — import job, live FX amounts in the UI.
7. **Matching** — engine in `packages/core`, review queue, auto-match with undo, Exact booking
   (bank entry + MatchSet).
8. **Data quality** — rules, Data health, alerts; Today queue.
9. **Payments** — Pay button, batches, four-eyes, approvals; Revolut `/pay` or drafts.
10. **Reminders and resend emails**.
11. **Cash forecast and Close checklist**.
12. **Monthly FX revaluation booking**.

---

## 8. Definition of done (every task)

- Acceptance criteria met; tests added and green; typecheck and lint green.
- Reviewer PASS; merged to `main`; `docs/PROGRESS.md` updated.
- No secrets in code or logs; audit entries for every write to Exact or Revolut.
- UI works in light and dark, at phone width, with keyboard only.

---

## 9. Open decisions (ask the user; record answers in `docs/decisions/`)

1. Revolut plan: Company (true one-click `/pay`) or not (payment drafts)?
2. Is Revolut's own Exact integration switched on (who creates bank entries)?
3. Currencies held; ledger account for FX results; reverse revaluation each month?
4. ECB rates approved by the accountant for revaluation?
5. Reminder timing and tone; Exact debtor management or own email service?
6. Four-eyes limit and approvers; roles (who may pay, approve, lock periods).
7. Workers-only, or Workers + EU VPS with PostgreSQL?
8. Which Google Cloud project owns the OAuth client, and which external emails (if any) may sign
   in besides `camelthorncapital.com` accounts?
