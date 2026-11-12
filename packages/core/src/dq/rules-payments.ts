/**
 * Payment rules (Phase 9 final review S1, ADR 0053). Pure. They read the payment tables only (D1);
 * with no rows they are `ok` (nothing to be wrong about), and `not_available` only when the loader
 * failed. Area `bank`: the table behind `dq_issues.area` has no `payments` area and a migration was
 * out of scope. Subjects are named "Payment 12" / "Batch 3": never an IBAN, never a beneficiary name.
 */
import type { DqInput, DqIssue, DqPaymentsList, DqRuleDef, DqRuleOutcome } from "./types";
import {
  ageMs,
  amountText,
  DAY_MS,
  fingerprintOf,
  finish,
  HOUR_MS,
  makeIssue,
  notAvailable,
  numberThreshold,
  plural,
  wholeDays,
} from "./util";

/** An unknown outcome older than this is critical: money may have left. */
export const OUTCOME_UNKNOWN_MAX_MS = 30 * 60_000;
/** A ready request not sent after this long is a sign the submitter is stuck. */
export const READY_NOT_SENT_MAX_MS = 4 * HOUR_MS;
/** Reconcile results that are alerts (the ones payment_reconcile.alert_at is set for). */
export const PAYMENT_ALERT_RESULTS = [
  "approved_after_expiry",
  "reverted_after_paid",
  "mismatch",
  "duplicate",
] as const;
/** Labels of the alert kinds: the four results above plus the kinds of migration 0030 (F9a). */
export const PAYMENT_ALERT_LABEL: Readonly<Record<string, string>> = {
  approved_after_expiry: "approved after expiry",
  reverted_after_paid: "reverted after paid",
  mismatch: "bank data does not match",
  duplicate: "possible duplicate payment",
  draft_gone: "draft no longer in Revolut",
  draft_completed_unlinked: "draft completed, bank lines not linked",
};
/** An open alert of a kind this code has no label for is still raised (never skipped). */
export const PAYMENT_ALERT_UNKNOWN_LABEL = "alert that needs a look";
const ALERT_KIND_RE = /^[a-z_]{1,40}$/;
/** Share of the draft expiry after which a waiting draft is a warning (half of it is info). */
export const DRAFT_WARNING_SHARE = 0.8;

const subjectLabel = (s: { kind: "payment" | "batch"; id: number }): string =>
  `${s.kind === "batch" ? "Batch" : "Payment"} ${s.id}`;

/** A list the loader had to cut makes the rule truncated: it reports, but resolves nothing. */
function done(outcome: DqRuleOutcome, input: DqInput, list: DqPaymentsList): DqRuleOutcome {
  return input.payments?.capped[list] === true ? { ...outcome, truncated: true } : outcome;
}

const minutesText = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  return m < 120 ? `${m} ${plural(m, "minute", "minutes")}` : `${Math.floor(m / 60)} hours`;
};

const expiryText = (expiresAt: string | null, nowMs: number): string => {
  const t = expiresAt === null ? NaN : Date.parse(expiresAt);
  if (Number.isNaN(t)) return "expiry unknown";
  const left = t - nowMs;
  if (left <= 0) return "expired";
  const h = Math.ceil(left / HOUR_MS);
  return `expires in ${h} ${plural(h, "hour", "hours")}`;
};

const outcomeUnknownOld: DqRuleDef = {
  id: "payments.outcome_unknown_old",
  area: "bank",
  scope: "global",
  defaultSeverity: "critical",
  threshold: null,
  title: "Payment with an unknown outcome for over 30 minutes",
  description:
    "A payment or batch was sent (or may have been) and Revolut has not told us what happened. Nothing is sent again; check the Revolut app, then resolve it in Payments.",
  fix: "payments",
  evaluate(input, config) {
    const p = input.payments;
    if (p === null) return notAvailable("payments_not_loaded");
    const issues: DqIssue[] = [];
    const unjudged: string[] = [];
    for (const s of p.outcomeUnknown) {
      const age = ageMs(input.nowMs, s.since);
      if (age === null) {
        unjudged.push(fingerprintOf(this.id, [s.kind, s.id]));
        continue;
      }
      if (age <= OUTCOME_UNKNOWN_MAX_MS) continue;
      issues.push(
        makeIssue(this, config, [s.kind, s.id], {
          subject: subjectLabel(s),
          message: `${minutesText(age)}: ${amountText(s.amountMinor, s.currency)} ${s.kind} with an unknown outcome. Do not pay again.`,
          amountMinor: s.amountMinor,
          currency: s.currency,
          details: { subjectKind: s.kind, subjectId: s.id, minutes: Math.floor(age / 60_000) },
        }),
      );
    }
    return done(finish(issues, p.outcomeUnknown.length, unjudged), input, "outcomeUnknown");
  },
};

const alertOpen: DqRuleDef = {
  id: "payments.alert_open",
  area: "bank",
  scope: "global",
  defaultSeverity: "critical",
  threshold: null,
  title: "Payment alert not yet looked at",
  description:
    "The reconciliation found something that needs a person: a draft approved after it expired, a payment reverted after it was paid, bank data that does not match the request, a possible duplicate, or a draft that is no longer in Revolut.",
  fix: "payments",
  evaluate(input, config) {
    const p = input.payments;
    if (p === null) return notAvailable("payments_not_loaded");
    const issues: DqIssue[] = [];
    let checked = 0;
    for (const a of p.alerts) {
      // Fail loud: an open alert whose kind has no label (a kind added later, or an empty kind) is
      // raised with a generic label; the kind goes into the key only when it is a plain code.
      const known = Object.hasOwn(PAYMENT_ALERT_LABEL, a.result);
      const kind = ALERT_KIND_RE.test(a.result) ? a.result : "unknown";
      const label = known ? (PAYMENT_ALERT_LABEL[a.result] as string) : PAYMENT_ALERT_UNKNOWN_LABEL;
      checked += 1;
      issues.push(
        makeIssue(this, config, [a.kind, a.id, kind], {
          subject: `${subjectLabel(a)} · ${label}`,
          message:
            a.amountMinor !== null && a.currency !== null
              ? `Alert on ${subjectLabel(a).toLowerCase()}: ${label}, ${amountText(a.amountMinor, a.currency)}.`
              : `Alert on ${subjectLabel(a).toLowerCase()}: ${label}.`,
          amountMinor: a.amountMinor,
          currency: a.currency,
          details: { subjectKind: a.kind, subjectId: a.id, alert: kind },
        }),
      );
    }
    return done(finish(issues, checked), input, "alerts");
  },
};

const paidNotBooked: DqRuleDef = {
  id: "payments.paid_not_booked",
  area: "bank",
  scope: "global",
  defaultSeverity: "warning",
  threshold: { kind: "number", unit: "days", default: 3, min: 1, max: 30 },
  title: "Paid at the bank but not booked in Exact",
  description:
    "The bank confirmed the payment, but its bank line is not matched and booked in Exact after the set number of days. The invoice still looks open in Exact.",
  fix: "payments",
  evaluate(input, config) {
    const p = input.payments;
    if (p === null) return notAvailable("payments_not_loaded");
    const days = numberThreshold(config.threshold, 3);
    const issues: DqIssue[] = [];
    const unjudged: string[] = [];
    for (const r of p.paidNotBooked) {
      const age = ageMs(input.nowMs, r.paidAt);
      if (age === null) {
        unjudged.push(fingerprintOf(this.id, ["payment", r.id]));
        continue;
      }
      if (age <= days * DAY_MS) continue;
      const d = wholeDays(age);
      const stage =
        r.stage === "awaiting_bank_line"
          ? "the bank line has not arrived"
          : r.stage === "awaiting_match"
            ? "the bank line is not matched"
            : r.stage === "match_other_invoice"
              ? "the bank line is matched to another invoice"
              : "the match is not booked in Exact";
      issues.push(
        makeIssue(this, config, ["payment", r.id], {
          subject: `Payment ${r.id}`,
          message: `${d} ${plural(d, "day", "days")}: ${amountText(r.amountMinor, r.currency)} paid, but ${stage}.`,
          amountMinor: r.amountMinor,
          currency: r.currency,
          details: { subjectKind: "payment", subjectId: r.id, days: d, stage: r.stage },
        }),
      );
    }
    return done(finish(issues, p.paidNotBooked.length, unjudged), input, "paidNotBooked");
  },
};

const readyNotSent: DqRuleDef = {
  id: "payments.ready_not_sent",
  area: "bank",
  scope: "global",
  defaultSeverity: "warning",
  threshold: null,
  title: "Approved payment not sent",
  description:
    "A payment was approved and is ready, but has not been sent for over 4 hours. It expires 24 hours after the request, so it may lapse unsent.",
  fix: "payments",
  evaluate(input, config) {
    const p = input.payments;
    if (p === null) return notAvailable("payments_not_loaded");
    const issues: DqIssue[] = [];
    const unjudged: string[] = [];
    for (const s of p.ready) {
      const age = ageMs(input.nowMs, s.since);
      if (age === null) {
        unjudged.push(fingerprintOf(this.id, [s.kind, s.id]));
        continue;
      }
      if (age <= READY_NOT_SENT_MAX_MS) continue;
      const h = Math.floor(age / HOUR_MS);
      issues.push(
        makeIssue(this, config, [s.kind, s.id], {
          subject: subjectLabel(s),
          message: `${h} hours: ${amountText(s.amountMinor, s.currency)} approved but not sent, ${expiryText(s.expiresAt, input.nowMs)}.`,
          amountMinor: s.amountMinor,
          currency: s.currency,
          details: { subjectKind: s.kind, subjectId: s.id, hours: h },
        }),
      );
    }
    return done(finish(issues, p.ready.length, unjudged), input, "ready");
  },
};

const draftWaitingLong: DqRuleDef = {
  id: "payments.draft_waiting_long",
  area: "bank",
  scope: "global",
  defaultSeverity: "warning",
  threshold: null,
  title: "Payment draft waiting for approval in Revolut",
  description:
    "A payment draft was sent to Revolut and nobody approved it in the Revolut app for over half of the time after which it counts as failed.",
  fix: "payments",
  evaluate(input, config) {
    const p = input.payments;
    if (p === null) return notAvailable("payments_not_loaded");
    const expiryMs = p.draftExpiryDays * DAY_MS;
    const issues: DqIssue[] = [];
    const unjudged: string[] = [];
    for (const s of p.draftsWaiting) {
      const age = ageMs(input.nowMs, s.since);
      if (age === null) {
        unjudged.push(fingerprintOf(this.id, [s.kind, s.id]));
        continue;
      }
      if (age <= expiryMs / 2) continue;
      // Half of the expiry is a prompt (info); past 80% it is the rule's own severity.
      const severity = age > expiryMs * DRAFT_WARNING_SHARE ? config.severity : "info";
      const d = wholeDays(age);
      const left = Math.max(0, Math.ceil((expiryMs - age) / DAY_MS));
      issues.push(
        makeIssue(this, { severity }, [s.kind, s.id], {
          subject: subjectLabel(s),
          message: `${d} ${plural(d, "day", "days")}: ${amountText(s.amountMinor, s.currency)} draft not approved in Revolut, ${left} ${plural(left, "day", "days")} left.`,
          amountMinor: s.amountMinor,
          currency: s.currency,
          details: { subjectKind: s.kind, subjectId: s.id, days: d },
        }),
      );
    }
    return done(finish(issues, p.draftsWaiting.length, unjudged), input, "draftsWaiting");
  },
};

const disabledWithInflight: DqRuleDef = {
  id: "payments.disabled_with_inflight",
  area: "bank",
  scope: "global",
  defaultSeverity: "warning",
  threshold: null,
  title: "Payments switched off with requests in flight",
  description:
    "The payments switch is off, but requests are still waiting for approval, ready to send, or sent. Approved requests are not sent while the switch is off; sent ones are still looked up.",
  fix: "payments",
  evaluate(input, config) {
    const p = input.payments;
    if (p === null) return notAvailable("payments_not_loaded");
    if (p.switchOn || p.inFlight <= 0) return finish([], 1);
    const n = p.inFlight;
    return finish(
      [
        makeIssue(this, config, ["switch"], {
          subject: "Payments switch",
          message: `${n} payment ${plural(n, "request is", "requests are")} in flight while payments are switched off.`,
          details: { count: n },
        }),
      ],
      1,
    );
  },
};

export const PAYMENT_RULES: readonly DqRuleDef[] = [
  outcomeUnknownOld,
  alertOpen,
  paidNotBooked,
  readyNotSent,
  draftWaitingLong,
  disabledWithInflight,
];
