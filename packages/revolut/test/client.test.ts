import { describe, expect, it } from "vitest";
import {
  RevolutApiError,
  RevolutAuthError,
  RevolutRateLimitedError,
  createRevolutClient,
  isFinalState,
  mapTransactionState,
  retryAfterMs,
  type ListTransactionsOptions,
  type RevolutRequest,
  type RevolutTransaction,
  type RevolutTransport,
  type TransactionChunk,
  type TransactionCursor,
} from "../src/index";
import { mapAccount, mapTransaction } from "../src/models";
import { parseJsonRawNumbers, minorOf } from "../src/json";
import {
  fakeTransactionsServer,
  micros,
  ok,
  scripted,
  status,
  type FakeServerOptions,
  type FakeTx,
} from "./helpers";

const base = { connectionId: 1, jobId: "job-1", priority: "job" as const };
const raw = (x: unknown): unknown => parseJsonRawNumbers(JSON.stringify(x));
const noSleep = async (): Promise<void> => undefined;

function client(transport: RevolutTransport, extra: Record<string, unknown> = {}) {
  return createRevolutClient(transport, { ...base, sleep: noSleep, ...extra });
}

describe("money conversion", () => {
  it.each([
    ["1234.56", "EUR", 123456],
    ["-10", "GBP", -1000],
    ["0.1", "USD", 10],
    ["0.07", "EUR", 7],
    ["1234", "JPY", 1234],
    ["-1234", "JPY", -1234],
    ["1.234", "KWD", 1234],
    ["-0.001", "BHD", -1],
    ["1e2", "EUR", 10000],
    ["1234.50", "EUR", 123450],
    ["1234.500000", "EUR", 123450],
    ["-0.00", "EUR", 0],
    ["-0", "EUR", 0],
    ["0", "EUR", 0],
    ["1.5E1", "EUR", 1500],
    ["150e-2", "EUR", 150],
    ["1E+3", "JPY", 1000],
    ["12000e-3", "JPY", 12],
    ["-90071992547409.91", "EUR", -9007199254740991],
    ["1.2345", "CLF", 12345],
    ["10", "XYZ", 1000], // unknown ISO code: scale 2, like core
  ])("%s %s -> %i minor units", (raw, cur, minor) => {
    expect(minorOf(raw, cur, "amount")).toBe(minor);
  });

  it("fails loudly on more decimals than the currency has (never rounds)", () => {
    for (const [raw, cur] of [
      ["2.675", "EUR"],
      ["0.005", "EUR"],
      ["1e-7", "EUR"],
      ["-0.001", "EUR"],
      ["1.5", "JPY"],
      ["1.2345", "KWD"],
      ["0.0000000001", "USD"],
    ] as const) {
      expect(() => minorOf(raw, cur, "amount"), `${raw} ${cur}`).toThrow(/Unexpected amount/);
    }
  });

  it("rejects out-of-range values and odd currencies", () => {
    for (const raw of [
      "90071992547409.92",
      "1e300",
      "1e99999",
      "",
      ".",
      "-",
      "e5",
      "1.2.3",
      "NaN",
      "Infinity",
      "0x10",
      "1_000",
    ]) {
      expect(() => minorOf(raw, "EUR", "amount"), raw).toThrow(RevolutApiError);
    }
    expect(() => minorOf("1", "EURO", "amount")).toThrow(RevolutApiError);
  });

  it("accepts amounts sent as JSON strings or numbers alike", () => {
    const parsed = parseJsonRawNumbers('{"a": -12.30, "b": "-12.30", "c": -1.23e1}') as Record<
      string,
      string
    >;
    expect(minorOf(parsed["a"] ?? "", "EUR", "a")).toBe(-1230);
    expect(minorOf(parsed["b"] ?? "", "EUR", "b")).toBe(-1230);
    expect(minorOf(parsed["c"] ?? "", "EUR", "c")).toBe(-1230);
  });

  it("rejects garbage without echoing it", () => {
    expect(() => minorOf("12,5", "EUR", "amount")).toThrow(RevolutApiError);
    expect(() => minorOf("12,5", "EUR", "amount")).not.toThrow(/12,5/);
  });

  it("never goes through a float: 9007199254740.99 EUR stays exact", () => {
    const parsed = parseJsonRawNumbers('{"balance": 9007199254740.99, "n": 0.1}') as Record<
      string,
      string
    >;
    expect(parsed["balance"]).toBe("9007199254740.99");
    expect(minorOf(parsed["balance"] ?? "", "EUR", "balance")).toBe(900719925474099);
  });
});

describe("json parsing", () => {
  it("leaves digits in strings alone and rejects bad numbers and bad JSON", () => {
    expect(parseJsonRawNumbers('{"a":"12.50","b":[1,-2.5e3]}')).toEqual({
      a: "12.50",
      b: ["1", "-2.5e3"],
    });
    expect(() => parseJsonRawNumbers('{"a":007}')).toThrow(/invalid JSON/);
    expect(() => parseJsonRawNumbers('{"a":"x')).toThrow(/invalid JSON/);
    expect(() => parseJsonRawNumbers("{a:1}")).toThrow(/invalid JSON/);
    try {
      parseJsonRawNumbers('{"iban":"NL91ABNA0417164300",');
    } catch (e) {
      expect(String(e)).not.toContain("NL91");
    }
  });
});

describe("states", () => {
  it("maps known states and never turns unknown ones into completed", () => {
    expect(mapTransactionState("pending")).toBe("pending");
    expect(mapTransactionState("Completed")).toBe("completed");
    expect(mapTransactionState("declined")).toBe("declined");
    expect(mapTransactionState("failed")).toBe("failed");
    expect(mapTransactionState("reverted")).toBe("reverted");
    expect(mapTransactionState("something_new")).toBe("unknown");
    expect(mapTransactionState(undefined)).toBe("unknown");
    expect(mapTransactionState(7)).toBe("unknown");
  });

  it("isFinalState is true for completed, failed, reverted, declined only", () => {
    expect(isFinalState("completed")).toBe(true);
    expect(isFinalState("failed")).toBe(true);
    expect(isFinalState("reverted")).toBe(true);
    expect(isFinalState("declined")).toBe(true);
    expect(isFinalState("pending")).toBe(false);
    expect(isFinalState("unknown")).toBe(false);
  });

  it("normalises case and surrounding whitespace only; lookalikes stay unknown and non-final", () => {
    expect(mapTransactionState(" COMPLETED\n")).toBe("completed");
    expect(mapTransactionState("\tReverted ")).toBe("reverted");
    for (const v of [
      "created",
      "cancelled",
      "complete",
      "completed\u200b",
      "com pleted",
      "",
      null,
      {},
      ["completed"],
      true,
    ]) {
      const st = mapTransactionState(v);
      expect(st, String(v)).toBe("unknown");
      expect(isFinalState(st)).toBe(false);
    }
  });

  it("never puts an IBAN or amount text into a mapping error", () => {
    const tx = {
      id: "t",
      created_at: "2024-05-01T00:00:00Z",
      legs: [
        {
          leg_id: "l",
          amount: "NL91ABNA0417164300",
          currency: "EUR",
          counterparty: { iban: "NL91ABNA0417164300" },
        },
      ],
    };
    const err = (() => {
      try {
        mapTransaction(raw(tx));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(RevolutApiError);
    expect(`${err?.message} ${err?.stack ?? ""}`).not.toMatch(/ABNA|0417164300/);
    const badIban = {
      ...tx,
      legs: [{ ...tx.legs[0], amount: 1, counterparty: { iban: ["NL91ABNA0417164300"] } }],
    };
    expect(() => mapTransaction(raw(badIban))).toThrow(/Unexpected type for iban/);
    expect(() => mapTransaction(raw(badIban))).not.toThrow(/ABNA/);
  });
});

describe("accounts and bank details", () => {
  it("lists accounts as minor units", async () => {
    const { transport, calls } = scripted([
      ok(
        `[{"id":"a1","name":"Main EUR","balance":1234.5,"currency":"EUR","state":"active","public":false,"created_at":"2020-01-01T00:00:00.000Z","updated_at":"2024-01-01T00:00:00.000Z"},
          {"id":"a2","name":"Yen","balance":-100,"currency":"JPY","state":"weird"},
          {"id":"a3","balance":0.5,"currency":"KWD","state":"inactive"}]`,
      ),
    ]);
    const accounts = await client(transport).listAccounts();
    expect(accounts[0]).toEqual({
      id: "a1",
      name: "Main EUR",
      balanceMinor: 123450,
      currency: "EUR",
      state: "active",
      public: false,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    expect(accounts[1]).toMatchObject({ balanceMinor: -100, currency: "JPY", state: "unknown" });
    expect(accounts[2]).toMatchObject({ balanceMinor: 500, name: "", state: "inactive" });
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/accounts",
      connectionId: 1,
      priority: "job",
      jobId: "job-1",
    });
    expect(calls[0]?.apiVersion).toBeUndefined();
  });

  it("rejects an account with a bad currency or amount", () => {
    expect(() => mapAccount({ id: "a", balance: "1", currency: "EURO" })).toThrow(RevolutApiError);
    expect(() => mapAccount({ id: "a", balance: "x", currency: "EUR" })).toThrow(RevolutApiError);
    expect(() => mapAccount({ id: "a", balance: "1", currency: "EUR", public: "yes" })).toThrow(
      RevolutApiError,
    );
    expect(() => mapAccount("nope")).toThrow(RevolutApiError);
  });

  it("reads bank details", async () => {
    const { transport, calls } = scripted([
      ok(
        `[{"iban":"LT123456789012345678","bic":"REVOLT21","beneficiary":"Camelthorn","bank_country":"LT","pooled":false,"unique_reference":"ref","schemes":["sepa","swift"]},
          {"account_no":"12345678","sort_code":"223344","routing_number":"021000021","schemes":"x"}]`.replace(
          '"schemes":"x"',
          '"schemes":[null,"fps"]',
        ),
      ),
    ]);
    const details = await client(transport).getAccountBankDetails("a/1");
    expect(calls[0]?.path).toBe("/accounts/a%2F1/bank-details");
    expect(details[0]).toMatchObject({
      iban: "LT123456789012345678",
      bic: "REVOLT21",
      beneficiary: "Camelthorn",
      bankCountry: "LT",
      pooled: false,
      uniqueReference: "ref",
      schemes: ["sepa", "swift"],
    });
    expect(details[1]).toMatchObject({
      accountNo: "12345678",
      sortCode: "223344",
      routingNumber: "021000021",
      schemes: ["fps"],
    });
  });

  it("requires an account id and a list", async () => {
    const c = client(scripted([ok('{"a":1}')]).transport);
    await expect(c.getAccountBankDetails("")).rejects.toThrow(RangeError);
    await expect(c.listAccounts()).rejects.toThrow(/Expected a list/);
  });
});

describe("transaction mapping", () => {
  const multiLeg = {
    id: "tx-1",
    type: "exchange",
    request_id: "req-1",
    state: "completed",
    reason_code: "none",
    created_at: "2024-03-01T10:00:00.123456Z",
    updated_at: "2024-03-01T10:00:01.000Z",
    completed_at: "2024-03-01T10:00:01.000Z",
    reference: "INV-2024-001",
    merchant: { name: "Shop", city: "Amsterdam", category_code: "5411", country: "NL" },
    card: { card_number: "123456******7890" },
    legs: [
      {
        leg_id: "leg-a",
        account_id: "acc-eur",
        amount: -100.5,
        fee: -0.25,
        currency: "EUR",
        bill_amount: -110,
        bill_currency: "USD",
        balance: 900.25,
        description: "Exchanged to USD",
        counterparty: { id: "cp-1", type: "self", account_id: "acc-usd" },
      },
      {
        leg_id: "leg-b",
        account_id: "acc-usd",
        amount: 110,
        currency: "USD",
        counterparty: { account_type: "external", name: "Acme BV", iban: "NL91ABNA0417164300" },
        card: { card_number: "123456******7890" },
      },
    ],
  };

  it("keeps every leg with its leg id and signed amounts", () => {
    const tx = mapTransaction(raw(multiLeg));
    expect(tx).toMatchObject({
      id: "tx-1",
      type: "exchange",
      requestId: "req-1",
      state: "completed",
      reasonCode: "none",
      createdAt: "2024-03-01T10:00:00.123456Z",
      reference: "INV-2024-001",
      merchant: { name: "Shop", city: "Amsterdam", categoryCode: "5411", country: "NL" },
      card: { last4: "7890" },
    });
    expect(tx.legs).toHaveLength(2);
    expect(tx.legs[0]).toMatchObject({
      legId: "leg-a",
      accountId: "acc-eur",
      amountMinor: -10050,
      feeMinor: -25,
      currency: "EUR",
      billAmountMinor: -11000,
      billCurrency: "USD",
      balanceMinor: 90025,
      counterparty: { id: "cp-1", accountType: "self", accountId: "acc-usd" },
    });
    expect(tx.legs[1]).toMatchObject({
      legId: "leg-b",
      amountMinor: 11000,
      counterparty: { accountType: "external", name: "Acme BV", iban: "NL91ABNA0417164300" },
      card: { last4: "7890" },
    });
    // The masked number itself is not kept anywhere in the mapped object.
    expect(JSON.stringify(tx)).not.toContain("******");
  });

  it("handles minimal rows, unknown state and empty card", () => {
    const tx = mapTransaction(
      raw({ id: "t", created_at: "2024-01-01T00:00:00Z", state: "mystery", card: {} }),
    );
    expect(tx).toEqual({
      id: "t",
      type: "unknown",
      state: "unknown",
      createdAt: "2024-01-01T00:00:00Z",
      legs: [],
      card: {},
    });
  });

  it("refuses duplicate leg ids and missing ids", () => {
    const leg = { leg_id: "x", amount: "1", currency: "EUR" };
    expect(() => mapTransaction({ id: "t", created_at: "c", legs: [leg, leg] })).toThrow(
      /Duplicate leg/,
    );
    expect(() => mapTransaction({ created_at: "c" })).toThrow(/Missing id/);
    expect(() =>
      mapTransaction({ id: "t", created_at: "c", legs: [{ amount: "1", currency: "EUR" }] }),
    ).toThrow(/Missing leg_id/);
    expect(() => mapTransaction({ id: "t", created_at: "c", legs: "no" })).toThrow(RevolutApiError);
  });

  it("getTransaction reads one transaction (by id or request id)", async () => {
    const body = JSON.stringify({
      id: "tx 1",
      created_at: "2024-01-01T00:00:00Z",
      state: "pending",
      legs: [],
    });
    const { transport, calls } = scripted([ok(body), ok(body)]);
    const c = client(transport);
    expect((await c.getTransaction("tx 1")).state).toBe("pending");
    await c.getTransaction("r-1", "request_id");
    expect(calls[0]).toMatchObject({ path: "/transaction/tx%201" });
    expect(calls[0]?.query).toBeUndefined();
    expect(calls[1]?.query).toEqual({ id_type: "request_id" });
    await expect(c.getTransaction("")).rejects.toThrow(RangeError);
  });
});

describe("errors, retries and redaction", () => {
  it("maps 401 to RevolutAuthError and 429 to RevolutRateLimitedError", async () => {
    await expect(
      client(scripted([status(401, "Bearer abc.def.ghi")]).transport).listAccounts(),
    ).rejects.toBeInstanceOf(RevolutAuthError);
    const r1 = await client(scripted([status(429, "", { "Retry-After": "7" })]).transport)
      .listAccounts()
      .catch((e: unknown) => e);
    expect(r1).toBeInstanceOf(RevolutRateLimitedError);
    expect((r1 as RevolutRateLimitedError).retryAfterMs).toBe(7000);
    const r2 = await client(scripted([status(429)]).transport, { now: () => 0 })
      .listAccounts()
      .catch((e: unknown) => e);
    expect((r2 as RevolutRateLimitedError).retryAfterMs).toBe(60_000);
    const r3 = await client(
      scripted([status(429, "", { "retry-after": "Thu, 01 Jan 1970 00:00:10 GMT" })]).transport,
      { now: () => 4000 },
    )
      .listAccounts()
      .catch((e: unknown) => e);
    expect((r3 as RevolutRateLimitedError).retryAfterMs).toBe(6000);
    const r4 = await client(scripted([status(429, "", { "Retry-After": "soon" })]).transport)
      .listAccounts()
      .catch((e: unknown) => e);
    expect((r4 as RevolutRateLimitedError).retryAfterMs).toBe(60_000);
  });

  it("passes gate errors through untouched and never retries them", async () => {
    const err = new RevolutRateLimitedError(5, "gate");
    const { transport, calls } = scripted([err, ok("[]")]);
    await expect(client(transport).listAccounts()).rejects.toBe(err);
    expect(calls).toHaveLength(1);
  });

  it("retries GET on 5xx twice with backoff, then fails", async () => {
    const sleeps: number[] = [];
    const { transport, calls } = scripted([status(502), status(503), ok("[]")]);
    const c = createRevolutClient(transport, {
      ...base,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(await c.listAccounts()).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 2000]);

    const s2 = scripted([status(500), status(500), status(500, '{"message":"boom","code":42}')]);
    const err = await client(s2.transport)
      .listAccounts()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevolutApiError);
    expect((err as RevolutApiError).status).toBe(500);
    expect((err as RevolutApiError).code).toBe("42");
    expect(s2.calls).toHaveLength(3);
  });

  it("never retries a POST or DELETE on 5xx", async () => {
    const s = scripted([status(500, "x"), ok("{}")]);
    await expect(
      client(s.transport).createWebhook("https://example.com/hook"),
    ).rejects.toBeInstanceOf(RevolutApiError);
    expect(s.calls).toHaveLength(1);
    const d = scripted([status(500), ok("")]);
    await expect(client(d.transport).deleteWebhook("w1")).rejects.toBeInstanceOf(RevolutApiError);
    expect(d.calls).toHaveLength(1);
  });

  it("redacts IBANs, tokens and secrets in error messages", async () => {
    const body = JSON.stringify({
      message:
        "Bad IBAN NL91ABNA0417164300 for Bearer abc.def-ghi token access_token=sekrit signing_secret: wsk_1234",
      code: "bad code!",
    });
    const err = (await client(scripted([status(400, body)]).transport)
      .listAccounts()
      .catch((e: unknown) => e)) as RevolutApiError;
    expect(err.message).toContain("NL91****4300");
    expect(err.message).not.toContain("ABNA0417164300");
    expect(err.message).not.toContain("abc.def-ghi");
    expect(err.message).not.toContain("sekrit");
    expect(err.message).not.toContain("wsk_1234");
    expect(err.code).toBeUndefined();
    const plain = (await client(
      scripted([status(400, "<html>NL91ABNA0417164300</html>")]).transport,
    )
      .listAccounts()
      .catch((e: unknown) => e)) as RevolutApiError;
    expect(plain.message).not.toContain("ABNA0417164300");
    const noMsg = (await client(scripted([status(400, "{}")]).transport)
      .listAccounts()
      .catch((e: unknown) => e)) as RevolutApiError;
    expect(noMsg.message).toContain("no message");
  });

  it("validates construction", () => {
    const t = scripted([]).transport;
    expect(() => createRevolutClient(t, { ...base, connectionId: 0 })).toThrow(RangeError);
    expect(() => createRevolutClient(t, { ...base, jobId: "" })).toThrow(RangeError);
    expect(() => createRevolutClient(t, { ...base, jobId: "bad id!" })).toThrow(RangeError);
    // default sleep/now are usable
    expect(createRevolutClient(t, base)).toBeDefined();
  });
});

describe("counterparties and webhooks", () => {
  it("lists counterparties", async () => {
    const { transport, calls } = scripted([
      ok(
        `[{"id":"c1","name":"Acme","profile_type":"business","country":"NL","state":"created","created_at":"2024-01-01T00:00:00.000Z","updated_at":"2024-01-02T00:00:00.000Z",
           "accounts":[{"id":"ca1","currency":"EUR","type":"external","iban":"NL91ABNA0417164300","bic":"ABNANL2A","account_no":"1","sort_code":"2"}]},
          {"id":"c2"}]`,
      ),
    ]);
    const list = await client(transport).listCounterparties();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      id: "c1",
      name: "Acme",
      profileType: "business",
      country: "NL",
      state: "created",
      accounts: [
        {
          id: "ca1",
          currency: "EUR",
          type: "external",
          iban: "NL91ABNA0417164300",
          bic: "ABNANL2A",
          accountNo: "1",
          sortCode: "2",
        },
      ],
    });
    expect(list[1]).toEqual({ id: "c2", accounts: [] });
    expect(calls[0]?.query).toEqual({ count: "1000" });
  });

  it("pages counterparties with created_before and de-duplicates ties", async () => {
    const page = (ids: string[], at: string) =>
      JSON.stringify(ids.map((id) => ({ id, created_at: at, accounts: [] })));
    const first = Array.from({ length: 1000 }, (_, i) => `c${i}`);
    const { transport, calls } = scripted([
      ok(page(first, "2024-01-01T00:00:00.500Z")),
      ok(page(["c999", "late"], "2024-01-01T00:00:00.400Z")),
    ]);
    const list = await client(transport).listCounterparties();
    expect(list).toHaveLength(1001);
    expect(calls[1]?.query?.["created_before"]).toBe("2024-01-01T00:00:00.501Z");
  });

  it("fails loudly when counterparty paging cannot advance or lacks created_at", async () => {
    const full = (ids: string[], at?: string) =>
      JSON.stringify(ids.map((id) => (at ? { id, created_at: at } : { id })));
    const ids = Array.from({ length: 1000 }, (_, i) => `c${i}`);
    await expect(
      client(
        scripted([ok(full(ids, "2024-01-01T00:00:00Z")), ok(full(ids, "2024-01-01T00:00:00Z"))])
          .transport,
      ).listCounterparties(),
    ).rejects.toMatchObject({ code: "PAGING_STUCK" });
    await expect(
      client(scripted([ok(full(ids))]).transport).listCounterparties(),
    ).rejects.toMatchObject({ code: "PAGING_STUCK" });
  });

  it("stops counterparty paging at the page limit", async () => {
    let n = 0;
    const transport: RevolutTransport = async () => {
      const ids = Array.from({ length: 1000 }, (_, i) => `p${n}-${i}`);
      n++;
      return ok(JSON.stringify(ids.map((id) => ({ id, created_at: "2024-01-01T00:00:00Z" }))));
    };
    await expect(client(transport).listCounterparties()).rejects.toMatchObject({
      code: "PAGING_LIMIT",
    });
  });

  it("uses API 2.0 for webhooks and returns the signing secret only to the caller", async () => {
    const { transport, calls } = scripted([
      ok('[{"id":"w1","url":"https://x.example/hook","events":["TransactionCreated"]}]'),
      ok('{"webhooks":[{"id":"w2","url":"https://x.example/h2","events":[]}]}'),
      ok(
        '{"id":"w3","url":"https://x.example/h3","events":["TransactionCreated","TransactionStateChanged"],"signing_secret":"wsk_abc"}',
      ),
      status(204),
    ]);
    const c = client(transport);
    expect(await c.listWebhooks()).toEqual([
      { id: "w1", url: "https://x.example/hook", events: ["TransactionCreated"] },
    ]);
    expect((await c.listWebhooks())[0]?.id).toBe("w2");
    const created = await c.createWebhook("https://x.example/h3");
    expect(created.signingSecret).toBe("wsk_abc");
    await c.deleteWebhook("w3");
    expect(calls.map((r: RevolutRequest) => [r.method, r.path, r.apiVersion])).toEqual([
      ["GET", "/webhooks", "2.0"],
      ["GET", "/webhooks", "2.0"],
      ["POST", "/webhooks", "2.0"],
      ["DELETE", "/webhooks/w3", "2.0"],
    ]);
    expect(JSON.parse(calls[2]?.body ?? "")).toEqual({
      url: "https://x.example/h3",
      events: ["TransactionCreated", "TransactionStateChanged"],
    });
    expect(calls[2]?.headers?.["Content-Type"]).toBe("application/json");
  });

  it("validates webhook inputs and requires the signing secret", async () => {
    const c = client(scripted([ok('{"id":"w","url":"https://a.b/c","events":[]}')]).transport);
    await expect(c.createWebhook("http://a.b/c")).rejects.toThrow(RangeError);
    await expect(c.createWebhook("https://a.b/c", [])).rejects.toThrow(RangeError);
    await expect(c.deleteWebhook("")).rejects.toThrow(RangeError);
    await expect(c.createWebhook("https://a.b/c")).rejects.toThrow(/unusable webhook response/);
  });

  it("never puts the signing secret into an error", async () => {
    const err = (await client(
      scripted([status(400, '{"message":"x","signing_secret":"wsk_topsecret"}')]).transport,
    )
      .createWebhook("https://a.b/c")
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("wsk_topsecret");
    // A 2xx body we cannot use (bad JSON, missing id, wrong types) never surfaces either.
    for (const body of [
      '{"signing_secret":"wsk_topsecret"',
      '{"signing_secret":"wsk_topsecret"}',
      '{"id":"w","url":"https://a.b/c","signing_secret":["wsk_topsecret"]}',
      '{"id":"w","url":7,"signing_secret":"wsk_topsecret"}',
      "wsk_topsecret",
    ]) {
      const e = (await client(scripted([ok(body)]).transport)
        .createWebhook("https://a.b/c")
        .catch((x: unknown) => x)) as Error;
      expect(e).toBeInstanceOf(RevolutApiError);
      expect(`${e.message} ${e.stack ?? ""}`).not.toContain("wsk_topsecret");
    }
    // Nor does a non-JSON error body.
    const raw = (await client(scripted([status(500, "secret wsk_topsecret here")]).transport)
      .createWebhook("https://a.b/c")
      .catch((x: unknown) => x)) as Error;
    expect(raw.message).not.toContain("wsk_topsecret");
  });
});

describe("transactions paging", () => {
  const T = "2024-05-01T10:00:00.";
  const mk = (i: number, ts: string): FakeTx => ({
    id: `t${String(i).padStart(3, "0")}`,
    createdAt: ts,
  });

  async function collect(data: FakeTx[], count: number, extra: Record<string, string> = {}) {
    const srv = fakeTransactionsServer(data);
    const c = client(srv.transport);
    const out: string[] = [];
    let chunks = 0;
    for await (const chunk of c.transactionChunks({ count, ...extra })) {
      chunks++;
      out.push(...chunk.map((t) => t.id));
    }
    return { out, chunks, calls: srv.calls };
  }

  it("returns everything exactly once when many rows share a created_at at chunk boundaries", async () => {
    const data: FakeTx[] = [
      mk(0, `${T}900Z`),
      ...Array.from({ length: 7 }, (_, i) => mk(1 + i, `${T}500Z`)), // 7 ties
      mk(8, `${T}100Z`),
      mk(9, `${T}100Z`),
    ];
    for (const count of [1, 2, 3, 4, 5, 7, 10, 100]) {
      const { out } = await collect(data, count);
      expect([...out].sort(), `count=${count}`).toEqual(data.map((d) => d.id).sort());
      expect(new Set(out).size).toBe(out.length);
    }
  });

  it("is newest first within and across chunks", async () => {
    const data = Array.from({ length: 9 }, (_, i) => mk(i, `${T}${String(100 + i * 10)}Z`));
    const { out } = await collect(data, 4);
    expect(out).toEqual([...data].reverse().map((d) => d.id));
  });

  it("handles sub-millisecond timestamps without losing rows at the boundary", async () => {
    const data: FakeTx[] = [
      mk(0, `${T}222900Z`),
      mk(1, `${T}222456Z`),
      mk(2, `${T}222456Z`),
      mk(3, `${T}222123Z`),
      mk(4, `${T}221999Z`),
      mk(5, `${T}221000Z`),
    ];
    for (const count of [1, 2, 3, 5]) {
      const { out } = await collect(data, count);
      expect([...out].sort(), `count=${count}`).toEqual(data.map((d) => d.id).sort());
      expect(new Set(out).size).toBe(out.length);
    }
  });

  it("is complete in a randomised walk with heavy ties", async () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 25; round++) {
      const n = 1 + rnd(60);
      const data = Array.from({ length: n }, (_, i) => {
        const ms = 100 + rnd(4);
        const micro = rnd(3) * 7;
        return mk(i, `${T}${ms}${String(micro).padStart(3, "0")}Z`);
      });
      const count = 1 + rnd(12);
      const { out } = await collect(data, count);
      expect([...out].sort(), `round=${round} n=${n} count=${count}`).toEqual(
        data.map((d) => d.id).sort(),
      );
      expect(new Set(out).size).toBe(out.length);
    }
  });

  it("passes filters through and stops when a chunk is short", async () => {
    const data = [mk(0, `${T}100Z`), mk(1, `${T}200Z`)];
    const srv = fakeTransactionsServer(data);
    const c = client(srv.transport);
    const chunk = await c.listTransactionsChunk({
      count: 10,
      from: "2024-05-01T00:00:00.000Z",
      to: "2024-05-02T00:00:00.000Z",
      accountId: "acc-1",
      type: "card_payment",
      trustShortPage: true,
    });
    expect(chunk.nextCursor).toBeNull();
    expect(chunk.transactions.map((t) => t.id)).toEqual(["t001", "t000"]);
    expect(srv.calls[0]?.query).toEqual({
      count: "10",
      from: "2024-05-01T00:00:00.000Z",
      to: "2024-05-02T00:00:00.000Z",
      account: "acc-1",
      type: "card_payment",
    });
  });

  it("returns an empty, finished walk for no rows", async () => {
    const { out, chunks } = await collect([], 5);
    expect(out).toEqual([]);
    expect(chunks).toBe(0);
  });

  it("asks for extra rows to cover the ties it has already seen", async () => {
    const data = Array.from({ length: 6 }, (_, i) => mk(i, `${T}500Z`));
    const { calls } = await collect(data, 2);
    expect(calls.map((c) => c.query?.["count"])).toEqual(["2", "4", "6", "8"]);
    // each subsequent call carries a `to` that includes the boundary millisecond
    // (one millisecond past it, so an exclusive `to` would be complete too)
    expect(calls[1]?.query?.["to"]).toBe("2024-05-01T10:00:00.501Z");
  });

  it("throws PAGING_STUCK instead of skipping rows when 1000+ rows share one millisecond", async () => {
    const data = Array.from({ length: 1200 }, (_, i) => mk(i, `${T}500Z`));
    const srv = fakeTransactionsServer(data);
    const c = client(srv.transport);
    const err = await (async () => {
      for await (const chunk of c.transactionChunks({ count: 400 })) void chunk;
    })().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PAGING_STUCK" });
  });

  it("ignores rows outside the requested window and duplicate ids inside a response", async () => {
    const row = (id: string, at: string) => ({
      id,
      type: "transfer",
      state: "completed",
      created_at: at,
      legs: [],
    });
    const { transport } = scripted([
      ok(
        JSON.stringify([
          row("future", "2024-05-02T00:00:00.000Z"),
          row("a", "2024-05-01T10:00:00.500Z"),
          row("a", "2024-05-01T10:00:00.500Z"),
        ]),
      ),
    ]);
    const chunk = await client(transport).listTransactionsChunk({
      count: 10,
      to: "2024-05-01T12:00:00.000Z",
    });
    expect(chunk.transactions.map((t) => t.id)).toEqual(["a"]);
  });

  it("validates its inputs", async () => {
    const c = client(scripted([]).transport);
    await expect(c.listTransactionsChunk({ count: 0 })).rejects.toThrow(RangeError);
    await expect(c.listTransactionsChunk({ count: 1001 })).rejects.toThrow(RangeError);
    await expect(c.listTransactionsChunk({ count: 1.5 })).rejects.toThrow(RangeError);
    await expect(c.listTransactionsChunk({ count: 5, from: "yesterday" })).rejects.toThrow(
      RangeError,
    );
    await expect(c.listTransactionsChunk({ count: 5, to: "tomorrow" })).rejects.toThrow(RangeError);
  });

  it("rejects malformed timestamps from the API and stops at the chunk limit", async () => {
    // A row with an unusable timestamp is rejected on its own (review S2), the walk goes on.
    const bad = scripted([ok(JSON.stringify([{ id: "a", created_at: "01/05/2024", legs: [] }]))]);
    expect(await client(bad.transport).listTransactionsChunk({ count: 5 })).toEqual({
      transactions: [],
      rejected: [{ id: "a", code: "bad_timestamp" }],
      nextCursor: null,
    });
    const impossible = scripted([
      ok(JSON.stringify([{ id: "a", created_at: "2024-13-45T10:00:00Z", legs: [] }])),
    ]);
    expect(
      (await client(impossible.transport).listTransactionsChunk({ count: 5 })).rejected,
    ).toEqual([{ id: "a", code: "bad_timestamp" }]);

    // A server that always returns one fresh older row per call and a full page.
    let n = 0;
    const transport: RevolutTransport = async (req) => {
      const rows = Array.from({ length: Number(req.query?.["count"]) }, () => {
        n++;
        return {
          id: `x${n}`,
          created_at: new Date(Date.UTC(2024, 0, 1) - n * 1000).toISOString(),
          legs: [],
        };
      });
      return ok(JSON.stringify(rows));
    };
    const walk = async () => {
      for await (const chunk of client(transport).transactionChunks({ count: 1 }, 3)) void chunk;
    };
    await expect(walk()).rejects.toMatchObject({ code: "PAGING_LIMIT" });
  });
});

describe("transactions paging under adversarial servers", () => {
  const T = "2024-05-01T10:00:00.";
  let seed = 987;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const randomData = (n: number): FakeTx[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${String(i).padStart(4, "0")}`,
      createdAt: `${T}${100 + rnd(5)}${String(rnd(3) * 333).padStart(3, "0")}Z`,
    }));

  async function walk(
    data: FakeTx[],
    count: number,
    server: FakeServerOptions = {},
    extra: Partial<ListTransactionsOptions> = {},
  ) {
    const srv = fakeTransactionsServer(data, server);
    const out: RevolutTransaction[] = [];
    for await (const chunk of client(srv.transport).transactionChunks({ count, ...extra })) {
      out.push(...chunk);
    }
    return { ids: out.map((t) => t.id), txs: out, calls: srv.calls };
  }
  const sorted = (d: FakeTx[]) => d.map((x) => x.id).sort();

  it("is complete whether `to` is inclusive or exclusive", async () => {
    for (let round = 0; round < 20; round++) {
      const data = randomData(1 + rnd(50));
      const count = 1 + rnd(8);
      for (const exclusiveTo of [false, true]) {
        const { ids } = await walk(data, count, { exclusiveTo });
        expect([...ids].sort(), `round ${round} exclusive=${exclusiveTo}`).toEqual(sorted(data));
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("is complete when the server caps count lower or returns short pages early", async () => {
    for (let round = 0; round < 20; round++) {
      const data = randomData(5 + rnd(50));
      const count = 2 + rnd(8);
      // A cap works as long as it is larger than the rows sharing one boundary (here at most 2).
      const spaced = Array.from({ length: 5 + rnd(50) }, (_, i) => ({
        id: `p${String(i).padStart(3, "0")}`,
        createdAt: new Date(Date.UTC(2024, 4, 1) + Math.floor(i / 2) * 7).toISOString(),
      }));
      const capped = await walk(spaced, count + 3, { maxCount: count + 2 });
      expect([...capped.ids].sort(), `cap round ${round}`).toEqual(sorted(spaced));
      const early = await walk(data, count, { randomShort: () => rnd(count) });
      expect([...early.ids].sort(), `short round ${round}`).toEqual(sorted(data));
    }
    // With trustShortPage the first capped page would end the walk: that is why it is opt-in.
    const data = randomData(30);
    const trusting = await walk(data, 10, { maxCount: 5 }, { trustShortPage: true });
    expect(trusting.ids.length).toBeLessThan(30);
  });

  it("costs one confirming call at the end by default", async () => {
    const data = randomData(3);
    expect((await walk(data, 10)).calls).toHaveLength(2);
    expect((await walk(data, 10, {}, { trustShortPage: true })).calls).toHaveLength(1);
  });

  it("keeps the cursor small: only ids at the boundary are carried", async () => {
    const data = Array.from({ length: 50 }, (_, i) => ({
      id: `s${i}`,
      createdAt: new Date(Date.UTC(2024, 4, 1) + i * 10).toISOString(),
    }));
    const srv = fakeTransactionsServer(data);
    const c = client(srv.transport);
    let cursor: TransactionCursor | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const chunk: TransactionChunk = await c.listTransactionsChunk({ count: 5, cursor });
      ids.push(...chunk.transactions.map((t) => t.id));
      if (chunk.nextCursor === null) break;
      expect(chunk.nextCursor.seen.length).toBeLessThanOrEqual(1);
      cursor = chunk.nextCursor;
    }
    expect(ids).toHaveLength(50);
    // and the cursor survives a JSON round trip (queue message)
    expect(JSON.parse(JSON.stringify(cursor))).toEqual(cursor);
  });

  it("never widens the window above the caller's `to`", async () => {
    const data: FakeTx[] = [
      { id: "above", createdAt: `${T}500900Z` },
      { id: "a", createdAt: `${T}500300Z` },
      { id: "b", createdAt: `${T}500300Z` },
      { id: "c", createdAt: `${T}500100Z` },
    ];
    const { ids, calls } = await walk(data, 1, {}, { to: `${T}500500Z` });
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
    for (const call of calls) {
      expect(micros(call.query?.["to"] ?? "")).toBeLessThanOrEqual(micros(`${T}500500Z`));
    }
  });

  it("supports from without to and date-only bounds", async () => {
    const data: FakeTx[] = [
      { id: "new", createdAt: "2024-05-02T00:00:00.000Z" },
      { id: "mid", createdAt: "2024-05-01T12:00:00.000Z" },
      { id: "old", createdAt: "2024-04-30T23:59:59.999Z" },
    ];
    const { ids, calls } = await walk(data, 10, {}, { from: "2024-05-01T00:00:00Z" });
    expect(ids).toEqual(["new", "mid"]);
    expect(calls[0]?.query?.["to"]).toBeUndefined();
    const c = client(fakeTransactionsServer(data).transport);
    const chunk = await c.listTransactionsChunk({
      count: 10,
      from: "2024-05-01",
      to: "2024-05-02",
      trustShortPage: true,
    });
    expect(chunk.transactions.map((t) => t.id)).toEqual(["new", "mid"]);
    await expect(
      c.listTransactionsChunk({ count: 1, from: "2024-05-02", to: "2024-05-01" }),
    ).rejects.toThrow(/from must not be after to/);
    for (const bad of ["2024-05-01T10:00:00", "March 7", "2024-5-1", "1714557600000"]) {
      await expect(c.listTransactionsChunk({ count: 1, from: bad }), bad).rejects.toThrow(
        RangeError,
      );
    }
  });

  it("fails loudly on a page that is not newest first", async () => {
    const row = (id: string, at: string) => ({ id, state: "completed", created_at: at, legs: [] });
    const { transport } = scripted([
      ok(JSON.stringify([row("old", `${T}100Z`), row("new", `${T}200Z`)])),
    ]);
    await expect(client(transport).listTransactionsChunk({ count: 5 })).rejects.toMatchObject({
      code: "PAGING_ORDER",
    });
  });

  it("keeps the later updated_at when a response repeats an id, and never yields an id twice", async () => {
    const row = (state: string, updated: string) => ({
      id: "dup",
      state,
      created_at: `${T}100Z`,
      updated_at: updated,
      legs: [],
    });
    const { transport } = scripted([
      ok(
        JSON.stringify([
          row("pending", "2024-05-01T10:00:01Z"),
          row("completed", "2024-05-01T10:05:00Z"),
          row("pending", "2024-05-01T10:00:02Z"),
        ]),
      ),
    ]);
    const chunk = await client(transport).listTransactionsChunk({ count: 5, trustShortPage: true });
    expect(chunk.transactions.map((t) => t.state)).toEqual(["completed"]);

    // A row seen in chunk 1 that changes state before chunk 2 is not yielded again (documented:
    // consumers upsert by updated_at and the webhook / next run carry the change).
    const data: FakeTx[] = [
      { id: "x1", createdAt: `${T}300Z` },
      { id: "x2", createdAt: `${T}200Z`, state: "pending" },
      { id: "x3", createdAt: `${T}200Z` },
      { id: "x4", createdAt: `${T}100Z` },
    ];
    const res = await walk(data, 2, {
      mutate: (call, d) => {
        const x2 = d.find((t) => t.id === "x2");
        if (call === 2 && x2 !== undefined) {
          x2.state = "completed";
          x2.updatedAt = "2024-05-01T11:00:00.000Z";
        }
      },
    });
    expect([...res.ids].sort()).toEqual(["x1", "x2", "x3", "x4"]);
  });

  it("validates cursors and maxChunks", async () => {
    const c = client(scripted([]).transport);
    for (const cursor of [
      { toIso: "nope", seen: [] },
      { toIso: "2024-05-01T00:00:00Z", seen: [{ id: "", ms: 1 }] },
      { toIso: "2024-05-01T00:00:00Z", seen: [{ id: "a", ms: 1.5 }] },
      { toIso: "2024-05-01T00:00:00Z", seen: "x" },
      {
        toIso: "2024-05-01T00:00:00Z",
        seen: Array.from({ length: 2001 }, (_, i) => ({ id: `i${i}`, ms: 1 })),
      },
    ]) {
      await expect(
        c.listTransactionsChunk({ count: 1, cursor: cursor as unknown as TransactionCursor }),
      ).rejects.toThrow(/cursor/);
    }
    for (const maxChunks of [0, -1, 1.5, 100_001]) {
      const gen = c.transactionChunks({ count: 1 }, maxChunks);
      await expect(gen.next()).rejects.toThrow(/maxChunks/);
    }
  });

  it("throws PAGING_STUCK rather than skipping when the boundary holds more than a call", async () => {
    // 1001 rows in two adjacent milliseconds: a full page of repeats eventually.
    const data = Array.from({ length: 1001 }, (_, i) => ({
      id: `z${i}`,
      createdAt: i % 2 === 0 ? `${T}500Z` : `${T}501Z`,
    }));
    const err = await walk(data, 1000).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PAGING_STUCK" });
  });
});

describe("Retry-After parsing", () => {
  it.each([
    ["7", 7000],
    ["0", 0],
    ["  12 ", 12_000],
    ["99999999", 900_000],
    ["99999999999999999999", 900_000],
    ["-5", 60_000],
    ["1.5", 60_000],
    ["soon", 60_000],
    ["", 60_000],
    ["2024-05-01T00:00:10Z", 60_000],
    ["Thu, 01 Jan 1970 00:00:10 GMT", 6000],
    ["Thu, 01 Jan 1970 00:00:01 GMT", 0],
    ["Fri, 01 Jan 2100 00:00:00 GMT", 900_000],
  ])("%j -> %i ms", (value, ms) => {
    expect(retryAfterMs({ "Retry-After": value }, 4000)).toBe(ms);
  });

  it("defaults when absent and finds the header in any case", () => {
    expect(retryAfterMs({}, 0)).toBe(60_000);
    expect(retryAfterMs({ "RETRY-AFTER": "3" }, 0)).toBe(3000);
  });

  it("does not retry 429 inside the client, even for GET", async () => {
    const s = scripted([status(429, "", { "Retry-After": "1" }), ok("[]")]);
    await expect(client(s.transport).listAccounts()).rejects.toBeInstanceOf(
      RevolutRateLimitedError,
    );
    expect(s.calls).toHaveLength(1);
  });

  it("does not retry 4xx and passes transport errors through on retries too", async () => {
    const s = scripted([status(404, '{"message":"not found"}'), ok("[]")]);
    await expect(client(s.transport).listAccounts()).rejects.toMatchObject({ status: 404 });
    expect(s.calls).toHaveLength(1);
    const boom = new Error("gate down");
    const t = scripted([status(502), boom]);
    await expect(client(t.transport).listAccounts()).rejects.toBe(boom);
    expect(t.calls).toHaveLength(2);
  });
});
