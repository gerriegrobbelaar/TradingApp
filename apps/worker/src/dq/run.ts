/**
 * Job `dq.checks` (hourly; ADR 0045): loads the rule inputs from D1 ONLY (no Exact or Revolut
 * call), evaluates the rules per synchronised administration and once globally, and reconciles the
 * issues: new ones are inserted, open ones refreshed, resolved ones that are seen again reopened
 * (explicit path), snoozes honoured, and issues a rule no longer reports are resolved ONLY when the
 * rule was really evaluated (a rule that was not available, not configured, disabled, failed or cut
 * short vouches for nothing).
 *
 * Safe to repeat (handler contract): issues are keyed by fingerprint, every change is conditional
 * on the status it was planned from, the run row is keyed by the job run id, and the summary holds
 * counts and codes only.
 */
import {
  emptyInput,
  evaluateRules,
  resolveAllConfigs,
  type DqInput,
  type DqRuleResult,
} from "@camelthorn/core";
import type { HandlerResult, JobContext } from "../jobs/types";
import {
  loadBankAccounts,
  loadBankTransactions,
  loadBookedMatches,
  loadBookingHealth,
  loadExactBudget,
  loadExactConnection,
  loadFx,
  loadJobs,
  loadLedger,
  loadOpenItems,
  loadPurchaseEntries,
  loadRelations,
  loadWebhook,
  type DescribeHandler,
  type DqDivision,
} from "./load";
import { applyResults, loadRuleRows, recordRun, toOverrides, type DivisionOutcome } from "./store";

export interface DqRunDeps {
  describeHandler: DescribeHandler;
}

const SUSPENSE_RULE = "ledger.suspense_not_zero";

export async function loadDivisions(db: D1Database): Promise<DqDivision[]> {
  const rows = (
    await db
      .prepare(
        `SELECT d.id, d.exact_division, d.base_currency FROM divisions d
           JOIN connections c ON c.id = d.connection_id
         WHERE d.sync_enabled = 1 AND c.kind = 'exact' AND c.status <> 'disabled'
         ORDER BY d.id`,
      )
      .all<{ id: number; exact_division: number; base_currency: string }>()
  ).results;
  return rows.map((r) => ({
    id: r.id,
    exactDivision: r.exact_division,
    baseCurrency: r.base_currency,
  }));
}

const add = (a: DivisionOutcome, b: DivisionOutcome): DivisionOutcome => ({
  newIssues: a.newIssues + b.newIssues,
  refreshed: a.refreshed + b.refreshed,
  reopened: a.reopened + b.reopened,
  unsnoozed: a.unsnoozed + b.unsnoozed,
  resolved: a.resolved + b.resolved,
});

export async function runDqChecks(ctx: JobContext, deps: DqRunDeps): Promise<HandlerResult> {
  const db = ctx.env.DB;
  const nowMs = ctx.now();
  const startedAt = new Date(nowMs).toISOString();
  let sectionFailures = 0;

  /** One input section; a failure makes the rules that need it not_available, never a guess. */
  async function section<T>(name: string, load: () => Promise<T>): Promise<T | null> {
    try {
      return await load();
    } catch (e) {
      sectionFailures += 1;
      ctx.log("dq_section_failed", {
        section: name,
        error: e instanceof Error ? e.name : "unknown",
      });
      return null;
    }
  }

  const rows = await loadRuleRows(db);
  const configs = resolveAllConfigs(toOverrides(rows));
  const suspense = configs.get(SUSPENSE_RULE)?.threshold;
  const suspenseCodes = Array.isArray(suspense) ? (suspense as string[]) : [];

  const results: { divisionId: number; results: DqRuleResult[] }[] = [];
  let outcome: DivisionOutcome = {
    newIssues: 0,
    refreshed: 0,
    reopened: 0,
    unsnoozed: 0,
    resolved: 0,
  };
  let aborted = false;

  const divisions = await loadDivisions(db);
  for (const d of divisions) {
    if (ctx.signal.aborted) {
      aborted = true;
      break;
    }
    const tx = await section("bank_transactions", () => loadBankTransactions(db, d, nowMs));
    const input: DqInput = {
      ...emptyInput(nowMs, d.id, d.baseCurrency),
      bankAccounts: await section("bank_accounts", () => loadBankAccounts(db, d)),
      bankTransactions: tx === null ? null : tx.lines,
      bankTransactionsCapped: tx?.capped ?? false,
      bookedMatches: await section("booked_matches", () => loadBookedMatches(db, d)),
      booking: await section("booking_health", () => loadBookingHealth(db, d, nowMs)),
      openItems: await section("open_items", () => loadOpenItems(db, d)),
      purchaseEntries: await section("purchase_entries", () => loadPurchaseEntries(db, d, nowMs)),
      relations: await section("relations", () => loadRelations(db, d)),
      fx: await section("fx", () => loadFx(db, d, nowMs)),
      ledger: await section("ledger", () => loadLedger(db, d, nowMs, suspenseCodes)),
      exactBudget: await section("exact_budget", () => loadExactBudget(db, d, nowMs)),
    };
    const res = evaluateRules(input, "division", configs);
    outcome = add(outcome, await applyResults(db, d.id, res, startedAt, ctx.run.id));
    results.push({ divisionId: d.id, results: res });
  }

  if (!aborted && !ctx.signal.aborted) {
    const input: DqInput = {
      ...emptyInput(nowMs, 0),
      fx: await section("fx", () => loadFx(db, null, nowMs)),
      jobs: await section("jobs", () => loadJobs(db, nowMs, deps.describeHandler)),
      webhook: await section("webhook", () => loadWebhook(db, nowMs)),
      exactConnection: await section("exact_connection", () => loadExactConnection(db)),
    };
    const res = evaluateRules(input, "global", configs);
    outcome = add(outcome, await applyResults(db, 0, res, startedAt, ctx.run.id));
    results.push({ divisionId: 0, results: res });
  } else {
    aborted = true;
  }

  const all = results.flatMap((r) => r.results);
  const evaluated = all.filter((r) => r.status === "ok" || r.status === "issues").length;
  const unavailable = all.filter(
    (r) => r.status === "not_available" || r.status === "not_configured" || r.status === "error",
  ).length;
  const failedRules = all.filter((r) => r.status === "error").length;
  const partial = aborted || sectionFailures > 0 || failedRules > 0;
  const status: "ok" | "partial" = partial ? "partial" : "ok";
  const errorCode = aborted
    ? "aborted"
    : sectionFailures > 0 || failedRules > 0
      ? "section_failed"
      : null;

  await recordRun(db, {
    jobRunId: ctx.run.id,
    startedAt,
    finishedAt: new Date(ctx.now()).toISOString(),
    status,
    divisions: divisions.length,
    rulesEvaluated: evaluated,
    rulesUnavailable: unavailable,
    outcome,
    errorCode,
  });

  return {
    status,
    ...(errorCode !== null ? { code: errorCode } : {}),
    summary: {
      divisions: divisions.length,
      rulesEvaluated: evaluated,
      rulesUnavailable: unavailable,
      sectionFailures,
      ...outcome,
    },
  };
}
