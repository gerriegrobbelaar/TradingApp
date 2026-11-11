/**
 * Booked division-currency amount of foreign open items (Phase 6 review B1, ADR 0038): the nightly
 * list pass must not wipe it, may read it from optional list fields (with a degrade path on a 400)
 * or compute it from a verified rate direction; none of this spends extra Exact calls.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LIST_DC_UNAVAILABLE_MS,
  syncDivision,
  type DivisionRef,
  type SyncMode,
  type SyncOptions,
  type SyncSummary,
} from "../src/exact/sync";
import {
  FakeExact,
  addDivision,
  db,
  fakeGate,
  resetSync,
  type FakeGate,
  type FakeItem,
} from "./sync-helpers";

let div: DivisionRef & { name: string };
let fx: FakeExact;
let gate: FakeGate;
let n = 0;
let clock = Date.parse("2026-11-11T01:00:00Z");

beforeEach(async () => {
  await resetSync();
  await db
    .prepare("DELETE FROM settings WHERE key IN ('exact.list_dc_fields', 'exact.rate_direction')")
    .run();
  div = await addDivision();
  fx = new FakeExact(div.exactDivision);
  fx.divisions = [{ code: div.exactDivision, description: "Camelthorn", currency: "EUR" }];
  fx.accounts = [{ n: 1, name: "Acme", ts: 1, customer: true }];
  gate = fakeGate();
  clock = Date.parse("2026-11-11T01:00:00Z");
});

const run = (mode: SyncMode, over: Partial<SyncOptions> = {}): Promise<SyncSummary> =>
  syncDivision(
    env,
    { ...div, currency: "EUR" },
    { jobId: `booked-${++n}`, mode, ...over },
    { transport: fx.transport, gate, now: () => clock },
  );

const setSetting = (key: string, value: unknown) =>
  db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_by) VALUES (?1, ?2, 'test')
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .bind(key, JSON.stringify(value))
    .run();

const usd = (over: Partial<FakeItem> = {}): FakeItem => ({
  n: 1,
  account: 1,
  name: "Acme",
  amount: 1000,
  currency: "USD",
  invoiceNumber: 1,
  ts: 5,
  original: 1000,
  amountDc: 920,
  rate: 0.92,
  ...over,
});

interface Row {
  open_minor: number;
  currency: string;
  open_dc_minor: number | null;
  dc_currency: string | null;
  rate: string | null;
  status: string;
}
const read = async (): Promise<Row | null> =>
  db
    .prepare(
      `SELECT open_minor, currency, open_dc_minor, dc_currency, rate, status
       FROM open_items WHERE division_id = ?1`,
    )
    .bind(div.id)
    .first<Row>();

const listCalls = () => fx.calls.filter((c) => c.path === "/read/financial/ReceivablesList");
/** Calls to the open-item lists (what this change could add to); the rest of a run varies with its state. */
const exactCalls = () => fx.calls.filter((c) => c.path.startsWith("/read/financial/")).length;

describe("the nightly list pass keeps the booked amount (B1a)", () => {
  it("keeps open_dc_minor, dc_currency and rate while open amount and currency are unchanged", async () => {
    fx.receivables = [usd()];
    expect((await run("incremental")).status).toBe("ok");
    expect(await read()).toMatchObject({ open_dc_minor: 92000, dc_currency: "EUR", rate: "0.92" });

    expect((await run("full")).status).toBe("ok");
    expect(await read()).toEqual({
      open_minor: 100000,
      currency: "USD",
      open_dc_minor: 92000,
      dc_currency: "EUR",
      rate: "0.92",
      status: "open",
    });
  });

  it("clears it when the open amount changed (a part payment): the remainder is unknown", async () => {
    fx.receivables = [usd()];
    await run("incremental");
    fx.receivables = [usd({ amount: 400 })];
    expect((await run("full")).status).toBe("ok");
    expect(await read()).toMatchObject({
      open_minor: 40000,
      open_dc_minor: null,
      dc_currency: null,
      rate: "0.92", // the rate describes the booked invoice and is kept
    });
    // the next incremental read that carries it fills it again
    fx.receivables = [usd({ amount: 400, amountDc: 368, ts: 9 })];
    await run("incremental");
    expect(await read()).toMatchObject({ open_minor: 40000, open_dc_minor: 36800 });
    // and a further full pass with the same open amount keeps it
    await run("full");
    expect(await read()).toMatchObject({ open_minor: 40000, open_dc_minor: 36800 });
  });

  it("clears it when the currency changed", async () => {
    fx.receivables = [usd()];
    await run("incremental");
    fx.receivables = [usd({ currency: "GBP" })];
    await run("full");
    expect(await read()).toMatchObject({
      currency: "GBP",
      open_minor: 100000,
      open_dc_minor: null,
      dc_currency: null,
      rate: null,
    });
  });

  it("a second full pass changes nothing (idempotent) and spends the same Exact calls", async () => {
    fx.receivables = [usd()];
    await run("incremental");
    await run("full");
    const before = await read();
    const callsBefore = exactCalls();
    await run("full");
    expect(await read()).toEqual(before);
    // a full pass costs the same number of calls the second time as the first time did
    const second = exactCalls() - callsBefore;
    fx.calls = [];
    await run("full");
    expect(exactCalls()).toBe(second);
  });

  it("settings off by default: no extra fields in $select, no extra calls", async () => {
    fx.receivables = [usd({ listAmountDc: 1, listRate: 1 })];
    await run("full");
    expect(listCalls().every((c) => !(c.query?.["$select"] ?? "").includes("AmountDC"))).toBe(true);
    expect(await read()).toMatchObject({ open_dc_minor: null });
  });
});

describe("optional DC fields in the list read (B1b option 1)", () => {
  it("reads AmountDC and RateFC from the list when the admin switched it on", async () => {
    await setSetting("exact.list_dc_fields", true);
    fx.receivables = [usd({ listAmountDc: 920.04, listRate: 0.92004 })];
    expect((await run("full")).status).toBe("ok");
    expect(listCalls().every((c) => (c.query?.["$select"] ?? "").includes("AmountDC,RateFC"))).toBe(
      true,
    );
    expect(await read()).toMatchObject({
      open_dc_minor: 92004,
      dc_currency: "EUR",
      rate: "0.92004",
    });
  });

  it("a 400 on the extended $select degrades to the plain read, once, and is remembered for 7 days", async () => {
    await setSetting("exact.list_dc_fields", true);
    fx.rejectSelect = "AmountDC";
    fx.receivables = [usd({ listAmountDc: 920 })];

    // baseline: how many calls a plain run costs
    await setSetting("exact.list_dc_fields", false);
    await run("full");
    const plain = exactCalls();
    fx.calls = [];
    await setSetting("exact.list_dc_fields", true);

    const first = await run("full");
    expect(first.status).toBe("ok");
    // one extra call per list (receivables, payables): the refused request
    expect(exactCalls()).toBe(plain + 2);
    expect(
      listCalls().filter((c) => (c.query?.["$select"] ?? "").includes("AmountDC")),
    ).toHaveLength(1);
    expect(await read()).toMatchObject({ status: "open" });
    const mark = await db
      .prepare(
        "SELECT unavailable_until FROM sync_state WHERE division_id = ?1 AND entity = 'receivables'",
      )
      .bind(div.id)
      .first<{ unavailable_until: string }>();
    expect(Date.parse(mark?.unavailable_until ?? "")).toBe(clock + LIST_DC_UNAVAILABLE_MS);

    // the next night: remembered, not even tried
    clock += 24 * 3600_000;
    fx.calls = [];
    expect((await run("full")).status).toBe("ok");
    expect(exactCalls()).toBe(plain);
    expect(listCalls().some((c) => (c.query?.["$select"] ?? "").includes("AmountDC"))).toBe(false);

    // after 7 days it is tried again (and refused again, once per list)
    clock += 7 * 24 * 3600_000;
    fx.calls = [];
    expect((await run("full")).status).toBe("ok");
    expect(exactCalls()).toBe(plain + 2);
  });

  it("only Exact's refusal degrades: a 500 on the list is an ordinary failure", async () => {
    await setSetting("exact.list_dc_fields", true);
    fx.receivables = [usd()];
    fx.override["/read/financial/ReceivablesList"] = () => ({
      status: 500,
      headers: {},
      body: "{}",
    });
    const r = await run("full");
    expect(r.status).not.toBe("ok");
    const mark = await db
      .prepare("SELECT unavailable_until FROM sync_state WHERE entity = 'receivables'")
      .first<{ unavailable_until: string | null }>();
    expect(mark?.unavailable_until ?? null).toBeNull();
  });

  it("an admin changing the switch forgets a remembered 400 (via the settings route)", async () => {
    await db
      .prepare(
        `INSERT INTO sync_state (division_id, entity, unavailable_until) VALUES (?1, 'receivables', ?2)`,
      )
      .bind(div.id, new Date(clock + 1000).toISOString())
      .run();
    // the route is covered in exact-sync-routes-g3; here the SQL it uses
    await db
      .prepare(
        `UPDATE sync_state SET unavailable_until = NULL
         WHERE entity IN ('receivables', 'payables') AND unavailable_until IS NOT NULL
           AND ?1 <> COALESCE((SELECT value_json FROM settings WHERE key = ?2), 'false')`,
      )
      .bind("true", "exact.list_dc_fields")
      .run();
    const mark = await db
      .prepare("SELECT unavailable_until FROM sync_state WHERE entity = 'receivables'")
      .first<{ unavailable_until: string | null }>();
    expect(mark?.unavailable_until).toBeNull();
  });
});

describe("computing the booked amount from a verified rate direction (B1b option 3)", () => {
  it("does nothing while the direction is unset", async () => {
    fx.receivables = [usd({ amountDc: undefined, listRate: undefined })];
    await run("incremental"); // stores the rate 0.92 but no DC amount
    expect(await read()).toMatchObject({ rate: "0.92", open_dc_minor: null });
    fx.receivables = [usd({ amount: 400, amountDc: undefined })];
    await run("full");
    expect(await read()).toMatchObject({ open_minor: 40000, open_dc_minor: null });
  });

  it("base_per_foreign: open amount x stored rate, in the division currency", async () => {
    await setSetting("exact.rate_direction", "base_per_foreign");
    fx.receivables = [usd({ amountDc: undefined })];
    await run("incremental");
    fx.receivables = [usd({ amount: 400, amountDc: undefined })];
    await run("full");
    expect(await read()).toMatchObject({
      open_minor: 40000,
      open_dc_minor: 36800,
      dc_currency: "EUR",
    });
  });

  it("foreign_per_base: open amount / stored rate", async () => {
    await setSetting("exact.rate_direction", "foreign_per_base");
    fx.receivables = [usd({ amountDc: undefined, rate: 1.25 })];
    await run("incremental");
    fx.receivables = [usd({ amount: 500, amountDc: undefined, rate: 1.25 })];
    await run("full");
    expect(await read()).toMatchObject({ open_dc_minor: 40000, dc_currency: "EUR" });
  });

  it("needs a rate: an item never read by a sync endpoint stays without a booked amount", async () => {
    await setSetting("exact.rate_direction", "base_per_foreign");
    fx.receivables = [usd({ amountDc: undefined, rate: undefined })];
    await run("full");
    expect(await read()).toMatchObject({ rate: null, open_dc_minor: null });
  });

  it("an amount the sync endpoint gave wins over the computed one, and EUR items are untouched", async () => {
    await setSetting("exact.rate_direction", "base_per_foreign");
    fx.receivables = [
      usd({ amountDc: 919.99 }),
      usd({
        n: 2,
        currency: "EUR",
        amount: 50,
        original: 50,
        amountDc: 50,
        rate: 1,
        invoiceNumber: 2,
      }),
    ];
    await run("incremental");
    await run("full");
    const rows = (
      await db
        .prepare(
          "SELECT currency, open_dc_minor FROM open_items WHERE division_id = ?1 ORDER BY currency",
        )
        .bind(div.id)
        .all<{ currency: string; open_dc_minor: number | null }>()
    ).results;
    expect(rows).toEqual([
      { currency: "EUR", open_dc_minor: 5000 },
      { currency: "USD", open_dc_minor: 91999 },
    ]);
  });

  it("spends no extra Exact calls", async () => {
    fx.receivables = [usd({ amountDc: undefined })];
    await run("incremental");
    fx.calls = [];
    await run("full");
    const without = exactCalls();
    await setSetting("exact.rate_direction", "base_per_foreign");
    fx.calls = [];
    await run("full");
    expect(exactCalls()).toBe(without);
  });
});
