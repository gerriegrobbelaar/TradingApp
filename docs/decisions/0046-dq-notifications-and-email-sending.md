# 0046 Data quality notifications: e-mail abstraction, instant alerts, daily digest (Phase 8, D8b)

Status: accepted for the code; **the e-mail provider is PROVISIONAL** pending open decision 5 (reminder timing and tone; Exact debtor management or an own e-mail service). Nothing has been sent by this code against a real provider. Code: `packages/core/src/dq/notify.ts` (types, settings, keys, renderers), `apps/worker/src/email/` (sender, log), `apps/worker/src/dq/{alerts,digest,notify-settings}.ts`, routes in `dq/routes.ts`, migration `0027_email_log.sql`. CLAUDE.md 4.6 ("daily digest email, instant alert for critical") is the brief.

## E-mail sending (provisional)

`EmailSender` has two implementations, chosen from a setting:

| Kind | When | Behaviour |
|---|---|---|
| `disabled` | default, and whenever the https sender is incomplete | sends nothing; callers record `skipped_not_configured` |
| `https` | setting `emailProvider = https` with a host and a sender address, and the secret `EMAIL_API_KEY` present | one JSON `POST https://<host>/emails` with `Authorization: Bearer <EMAIL_API_KEY>` and `{from, to[], subject, html, text}`; a 2xx answer may carry `{"id": "..."}` |

**Why this, and not the Cloudflare `send_email` binding.** The binding needs a verified destination or a Cloudflare Email Routing set-up and a code change per environment; an HTTPS call to a configured host needs no binding, works in staging and production with the same code, is trivially mockable (`fetchFn`) and keeps every secret in a Workers secret and every choice in settings. The request shape is that of common transactional APIs (Resend uses exactly this), so a provider is a matter of host, sender and key. **No provider is named in code.** If decision 5 picks Exact's debtor management for reminders, this sender still serves the internal alerts and digest; if it picks a service with another request shape, only `httpsSender` changes. The host is validated as a public DNS name (no IP literal, no `localhost`, `.local`, `.internal`), https only, and changing it needs an admin with a fresh sign-in (it receives the API key).

**Result classification** is what makes claim-then-send safe:

- 2xx: `sent` (the id is stored when readable, otherwise null).
- 4xx other than 408 (including 429): `failed`: the provider definitely did not accept it. May be tried again.
- 408, 3xx (redirects are not followed), 5xx, timeout (10 s), network error, a sender that throws: `unknown`: it may have been delivered. **Never sent again by the code.**

## Recipients

Only people in the `users` table: not disabled, not `is_external`, holding role `admin` (mode `admin`) or `admin` or `finance` (mode `admin_finance`, default), **and** whose address is on `ALLOWED_HD` (v1 is domain-only, exact domain, so `x@sub.camelthorncapital.com` and look-alikes are out) and is a plain mailbox (letters, digits, `._+-`; no display name, list, comment or control character). There is no free-text address anywhere: not in a setting, not in a request. The test message goes to the caller only, and only if the caller is such a recipient. Removing a role or disabling a user takes effect at the next send (the list is read per send).

## The e-mail ledger (`email_log`, migration 0027)

The placeholder table of migration 0003 was never written and is replaced. One row per e-mail: unique `idempotency_key`, `kind` (`dq_alert`, `dq_alert_summary`, `dq_digest`, `test`), `template` (`dq.alert.v1`, ...), `recipients_count`, `status`, `attempts` (1 to 3), `dq_issue_id`, `reminder_id` (kept for Phase 10), `provider_message_id`, `error_code`, timestamps. **No address, no subject, no body.** Statuses: `claimed`, `sent`, `delivered`, `bounced`, `failed`, `unknown`, `skipped_not_configured` (`delivered` and `bounced` are for Phase 10's provider callbacks; nothing sets them yet).

Guards (hashes pinned): `email_log_identity` (key, kind, template, recipient count, issue, reminder, created_at never change), `email_log_status_path` (claimed to sent / failed / unknown / skipped; failed to claimed only with attempts + 1; sent to delivered / bounced), `email_log_attempts` (attempts only rise, only with failed to claimed), `email_log_keep_recent` (a row younger than 365 days cannot be deleted).

**Retention.** Rows older than **400 days** are deleted by the alert pass and by the digest job (the delete trigger is the floor at 365 days). The log is small (one row per alert and per recipient and day). Every claim also writes an `email.claimed` audit row (kind, template, recipient count; no address).

## Instant alerts for critical issues

After `dq.checks` has reconciled the issues (`dq/alerts.ts`, called at the end of the run; a failure there never fails the checks, it is counted as `alertsError`):

- **Which issues:** status `open` (never snoozed or resolved), severity `critical`, `notified_at IS NULL` (new, or reopened: the reconcile clears it and raises `reopen_count`), and the last verdict of the rule in `dq_rule_status` is `issues`. A rule that is `not_available`, `not_configured`, `disabled` or `error` vouches for nothing, so its leftover critical issues are not alerted.
- **Claim then send.** One D1 batch (atomic) does three things, each conditional on the same facts: `INSERT email_log` with key `dq-alert:<fingerprint>:<reopen_count>` (`ON CONFLICT DO NOTHING`, only while the issue is still open, critical and unnotified), `UPDATE dq_issues SET notified_at` guarded by `changes() = 1`, and the audit row. Only the writer whose insert changed a row calls the sender, so two concurrent runs cannot both send. A reopened issue has a new `reopen_count` and so a new key: it is alerted again, once.
- **Crash between claim and send.** The row stays `claimed`. A sweep (every alert pass and digest run) turns a claim older than 15 minutes into `unknown / claim_stale`. It is **not sent again**: a duplicate flood is worse than a missing alert, and the gap is visible in the log and in the job summary (`alertsUnknown`). A sender that throws, or a 5xx or timeout, ends the same way.
- **Refusals** (`failed`) are re-claimed (`attempts + 1`) by a later run while the issue is still a pending critical with the same reopen count, at most three attempts in total.
- **Cap and fold.** At most `maxAlertsPerRun` (default 10, 1 to 50) single alerts per run, oldest first. The rest are claimed together and sent as **summary alerts** of up to 80 issues each (key `dq-alert-summary:<job run id>:<chunk>`), which list up to ten and say how many more.
- **Nothing configured.** With no sender (or no qualifying recipient) nothing is claimed and `notified_at` stays NULL, so enabling the sender later alerts what is still open (subject to the cap). One `skipped_not_configured` row per Amsterdam day (`error_code` `not_configured` or `no_recipients`) shows that alerts were pending.
- **Known limit:** an issue whose alert is `failed` three times or `unknown` has `notified_at` set and is not alerted again until it is resolved and reopens. The log and `alertsFailed`/`alertsUnknown` show it; the daily digest still lists it.

## Daily digest (`dq.digest`)

Job `dq.digest`, daily **08:00 Europe/Amsterdam**, default job row **enabled** (`DEFAULT_JOBS_VERSION` 5; existing rows are never flipped; the seeding inserts the new row on the next start). It sends **nothing** until the sender is configured: it ends `skipped / email_not_configured` and records one `skipped_not_configured` row for the day. Manual "Run now" needs a fresh sign-in (it sends e-mail).

One e-mail per recipient (key `dq-digest:<Amsterdam date>:<user id>`, claimed before the send). Content: the number first ("6 open data quality issues, 2 critical"), counts by severity and by area, new since yesterday (first seen in the last 24 hours), snoozed, the oldest open issue, the ten most important open issues (severity, then age) each with a fix link, and **the rules that were not evaluated, with the reason**. Links are `<baseUrl><path>` when a base URL is set, else the relative path. A repeated run finds the claims and sends nothing; a refused recipient is retried alone after ten minutes (job retry, three attempts); an unknown outcome is never retried.

The pure renderer (`renderAlert`, `renderAlertSummary`, `renderDigest` in `packages/core`) HTML-escapes every value that comes from data (issue subjects and messages, rule titles, reasons), strips control characters from subjects (no header injection), has a plain-text twin with the same content, no images, no tracking pixels, no external resources. Sentence case, no exclamation marks. Tests assert content, not snapshots.

## Settings API

Setting `dq.notifications` (JSON in `settings`, with a `rev`): `enabled` (master switch, default true), `alertRecipients` (`admin_finance` | `admin`), `baseUrl` (`https://host[:port]` or empty), `maxAlertsPerRun`, and the sender: `emailProvider` (`disabled` | `https`), `emailHost`, `emailFrom`. `GET /api/dq/notifications` (admin) also answers `apiKeyPresent`, `senderActive`, `allowedDomain`, `recipientCount`; **the key's value is never returned**. `PATCH` (admin, step-up, audited `dq.notifications_changed` with before/after, optimistic `rev`, 409 on a stale one, strict validation, a change that changes nothing writes nothing). `POST /api/dq/notifications/test` (admin, step-up) sends one message to the caller, at most one per minute.

**Deviation from the task text:** there is no `digestHour` setting. The digest hour is the schedule of the `dq.digest` job (Settings, Schedules, admin-editable, validated there); a second copy would only be able to disagree with it.

## Housekeeping (D8a review leftover)

`dq.checks` resolves open and snoozed issues of administrations that are no longer synchronised (`sync_enabled = 0`, connection disabled or gone) with `resolved_by = 'system'`, `resolution_note = 'division_not_synchronised'` and one audit row `dq.unsynced_resolved` (count only), and removes their `dq_rule_status` rows. Global issues (division 0) are untouched. If the administration is synchronised again the issue reopens through the normal path.

## Privacy and logging

No log line, error, result summary or audit row contains an address, subject, body, API key or the provider's answer text (a source scan, `dq-notify-scan.test.ts`, checks it). The job summaries hold counts and codes. The `email_log` holds counts and codes. ADR 0045's statement that the data quality code makes no external call stays true for the rules and the check; the alert pass is the one place where `dq.checks` talks to the outside world, through `src/email/sender.ts`, and only to the configured e-mail host.

## Not done here

Screens (D8c), delivery and bounce callbacks (`delivered`, `bounced`; Phase 10), a Data health path in the web app for summary alerts (`DQ_HEALTH_PATH` in core is a placeholder for D8c), notifications to external accountants (v1 is domain-only; open decision 8), per-user opt-out, an alert for a failed or unknown alert, SMS or chat channels.
