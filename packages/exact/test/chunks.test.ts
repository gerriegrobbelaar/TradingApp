import { describe, expect, it } from "vitest";
import { ExactApiError, ExactRateLimitedError, createExactClient } from "../src";
import * as fx from "./fixtures";
import { ok, scripted, status } from "./helpers";

const base = { division: fx.DIV, jobId: "job-1", priority: "job" as const };
const noSleep = (ms: number) => {
  void ms;
  return Promise.resolve();
};

describe("resumable list chunks (review G1)", () => {
  const link = (token: string) =>
    `https://${fx.HOST}/api/v1/${fx.DIV}/read/financial/ReceivablesList?$skiptoken=${token}`;
  const row = (n: number) =>
    `{"ID":"a0000000-0000-0000-0000-00000000000${n}","AccountId":"c0000000-0000-0000-0000-000000000001","AccountName":"A","Amount":${n},"CurrencyCode":"EUR","InvoiceNumber":${n}}`;
  const page = (n: number, next?: string) =>
    `{"d":{"results":[${row(n)}]${next === undefined ? "" : `,"__next":"${next}"`}}}`;

  it("returns the $skiptoken at the page cap and resumes from a saved token", async () => {
    const { transport, calls } = scripted([
      ok(page(1, link("t1"))),
      ok(page(2, link("t2"))),
      ok(page(3)),
    ]);
    const c = createExactClient(transport, base);
    const first = await c.listReceivablesChunk(null, { maxPages: 2 });
    expect(first).toMatchObject({ complete: false, nextToken: "t2" });
    expect(first.items.map((i) => i.amount.minor)).toEqual([100, 200]);
    expect(calls[0]?.query?.["$skiptoken"]).toBeUndefined();
    expect(calls[1]?.query?.["$skiptoken"]).toBe("t1");

    const second = await c.listReceivablesChunk("t2", { maxPages: 2 });
    expect(second).toMatchObject({ complete: true, nextToken: null });
    expect(calls[2]?.query?.["$skiptoken"]).toBe("t2");
    expect(calls[2]?.path).toBe("/read/financial/ReceivablesList");
  });

  it("keeps the pages read before a failure and hands the error back", async () => {
    const boom = new ExactRateLimitedError(1000);
    const { transport } = scripted([ok(page(1, link("t1"))), boom]);
    const r = await createExactClient(transport, base).listReceivablesChunk(null, { maxPages: 5 });
    expect(r.items).toHaveLength(1);
    expect(r).toMatchObject({ complete: false, nextToken: "t1", error: boom });
  });

  it("throws when the very first page fails, and refuses a bad saved token", async () => {
    const { transport } = scripted([new ExactRateLimitedError(1)]);
    const c = createExactClient(transport, base);
    await expect(c.listPayablesChunk(null)).rejects.toBeInstanceOf(ExactRateLimitedError);
    await expect(c.listPayablesChunk("")).rejects.toBeInstanceOf(RangeError);
    await expect(c.listPayablesChunk("x".repeat(501))).rejects.toBeInstanceOf(RangeError);
  });

  it("sync reads keep earlier pages when a later page fails (cursor stays resumable)", async () => {
    const { transport } = scripted([
      ok(fx.SYNC_RECEIVABLES),
      status(503),
      status(503),
      status(503),
    ]);
    const r = await createExactClient(transport, { ...base, sleep: noSleep }).syncReceivables("0");
    expect(r.complete).toBe(false);
    expect(r.error).toBeInstanceOf(ExactApiError);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.nextCursor).not.toBe("0");
  });
});
