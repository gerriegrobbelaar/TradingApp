import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ExactApiError, ExactBudgetExhaustedError } from "@camelthorn/exact";
import { LEDGER_PASS_MAX_AGE_MS, reportingYear } from "../src/exact/ledger-sync";
import {
  CYCLE_MAX_AGE_MS,
  syncDivision,
  type DivisionRef,
  type SyncOptions,
  type SyncSummary,
} from "../src/exact/sync";
import {
  FakeExact,
  addDivision,
  db,
  fakeGate,
  resetSync,
  type FakeBalance,
  type FakeGate,
  type FakeGlAccount,
} from "./sync-helpers";

/**
 * Review K2 of the ledger sync: split keys, passes that outlive a full cycle, the Amsterdam year
 * boundary, empty answers and which errors may mark budgets unavailable.
 */
const T0 = Date.parse("2026-07-15T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let clock = T0;
let div: DivisionRef & { name: string };
let fx: FakeExact;
let gate: FakeGate;
let n = 0;
/**
 * Exact calls before the ledger in a full run: divisions, receivables, payables, relations
 * and the (empty) purchase-entry read, which runs before the ledger (review K4, ADR 0025). The IBAN
 * read is switched off in these runs (see `run`).
 */
const PRE = 5;

beforeEach(async () => {
  await resetSync();
  await db.prepare("DELETE FROM settings WHERE key = 'exact.prior_year_nightly_until_month'").run();
  div = await addDivision();
  fx = new FakeExact(div.exactDivision);
  fx.divisions = [{ code: div.exactDivision, description: "BV" }];
  gate = fakeGate();
  clock = T0;
});

const run = (over: Partial<SyncOptions> = {}): Promise<SyncSummary> =>
  syncDivision(
    env,
    div,
    // IBANs off: their place in the order depends on their own age (fullSyncOrder, tested in
    // exact-sync-resume.test.ts) and would shift the call counts these ledger tests rely on.
    {
      jobId: `ledger-review-${++n}`,
      mode: "full",
      actor: "system",
      budget: 10_000,
      readIbans: false,
      ...over,
    },
    { transport: fx.transport, gate, now: () => clock },
  );

function budgeted(budget: number): void {
  fx.calls = [];
  fx.beforeCall = (call) => {
    if (call > budget) throw new ExactBudgetExhaustedError("x");
  };
}
const unlimited = (): void => {
  fx.calls = [];
  fx.beforeCall = () => undefined;
};

const chart = (count: number): FakeGlAccount[] =>
  Array.from({ length: count }, (_, i) => ({
    n: i + 1,
    code: String(1000 + i),
    name: `Account ${i + 1}`,
    side: i % 2 === 0 ? "D" : "C",
    bt: i >= count / 2 ? "W" : "B",
  }));
const balances = (count: number, year: number, periods = 2): FakeBalance[] =>
  Array.from({ length: count * periods }, (_, k) => ({
    account: Math.floor(k / periods) + 1,
    year,
    period: (k % periods) + 1,
    amount: k + 1,
  }));

const count = async (table: string, where = "1 = 1"): Promise<number> =>
  (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE division_id = ?1 AND ${where}`)
      .bind(div.id)
      .first<{ n: number }>()
  )?.n ?? 0;
const yearRow = (entity: string, year: number) =>
  db
    .prepare(
      "SELECT completed_at, rows_read, split_keys, cycle FROM gl_sync_years WHERE division_id = ?1 AND entity = ?2 AND year = ?3",
    )
    .bind(div.id, entity, year)
    .first<{ completed_at: string; rows_read: number; split_keys: number; cycle: number }>();
const balanceCalls = (year: number): string[] =>
  fx.calls
    .filter(
      (c) =>
        c.path === "/financial/ReportingBalance" &&
        c.query?.["$filter"] === `ReportingYear eq ${year}`,
    )
    .map((c) => c.query?.["$skiptoken"] ?? "");
const state = (entity: string) =>
  db
    .prepare("SELECT * FROM sync_state WHERE division_id = ?1 AND entity = ?2")
    .bind(div.id, entity)
    .first<{
      pass_token: string | null;
      pass_seq: number | null;
      pass_started_at: string | null;
      last_error: string | null;
      unavailable_until: string | null;
      cycle_seq: number | null;
    }>();

describe("the same key twice in one read (a field we do not read splits the figure)", () => {
  beforeEach(() => {
    fx.glAccounts = chart(2);
  });

  it("adds and flags a key repeated inside one chunk", async () => {
    fx.pageSize = 100;
    fx.glBalances = [
      { account: 1, year: 2026, period: 1, amount: 10, costcenter: "CC1" },
      { account: 1, year: 2026, period: 1, amount: 4, costcenter: "CC1" },
      { account: 2, year: 2026, period: 1, amount: -14, costcenter: "CC1" },
    ];
    await run();
    expect((await yearRow("gl_balances", 2026))?.split_keys).toBe(1);
    expect(await count("gl_balances", "split_key = 1 AND amount_minor = 1400")).toBe(1);
  });

  it("flags a key repeated across chunks, keeping the later figure (a re-served page must not count twice)", async () => {
    fx.pageSize = 1;
    fx.glBalances = [
      { account: 1, year: 2026, period: 1, amount: 10, status: "50" },
      { account: 2, year: 2026, period: 1, amount: -14, status: "50" },
      { account: 1, year: 2026, period: 1, amount: 4, status: "50" },
    ];
    await run({ chunkPages: 1 });
    expect((await yearRow("gl_balances", 2026))?.split_keys).toBe(1);
    expect(await count("gl_balances", "split_key = 1 AND amount_minor = 400")).toBe(1);
    // a clean read the next night clears the flag
    clock += DAY;
    fx.glBalances = fx.glBalances.slice(0, 2);
    unlimited();
    await run({ chunkPages: 1 });
    expect((await yearRow("gl_balances", 2026))?.split_keys).toBe(0);
    expect(await count("gl_balances", "split_key = 1")).toBe(0);
  });

  it("keeps different statuses and cost centres apart (no flag)", async () => {
    fx.pageSize = 1;
    fx.glBalances = [
      { account: 1, year: 2026, period: 1, amount: 10, status: "20" },
      { account: 1, year: 2026, period: 1, amount: 5, status: "50" },
      { account: 1, year: 2026, period: 1, amount: 3, status: "50", costcenter: "CC9" },
      { account: 2, year: 2026, period: 1, amount: -18, status: "50" },
    ];
    await run({ chunkPages: 1 });
    expect((await yearRow("gl_balances", 2026))?.split_keys).toBe(0);
    expect(await count("gl_balances", "gl_account_exact_id LIKE '%7001'")).toBe(3);
    const sum = await db
      .prepare("SELECT SUM(amount_minor) AS s FROM gl_balances WHERE division_id = ?1")
      .bind(div.id)
      .first<{ s: number }>();
    expect(sum?.s).toBe(0);
  });

  it("keeps cost units apart too", async () => {
    fx.pageSize = 100;
    fx.glBalances = [
      { account: 1, year: 2026, period: 1, amount: 10, costcenter: "CC1", costunit: "U1" },
      { account: 1, year: 2026, period: 1, amount: 5, costcenter: "CC1", costunit: "U2" },
      { account: 2, year: 2026, period: 1, amount: -15 },
    ];
    await run();
    expect((await yearRow("gl_balances", 2026))?.split_keys).toBe(0);
    expect(await count("gl_balances", "dimension IN ('|CC1|U1', '|CC1|U2')")).toBe(2);
  });

  it("does not flag a chunk that is read again after its batch was lost", async () => {
    fx.pageSize = 1;
    fx.glBalances = balances(2, 2026, 2); // 4 rows, 4 pages
    // Stop after the second balance page; then pretend the progress of that chunk was lost (as
    // if the run died between the rows and the token): the next run reads that page again.
    budgeted(PRE + 2 + 2);
    await run({ chunkPages: 1 });
    const st = await state("gl_balances");
    expect(st?.pass_token).toBe("2026:2");
    await db
      .prepare(
        "UPDATE sync_state SET pass_token = '2026:1', pass_rows = 1 WHERE division_id = ?1 AND entity = 'gl_balances'",
      )
      .bind(div.id)
      .run();
    unlimited();
    await run({ chunkPages: 1 });
    expect((await yearRow("gl_balances", 2026))?.split_keys).toBe(0);
    expect(await count("gl_balances")).toBe(4);
  });
});

describe("a ledger pass may outlive the 36-hour cycle (large ledgers)", () => {
  beforeEach(() => {
    fx.pageSize = 2;
    fx.glAccounts = chart(4); // 2 pages
    fx.glBalances = [...balances(4, 2026, 3), ...balances(4, 2025, 3)]; // 6 pages a year
  });

  it("continues the saved pass in the next cycle instead of starting it again", async () => {
    // Night 1: everything before the ledger, the chart, then 2 pages of 2026.
    budgeted(PRE + 2 + 2);
    const a = await run({ chunkPages: 1 });
    expect(a.entities.gl_balances.status).toBe("partial");
    const passSeq = (await state("gl_balances"))?.pass_seq;
    expect(passSeq).not.toBeNull();
    // Two nights later the cycle has expired: a new one starts, but the balances continue.
    clock += 2 * DAY;
    expect(2 * DAY).toBeGreaterThan(CYCLE_MAX_AGE_MS);
    unlimited();
    const b = await run({ chunkPages: 1 });
    expect(b.status).toBe("ok");
    expect(b.cycleComplete).toBe(true);
    const tokens2026 = balanceCalls(2026);
    expect(tokens2026[0]).toBe("4"); // resumed after row 4, not from the first page
    expect(tokens2026).not.toContain("");
    expect(await count("gl_balances", "year = 2026")).toBe(12);
    // the rows read two nights ago were seen by this pass: nothing struck
    expect(await count("gl_balances", "missed_cycles > 0")).toBe(0);
  });

  it("strikes only rows the pass never saw, judged from the pass's own start", async () => {
    unlimited();
    await run({ chunkPages: 1 });
    expect(await count("gl_balances", "year = 2026")).toBe(12);
    // Next week: a row disappears, and the read is split over two cycles.
    clock += 8 * DAY;
    fx.glBalances = fx.glBalances.filter((b) => !(b.year === 2026 && b.account === 4));
    budgeted(PRE + 2 + 1);
    await run({ chunkPages: 1 });
    clock += 2 * DAY;
    unlimited();
    await run({ chunkPages: 1 });
    // 3 rows gone; carried across runs, so they get one strike and stay for now
    expect(await count("gl_balances", "year = 2026 AND missed_cycles = 1")).toBe(3);
    expect(await count("gl_balances", "year = 2026 AND missed_cycles = 0")).toBe(9);
  });

  it("starts again once the saved pass is older than the limit", async () => {
    budgeted(PRE + 2 + 2);
    await run({ chunkPages: 1 });
    clock += LEDGER_PASS_MAX_AGE_MS + HOUR;
    unlimited();
    await run({ chunkPages: 1 });
    expect(balanceCalls(2026)[0]).toBe("");
  });

  it("a restart starts the pass again", async () => {
    budgeted(PRE + 2 + 2);
    await run({ chunkPages: 1 });
    clock += HOUR;
    unlimited();
    await run({ chunkPages: 1, restart: true });
    expect(balanceCalls(2026)[0]).toBe("");
  });

  it("continues the previous year's pass first when it is the one that was cut off", async () => {
    // The whole of 2026 and 2 pages of 2025 in the first cycle.
    budgeted(PRE + 2 + 6 + 2);
    await run({ chunkPages: 1 });
    expect((await state("gl_balances"))?.pass_token).toMatch(/^2025:/);
    // A new cycle reads 2026 again, but only after 2025 was continued (one saved token).
    clock += 2 * DAY;
    unlimited();
    const r = await run({ chunkPages: 1 });
    expect(r.cycleComplete).toBe(true);
    expect(balanceCalls(2025)[0]).toBe("4");
    expect(balanceCalls(2026)[0]).toBe("");
    const order = fx.calls
      .filter((c) => c.path === "/financial/ReportingBalance")
      .map((c) => c.query?.["$filter"]);
    expect(order[0]).toBe("ReportingYear eq 2025");
    expect(await count("gl_balances")).toBe(24);
  });
});

describe("the weekly night needs a second attempt, which resumes", () => {
  it("does not read the current year or the first pages of the previous year again", async () => {
    fx.pageSize = 2;
    fx.glAccounts = chart(4);
    fx.glBalances = [...balances(4, 2026, 3), ...balances(4, 2025, 3)];
    unlimited();
    await run({ chunkPages: 1 });
    // A week later: the previous year is due again and the first attempt runs out of budget.
    clock += 7 * DAY + HOUR;
    budgeted(PRE + 2 + 6 + 3);
    const a = await run({ chunkPages: 1 });
    expect(a.status).toBe("partial");
    // the 4th page of 2025 is the call the budget refused (recorded, not read)
    expect(balanceCalls(2025)).toEqual(["", "2", "4", "6"]);
    // The scheduler's retry five minutes later.
    clock += 5 * 60_000;
    unlimited();
    const b = await run({ chunkPages: 1 });
    expect(b.cycleComplete).toBe(true);
    expect(balanceCalls(2026)).toEqual([]);
    expect(fx.calls.some((c) => c.path === "/financial/GLAccounts")).toBe(false);
    expect(balanceCalls(2025)).toEqual(["6", "8", "10"]);
  });
});

describe("last year's balances nightly through April (review S4): resume and month boundary", () => {
  beforeEach(() => {
    fx.pageSize = 2;
    fx.glAccounts = chart(4); // 2 pages
    fx.glBalances = [...balances(4, 2027, 3), ...balances(4, 2026, 3)]; // 6 pages a year
  });

  it("a February night that does not fit one attempt resumes last year in the retry, not from the start", async () => {
    clock = Date.parse("2027-02-09T01:00:00Z");
    unlimited();
    expect((await run({ chunkPages: 1 })).cycleComplete).toBe(true);
    // Next night: chart, all of 2027, then 3 pages of 2026 before the budget ends.
    clock = Date.parse("2027-02-10T01:00:00Z");
    budgeted(PRE + 2 + 6 + 3);
    const a = await run({ chunkPages: 1 });
    expect(a.status).toBe("partial");
    expect(balanceCalls(2026)).toEqual(["", "2", "4", "6"]);
    expect((await state("gl_balances"))?.pass_token).toBe("2026:6");
    // The scheduler's retry five minutes later continues 2026 and does not re-read 2027 or the chart.
    clock += 5 * 60_000;
    unlimited();
    const b = await run({ chunkPages: 1 });
    expect(b.cycleComplete).toBe(true);
    expect(balanceCalls(2027)).toEqual([]);
    expect(fx.calls.some((c) => c.path === "/financial/GLAccounts")).toBe(false);
    expect(balanceCalls(2026)).toEqual(["6", "8", "10"]);
    expect(await count("gl_balances", "year = 2026")).toBe(12);
    expect(await count("gl_balances", "missed_cycles > 0")).toBe(0);
  });

  it("uses the Amsterdam month: 23:59 on 30 April still reads last year, 00:00 on 1 May does not", async () => {
    clock = Date.parse("2027-04-29T22:30:00Z"); // 00:30 on 30 April (CEST)
    unlimited();
    await run({ chunkPages: 1 });
    clock = Date.parse("2027-04-30T21:59:00Z"); // 23:59 on 30 April Amsterdam, 21:59 UTC
    unlimited();
    await run({ chunkPages: 1 });
    expect(balanceCalls(2026)[0]).toBe("");
    clock = Date.parse("2027-04-30T22:00:00Z"); // 00:00 on 1 May Amsterdam, still 30 April UTC
    unlimited();
    await run({ chunkPages: 1 });
    expect(balanceCalls(2026)).toEqual([]);
    expect(balanceCalls(2027)[0]).toBe("");
  });

  it("a pass of last year cut off at 23:59 on 30 April is finished after midnight, not left for a week", async () => {
    clock = Date.parse("2027-04-29T22:30:00Z");
    unlimited();
    await run({ chunkPages: 1 });
    clock = Date.parse("2027-04-30T21:50:00Z");
    budgeted(PRE + 2 + 6 + 3);
    expect((await run({ chunkPages: 1 })).status).toBe("partial");
    expect((await state("gl_balances"))?.pass_token).toBe("2026:6");
    clock = Date.parse("2027-04-30T22:05:00Z"); // 00:05 on 1 May: the nightly rule is over
    unlimited();
    const b = await run({ chunkPages: 1 });
    expect(b.cycleComplete).toBe(true);
    expect(balanceCalls(2026)).toEqual(["6", "8", "10"]);
    expect((await state("gl_balances"))?.pass_token ?? null).toBeNull();
  });
});

describe("the Amsterdam year boundary", () => {
  beforeEach(() => {
    fx.pageSize = 100;
    fx.glAccounts = chart(4);
    fx.glBalances = [...balances(4, 2026), ...balances(4, 2025)];
  });

  it("is midnight in Amsterdam, not UTC", () => {
    expect(reportingYear(Date.parse("2026-12-31T22:59:59Z"))).toBe(2026);
    expect(reportingYear(Date.parse("2026-12-31T23:00:00Z"))).toBe(2027);
  });

  it("on 1 January reads the new year and the old one once more, then the old one weekly (nightly limit off)", async () => {
    await db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value_json, updated_by) VALUES ('exact.prior_year_nightly_until_month', '0', 't')",
      )
      .run();
    clock = Date.parse("2026-12-31T01:00:00Z"); // 31 Dec 02:00 Amsterdam
    unlimited();
    await run();
    // 1 Jan 2027 02:00 Amsterdam: the new year has no figures in Exact yet
    clock = Date.parse("2027-01-01T01:00:00Z");
    unlimited();
    const r = await run();
    expect(r.cycleComplete).toBe(true);
    expect(balanceCalls(2027)).toHaveLength(1);
    // 2026 was last read while it was the current year: once more now it has closed
    expect(balanceCalls(2026)).toHaveLength(1);
    expect(balanceCalls(2025)).toHaveLength(0);
    // the new year is recorded as read (an empty year, nothing held): the report says no_data
    expect(await yearRow("gl_balances", 2027)).toMatchObject({ rows_read: 0 });
    // the old year is still there
    expect(await count("gl_balances", "year = 2026")).toBe(8);
    // 2 January: 2026 now waits for the weekly refresh
    clock += DAY;
    unlimited();
    await run();
    expect(balanceCalls(2026)).toHaveLength(0);
    expect(balanceCalls(2027)).toHaveLength(1);
  });

  it("with the default limit (4 = April) the old year is read every night until the end of April, then weekly (review S4)", async () => {
    clock = Date.parse("2026-12-31T01:00:00Z");
    unlimited();
    await run();
    clock = Date.parse("2027-01-01T01:00:00Z");
    unlimited();
    await run();
    for (const day of ["2027-01-02", "2027-02-15", "2027-04-30"]) {
      clock = Date.parse(`${day}T01:00:00Z`);
      unlimited();
      await run();
      expect(balanceCalls(2026), day).toHaveLength(1);
    }
    // 1 May: past the limit; the last nightly read was yesterday, so it waits for the week
    clock = Date.parse("2027-05-01T01:00:00Z");
    unlimited();
    await run();
    expect(balanceCalls(2026)).toHaveLength(0);
    clock = Date.parse("2027-05-06T01:00:00Z");
    unlimited();
    await run();
    expect(balanceCalls(2026)).toHaveLength(0);
    clock = Date.parse("2027-05-08T01:00:00Z"); // 7 days after the last complete read
    unlimited();
    await run();
    expect(balanceCalls(2026)).toHaveLength(1);
  });

  it("an admin can move the limit: month 6 keeps the nightly read in June, month 0 never reads nightly", async () => {
    await db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value_json, updated_by) VALUES ('exact.prior_year_nightly_until_month', '6', 't')",
      )
      .run();
    clock = Date.parse("2027-05-31T01:00:00Z");
    unlimited();
    await run();
    clock = Date.parse("2027-06-02T01:00:00Z");
    unlimited();
    await run();
    expect(balanceCalls(2026)).toHaveLength(1);
    clock = Date.parse("2027-06-03T01:00:00Z");
    unlimited();
    await run();
    expect(balanceCalls(2026)).toHaveLength(1);
    // a malformed value falls back to the default (4): June is then weekly
    await db
      .prepare(
        "UPDATE settings SET value_json = '\"x\"' WHERE key = 'exact.prior_year_nightly_until_month'",
      )
      .run();
    clock = Date.parse("2027-06-04T01:00:00Z");
    unlimited();
    await run();
    expect(balanceCalls(2026)).toHaveLength(0);
  });

  it("a run at 00:30 Amsterdam on 1 January (still 31 December in UTC) is in the new year", async () => {
    clock = Date.parse("2026-12-31T23:30:00Z");
    unlimited();
    await run();
    expect(balanceCalls(2027)).toHaveLength(1);
    expect(balanceCalls(2026)).toHaveLength(1);
  });
});

describe("empty answers", () => {
  it("a genuinely empty ledger at the first sync completes the cycle and records the years", async () => {
    fx.pageSize = 100;
    unlimited();
    const r = await run();
    expect(r.status).toBe("ok");
    expect(r.cycleComplete).toBe(true);
    expect(await yearRow("gl_balances", 2026)).toMatchObject({ rows_read: 0 });
    expect(await yearRow("gl_balances", 2025)).toMatchObject({ rows_read: 0 });
    expect(await count("gl_accounts")).toBe(0);
  });

  it("an empty answer while we hold rows changes nothing and does not move freshness", async () => {
    fx.pageSize = 100;
    fx.glAccounts = chart(4);
    fx.glBalances = balances(4, 2026);
    unlimited();
    await run();
    const before = await yearRow("gl_balances", 2026);
    clock += DAY;
    fx.glBalances = [];
    unlimited();
    const r = await run();
    expect(r.entities.gl_balances).toMatchObject({
      status: "ok",
      error: "empty_answer_ignored",
    });
    expect(await count("gl_balances")).toBe(8);
    expect(await count("gl_balances", "missed_cycles > 0")).toBe(0);
    expect((await yearRow("gl_balances", 2026))?.completed_at).toBe(before?.completed_at);
  });
});

describe("only Exact's own refusal marks budgets unavailable", () => {
  beforeEach(() => {
    fx.pageSize = 100;
    fx.glAccounts = chart(2);
    fx.glBalances = balances(2, 2026);
  });

  for (const [label, err] of [
    ["our gate rejecting the request (400 path)", new ExactApiError(400, "invalid", "path")],
    ["a wrong gate (400 division_mismatch)", new ExactApiError(400, "wrong", "division_mismatch")],
    ["a network failure (502 network)", new ExactApiError(502, "unreachable", "network")],
    ["a gateway timeout (504)", new ExactApiError(504, "timeout")],
  ] as const) {
    it(`not after ${label}`, async () => {
      fx.beforeCall = (_n, req) => {
        if (req.path === "/budget/Budgets") throw err;
      };
      const r = await run();
      expect(r.entities.gl_budgets.status).not.toBe("skipped");
      expect((await state("gl_budgets"))?.unavailable_until ?? null).toBeNull();
      expect(r.cycleComplete).toBe(false);
    });
  }
});
