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
      "A11, on a plan that is NOT Company: send one 1.00 `/pay` from the sandbox console or curl and write down the answer (status and error code). It must be refused; if it is accepted, the plan is not what Settings says: STOP.",
    ],
    pass: "The plan is written in the note, the connection's payment mode matches it, and (not Company) `/pay` was refused.",
  },
  sandbox_counterparty_roundtrip: {
    title: "Sandbox: a counterparty is created from a supplier IBAN",
    steps: [
      "On staging with REVOLUT_PAYMENTS_EXECUTION on, open Preview payment for a test bill.",
      "Send the first payment of a test supplier whose IBAN is verified. The app creates the counterparty once.",
      "In Revolut Business (sandbox), Counterparties: the new one shows the supplier name and the SAME IBAN.",
      "Send a second payment to the same supplier: no second counterparty appears.",
      "Payee-name verification: pay a test supplier whose name differs slightly from the name on the IBAN, and one whose name is exactly right. Write down what Revolut shows or answers (match, close match, no match) and whether it blocks the payment.",
    ],
    pass: "One counterparty, the right IBAN, reused for the second payment; the answer to a wrong payee name is written in the note.",
  },
  counterparty_lookup_probe: {
    title: "Probe: counterparties can be listed, with IBANs, and reads are rate limited sensibly",
    steps: [
      "A14: in the sandbox console or curl, `GET /counterparties` and look at one external counterparty. Write down whether its account carries the full `iban`. If it does not, the app cannot find a payee it created before (after a lost answer or a key change): STOP and tell the developer.",
      "A14: write down whether the list is paged (a `limit`, a `created_before` or a next link) and how many counterparties one page holds. The app reads ONE page.",
      "A16: send 40 reads of `GET /counterparties` within one minute. Write down the first status that is not 200, its `Retry-After` header and the error body.",
    ],
    pass: "The list shows IBANs, its paging is written down, and the rate-limit answer is written down.",
  },
  sandbox_draft_roundtrip: {
    title: "Sandbox: a payment draft appears in Revolut and is paid after approval",
    steps: [
      "Mode `drafts`. Create, confirm (and approve) a request of 1.00 and send it.",
      "The request shows `submitted`. In the Revolut app a draft titled CF-<12 characters> exists with the right payee, amount and reference.",
      "Approve the draft in the Revolut app. Within 10 minutes the request becomes `paid` and the bank line is linked.",
      "Repeat once with two bills in one batch: ONE bulk draft with two payments.",
      "S13, fees: on the bank line of the paid draft look for a fee (a separate fee leg or a fee amount). Write down whether this payment type carries one. A payment with a fee line cannot be booked by the app (matching refuses fee lines): such a payment type must not be used until that is decided.",
    ],
    pass: "Draft content equals the request; approval in the app turns the request paid; the batch is one draft; whether a fee exists is written in the note.",
  },
  draft_lifecycle_probe: {
    title: "Probe: how a draft ends, is read back, and is listed",
    steps: [
      "A10: send `POST /payment-drafts` from the sandbox console with an invalid body (a bad currency). Then list the drafts: NO draft may exist for it. If one does, STOP: a refused call can leave a draft.",
      "A8, state words: write down the exact `state` words of a draft that is pending, approved and paid, deleted in the Revolut app, and expired. The app reads completed/failed/declined/revoked/cancelled/rejected/reverted/deleted; any other word counts as pending.",
      "A8, completed: after approving a 1.00 draft read it back (`GET /payment-drafts/{id}`) and open each payment in it. Every payment must carry the id of its transaction, and `GET /transaction/{id}` must show our amount leaving our account. If a payment has no transaction id, the app will NOT mark the request paid (it raises draft_completed_unlinked): STOP and tell the developer.",
      "A8, delete: delete a pending draft in the Revolut app, then `GET /payment-drafts/{id}`. Write down the answer (404 or a state). The app treats 404 as not found and never as failed.",
      "A8, approve late: let a 1.00 draft stay unapproved past `payments.draft_expiry_days` (set it to 1 for the drill), see the request fail as draft_expired, then approve the draft in the Revolut app. The job must raise an alert and the request must NOT become paid by itself.",
      "A8, paging: create more drafts than one page of `GET /payment-drafts` holds (write down the page size) and check whether the draft you look for is on the first page. If the list is paged and the app reads one page, a lost answer can be missed: STOP and tell the developer.",
    ],
    pass: "A refused call creates no draft, the state words and the 404 are written down, a late approval is raised, and the list paging is known.",
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
      "On staging, send a 1.00 request and cut the Worker off after the sandbox received it: run the staging Worker with `wrangler dev --env staging --remote`, send the request, and stop the dev server (Ctrl-C) as soon as the sandbox console shows the new transfer or draft. Nothing else in the app can fake a lost answer.",
      "The request stays `submitting` until its claim runs out (10 minutes), then shows `outcome_unknown`. Never resend it.",
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
