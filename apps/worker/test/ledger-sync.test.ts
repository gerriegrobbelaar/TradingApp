import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ExactApiError, ExactBudgetExhaustedError } from "@camelthorn/exact";
import {
  BUDGETS_UNAVAILABLE_MS,
  LEDGER_REFRESH_MS,
  estimateLedgerCalls,
} from "../src/exact/ledger-sync";
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
  type FakeBalance,
  type FakeBudget,
  type FakeGate,
  type FakeGlAccount,
} from "./sync-helpers";

/**
 * The ledger sync (task K2, ADR 0023): chart of accounts, reporting balances (current and
 * previous year) and optional budgets, read in resumable passes inside FULL cycles. The clock is
 * fixed in July 2026, so the reporting year is 2026 and the previous one 2025.
 */
const T0 = Date.parse("2026-07-15T10:00:00Z");
const DAY = 86_400_000;
let clock = T0;
let div: DivisionRef & { name: string };
let fx: FakeExact;
let gate: FakeGate;
let n = 0;
/** Exact calls before the ledger in a full run: divisions, receivables, payables, relations, IBANs. */
const PRE = 5;

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
    { jobId: `ledger-${++n}`, mode, actor: "system", budget: 10_000, ...over },
    { transport: fx.transport, gate, now: () => clock },
  );

/** The next run may spend `budget` Exact calls; the call after the last one is refused. */
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
    type: i < count / 2 ? 12 : undefined,
  }));
const balances = (count: number, year: number, periods = 12, base = 1): FakeBalance[] =>
  Array.from({ length: count * periods }, (_, k) => {
    const account = Math.floor(k / periods) + 1;
    const period = (k % periods) + 1;
    return {
      account,
      year,
      period,
      amount: ((account * 7 + period) % 90) + base,
      bt: account > count / 2 ? "W" : "B",
    };
  });
const budgetsFor = (count: number, year: number, periods = 12): FakeBudget[] =>
  balances(count, year, periods)
    .filter((b) => b.bt === "W")
    .map((b) => ({ account: b.account, year, period: b.period, amount: b.amount }));

const count = async (table: string, where = "1 = 1"): Promise<number> =>
  (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE division_id = ?1 AND ${where}`)
      .bind(div.id)
      .first<{ n: number }>()
  )?.n ?? 0;
const state = (entity: string) =>
  db
    .prepare("SELECT * FROM sync_state WHERE division_id = ?1 AND entity = ?2")
    .bind(div.id, entity)
    .first<{
      last_status: string | null;
      last_error: string | null;
      last_completed_at: string | null;
      pass_token: string | null;
      pass_cycle: number | null;
      pass_rows: number;
      done_cycle: number | null;
      unavailable_until: string | null;
      cycle_seq: number | null;
      last_full_completed_at: string | null;
    }>();
const calls = (path: string): number => fx.calls.filter((c) => c.path === path).length;
const years = async (entity: string): Promise<Record<number, string>> =>
  Object.fromEntries(
    (
      await db
        .prepare(
          "SELECT year, completed_at FROM gl_sync_years WHERE division_id = ?1 AND entity = ?2",
        )
        .bind(div.id, entity)
        .all<{ year: number; completed_at: string }>()
    ).results.map((r) => [r.year, r.completed_at]),
  );
const accountState = async (): Promise<Record<string, { active: number; missed: number }>> =>
  Object.fromEntries(
    (
      await db
        .prepare("SELECT code, is_active, missed_cycles FROM gl_accounts WHERE division_id = ?1")
        .bind(div.id)
        .all<{ code: string; is_active: number; missed_cycles: number }>()
    ).results.map((r) => [r.code, { active: r.is_active, missed: r.missed_cycles }]),
  );

describe.each([
  { label: "pages of 60", size: 60, accountCalls: 5, balanceCalls: 60, budgetCalls: 30 },
  { label: "pages of 1,000", size: 1000, accountCalls: 1, balanceCalls: 4, budgetCalls: 2 },
])("a full cycle with $label (300 accounts, 12 periods, two years)", (p) => {
  beforeEach(() => {
    fx.listPageSize = p.size;
    fx.glAccounts = chart(300);
    fx.glBalances = [...balances(300, 2026), ...balances(300, 2025)];
    fx.glBudgets = budgetsFor(300, 2026);
  });

  it("reads everything inside the 240-call run budget and writes it", async () => {
    budgeted(240);
    const r = await run("full", { budget: 240 });
    expect(r.status).toBe("ok");
    expect(r.cycleComplete).toBe(true);
    expect(calls("/financial/GLAccounts")).toBe(p.accountCalls);
    // two years of balances (3,600 rows each) and the budgets of 150 profit and loss accounts
    expect(calls("/financial/ReportingBalance")).toBe(2 * p.balanceCalls);
    expect(calls("/budget/Budgets")).toBe(p.budgetCalls);
    expect(fx.calls.length).toBeLessThanOrEqual(240);
    expect(fx.calls.length).toBe(PRE + p.accountCalls + 2 * p.balanceCalls + p.budgetCalls);
    expect(await count("gl_accounts")).toBe(300);
    expect(await count("gl_balances")).toBe(7200);
    expect(await count("gl_balances", "year = 2025")).toBe(3600);
    expect(await count("gl_budgets")).toBe(1800);
    expect(Object.keys(await years("gl_balances")).sort()).toEqual(["2025", "2026"]);
    expect(Object.keys(await years("gl_budgets"))).toEqual(["2026"]);
    expect((await state("gl_accounts"))?.last_completed_at).not.toBeNull();
    expect((await state("run"))?.last_full_completed_at).not.toBeNull();
  }, 60_000);

  it("the next night reads only the chart and the current year", async () => {
    await run("full");
    clock += DAY;
    unlimited();
    const r = await run("full");
    expect(r.status).toBe("ok");
    expect(calls("/financial/GLAccounts")).toBe(p.accountCalls);
    expect(calls("/financial/ReportingBalance")).toBe(p.balanceCalls);
    expect(calls("/budget/Budgets")).toBe(0);
    // the call arithmetic of the ADR: 5 + 60 = 65 calls at pages of 60
    expect(calls("/financial/GLAccounts") + calls("/financial/ReportingBalance")).toBe(
      estimateLedgerCalls({ accounts: 300, balanceYears: 1, pageSize: p.size }),
    );
  }, 60_000);
});

describe("call arithmetic", () => {
  it("estimates 300 accounts x 12 periods", () => {
    expect(estimateLedgerCalls({ accounts: 300, balanceYears: 1 })).toBe(65);
    expect(estimateLedgerCalls({ accounts: 300, balanceYears: 2, budgetAccounts: 150 })).toBe(155);
    expect(estimateLedgerCalls({ accounts: 300, balanceYears: 1, pageSize: 1000 })).toBe(5);
  });
});

describe("resumable across runs", () => {
  beforeEach(() => {
    fx.pageSize = 2;
    fx.glAccounts = chart(10);
    fx.glBalances = [...balances(10, 2026, 3), ...balances(10, 2025, 3)];
    fx.glBudgets = budgetsFor(10, 2026, 3);
  });

  it("continues from the saved $skiptoken and never rereads a page inside a cycle", async () => {
    const seen: string[] = [];
    let runs = 0;
    for (; runs < 60; runs++) {
      const spend = PRE + 3;
      budgeted(spend);
      const r = await run("full");
      // the call that hit the budget was refused, so it is not a page read
      for (const c of fx.calls.slice(0, spend)) {
        if (c.path.startsWith("/financial") || c.path.startsWith("/budget")) {
          seen.push(`${c.path}|${c.query?.["$filter"] ?? ""}|${c.query?.["$skiptoken"] ?? ""}`);
        }
      }
      if (r.cycleComplete) break;
      expect(r.status).toBe("partial");
    }
    expect(runs).toBeGreaterThan(2);
    expect(new Set(seen).size).toBe(seen.length); // no page twice
    expect(await count("gl_accounts")).toBe(10);
    expect(await count("gl_balances")).toBe(60);
    expect(await count("gl_budgets")).toBe(15);
  }, 60_000);

  it("holds the year in the saved token while a year of balances is partly read", async () => {
    // the chart is 5 pages of 2; then 2 pages of the current year's balances
    budgeted(PRE + 5 + 2);
    const r = await run("full", { chunkPages: 1 });
    expect(r.entities.gl_accounts.status).toBe("ok");
    expect(r.entities.gl_balances.status).toBe("partial");
    const bal = await state("gl_balances");
    expect(bal?.pass_token).toMatch(/^2026:/);
    expect(bal?.pass_rows).toBeGreaterThan(0);
    expect(bal?.pass_cycle).not.toBeNull();
  });
});

describe("rows Exact stops returning", () => {
  beforeEach(async () => {
    fx.pageSize = 100;
    fx.glAccounts = chart(10);
    fx.glBalances = balances(10, 2026, 2);
    await run("full");
    expect(await count("gl_accounts", "is_active = 1")).toBe(10);
    clock += DAY;
  });

  it("marks an account inactive (kept, not deleted) after a complete single-run read", async () => {
    fx.glAccounts = fx.glAccounts.filter((a) => a.n !== 4);
    unlimited();
    await run("full");
    const a = await accountState();
    expect(a["1003"]).toEqual({ active: 0, missed: 1 });
    expect(await count("gl_accounts")).toBe(10);
    expect(await count("gl_accounts", "is_active = 1")).toBe(9);
    // its balances are Exact's to remove; the chart marking does not touch them
    expect(
      await count("gl_balances", "gl_account_exact_id = '00000000-0000-0000-0000-000000007004'"),
    ).toBe(2);
  });

  it("reactivates an account that comes back", async () => {
    fx.glAccounts = fx.glAccounts.filter((a) => a.n !== 4);
    await run("full");
    clock += DAY;
    fx.glAccounts = chart(10);
    await run("full");
    expect((await accountState())["1003"]).toEqual({ active: 1, missed: 0 });
  });

  it("changes nothing after a partial read", async () => {
    fx.glAccounts = fx.glAccounts.filter((a) => a.n !== 4);
    fx.pageSize = 2;
    budgeted(PRE + 2); // stops inside the chart (5 pages of 2)
    const r = await run("full", { chunkPages: 1 });
    expect(r.entities.gl_accounts.status).toBe("partial");
    expect(await count("gl_accounts", "is_active = 1")).toBe(10);
    expect((await accountState())["1003"]).toEqual({ active: 1, missed: 0 });
  });

  it("needs two complete reads when the read was carried across runs", async () => {
    fx.glAccounts = fx.glAccounts.filter((a) => a.n !== 4);
    fx.pageSize = 2;
    // Cycle 1: split over two runs.
    budgeted(PRE + 2);
    await run("full", { chunkPages: 1 });
    budgeted(500);
    const done = await run("full", { chunkPages: 1 });
    expect(done.entities.gl_accounts.status).not.toBe("partial");
    expect((await accountState())["1003"]).toEqual({ active: 1, missed: 1 });
    // Cycle 2, split again: the second strike inactivates it.
    clock += DAY;
    budgeted(PRE + 2);
    await run("full", { chunkPages: 1 });
    budgeted(500);
    await run("full", { chunkPages: 1 });
    expect((await accountState())["1003"]).toEqual({ active: 0, missed: 2 });
  });

  it("a replayed finish inside one cycle does not strike twice", async () => {
    fx.glAccounts = fx.glAccounts.filter((a) => a.n !== 4);
    // The chart is read in one page and finished, then the run runs out of budget in the balances
    // so the cycle stays open.
    budgeted(PRE + 1);
    const a = await run("full");
    expect(a.entities.gl_accounts.status).toBe("ok");
    expect(a.cycleComplete).toBe(false);
    expect((await accountState())["1003"]).toEqual({ active: 0, missed: 1 });
    // Simulate a crash before the entity was marked done: the chart is read and finished again.
    await db
      .prepare(
        "UPDATE sync_state SET done_cycle = NULL WHERE division_id = ?1 AND entity = 'gl_accounts'",
      )
      .bind(div.id)
      .run();
    budgeted(500);
    await run("full");
    expect((await accountState())["1003"]).toEqual({ active: 0, missed: 1 });
  });

  it("deletes a balance row that is gone after a complete read and keeps the rest", async () => {
    fx.glBalances = fx.glBalances.filter((b) => !(b.account === 2 && b.period === 2));
    unlimited();
    await run("full");
    expect(await count("gl_balances")).toBe(19);
  });

  it("an empty answer changes nothing", async () => {
    fx.glAccounts = [];
    fx.glBalances = [];
    unlimited();
    const r = await run("full");
    expect(r.entities.gl_accounts.status).toBe("ok");
    expect(await count("gl_accounts", "is_active = 1")).toBe(10);
    expect(await count("gl_balances")).toBe(20);
  });

  it("refuses to inactivate a large share at once, unless an admin allows it", async () => {
    fx.glAccounts = fx.glAccounts.slice(0, 3); // 7 of 10 gone: more than max(5, 20 %)
    unlimited();
    const r = await run("full");
    expect(r.entities.gl_accounts).toMatchObject({ status: "error", error: "close_guard" });
    expect(r.status).toBe("error");
    expect(await count("gl_accounts", "is_active = 1")).toBe(10);
    unlimited();
    const ok = await run("full", { allowLargeClose: true });
    expect(ok.entities.gl_accounts.status).toBe("ok");
    expect(await count("gl_accounts", "is_active = 1")).toBe(3);
  });
});

describe("lease and run_seq guards", () => {
  it("a run that lost its lease saves no progress and strikes nothing", async () => {
    fx.pageSize = 100;
    fx.glAccounts = chart(6);
    await run("full");
    const before = await state("gl_accounts");
    clock += DAY;
    fx.glAccounts = fx.glAccounts.filter((a) => a.n !== 2);
    // Another run takes the division's lease before this one reads anything.
    const lost = fakeGate({
      startJob: async () => {
        await db
          .prepare(
            "UPDATE sync_locks SET holder = 'someone-else', run_seq = run_seq + 1 WHERE division_id = ?1",
          )
          .bind(div.id)
          .run();
      },
    });
    await syncDivision(
      env,
      div,
      { jobId: "lost-lease", mode: "full", budget: 10_000 },
      { transport: fx.transport, gate: lost, now: () => clock },
    );
    expect((await accountState())["1001"]).toEqual({ active: 1, missed: 0 });
    const after = await state("gl_accounts");
    expect(after?.done_cycle).toBe(before?.done_cycle);
    expect(after?.pass_cycle).toBe(before?.pass_cycle);
  });

  it("an older run cannot overwrite a row a newer run has seen", async () => {
    fx.glAccounts = chart(2);
    await db
      .prepare(
        `INSERT INTO gl_accounts (division_id, exact_id, code, name, is_active, last_seen_sync_id, updated_at)
         VALUES (?1, '00000000-0000-0000-0000-000000007001', '1000', 'Newer name', 1, 1000000, '2026-01-01T00:00:00Z')`,
      )
      .bind(div.id)
      .run();
    await run("full");
    const row = await db
      .prepare(
        "SELECT name, last_seen_sync_id FROM gl_accounts WHERE division_id = ?1 AND code = '1000'",
      )
      .bind(div.id)
      .first<{ name: string; last_seen_sync_id: number }>();
    expect(row).toEqual({ name: "Newer name", last_seen_sync_id: 1000000 });
  });
});

describe("previous year and budgets run at most weekly", () => {
  beforeEach(() => {
    fx.pageSize = 100;
    fx.glAccounts = chart(6);
    fx.glBalances = [...balances(6, 2026, 2), ...balances(6, 2025, 2)];
    fx.glBudgets = budgetsFor(6, 2026, 2);
  });

  it("reads the previous year and the budgets on the first run, then only after a week", async () => {
    await run("full");
    expect(calls("/financial/ReportingBalance")).toBe(2);
    expect(calls("/budget/Budgets")).toBe(1);
    for (let day = 1; day <= 6; day++) {
      clock += DAY;
      unlimited();
      await run("full");
      expect(
        fx.calls.filter(
          (c) =>
            c.path === "/financial/ReportingBalance" &&
            c.query?.["$filter"] === "ReportingYear eq 2025",
        ),
      ).toHaveLength(0);
      expect(calls("/budget/Budgets")).toBe(0);
      expect(
        fx.calls.filter(
          (c) =>
            c.path === "/financial/ReportingBalance" &&
            c.query?.["$filter"] === "ReportingYear eq 2026",
        ),
      ).toHaveLength(1);
    }
    clock += LEDGER_REFRESH_MS;
    unlimited();
    await run("full");
    expect(fx.calls.filter((c) => c.query?.["$filter"] === "ReportingYear eq 2025")).toHaveLength(
      1,
    );
    expect(calls("/budget/Budgets")).toBe(1);
  });

  it("starts the new year when the calendar turns over", async () => {
    await run("full");
    clock = Date.parse("2027-01-05T10:00:00Z");
    unlimited();
    fx.glBalances = [...fx.glBalances, ...balances(6, 2027, 1)];
    await run("full");
    const balanceCalls = (year: number): number =>
      fx.calls.filter(
        (c) =>
          c.path === "/financial/ReportingBalance" &&
          c.query?.["$filter"] === `ReportingYear eq ${year}`,
      ).length;
    // 2027 was never read; 2026 is now the previous year and was last read 174 days ago; 2025 is
    // no longer asked for.
    expect(Object.keys(await years("gl_balances")).sort()).toEqual(["2025", "2026", "2027"]);
    expect(balanceCalls(2027)).toBe(1);
    expect(balanceCalls(2026)).toBe(1);
    expect(balanceCalls(2025)).toBe(0);
    // budgets follow the new year
    expect(Object.keys(await years("gl_budgets")).sort()).toEqual(["2026", "2027"]);
  });

  it("the hourly incremental run never reads ledger data", async () => {
    unlimited();
    await run("incremental");
    expect(
      fx.calls.some((c) => c.path.startsWith("/financial") || c.path.startsWith("/budget")),
    ).toBe(false);
    expect(await count("gl_accounts")).toBe(0);
  });

  it("can be switched off for a run (readLedger: false)", async () => {
    unlimited();
    const r = await run("full", { readLedger: false });
    expect(r.cycleComplete).toBe(true);
    expect(
      fx.calls.some((c) => c.path.startsWith("/financial") || c.path.startsWith("/budget")),
    ).toBe(false);
  });
});

describe("budgets are optional", () => {
  beforeEach(() => {
    fx.pageSize = 100;
    fx.glAccounts = chart(6);
    fx.glBalances = balances(6, 2026, 2);
  });

  for (const code of [400, 403, 404]) {
    it(`marks budgets unavailable for a week after a first-page ${code} and carries on`, async () => {
      fx.override["/budget/Budgets"] = () => ({
        status: code,
        headers: {},
        body: `{"error":{"code":"","message":{"lang":"","value":"no"}}}`,
      });
      const r = await run("full");
      expect(r.status).toBe("ok");
      expect(r.cycleComplete).toBe(true);
      expect(r.entities.gl_budgets).toMatchObject({
        status: "skipped",
        error: `budgets_unavailable_${code}`,
      });
      const st = await state("gl_budgets");
      expect(Date.parse(st?.unavailable_until ?? "")).toBe(T0 + BUDGETS_UNAVAILABLE_MS);
      expect(st?.last_error).toBe(`budgets_unavailable_${code}`);
      // the rest of the ledger was written and counts as a complete full sync
      expect(await count("gl_balances")).toBe(12);
      expect((await state("run"))?.last_full_completed_at).not.toBeNull();

      // Not tried again for a week...
      clock += 6 * DAY;
      unlimited();
      fx.override["/budget/Budgets"] = () => {
        throw new Error("budgets must not be read");
      };
      const next = await run("full");
      expect(next.status).toBe("ok");
      expect(calls("/budget/Budgets")).toBe(0);
      expect(next.entities.gl_budgets.error).toBe("budgets_unavailable");

      // ...then tried again, and cleared once it works.
      clock += 2 * DAY;
      delete fx.override["/budget/Budgets"];
      fx.glBudgets = budgetsFor(6, 2026, 2);
      unlimited();
      const again = await run("full");
      expect(again.entities.gl_budgets.status).toBe("ok");
      expect((await state("gl_budgets"))?.unavailable_until).toBeNull();
      expect(await count("gl_budgets")).toBe(6);
    });
  }

  it("a restart tries the budgets at once", async () => {
    fx.override["/budget/Budgets"] = () => ({ status: 404, headers: {}, body: "" });
    await run("full");
    delete fx.override["/budget/Budgets"];
    fx.glBudgets = budgetsFor(6, 2026, 2);
    unlimited();
    clock += 60_000;
    const r = await run("full", { restart: true });
    expect(r.entities.gl_budgets.status).toBe("ok");
    expect(await count("gl_budgets")).toBe(6);
  });

  it("a server error is an ordinary failure, not 'no budgets'", async () => {
    fx.beforeCall = (_n, req) => {
      if (req.path === "/budget/Budgets") throw new ExactApiError(500, "boom", "http_500");
    };
    const r = await run("full");
    expect(r.entities.gl_budgets.status).not.toBe("skipped");
    expect((await state("gl_budgets"))?.unavailable_until ?? null).toBeNull();
  });

  it("a 400 on a later page (a stale token) is not 'no budgets'", async () => {
    fx.pageSize = 1;
    fx.glBudgets = budgetsFor(6, 2026, 2); // 6 rows
    let budgetCalls = 0;
    fx.beforeCall = (_n, req) => {
      if (req.path === "/budget/Budgets" && ++budgetCalls === 3) {
        fx.override["/budget/Budgets"] = () => ({ status: 400, headers: {}, body: "" });
      }
    };
    const r = await run("full", { chunkPages: 1 });
    expect(r.entities.gl_budgets.status).toBe("error");
    expect((await state("gl_budgets"))?.unavailable_until ?? null).toBeNull();
    // the failing token is dropped so the cycle does not retry it forever
    expect((await state("gl_budgets"))?.pass_token).toBeNull();
  });
});

describe("division currency scale", () => {
  async function ledgerFor(currency: string, amount: number, spec: string) {
    await resetSync();
    const d = await addDivision();
    const f = new FakeExact(d.exactDivision);
    f.divisions = [{ code: d.exactDivision, description: "BV", currency }];
    f.pageSize = 100;
    f.glAccounts = [{ n: 1, code: "1100", name: "Bank", side: "D", type: 12 }];
    f.glBalances = [{ account: 1, year: 2026, period: 1, amount }];
    await syncDivision(
      env,
      d,
      { jobId: `scale-${++n}`, mode: "full", budget: 1000 },
      { transport: f.transport, gate: fakeGate(), now: () => clock },
    );
    const row = await db
      .prepare(
        "SELECT amount_minor, debit_minor, credit_minor, currency FROM gl_balances WHERE division_id = ?1",
      )
      .bind(d.id)
      .first<{
        amount_minor: number;
        debit_minor: number;
        credit_minor: number;
        currency: string;
      }>();
    expect(row, spec).not.toBeNull();
    return row;
  }

  it("reads yen without decimals, euro with 2 and dinar with 3", async () => {
    expect(await ledgerFor("JPY", 123456, "yen")).toEqual({
      amount_minor: 123456,
      debit_minor: 123456,
      credit_minor: 0,
      currency: "JPY",
    });
    expect(await ledgerFor("EUR", 1234.5, "euro")).toMatchObject({
      amount_minor: 123450,
      currency: "EUR",
    });
    expect(await ledgerFor("KWD", -1234.567, "dinar")).toEqual({
      amount_minor: -1234567,
      debit_minor: 0,
      credit_minor: 1234567,
      currency: "KWD",
    });
  });
});

describe("split rows", () => {
  it("keeps cost-centre splits as separate rows and adds duplicates inside a chunk", async () => {
    fx.pageSize = 100;
    fx.glAccounts = chart(2);
    fx.glBalances = [
      { account: 1, year: 2026, period: 1, amount: 10, costcenter: "CC1" },
      { account: 1, year: 2026, period: 1, amount: 5, costcenter: "CC2" },
      { account: 1, year: 2026, period: 1, amount: 2, costcenter: "CC2" }, // same key: added
      { account: 2, year: 2026, period: 1, amount: -3 },
    ];
    await run("full");
    const rows = (
      await db
        .prepare(
          "SELECT dimension, amount_minor FROM gl_balances WHERE division_id = ?1 ORDER BY dimension, amount_minor",
        )
        .bind(div.id)
        .all<{ dimension: string; amount_minor: number }>()
    ).results;
    expect(rows).toEqual([
      { dimension: "", amount_minor: -300 },
      { dimension: "|CC1", amount_minor: 1000 },
      { dimension: "|CC2", amount_minor: 700 },
    ]);
  });
});

describe("the cycle", () => {
  it("is not complete, and the full sync not counted, until the ledger is read", async () => {
    fx.pageSize = 100;
    fx.glAccounts = chart(4);
    fx.glBalances = balances(4, 2026, 2);
    budgeted(2); // divisions + the relations page; the ledger has to wait
    const a = await run("full");
    expect(a.status).toBe("partial");
    expect(a.cycleComplete).toBe(false);
    expect((await state("run"))?.last_full_completed_at ?? null).toBeNull();
    expect((await state("run"))?.cycle_seq).not.toBeNull();
    unlimited();
    const b = await run("full");
    expect(b.cycleComplete).toBe(true);
    expect(b.entities.gl_accounts.status).toBe("ok");
    expect((await state("run"))?.last_full_completed_at).not.toBeNull();
    expect((await state("gl_accounts"))?.done_cycle).not.toBeNull();
  });

  it("writes the ledger entities into the run's audit row", async () => {
    fx.pageSize = 100;
    fx.glAccounts = chart(2);
    await run("full");
    const row = await db
      .prepare(
        "SELECT after_json FROM audit_log WHERE action = 'exact.sync' ORDER BY id DESC LIMIT 1",
      )
      .first<{ after_json: string }>();
    const after = JSON.parse(row?.after_json ?? "{}") as {
      entities: Record<string, { status: string }>;
    };
    expect(Object.keys(after.entities)).toEqual(
      expect.arrayContaining(["gl_accounts", "gl_balances", "gl_budgets"]),
    );
    expect(after.entities["gl_accounts"]?.status).toBe("ok");
  });
});
