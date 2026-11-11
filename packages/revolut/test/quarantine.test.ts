/**
 * Per-row quarantine of /transactions pages, the card mask and getCounterparty (Phase 5 review
 * S2, S6). A row that does not map is reported by id and fixed code only; the page, the cursor and
 * the walk go on.
 */
import { describe, expect, it } from "vitest";
import { createRevolutClient } from "../src/client";
import { mapTransaction } from "../src/models";
import type { RevolutTransport } from "../src/transport";
import { ok, scripted, status } from "./helpers";

const client = (t: RevolutTransport) =>
  createRevolutClient(t, {
    connectionId: 1,
    jobId: "test",
    priority: "job",
    sleep: async () => {},
  });

const leg = (id: string, over: Record<string, unknown> = {}) => ({
  leg_id: id,
  account_id: "acc-1",
  amount: "-1.5",
  currency: "EUR",
  ...over,
});
const row = (id: string, at: string, legs: unknown[] = [leg(`${id}-l`)]) => ({
  id,
  type: "transfer",
  state: "completed",
  created_at: at,
  updated_at: at,
  legs,
});

const T = "2024-05-01T10:00:";

describe("a bad row does not stop its page", () => {
  const page = [
    row("good-1", `${T}59.000Z`),
    row("no-leg-id", `${T}58.000Z`, [{ account_id: "a", amount: 1, currency: "EUR" }]),
    row("decimals", `${T}57.000Z`, [leg("d", { amount: "1.005" })]),
    row("zoneless", `${T}56.000`),
    row("dup-legs", `${T}55.000Z`, [leg("x"), leg("x")]),
    row("good-2", `${T}54.000Z`),
  ];

  it("returns the good rows and the bad ones as id and code only", async () => {
    const s = scripted([ok(JSON.stringify(page))]);
    const chunk = await client(s.transport).listTransactionsChunk({ count: 50 });
    expect(chunk.transactions.map((t) => t.id)).toEqual(["good-1", "good-2"]);
    expect(chunk.rejected).toEqual([
      { id: "no-leg-id", code: "bad_shape" },
      { id: "decimals", code: "bad_shape" },
      { id: "dup-legs", code: "bad_shape" },
      // Not placeable in the order, so reported after the placed rows.
      { id: "zoneless", code: "bad_timestamp" },
    ]);
    // Codes and ids only: no payload text of any kind.
    expect(JSON.stringify(chunk.rejected)).not.toMatch(/1\.005|EUR|acc-1/);
  });

  it("moves the cursor by the raw page, so a bad oldest row cannot stall a walk", async () => {
    const rows = [row("g", `${T}59.000Z`), row("bad-oldest", `${T}50.000Z`, [{ amount: "x" }])];
    const s = scripted([ok(JSON.stringify(rows)), ok(JSON.stringify([]))]);
    const c = client(s.transport);
    const first = await c.listTransactionsChunk({ count: 2 });
    expect(first.transactions.map((t) => t.id)).toEqual(["g"]);
    expect(first.rejected).toEqual([{ id: "bad-oldest", code: "bad_shape" }]);
    // The next bound is one millisecond past the BAD row's timestamp, and the bad id is "seen".
    expect(first.nextCursor?.toIso).toBe("2024-05-01T10:00:50.001Z");
    expect(first.nextCursor?.seen.map((x) => x.id).sort()).toEqual(["bad-oldest"]);
    const second = await c.listTransactionsChunk({ count: 2, cursor: first.nextCursor });
    expect(second).toEqual({ transactions: [], rejected: [], nextCursor: null });
  });

  it("a row without a usable id or created_at is reported and left out of the paging", async () => {
    const s = scripted([
      ok(JSON.stringify([row("g", `${T}59.000Z`), { created_at: `${T}58.000Z` }, "junk", null])),
    ]);
    const chunk = await client(s.transport).listTransactionsChunk({ count: 50 });
    expect(chunk.transactions.map((t) => t.id)).toEqual(["g"]);
    expect(chunk.rejected).toEqual([
      { id: null, code: "bad_shape" },
      { id: null, code: "bad_shape" },
      { id: null, code: "bad_shape" },
    ]);
  });

  it("transactionChunks hands rejected rows to the callback and yields the rest", async () => {
    const s = scripted([ok(JSON.stringify(page)), ok("[]")]);
    const seen: string[] = [];
    const out: string[] = [];
    for await (const chunk of client(s.transport).transactionChunks({ count: 50 }, 5, (r) =>
      seen.push(...r.map((x) => x.id ?? "?")),
    )) {
      out.push(...chunk.map((t) => t.id));
    }
    expect(out).toEqual(["good-1", "good-2"]);
    expect(seen).toEqual(["no-leg-id", "decimals", "dup-legs", "zoneless"]);
  });
});

describe("card number", () => {
  it("keeps the last four digits only", () => {
    const tx = mapTransaction({
      ...row("c", `${T}59.000Z`, [leg("l", { card: { card_number: "123456******7890" } })]),
      card: { card_number: "4111111111111111" },
    });
    expect(tx.card).toEqual({ last4: "1111" });
    expect(tx.legs[0]?.card).toEqual({ last4: "7890" });
    const json = JSON.stringify(tx);
    expect(json).not.toContain("123456");
    expect(json).not.toContain("411111");
  });

  it("a card number without digits at the end gives no card info", () => {
    const tx = mapTransaction({ ...row("c", `${T}59.000Z`), card: { card_number: "hidden" } });
    expect(tx.card).toEqual({});
  });
});

describe("getCounterparty", () => {
  const body = {
    id: "cp-1",
    name: "Acme B.V.",
    accounts: [{ id: "cpa-1", currency: "EUR", type: "external", iban: "NL91ABNA0417164300" }],
  };

  it("reads one counterparty by id from /counterparty/{id}", async () => {
    const s = scripted([ok(JSON.stringify(body))]);
    const cp = await client(s.transport).getCounterparty("cp 1/x");
    expect(s.calls[0]).toMatchObject({ method: "GET", path: "/counterparty/cp%201%2Fx" });
    expect(cp).toMatchObject({
      id: "cp-1",
      name: "Acme B.V.",
      accounts: [{ iban: "NL91ABNA0417164300" }],
    });
  });

  it("masks IBANs in error messages and never quotes a non-JSON body", async () => {
    const e1 = (await client(
      scripted([status(400, JSON.stringify({ message: "bad NL91ABNA0417164300 for Acme" }))])
        .transport,
    )
      .getCounterparty("cp-1")
      .catch((x: unknown) => x)) as Error;
    expect(e1.message).not.toContain("NL91ABNA0417164300");
    const e2 = (await client(scripted([status(500, "<html>NL91ABNA0417164300</html>")]).transport)
      .getCounterparty("cp-1")
      .catch((x: unknown) => x)) as Error;
    expect(e2.message).not.toContain("NL91ABNA0417164300");
  });

  it("an unusable body is a fixed-message data error; an empty id is refused", async () => {
    const e = (await client(scripted([ok("[]")]).transport)
      .getCounterparty("cp-1")
      .catch((x: unknown) => x)) as Error;
    expect(e.message).not.toMatch(/\[\]/);
    await expect(client(scripted([]).transport).getCounterparty("")).rejects.toThrow(RangeError);
  });
});
