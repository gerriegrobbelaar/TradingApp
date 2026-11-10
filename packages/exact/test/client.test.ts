import { describe, expect, it, vi } from "vitest";
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  createExactClient,
  resolveNextLink,
} from "../src";
import * as fx from "./fixtures";
import { ok, scripted, status } from "./helpers";

const base = { division: fx.DIV, jobId: "job-1", priority: "job" as const };
const noSleep = (ms: number) => {
  void ms;
  return Promise.resolve();
};

describe("passthrough to the transport", () => {
  it("sends division, priority, jobId, api and $select on every REST call", async () => {
    const { transport, calls } = scripted([
      ok(fx.ME),
      ok(fx.DIVISIONS),
      ok(fx.ACCOUNTS),
      ok(fx.BANK_ACCOUNTS),
      ok(fx.receivablesPage1().replace(/,"__next".*$/, "}}")),
      ok(fx.PAYABLES),
      ok(fx.SYNC_ACCOUNTS),
      ok(fx.EMPTY),
      ok(fx.EMPTY),
      ok(fx.GL_BALANCES),
    ]);
    const c = createExactClient(transport, { ...base, priority: "user" });
    await c.currentMe();
    await c.listDivisions();
    await c.listAccounts();
    await c.listBankAccounts();
    await c.listReceivables();
    await c.listPayables();
    await c.syncAccounts("0");
    await c.syncReceivables("0");
    await c.syncPayables("0");
    await c.listGlBalances({ year: 2025, currency: "EUR" });
    expect(calls).toHaveLength(10);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.api).toBe("rest");
      expect(call.priority).toBe("user");
      expect(call.jobId).toBe("job-1");
      expect(call.path.startsWith("/")).toBe(true);
      expect(call.path).not.toContain("/api/v1");
      expect(call.query?.["$select"]).toMatch(/^[A-Za-z,]+$/);
    }
    expect(calls[0]?.path).toBe("/current/Me");
    expect(calls[0]?.division).toBe(0);
    expect(calls.slice(1).every((x) => x.division === fx.DIV)).toBe(true);
  });
});

describe("currentMe and divisions", () => {
  it("maps Me", async () => {
    const { transport } = scripted([ok(fx.ME)]);
    const me = await createExactClient(transport, base).currentMe();
    expect(me).toEqual({
      userId: "11111111-2222-3333-4444-555555555555",
      userName: "gerrie",
      fullName: "Test User",
      email: "test@example.com",
      currentDivision: fx.DIV,
    });
  });

  it("rejects an empty or incomplete Me", async () => {
    await expect(
      createExactClient(scripted([ok(fx.EMPTY)]).transport, base).currentMe(),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
    const noDiv = `{"d":{"results":[{"UserID":"u"}]}}`;
    await expect(
      createExactClient(scripted([ok(noDiv)]).transport, base).currentMe(),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
  });

  it("lists divisions", async () => {
    const { transport, calls } = scripted([ok(fx.DIVISIONS)]);
    const d = await createExactClient(transport, base).listDivisions();
    expect(calls[0]?.path).toBe("/system/Divisions");
    expect(d).toEqual([
      {
        code: fx.DIV,
        description: "Camelthorn Advisory B.V.",
        country: "NL",
        status: 1,
        main: true,
      },
      { code: 7654321, description: "Second BV", country: "NL", status: 1, main: false },
    ]);
  });

  it("rejects a division without Code", async () => {
    const { transport } = scripted([ok(`{"d":{"results":[{"Description":"x"}]}}`)]);
    await expect(createExactClient(transport, base).listDivisions()).rejects.toMatchObject({
      code: "BAD_SHAPE",
    });
  });
});

describe("open items", () => {
  it("follows __next, converts money and dates, and keeps $select", async () => {
    const { transport, calls } = scripted([ok(fx.receivablesPage1()), ok(fx.RECEIVABLES_PAGE2)]);
    const items = await createExactClient(transport, base).listReceivables();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toBe("/read/financial/ReceivablesList");
    expect(calls[1]?.query?.["$skiptoken"]).toBe("guid'99999999-0000-0000-0000-000000000000'");
    expect(calls[1]?.query?.["$select"]).toBe("ID,AccountId");
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      kind: "receivable",
      accountCode: "1001",
      invoiceNumber: 20240001,
      amount: { minor: 123450, currency: "EUR" },
      dueDate: "2023-11-14T22:13:20.000Z",
      timestamp: null,
    });
    expect(items[1]).toMatchObject({
      amount: { minor: -9999, currency: "USD" },
      dueDate: null,
      description: null,
      invoiceNumber: null,
    });
    expect(items[2]?.amount.minor).toBe(0);
  });

  it("reads payables", async () => {
    const { transport, calls } = scripted([ok(fx.PAYABLES)]);
    const items = await createExactClient(transport, base).listPayables();
    expect(calls[0]?.path).toBe("/read/financial/PayablesList");
    expect(items[0]).toMatchObject({ kind: "payable", amount: { minor: 123456789 } });
  });

  it("rejects amounts beyond the safe range, missing currency and bad currency", async () => {
    const huge = fx.PAYABLES.replace("1234567.89", "900071992547409.91");
    await expect(
      createExactClient(scripted([ok(huge)]).transport, base).listPayables(),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
    const noCur = fx.PAYABLES.replace('"CurrencyCode":"EUR"', '"CurrencyCode":null');
    await expect(
      createExactClient(scripted([ok(noCur)]).transport, base).listPayables(),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
    const badCur = fx.PAYABLES.replace('"CurrencyCode":"EUR"', '"CurrencyCode":"EURO"');
    await expect(
      createExactClient(scripted([ok(badCur)]).transport, base).listPayables(),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
  });

  it("rejects invalid JSON and odd envelopes", async () => {
    await expect(
      createExactClient(scripted([ok("<html>")]).transport, base).listPayables(),
    ).rejects.toMatchObject({ code: "BAD_JSON" });
    await expect(
      createExactClient(scripted([ok(`{"d":{"nope":1}}`)]).transport, base).listPayables(),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
    await expect(
      createExactClient(scripted([ok(`{"d":{"results":[1]}}`)]).transport, base).listPayables(),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
  });

  it("accepts a bare array in d", async () => {
    const { transport } = scripted([ok(`{"d":[]}`)]);
    expect(await createExactClient(transport, base).listPayables()).toEqual([]);
  });
});

describe("paging guards", () => {
  const exp = { host: fx.HOST, division: fx.DIV, path: "/crm/Accounts", select: "ID" };
  const good = `https://${fx.HOST}/api/v1/${fx.DIV}/crm/Accounts?$select=ID&$skiptoken=guid'abc'`;

  it("accepts a same-host, same-division, same-endpoint link", () => {
    expect(resolveNextLink(good, exp)).toEqual({
      path: "/crm/Accounts",
      query: { $select: "ID", $skiptoken: "guid'abc'" },
    });
  });

  it("adds $select when the link drops it", () => {
    const r = resolveNextLink(`https://${fx.HOST}/api/v1/${fx.DIV}/crm/Accounts?$skiptoken=1`, exp);
    expect(r.query["$select"]).toBe("ID");
  });

  it.each([
    ["different host", good.replace(fx.HOST, "evil.example")],
    ["lookalike host", good.replace(fx.HOST, `${fx.HOST}.evil.example`)],
    ["userinfo trick", good.replace("https://", `https://${fx.HOST}@evil.example/#`)],
    ["http", good.replace("https:", "http:")],
    ["credentials", good.replace("https://", "https://u:p@")],
    ["port", good.replace(fx.HOST, `${fx.HOST}:8443`)],
    ["other division", good.replace(String(fx.DIV), "999")],
    ["other endpoint", good.replace("/crm/Accounts", "/crm/Contacts")],
    ["relative", "/api/v1/1/crm/Accounts"],
    ["duplicate key", `${good}&$select=Name`],
    ["not a url", "::::"],
  ])("rejects %s", (_n, link) => {
    expect(() => resolveNextLink(link, exp)).toThrow(ExactApiError);
    try {
      resolveNextLink(link, exp);
    } catch (e) {
      expect((e as ExactApiError).code).toBe("BAD_NEXT_LINK");
    }
  });

  it("is case-insensitive on the host", () => {
    expect(() => resolveNextLink(good.replace(fx.HOST, fx.HOST.toUpperCase()), exp)).not.toThrow();
  });

  it("uses the 'current' segment for division 0", () => {
    const r = resolveNextLink(`https://${fx.HOST}/api/v1/current/Me?$skiptoken=1`, {
      ...exp,
      division: 0,
      path: "/Me",
    });
    expect(r.path).toBe("/Me");
  });

  it("stops following a hostile link inside a read, without calling the transport again", async () => {
    const evil = fx.receivablesPage1().replace(fx.HOST, "evil.example");
    const { transport, calls } = scripted([ok(evil), ok(fx.RECEIVABLES_PAGE2)]);
    await expect(createExactClient(transport, base).listReceivables()).rejects.toMatchObject({
      code: "BAD_NEXT_LINK",
    });
    expect(calls).toHaveLength(1);
  });

  it("honours a custom host", async () => {
    const page1 = fx.receivablesPage1().replace(fx.HOST, "start.exactonline.be");
    const { transport } = scripted([ok(page1), ok(fx.RECEIVABLES_PAGE2)]);
    const items = await createExactClient(transport, {
      ...base,
      host: "start.exactonline.be",
    }).listReceivables();
    expect(items).toHaveLength(3);
  });

  it("enforces the page cap", async () => {
    const endless = Array.from({ length: 5 }, () => ok(fx.receivablesPage1()));
    const { transport, calls } = scripted(endless);
    await expect(
      createExactClient(transport, { ...base, maxPages: 3 }).listReceivables(),
    ).rejects.toMatchObject({ code: "PAGE_CAP" });
    expect(calls).toHaveLength(3);
  });
});

describe("sync endpoints", () => {
  it("sends the Timestamp cursor filter and orders ascending", async () => {
    const { transport, calls } = scripted([ok(fx.SYNC_ACCOUNTS)]);
    const page = await createExactClient(transport, base).syncAccounts("42");
    expect(calls[0]?.path).toBe("/sync/CRM/Accounts");
    expect(calls[0]?.query?.["$filter"]).toBe("Timestamp gt 42L");
    expect(calls[0]?.query?.["$orderby"]).toBe("Timestamp");
    expect(calls[0]?.query?.["$select"]).toContain("Timestamp");
    expect(page.complete).toBe(true);
    // Beyond Number.MAX_SAFE_INTEGER: must stay exact.
    expect(page.nextCursor).toBe("9007199254740999");
    expect(page.items[0]?.timestamp).toBe("9007199254740993");
    expect(page.items[0]?.email).toBeNull();
  });

  it("keeps the cursor when nothing changed", async () => {
    const { transport } = scripted([ok(fx.EMPTY)]);
    const page = await createExactClient(transport, base).syncReceivables("77");
    expect(page).toEqual({ items: [], nextCursor: "77", complete: true });
  });

  it("follows pages and maps sync open items", async () => {
    const { transport, calls } = scripted([ok(fx.SYNC_RECEIVABLES), ok(fx.SYNC_RECEIVABLES_2)]);
    const page = await createExactClient(transport, base).syncReceivables("0");
    expect(calls[1]?.query?.["$filter"]).toBe("Timestamp gt 0L");
    expect(page.items.map((i) => i.amount.minor)).toEqual([1000, 2025]);
    expect(page.nextCursor).toBe("700");
    expect(page.items[0]?.accountId).toBe("c0000000-0000-0000-0000-000000000001");
  });

  it("stops at the page cap with a resumable cursor when maxPages is given", async () => {
    const { transport, calls } = scripted([ok(fx.SYNC_RECEIVABLES), ok(fx.SYNC_RECEIVABLES_2)]);
    const page = await createExactClient(transport, { ...base, maxPages: 1 }).syncPayables("0", {
      maxPages: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/sync/Cashflow/Payables");
    expect(page.complete).toBe(false);
    expect(page.nextCursor).toBe("500");
    expect(page.items[0]?.kind).toBe("payable");
  });

  it("rejects a cursor that is not digits (filter injection)", async () => {
    const c = createExactClient(scripted([]).transport, base);
    await expect(c.syncAccounts("0 or true")).rejects.toThrow(RangeError);
    await expect(c.syncAccounts("-1")).rejects.toThrow(RangeError);
  });
});

describe("accounts and bank accounts", () => {
  it("maps accounts, trimming padded codes", async () => {
    const { transport } = scripted([ok(fx.ACCOUNTS)]);
    const a = await createExactClient(transport, base).listAccounts();
    expect(a[0]).toMatchObject({
      code: "1001",
      vatNumber: "NL001234567B01",
      country: "NL",
      isSales: true,
      timestamp: null,
    });
    expect(a[1]).toMatchObject({ email: null, vatNumber: null, status: null, isSupplier: true });
  });

  it("normalises IBANs and filters by a validated account id", async () => {
    const { transport, calls } = scripted([ok(fx.BANK_ACCOUNTS)]);
    const id = "c0000000-0000-0000-0000-0000000000f1";
    const b = await createExactClient(transport, base).listBankAccounts({ accountId: id });
    expect(calls[0]?.query?.["$filter"]).toBe(`Account eq guid'${id}'`);
    expect(b[0]?.iban).toBe("NL91ABNA0417164300");
    await expect(
      createExactClient(scripted([]).transport, base).listBankAccounts({
        accountId: "x' or 1 eq 1",
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("GL balances", () => {
  it("filters and converts", async () => {
    const { transport, calls } = scripted([ok(fx.GL_BALANCES)]);
    const r = await createExactClient(transport, base).listGlBalances({
      year: 2025,
      upToPeriod: 3,
      currency: "EUR",
    });
    expect(calls[0]?.query?.["$filter"]).toBe("ReportingYear eq 2025 and ReportingPeriod le 3");
    expect(r[0]).toMatchObject({ amount: { minor: -150005, currency: "EUR" }, balanceType: "B" });
  });

  it("validates inputs", async () => {
    const c = createExactClient(scripted([]).transport, base);
    await expect(c.listGlBalances({ year: 20, currency: "EUR" })).rejects.toThrow(RangeError);
    await expect(c.listGlBalances({ year: 2025, upToPeriod: -1, currency: "EUR" })).rejects.toThrow(
      RangeError,
    );
  });

  it("rejects incomplete rows", async () => {
    const { transport } = scripted([ok(`{"d":{"results":[{"GLAccount":"g"}]}}`)]);
    await expect(
      createExactClient(transport, base).listGlBalances({ year: 2025, currency: "EUR" }),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
  });
});

describe("errors and retries", () => {
  it("maps 401 to ExactAuthError without retry", async () => {
    const { transport, calls } = scripted([status(401, "nope")]);
    await expect(createExactClient(transport, base).listDivisions()).rejects.toBeInstanceOf(
      ExactAuthError,
    );
    expect(calls).toHaveLength(1);
  });

  it("maps 429 using Retry-After, without retry", async () => {
    const sleep = vi.fn(noSleep);
    const { transport, calls } = scripted([status(429, "", { "Retry-After": "7" })]);
    const err = await createExactClient(transport, { ...base, sleep })
      .listDivisions()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExactRateLimitedError);
    expect((err as ExactRateLimitedError).retryAfterMs).toBe(7000);
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("maps 429 using the reset headers and the injected clock", async () => {
    const { transport } = scripted([
      status(429, "", {
        "X-RateLimit-Minutely-Reset": "1700000045000",
        "X-RateLimit-Minutely-Remaining": "0",
      }),
    ]);
    const err = await createExactClient(transport, { ...base, now: () => 1_700_000_000_000 })
      .listDivisions()
      .catch((e: unknown) => e);
    expect((err as ExactRateLimitedError).retryAfterMs).toBe(45_000);
  });

  it("surfaces ExactRateLimitedError and budget errors from the transport without retry", async () => {
    const sleep = vi.fn(noSleep);
    const rl = scripted([new ExactRateLimitedError("gate", 1234)]);
    await expect(
      createExactClient(rl.transport, { ...base, sleep }).listDivisions(),
    ).rejects.toMatchObject({ retryAfterMs: 1234 });
    expect(rl.calls).toHaveLength(1);
    const bu = scripted([new ExactBudgetExhaustedError("spent", "job-1")]);
    await expect(
      createExactClient(bu.transport, { ...base, sleep }).listDivisions(),
    ).rejects.toMatchObject({
      jobId: "job-1",
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries GET on 5xx up to twice with backoff, then succeeds", async () => {
    const sleep = vi.fn(noSleep);
    const { transport, calls } = scripted([status(503), status(500), ok(fx.DIVISIONS)]);
    const d = await createExactClient(transport, { ...base, sleep }).listDivisions();
    expect(d).toHaveLength(2);
    expect(calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1500]);
  });

  it("gives up after two retries with an ExactApiError", async () => {
    const sleep = vi.fn(noSleep);
    const { transport, calls } = scripted([
      status(502),
      status(502),
      status(502),
      ok(fx.DIVISIONS),
    ]);
    await expect(
      createExactClient(transport, { ...base, sleep }).listDivisions(),
    ).rejects.toMatchObject({ status: 502 });
    expect(calls).toHaveLength(3);
  });

  it("never retries a non-GET on 5xx", async () => {
    const sleep = vi.fn(noSleep);
    const { transport, calls } = scripted([status(500, "boom"), ok(fx.XML_OK)]);
    await expect(
      createExactClient(transport, { ...base, sleep }).xmlUpload("MatchSets", "<MatchSets/>"),
    ).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses a real timer by default (no injected sleep)", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = scripted([status(500), ok(fx.DIVISIONS)]);
      const p = createExactClient(transport, base).listDivisions();
      await vi.advanceTimersByTimeAsync(600);
      expect(await p).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps other 4xx to ExactApiError with parsed code and masked details", async () => {
    const body = `{"error":{"code":"E1","message":{"lang":"en","value":"Bad IBAN NL91ABNA0417164300 Bearer abc.def.ghi"}}}`;
    const { transport } = scripted([status(400, body)]);
    const err = (await createExactClient(transport, base)
      .listDivisions()
      .catch((e: unknown) => e)) as ExactApiError;
    expect(err).toBeInstanceOf(ExactApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("E1");
    expect(err.message).not.toContain("NL91ABNA0417164300");
    expect(err.message).not.toContain("abc.def.ghi");
    expect(err.message).toContain("NL91");
  });

  it("handles plain-string and non-JSON error bodies", async () => {
    const a = await createExactClient(
      scripted([status(404, `{"error":{"message":"gone"}}`)]).transport,
      base,
    )
      .listDivisions()
      .catch((e: unknown) => e as ExactApiError);
    expect((a as ExactApiError).message).toContain("gone");
    expect((a as ExactApiError).code).toBeUndefined();
    const b = await createExactClient(
      scripted([status(403, "access_token=SECRETVALUE failed for DE89370400440532013000")])
        .transport,
      base,
    )
      .listDivisions()
      .catch((e: unknown) => e as ExactApiError);
    expect((b as ExactApiError).message).not.toContain("SECRETVALUE");
    expect((b as ExactApiError).message).not.toContain("DE89370400440532013000");
    const c = await createExactClient(scripted([status(400, `{"error":5}`)]).transport, base)
      .listDivisions()
      .catch((e: unknown) => e as ExactApiError);
    expect(c).toBeInstanceOf(ExactApiError);
  });

  it("never puts IBANs from data into BAD_SHAPE messages", async () => {
    const body = `{"d":{"results":[{"ID":1,"BankAccount":"NL91ABNA0417164300"}]}}`;
    const err = (await createExactClient(scripted([ok(body)]).transport, base)
      .listBankAccounts()
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("NL91ABNA0417164300");
  });
});

describe("xmlUpload", () => {
  it("posts the envelope once and parses messages", async () => {
    const { transport, calls } = scripted([ok(fx.XML_OK)]);
    const r = await createExactClient(transport, { ...base, priority: "user" }).xmlUpload(
      "MatchSets",
      "<MatchSets/>",
    );
    expect(r).toEqual({
      ok: true,
      messages: [{ severity: "info", description: "Created & matched" }],
    });
    const c = calls[0];
    expect(c).toMatchObject({
      method: "POST",
      api: "xml",
      path: "/docs/XMLUpload.aspx",
      query: { Topic: "MatchSets" },
      division: fx.DIV,
      priority: "user",
      jobId: "job-1",
    });
    expect(c?.body).toContain("<eExact");
    expect(c?.body).toContain("<MatchSets/>");
  });

  it("rejects bad topic names", async () => {
    await expect(
      createExactClient(scripted([]).transport, base).xmlUpload("A&B", "<x/>"),
    ).rejects.toThrow(RangeError);
  });
});
