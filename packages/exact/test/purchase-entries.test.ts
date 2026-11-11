import { describe, expect, it } from "vitest";
import {
  PURCHASE_ENTRY_FIELDS,
  createExactClient,
  odataDateTime,
  purchaseEntryFilterExpr,
} from "../src";
import * as fx from "./fixtures";
import { ok, scripted, status } from "./helpers";

const base = { division: fx.DIV, jobId: "job-1", priority: "job" as const };
const G = (n: number): string => `f0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const PATH = "/purchaseentry/PurchaseEntries";
const link = (token: string): string =>
  `https://${fx.HOST}/api/v1/${fx.DIV}${PATH}?$skiptoken=${token}`;
const envelope = (rows: string[], next?: string): string =>
  `{"d":{"results":[${rows.join(",")}]${next === undefined ? "" : `,"__next":"${next}"`}}}`;
const entry = (n: number, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    EntryID: G(n),
    EntryNumber: 70000 + n,
    Supplier: G(500 + n),
    SupplierName: ` Supplier ${n} `,
    Currency: "EUR",
    AmountFC: 121.5,
    AmountDC: 121.5,
    EntryDate: "/Date(1784000000000)/",
    DueDate: "/Date(1786000000000)/",
    Status: 5,
    Created: "/Date(1784000100000)/",
    Modified: "/Date(1784000200000)/",
    Document: G(900 + n),
    ...over,
  });
const WINDOW = {
  kind: "window" as const,
  fromIso: "2026-03-17T00:00:00.000Z",
  pendingStatusCodes: [5],
};

describe("purchase entry filters", () => {
  it("builds an OData v2 datetime literal at second precision", () => {
    expect(odataDateTime("2026-03-17T10:20:30.999Z")).toBe("datetime'2026-03-17T10:20:30'");
    expect(() => odataDateTime("nonsense")).toThrow(RangeError);
  });

  it("the window filter is entry date or modified or a pending status, the hourly one is modified", () => {
    expect(purchaseEntryFilterExpr(WINDOW)).toBe(
      "EntryDate ge datetime'2026-03-17T00:00:00' or Modified ge datetime'2026-03-17T00:00:00' or Status eq 5",
    );
    expect(purchaseEntryFilterExpr({ ...WINDOW, pendingStatusCodes: [] })).not.toContain("Status");
    expect(purchaseEntryFilterExpr({ kind: "modified", sinceIso: "2026-03-17T00:00:00Z" })).toBe(
      "Modified ge datetime'2026-03-17T00:00:00'",
    );
    expect(() => purchaseEntryFilterExpr({ ...WINDOW, pendingStatusCodes: [-1] })).toThrow(
      RangeError,
    );
    expect(() => purchaseEntryFilterExpr({ ...WINDOW, pendingStatusCodes: [Number.NaN] })).toThrow(
      RangeError,
    );
  });
});

describe("listPurchaseEntriesChunk", () => {
  it("maps rows and sends $select, $filter and $orderby=Modified", async () => {
    const { transport, calls } = scripted([ok(envelope([entry(1)]))]);
    const r = await createExactClient(transport, base).listPurchaseEntriesChunk(null, {
      filter: WINDOW,
    });
    expect(calls[0]?.path).toBe(PATH);
    expect(calls[0]?.query?.["$select"]).toBe(PURCHASE_ENTRY_FIELDS.join(","));
    expect(calls[0]?.query?.["$orderby"]).toBe("Modified");
    expect(calls[0]?.query?.["$filter"]).toBe(purchaseEntryFilterExpr(WINDOW));
    expect(calls[0]?.query?.["$skiptoken"]).toBeUndefined();
    expect(r.complete).toBe(true);
    expect(r.items[0]).toEqual({
      id: G(1),
      entryNumber: "70001",
      supplierId: G(501),
      supplierName: "Supplier 1",
      amount: { minor: 12150, currency: "EUR" },
      amountDc: { minor: 12150, currency: "EUR" },
      entryDate: new Date(1784000000000).toISOString(),
      dueDate: new Date(1786000000000).toISOString(),
      statusCode: 5,
      created: new Date(1784000100000).toISOString(),
      modified: new Date(1784000200000).toISOString(),
      hasDocument: true,
    });
  });

  it("tells a missing Document field (unknown) from an empty one (no document)", async () => {
    const withNull = entry(2, { Document: null });
    const absent = JSON.parse(entry(3)) as Record<string, unknown>;
    delete absent["Document"];
    const { transport } = scripted([ok(envelope([withNull, JSON.stringify(absent)]))]);
    const r = await createExactClient(transport, base).listPurchaseEntriesChunk(null, {
      filter: WINDOW,
    });
    expect(r.items.map((i) => i.hasDocument)).toEqual([false, null]);
  });

  it("keeps the raw status code, including odd and missing ones", async () => {
    const { transport } = scripted([
      ok(
        envelope([
          entry(1, { Status: 999 }),
          entry(2, { Status: null }),
          entry(3, { Status: "x" }),
        ]),
      ),
    ]);
    const r = await createExactClient(transport, base).listPurchaseEntriesChunk(null, {
      filter: WINDOW,
    });
    expect(r.items.map((i) => i.statusCode)).toEqual([999, null, null]);
  });

  it("uses the division currency when the row has none, and scales other currencies", async () => {
    const { transport } = scripted([
      ok(
        envelope([
          entry(1, { Currency: null, AmountFC: 10 }),
          entry(2, { Currency: "JPY", AmountFC: 1500, AmountDC: 9.5 }),
        ]),
      ),
    ]);
    const r = await createExactClient(transport, base).listPurchaseEntriesChunk(null, {
      filter: WINDOW,
    });
    expect(r.items[0]?.amount).toEqual({ minor: 1000, currency: "EUR" });
    expect(r.items[1]?.amount).toEqual({ minor: 1500, currency: "JPY" });
    expect(r.items[1]?.amountDc).toEqual({ minor: 950, currency: "EUR" });
  });

  it("rejects a row without a GUID id or without an amount", async () => {
    for (const row of [entry(1, { EntryID: "nope" }), entry(1, { AmountFC: null })]) {
      const { transport } = scripted([ok(envelope([row]))]);
      await expect(
        createExactClient(transport, base).listPurchaseEntriesChunk(null, { filter: WINDOW }),
      ).rejects.toMatchObject({ code: "BAD_SHAPE" });
    }
  });

  it("pages in chunks with a saved $skiptoken and returns pages read before a failure", async () => {
    const { transport, calls } = scripted([
      ok(envelope([entry(1)], link("t1"))),
      ok(envelope([entry(2)], link("t2"))),
      ok(envelope([entry(3)])),
    ]);
    const c = createExactClient(transport, base);
    const first = await c.listPurchaseEntriesChunk(null, { filter: WINDOW, maxPages: 2 });
    expect(first).toMatchObject({ complete: false, nextToken: "t2" });
    expect(first.items).toHaveLength(2);
    const second = await c.listPurchaseEntriesChunk("t2", { filter: WINDOW, maxPages: 2 });
    expect(calls[2]?.query?.["$skiptoken"]).toBe("t2");
    expect(calls[2]?.query?.["$filter"]).toBe(purchaseEntryFilterExpr(WINDOW));
    expect(second).toMatchObject({ complete: true, nextToken: null });

    const failing = scripted([ok(envelope([entry(4)], link("t9"))), status(400, "{}")]);
    const part = await createExactClient(failing.transport, base).listPurchaseEntriesChunk(null, {
      filter: WINDOW,
      maxPages: 3,
    });
    expect(part.items).toHaveLength(1);
    expect(part.complete).toBe(false);
    expect(part.error).toBeDefined();
  });

  it("surfaces a 404 on the first page as an API error (the sync marks the entity unavailable)", async () => {
    const { transport } = scripted([status(404, "{}")]);
    await expect(
      createExactClient(transport, base).listPurchaseEntriesChunk(null, { filter: WINDOW }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
