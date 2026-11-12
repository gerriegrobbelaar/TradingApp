/** FX, ledger and integration rules (CLAUDE.md 3, 4.6). Pure. */
import type { DqIssue, DqRuleDef } from "./types";
import {
  ageMs,
  amountText,
  cleanText,
  DAY_MS,
  finish,
  HOUR_MS,
  makeIssue,
  notAvailable,
  notConfigured,
  numberThreshold,
  plural,
  wholeDays,
} from "./util";

// ---- FX --------------------------------------------------------------------------------------------

const rateStale: DqRuleDef = {
  id: "fx.rate_stale",
  area: "fx",
  scope: "global",
  defaultSeverity: "warning",
  threshold: null,
  title: "ECB rate older than one working day",
  description:
    "The newest ECB rate is older than the rate that should exist by now (TARGET calendar; the import retries until 17:30).",
  fix: "fx",
  evaluate(input, config) {
    if (input.fx === null) return notAvailable("fx_not_loaded");
    const fx = input.fx;
    if (!fx.stale) return finish([], 1);
    const never = fx.newestRateDate === null;
    return finish(
      [
        makeIssue(this, config, ["ecb"], {
          subject: "ECB rates",
          message: never
            ? "No ECB rate has been imported yet."
            : `The newest ECB rate is from ${fx.newestRateDate}${fx.workingDaysOld === null ? "" : `, ${fx.workingDaysOld} working ${plural(fx.workingDaysOld, "day", "days")} old`}.`,
          details: {
            newestRateDate: fx.newestRateDate,
            workingDaysOld: fx.workingDaysOld,
            reason: fx.staleReason,
          },
        }),
      ],
      1,
    );
  },
};

const currencyWithoutRate: DqRuleDef = {
  id: "fx.currency_without_rate",
  area: "fx",
  scope: "division",
  defaultSeverity: "critical",
  threshold: null,
  title: "Foreign currency items without an ECB rate",
  description:
    "Open items in a currency the ECB table cannot price, so the live EUR amount and the unrealised difference are unknown.",
  fix: "fx",
  evaluate(input, config) {
    if (input.fx === null) return notAvailable("fx_not_loaded");
    const issues = input.fx.currenciesWithoutRate.map((c) =>
      makeIssue(this, config, ["cur", c.currency], {
        subject: c.currency,
        message: `${c.items} open ${plural(c.items, "item", "items")} in ${cleanText(c.currency, 3)} with no ECB rate.`,
        details: { currency: c.currency, items: c.items },
      }),
    );
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
    return finish(issues, input.fx.currenciesWithoutRate.length);
  },
};

const itemWithoutBookedRate: DqRuleDef = {
  id: "fx.item_without_booked_rate",
  area: "fx",
  scope: "division",
  defaultSeverity: "info",
  threshold: null,
  title: "Foreign items without a booked rate",
  description:
    "Open items in a currency other than the division currency that have neither a booked rate nor a booked amount in the division currency, so no difference against the booked rate can be shown.",
  fix: "invoices",
  evaluate(input, config) {
    if (input.openItems === null) return notAvailable("open_items_not_loaded");
    const missing = input.openItems.filter(
      (it) => it.currency !== input.baseCurrency && it.rate === null && it.openDcMinor === null,
    );
    if (missing.length === 0) {
      return finish([], input.openItems.filter((it) => it.currency !== input.baseCurrency).length);
    }
    // One issue per currency: a handful of lines, not one per invoice.
    const byCurrency = new Map<string, number>();
    for (const it of missing) byCurrency.set(it.currency, (byCurrency.get(it.currency) ?? 0) + 1);
    const issues: DqIssue[] = [...byCurrency]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cur, n]) =>
        makeIssue(this, config, ["cur", cur], {
          subject: cur,
          message: `${n} open ${plural(n, "item", "items")} in ${cleanText(cur, 3)} without a booked rate.`,
          details: { currency: cur, items: n },
        }),
      );
    return finish(issues, input.openItems.length);
  },
};

const rateConflicts: DqRuleDef = {
  id: "fx.rate_conflicts",
  area: "fx",
  scope: "global",
  defaultSeverity: "warning",
  threshold: null,
  title: "ECB rate conflicts to resolve",
  description:
    "The ECB published a rate that differs from the one stored for the same day. A person decides which to keep.",
  fix: "fx",
  evaluate(input, config) {
    if (input.fx === null) return notAvailable("fx_not_loaded");
    const issues = input.fx.unresolvedConflicts.map((c) =>
      makeIssue(this, config, ["conflict", c.id], {
        subject: `${c.currency} ${c.rateDate}`,
        message: `The ECB ${cleanText(c.currency, 3)} rate of ${cleanText(c.rateDate, 10)} differs from the stored rate.`,
        details: { currency: c.currency, rateDate: c.rateDate, conflictId: c.id },
      }),
    );
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en", { numeric: true }));
    return finish(issues, input.fx.unresolvedConflicts.length);
  },
};

// ---- ledger ----------------------------------------------------------------------------------------

const suspenseNotZero: DqRuleDef = {
  id: "ledger.suspense_not_zero",
  area: "ledger",
  scope: "division",
  defaultSeverity: "warning",
  threshold: { kind: "codes", default: [], maxItems: 20 },
  title: "Suspense account balance is not zero",
  description:
    "The balance of each ledger account listed as a suspense account. The list is empty until an admin sets the account codes.",
  fix: "ledger",
  evaluate(input, config) {
    const codes = Array.isArray(config.threshold) ? (config.threshold as readonly string[]) : [];
    if (codes.length === 0) return notConfigured("no_suspense_accounts_configured");
    if (input.ledger === null) return notAvailable("ledger_not_loaded");
    const issues: DqIssue[] = [];
    const found = new Set<string>();
    for (const a of input.ledger.suspense) {
      found.add(a.code);
      if (a.balanceMinor === 0) continue;
      issues.push(
        makeIssue(this, config, ["gl", a.code], {
          subject: `${a.code} ${a.name}`,
          message: `${amountText(a.balanceMinor, a.currency)} on suspense account ${cleanText(a.code, 20)}.`,
          amountMinor: a.balanceMinor,
          currency: a.currency,
          details: { code: a.code },
        }),
      );
    }
    // A configured code the chart does not have cannot be judged: say so instead of passing.
    const absent = codes.filter((c) => !found.has(c));
    for (const code of absent) {
      issues.push(
        makeIssue(this, config, ["missing", code], {
          subject: code,
          message: `Suspense account ${cleanText(code, 20)} is not in the chart of accounts, so its balance is unknown.`,
          details: { code, reason: "account_not_found" },
        }),
      );
    }
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en", { numeric: true }));
    return finish(issues, codes.length);
  },
};

const closedPeriod: DqRuleDef = {
  id: "ledger.closed_period_bookings",
  area: "ledger",
  scope: "division",
  defaultSeverity: "critical",
  threshold: null,
  title: "Bookings in a closed period",
  description:
    "Entries dated in a period that is locked. Not available until the app records which periods are closed (Phase 11, the Close checklist).",
  fix: "ledger",
  evaluate(input, config) {
    const rows = input.ledger?.closedPeriodBookings ?? null;
    if (rows === null) return notAvailable("no_closed_period_marker");
    const issues = rows.map((b) =>
      makeIssue(this, config, ["entry", b.id], {
        subject: `Entry ${b.id}`,
        message: `A booking is dated in the closed period ${cleanText(b.period, 10)}.`,
        details: { period: b.period, entryId: b.id },
      }),
    );
    return finish(issues, rows.length);
  },
};

// ---- integrations ----------------------------------------------------------------------------------

const jobStale: DqRuleDef = {
  id: "integrations.job_stale",
  area: "integrations",
  scope: "global",
  defaultSeverity: "warning",
  threshold: { kind: "number", unit: "factor", default: 2, min: 1, max: 20 },
  title: "A scheduled job has not succeeded in time",
  description:
    "An enabled job whose last successful run is older than the set multiple of its schedule interval. Jobs that are switched off are not judged.",
  fix: "schedules",
  evaluate(input, config) {
    if (input.jobs === null) return notAvailable("jobs_not_loaded");
    const factor = numberThreshold(config.threshold, 2);
    const issues: DqIssue[] = [];
    let checked = 0;
    for (const j of input.jobs) {
      if (!j.enabled || !j.implemented || j.intervalMs === null || j.intervalMs <= 0) continue;
      const since = ageMs(input.nowMs, j.lastSuccessAt) ?? ageMs(input.nowMs, j.referenceAt);
      if (since === null) continue;
      checked += 1;
      if (since <= factor * j.intervalMs) continue;
      const hours = Math.floor(since / HOUR_MS);
      issues.push(
        makeIssue(this, config, ["job", j.name], {
          subject: j.title,
          message: `${cleanText(j.title)} has not succeeded for ${hours < 48 ? `${hours} ${plural(hours, "hour", "hours")}` : `${wholeDays(since)} days`}.`,
          details: {
            job: j.name,
            lastStatus: j.lastStatus,
            lastCode: j.lastCode,
            hours,
            neverSucceeded: j.lastSuccessAt === null,
          },
        }),
      );
    }
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
    return finish(issues, checked);
  },
};

const webhookFailures: DqRuleDef = {
  id: "integrations.webhook_failures",
  area: "integrations",
  scope: "global",
  defaultSeverity: "warning",
  threshold: { kind: "number", unit: "count", default: 5, min: 0, max: 100_000 },
  title: "Revolut webhook deliveries failing",
  description:
    "Deliveries rejected (bad signature, bad timestamp) or that failed to process in the last 24 hours. The nightly backfill catches missed transactions.",
  fix: "connections",
  evaluate(input, config) {
    if (input.webhook === null) return notConfigured("no_revolut_connection");
    const limit = numberThreshold(config.threshold, 5);
    const w = input.webhook;
    const total = w.rejected24h + w.errored24h;
    if (!Number.isSafeInteger(total) || total <= limit) return finish([], 1);
    return finish(
      [
        makeIssue(this, config, ["revolut"], {
          subject: "Revolut webhook",
          message: `${total} webhook ${plural(total, "delivery", "deliveries")} failed in the last 24 hours.`,
          details: { rejected: w.rejected24h, errored: w.errored24h },
        }),
      ],
      1,
    );
  },
};

const exactConnection: DqRuleDef = {
  id: "integrations.exact_connection",
  area: "integrations",
  scope: "global",
  defaultSeverity: "critical",
  threshold: { kind: "number", unit: "days", default: 7, min: 1, max: 29 },
  title: "Exact connection needs attention",
  description:
    "The Exact connection needs a new sign-in, or its refresh token expires within the set number of days.",
  fix: "connections",
  evaluate(input, config) {
    const c = input.exactConnection;
    if (c === null) return notConfigured("no_exact_connection");
    const days = numberThreshold(config.threshold, 7);
    let reason: string | null = null;
    if (c.status !== "active") reason = c.status;
    else if (c.lastError === "credentials_rejected") reason = "credentials_rejected";
    else {
      const left = ageMs(input.nowMs, c.refreshExpiresAt);
      // `left` is negative while the expiry lies ahead.
      if (left !== null && -left <= days * DAY_MS) reason = left >= 0 ? "expired" : "expiring";
    }
    if (reason === null) return finish([], 1);
    return finish(
      [
        makeIssue(this, config, ["exact"], {
          subject: "Exact connection",
          message:
            reason === "expiring"
              ? `The Exact connection expires within ${days} ${plural(days, "day", "days")}.`
              : `The Exact connection needs a new sign-in (${cleanText(reason, 30)}).`,
          details: { reason },
        }),
      ],
      1,
    );
  },
};

const exactBudget: DqRuleDef = {
  id: "integrations.exact_budget",
  area: "integrations",
  scope: "division",
  defaultSeverity: "warning",
  threshold: { kind: "number", unit: "calls", default: 500, min: 0, max: 5000 },
  title: "Exact calls for today running low",
  description:
    "Fewer calls remain today than the set number (Exact allows 5,000 per administration and day).",
  fix: "schedules",
  evaluate(input, config) {
    const b = input.exactBudget;
    if (b === null) return notAvailable("exact_usage_unknown");
    const floor = numberThreshold(config.threshold, 500);
    const byCount = b.dailyLimit - b.calls;
    // Exact's own last report wins when it is lower than our count (other apps use the budget too).
    const remaining = b.remaining === null ? byCount : Math.min(byCount, b.remaining);
    if (!Number.isFinite(remaining) || remaining >= floor) return finish([], 1);
    return finish(
      [
        makeIssue(this, config, ["budget"], {
          subject: "Exact calls today",
          message: `${Math.max(0, remaining)} Exact calls left today.`,
          details: { remaining: Math.max(0, remaining), used: b.calls },
        }),
      ],
      1,
    );
  },
};

export const SYSTEM_RULES: readonly DqRuleDef[] = [
  rateStale,
  currencyWithoutRate,
  itemWithoutBookedRate,
  rateConflicts,
  suspenseNotZero,
  closedPeriod,
  jobStale,
  webhookFailures,
  exactConnection,
  exactBudget,
];
