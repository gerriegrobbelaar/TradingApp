import { currencyScale, parseMinor } from "@camelthorn/core";
import { describe, expect, it } from "vitest";
import { createRevolutClient } from "../src/client";
import {
  buildCreateCounterparty,
  buildPay,
  buildPaymentDraft,
  classifyPaymentFailure,
  draftTitle,
  isPaymentJobId,
  parseCreatedCounterparty,
  parsePayAnswer,
  parsePaymentDraft,
  revolutAmount,
  revolutName,
  revolutReference,
  REVOLUT_AMOUNT_MAX_MINOR,
  REVOLUT_REFERENCE_MAX,
} from "../src/payments";
import {
  RevolutApiError,
  RevolutAuthError,
  RevolutRateLimitedError,
  RevolutWriteAuthRetryRefused,
} from "../src/transport";
import {
  ACCOUNT_ID,
  COUNTERPARTY_CREATED,
  COUNTERPARTY_ID,
  DRAFT_CREATED,
  DRAFT_VIEW,
  ERROR_BODY,
  IBAN,
  PAY_COMPLETED,
  PAY_DECLINED,
  PAY_PENDING,
  REQUEST_ID,
  TRANSACTION,
} from "./payment-fixtures";
import { ok, scripted, status } from "./helpers";

const leg = {
  accountId: ACCOUNT_ID,
  counterpartyId: COUNTERPARTY_ID,
  amountMinor: 123_450,
  currency: "EUR",
  reference: "Invoice 2026-0412",
};
const CALL = { lease: "lease-1", ledgerKey: REQUEST_ID };

describe("revolutAmount: the single audited amount function", () => {
  it("formats integer minor units at the currency scale", () => {
    expect(revolutAmount(123_450, "EUR")).toBe("1234.50");
    expect(revolutAmount(1, "EUR")).toBe("0.01");
    expect(revolutAmount(5, "EUR")).toBe("0.05");
    expect(revolutAmount(100, "EUR")).toBe("1.00");
    expect(revolutAmount(99, "EUR")).toBe("0.99");
    expect(revolutAmount(100_000_000_000_000, "EUR")).toBe("1000000000000.00");
    expect(revolutAmount(REVOLUT_AMOUNT_MAX_MINOR, "EUR")).toBe("9999999999999.99");
    expect(revolutAmount(123_456, "USD")).toBe("1234.56");
  });
  it("review P9b: never rounds; refuses what a double-parsing receiver could not read exactly", () => {
    // 1e15 minor units would be 16 significant digits; MAX_SAFE_INTEGER even more
    expect(() => revolutAmount(REVOLUT_AMOUNT_MAX_MINOR + 1, "EUR")).toThrow(RangeError);
    expect(() => revolutAmount(1e15, "EUR")).toThrow(RangeError);
    expect(() => revolutAmount(Number.MAX_SAFE_INTEGER, "EUR")).toThrow(RangeError);
    // every amount we do send is exact as a double too
    for (const m of [1, 99, 100, 123_450, 999_999_999_999_999]) {
      const t = revolutAmount(m, "EUR");
      expect(Number(t).toFixed(2)).toBe(t);
    }
  });
  it("review P9b: currencies whose scale is not 2 are refused (A3 unverified), never converted", () => {
    for (const c of ["JPY", "KRW", "KWD", "BHD", "CLF"]) {
      expect(() => revolutAmount(1234, c)).toThrow(/scale/);
    }
  });
  it("round-trips through the parser for many values (no float anywhere)", () => {
    let x = 7;
    for (let i = 0; i < 2000; i++) {
      x = (x * 48271) % 2147483647;
      const minor = x * 3 + 1;
      for (const c of ["EUR", "USD", "GBP"]) {
        expect(parseMinor(revolutAmount(minor, c), currencyScale(c))).toBe(minor);
      }
    }
  });
  it("refuses anything that is not a positive safe integer and a plain currency", () => {
    for (const bad of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      2 ** 53,
      "100" as unknown as number,
      null as never,
    ]) {
      expect(() => revolutAmount(bad, "EUR")).toThrow(RangeError);
    }
    for (const c of ["eur", "EU", "EURO", "", "E1R"]) {
      expect(() => revolutAmount(100, c)).toThrow(RangeError);
    }
  });
});

describe("reference and names", () => {
  it("keeps the SEPA character set and caps the length", () => {
    expect(revolutReference("Invoice 2026-0412")).toBe("Invoice 2026-0412");
    expect(revolutReference("Fäktuur Ünï/1")).toBe("Faktuur Uni/1");
    expect(revolutReference("A".repeat(300))).toHaveLength(REVOLUT_REFERENCE_MAX);
    expect(revolutReference("x // y")).toBe("x / y");
  });
  it("never produces an empty reference", () => {
    expect(() => revolutReference("日本語")).toThrow(RangeError);
    expect(() => revolutReference("   ")).toThrow(RangeError);
  });
  it("cleans a name and refuses an empty one", () => {
    expect(revolutName("  Acme​  Supplies\n B.V. ")).toBe("Acme Supplies B.V.");
    expect(revolutName("x".repeat(200))).toHaveLength(70);
    expect(() => revolutName("​ \n")).toThrow(RangeError);
  });
  it("the draft title carries 12 hex characters of the request id", () => {
    expect(draftTitle(REQUEST_ID)).toBe("CF-3f2b8c1e5d4a");
    expect(() => draftTitle("not-a-uuid")).toThrow(RangeError);
  });
});

describe("strict request builders (the bytes that would be sent)", () => {
  it("pay: exact body, amount a raw JSON number token", () => {
    const b = buildPay({ ...leg, requestId: REQUEST_ID });
    expect(b.method).toBe("POST");
    expect(b.path).toBe("/pay");
    expect(b.body).toBe(
      `{"request_id":"${REQUEST_ID}","account_id":"${ACCOUNT_ID}","receiver":{"counterparty_id":"${COUNTERPARTY_ID}"},"amount":1234.50,"currency":"EUR","reference":"Invoice 2026-0412"}`,
    );
    expect(Object.keys(JSON.parse(b.body) as object)).toEqual([
      "request_id",
      "account_id",
      "receiver",
      "amount",
      "currency",
      "reference",
    ]);
  });
  it("pay: requires a UUIDv4 request id and uuid ids", () => {
    expect(() => buildPay({ ...leg, requestId: "abc" })).toThrow(RangeError);
    expect(() => buildPay({ ...leg, requestId: REQUEST_ID, accountId: "x" })).toThrow(RangeError);
    expect(() => buildPay({ ...leg, requestId: REQUEST_ID, counterpartyId: "x" })).toThrow(
      RangeError,
    );
    expect(() => buildPay({ ...leg, requestId: REQUEST_ID, receiverAccountId: "no" })).toThrow(
      RangeError,
    );
    expect(() => buildPay({ ...leg, requestId: REQUEST_ID, amountMinor: 1.5 })).toThrow(RangeError);
    expect(() => buildPay({ ...leg, requestId: REQUEST_ID, currency: "eur" })).toThrow(RangeError);
  });
  it("pay: a hostile reference cannot break out of the JSON string", () => {
    const b = buildPay({ ...leg, requestId: REQUEST_ID, reference: 'x","amount":1,"y":"' });
    const parsed = JSON.parse(b.body) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(6);
    expect(String(parsed["reference"])).not.toContain('"');
  });
  it("counterparty: validates the IBAN checksum and sends the normalised one", () => {
    const b = buildCreateCounterparty({
      name: "Acme Supplies B.V.",
      iban: "nl91 abna 0417 1643 00",
      currency: "EUR",
    });
    expect(b.path).toBe("/counterparty");
    expect(JSON.parse(b.body)).toEqual({
      company_name: "Acme Supplies B.V.",
      bank_country: "NL",
      currency: "EUR",
      iban: IBAN,
    });
    expect(() =>
      buildCreateCounterparty({ name: "A", iban: "NL91ABNA0417164301", currency: "EUR" }),
    ).toThrow(RangeError);
    expect(() => buildCreateCounterparty({ name: "", iban: IBAN, currency: "EUR" })).toThrow(
      RangeError,
    );
  });
  it("draft: one entry or a bulk of several, title from the request id, same currency", () => {
    const one = buildPaymentDraft({ requestId: REQUEST_ID, payments: [leg] });
    expect(one.path).toBe("/payment-drafts");
    const p = JSON.parse(one.body) as { title: string; payments: Record<string, unknown>[] };
    expect(p.title).toBe("CF-3f2b8c1e5d4a");
    expect(p.payments).toHaveLength(1);
    expect(Object.keys(p.payments[0] as object)).toEqual([
      "account_id",
      "receiver",
      "amount",
      "currency",
      "reference",
    ]);
    expect(one.body).toContain('"amount":1234.50');
    expect(() => buildPaymentDraft({ requestId: REQUEST_ID, payments: [] })).toThrow(RangeError);
    expect(() =>
      buildPaymentDraft({ requestId: REQUEST_ID, payments: [leg, { ...leg, currency: "USD" }] }),
    ).toThrow(RangeError);
  });
});

describe("tolerant parsers", () => {
  it("reads a counterparty answer and ignores unknown fields", () => {
    const c = parseCreatedCounterparty(COUNTERPARTY_CREATED);
    expect(c.id).toBe(COUNTERPARTY_ID);
    expect(c.accounts[0]?.iban).toBe(IBAN);
  });
  it("reads pay answers; an unknown state is 'unknown', never 'completed'", () => {
    expect(parsePayAnswer(PAY_PENDING).state).toBe("pending");
    expect(parsePayAnswer(PAY_COMPLETED).state).toBe("completed");
    expect(parsePayAnswer(PAY_DECLINED)).toMatchObject({
      state: "declined",
      reasonCode: "invalid_account",
    });
    expect(parsePayAnswer(JSON.stringify({ id: "x", state: "weird" })).state).toBe("unknown");
  });
  it("an answer without an id is unreadable (outcome unknown for the caller)", () => {
    for (const body of ["", "[]", "{}", '{"state":"pending"}', "not json"]) {
      expect(() => parsePayAnswer(body)).toThrow(RevolutApiError);
    }
    try {
      parsePayAnswer("{}");
    } catch (e) {
      expect(e).toMatchObject({ status: 200, code: "PAYMENT_ANSWER_UNREADABLE" });
    }
  });
  it("reads a draft view", () => {
    const d = parsePaymentDraft(JSON.parse(DRAFT_VIEW));
    expect(d.title).toBe("CF-3f2b8c1e5d4a");
    expect(d.payments[1]).toMatchObject({ state: "completed" });
  });
});

describe("client: strict in send, one attempt, no retry", () => {
  const client = (replies: Parameters<typeof scripted>[0]) => {
    const s = scripted(replies);
    return {
      calls: s.calls,
      c: createRevolutClient(s.transport, {
        connectionId: 1,
        jobId: "revolut-payment",
        priority: "user",
        sleep: () => Promise.resolve(),
      }),
    };
  };

  it("pay sends the built body with the lease and the ledger key", async () => {
    const { c, calls } = client([ok(PAY_PENDING)]);
    const r = await c.pay({ ...leg, requestId: REQUEST_ID }, CALL);
    expect(r).toMatchObject({ state: "pending" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/pay",
      paymentLease: "lease-1",
      paymentRef: REQUEST_ID,
      jobId: "revolut-payment",
    });
    expect(calls[0]?.body).toBe(buildPay({ ...leg, requestId: REQUEST_ID }).body);
  });

  it("never retries a write, whatever the answer", async () => {
    for (const reply of [
      status(500),
      status(502),
      status(503),
      status(429),
      status(409),
      status(400),
    ]) {
      const { c, calls } = client([reply, ok(PAY_PENDING)]);
      await expect(c.pay({ ...leg, requestId: REQUEST_ID }, CALL)).rejects.toBeInstanceOf(Error);
      expect(calls).toHaveLength(1);
    }
    const { c, calls } = client([new Error("boom"), ok(PAY_PENDING)]);
    await expect(c.pay({ ...leg, requestId: REQUEST_ID }, CALL)).rejects.toThrow("boom");
    expect(calls).toHaveLength(1);
  });

  it("refuses a write without the lease or ledger key before any call", async () => {
    const { c, calls } = client([ok(PAY_PENDING)]);
    await expect(
      c.pay({ ...leg, requestId: REQUEST_ID }, { lease: "", ledgerKey: "bad key" }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(c.pay({ ...leg, requestId: "x" }, CALL)).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("a 2xx with an unreadable body is an unreadable-answer error (status 200)", async () => {
    const { c } = client([ok("<html>")]);
    await expect(c.pay({ ...leg, requestId: REQUEST_ID }, CALL)).rejects.toMatchObject({
      status: 200,
    });
  });

  it("draft, bulk draft and counterparty go to their endpoints", async () => {
    const { c, calls } = client([ok(DRAFT_CREATED), ok(DRAFT_CREATED), ok(COUNTERPARTY_CREATED)]);
    expect(
      (await c.createPaymentDraft({ requestId: REQUEST_ID, payments: [leg] }, CALL)).id,
    ).toMatch(/^9c1d/);
    await c.createBulkDraft({ requestId: REQUEST_ID, payments: [leg, leg] }, CALL);
    await c.createCounterparty(
      { name: "Acme", iban: IBAN, currency: "EUR" },
      { lease: "l", ledgerKey: `cp-${REQUEST_ID}` },
    );
    expect(calls.map((x) => x.path)).toEqual([
      "/payment-drafts",
      "/payment-drafts",
      "/counterparty",
    ]);
    await expect(
      c.createPaymentDraft({ requestId: REQUEST_ID, payments: [leg, leg] }, CALL),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      c.createBulkDraft({ requestId: REQUEST_ID, payments: [leg] }, CALL),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("looks a payment up by request_id (read; 404 is null; reads may retry a 5xx)", async () => {
    const { c, calls } = client([ok(TRANSACTION), status(404, ERROR_BODY("not found"))]);
    const tx = await c.getTransactionByRequestId(REQUEST_ID);
    expect(tx?.requestId).toBe(REQUEST_ID);
    expect(tx?.legs[0]?.amountMinor).toBe(-123_450);
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: `/transaction/${REQUEST_ID}`,
      query: { id_type: "request_id" },
    });
    expect(await c.getTransactionByRequestId(REQUEST_ID)).toBeNull();
    const retry = client([status(500), ok(TRANSACTION)]);
    expect((await retry.c.getTransactionByRequestId(REQUEST_ID))?.state).toBe("completed");
    expect(retry.calls).toHaveLength(2);
  });

  it("drafts: get one and list (array or wrapped)", async () => {
    const { c } = client([
      ok(DRAFT_VIEW),
      ok(`[${DRAFT_VIEW}]`),
      ok(`{"payment_drafts":[${DRAFT_VIEW}]}`),
    ]);
    expect((await c.getPaymentDraft("d1")).id).toMatch(/^9c1d/);
    expect(await c.listPaymentDrafts()).toHaveLength(1);
    expect(await c.listPaymentDrafts()).toHaveLength(1);
  });
});

describe("classification of a failed write", () => {
  const api = (status: number, code?: string) => new RevolutApiError(status, "m", code);
  it("a local validation error is not executed only when the ledger proves no attempt (review P9b)", () => {
    expect(classifyPaymentFailure(new RangeError("x"), "never_attempted")).toEqual({
      kind: "not_executed",
      code: "invalid_request",
    });
    // a RangeError after the call was made says nothing about Revolut: unknown
    for (const l of ["attempted", "unreadable"] as const) {
      expect(classifyPaymentFailure(new RangeError("x"), l)).toEqual({
        kind: "unknown",
        code: "invalid_after_send",
      });
    }
  });
  it("the gate's ledger 'never attempted' proves not executed for ANY error", () => {
    for (const e of [
      api(503, "gate_unavailable"),
      api(500),
      new RevolutWriteAuthRetryRefused(),
      new Error("x"),
    ]) {
      expect(classifyPaymentFailure(e, "never_attempted").kind).toBe("not_executed");
    }
  });
  it("after an attempt: a 401 is unknown, never definite", () => {
    expect(classifyPaymentFailure(new RevolutWriteAuthRetryRefused(), "attempted")).toEqual({
      kind: "unknown",
      code: "auth_refused_after_send",
    });
    expect(classifyPaymentFailure(new RevolutAuthError("unauthorized"), "attempted").kind).toBe(
      "unknown",
    );
  });
  it("after an attempt: 409 is a duplicate request id, 4xx refusals are rejected", () => {
    expect(classifyPaymentFailure(api(409), "attempted")).toEqual({ kind: "duplicate_request_id" });
    for (const s of [400, 403, 404, 422]) {
      expect(classifyPaymentFailure(api(s, "x"), "attempted")).toEqual({
        kind: "rejected",
        code: "x",
      });
    }
    expect(classifyPaymentFailure(api(400), "attempted")).toEqual({
      kind: "rejected",
      code: "http_400",
    });
    // review P9b: a 429 after the call was made is settled by lookup, never assumed "not processed"
    expect(classifyPaymentFailure(new RevolutRateLimitedError(1000), "attempted")).toEqual({
      kind: "unknown",
      code: "rate_limited_after_send",
    });
    expect(classifyPaymentFailure(new RevolutRateLimitedError(1000), "never_attempted").kind).toBe(
      "not_executed",
    );
  });
  it("review P9b: a code that looks like an IBAN or account number is never kept", () => {
    for (const c of [
      "NL91ABNA0417164300",
      "nl91abna0417164300",
      "12345678",
      "x_DE89370400440532",
    ]) {
      expect(classifyPaymentFailure(api(400, c), "attempted")).toEqual({
        kind: "rejected",
        code: "http_400",
      });
    }
    expect(classifyPaymentFailure(api(400, "3000"), "attempted")).toEqual({
      kind: "rejected",
      code: "3000",
    });
  });
  it("after an attempt: 5xx, network, gate_unavailable, an unreadable 200, anything else is unknown", () => {
    for (const e of [
      api(500),
      api(502, "network"),
      api(503, "gate_unavailable"),
      api(200, "PAYMENT_ANSWER_UNREADABLE"),
      api(401),
      api(418),
      new Error("x"),
      "str",
    ]) {
      expect(classifyPaymentFailure(e, "attempted").kind).toBe("unknown");
      expect(classifyPaymentFailure(e, "unreadable").kind).toBe("unknown");
    }
  });
  it("a failure code is short, lower case and never a message", () => {
    const r = classifyPaymentFailure(
      api(400, "Some Bad Code With Spaces and a long message"),
      "attempted",
    );
    expect(r).toEqual({ kind: "rejected", code: "http_400" });
  });
});

describe("job class", () => {
  it("accepts revolut-payment and revolut-payment:<suffix> only", () => {
    expect(isPaymentJobId("revolut-payment")).toBe(true);
    expect(isPaymentJobId("revolut-payment:reconcile")).toBe(true);
    for (const bad of [
      "revolut-payments",
      "revolut-payment:",
      "x-revolut-payment",
      "revolut-payment:a b",
      "revolut-sync",
    ]) {
      expect(isPaymentJobId(bad)).toBe(false);
    }
  });
});
