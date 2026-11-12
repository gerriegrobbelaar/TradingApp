/**
 * Job exact.bank_balances (ADR 0045): reads the balance of each mapped bank ledger account from
 * Exact (read only, bounded, resumable by being cheap and repeatable) and stores it on bank_accounts.
 */
import { env } from "cloudflare:test";
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
} from "@camelthorn/exact";
import { describe, expect, it } from "vitest";
import { CREDENTIALS_REJECTED } from "../src/exact/gate";
import { BANK_BALANCES_BUDGET, runBankBalances } from "../src/exact/bank-balances";
import type { JobContext } from "../src/jobs/types";
import { jobContext, NOW, resetWorld, type World } from "./matching-helpers";
import { FakeExact, db, fakeGate, guid } from "./sync-helpers";

let w: World;
let exactDivision: number;

async function setup(over: { code?: string | null } = {}): Promise<FakeExact> {
  w = await resetWorld();
  exactDivision = (
    (await db
      .prepare("SELECT exact_division AS n FROM divisions WHERE id = ?1")
      .bind(w.divisionId)
      .first<{ n: number }>()) as { n: number }
  ).n;
  if (over.code !== null) {
    await db
      .prepare(
        `INSERT INTO gl_accounts (division_id, exact_id, code, name, is_active, updated_at)
         VALUES (?1, ?2, ?3, 'Revolut EUR', 1, '2026-07-14T00:00:00.000Z')`,
      )
      .bind(w.divisionId, guid(7001), over.code ?? "  1210")
      .run();
  }
  const fx = new FakeExact(exactDivision);
  fx.glBalances = [
    { account: 1, year: 2026, period: 0, amount: 1000.5 },
    { account: 1, year: 2026, period: 6, amount: -200.25 },
    { account: 2, year: 2026, period: 1, amount: 99999 },
    { account: 1, year: 2025, period: 12, amount: 777 },
  ];
  return fx;
}

const ctxFor = (fx: FakeExact, over: Partial<JobContext> = {}, gate = fakeGate()): JobContext =>
  jobContext({
    job: { id: 1, name: "exact.bank_balances", handler: "exact.bank_balances", exactBudget: 20 },
    budget: BANK_BALANCES_BUDGET,
    syncDeps: { transport: fx.transport, gate, now: () => NOW },
    ...over,
  });

const account = () =>
  db
    .prepare(
      "SELECT exact_balance_minor AS m, exact_balance_at AS at FROM bank_accounts WHERE id = ?1",
    )
    .bind(w.accountId)
    .first<{ m: number | null; at: string | null }>();

describe("exact.bank_balances", () => {
  it("stores the sum of the year's periods for the mapped ledger account, and nothing else", async () => {
    const fx = await setup();
    const gate = fakeGate();
    const res = await runBankBalances(ctxFor(fx, {}, gate));
    expect(res).toMatchObject({
      status: "ok",
      callsUsed: 1,
      summary: { read: 1, stored: 1, skipped: 0 },
    });
    // 1000.50 - 200.25 = 800.25 (the other account and the other year are not in it)
    expect(await account()).toEqual({ m: 80025, at: new Date(NOW).toISOString() });
    // one read-only call, narrowed to the account and the year, through the job gate
    expect(fx.calls).toHaveLength(1);
    const call = fx.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.path).toBe("/financial/ReportingBalance");
    expect(call?.query?.["$filter"]).toBe(
      `GLAccount eq guid'${guid(7001)}' and ReportingYear eq 2026`,
    );
    expect(gate.started).toEqual([
      { jobId: `bankbal:${exactDivision}:r1`, budget: BANK_BALANCES_BUDGET },
    ]);
    expect(gate.ended).toEqual([`bankbal:${exactDivision}:r1`]);
  });

  it("is repeatable: the same number again, one more read", async () => {
    const fx = await setup();
    await runBankBalances(ctxFor(fx));
    await runBankBalances(ctxFor(fx, { now: () => NOW + 3_600_000 }, fakeGate()));
    expect((await account())?.m).toBe(80025);
  });

  it("an empty answer is not a zero balance", async () => {
    const fx = await setup();
    fx.glBalances = [];
    const res = await runBankBalances(ctxFor(fx));
    expect(res.summary).toMatchObject({ stored: 0, empty_answer: 1 });
    expect(await account()).toEqual({ m: null, at: null });
  });

  it("more pages than allowed means the figure is not trusted", async () => {
    const fx = await setup();
    fx.glBalances = Array.from({ length: 9 }, (_, i) => ({
      account: 1,
      year: 2026,
      period: i,
      amount: 1,
    }));
    const res = await runBankBalances(ctxFor(fx));
    expect(res.summary).toMatchObject({ stored: 0, incomplete_read: 1 });
    expect((await account())?.m).toBeNull();
  });

  it("skips an account whose ledger account is unknown or whose currency is not the division's", async () => {
    let fx = await setup({ code: null });
    let res = await runBankBalances(ctxFor(fx));
    expect(res.summary).toMatchObject({ no_ledger_account: 1, stored: 0, calls: 0 });
    fx = await setup();
    await db
      .prepare("UPDATE bank_accounts SET currency = 'USD' WHERE id = ?1")
      .bind(w.accountId)
      .run();
    res = await runBankBalances(ctxFor(fx));
    expect(res.summary).toMatchObject({ currency_differs: 1, stored: 0, calls: 0 });
  });

  it("does nothing without an active Exact connection, and skips while credentials are rejected", async () => {
    const fx = await setup();
    await db
      .prepare("UPDATE connections SET status = 'needs_reauth' WHERE id = ?1")
      .bind(w.exactConnectionId)
      .run();
    expect(await runBankBalances(ctxFor(fx))).toMatchObject({
      status: "skipped",
      code: "not_active",
    });
    await db
      .prepare("UPDATE connections SET status = 'active', last_error = ?2 WHERE id = ?1")
      .bind(w.exactConnectionId, CREDENTIALS_REJECTED)
      .run();
    expect(await runBankBalances(ctxFor(fx))).toMatchObject({
      status: "skipped",
      code: "credentials_rejected",
    });
    expect(fx.calls).toHaveLength(0);
  });

  it("skips when no division is synchronised", async () => {
    const fx = await setup();
    await db.prepare("UPDATE divisions SET sync_enabled = 0").run();
    expect(await runBankBalances(ctxFor(fx))).toMatchObject({
      status: "skipped",
      code: "no_divisions",
    });
  });

  it("stops at the budget, at a rate limit, at an auth failure and when Exact is unavailable", async () => {
    const cases: [string, () => Error, string][] = [
      ["budget", () => new ExactBudgetExhaustedError("j"), "budget_exhausted"],
      ["rate", () => new ExactRateLimitedError(1000), "rate_limited"],
      ["auth", () => new ExactAuthError(), "auth_failed"],
      ["503", () => new ExactApiError(503, "x"), "exact_unavailable"],
      ["gate", () => new ExactApiError(500, "x", "gate_unavailable"), "exact_unavailable"],
    ];
    for (const [name, make, code] of cases) {
      const fx = await setup();
      fx.beforeCall = () => {
        throw make();
      };
      const gate = fakeGate();
      const res = await runBankBalances(ctxFor(fx, {}, gate));
      expect(res, name).toMatchObject({ status: "partial", code });
      expect(gate.ended, name).toHaveLength(1); // the job is always ended
      expect((await account())?.m, name).toBeNull();
    }
  });

  it("a bad answer for one account is skipped and reported as partial", async () => {
    const fx = await setup();
    fx.beforeCall = () => {
      throw new ExactApiError(400, "bad");
    };
    const res = await runBankBalances(ctxFor(fx));
    expect(res).toMatchObject({
      status: "partial",
      code: "read_failed",
      summary: { read_failed: 1 },
    });
  });

  it("honours the call budget, the abort signal and a gate that will not start", async () => {
    let fx = await setup();
    expect(await runBankBalances(ctxFor(fx, { budget: 0 }))).toMatchObject({
      status: "partial",
      code: "budget",
    });
    expect(fx.calls).toHaveLength(0);
    fx = await setup();
    const ac = new AbortController();
    ac.abort();
    expect(await runBankBalances(ctxFor(fx, { signal: ac.signal }))).toMatchObject({
      status: "partial",
      code: "aborted",
    });
    fx = await setup();
    const gate = fakeGate({
      startJob: async () => {
        throw new Error("down");
      },
    });
    expect(await runBankBalances(ctxFor(fx, {}, gate))).toMatchObject({
      status: "partial",
      code: "gate_unavailable",
    });
    expect(fx.calls).toHaveLength(0);
    fx = await setup();
    expect(await runBankBalances(ctxFor(fx, { deadlineMs: NOW - 1 }))).toMatchObject({
      status: "partial",
      code: "time_limit",
    });
  });

  it("reads the account with the oldest balance first", async () => {
    const fx = await setup();
    const other = await db
      .prepare(
        `INSERT INTO bank_accounts (connection_id, external_id, name, currency, is_active, exact_balance_at)
         VALUES (?1, 'acc-2', 'Second', 'EUR', 1, '2026-07-01T00:00:00.000Z')`,
      )
      .bind(w.revolutConnectionId)
      .run();
    await db
      .prepare(
        `INSERT INTO bank_account_exact_map (bank_account_id, division_id, journal_code, bank_gl_account_code, created_by, updated_by)
         VALUES (?1, ?2, '91', '1220', 't', 't')`,
      )
      .bind(other.meta.last_row_id, w.divisionId)
      .run();
    await db
      .prepare(
        "UPDATE bank_accounts SET exact_balance_at = '2026-07-10T00:00:00.000Z' WHERE id = ?1",
      )
      .bind(w.accountId)
      .run();
    await db
      .prepare(
        `INSERT INTO gl_accounts (division_id, exact_id, code, name, is_active, updated_at)
         VALUES (?1, ?2, '1220', 'Second', 1, '2026-07-14T00:00:00.000Z')`,
      )
      .bind(w.divisionId, guid(7002))
      .run();
    // only one call is allowed: the account with the OLDER balance (the second) is read first
    const res = await runBankBalances(ctxFor(fx, { budget: 1 }));
    expect(res).toMatchObject({ status: "partial", code: "budget", summary: { stored: 1 } });
    const second = await db
      .prepare("SELECT exact_balance_minor AS m FROM bank_accounts WHERE id = ?1")
      .bind(other.meta.last_row_id)
      .first<{ m: number }>();
    expect(second?.m).toBe(9999900);
    expect((await account())?.m).toBeNull();
  });

  it("is registered as a read-only Exact job that ships off", async () => {
    const { HANDLERS } = await import("../src/jobs/handlers");
    const { defaultJobFor } = await import("../src/jobs/defaults");
    expect(HANDLERS["exact.bank_balances"]).toMatchObject({ usesExact: true });
    expect(defaultJobFor("exact.bank_balances")).toMatchObject({
      enabled: false,
      disabledReason: "awaiting_live_verification",
      exactBudget: BANK_BALANCES_BUDGET,
    });
    expect(env).toBeDefined();
  });
});
