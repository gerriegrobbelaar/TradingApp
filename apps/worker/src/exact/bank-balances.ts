/**
 * Job `exact.bank_balances` (Phase 8, D8a, ADR 0045): reads the balance of each MAPPED bank ledger
 * account from Exact and stores it on our bank account row (exact_balance_minor / exact_balance_at),
 * so the data quality rule "Exact balance differs from the bank balance" can compare it with the
 * bank's own number.
 *
 *  - READ ONLY towards Exact: one `financial/ReportingBalance` read per mapped account (filtered by
 *    GLAccount and the current reporting year), through the division's ExactGate with a job
 *    budget. Writes only to D1.
 *  - Which accounts: those with a row in bank_account_exact_map (the account map of the matching
 *    feature), active, whose currency is the division currency (a ledger balance is in the division
 *    currency). Accounts whose ledger account is not in our copy of the chart are reported as
 *    skipped with a code, not guessed.
 *  - Balance = sum of the periods 0..99 of the current Amsterdam year (LEDGER_BALANCE_SEMANTICS,
 *    debit - credit; ADR 0024). An incomplete read (more pages than allowed) stores nothing.
 *  - Stops at the deadline or when the budget is gone; the accounts left wait for the next run
 *    (accounts with the oldest balance are read first, so none is starved).
 *  - ING and Rabobank: they have no row in bank_accounts (only Revolut accounts do), so there is no
 *    second number to compare with; this job does not cover them (ADR 0045, open item).
 */
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  createExactClient,
  type ExactTransport,
} from "@camelthorn/exact";
import { LEDGER_BALANCE_SEMANTICS, amsterdamParts, signedByAccount } from "@camelthorn/core";
import { CREDENTIALS_REJECTED } from "./gate";
import { createGateTransport, gateName, getExactGate } from "./gate-transport";
import type { JobGate } from "./sync";
import type { HandlerResult, JobContext } from "../jobs/types";

/** Exact calls per run and administration. */
export const BANK_BALANCES_BUDGET = 20;
/** Pages read per account; more rows than that (many cost centres) mean the figure is not trusted. */
const PAGES_PER_ACCOUNT = 3;
const RUN_MAX_MS = 5 * 60_000;

interface AccountRow {
  id: number;
  currency: string;
  gl_code: string;
  exact_id: string | null;
}

interface DivisionRow {
  id: number;
  exact_division: number;
  base_currency: string;
}

type Skip =
  "no_ledger_account" | "currency_differs" | "incomplete_read" | "empty_answer" | "read_failed";

export async function runBankBalances(ctx: JobContext): Promise<HandlerResult> {
  const { env } = ctx;
  const db = env.DB;
  const deps = ctx.syncDeps ?? {};
  const clock = deps.now ?? ctx.now;
  const nowMs = clock();
  const deadline = Math.min(ctx.deadlineMs, nowMs + RUN_MAX_MS);

  const conn = await db
    .prepare(
      "SELECT id, status, last_error FROM connections WHERE kind = 'exact' ORDER BY id LIMIT 1",
    )
    .first<{ id: number; status: string; last_error: string | null }>();
  if (!conn) return { status: "skipped", code: "no_connection", summary: {} };
  if (conn.status !== "active") return { status: "skipped", code: "not_active", summary: {} };
  if (conn.last_error === CREDENTIALS_REJECTED) {
    return { status: "skipped", code: "credentials_rejected", summary: {} };
  }

  const divisions = (
    await db
      .prepare(
        `SELECT id, exact_division, base_currency FROM divisions
         WHERE connection_id = ?1 AND sync_enabled = 1 ORDER BY id`,
      )
      .bind(conn.id)
      .all<DivisionRow>()
  ).results;
  if (divisions.length === 0) return { status: "skipped", code: "no_divisions", summary: {} };

  const year = Number(amsterdamParts(nowMs).date.slice(0, 4));
  let read = 0;
  let stored = 0;
  let calls = 0;
  const skipped: Record<Skip, number> = {
    no_ledger_account: 0,
    currency_differs: 0,
    incomplete_read: 0,
    empty_answer: 0,
    read_failed: 0,
  };
  let stopped: string | null = null;

  for (const d of divisions) {
    const accounts = (
      await db
        .prepare(
          `SELECT ba.id, ba.currency, m.bank_gl_account_code AS gl_code,
                  (SELECT g.exact_id FROM gl_accounts g WHERE g.division_id = m.division_id
                     AND g.is_active = 1 AND trim(g.code) = m.bank_gl_account_code LIMIT 1) AS exact_id
           FROM bank_account_exact_map m JOIN bank_accounts ba ON ba.id = m.bank_account_id
           WHERE m.division_id = ?1 AND ba.is_active = 1
           ORDER BY COALESCE(ba.exact_balance_at, ''), ba.id`,
        )
        .bind(d.id)
        .all<AccountRow>()
    ).results;
    if (accounts.length === 0) continue;

    const jobId = `bankbal:${d.exact_division}:r${ctx.run.id}`;
    const gate: JobGate = deps.gate ?? {
      startJob: (id, budget) => getExactGate(env, gateName(d.exact_division)).startJob(id, budget),
      endJob: (id) => getExactGate(env, gateName(d.exact_division)).endJob(id),
    };
    const base: ExactTransport = deps.transport ?? createGateTransport(env, d.exact_division);
    const transport: ExactTransport = (req) => {
      calls += 1;
      return base(req);
    };
    const client = createExactClient(transport, {
      division: d.exact_division,
      jobId,
      priority: "job",
      divisionCurrency: d.base_currency,
    });

    try {
      await gate.startJob(jobId, ctx.budget);
    } catch {
      stopped = "gate_unavailable";
      break;
    }
    try {
      for (const a of accounts) {
        if (ctx.signal.aborted || clock() >= deadline || calls >= ctx.budget) {
          stopped = ctx.signal.aborted ? "aborted" : calls >= ctx.budget ? "budget" : "time_limit";
          break;
        }
        if (a.currency !== d.base_currency) {
          skipped.currency_differs += 1;
          continue;
        }
        if (a.exact_id === null) {
          skipped.no_ledger_account += 1;
          continue;
        }
        let rows;
        try {
          const chunk = await client.listReportingBalancesChunk(null, {
            year,
            glAccountId: a.exact_id,
            maxPages: PAGES_PER_ACCOUNT,
          });
          if (chunk.error !== undefined) throw new Error("chunk_error");
          if (!chunk.complete) {
            skipped.incomplete_read += 1;
            continue;
          }
          if (chunk.items.length === 0) {
            // Nothing came back: an empty answer is not a zero balance (a filter Exact ignored
            // would look the same). Stored only when Exact returned rows.
            skipped.empty_answer += 1;
            continue;
          }
          rows = chunk.items;
        } catch (e) {
          // Budget, rate limit, auth and an unavailable Exact stop the run for everyone; anything
          // else (a bad shape) only skips this account.
          const stop =
            e instanceof ExactBudgetExhaustedError
              ? "budget_exhausted"
              : e instanceof ExactRateLimitedError
                ? "rate_limited"
                : e instanceof ExactAuthError
                  ? "auth_failed"
                  : e instanceof ExactApiError &&
                      ([502, 503, 504].includes(e.status) ||
                        e.code === "network" ||
                        e.code === "gate_unavailable")
                    ? "exact_unavailable"
                    : null;
          if (stop !== null) {
            stopped = stop;
            break;
          }
          skipped.read_failed += 1;
          ctx.log("bank_balance_read_failed", { error: e instanceof Error ? e.name : "unknown" });
          continue;
        }
        read += 1;
        const sums = signedByAccount(
          rows
            .filter((r) => r.reportingYear === year)
            .map((r) => ({
              glAccountExactId: a.exact_id as string,
              year: r.reportingYear,
              period: r.reportingPeriod,
              amountMinor: r.amount.minor,
              balanceType: r.balanceType,
            })),
          year,
          { from: 0, to: 99 },
          LEDGER_BALANCE_SEMANTICS,
        );
        const total = sums.get(a.exact_id) ?? 0n;
        if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < -BigInt(Number.MAX_SAFE_INTEGER)) {
          skipped.read_failed += 1;
          continue;
        }
        await db
          .prepare(
            "UPDATE bank_accounts SET exact_balance_minor = ?2, exact_balance_at = ?3 WHERE id = ?1",
          )
          .bind(a.id, Number(total), new Date(clock()).toISOString())
          .run();
        stored += 1;
      }
    } finally {
      await gate.endJob(jobId).catch(() => undefined);
    }
    if (stopped !== null) break;
  }

  const skippedTotal = Object.values(skipped).reduce((x, y) => x + y, 0);
  const summary = { read, stored, skipped: skippedTotal, ...skipped, calls };
  if (stopped !== null) {
    return { status: "partial", code: stopped, summary, callsUsed: calls };
  }
  return {
    status: skipped.read_failed > 0 ? "partial" : "ok",
    ...(skipped.read_failed > 0 ? { code: "read_failed" } : {}),
    summary,
    callsUsed: calls,
  };
}
