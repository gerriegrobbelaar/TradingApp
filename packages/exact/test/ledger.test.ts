import { describe, expect, it } from "vitest";
import {
  BUDGET_FIELDS,
  ExactApiError,
  ExactRateLimitedError,
  GL_ACCOUNT_FIELDS,
  REPORTING_BALANCE_FIELDS,
  createExactClient,
} from "../src";
import * as fx from "./fixtures";
import { ok, scripted, status } from "./helpers";

const base = { division: fx.DIV, jobId: "job-1", priority: "job" as const };
const G = (n: number): string => `f0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const link = (path: string, token: string): string =>
  `https://${fx.HOST}/api/v1/${fx.DIV}${path}?$skiptoken=${token}`;
const envelope = (rows: string[], next?: string): string =>
  `{"d":{"results":[${rows.join(",")}]${next === undefined ? "" : `,"__next":"${next}"`}}}`;

const account = (n: number, over = ""): string =>
  `{"ID":"${G(n)}","Code":"  ${1000 + n}","Description":" Account ${n} ","Type":12,"TypeDescription":"Bank","BalanceSide":"D","BalanceType":"B","Blocked":false${over}}`;
const balance = (n: number, year: number, period: number, amount: string, over = ""): string =>
  `{"GLAccount":"${G(n)}","GLAccountCode":"${1000 + n}","ReportingYear":${year},"ReportingPeriod":${period},"Amount":${amount},"AmountDebit":${amount.startsWith("-") ? "0" : amount},"AmountCredit":${amount.startsWith("-") ? amount.slice(1) : "0"},"BalanceType":"B","Status":null,"CostCenterCode":null${over}}`;

describe("chart of accounts", () => {
  it("maps accounts, trims, and sends a $select of the documented fields", async () => {
    const { transport, calls } = scripted([ok(envelope([account(1), account(2)]))]);
    const r = await createExactClient(transport, base).listGlAccountsChunk(null);
    expect(calls[0]?.path).toBe("/financial/GLAccounts");
    expect(calls[0]?.query?.["$select"]).toBe(GL_ACCOUNT_FIELDS.join(","));
    expect(calls[0]?.query?.["$skiptoken"]).toBeUndefined();
    expect(r.complete).toBe(true);
    expect(r.items[0]).toEqual({
      id: G(1),
      code: "1001",
      name: "Account 1",
      type: 12,
      typeDescription: "Bank",
      balanceSide: "D",
      balanceType: "B",
      isBlocked: false,
    });
  });

  it("is lenient about odd values: unknown side or type, blocked true, no description", async () => {
    const row = `{"ID":"${G(3)}","Code":null,"Description":null,"Type":"x","BalanceSide":"?","BalanceType":"Z","Blocked":true}`;
    const { transport } = scripted([ok(envelope([row]))]);
    const r = await createExactClient(transport, base).listGlAccountsChunk(null);
    expect(r.items[0]).toMatchObject({
      code: null,
      name: "",
      type: null,
      balanceSide: null,
      balanceType: null,
      isBlocked: true,
    });
  });

  it("rejects a row without a GUID id", async () => {
    const { transport } = scripted([ok(envelope([`{"ID":"nope"}`]))]);
    await expect(
      createExactClient(transport, base).listGlAccountsChunk(null),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
  });

  it("pages in chunks with a saved $skiptoken (pages of 60 rows)", async () => {
    const page = (from: number, next?: string): string =>
      envelope(
        Array.from({ length: 60 }, (_, i) => account(from + i)),
        next,
      );
    const path = "/financial/GLAccounts";
    const { transport, calls } = scripted([
      ok(page(1, link(path, "t1"))),
      ok(page(61, link(path, "t2"))),
      ok(page(121)),
    ]);
    const c = createExactClient(transport, base);
    const first = await c.listGlAccountsChunk(null, { maxPages: 2 });
    expect(first).toMatchObject({ complete: false, nextToken: "t2" });
    expect(first.items).toHaveLength(120);
    const second = await c.listGlAccountsChunk("t2", { maxPages: 2 });
    expect(second).toMatchObject({ complete: true, nextToken: null });
    expect(second.items).toHaveLength(60);
    expect(calls[2]?.query?.["$skiptoken"]).toBe("t2");
  });

  it("keeps pages read before a later failure and hands the error back", async () => {
    const boom = new ExactRateLimitedError(1000);
    const { transport } = scripted([
      ok(envelope([account(1)], link("/financial/GLAccounts", "t1"))),
      boom,
    ]);
    const r = await createExactClient(transport, base).listGlAccountsChunk(null, { maxPages: 5 });
    expect(r).toMatchObject({ complete: false, nextToken: "t1", error: boom });
    expect(r.items).toHaveLength(1);
  });

  it("refuses a paging link to another endpoint", async () => {
    const { transport } = scripted([
      ok(envelope([account(1)], link("/financial/ReportingBalance", "t1"))),
    ]);
    // first page succeeded, the link is unusable: no safe place to continue from
    await expect(
      createExactClient(transport, base).listGlAccountsChunk(null),
    ).rejects.toMatchObject({ code: "BAD_NEXT_LINK" });
  });
});

describe("reporting balances", () => {
  it("filters by year, keeps the filter on every page and sends the field list", async () => {
    const path = "/financial/ReportingBalance";
    const { transport, calls } = scripted([
      ok(envelope([balance(1, 2026, 1, "100.5")], link(path, "t1"))),
      ok(envelope([balance(1, 2026, 2, "-20")])),
    ]);
    const r = await createExactClient(transport, base).listReportingBalancesChunk(null, {
      year: 2026,
    });
    expect(r.complete).toBe(true);
    for (const c of calls) {
      expect(c.path).toBe(path);
      expect(c.query?.["$filter"]).toBe("ReportingYear eq 2026");
      expect(c.query?.["$select"]).toBe(REPORTING_BALANCE_FIELDS.join(","));
    }
    expect(calls[1]?.query?.["$skiptoken"]).toBe("t1");
    expect(r.items.map((i) => i.amount)).toEqual([
      { minor: 10050, currency: "EUR" },
      { minor: -2000, currency: "EUR" },
    ]);
    expect(r.items[0]).toMatchObject({
      glAccountId: G(1),
      reportingYear: 2026,
      reportingPeriod: 1,
      balanceType: "B",
      dimension: "",
      debit: { minor: 10050, currency: "EUR" },
      credit: { minor: 0, currency: "EUR" },
    });
  });

  it("keeps Exact's decimals at the scale of the division currency: JPY 0, KWD 3", async () => {
    const yen = scripted([ok(envelope([balance(1, 2026, 1, "123456789")]))]);
    const y = await createExactClient(yen.transport, {
      ...base,
      divisionCurrency: "JPY",
    }).listReportingBalancesChunk(null, { year: 2026 });
    expect(y.items[0]?.amount).toEqual({ minor: 123456789, currency: "JPY" });

    const kwd = scripted([ok(envelope([balance(1, 2026, 1, "1234.567")]))]);
    const k = await createExactClient(kwd.transport, {
      ...base,
      divisionCurrency: "KWD",
    }).listReportingBalancesChunk(null, { year: 2026 });
    expect(k.items[0]?.amount).toEqual({ minor: 1234567, currency: "KWD" });
    expect(k.items[0]?.debit).toEqual({ minor: 1234567, currency: "KWD" });
  });

  it("never goes through a float: a large amount stays exact, one beyond the safe range is refused", async () => {
    const exact = scripted([ok(envelope([balance(1, 2026, 1, "12345678901234.56")]))]);
    const r = await createExactClient(exact.transport, base).listReportingBalancesChunk(null, {
      year: 2026,
    });
    expect(r.items[0]?.amount.minor).toBe(1234567890123456);
    const huge = scripted([ok(envelope([balance(1, 2026, 1, "1234567890123456.78")]))]);
    await expect(
      createExactClient(huge.transport, base).listReportingBalancesChunk(null, { year: 2026 }),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
  });

  it("can narrow the read to one ledger account (the bank balance job, ADR 0045)", async () => {
    const { transport, calls } = scripted([ok(envelope([balance(1, 2026, 1, "5")]))]);
    await createExactClient(transport, base).listReportingBalancesChunk(null, {
      year: 2026,
      glAccountId: G(1).toUpperCase(),
    });
    expect(calls[0]?.query?.["$filter"]).toBe(
      `GLAccount eq guid'${G(1)}' and ReportingYear eq 2026`,
    );
    // anything that is not a GUID is refused before a call is made (no filter injection)
    const none = scripted([]);
    await expect(
      createExactClient(none.transport, base).listReportingBalancesChunk(null, {
        year: 2026,
        glAccountId: "x' or 1 eq 1",
      }),
    ).rejects.toThrow(RangeError);
    expect(none.calls).toHaveLength(0);
  });

  it("splits periods over status and cost centre in the dimension", async () => {
    const row = balance(1, 2026, 3, "5", "").replace(
      `"Status":null,"CostCenterCode":null`,
      `"Status":"20","CostCenterCode":" CC1 "`,
    );
    const { transport } = scripted([ok(envelope([row]))]);
    const r = await createExactClient(transport, base).listReportingBalancesChunk(null, {
      year: 2026,
    });
    expect(r.items[0]?.dimension).toBe("20|CC1");
  });

  it("adds the cost unit to the dimension and reads a numeric status (review K2)", async () => {
    const row = balance(1, 2026, 3, "5", "").replace(
      `"Status":null,"CostCenterCode":null`,
      `"Status":50,"CostCenterCode":null,"CostUnitCode":"U7"`,
    );
    const { transport, calls } = scripted([ok(envelope([row]))]);
    const r = await createExactClient(transport, base).listReportingBalancesChunk(null, {
      year: 2026,
    });
    expect(r.items[0]?.dimension).toBe("50||U7");
    expect(calls[0]?.query?.["$select"]).toContain("CostUnitCode");
  });

  it("validates the year and rows", async () => {
    const c = createExactClient(scripted([]).transport, base);
    await expect(c.listReportingBalancesChunk(null, { year: 20 })).rejects.toThrow(RangeError);
    await expect(c.listReportingBalancesChunk(null, { year: 2026.5 })).rejects.toThrow(RangeError);
    const bad = scripted([ok(envelope([`{"GLAccount":"${G(1)}","Amount":1}`]))]);
    await expect(
      createExactClient(bad.transport, base).listReportingBalancesChunk(null, { year: 2026 }),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
    const noAmount = scripted([
      ok(envelope([`{"GLAccount":"${G(1)}","ReportingYear":2026,"ReportingPeriod":1}`])),
    ]);
    await expect(
      createExactClient(noAmount.transport, base).listReportingBalancesChunk(null, { year: 2026 }),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
    const period = scripted([
      ok(
        envelope([`{"GLAccount":"${G(1)}","ReportingYear":2026,"ReportingPeriod":120,"Amount":1}`]),
      ),
    ]);
    await expect(
      createExactClient(period.transport, base).listReportingBalancesChunk(null, { year: 2026 }),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
  });
});

describe("budgets", () => {
  const budget = (n: number, period: number, amount: string, scenario: string | null): string =>
    `{"GLAccount":"${G(n)}","GLAccountCode":"${1000 + n}","ReportingYear":2026,"ReportingPeriod":${period},"AmountDC":${amount},"BudgetScenario":${scenario === null ? "null" : `"${scenario}"`},"Costcenter":null}`;

  it("reads budgets of a year as division-currency amounts", async () => {
    const { transport, calls } = scripted([
      ok(envelope([budget(5, 1, "-6000", G(77).toUpperCase()), budget(6, 1, "3500.25", null)])),
    ]);
    const r = await createExactClient(transport, base).listBudgetsChunk(null, { year: 2026 });
    expect(calls[0]?.path).toBe("/budget/Budgets");
    expect(calls[0]?.query?.["$filter"]).toBe("ReportingYear eq 2026");
    expect(calls[0]?.query?.["$select"]).toBe(BUDGET_FIELDS.join(","));
    expect(r.items[0]).toMatchObject({
      amount: { minor: -600000, currency: "EUR" },
      scenario: G(77),
      dimension: "",
    });
    expect(r.items[1]).toMatchObject({ amount: { minor: 350025, currency: "EUR" }, scenario: "" });
  });

  it("throws the API error of the first page so the caller can treat it as 'no budgets'", async () => {
    for (const code of [400, 403, 404]) {
      const { transport } = scripted([status(code, `{"error":{"message":{"value":"no"}}}`)]);
      await expect(
        createExactClient(transport, base).listBudgetsChunk(null, { year: 2026 }),
      ).rejects.toMatchObject({ status: code });
    }
    const { transport } = scripted([status(404)]);
    await expect(
      createExactClient(transport, base).listBudgetsChunk(null, { year: 2026 }),
    ).rejects.toBeInstanceOf(ExactApiError);
  });
});
