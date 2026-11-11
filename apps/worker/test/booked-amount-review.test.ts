/**
 * Review of T1 (Phase 6 review B1, ADR 0038): every transition of the booked division-currency
 * amount (open_minor, currency, open_dc_minor, dc_currency, dc_source) across the sync read, the
 * list read (with and without its optional fields) and the rate computation. The rule under test:
 * a stored booked amount is shown only for the open balance it was obtained for, an amount read
 * from Exact beats a computed one for the same balance, and the decision is one SQL statement.
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
let ts = 10;

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
  ts = 10;
});

const run = (mode: SyncMode, over: Partial<SyncOptions> = {}): Promise<SyncSummary> => {
  clock += 60_000;
  return syncDivision(
    env,
    { ...div, currency: "EUR" },
    { jobId: `booked-review-${++n}`, mode, ...over },
    { transport: fx.transport, gate, now: () => clock },
  );
};

const setSetting = (key: string, value: unknown) =>
  value === null
    ? db.prepare("DELETE FROM settings WHERE key = ?1").bind(key).run()
    : db
        .prepare(
          `INSERT INTO settings (key, value_json, updated_by) VALUES (?1, ?2, 'test')
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
        )
        .bind(key, JSON.stringify(value))
        .run();

/** A USD item; `ts` moves on every call so the incremental read sees it as changed. */
const usd = (over: Partial<FakeItem> = {}): FakeItem => ({
  n: 1,
  account: 1,
  name: "Acme",
  amount: 1000,
  currency: "USD",
  invoiceNumber: 1,
  ts: ++ts,
  original: 1000,
  rate: 0.92,
  ...over,
});

interface Row {
  open_minor: number;
  currency: string;
  open_dc_minor: number | null;
  dc_currency: string | null;
  dc_source: string | null;
  rate: string | null;
  status: string;
}
const read = async (): Promise<Row | null> =>
  db
    .prepare(
      `SELECT open_minor, currency, open_dc_minor, dc_currency, dc_source, rate, status
       FROM open_items WHERE division_id = ?1`,
    )
    .bind(div.id)
    .first<Row>();

describe("precedence for the same open balance: sync > list > computed", () => {
  it("a list value never replaces a sync value for the same balance", async () => {
    fx.receivables = [usd({ amountDc: 920 })];
    await run("incremental");
    expect(await read()).toMatchObject({ open_dc_minor: 92000, dc_source: "sync" });
    await setSetting("exact.list_dc_fields", true);
    // the list's AmountDC is (say) the invoice total at another rate: it must not win
    fx.receivables = [usd({ listAmountDc: 950, listRate: 0.95 })];
    await run("full");
    expect(await read()).toMatchObject({ open_dc_minor: 92000, dc_source: "sync" });
  });

  it("a sync value replaces a list value for the same balance", async () => {
    await setSetting("exact.list_dc_fields", true);
    fx.receivables = [usd({ listAmountDc: 950, listRate: 0.95 })];
    await run("full");
    expect(await read()).toMatchObject({ open_dc_minor: 95000, dc_source: "list" });
    fx.receivables = [usd({ amountDc: 920 })];
    await run("incremental");
    expect(await read()).toMatchObject({ open_dc_minor: 92000, dc_source: "sync" });
  });

  it("a computed value never replaces one read from Exact, and is replaced by one", async () => {
    fx.receivables = [usd({ amountDc: 919.99 })];
    await run("incremental");
    await setSetting("exact.rate_direction", "base_per_foreign");
    fx.receivables = [usd()];
    await run("full");
    expect(await read()).toMatchObject({ open_dc_minor: 91999, dc_source: "sync" });

    // a part payment seen by the list only: computed for the NEW balance
    fx.receivables = [usd({ amount: 400 })];
    await run("full");
    expect(await read()).toMatchObject({
      open_minor: 40000,
      open_dc_minor: 36800,
      dc_source: "computed",
    });
    // Exact's own figure for that balance arrives: it wins
    fx.receivables = [usd({ amount: 400, amountDc: 367.5 })];
    await run("incremental");
    expect(await read()).toMatchObject({ open_dc_minor: 36750, dc_source: "sync" });
    // and a later list pass (computing 368.00 again) keeps Exact's figure
    await run("full");
    expect(await read()).toMatchObject({ open_dc_minor: 36750, dc_source: "sync" });
  });

  it("a list value replaces a computed one for the same balance", async () => {
    await setSetting("exact.rate_direction", "base_per_foreign");
    fx.receivables = [usd()];
    await run("incremental"); // rate only (no AmountDC in this sync row)
    await run("full");
    expect(await read()).toMatchObject({ open_dc_minor: 92000, dc_source: "computed" });
    await setSetting("exact.list_dc_fields", true);
    fx.receivables = [usd({ listAmountDc: 921 })];
    await run("full");
    expect(await read()).toMatchObject({ open_dc_minor: 92100, dc_source: "list" });
  });
});

describe("a changed open balance never keeps a stale booked amount", () => {
  it("credit note: a negative open amount computes a negative booked amount", async () => {
    await setSetting("exact.rate_direction", "foreign_per_base");
    fx.receivables = [usd({ amount: -1234.56, original: -1234.56, rate: 1.087 })];
    await run("incremental");
    await run("full");
    // -1,234.56 / 1.087 = -1,135.7498... -> -1,135.75
    expect(await read()).toMatchObject({ open_dc_minor: -113575, dc_source: "computed" });
  });

  it("closed, then reopened with its old amount: the closed 0 is not carried over", async () => {
    fx.receivables = [usd({ amountDc: 920 })];
    await run("incremental");
    fx.receivables = [usd({ amount: 0, amountDc: 0, fullyPaid: true })];
    await run("incremental");
    expect(await read()).toMatchObject({ status: "closed", open_minor: 0, open_dc_minor: 0 });
    // reopened (payment reversed), seen by the list only, no direction set
    fx.receivables = [usd()];
    await run("full");
    expect(await read()).toMatchObject({
      status: "open",
      open_minor: 100000,
      open_dc_minor: null,
      dc_currency: null,
      dc_source: null,
    });
  });

  it("a currency change takes the new read's amount, or none", async () => {
    fx.receivables = [usd({ amountDc: 920 })];
    await run("incremental");
    await setSetting("exact.list_dc_fields", true);
    fx.receivables = [usd({ currency: "GBP", listAmountDc: 1150 })];
    await run("full");
    expect(await read()).toMatchObject({
      currency: "GBP",
      open_dc_minor: 115000,
      dc_source: "list",
    });
    await setSetting("exact.list_dc_fields", false);
    fx.receivables = [usd({ currency: "USD" })];
    await run("full");
    expect(await read()).toMatchObject({ currency: "USD", open_dc_minor: null, dc_source: null });
  });

  // Four seeds of 20 reads each (one test per seed keeps each well under the default timeout
  // when the whole suite runs in parallel); what they visited is checked after the last one.
  const visited = new Set<string>();
  it.each([20261111, 7, 4242, 99])(
    "random sequences (seed %i): a stored amount always belongs to the current balance and best source",
    async (seed) => {
      // Model: for the current (currency, open amount), the amounts each source gave since the
      // balance last changed. The stored amount must be the best source's latest value, or null
      // when no source gave one. Reads are random: sync with/without AmountDC, list with/without
      // fields, with/without a rate direction, amounts and currencies changing.
      let x = seed;
      const rnd = (k: number) => {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        return (x >>> 16) % k; // the high bits: an LCG's low bits cycle quickly
      };
      const rank: Record<string, number> = { sync: 3, list: 2, computed: 1 };
      let key = "";
      let given: Record<string, number> = {};
      const seen = visited;
      for (let step = 0; step < 20; step++) {
        // mostly the same balance again (where precedence matters), sometimes a new one
        const keep = key !== "" && rnd(10) < 7;
        const amount = keep ? Number(key.split("|")[1]) : ([1000, 400, -250][rnd(3)] as number);
        const currency = keep
          ? (key.split("|")[0] as string)
          : (["USD", "USD", "GBP"][rnd(3)] as string);
        const op = rnd(4);
        const dcMajor = (amount * (90 + rnd(10))) / 100;
        const newKey = `${currency}|${amount}`;
        if (newKey !== key) {
          key = newKey;
          given = {};
        }
        if (op === 0) {
          // incremental sync read, with or without AmountDC
          const withDc = rnd(2) === 0;
          fx.receivables = [usd({ amount, currency, ...(withDc ? { amountDc: dcMajor } : {}) })];
          await run("incremental");
          if (withDc) given["sync"] = Math.round(dcMajor * 100);
        } else if (op === 1) {
          await setSetting("exact.list_dc_fields", true);
          await setSetting("exact.rate_direction", null);
          fx.receivables = [usd({ amount, currency, listAmountDc: dcMajor })];
          await run("full");
          given["list"] = Math.round(dcMajor * 100);
        } else if (op === 2) {
          await setSetting("exact.list_dc_fields", false);
          await setSetting("exact.rate_direction", null);
          fx.receivables = [usd({ amount, currency })];
          await run("full");
        } else {
          await setSetting("exact.list_dc_fields", false);
          await setSetting("exact.rate_direction", "base_per_foreign");
          fx.receivables = [usd({ amount, currency })];
          await run("full");
          // computed only when a rate is stored for this currency (the sync rows carry 0.92)
          const r = await read();
          if (r?.rate === "0.92") given["computed"] = Math.round(amount * 92);
        }
        const row = await read();
        seen.add(`op${op}`).add(row?.dc_source ?? "none");
        if (row === null) continue;
        expect(`${row.currency}|${row.open_minor / 100}`, `step ${step}`).toBe(key);
        const best = Object.keys(given).sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0];
        if (best === undefined) {
          expect(row.open_dc_minor, `step ${step}`).toBeNull();
          expect(row.dc_source, `step ${step}`).toBeNull();
        } else {
          expect(row.dc_source, `step ${step}`).toBe(best);
          expect(row.open_dc_minor, `step ${step}`).toBe(given[best]);
          expect(row.dc_currency, `step ${step}`).toBe("EUR");
        }
      }
    },
  );

  it("the random sequences together visited every read kind and every outcome", () => {
    // the sequence really visited every read kind and every outcome
    expect([...visited].sort()).toEqual(
      ["computed", "list", "none", "op0", "op1", "op2", "op3", "sync"].sort(),
    );
  });
});

describe("the list-fields degrade path (option 1)", () => {
  it("a 400 that the plain read gets too is not about the fields: nothing is remembered", async () => {
    await setSetting("exact.list_dc_fields", true);
    fx.receivables = [usd()];
    fx.override["/read/financial/ReceivablesList"] = () => ({
      status: 400,
      headers: {},
      body: '{"error":{"message":{"value":"Bad filter"}}}',
    });
    const r = await run("full");
    expect(r.status).not.toBe("ok");
    const mark = await db
      .prepare(
        "SELECT unavailable_until FROM sync_state WHERE division_id = ?1 AND entity = 'receivables'",
      )
      .bind(div.id)
      .first<{ unavailable_until: string | null }>();
    expect(mark?.unavailable_until ?? null).toBeNull();
  });

  it("a restart run whose fields are accepted again forgets the remembered 400", async () => {
    await setSetting("exact.list_dc_fields", true);
    fx.rejectSelect = "AmountDC";
    fx.receivables = [usd({ listAmountDc: 920 })];
    await run("full");
    const until = async () =>
      (
        await db
          .prepare(
            "SELECT unavailable_until AS u FROM sync_state WHERE division_id = ?1 AND entity = 'receivables'",
          )
          .bind(div.id)
          .first<{ u: string | null }>()
      )?.u ?? null;
    expect(Date.parse((await until()) ?? "")).toBe(clock + LIST_DC_UNAVAILABLE_MS);
    fx.rejectSelect = undefined;
    await run("full", { restart: true });
    expect(await until()).toBeNull();
    expect(await read()).toMatchObject({ open_dc_minor: 92000, dc_source: "list" });
  });
});
