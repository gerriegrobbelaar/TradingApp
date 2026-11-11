import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ExactApiError, ExactBudgetExhaustedError } from "@camelthorn/exact";
import { isInvoiceApprovedForPayment, type ApprovalStatus } from "@camelthorn/core";
import {
  CURSOR_FUTURE_LIMIT_MS,
  CURSOR_MARGIN_MS,
  INCREMENTAL_MAX_CHUNKS,
  PURCHASE_UNAVAILABLE_MS,
} from "../src/exact/purchase-sync";
import {
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
  type FakePurchase,
} from "./sync-helpers";

/**
 * The purchase-entry sync (task K4, ADR 0025): a resumable windowed pass in FULL cycles, a cheap
 * Modified-cursor read in hourly INCREMENTAL runs. The clock is fixed at 15 July 2026, so the
 * 120-day window starts on 17 March 2026.
 */
const PATH = "/purchaseentry/PurchaseEntries";
const T0 = Date.parse("2026-07-15T10:00:00Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
let clock = T0;
let div: DivisionRef & { name: string };
let fx: FakeExact;
let gate: FakeGate;
let n = 0;

beforeEach(async () => {
  await resetSync();
  div = await addDivision();
  fx = new FakeExact(div.exactDivision);
  fx.divisions = [{ code: div.exactDivision, description: "BV" }];
  gate = fakeGate();
  clock = T0;
});

const run = (mode: SyncMode, over: Partial<SyncOptions> = {}): Promise<SyncSummary> =>
  syncDivision(
    env,
    div,
    { jobId: `purchase-${++n}`, mode, actor: "system", budget: 10_000, ...over },
    { transport: fx.transport, gate, now: () => clock },
  );

const purchaseCalls = (): number => fx.calls.filter((c) => c.path === PATH).length;

const entry = (k: number, over: Partial<FakePurchase> = {}): FakePurchase => ({
  n: k,
  supplier: k,
  amount: 100 + k,
  status: 5,
  entryDate: T0 - 10 * DAY,
  modified: T0 - DAY + k * 1000,
  doc: true,
  ...over,
});

interface DbRow {
  exact_id: string;
  entry_number: string | null;
  relation_id: string | null;
  relation_name: string | null;
  currency: string;
  amount_minor: number;
  amount_dc_minor: number | null;
  dc_currency: string | null;
  entry_date: string | null;
  due_date: string | null;
  status_code: number | null;
  status: string;
  submitted_at: string | null;
  modified_at: string | null;
  has_pdf: number | null;
  search_text: string | null;
  missed_cycles: number;
  last_seen_sync_id: number | null;
}
const rows = async (): Promise<DbRow[]> =>
  (
    await db
      .prepare("SELECT * FROM purchase_entries WHERE division_id = ?1 ORDER BY exact_id")
      .bind(div.id)
      .all<DbRow>()
  ).results;
const byNumber = async (k: number): Promise<DbRow | undefined> =>
  (await rows()).find((r) => r.exact_id.endsWith(String(8000 + k).padStart(12, "0")));
const state = () =>
  db
    .prepare("SELECT * FROM sync_state WHERE division_id = ?1 AND entity = 'purchase_entries'")
    .bind(div.id)
    .first<{
      cursor: string;
      last_status: string | null;
      last_error: string | null;
      last_completed_at: string | null;
      unavailable_until: string | null;
      pass_token: string | null;
      pass_rows: number;
      done_cycle: number | null;
    }>();

describe("full read", () => {
  it("reads the window and everything pending, maps statuses, never guesses approved", async () => {
    fx.purchases = [
      entry(1, { name: "  Acme B.V. ", dueDate: T0 + 20 * DAY }),
      entry(2, { status: 50, entryDate: T0 - 30 * DAY, modified: T0 - 20 * DAY, doc: false }),
      entry(3, { status: 77, doc: undefined }),
      // outside the window and not pending: never read
      entry(4, { status: 50, entryDate: T0 - 200 * DAY, modified: T0 - 200 * DAY }),
      // outside the window but still pending: read
      entry(5, { status: 5, entryDate: T0 - 200 * DAY, modified: T0 - 200 * DAY }),
      entry(6, { currency: "USD", amount: 50.25, amountDc: 45, status: null }),
    ];
    const r = await run("full");
    expect(r.status).toBe("ok");
    expect(r.cycleComplete).toBe(true);
    const e = r.entities.purchase_entries;
    expect(e).toMatchObject({ status: "ok", rows: 5, cycleDone: true });
    expect(e.calls).toBe(3); // 5 rows, 2 per page

    const all = await rows();
    expect(all).toHaveLength(5);
    expect(await byNumber(4)).toBeUndefined();
    const status = async (k: number): Promise<string | undefined> => (await byNumber(k))?.status;
    expect(await Promise.all([1, 2, 3, 5, 6].map(status))).toEqual([
      "pending_approval",
      "approved",
      "unknown",
      "pending_approval",
      "unknown",
    ]);
    expect(await byNumber(3)).toMatchObject({ status_code: 77, status: "unknown", has_pdf: null });
    expect(await byNumber(6)).toMatchObject({ status_code: null, status: "unknown" });
    expect(await byNumber(2)).toMatchObject({ has_pdf: 0 });
    expect(await byNumber(1)).toMatchObject({
      entry_number: "70001",
      relation_id: "00000000-0000-0000-0000-000000000001",
      relation_name: "Acme B.V.",
      currency: "EUR",
      amount_minor: 10100,
      amount_dc_minor: null,
      entry_date: "2026-07-05",
      due_date: "2026-08-04",
      has_pdf: 1,
      search_text: "70001\nacme b.v.",
    });
    expect(await byNumber(6)).toMatchObject({
      currency: "USD",
      amount_minor: 5025,
      amount_dc_minor: 4500,
      dc_currency: "EUR",
    });
  });

  it("sends the window and the pending codes in the filter, ordered by Modified", async () => {
    fx.purchases = [entry(1)];
    await run("full");
    const req = fx.calls.find((c) => c.path === PATH);
    expect(req?.query?.["$filter"]).toBe(
      "EntryDate ge datetime'2026-03-17T00:00:00' or Modified ge datetime'2026-03-17T00:00:00' or Status eq 5",
    );
    expect(req?.query?.["$orderby"]).toBe("Modified");
    expect(req?.query?.["$select"]).toContain("Status");
    expect(req?.priority).toBe("job");
  });

  it("starts the incremental cursor at the pass start minus a margin, and marks the cycle done", async () => {
    fx.purchases = [entry(1)];
    await run("full");
    const s = await state();
    expect(s?.cursor).toBe(String(T0 - CURSOR_MARGIN_MS));
    expect(s?.last_status).toBe("ok");
    expect(s?.last_completed_at).not.toBeNull();
    expect(s?.done_cycle).not.toBeNull();
    expect(s?.pass_token).toBeNull();
  });

  it("an empty administration is a complete, empty read", async () => {
    const r = await run("full");
    expect(r.entities.purchase_entries).toMatchObject({ status: "ok", rows: 0, calls: 1 });
    expect((await state())?.cursor).toBe(String(T0 - CURSOR_MARGIN_MS));
  });

  it("can be switched off", async () => {
    fx.purchases = [entry(1)];
    const r = await run("full", { readPurchaseEntries: false });
    expect(purchaseCalls()).toBe(0);
    expect(r.entities.purchase_entries.status).toBe("skipped");
    expect(r.cycleComplete).toBe(true);
  });
});

describe("resume", () => {
  const many = (count: number): FakePurchase[] =>
    Array.from({ length: count }, (_, i) => entry(i + 1, { modified: T0 - DAY + i * 1000 }));

  it("continues from the saved $skiptoken in the next run and loses nothing", async () => {
    fx.purchases = many(23); // 12 pages of 2
    let seen = 0;
    fx.beforeCall = (_n, req) => {
      if (req.path === PATH && ++seen > 2) throw new ExactBudgetExhaustedError("x");
    };
    const a = await run("full");
    expect(a.status).toBe("partial");
    expect(a.entities.purchase_entries).toMatchObject({
      status: "partial",
      error: "budget_exhausted",
    });
    expect(a.cycleComplete).toBe(false);
    expect(await rows()).toHaveLength(4); // the two pages read before the stop were written
    const mid = await state();
    expect(mid?.pass_token).toBe("4"); // the fake serves offset tokens: the next page starts at row 4
    expect(mid?.pass_rows).toBe(4);
    expect(mid?.cursor).toBe("0"); // not started before a complete read
    expect(mid?.done_cycle).toBeNull();

    fx.calls = [];
    fx.beforeCall = () => undefined;
    const b = await run("full");
    expect(b.status).toBe("ok");
    expect(b.cycleComplete).toBe(true);
    // 23 rows = 12 pages; 2 were read before; the first request of the resume re-sends the token
    expect(purchaseCalls()).toBe(10);
    expect(fx.calls.find((c) => c.path === PATH)?.query?.["$skiptoken"]).toBe("4");
    expect(await rows()).toHaveLength(23);
    expect((await state())?.cursor).toBe(String(T0 - CURSOR_MARGIN_MS));
  });

  it("never removes anything before the pass is complete", async () => {
    fx.purchases = many(6);
    await run("full");
    expect(await rows()).toHaveLength(6);
    // next cycle: Exact now has only 3 entries, but the read stops after the first page
    fx.purchases = many(3);
    let seen = 0;
    fx.beforeCall = (_n, req) => {
      if (req.path === PATH && ++seen > 1) throw new ExactBudgetExhaustedError("x");
    };
    const a = await run("full", { restart: true });
    expect(a.entities.purchase_entries.status).toBe("partial");
    expect(await rows()).toHaveLength(6);
    expect((await rows()).every((r) => r.missed_cycles === 0)).toBe(true);
  });

  it("ignores a saved pass of another cycle and starts again", async () => {
    fx.purchases = many(6);
    let seen = 0;
    fx.beforeCall = (_n, req) => {
      if (req.path === PATH && ++seen > 1) throw new ExactBudgetExhaustedError("x");
    };
    await run("full");
    fx.beforeCall = () => undefined;
    fx.calls = [];
    await run("full", { restart: true }); // abandons the cycle
    expect(fx.calls.find((c) => c.path === PATH)?.query?.["$skiptoken"]).toBeUndefined();
    expect(await rows()).toHaveLength(6);
  });
});

describe("removal rules", () => {
  const ten = (): FakePurchase[] =>
    Array.from({ length: 10 }, (_, i) => entry(i + 1, { modified: T0 - DAY + i * 1000 }));

  it("deletes an entry that vanished after a complete single-run read", async () => {
    fx.purchases = ten().slice(0, 6);
    await run("full");
    expect(await rows()).toHaveLength(6);
    clock += DAY;
    fx.purchases = fx.purchases.filter((p) => p.n !== 2);
    const r = await run("full");
    expect(r.entities.purchase_entries.status).toBe("ok");
    expect(await rows()).toHaveLength(5);
    expect(await byNumber(2)).toBeUndefined();
  });

  it("needs two complete reads in a row when the read was carried over runs", async () => {
    fx.purchases = ten().slice(0, 6);
    await run("full");
    clock += DAY;
    fx.purchases = fx.purchases.filter((p) => p.n !== 2);
    // a full read that spans two runs: stop after the first page, finish in the second
    let seen = 0;
    fx.beforeCall = (_n, req) => {
      if (req.path === PATH && ++seen > 1) throw new ExactBudgetExhaustedError("x");
    };
    await run("full");
    fx.beforeCall = () => undefined;
    const done = await run("full");
    expect(done.entities.purchase_entries.status).toBe("ok");
    const after1 = await byNumber(2);
    expect(after1).toBeDefined();
    expect(after1?.missed_cycles).toBe(1);
    expect(await rows()).toHaveLength(6);
    // the next night sees it missing again, now in one run
    clock += DAY;
    await run("full");
    expect(await byNumber(2)).toBeUndefined();
  });

  it("a row seen again is forgiven (missed count back to 0)", async () => {
    fx.purchases = ten().slice(0, 6);
    await run("full");
    clock += DAY;
    const gone = fx.purchases.find((p) => p.n === 2) as FakePurchase;
    fx.purchases = fx.purchases.filter((p) => p.n !== 2);
    let seen = 0;
    fx.beforeCall = (_n, req) => {
      if (req.path === PATH && ++seen > 1) throw new ExactBudgetExhaustedError("x");
    };
    await run("full");
    fx.beforeCall = () => undefined;
    await run("full");
    expect((await byNumber(2))?.missed_cycles).toBe(1);
    clock += DAY;
    fx.purchases.push(gone);
    await run("full");
    expect((await byNumber(2))?.missed_cycles).toBe(0);
  });

  it("never removes rows outside what the read covers, and does remove a vanished pending one", async () => {
    fx.purchases = ten().slice(0, 6);
    await run("full");
    // an old approved entry (not in the window) and an old pending one (in the read's scope)
    await db.batch(
      [
        ["70", "approved", 50],
        ["71", "pending_approval", 5],
      ].map(([k, status, code]) =>
        db
          .prepare(
            `INSERT INTO purchase_entries (division_id, exact_id, currency, amount_minor, entry_date,
                 modified_at, status_code, status, synced_at, last_seen_sync_id)
               VALUES (?1, ?2, 'EUR', 100, '2026-01-02', '2026-01-03T00:00:00.000Z', ?3, ?4,
                 '2026-01-03T00:00:00Z', 1)`,
          )
          .bind(div.id, `old-${k}`, code, status),
      ),
    );
    clock += DAY;
    await run("full");
    const ids = (await rows()).map((r) => r.exact_id);
    expect(ids).toContain("old-70");
    expect(ids).not.toContain("old-71");
  });

  it("refuses to delete a large share at once (close guard) unless an admin confirms", async () => {
    fx.purchases = ten();
    await run("full");
    clock += DAY;
    fx.purchases = ten().slice(0, 2); // 8 of 10 vanish: more than max(5, 20 %)
    const a = await run("full");
    expect(a.entities.purchase_entries).toMatchObject({ status: "error", error: "close_guard" });
    expect(a.status).toBe("error");
    expect(a.cycleComplete).toBe(false);
    expect(await rows()).toHaveLength(10);
    clock += DAY;
    const b = await run("full", { allowLargeClose: true, restart: true });
    expect(b.entities.purchase_entries.status).toBe("ok");
    expect(await rows()).toHaveLength(2);
  });

  it("an answer without a single row while we hold rows changes nothing", async () => {
    fx.purchases = ten().slice(0, 3);
    await run("full");
    const cursor = (await state())?.cursor;
    clock += DAY;
    fx.purchases = [];
    const r = await run("full");
    expect(r.entities.purchase_entries).toMatchObject({
      status: "ok",
      error: "empty_answer_ignored",
    });
    expect(await rows()).toHaveLength(3);
    expect((await state())?.cursor).toBe(cursor);
  });
});

describe("incremental read", () => {
  it("does nothing before the first complete full read", async () => {
    fx.purchases = [entry(1)];
    const r = await run("incremental");
    expect(purchaseCalls()).toBe(0);
    expect(r.entities.purchase_entries).toMatchObject({ status: "skipped", error: "no_cursor" });
    expect(r.status).toBe("ok");
    expect(await rows()).toHaveLength(0);
    expect(await state()).toBeNull();
  });

  it("reads only entries modified since the cursor, and picks up an approval", async () => {
    fx.purchases = [entry(1), entry(2, { modified: T0 - 20 * DAY, status: 50 })];
    await run("full");
    expect((await byNumber(1))?.status).toBe("pending_approval");

    clock = T0 + HOUR;
    fx.calls = [];
    const p1 = fx.purchases[0] as FakePurchase;
    p1.status = 50;
    p1.modified = T0 + 30 * 60_000;
    const r = await run("incremental");
    expect(purchaseCalls()).toBe(1);
    expect(fx.calls.find((c) => c.path === PATH)?.query?.["$filter"]).toBe(
      `Modified ge datetime'${new Date(T0 - CURSOR_MARGIN_MS).toISOString().slice(0, 19)}'`,
    );
    expect(r.entities.purchase_entries).toMatchObject({ status: "ok", rows: 1 });
    expect((await byNumber(1))?.status).toBe("approved");
    expect((await byNumber(2))?.status).toBe("approved");
    expect((await state())?.cursor).toBe(String(T0 + 30 * 60_000));
    expect((await state())?.last_completed_at).not.toBeNull();

    // nothing new: one call, the same last row is read again (ge), cursor unchanged
    clock = T0 + 2 * HOUR;
    fx.calls = [];
    const again = await run("incremental");
    expect(purchaseCalls()).toBe(1);
    expect(again.entities.purchase_entries.rows).toBe(1);
    expect((await state())?.cursor).toBe(String(T0 + 30 * 60_000));
    expect(await rows()).toHaveLength(2);
  });

  it("runs before the relations, and never removes or inserts old history", async () => {
    fx.purchases = [entry(1)];
    fx.accounts = [{ n: 1, name: "S", ts: 10, supplier: true }];
    await run("full");
    clock = T0 + HOUR;
    fx.calls = [];
    await run("incremental");
    const paths = fx.calls.map((c) => c.path).filter((p, i, a) => a.indexOf(p) === i);
    expect(paths.indexOf(PATH)).toBeGreaterThan(-1);
    expect(paths.indexOf(PATH)).toBeLessThan(paths.indexOf("/sync/CRM/Accounts"));
    fx.purchases = [];
    clock += HOUR;
    await run("incremental");
    expect(await rows()).toHaveLength(1); // absence never deletes in an incremental run
  });

  it("caps a backlog at INCREMENTAL_MAX_CHUNKS chunks (10 calls) and continues next hour", async () => {
    fx.purchases = [entry(1)];
    await run("full");
    const backlog = Array.from({ length: 150 }, (_, i) =>
      entry(100 + i, { modified: T0 + (i + 1) * 1000, status: 5 }),
    );
    fx.purchases.push(...backlog);
    const before = (await state())?.last_completed_at;
    let guard = 0;
    let last: SyncSummary | undefined;
    const callsPerRun: number[] = [];
    while (guard++ < 20) {
      clock += HOUR;
      fx.calls = [];
      last = await run("incremental", { budget: 40 });
      callsPerRun.push(purchaseCalls());
      expect(purchaseCalls()).toBeLessThanOrEqual(INCREMENTAL_MAX_CHUNKS * 5);
      expect(fx.calls.length).toBeLessThanOrEqual(40);
      if (last.entities.purchase_entries.status === "ok") break;
      expect(last.entities.purchase_entries).toMatchObject({
        status: "skipped",
        error: "incremental_cap",
      });
      expect(last.status).toBe("ok"); // a backlog is not a failure
      // freshness is not claimed while the backlog is being worked off
      expect((await state())?.last_completed_at).toBe(before);
    }
    expect(last?.entities.purchase_entries.status).toBe("ok");
    expect(callsPerRun.length).toBeGreaterThan(1);
    expect(await rows()).toHaveLength(151);
    expect(Math.max(...callsPerRun)).toBe(10);
  });

  it("is skipped while unavailable and a 404 on the first page marks it", async () => {
    fx.purchases = [entry(1)];
    await run("full");
    clock += HOUR;
    fx.override[PATH] = () => ({ status: 404, headers: {}, body: "{}" });
    const r = await run("incremental");
    expect(r.entities.purchase_entries).toMatchObject({
      status: "skipped",
      error: "purchase_entries_unavailable_404",
    });
    expect(r.status).toBe("ok");
    fx.calls = [];
    clock += HOUR;
    await run("incremental");
    expect(purchaseCalls()).toBe(0);
  });
});

describe("unavailable resource", () => {
  const notFound = () => ({ status: 404, headers: {}, body: "{}" });

  it("a 404 marks the entity for a day, the cycle still completes, restart tries again", async () => {
    fx.override[PATH] = notFound;
    const a = await run("full");
    expect(a.status).toBe("ok");
    expect(a.cycleComplete).toBe(true);
    expect(a.entities.purchase_entries).toMatchObject({
      status: "skipped",
      error: "purchase_entries_unavailable_404",
    });
    const s = await state();
    expect(s?.last_error).toBe("purchase_entries_unavailable_404");
    expect(Date.parse(s?.unavailable_until ?? "")).toBe(T0 + PURCHASE_UNAVAILABLE_MS);
    expect(s?.last_completed_at).toBeNull();

    fx.calls = [];
    clock += 2 * HOUR;
    await run("full");
    expect(purchaseCalls()).toBe(0);

    fx.calls = [];
    delete fx.override[PATH];
    fx.purchases = [entry(1)];
    await run("full", { restart: true });
    expect(purchaseCalls()).toBe(1);
    expect((await state())?.unavailable_until).toBeNull();
    expect(await rows()).toHaveLength(1);
  });

  it("tries again after the day is over", async () => {
    fx.override[PATH] = notFound;
    await run("full");
    delete fx.override[PATH];
    fx.purchases = [entry(1)];
    clock += PURCHASE_UNAVAILABLE_MS + 1000;
    fx.calls = [];
    await run("full");
    expect(purchaseCalls()).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  it("a 403 and a 400 from Exact count, but our own gate's 400 does not", async () => {
    for (const code of [403, 400]) {
      await resetSync();
      div = await addDivision();
      fx = new FakeExact(div.exactDivision);
      fx.divisions = [{ code: div.exactDivision, description: "BV" }];
      fx.override[PATH] = () => ({ status: code, headers: {}, body: "{}" });
      const r = await run("full");
      expect(r.entities.purchase_entries.error).toBe(`purchase_entries_unavailable_${code}`);
    }
    await resetSync();
    div = await addDivision();
    fx = new FakeExact(div.exactDivision);
    fx.divisions = [{ code: div.exactDivision, description: "BV" }];
    fx.beforeCall = (_n, req) => {
      if (req.path === PATH) throw new ExactApiError(400, "rejected by the gate", "budget");
    };
    const r = await run("full");
    expect(r.entities.purchase_entries).toMatchObject({ status: "error", error: "budget" });
    expect((await state())?.unavailable_until ?? null).toBeNull();
    expect(r.cycleComplete).toBe(false);
  });

  it("a 500 is an ordinary failure and is not remembered", async () => {
    fx.override[PATH] = () => ({ status: 503, headers: {}, body: "{}" });
    const r = await run("full");
    expect(r.entities.purchase_entries.status).toBe("partial");
    expect((await state())?.unavailable_until ?? null).toBeNull();
  });
});

// ---- review K4 -------------------------------------------------------------------------------

describe("a run that lost its lease (review K4)", () => {
  const takeOver = async (): Promise<void> => {
    await db
      .prepare(
        "UPDATE sync_locks SET holder = 'other', run_seq = run_seq + 100 WHERE division_id = ?1",
      )
      .bind(div.id)
      .run();
  };

  it("full: writes no entry, no pass, no cursor and strikes nothing", async () => {
    fx.purchases = [entry(1), entry(2), entry(3)];
    const takeover: typeof fx.transport = async (req) => {
      if (req.path === PATH) await takeOver();
      return fx.transport(req);
    };
    await syncDivision(
      env,
      div,
      { jobId: `purchase-${++n}`, mode: "full", actor: "system", budget: 10_000 },
      { transport: takeover, gate, now: () => clock },
    );
    expect(await rows()).toHaveLength(0);
    const s = await state();
    expect(s === null || (s.cursor === "0" && s.pass_token === null)).toBe(true);
  });

  it("incremental: a status read after the takeover is not written and the cursor stays", async () => {
    fx.purchases = [entry(1, { status: 5 })];
    await run("full");
    const before = await state();
    clock = T0 + HOUR;
    const p1 = fx.purchases[0] as FakePurchase;
    p1.status = 50;
    p1.modified = T0 + 30 * 60_000;
    const takeover: typeof fx.transport = async (req) => {
      if (req.path === PATH) await takeOver();
      return fx.transport(req);
    };
    await syncDivision(
      env,
      div,
      { jobId: `purchase-${++n}`, mode: "incremental", actor: "system", budget: 40 },
      { transport: takeover, gate, now: () => clock },
    );
    expect((await byNumber(1))?.status).toBe("pending_approval");
    expect((await state())?.cursor).toBe(before?.cursor);
  });

  it("full, closing: a takeover before the close strikes and deletes nothing", async () => {
    fx.purchases = [entry(1), entry(2), entry(3), entry(4), entry(5), entry(6)];
    await run("full");
    fx.purchases.splice(0, 1);
    clock += DAY;
    let seen = 0;
    const takeover: typeof fx.transport = async (req) => {
      // the last purchase page of the pass: 5 rows at 2 a page = 3 pages
      if (req.path === PATH && ++seen === 3) {
        const res = await fx.transport(req);
        await takeOver();
        return res;
      }
      return fx.transport(req);
    };
    await syncDivision(
      env,
      div,
      { jobId: `purchase-${++n}`, mode: "full", actor: "system", budget: 10_000 },
      { transport: takeover, gate, now: () => clock },
    );
    expect(await rows()).toHaveLength(6);
    expect((await rows()).every((r) => r.missed_cycles === 0)).toBe(true);
  });
});

describe("status changes reach the cache (review K4)", () => {
  it("approved -> waiting again is picked up by the next hourly run", async () => {
    fx.purchases = [entry(1, { status: 50 })];
    await run("full");
    expect((await byNumber(1))?.status).toBe("approved");
    clock = T0 + HOUR;
    const p1 = fx.purchases[0] as FakePurchase;
    p1.status = 5;
    p1.modified = T0 + 20 * 60_000;
    await run("incremental");
    expect(await byNumber(1)).toMatchObject({ status: "pending_approval", status_code: 5 });
    // and to a code the table does not list: unknown, not approved
    clock += HOUR;
    p1.status = 31;
    p1.modified = clock - 60_000;
    await run("incremental");
    expect(await byNumber(1)).toMatchObject({ status: "unknown", status_code: 31 });
  });

  it("a pending entry older than the window that gets approved stays tracked", async () => {
    fx.purchases = [entry(1, { status: 5, entryDate: T0 - 300 * DAY, modified: T0 - 300 * DAY })];
    await run("full");
    expect((await byNumber(1))?.status).toBe("pending_approval");
    clock = T0 + HOUR;
    const p1 = fx.purchases[0] as FakePurchase;
    p1.status = 50;
    p1.modified = T0 + 30 * 60_000; // approving it is a change
    await run("incremental");
    expect((await byNumber(1))?.status).toBe("approved");
    for (let d = 1; d <= 3; d++) {
      clock = T0 + d * DAY;
      await run("full");
    }
    expect((await byNumber(1))?.status).toBe("approved");
  });

  it("if approving did not touch Modified, the old row is dropped, never kept as pending or guessed", async () => {
    fx.purchases = [
      entry(1, { status: 5, entryDate: T0 - 300 * DAY, modified: T0 - 300 * DAY }),
      ...[2, 3, 4, 5, 6].map((k) => entry(k)),
    ];
    await run("full");
    (fx.purchases[0] as FakePurchase).status = 50; // Modified unchanged: the window misses it
    clock = T0 + DAY;
    await run("full");
    expect(await byNumber(1)).toBeUndefined();
  });

  it("an approved row that left the scope is no longer refreshed and stops counting for payment", async () => {
    fx.purchases = [entry(1, { status: 50, entryDate: T0 - 100 * DAY, modified: T0 - 100 * DAY })];
    await run("full");
    const asPayment = async (nowMs: number): Promise<boolean> => {
      const r = await db
        .prepare(
          `SELECT status, status_code, synced_at, missed_cycles FROM purchase_entries
           WHERE division_id = ?1`,
        )
        .bind(div.id)
        .first<{
          status: ApprovalStatus;
          status_code: number | null;
          synced_at: string;
          missed_cycles: number;
        }>();
      if (!r) return false;
      return isInvoiceApprovedForPayment(
        {
          status: r.status,
          statusCode: r.status_code,
          lastSeenAt: r.synced_at,
          missedCycles: r.missed_cycles,
        },
        { nowMs, mappingVerified: true },
      );
    };
    expect(await asPayment(clock)).toBe(true);
    // 30 days later the entry is 130 days old: no longer read, row kept but not refreshed
    clock = T0 + 30 * DAY;
    await run("full");
    expect((await byNumber(1))?.status).toBe("approved");
    expect(await asPayment(clock)).toBe(false);
  });
});

describe("cursor rules (review K4)", () => {
  it("a later complete full read moves the cursor forward, never back; restart may reset it", async () => {
    fx.purchases = [entry(1)];
    await run("full");
    expect((await state())?.cursor).toBe(String(T0 - CURSOR_MARGIN_MS));
    // an hourly run moves it to the last Modified read
    clock = T0 + HOUR;
    const p1 = fx.purchases[0] as FakePurchase;
    p1.modified = T0 + 50 * 60_000;
    await run("incremental");
    expect((await state())?.cursor).toBe(String(T0 + 50 * 60_000));
    // the next night's pass starts later: the cursor follows it
    clock = T0 + DAY;
    await run("full");
    expect((await state())?.cursor).toBe(String(T0 + DAY - CURSOR_MARGIN_MS));
    // a manual full run whose pass started earlier than the cursor does not move it back
    await db
      .prepare(
        "UPDATE sync_state SET cursor = ?2 WHERE division_id = ?1 AND entity = 'purchase_entries'",
      )
      .bind(div.id, String(T0 + 3 * DAY))
      .run();
    clock = T0 + 2 * DAY;
    await run("full");
    expect((await state())?.cursor).toBe(String(T0 + 3 * DAY));
    // restart sets it to the pass start (re-reads, idempotent)
    clock = T0 + 2 * DAY + HOUR;
    await run("full", { restart: true });
    expect((await state())?.cursor).toBe(String(clock - CURSOR_MARGIN_MS));
  });

  it("frees a cursor the hourly cap cannot move (more same-second changes than the cap reads)", async () => {
    fx.purchases = [entry(1)];
    await run("full");
    const same = T0 + 10 * 60_000;
    fx.purchases.push(...Array.from({ length: 25 }, (_, i) => entry(200 + i, { modified: same })));
    for (let h = 1; h <= 3; h++) {
      clock = T0 + h * HOUR;
      const r = await run("incremental", { budget: 40 });
      expect(r.entities.purchase_entries.error).toBe("incremental_cap");
    }
    expect((await state())?.cursor).toBe(String(same));
    clock = T0 + DAY;
    await run("full");
    expect((await state())?.cursor).toBe(String(T0 + DAY - CURSOR_MARGIN_MS));
    clock += HOUR;
    const r = await run("incremental", { budget: 40 });
    expect(r.entities.purchase_entries.status).toBe("ok");
  });

  it("a far-future Modified does not park the cursor more than 3 hours ahead", async () => {
    fx.purchases = [entry(1)];
    await run("full");
    clock = T0 + HOUR;
    fx.purchases.push(entry(2, { modified: Date.parse("2099-01-01T00:00:00Z") }));
    await run("incremental");
    expect(Number((await state())?.cursor)).toBe(clock + CURSOR_FUTURE_LIMIT_MS);
    // a real change after that point is read by the hourly run
    const p1 = fx.purchases[0] as FakePurchase;
    p1.status = 50;
    p1.modified = T0 + HOUR + CURSOR_FUTURE_LIMIT_MS + 60_000;
    clock = p1.modified + 5 * 60_000;
    await run("incremental");
    expect((await byNumber(1))?.status).toBe("approved");
  });

  it("the full read runs before the ledger, so a long ledger cannot starve it", async () => {
    fx.purchases = [entry(1)];
    fx.glAccounts = [{ n: 1, code: "1000", name: "Bank" }];
    let ledgerSeen = false;
    let purchaseBeforeLedger = false;
    fx.beforeCall = (_n, req) => {
      if (req.path.startsWith("/financial/") || req.path.startsWith("/budget/")) ledgerSeen = true;
      if (req.path === PATH && !ledgerSeen) purchaseBeforeLedger = true;
    };
    await run("full");
    expect(purchaseBeforeLedger).toBe(true);
  });
});
