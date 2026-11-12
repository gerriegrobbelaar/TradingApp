/**
 * Review D8a: adversarial Worker tests.
 *  - exact.bank_balances never sums rows of another ledger account (a filter Exact ignored), and
 *    never reads more pages than the budget has left;
 *  - notes typed by people are masked before they are stored, audited or returned;
 *  - loosening a critical rule in small steps needs the phrase every time, and the direction is
 *    the rule's own (a SHORTER window is looser for "IBAN changed in the last N days");
 *  - a loader list that hit its cap never auto-resolves the tail it did not read.
 */
import { DQ_LOOSEN_PHRASE, MAX_ISSUES_PER_RULE, type DqIssueDto } from "@camelthorn/core";
import type { ExactTransport } from "@camelthorn/exact";
import { beforeEach, describe, expect, it } from "vitest";
import { BANK_BALANCES_BUDGET, runBankBalances } from "../src/exact/bank-balances";
import { addSession, addUser, authed, resetDb } from "./helpers";
import { db, issues, resetDq, ruleStatus, runDq } from "./dq-helpers";
import { addRelation, jobContext, NOW, resetWorld, type World } from "./matching-helpers";
import { FakeExact, auditRows, fakeGate, guid } from "./sync-helpers";

let w: World;
const FULL_IBAN = "NL91ABNA0417164300";

describe("exact.bank_balances (review)", () => {
  async function setup(): Promise<FakeExact> {
    w = await resetWorld();
    const ex = (
      (await db
        .prepare("SELECT exact_division AS n FROM divisions WHERE id = ?1")
        .bind(w.divisionId)
        .first<{ n: number }>()) as { n: number }
    ).n;
    await db
      .prepare(
        `INSERT INTO gl_accounts (division_id, exact_id, code, name, is_active, updated_at)
         VALUES (?1, ?2, '1210', 'Revolut EUR', 1, '2026-07-14T00:00:00.000Z')`,
      )
      .bind(w.divisionId, guid(7001))
      .run();
    const fx = new FakeExact(ex);
    fx.glBalances = [
      { account: 1, year: 2026, period: 0, amount: 10 },
      { account: 2, year: 2026, period: 1, amount: 99999 },
    ];
    return fx;
  }
  const balance = async () =>
    (
      await db
        .prepare("SELECT exact_balance_minor AS m FROM bank_accounts WHERE id = ?1")
        .bind(w.accountId)
        .first<{ m: number | null }>()
    )?.m;

  it("a filter Exact ignores (rows of other ledger accounts) stores nothing and reports partial", async () => {
    const fx = await setup();
    // Exact drops the GLAccount clause: every account's rows come back
    const ignoring: ExactTransport = (req) =>
      fx.transport({
        ...req,
        query: {
          ...req.query,
          $filter: (req.query?.["$filter"] ?? "").replace(/GLAccount eq guid'[^']+' and /, ""),
        },
      });
    const res = await runBankBalances(
      jobContext({
        job: {
          id: 1,
          name: "exact.bank_balances",
          handler: "exact.bank_balances",
          exactBudget: 20,
        },
        budget: BANK_BALANCES_BUDGET,
        syncDeps: { transport: ignoring, gate: fakeGate(), now: () => NOW },
      }),
    );
    expect(res).toMatchObject({
      status: "partial",
      code: "other_account_rows",
      summary: { stored: 0, other_account_rows: 1 },
    });
    expect(await balance()).toBeNull();
    // and never anything but a read
    expect(fx.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("never reads more pages than the budget has left", async () => {
    const fx = await setup();
    fx.glBalances = Array.from({ length: 4 }, (_, i) => ({
      account: 1,
      year: 2026,
      period: i,
      amount: 1,
    }));
    const res = await runBankBalances(
      jobContext({
        job: { id: 1, name: "exact.bank_balances", handler: "exact.bank_balances", exactBudget: 1 },
        budget: 1,
        syncDeps: { transport: fx.transport, gate: fakeGate(), now: () => NOW },
      }),
    );
    expect(fx.calls).toHaveLength(1);
    expect(res.callsUsed).toBe(1);
    expect(res.summary).toMatchObject({ stored: 0, incomplete_read: 1 });
    expect(await balance()).toBeNull();
  });
});

describe("API (review)", () => {
  const tokens: Record<string, string> = {};
  const DAY = 86_400_000;
  const send = async (role: string, method: string, path: string, json?: unknown) => {
    const res = await authed(path, tokens[role] as string, {
      method,
      ...(json !== undefined ? { json } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(async () => {
    await resetDb();
    await resetDq();
    w = await resetWorld();
    for (const role of ["admin", "finance"] as const) {
      tokens[role] = await addSession(await addUser(`${role}@camelthorncapital.com`, [role]));
    }
  });

  async function oneIssue(): Promise<number> {
    await addRelation({
      divisionId: w.divisionId,
      name: "Acme B.V.",
      ibans: [],
      ibanChangedAt: "2026-07-10T00:00:00.000Z",
    });
    await runDq();
    return (await issues("status = 'open'"))[0]?.id as number;
  }

  it("a note with an IBAN is masked in the issue row, the audit row and the answer (snooze and resolve)", async () => {
    const id = await oneIssue();
    const until = new Date(Date.now() + 3 * DAY).toISOString();
    const s = await send("finance", "POST", `/api/dq/issues/${id}/snooze`, {
      until,
      note: `verified ${FULL_IBAN} by phone`,
    });
    expect(s.status).toBe(200);
    const r = await send("finance", "POST", `/api/dq/issues/${id}/resolve-note`, {
      note: `new IBAN NL91 ABNA 0417 1643 00 confirmed`,
    });
    expect(r.status).toBe(200);
    // an identical repeat (same raw note) is still recognised as the same request
    const again = await send("finance", "POST", `/api/dq/issues/${id}/resolve-note`, {
      note: `new IBAN NL91 ABNA 0417 1643 00 confirmed`,
    });
    expect(again.status).toBe(200);
    expect(await auditRows("dq.issue_resolved", id)).toHaveLength(1);
    const stored = JSON.stringify(
      (await db.prepare("SELECT * FROM dq_issues WHERE id = ?1").bind(id).all()).results,
    );
    const audit = JSON.stringify(
      (await db.prepare("SELECT * FROM audit_log WHERE action LIKE 'dq.issue_%'").all()).results,
    );
    for (const text of [stored, audit, JSON.stringify(s.body), JSON.stringify(r.body)]) {
      expect(text).not.toContain("0417164300");
      expect(text).not.toContain("0417 1643");
    }
    expect((r.body["issue"] as DqIssueDto).resolutionNote).toMatch(/^new IBAN NL91/);
  });

  it("a snooze longer than 90 days is refused by the server", async () => {
    const id = await oneIssue();
    const r = await send("finance", "POST", `/api/dq/issues/${id}/snooze`, {
      until: new Date(Date.now() + 91 * DAY).toISOString(),
      note: "later",
    });
    expect(r.status).toBe(400);
    expect(r.body["error"]).toBe("until_too_far");
  });

  it("supplier IBAN changed (critical): a shorter window needs the phrase, every single step", async () => {
    const path = "/api/dq/rules/payables.supplier_iban_changed";
    const step1 = await send("admin", "PATCH", path, { rev: null, threshold: 29 });
    expect(step1.status).toBe(422);
    expect(step1.body["error"]).toBe("confirmation_required");
    const ok = await send("admin", "PATCH", path, {
      rev: null,
      threshold: 25,
      confirm: DQ_LOOSEN_PHRASE,
    });
    expect(ok.status).toBe(200);
    const rev = (ok.body["rule"] as { rev: string }).rev;
    // the next small step is judged on its own: phrase again
    const step2 = await send("admin", "PATCH", path, { rev, threshold: 24 });
    expect(step2.status).toBe(422);
    // a longer window is tighter: no phrase
    const tighter = await send("admin", "PATCH", path, { rev, threshold: 60 });
    expect(tighter.status).toBe(200);
    // switching the critical rule off needs the phrase too
    const rev2 = (tighter.body["rule"] as { rev: string }).rev;
    expect((await send("admin", "PATCH", path, { rev: rev2, enabled: false })).status).toBe(422);
    expect(await auditRows("dq.rule_changed", "payables.supplier_iban_changed")).toHaveLength(2);
  });
});

describe("loader caps (review)", () => {
  beforeEach(async () => {
    await resetDq();
    w = await resetWorld();
    await db.prepare("DELETE FROM fx_rate_conflicts").run();
  });

  it("more unresolved ECB conflicts than the rule cap: truncated, so the issue of one not listed stays open", async () => {
    const n = MAX_ISSUES_PER_RULE + 2;
    const stmts = Array.from({ length: n }, (_, i) =>
      db
        .prepare(
          `INSERT INTO fx_rate_conflicts (currency, rate_date, stored_rate, ecb_rate)
           VALUES ('USD', ?1, '1.1', ?2)`,
        )
        .bind("2026-07-01", `1.${1000 + i}`),
    );
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    // an issue for a conflict id the capped list does not reach
    const last = (await db.prepare("SELECT MAX(id) AS id FROM fx_rate_conflicts").first<{
      id: number;
    }>()) as { id: number };
    await db
      .prepare(
        `INSERT INTO dq_issues (division_id, rule_id, fingerprint, area, severity, subject, message, fix,
           first_seen_at, last_seen_at)
         VALUES (0, 'fx.rate_conflicts', ?1, 'fx', 'warning', 's', 'm', 'fx', ?2, ?2)`,
      )
      .bind(`fx.rate_conflicts:conflict|${last.id}`, "2026-07-01T00:00:00.000Z")
      .run();
    await runDq();
    const st = await ruleStatus("fx.rate_conflicts", 0);
    expect(st?.status).toBe("issues");
    const row = await issues(`fingerprint = 'fx.rate_conflicts:conflict|${last.id}'`);
    expect(row[0]?.status).toBe("open");
    await db.prepare("DELETE FROM fx_rate_conflicts").run();
  });
});

describe("Exact budget day (review)", () => {
  beforeEach(async () => {
    await resetDq();
    w = await resetWorld();
  });

  it("reads the usage row of the UTC day the gate writes, also after midnight in Amsterdam", async () => {
    const exactDivision = (
      (await db
        .prepare("SELECT exact_division AS n FROM divisions WHERE id = ?1")
        .bind(w.divisionId)
        .first<{ n: number }>()) as { n: number }
    ).n;
    // 23:30 UTC on 15 July is 01:30 on 16 July in Amsterdam; the gate's row is '2026-07-15'
    const late = Date.parse("2026-07-15T23:30:00.000Z");
    await db
      .prepare(
        "INSERT INTO exact_usage (division, day, calls, remaining) VALUES (?1, '2026-07-15', 4900, NULL)",
      )
      .bind(exactDivision)
      .run();
    await runDq({ now: () => late });
    const open = await issues(`fingerprint = 'integrations.exact_budget:budget'`);
    expect(open[0]?.status).toBe("open");
    await db.prepare("DELETE FROM exact_usage").run();
  });
});
