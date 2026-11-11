import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  amsterdamParts,
  type BalanceSheet,
  type BalanceSheetLine,
  type BalanceSheetSectionResult,
  type LedgerFreshnessEntry,
  type LedgerPeriodRow,
  type LedgerAccountRow,
  type Pair,
  type ProfitLoss,
  type ProfitLossFigures,
  type ProfitLossLine,
  type ProfitLossSectionResult,
  type Variance,
  type BalanceSheetResponse,
  type LedgerAccountBalancesResponse,
  type LedgerAccountsResponse,
  type ProfitLossResponse,
} from "@camelthorn/core";
import { addSession, addUser, authed, call, resetDb } from "./helpers";
import { resetExact, seedConnection } from "./exact-helpers";

const db = env.DB;
const tokens: Record<string, string> = {};
const now = (): { year: number; month: number } => {
  const [y, m] = amsterdamParts(Date.now()).date.split("-");
  return { year: Number(y), month: Number(m) };
};
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

let divA = 0;
let divB = 0;
let divOff = 0;
const G = (n: number): string => `00000000-0000-0000-0000-${String(7000 + n).padStart(12, "0")}`;

async function addDivision(connection: number, name: string, currency = "EUR"): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO divisions (connection_id, exact_division, name, base_currency, sync_enabled,
         base_currency_read_at) VALUES (?1, ?2, ?3, ?4, 1, '2026-01-01T00:00:00.000Z')`,
    )
    .bind(connection, Math.floor(Math.random() * 1e9), name, currency)
    .run();
  return r.meta.last_row_id;
}

interface Acc {
  n: number;
  code: string | null;
  name: string;
  type?: number | null;
  desc?: string | null;
  side?: "D" | "C" | null;
  bt?: "B" | "W" | null;
  active?: number;
}
const CHART: Acc[] = [
  { n: 1, code: "1100", name: "Bank", type: 12, side: "D", bt: "B" },
  { n: 2, code: "1300", name: "Receivables", type: 20, side: "D", bt: "B" },
  { n: 3, code: "1600", name: "Creditors", type: 22, side: "C", bt: "B" },
  { n: 4, code: "0500", name: "Share capital", type: 40, desc: "Equity", side: "C", bt: "B" },
  { n: 5, code: "4000", name: "Consulting revenue", side: "C", bt: "W" },
  { n: 6, code: "6000", name: "Salaries", side: "D", bt: "W" },
  { n: 7, code: "9999", name: "Mystery", desc: "Other", side: "D", bt: "B" },
];

async function addAccounts(division: number, accounts: Acc[] = CHART): Promise<void> {
  await db.batch(
    accounts.map((a) =>
      db
        .prepare(
          `INSERT INTO gl_accounts (division_id, exact_id, code, name, type, type_description,
             balance_side, balance_type, is_active, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '2026-01-01T00:00:00Z')`,
        )
        .bind(
          division,
          G(a.n),
          a.code,
          a.name,
          a.type ?? null,
          a.desc ?? null,
          a.side ?? null,
          a.bt === undefined ? "B" : a.bt,
          a.active ?? 1,
        ),
    ),
  );
}

/** [account, year, period, cents]; every period nets to zero. Same ledger as the core tests. */
const LEDGER: [number, number, number, number][] = [
  [1, 2026, 0, 10000],
  [2, 2026, 0, 5000],
  [3, 2026, 0, -3000],
  [4, 2026, 0, -12000],
  [1, 2026, 1, 2000],
  [5, 2026, 1, -5000],
  [6, 2026, 1, 3000],
  [1, 2026, 2, 1500],
  [5, 2026, 2, -2500],
  [6, 2026, 2, 1000],
  [1, 2026, 3, 100],
  [5, 2026, 3, -100],
  [1, 2025, 0, 8000],
  [4, 2025, 0, -8000],
  [1, 2025, 1, 1000],
  [5, 2025, 1, -4000],
  [6, 2025, 1, 3000],
  [1, 2025, 12, 500],
  [5, 2025, 12, -500],
];

async function addBalances(
  division: number,
  rows: [number, number, number, number][] = LEDGER,
  currency = "EUR",
): Promise<void> {
  const types = new Map(CHART.map((a) => [a.n, a.bt ?? null]));
  for (let i = 0; i < rows.length; i += 90) {
    await db.batch(
      rows.slice(i, i + 90).map(([a, y, p, c]) =>
        db
          .prepare(
            `INSERT INTO gl_balances (division_id, gl_account_exact_id, year, period, dimension,
               amount_minor, debit_minor, credit_minor, currency, balance_type, updated_at)
             VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?7, ?8, ?9, '2026-01-01T00:00:00Z')`,
          )
          .bind(
            division,
            G(a),
            y,
            p,
            c,
            c > 0 ? c : 0,
            c < 0 ? -c : 0,
            currency,
            types.get(a) ?? null,
          ),
      ),
    );
  }
}

async function addBudgets(
  division: number,
  rows: [number, number, number, number, string?][],
): Promise<void> {
  await db.batch(
    rows.map(([a, y, p, c, scenario]) =>
      db
        .prepare(
          `INSERT INTO gl_budgets (division_id, gl_account_exact_id, year, period, scenario, dimension,
             amount_minor, currency, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, 'EUR', '2026-01-01T00:00:00Z')`,
        )
        .bind(division, G(a), y, p, scenario ?? "", c),
    ),
  );
}

async function markSynced(
  division: number,
  opts: {
    years?: number[];
    budgetYears?: number[];
    accountsAt?: string | null;
    balancesAt?: string;
    budgetsAt?: string;
  } = {},
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (const y of opts.years ?? [2026, 2025]) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO gl_sync_years (division_id, entity, year, completed_at, cycle) VALUES (?1, 'gl_balances', ?2, ?3, 1)",
        )
        .bind(division, y, opts.balancesAt ?? hoursAgo(1)),
    );
  }
  for (const y of opts.budgetYears ?? []) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO gl_sync_years (division_id, entity, year, completed_at, cycle) VALUES (?1, 'gl_budgets', ?2, ?3, 1)",
        )
        .bind(division, y, opts.budgetsAt ?? hoursAgo(30)),
    );
  }
  if (opts.accountsAt !== null) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO sync_state (division_id, entity, mode, last_status, last_completed_at)
           VALUES (?1, 'gl_accounts', 'full', 'ok', ?2)`,
        )
        .bind(division, opts.accountsAt ?? hoursAgo(1)),
    );
  }
  await db.batch(stmts);
}

const get = async <T>(path: string, who = "admin"): Promise<{ status: number; body: T }> => {
  const res = await authed(path, tokens[who] as string);
  return { status: res.status, body: (await res.json()) as T };
};

beforeEach(async () => {
  await resetDb();
  await resetExact();
  for (const [key, email, roles] of [
    ["admin", "gerrie.grobbelaar@camelthorncapital.com", ["admin"]],
    ["finance", "fin@camelthorncapital.com", ["finance"]],
    ["viewer", "v@camelthorncapital.com", ["viewer"]],
    ["approver", "ap@camelthorncapital.com", ["approver"]],
  ] as const) {
    tokens[key] = await addSession(await addUser(email, [...roles]));
  }
  const conn = await seedConnection();
  const off = await db
    .prepare(
      "INSERT INTO connections (kind, name, status) VALUES ('exact', 'exact-off', 'disabled')",
    )
    .run();
  divA = await addDivision(conn, "Alpha BV");
  divB = await addDivision(conn, "Beta BV");
  divOff = await addDivision(off.meta.last_row_id, "Gamma BV");
});

const PATHS = [
  "/api/reports/balance-sheet?year=2026&period=2",
  "/api/reports/profit-loss?year=2026&periodTo=2",
  "/api/ledger/accounts",
  "/api/ledger/accounts/1/balances?year=2026",
];

describe("access and validation", () => {
  it("rejects anonymous callers", async () => {
    for (const p of PATHS) expect((await call(p)).status, p).toBe(401);
  });

  it("lets every role read, with no-store", async () => {
    await addAccounts(divA);
    await addBalances(divA);
    await markSynced(divA);
    const id = (await db.prepare("SELECT id FROM gl_accounts LIMIT 1").first<{ id: number }>())?.id;
    for (const who of ["admin", "finance", "viewer", "approver"]) {
      for (const p of [
        `/api/reports/balance-sheet?division=${divA}&year=2026&period=2`,
        `/api/reports/profit-loss?division=${divA}&year=2026&periodTo=2`,
        `/api/ledger/accounts?division=${divA}`,
        `/api/ledger/accounts/${id}/balances?year=2026`,
      ]) {
        const res = await authed(p, tokens[who] as string);
        expect(res.status, `${who} ${p}`).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    }
  });

  it("answers 400 or 404 for bad input", async () => {
    const bad: [string, number, string][] = [
      ["/api/reports/balance-sheet?division=abc", 400, "bad_division"],
      ["/api/reports/balance-sheet?division=0", 400, "bad_division"],
      ["/api/reports/balance-sheet?division=999999", 404, "unknown_division"],
      [`/api/reports/balance-sheet?division=${divOff}`, 404, "unknown_division"],
      [`/api/reports/profit-loss?division=${divOff}`, 404, "unknown_division"],
      [`/api/ledger/accounts?division=${divOff}`, 404, "unknown_division"],
      ["/api/reports/balance-sheet?year=abc", 400, "bad_year"],
      ["/api/reports/balance-sheet?year=1899", 400, "bad_year"],
      ["/api/reports/balance-sheet?year=2201", 400, "bad_year"],
      ["/api/reports/balance-sheet?year=2026.5", 400, "bad_year"],
      ["/api/reports/balance-sheet?period=0", 400, "bad_period"],
      ["/api/reports/balance-sheet?period=17", 400, "bad_period"],
      ["/api/reports/balance-sheet?period=1.5", 400, "bad_period"],
      ["/api/reports/balance-sheet?period=-1", 400, "bad_period"],
      ["/api/reports/balance-sheet?compare=lastyear", 400, "bad_compare"],
      ["/api/reports/balance-sheet?year=2026&compareYear=2026", 400, "bad_compare_year"],
      ["/api/reports/balance-sheet?compareYear=x", 400, "bad_compare_year"],
      ["/api/reports/profit-loss?periodTo=0", 400, "bad_period_to"],
      ["/api/reports/profit-loss?periodTo=99", 400, "bad_period_to"],
      ["/api/reports/profit-loss?scenario=not-a-guid", 400, "bad_scenario"],
      ["/api/ledger/accounts/abc/balances", 400, "bad_id"],
      ["/api/ledger/accounts/0/balances", 400, "bad_id"],
      ["/api/ledger/accounts/999999/balances", 404, "not_found"],
      ["/api/ledger/accounts/1/balances?year=abc", 404, "not_found"], // no such account first
    ];
    for (const [path, status, error] of bad) {
      const r = await get<{ error: string }>(path);
      expect([path, r.status, r.body.error]).toEqual([path, status, error]);
    }
  });

  it("validates the year of a drill-down for an existing account", async () => {
    await addAccounts(divA);
    const id = (await db.prepare("SELECT id FROM gl_accounts LIMIT 1").first<{ id: number }>())?.id;
    expect(
      (await get<{ error: string }>(`/api/ledger/accounts/${id}/balances?year=abc`)).status,
    ).toBe(400);
  });

  it("does not show an account of another or a disabled division (IDOR)", async () => {
    await addAccounts(divOff, [CHART[0] as Acc]);
    await addAccounts(divA, [CHART[1] as Acc]);
    const off = (
      await db
        .prepare("SELECT id FROM gl_accounts WHERE division_id = ?1")
        .bind(divOff)
        .first<{ id: number }>()
    )?.id;
    const a = (
      await db
        .prepare("SELECT id FROM gl_accounts WHERE division_id = ?1")
        .bind(divA)
        .first<{ id: number }>()
    )?.id;
    for (const who of ["admin", "viewer"]) {
      expect((await get(`/api/ledger/accounts/${off}/balances`, who)).status).toBe(404);
    }
    // an account is reached through its own division, whatever ?division says
    const r = await get<LedgerAccountBalancesResponse>(
      `/api/ledger/accounts/${a}/balances?division=${divB}&year=2026`,
    );
    expect(r.status).toBe(200);
    expect(r.body.division.id).toBe(divA);
    // the chart of division B holds nothing of division A
    const list = await get<LedgerAccountsResponse>(`/api/ledger/accounts?division=${divB}`);
    expect(list.body.accounts).toEqual([]);
    expect(list.body.status).toBe("not_synced");
  });
});

describe("empty state", () => {
  it("answers 200 not_synced with no report when the ledger was never read", async () => {
    const bs = await get<BalanceSheetResponse>(
      `/api/reports/balance-sheet?division=${divA}&year=2026&period=2`,
    );
    expect(bs.status).toBe(200);
    expect(bs.body).toMatchObject({
      status: "not_synced",
      report: null,
      year: 2026,
      period: 2,
      budgetsAvailable: true,
    });
    expect(bs.body.freshness.gl_balances).toMatchObject({ lastCompletedAt: null, stale: true });
    const pl = await get<ProfitLossResponse>(
      `/api/reports/profit-loss?division=${divA}&year=2026&periodTo=2`,
    );
    expect(pl.status).toBe(200);
    expect(pl.body).toMatchObject({ status: "not_synced", report: null, budgetScenario: null });
    const list = await get<LedgerAccountsResponse>(`/api/ledger/accounts?division=${divA}`);
    expect(list.body).toMatchObject({ status: "not_synced", accounts: [], unclassifiedCount: 0 });
  });

  it("is per year: the other year can be synced", async () => {
    await addAccounts(divA);
    await addBalances(
      divA,
      LEDGER.filter((r) => r[1] === 2025),
    );
    await markSynced(divA, { years: [2025] });
    const some = await get<BalanceSheetResponse>(
      `/api/reports/balance-sheet?division=${divA}&year=2025&period=12&compare=none`,
    );
    expect(some.body.status).toBe("ok");
    const none = await get<BalanceSheetResponse>(
      `/api/reports/balance-sheet?division=${divA}&year=2026&period=2`,
    );
    expect(none.body.status).toBe("not_synced");
  });

  it("drill-down of an account without balances is empty, not an error", async () => {
    await addAccounts(divA);
    const id = (await db.prepare("SELECT id FROM gl_accounts LIMIT 1").first<{ id: number }>())?.id;
    const r = await get<LedgerAccountBalancesResponse>(
      `/api/ledger/accounts/${id}/balances?year=2026`,
    );
    expect(r.body).toMatchObject({ status: "not_synced", periods: [], totalMinor: 0 });
  });
});

describe("balance sheet", () => {
  beforeEach(async () => {
    await addAccounts(divA);
    await addBalances(divA);
    await markSynced(divA);
  });
  const url = (q: string): string => `/api/reports/balance-sheet?division=${divA}&year=2026&${q}`;

  it("returns the hand-computed report against last year end", async () => {
    const r = await get<BalanceSheetResponse>(url("period=2&compare=yearend"));
    expect(r.status).toBe(200);
    const bs = r.body.report;
    expect(r.body).toMatchObject({ status: "ok", compareYear: 2025, compareMissing: false });
    expect(bs?.sections.assets.total).toEqual({ current: 18500 - 700 + 700 - 0, compare: 9500 });
    expect(bs?.sections.assets.lines.map((l) => [l.code, l.current, l.compare])).toEqual([
      ["1100", 13500, 9500],
      ["1300", 5000, 0],
    ]);
    expect(bs?.sections.liabilities.total).toEqual({ current: 3000, compare: 0 });
    expect(bs?.sections.equity.total).toEqual({ current: 12000, compare: 8000 });
    expect(bs?.result).toEqual({ current: 3500, compare: 1500 });
    expect(bs?.difference).toEqual({ current: 0, compare: 0 });
    expect(r.body.report?.compareBasis).toBe("year_end");
  });

  it("compares with the same period, or not at all", async () => {
    const same = await get<BalanceSheetResponse>(url("period=2&compare=period"));
    expect(same.body.report?.compareBasis).toBe("same_period");
    expect(same.body.report?.sections.assets.total.compare).toBe(9000);
    const none = await get<BalanceSheetResponse>(url("period=2&compare=none"));
    expect(none.body.compareYear).toBeNull();
    expect(none.body.compareMissing).toBe(false);
    expect(none.body.report?.result.compare).toBeNull();
  });

  it("says when the compare year was never read, and compares with nothing", async () => {
    await db.prepare("DELETE FROM gl_sync_years WHERE year = 2025").run();
    const r = await get<BalanceSheetResponse>(url("period=2"));
    expect(r.body).toMatchObject({ status: "ok", compareYear: null, compareMissing: true });
    expect(r.body.report?.result.compare).toBeNull();
  });

  it("surfaces a non-zero check line and the unclassified account", async () => {
    await addBalances(divA, [
      [7, 2026, 1, 700],
      [2, 2026, 1, -700],
    ]);
    const ok = await get<BalanceSheetResponse>(url("period=2&compare=none"));
    expect(ok.body.report?.sections.unclassified.lines.map((l) => l.code)).toEqual(["9999"]);
    expect(ok.body.report?.difference.current).toBe(0);
    // lose the capital opening: the books no longer balance and the report says so
    await db
      .prepare(
        "DELETE FROM gl_balances WHERE gl_account_exact_id = ?1 AND period = 0 AND year = 2026",
      )
      .bind(G(4))
      .run();
    const off = await get<BalanceSheetResponse>(url("period=2&compare=none"));
    expect(off.body.report?.difference.current).toBe(12000);
  });

  it("defaults to the current year and month", async () => {
    await markSynced(divB, { years: [now().year], accountsAt: null });
    const r = await get<BalanceSheetResponse>(`/api/reports/balance-sheet?division=${divB}`);
    expect(r.body.year).toBe(now().year);
    expect(r.body.period).toBe(now().month);
    const past = await get<BalanceSheetResponse>(
      `/api/reports/balance-sheet?division=${divA}&year=2025`,
    );
    expect(past.body.period).toBe(12);
  });

  it("keeps an account that Exact stopped returning, and one that is not in the chart", async () => {
    await db.prepare("UPDATE gl_accounts SET is_active = 0 WHERE exact_id = ?1").bind(G(2)).run();
    await db.prepare("DELETE FROM gl_accounts WHERE exact_id = ?1").bind(G(3)).run();
    const r = await get<BalanceSheetResponse>(url("period=2&compare=none"));
    expect(r.body.report?.sections.assets.lines.map((l) => l.code)).toContain("1300");
    const orphan = r.body.report?.sections.unclassified.lines[0];
    expect(orphan).toMatchObject({ code: null, current: -3000 });
    expect(r.body.report?.difference.current).toBe(0);
  });
});

describe("profit and loss", () => {
  beforeEach(async () => {
    await addAccounts(divA);
    await addBalances(divA);
    await markSynced(divA, { budgetYears: [2026] });
  });
  const url = (q = ""): string =>
    `/api/reports/profit-loss?division=${divA}&year=2026&periodTo=2${q}`;
  const S1 = "11111111-1111-1111-1111-111111111111";
  const S2 = "22222222-2222-2222-2222-222222222222";
  const budgets: [number, number, number, number, string?][] = [
    [5, 2026, 1, -6000, S1],
    [5, 2026, 2, -3000, S1],
    [5, 2026, 3, -1000, S1],
    [6, 2026, 1, 3500, S1],
    [6, 2026, 2, 1000, S1],
    [5, 2026, 1, -999, S2],
  ];

  it("returns actual, budget and last year for the periods to date", async () => {
    await addBudgets(divA, budgets);
    const r = await get<ProfitLossResponse>(url());
    expect(r.body).toMatchObject({
      status: "ok",
      compareYear: 2025,
      compareMissing: false,
      budgetsAvailable: true,
      budgetScenario: S1,
      budgetScenarios: [S1, S2],
    });
    const pl = r.body.report;
    expect(pl?.budgetsIncluded).toBe(true);
    expect(pl?.sections.revenue.total).toMatchObject({
      actual: 7500,
      budget: 9000,
      lastYear: 4000,
      vsBudget: { minor: -1500, bps: -1667 },
      vsLastYear: { minor: 3500, bps: 8750 },
    });
    expect(pl?.sections.costs.total).toMatchObject({
      actual: -4000,
      budget: -4500,
      lastYear: -3000,
    });
    expect(pl?.result).toMatchObject({ actual: 3500, budget: 4500, lastYear: 1000 });
    // balance sheet accounts are not in the report
    expect(pl?.sections.unclassified.lines).toEqual([]);
  });

  it("uses the requested scenario, and refuses an unknown one", async () => {
    await addBudgets(divA, budgets);
    const two = await get<ProfitLossResponse>(url(`&scenario=${S2.toUpperCase()}`));
    expect(two.body.budgetScenario).toBe(S2);
    expect(two.body.report?.result.budget).toBe(999);
    const unknown = await get<{ error: string }>(
      url("&scenario=33333333-3333-3333-3333-333333333333"),
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("unknown_scenario");
  });

  it("works without budgets: figures are null, not zero", async () => {
    await db.prepare("DELETE FROM gl_sync_years WHERE entity = 'gl_budgets'").run();
    const r = await get<ProfitLossResponse>(url());
    expect(r.body).toMatchObject({
      status: "ok",
      budgetScenario: null,
      budgetScenarios: [],
      budgetsAvailable: true,
    });
    expect(r.body.report?.budgetsIncluded).toBe(false);
    expect(r.body.report?.result.budget).toBeNull();
    expect(r.body.report?.result.actual).toBe(3500);
  });

  it("reports budgets as unavailable while Exact refuses them, and the report still works", async () => {
    await addBudgets(divA, budgets);
    await db
      .prepare(
        `INSERT INTO sync_state (division_id, entity, mode, last_error, unavailable_until)
         VALUES (?1, 'gl_budgets', 'full', 'budgets_unavailable_404', ?2)`,
      )
      .bind(divA, new Date(Date.now() + 3 * 86_400_000).toISOString())
      .run();
    const r = await get<ProfitLossResponse>(url());
    expect(r.body.budgetsAvailable).toBe(false);
    expect(r.body.report?.budgetsIncluded).toBe(false);
    expect(r.body.report?.result.actual).toBe(3500);
    // once the week is over the flag is true again (the next sync will try)
    await db
      .prepare(
        "UPDATE sync_state SET unavailable_until = ?2 WHERE division_id = ?1 AND entity = 'gl_budgets'",
      )
      .bind(divA, new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await get<ProfitLossResponse>(url())).body.budgetsAvailable).toBe(true);
  });

  it("flags a compare year that was never read", async () => {
    await db.prepare("DELETE FROM gl_sync_years WHERE year = 2025").run();
    const r = await get<ProfitLossResponse>(url());
    expect(r.body.compareMissing).toBe(true);
    // null, not 0: an unread year is not a year with no figures (review K2)
    expect(r.body.report?.result.lastYear).toBeNull();
    expect(r.body.report?.result.vsLastYear).toEqual({ minor: null, bps: null });
    expect(r.body.report?.compareYear).toBeNull();
    expect(r.body.compareFreshness).toBeNull();
  });

  it("splits revenue and costs by the side of the account, and keeps the rest", async () => {
    await addAccounts(divA, [{ n: 8, code: "7000", name: "Odd", bt: "W", side: null }]);
    await addBalances(divA, [[8, 2026, 1, 100]]);
    const r = await get<ProfitLossResponse>(url());
    expect(r.body.report?.sections.unclassified.lines.map((l) => [l.code, l.actual])).toEqual([
      ["7000", -100],
    ]);
    expect(r.body.report?.result.actual).toBe(3400);
  });
});

describe("freshness", () => {
  it("is stale after 36 hours and never-read is stale with no date", async () => {
    await addAccounts(divA);
    await addBalances(divA);
    await markSynced(divA, { accountsAt: hoursAgo(37), balancesAt: hoursAgo(35) });
    const r = await get<BalanceSheetResponse>(
      `/api/reports/balance-sheet?division=${divA}&year=2026&period=2`,
    );
    expect(r.body.freshness.gl_accounts.stale).toBe(true);
    expect(r.body.freshness.gl_accounts.staleAfterHours).toBe(36);
    expect(r.body.freshness.gl_balances.stale).toBe(false);
    expect(r.body.freshness.gl_balances.lastCompletedAt).not.toBeNull();
    expect(r.body.freshness.gl_budgets).toMatchObject({ lastCompletedAt: null, stale: true });
  });

  it("treats budgets, which are read weekly, as stale only after eight days", async () => {
    await addAccounts(divA);
    await addBalances(divA);
    await markSynced(divA, { budgetYears: [2026], budgetsAt: hoursAgo(5 * 24) });
    const fresh = await get<ProfitLossResponse>(
      `/api/reports/profit-loss?division=${divA}&year=2026&periodTo=2`,
    );
    expect(fresh.body.freshness.gl_budgets).toMatchObject({ stale: false, staleAfterHours: 192 });
    await db
      .prepare("UPDATE gl_sync_years SET completed_at = ?1 WHERE entity = 'gl_budgets'")
      .bind(hoursAgo(9 * 24))
      .run();
    const old = await get<ProfitLossResponse>(
      `/api/reports/profit-loss?division=${divA}&year=2026&periodTo=2`,
    );
    expect(old.body.freshness.gl_budgets.stale).toBe(true);
  });

  it("is on the chart and the drill-down too", async () => {
    await addAccounts(divA);
    await markSynced(divA, { years: [], accountsAt: hoursAgo(2) });
    const r = await get<LedgerAccountsResponse>(`/api/ledger/accounts?division=${divA}`);
    expect(r.body.status).toBe("ok");
    expect(r.body.freshness.gl_accounts.stale).toBe(false);
  });
});

describe("the chart", () => {
  it("lists accounts by code with flags and report sections", async () => {
    await addAccounts(divA);
    await db.prepare("UPDATE gl_accounts SET is_blocked = 1 WHERE exact_id = ?1").bind(G(2)).run();
    await db.prepare("UPDATE gl_accounts SET is_active = 0 WHERE exact_id = ?1").bind(G(3)).run();
    await markSynced(divA);
    const r = await get<LedgerAccountsResponse>(`/api/ledger/accounts?division=${divA}`);
    expect(
      r.body.accounts.map((a) => [a.code, a.statement, a.section, a.isBlocked, a.isActive]),
    ).toEqual([
      ["0500", "balance_sheet", "equity", false, true],
      ["1100", "balance_sheet", "assets", false, true],
      ["1300", "balance_sheet", "assets", true, true],
      ["1600", "balance_sheet", "liabilities", false, false],
      ["4000", "profit_loss", "revenue", false, true],
      ["6000", "profit_loss", "costs", false, true],
      ["9999", "balance_sheet", "unclassified", false, true],
    ]);
    expect(r.body.unclassifiedCount).toBe(1);
    expect(r.body.accounts[0]).toMatchObject({
      exactId: G(4),
      type: 40,
      typeDescription: "Equity",
      balanceSide: "C",
    });
  });
});

describe("account drill-down", () => {
  it("adds the rows of a period and keeps debit and credit only when every row has them", async () => {
    await addAccounts(divA);
    await markSynced(divA);
    await db.batch([
      db
        .prepare(
          `INSERT INTO gl_balances (division_id, gl_account_exact_id, year, period, dimension, amount_minor,
             debit_minor, credit_minor, currency, updated_at) VALUES
           (?1, ?2, 2026, 1, '', 1000, 1000, 0, 'EUR', 'x'),
           (?1, ?2, 2026, 1, '|CC1', -250, 0, 250, 'EUR', 'x'),
           (?1, ?2, 2026, 2, '', 400, NULL, NULL, 'EUR', 'x'),
           (?1, ?2, 2026, 3, '', 5, 5, 0, 'EUR', 'x'),
           (?1, ?2, 2025, 1, '', 999, 999, 0, 'EUR', 'x')`,
        )
        .bind(divA, G(1)),
    ]);
    const id = (
      await db
        .prepare("SELECT id FROM gl_accounts WHERE exact_id = ?1")
        .bind(G(1))
        .first<{ id: number }>()
    )?.id;
    const r = await get<LedgerAccountBalancesResponse>(
      `/api/ledger/accounts/${id}/balances?year=2026`,
    );
    expect(r.body.periods).toEqual([
      { period: 1, amountMinor: 750, debitMinor: 1000, creditMinor: 250, rows: 2 },
      { period: 2, amountMinor: 400, debitMinor: null, creditMinor: null, rows: 1 },
      { period: 3, amountMinor: 5, debitMinor: 5, creditMinor: 0, rows: 1 },
    ]);
    expect(r.body.totalMinor).toBe(1155);
    expect(r.body.account).toMatchObject({ code: "1100", section: "assets" });
    const prev = await get<LedgerAccountBalancesResponse>(
      `/api/ledger/accounts/${id}/balances?year=2025`,
    );
    expect(prev.body.periods).toHaveLength(1);
  });
});

describe("amounts are integers in the division currency", () => {
  function numbers(v: unknown, path = "$"): [string, number][] {
    if (typeof v === "number") return [[path, v]];
    if (Array.isArray(v)) return v.flatMap((x, i) => numbers(x, `${path}[${i}]`));
    if (v !== null && typeof v === "object") {
      return Object.entries(v).flatMap(([k, x]) => numbers(x, `${path}.${k}`));
    }
    return [];
  }

  it("never returns a fractional number, in any report", async () => {
    await addAccounts(divA);
    await addBalances(divA);
    await markSynced(divA, { budgetYears: [2026] });
    await addBudgets(divA, [
      [5, 2026, 1, -6000],
      [6, 2026, 1, 3500],
    ]);
    for (const p of [
      `/api/reports/balance-sheet?division=${divA}&year=2026&period=2`,
      `/api/reports/profit-loss?division=${divA}&year=2026&periodTo=2`,
      `/api/ledger/accounts?division=${divA}`,
    ]) {
      const r = await get<unknown>(p);
      for (const [path, n] of numbers(r.body))
        expect(Number.isInteger(n), `${p} ${path}`).toBe(true);
    }
  });

  it("carries yen and dinar exactly", async () => {
    const jpy = await addDivision(
      (
        await db
          .prepare("SELECT connection_id FROM divisions WHERE id = ?1")
          .bind(divA)
          .first<{ connection_id: number }>()
      )?.connection_id as number,
      "Tokyo KK",
      "JPY",
    );
    await addAccounts(jpy);
    await addBalances(
      jpy,
      [
        [1, 2026, 1, 123_456_789_012],
        [4, 2026, 1, -123_456_789_012],
      ],
      "JPY",
    );
    await markSynced(jpy, { years: [2026] });
    const r = await get<BalanceSheetResponse>(
      `/api/reports/balance-sheet?division=${jpy}&year=2026&period=1&compare=none`,
    );
    expect(r.body.division).toMatchObject({ currency: "JPY" });
    expect(r.body.report?.sections.assets.total.current).toBe(123_456_789_012);
    expect(r.body.report?.difference.current).toBe(0);

    const kwd = await addDivision(
      (
        await db
          .prepare("SELECT connection_id FROM divisions WHERE id = ?1")
          .bind(divA)
          .first<{ connection_id: number }>()
      )?.connection_id as number,
      "Kuwait WLL",
      "KWD",
    );
    await addAccounts(kwd);
    await addBalances(kwd, [[1, 2026, 1, 1_234_567]], "KWD"); // 1,234.567 KWD
    await markSynced(kwd, { years: [2026] });
    const k = await get<BalanceSheetResponse>(
      `/api/reports/balance-sheet?division=${kwd}&year=2026&period=1&compare=none`,
    );
    expect(k.body.division.currency).toBe("KWD");
    expect(k.body.report?.sections.assets.total.current).toBe(1_234_567);
    expect(k.body.report?.difference.current).toBe(1_234_567);
  });
});

describe("review K2", () => {
  const bsUrl = (q: string) => `/api/reports/balance-sheet?division=${divA}&${q}`;
  const plUrl = (q: string) => `/api/reports/profit-loss?division=${divA}&${q}`;

  it("answers no_data, without a report, for a year read completely that holds no rows", async () => {
    // 1 January: the new year was read, Exact has no figures for it yet; last year is still there
    await addAccounts(divA);
    await addBalances(
      divA,
      LEDGER.filter((r) => r[1] === 2025),
    );
    await markSynced(divA, { years: [2025, 2026] });
    const bs = await get<BalanceSheetResponse>(bsUrl("year=2026&period=1"));
    expect(bs.status).toBe(200);
    expect(bs.body).toMatchObject({ status: "no_data", report: null });
    const pl = await get<ProfitLossResponse>(plUrl("year=2026&periodTo=1"));
    expect(pl.body).toMatchObject({ status: "no_data", report: null, budgetScenario: null });
    const old = await get<BalanceSheetResponse>(bsUrl("year=2025&period=12&compare=none"));
    expect(old.body.status).toBe("ok");
    expect(old.body.report?.difference.current).toBe(0);
  });

  it("uses the weekly rule for another year's balances and reports the compare year's freshness", async () => {
    await addAccounts(divA);
    await addBalances(divA);
    const current = now().year;
    const other = current - 1;
    await db.batch([
      db
        .prepare(
          `INSERT INTO gl_sync_years (division_id, entity, year, completed_at, cycle)
           VALUES (?1, 'gl_balances', ?2, ?3, 1), (?1, 'gl_balances', ?4, ?5, 1)`,
        )
        .bind(divA, current, hoursAgo(2), other, hoursAgo(5 * 24)),
    ]);
    const r = await get<BalanceSheetResponse>(bsUrl(`year=${other}&period=12&compare=none`));
    // read five days ago, weekly cadence: not stale (a literal 36 hours would always flag it)
    expect(r.body.freshness.gl_balances).toMatchObject({ stale: false, staleAfterHours: 192 });
    const c = await get<BalanceSheetResponse>(bsUrl(`year=${current}&period=1`));
    expect(c.body.freshness.gl_balances).toMatchObject({ stale: false, staleAfterHours: 36 });
    expect(c.body.compareFreshness).toMatchObject({ stale: false, staleAfterHours: 192 });
    await db
      .prepare("UPDATE gl_sync_years SET completed_at = ?2 WHERE division_id = ?1 AND year = ?3")
      .bind(divA, hoursAgo(9 * 24), other)
      .run();
    const late = await get<BalanceSheetResponse>(bsUrl(`year=${current}&period=1`));
    expect(late.body.compareFreshness?.stale).toBe(true);
    const none = await get<BalanceSheetResponse>(bsUrl(`year=${current}&period=1&compare=none`));
    expect(none.body.compareFreshness).toBeNull();
  });

  it("shows no budget column when budgets were read but none exist for the year", async () => {
    await addAccounts(divA);
    await addBalances(divA);
    await markSynced(divA, { budgetYears: [2026] });
    const r = await get<ProfitLossResponse>(plUrl("year=2026&periodTo=2"));
    expect(r.body).toMatchObject({ status: "ok", budgetScenario: null, budgetScenarios: [] });
    expect(r.body.report?.budgetsIncluded).toBe(false);
    expect(r.body.report?.result.budget).toBeNull();
  });

  it("reports split keys of the data used", async () => {
    await addAccounts(divA);
    await addBalances(divA);
    await markSynced(divA, { budgetYears: [2026] });
    await db
      .prepare(
        "UPDATE gl_sync_years SET split_keys = CASE year WHEN 2026 THEN 2 ELSE 1 END WHERE division_id = ?1",
      )
      .bind(divA)
      .run();
    // balances 2026 (2) + 2025 (1); budgets of 2026 (2) are used only when there are rows
    expect((await get<BalanceSheetResponse>(bsUrl("year=2026&period=2"))).body.splitKeys).toBe(3);
    expect(
      (await get<BalanceSheetResponse>(bsUrl("year=2026&period=2&compare=none"))).body.splitKeys,
    ).toBe(2);
    expect((await get<ProfitLossResponse>(plUrl("year=2026&periodTo=2"))).body.splitKeys).toBe(5);
  });

  it("reads the report rows through the indexes", async () => {
    const plan = async (sql: string, ...binds: unknown[]): Promise<string> =>
      (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...binds)
          .all<{ detail: string }>()
      ).results
        .map((r) => r.detail)
        .join(" | ");
    const bs = await plan(
      `SELECT gl_account_exact_id, year, period, SUM(amount_minor) FROM gl_balances
       WHERE division_id = ?1 AND ((year = ?2 AND period <= ?3) OR (year = ?4 AND period <= ?5))
       GROUP BY gl_account_exact_id, year, period`,
      1,
      2026,
      2,
      2025,
      99,
    );
    expect(bs).toMatch(/idx_gl_balances_year|sqlite_autoindex_gl_balances/);
    expect(bs).not.toMatch(/SCAN gl_balances(?! USING)/);
    const drill = await plan(
      "SELECT period, SUM(amount_minor) FROM gl_balances WHERE division_id = ?1 AND gl_account_exact_id = ?2 AND year = ?3 GROUP BY period",
      1,
      "x",
      2026,
    );
    expect(drill).not.toMatch(/SCAN gl_balances(?! USING)/);
    const budgets = await plan(
      "SELECT gl_account_exact_id, SUM(amount_minor) FROM gl_budgets WHERE division_id = ?1 AND year = ?2 AND scenario = ?3 AND period BETWEEN 1 AND ?4 GROUP BY gl_account_exact_id, year, period",
      1,
      2026,
      "",
      12,
    );
    expect(budgets).not.toMatch(/SCAN gl_budgets(?! USING)/);
  });
});

/**
 * The ledger responses have EXACTLY the keys of their types in packages/core (as the K1 shape
 * tests do for the open-item reads): `keysOf<T>()` fails to compile when a key of T is missing from
 * the list, the runtime check when a response has a key the type does not, or lacks one.
 */
const keysOf =
  <T>() =>
  <const K extends readonly (keyof T)[]>(
    k: K & ([keyof T] extends [K[number]] ? unknown : "missing keys"),
  ): string[] =>
    [...k].map(String).sort();
const shape = (v: unknown): string[] => Object.keys(v as object).sort();

const FRESH = keysOf<LedgerFreshnessEntry>()(["lastCompletedAt", "stale", "staleAfterHours"]);
const PAIR = keysOf<Pair>()(["current", "compare"]);
const BS_LINE = keysOf<BalanceSheetLine>()(["accountId", "code", "name", "current", "compare"]);
const BS_SECTION = keysOf<BalanceSheetSectionResult>()(["section", "lines", "total"]);
const BS = keysOf<BalanceSheet>()([
  "year",
  "period",
  "compareYear",
  "compareBasis",
  "sections",
  "result",
  "liabilitiesAndEquity",
  "difference",
  "hasOpeningBalances",
]);
const BS_RESPONSE = keysOf<BalanceSheetResponse>()([
  "division",
  "status",
  "year",
  "period",
  "compareYear",
  "compareMissing",
  "report",
  "freshness",
  "compareFreshness",
  "budgetsAvailable",
  "splitKeys",
]);
const VARIANCE = keysOf<Variance>()(["minor", "bps"]);
const FIGURES = keysOf<ProfitLossFigures>()([
  "actual",
  "budget",
  "lastYear",
  "vsBudget",
  "vsLastYear",
]);
const PL_LINE = keysOf<ProfitLossLine>()([
  "accountId",
  "code",
  "name",
  "actual",
  "budget",
  "lastYear",
  "vsBudget",
  "vsLastYear",
]);
const PL_SECTION = keysOf<ProfitLossSectionResult>()(["section", "lines", "total"]);
const PL = keysOf<ProfitLoss>()([
  "year",
  "periodTo",
  "compareYear",
  "budgetsIncluded",
  "sections",
  "result",
]);
const PL_RESPONSE = keysOf<ProfitLossResponse>()([
  "division",
  "status",
  "year",
  "periodTo",
  "compareYear",
  "compareMissing",
  "report",
  "budgetScenario",
  "budgetScenarios",
  "freshness",
  "compareFreshness",
  "budgetsAvailable",
  "splitKeys",
]);
const ACCOUNT_ROW = keysOf<LedgerAccountRow>()([
  "id",
  "exactId",
  "code",
  "name",
  "type",
  "typeDescription",
  "balanceSide",
  "balanceType",
  "isBlocked",
  "isActive",
  "statement",
  "section",
]);
const ACCOUNTS = keysOf<LedgerAccountsResponse>()([
  "division",
  "status",
  "truncated",
  "accounts",
  "unclassifiedCount",
  "freshness",
]);
const PERIOD_ROW = keysOf<LedgerPeriodRow>()([
  "period",
  "amountMinor",
  "debitMinor",
  "creditMinor",
  "rows",
]);
const BALANCES = keysOf<LedgerAccountBalancesResponse>()([
  "division",
  "status",
  "year",
  "account",
  "periods",
  "totalMinor",
  "freshness",
]);

describe("ledger response shapes match api-types.ts exactly", () => {
  beforeEach(async () => {
    await addAccounts(divA);
    await addBalances(divA);
    await addBudgets(divA, [[5, 2026, 1, -6000]]);
    await markSynced(divA, { budgetYears: [2026] });
  });

  const freshness = (f: unknown): void => {
    expect(shape(f)).toEqual(["gl_accounts", "gl_balances", "gl_budgets"]);
    for (const e of Object.values(f as object)) expect(shape(e)).toEqual(FRESH);
  };

  it("balance sheet", async () => {
    const r = (
      await get<BalanceSheetResponse>(
        `/api/reports/balance-sheet?division=${divA}&year=2026&period=2`,
      )
    ).body;
    expect(shape(r)).toEqual(BS_RESPONSE);
    freshness(r.freshness);
    expect(shape(r.compareFreshness)).toEqual(FRESH);
    const bs = r.report as BalanceSheet;
    expect(shape(bs)).toEqual(BS);
    expect(shape(bs.sections)).toEqual(["assets", "equity", "liabilities", "unclassified"]);
    for (const sec of Object.values(bs.sections)) {
      expect(shape(sec)).toEqual(BS_SECTION);
      expect(shape(sec.total)).toEqual(PAIR);
      for (const l of sec.lines) expect(shape(l)).toEqual(BS_LINE);
    }
    expect(bs.sections.assets.lines.length).toBeGreaterThan(0);
    for (const k of ["result", "liabilitiesAndEquity", "difference", "hasOpeningBalances"] as const)
      expect(shape(bs[k])).toEqual(PAIR);
    const empty = (
      await get<BalanceSheetResponse>(
        `/api/reports/balance-sheet?division=${divB}&year=2026&period=2`,
      )
    ).body;
    expect(shape(empty)).toEqual(BS_RESPONSE);
  });

  it("profit and loss", async () => {
    const r = (
      await get<ProfitLossResponse>(
        `/api/reports/profit-loss?division=${divA}&year=2026&periodTo=2`,
      )
    ).body;
    expect(shape(r)).toEqual(PL_RESPONSE);
    freshness(r.freshness);
    const pl = r.report as ProfitLoss;
    expect(shape(pl)).toEqual(PL);
    expect(shape(pl.sections)).toEqual(["costs", "revenue", "unclassified"]);
    for (const sec of Object.values(pl.sections)) {
      expect(shape(sec)).toEqual(PL_SECTION);
      expect(shape(sec.total)).toEqual(FIGURES);
      for (const l of sec.lines) {
        expect(shape(l)).toEqual(PL_LINE);
        expect(shape(l.vsBudget)).toEqual(VARIANCE);
        expect(shape(l.vsLastYear)).toEqual(VARIANCE);
      }
    }
    expect(shape(pl.result)).toEqual(FIGURES);
    const empty = (
      await get<ProfitLossResponse>(
        `/api/reports/profit-loss?division=${divB}&year=2026&periodTo=2`,
      )
    ).body;
    expect(shape(empty)).toEqual(PL_RESPONSE);
  });

  it("chart and account drill-down", async () => {
    const list = (await get<LedgerAccountsResponse>(`/api/ledger/accounts?division=${divA}`)).body;
    expect(shape(list)).toEqual(ACCOUNTS);
    expect(list.truncated).toBe(false);
    freshness(list.freshness);
    for (const a of list.accounts) expect(shape(a)).toEqual(ACCOUNT_ROW);
    const bank = list.accounts.find((a) => a.code === "1100");
    const d = (
      await get<LedgerAccountBalancesResponse>(
        `/api/ledger/accounts/${bank?.id}/balances?year=2026`,
      )
    ).body;
    expect(shape(d)).toEqual(BALANCES);
    expect(shape(d.account)).toEqual(ACCOUNT_ROW);
    expect(d.periods.length).toBeGreaterThan(0);
    for (const p of d.periods) expect(shape(p)).toEqual(PERIOD_ROW);
  });
});
