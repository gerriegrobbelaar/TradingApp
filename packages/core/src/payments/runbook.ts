/**
 * The Revolut payment verification runbook (Phase 9, P9b, ADR 0050): ONE constant that the worker
 * (preview and settings answers), the web dialog (one tick box per check, with its steps) and
 * docs/DEPLOY.md (a test compares) all read. Every check is something a person does on the Revolut
 * SANDBOX or staging, with tiny amounts, and then ticks. Nothing here has been run yet: that is the
 * point of the list. The order is the order of the runbook.
 */
import { PAYMENTS_VERIFY_CHECKS, type PaymentsVerifyCheck } from "./settings";

export interface RunbookEntry {
  title: string;
  /** Plain steps, in order. Amounts are tiny (1.00 in the sandbox currency). */
  steps: readonly string[];
  /** What must be true to tick it. */
  pass: string;
}

export const PAYMENTS_VERIFY_RUNBOOK: Readonly<Record<PaymentsVerifyCheck, RunbookEntry>> = {
  revolut_plan_known: {
    title: "The Revolut plan is known",
    steps: [
      "Open Revolut Business, Settings, Plan, and read the plan name.",
      "Company plan: `pay` mode may be verified. Any other plan: stay on `drafts` and skip sandbox_pay_roundtrip.",
    ],
    pass: "The plan is written in the note, and the connection's payment mode matches it.",
  },
  sandbox_counterparty_roundtrip: {
    title: "Sandbox: a counterparty is created from a supplier IBAN",
    steps: [
      "On staging with REVOLUT_PAYMENTS_EXECUTION on, open Preview payment for a test bill.",
      "Send the first payment of a test supplier whose IBAN is verified. The app creates the counterparty once.",
      "In Revolut Business (sandbox), Counterparties: the new one shows the supplier name and the SAME IBAN.",
      "Send a second payment to the same supplier: no second counterparty appears.",
    ],
    pass: "One counterparty, the right IBAN, reused for the second payment.",
  },
  sandbox_draft_roundtrip: {
    title: "Sandbox: a payment draft appears in Revolut and is paid after approval",
    steps: [
      "Mode `drafts`. Create, confirm (and approve) a request of 1.00 and send it.",
      "The request shows `submitted`. In the Revolut app a draft titled CF-<12 characters> exists with the right payee, amount and reference.",
      "Approve the draft in the Revolut app. Within 10 minutes the request becomes `paid` and the bank line is linked.",
      "Repeat once with two bills in one batch: ONE bulk draft with two payments.",
    ],
    pass: "Draft content equals the request; approval in the app turns the request paid; the batch is one draft.",
  },
  sandbox_pay_roundtrip: {
    title: "Sandbox: a direct payment works (pay mode, Company plan only)",
    steps: [
      "Only for the `pay` mode. Set the connection to `pay`, confirm the loosening phrase.",
      "Create, confirm (and approve) a request of 1.00 and send it.",
      "The sandbox shows one transfer with our request id; the request becomes `submitted`, then `paid`.",
    ],
    pass: "One transfer, right amount, right payee, state followed to paid.",
  },
  request_id_idempotency_replay: {
    title: "Sandbox: the same request id is not paid twice",
    steps: [
      "With the sandbox, send the same /pay body twice with the SAME request id (use the Revolut sandbox console or curl with a sandbox token, not the app).",
      "Read what the second call answers (status and error code) and write both in the note.",
      "Confirm only ONE transfer exists. If a second one exists, STOP: do not enable payments.",
    ],
    pass: "One transfer. The second answer is recorded; the app treats it as 'already used, look it up'.",
  },
  lost_answer_lookup_drill: {
    title: "Drill: a lost answer is found again by request id",
    steps: [
      "On staging, send a 1.00 request while the answer is made to fail (cut the Worker response after the gate sent: use the staging fault switch described in docs/DEPLOY.md, or stop the Worker during the call).",
      "The request shows `outcome_unknown`. Never resend it.",
      "Within 5 minutes the reconciliation job finds the transfer by request id (pay) or the draft by its title (drafts) and moves the request on.",
      "A request nothing was sent for stays unknown; a person resolves it with the typed phrase after the lookup says not found.",
    ],
    pass: "The request ends as paid or submitted by lookup, with no second payment in Revolut.",
  },
  reference_charset_probe: {
    title: "Probe: which reference characters and length Revolut accepts",
    steps: [
      "Send sandbox payments with references of 18, 35, 70 and 140 characters, and one with / - ? : ( ) . , ' + and a space.",
      "Write the longest accepted length and any rejected character in the note.",
    ],
    pass: "140 characters and the SEPA set are accepted, or the limit is lowered in code (REVOLUT_REFERENCE_MAX) first.",
  },
  amount_format_probe: {
    title: "Probe: the amount format is accepted and exact",
    steps: [
      "Send sandbox payments of 0.01, 1.00, 1234.50 and 99999.99.",
      "Compare the amount Revolut shows with the amount in the request, to the cent.",
      "Try the amount as a JSON number (what the app sends) and note whether a string would also be accepted.",
    ],
    pass: "Every amount is identical to the cent.",
  },
  webhook_state_sequence: {
    title: "Webhook: the states of a payment arrive in order and are final once",
    steps: [
      "Watch the webhook events and the bank line of a sandbox payment from pending to completed.",
      "Provoke a failure (a sandbox payee that is declined) and watch declined or failed.",
      "Confirm the bank line is booked only in a final state and only once.",
    ],
    pass: "The sequence is pending then one final state; the payment follows the line.",
  },
  four_eyes_approver_accounts_checked: {
    title: "Approver accounts are right",
    steps: [
      "Settings, Users: the people holding the approver role are the intended ones, none of them requests payments in daily use.",
    ],
    pass: "At least one approver other than the finance user who requests.",
  },
  first_iban_verified_out_of_band: {
    title: "The first supplier IBAN was confirmed outside the app",
    steps: [
      "Call the supplier on a number you already had, or compare with a signed contract, and read the IBAN's last four characters.",
      "Then verify the IBAN in the app (approver, fresh sign-in).",
    ],
    pass: "A person confirmed the IBAN by a channel the invoice did not come through.",
  },
  approval_mapping_verified_in_exact: {
    title: "The Exact approval status mapping is verified",
    steps: ["Settings, Approvals: the status mapping is verified against the live Exact entries."],
    pass: "The mapping shows verified for the current table.",
  },
  limits_reviewed_by_finance_lead: {
    title: "The limits were reviewed",
    steps: [
      "Read the four-eyes limit, the per-request ceiling and the daily ceiling in Settings, Payments.",
      "Replace the placeholder ceilings (ADR 0049 question 3) with the real ones.",
    ],
    pass: "The finance lead agrees with the values and the note says who.",
  },
};

/** The runbook as plain text (what DEPLOY.md and the web dialog print). */
export function paymentsRunbookText(): string {
  return PAYMENTS_VERIFY_CHECKS.map((c, i) => {
    const e = PAYMENTS_VERIFY_RUNBOOK[c];
    return [
      `${i + 1}. ${c}: ${e.title}`,
      ...e.steps.map((s) => `   - ${s}`),
      `   Pass: ${e.pass}`,
    ].join("\n");
  }).join("\n");
}
