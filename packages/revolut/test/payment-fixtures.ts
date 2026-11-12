/**
 * Payment fixtures for the Revolut client (P9b, ADR 0050).
 *
 * THESE ARE NOT CAPTURED FROM THE SANDBOX. They are shaped after the public Business API
 * documentation as remembered (A-items in ADR 0050). Replace them with recorded sandbox answers
 * as part of the verification checklist and keep the tests: a difference between a fixture and the
 * recording IS the finding.
 */
export const REQUEST_ID = "3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a42";
export const ACCOUNT_ID = "bdab1c20-8d8c-430d-b967-87ac01af060c";
export const COUNTERPARTY_ID = "5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11";
export const IBAN = "NL91ABNA0417164300";

export const COUNTERPARTY_CREATED = JSON.stringify({
  id: COUNTERPARTY_ID,
  name: "Acme Supplies B.V.",
  state: "created",
  created_at: "2026-11-01T09:00:00.123Z",
  updated_at: "2026-11-01T09:00:00.123Z",
  accounts: [
    {
      id: "a5b2c3d4-0000-4000-8000-00000000abcd",
      currency: "EUR",
      type: "external",
      iban: IBAN,
      bic: "ABNANL2A",
      recipient_charges: "no",
      an_unknown_future_field: { nested: [1, 2, 3] },
    },
  ],
});

export const PAY_PENDING = JSON.stringify({
  id: "64f1e2a0-1111-4222-8333-444455556666",
  state: "pending",
  created_at: "2026-11-02T10:00:00.000Z",
  extra: "ignored",
});
export const PAY_COMPLETED = JSON.stringify({
  id: "64f1e2a0-1111-4222-8333-444455556666",
  state: "completed",
  created_at: "2026-11-02T10:00:00.000Z",
  completed_at: "2026-11-02T10:00:01.000Z",
});
export const PAY_DECLINED = JSON.stringify({
  id: "64f1e2a0-1111-4222-8333-444455556666",
  state: "declined",
  reason_code: "invalid_account",
  created_at: "2026-11-02T10:00:00.000Z",
});

export const DRAFT_CREATED = JSON.stringify({ id: "9c1d5a62-7777-4888-9999-aaaabbbbcccc" });

export const DRAFT_VIEW = JSON.stringify({
  id: "9c1d5a62-7777-4888-9999-aaaabbbbcccc",
  title: "CF-3f2b8c1e5d4a",
  state: "pending",
  payments: [
    { state: "pending", account_id: ACCOUNT_ID },
    { state: "completed", transaction_id: "64f1e2a0-1111-4222-8333-444455556666" },
  ],
});

export const TRANSACTION = JSON.stringify({
  id: "64f1e2a0-1111-4222-8333-444455556666",
  type: "transfer",
  request_id: REQUEST_ID,
  state: "completed",
  created_at: "2026-11-02T10:00:00.000Z",
  completed_at: "2026-11-02T10:00:01.000Z",
  reference: "Invoice 2026-0412",
  legs: [
    {
      leg_id: "11111111-2222-4333-8444-555566667777",
      amount: -1234.5,
      currency: "EUR",
      account_id: ACCOUNT_ID,
      counterparty: { id: COUNTERPARTY_ID, type: "external" },
      description: "Invoice 2026-0412",
    },
  ],
});

export const ERROR_BODY = (message: string, code?: number | string): string =>
  JSON.stringify({ message, ...(code !== undefined ? { code } : {}) });
