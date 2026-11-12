/** Payment DQ rules (Phase 9 final review S1, ADR 0053): pure evaluators with an injected clock. */
import { describe, expect, it } from "vitest";
import {
  DQ_FIX_PATHS,
  DQ_RULES,
  DRAFT_WARNING_SHARE,
  MAX_ISSUES_PER_RULE,
  OUTCOME_UNKNOWN_MAX_MS,
  PAYMENT_ALERT_RESULTS,
  READY_NOT_SENT_MAX_MS,
  dqRuleById,
  emptyInput,
  evaluateRules,
  planReconcile,
  resolveAllConfigs,
  type DqInput,
  type DqPaymentsIn,
  type DqRuleResult,
} from "./index";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const base = (over: Partial<DqPaymentsIn> = {}): DqPaymentsIn => ({
  outcomeUnknown: [],
  alerts: [],
  paidNotBooked: [],
  ready: [],
  draftsWaiting: [],
  draftExpiryDays: 5,
  switchOn: true,
  inFlight: 0,
  capped: {},
  ...over,
});
const inputOf = (p: DqPaymentsIn | null): DqInput => ({ ...emptyInput(NOW, 0), payments: p });
const PAYMENT_IDS = [
  "payments.outcome_unknown_old",
  "payments.alert_open",
  "payments.paid_not_booked",
  "payments.ready_not_sent",
  "payments.draft_waiting_long",
  "payments.disabled_with_inflight",
];
function run(p: DqPaymentsIn | null, overrides = {}): Record<string, DqRuleResult> {
  const all = evaluateRules(inputOf(p), "global", resolveAllConfigs(overrides));
  return Object.fromEntries(
    all.filter((r) => PAYMENT_IDS.includes(r.ruleId)).map((r) => [r.ruleId, r]),
  );
}
const subj = (id: number, since: string | null, kind: "payment" | "batch" = "payment") => ({
  kind,
  id,
  amountMinor: 125_000,
  currency: "EUR",
  since,
  expiresAt: new Date(NOW + 10 * HOUR).toISOString(),
});

describe("registration", () => {
  it("registers the six rules as global, area bank, with a payments fix path", () => {
    for (const id of PAYMENT_IDS) {
      const r = dqRuleById(id);
      expect(r, id).toBeDefined();
      expect(r?.scope).toBe("global");
      expect(r?.area).toBe("bank");
      expect(DQ_FIX_PATHS[r!.fix]).toContain("tab=payments");
    }
    expect(new Set(DQ_RULES.map((r) => r.id)).size).toBe(DQ_RULES.length);
    expect(dqRuleById("payments.outcome_unknown_old")?.defaultSeverity).toBe("critical");
    expect(dqRuleById("payments.alert_open")?.defaultSeverity).toBe("critical");
    expect(dqRuleById("payments.paid_not_booked")?.defaultSeverity).toBe("warning");
    expect(dqRuleById("payments.ready_not_sent")?.defaultSeverity).toBe("warning");
  });
});

describe("not available versus ok", () => {
  it("is not_available only when the loader failed", () => {
    const r = run(null);
    expect(Object.keys(r)).toHaveLength(6);
    for (const x of Object.values(r)) {
      expect(x.status).toBe("not_available");
      expect(x.reason).toBe("payments_not_loaded");
    }
  });
  it("is ok with zero rows, never not_available", () => {
    for (const x of Object.values(run(base()))) {
      expect(x.status, x.ruleId).toBe("ok");
      expect(x.issues).toEqual([]);
    }
  });
  it("a failed read resolves nothing, an empty read resolves open issues", () => {
    const issue = run(base({ outcomeUnknown: [subj(1, ago(40 * MIN))] }))[
      "payments.outcome_unknown_old"
    ]!.issues[0]!;
    const existing = [
      {
        id: 7,
        ruleId: issue.ruleId,
        fingerprint: issue.fingerprint,
        status: "open" as const,
        snoozedUntil: null,
      },
    ];
    const failed = planReconcile(existing, Object.values(run(null)), new Date(NOW).toISOString());
    expect(failed.resolve).toEqual([]);
    const empty = planReconcile(existing, Object.values(run(base())), new Date(NOW).toISOString());
    expect(empty.resolve).toEqual([7]);
  });
});

describe("payments.outcome_unknown_old", () => {
  const rule = "payments.outcome_unknown_old";
  it("flags strictly after 30 minutes (boundary with the injected clock)", () => {
    const at = (ms: number) => run(base({ outcomeUnknown: [subj(1, ago(ms))] }))[rule]!;
    expect(at(OUTCOME_UNKNOWN_MAX_MS - 1).status).toBe("ok");
    expect(at(OUTCOME_UNKNOWN_MAX_MS).status).toBe("ok");
    const over = at(OUTCOME_UNKNOWN_MAX_MS + 1);
    expect(over.status).toBe("issues");
    expect(over.issues[0]?.severity).toBe("critical");
    expect(over.issues[0]?.amountMinor).toBe(125_000);
    expect(over.issues[0]?.currency).toBe("EUR");
  });
  it("keeps a payment and a batch with the same id apart, and states the amount at scale", () => {
    const r = run(base({ outcomeUnknown: [subj(5, ago(HOUR)), subj(5, ago(HOUR), "batch")] }))[
      rule
    ]!;
    expect(r.issues).toHaveLength(2);
    expect(new Set(r.issues.map((i) => i.fingerprint)).size).toBe(2);
    expect(r.issues.map((i) => i.subject).sort()).toEqual(["Batch 5", "Payment 5"]);
    expect(r.issues[0]?.message).toContain("EUR 1250.00");
  });
  it("does not judge an unreadable time and leaves its issue alone", () => {
    const r = run(base({ outcomeUnknown: [subj(1, null), subj(2, "not a date")] }))[rule]!;
    expect(r.status).toBe("ok");
    expect(r.unjudged).toHaveLength(2);
  });
  it("a future start (clock skew) is not an issue", () => {
    expect(run(base({ outcomeUnknown: [subj(1, ago(-HOUR))] }))[rule]!.status).toBe("ok");
  });
});

describe("payments.alert_open", () => {
  const rule = "payments.alert_open";
  const alert = (id: number, result: string, kind: "payment" | "batch" = "payment") => ({
    kind,
    id,
    result,
    alertAt: ago(HOUR),
    amountMinor: 5_000,
    currency: "EUR",
  });
  it("raises one critical issue per alert kind, with the kind in the subject", () => {
    const r = run(base({ alerts: PAYMENT_ALERT_RESULTS.map((k, i) => alert(i + 1, k)) }))[rule]!;
    expect(r.issues).toHaveLength(4);
    expect(r.issues.every((i) => i.severity === "critical")).toBe(true);
    const subjects = r.issues.map((i) => i.subject).join("|");
    expect(subjects).toContain("approved after expiry");
    expect(subjects).toContain("reverted after paid");
    expect(subjects).toContain("bank data does not match");
    expect(subjects).toContain("possible duplicate payment");
  });
  it("two alerts on one payment are two issues; an open alert of an unknown kind is still raised", () => {
    // Review F9b: the loader only hands over OPEN alerts, so a kind without a label (a kind added
    // later, or an empty alert_kind) is raised with a generic label, never skipped.
    const r = run(
      base({
        alerts: [
          alert(1, "mismatch"),
          alert(1, "duplicate"),
          alert(2, "some_new_kind"),
          alert(3, ""),
          alert(4, "<b>Robert'); DROP"),
          alert(5, "__proto__"),
          alert(6, "toString"),
        ],
      }),
    )[rule]!;
    expect(r.issues).toHaveLength(7);
    expect(r.checked).toBe(7);
    const by = (id: number) => r.issues.filter((i) => i.details["subjectId"] === id);
    expect(by(2)[0]?.subject).toBe("Payment 2 · alert that needs a look");
    expect(by(2)[0]?.details["alert"]).toBe("some_new_kind");
    expect(by(3)[0]?.details["alert"]).toBe("unknown");
    expect(by(4)[0]?.details["alert"]).toBe("unknown");
    expect(by(4)[0]?.subject).not.toContain("<b>");
    expect(by(5)[0]?.subject).toBe("Payment 5 · alert that needs a look");
    expect(by(6)[0]?.subject).toBe("Payment 6 · alert that needs a look");
  });
  it("labels the alert kinds of migration 0030 (F9a)", () => {
    const r = run(base({ alerts: [alert(1, "draft_gone"), alert(2, "draft_completed_unlinked")] }))[
      rule
    ]!;
    expect(r.issues.map((i) => i.subject)).toEqual([
      "Payment 1 · draft no longer in Revolut",
      "Payment 2 · draft completed, bank lines not linked",
    ]);
  });
  it("tolerates an alert whose payment has no amount", () => {
    const r = run(
      base({ alerts: [{ ...alert(1, "mismatch"), amountMinor: null, currency: null }] }),
    )[rule]!;
    expect(r.issues[0]?.amountMinor).toBeNull();
    expect(r.issues[0]?.message).not.toContain("null");
  });
  it("an admin override of the severity is respected", () => {
    const r = run(base({ alerts: [alert(1, "mismatch")] }), {
      [rule]: { severity: "warning" },
    })[rule]!;
    expect(r.issues[0]?.severity).toBe("warning");
  });
});

describe("payments.paid_not_booked", () => {
  const rule = "payments.paid_not_booked";
  const paid = (
    id: number,
    ms: number | null,
    stage:
      | "awaiting_bank_line"
      | "awaiting_match"
      | "match_other_invoice"
      | "awaiting_booking" = "awaiting_bank_line",
  ) => ({
    id,
    amountMinor: 9_900,
    currency: "EUR",
    paidAt: ms === null ? null : ago(ms),
    stage,
  });
  it("flags after three days by default, not at exactly three", () => {
    const at = (ms: number) => run(base({ paidNotBooked: [paid(1, ms)] }))[rule]!.status;
    expect(at(3 * DAY)).toBe("ok");
    expect(at(3 * DAY + 1)).toBe("issues");
    expect(at(DAY)).toBe("ok");
  });
  it("uses the configured number of days", () => {
    const o = { [rule]: { threshold: 7 } };
    expect(run(base({ paidNotBooked: [paid(1, 5 * DAY)] }), o)[rule]!.status).toBe("ok");
    expect(run(base({ paidNotBooked: [paid(1, 8 * DAY)] }), o)[rule]!.status).toBe("issues");
    // an invalid override falls back to the default
    expect(
      run(base({ paidNotBooked: [paid(1, 4 * DAY)] }), { [rule]: { threshold: 0 } })[rule]!.status,
    ).toBe("issues");
  });
  it("says how far the Exact side is", () => {
    const r = run(
      base({
        paidNotBooked: [
          paid(1, 4 * DAY, "awaiting_bank_line"),
          paid(2, 4 * DAY, "awaiting_match"),
          paid(3, 4 * DAY, "awaiting_booking"),
          paid(4, 4 * DAY, "match_other_invoice"),
        ],
      }),
    )[rule]!;
    expect(r.issues.map((i) => i.details["stage"])).toEqual([
      "awaiting_bank_line",
      "awaiting_match",
      "awaiting_booking",
      "match_other_invoice",
    ]);
    expect(r.issues.map((i) => i.message.split(", but ")[1])).toEqual([
      "the bank line has not arrived.",
      "the bank line is not matched.",
      "the match is not booked in Exact.",
      "the bank line is matched to another invoice.",
    ]);
    expect(r.issues[0]?.message).toMatch(/^4 days: EUR 99\.00 paid/);
    expect(r.issues.every((i) => i.severity === "warning")).toBe(true);
  });
  it("leaves a payment with an unreadable paid time unjudged", () => {
    const r = run(base({ paidNotBooked: [paid(1, null)] }))[rule]!;
    expect(r.unjudged).toHaveLength(1);
  });
});

describe("payments.ready_not_sent", () => {
  const rule = "payments.ready_not_sent";
  it("flags strictly after four hours and shows the expiry countdown", () => {
    const at = (ms: number) => run(base({ ready: [subj(1, ago(ms))] }))[rule]!;
    expect(at(READY_NOT_SENT_MAX_MS).status).toBe("ok");
    const r = at(READY_NOT_SENT_MAX_MS + 1);
    expect(r.status).toBe("issues");
    expect(r.issues[0]?.message).toContain("expires in 10 hours");
    expect(r.issues[0]?.severity).toBe("warning");
  });
  it("says expired for a request past its validity and copes with a missing expiry", () => {
    const expired = { ...subj(1, ago(30 * HOUR)), expiresAt: ago(HOUR) };
    const none = { ...subj(2, ago(30 * HOUR)), expiresAt: null };
    const r = run(base({ ready: [expired, none] }))[rule]!;
    expect(r.issues[0]?.message).toContain("expired");
    expect(r.issues[1]?.message).toContain("expiry unknown");
  });
});

describe("payments.draft_waiting_long", () => {
  const rule = "payments.draft_waiting_long";
  const at = (ms: number, days = 5) =>
    run(base({ draftsWaiting: [subj(1, ago(ms))], draftExpiryDays: days }))[rule]!;
  it("is silent up to half of the expiry, info past it, warning past 80%", () => {
    expect(at(2.5 * DAY).status).toBe("ok");
    const half = at(2.5 * DAY + 1);
    expect(half.issues[0]?.severity).toBe("info");
    expect(at(DRAFT_WARNING_SHARE * 5 * DAY).issues[0]?.severity).toBe("info");
    expect(at(DRAFT_WARNING_SHARE * 5 * DAY + 1).issues[0]?.severity).toBe("warning");
  });
  it("follows the configured expiry", () => {
    expect(at(2 * DAY, 3).issues[0]?.severity).toBe("info");
    expect(at(2 * DAY, 30).status).toBe("ok");
  });
});

describe("payments.disabled_with_inflight", () => {
  const rule = "payments.disabled_with_inflight";
  it("needs the switch off and at least one request in flight", () => {
    expect(run(base({ switchOn: false, inFlight: 0 }))[rule]!.status).toBe("ok");
    expect(run(base({ switchOn: true, inFlight: 4 }))[rule]!.status).toBe("ok");
    const r = run(base({ switchOn: false, inFlight: 3 }))[rule]!;
    expect(r.status).toBe("issues");
    expect(r.issues[0]?.message).toMatch(/^3 payment requests are in flight/);
    expect(run(base({ switchOn: false, inFlight: 1 }))[rule]!.issues[0]?.message).toContain(
      "1 payment request is in flight",
    );
  });
});

describe("caps and privacy", () => {
  it("cuts at the issue cap and says so", () => {
    const rows = Array.from({ length: 1_000 }, (_, i) => subj(i + 1, ago(DAY)));
    const r = run(base({ outcomeUnknown: rows, ready: rows }));
    for (const id of ["payments.outcome_unknown_old", "payments.ready_not_sent"]) {
      expect(r[id]!.issues).toHaveLength(MAX_ISSUES_PER_RULE);
      expect(r[id]!.truncated).toBe(true);
      expect(r[id]!.total).toBe(1_000);
    }
  });
  it("a list the loader cut makes the rule truncated although few issues are shown", () => {
    const r = run(
      base({
        ready: [subj(1, ago(DAY))],
        capped: { ready: true, alerts: true, paidNotBooked: true },
      }),
    );
    expect(r["payments.ready_not_sent"]!.truncated).toBe(true);
    expect(r["payments.alert_open"]!.truncated).toBe(true);
    expect(r["payments.paid_not_booked"]!.truncated).toBe(true);
    expect(r["payments.outcome_unknown_old"]!.truncated).toBe(false);
    // and a truncated rule resolves nothing
    const issue = r["payments.ready_not_sent"]!.issues[0]!;
    const plan = planReconcile(
      [
        {
          id: 1,
          ruleId: issue.ruleId,
          fingerprint: issue.fingerprint,
          status: "open",
          snoozedUntil: null,
        },
        {
          id: 2,
          ruleId: issue.ruleId,
          fingerprint: `${issue.ruleId}:payment|99`,
          status: "open",
          snoozedUntil: null,
        },
      ],
      Object.values(r),
      new Date(NOW).toISOString(),
    );
    expect(plan.resolve).toEqual([]);
  });
  it("no issue carries an IBAN, a beneficiary or a raw timestamp in text", () => {
    const rows = [subj(1, ago(DAY)), subj(2, ago(DAY), "batch")];
    const r = run(
      base({
        outcomeUnknown: rows,
        ready: rows,
        draftsWaiting: rows.map((s) => ({ ...s, since: ago(4 * DAY) })),
        alerts: [
          {
            kind: "payment",
            id: 1,
            result: "mismatch",
            alertAt: ago(HOUR),
            amountMinor: 1,
            currency: "EUR",
          },
        ],
        paidNotBooked: [
          { id: 1, amountMinor: 1, currency: "EUR", paidAt: ago(9 * DAY), stage: "awaiting_match" },
        ],
        switchOn: false,
        inFlight: 2,
      }),
    );
    const text = JSON.stringify(Object.values(r).flatMap((x) => x.issues));
    expect(text).not.toMatch(/[A-Z]{2}\d{2}[A-Z0-9]{10,}/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(Object.values(r).flatMap((x) => x.issues).length).toBeGreaterThan(8);
  });
  it("a disabled rule is not evaluated", () => {
    const r = run(base({ outcomeUnknown: [subj(1, ago(DAY))] }), {
      "payments.outcome_unknown_old": { enabled: false },
    });
    expect(r["payments.outcome_unknown_old"]!.status).toBe("disabled");
  });
});
