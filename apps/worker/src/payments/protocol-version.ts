/**
 * The version of everything that decides what a payment does (ADR 0049 + ADR 0050): the core rules
 * (`paymentsProtocolVersion` in packages/core) PLUS what only the worker knows, the Revolut request
 * builders' output on fixed samples, the failure classification, the reference and name limits, the
 * payment endpoints of the gate allow-list and the runbook. A verification mark records this value;
 * any change to any of those voids the mark and so switches payments OFF until they are verified
 * again on the sandbox. Pinned in test/payments-execution.test.ts.
 */
import {
  paymentsProtocolVersion as coreProtocolVersion,
  PAYMENTS_VERIFY_RUNBOOK,
  sha256Hex,
} from "@camelthorn/core";
import {
  buildCreateCounterparty,
  buildPay,
  buildPaymentDraft,
  classifyPaymentFailure,
  PAYMENT_JOB_CLASS_RE,
  REVOLUT_AMOUNT_MAX_MINOR,
  REVOLUT_AMOUNT_SCALE,
  REVOLUT_NAME_MAX,
  REVOLUT_REFERENCE_MAX,
  RevolutApiError,
  RevolutAuthError,
  RevolutRateLimitedError,
  RevolutWriteAuthRetryRefused,
} from "@camelthorn/revolut";
import { paymentEndpointDescriptor } from "../revolut/request";

const RID = "11111111-1111-4111-8111-111111111111";
const ACC = "bdab1c20-8d8c-430d-b967-87ac01af060c";
const CP = "5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11";

export function paymentsProtocolVersion(): string {
  const leg = {
    accountId: ACC,
    counterpartyId: CP,
    amountMinor: 123_450,
    currency: "EUR",
    reference: "Invoice Ünï/1",
  };
  const errors: unknown[] = [
    new RangeError("x"),
    new RevolutWriteAuthRetryRefused(),
    new RevolutAuthError("unauthorized"),
    new RevolutRateLimitedError(1000),
    new RevolutApiError(409, "x"),
    new RevolutApiError(400, "x", "bad"),
    new RevolutApiError(422, "x"),
    new RevolutApiError(500, "x"),
    new RevolutApiError(503, "x", "gate_unavailable"),
    new RevolutApiError(200, "x", "PAYMENT_ANSWER_UNREADABLE"),
    new RevolutApiError(400, "x", "NL91ABNA0417164300"),
  ];
  const classes = (["never_attempted", "attempted", "unreadable"] as const).map((l) =>
    errors.map((e) => classifyPaymentFailure(e, l)),
  );
  return sha256Hex(
    JSON.stringify([
      "payments-execution-v1",
      coreProtocolVersion(),
      buildPay({ ...leg, requestId: RID }),
      buildPaymentDraft({ requestId: RID, payments: [leg, { ...leg, receiverAccountId: CP }] }),
      buildCreateCounterparty({
        name: "Acme  B.V.",
        iban: "nl91 abna 0417 1643 00",
        currency: "EUR",
      }),
      classes,
      REVOLUT_REFERENCE_MAX,
      REVOLUT_NAME_MAX,
      // review P9b: the amount limits are rules of what is sent
      REVOLUT_AMOUNT_MAX_MINOR,
      REVOLUT_AMOUNT_SCALE,
      PAYMENT_JOB_CLASS_RE.source,
      paymentEndpointDescriptor(),
      PAYMENTS_VERIFY_RUNBOOK,
    ]),
  );
}
