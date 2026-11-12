/**
 * The dq.checks job end to end on D1 (ADR 0045): issues are opened from real rows, a rerun changes
 * nothing, issues a rule stops reporting are resolved, a rule that could not vouch resolves
 * nothing, snoozes and reopening behave, and nothing leaves the database.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  dqContext,
  db,
  fingerprints,
  flakyDb,
  issues,
  NOW,
  resetDq,
  ruleStatus,
  runDq,
} from "./dq-helpers";
import {
  addItem,
  addRelation,
  addTx,
  CUSTOMER_IBAN,
  resetWorld,
  type World,
} from "./matching-helpers";

let w: World;
const DAY = 86_400_000;
const T0 = "2026-07-01T08:00:00.000Z"; // 14 days before NOW

async function seedProblems(): Promise<{ txId: number; itemIds: number[]; relId: number }> {
  const rel = await addRelation({
    divisionId: w.divisionId,
    name: "Acme B.V.",
    ibans: [],
    ibanChangedAt: "2026-07-10T00:00:00.000Z",
  });
  const itemIds: number[] = [];
  for (let i = 0; i < 2; i++) {
    itemIds.push(
      await addItem({
        divisionId: w.divisionId,
        kind: "bill",
        invoiceNumber: "F-2026-001",
        openMinor: 10_000,
        relationExactId: rel.exactId,
        relationName: "Acme B.V.",
      }),
    );
  }
  const txId = await addTx({
    accountId: w.accountId,
    connectionId: w.revolutConnectionId,
    amountMinor: -5_000,
    createdAt: T0,
    counterpartyName: "Acme B.V.",
    counterpartyIban: CUSTOMER_IBAN,
  });
  return { txId, itemIds, relId: rel.id };
}

beforeEach(async () => {
  await resetDq();
  w = await resetWorld();
});

describe("dq.checks: opens issues from the data", () => {
  it("opens the issues the rows call for, and records every rule's status", async () => {
    const { txId, relId } = await seedProblems();
    const res = await runDq();
    expect(res.status).toBe("ok");
    expect(res.summary).toMatchObject({ divisions: 1 });
    const open = await fingerprints();
    expect(open).toContain(`bank.unmatched_old:tx|${txId}`);
    expect(open).toContain(`payables.supplier_iban_changed:rel|${relId}`);
    expect(open).toContain(`master.supplier_no_iban:rel|${relId}`);
    expect(open.some((f) => f.startsWith("payables.duplicate_invoices:"))).toBe(true);
    // never imported -> the stale-rate rule fires globally
    expect(open).toContain("fx.rate_stale:ecb");
    const global = await issues("division_id = 0");
    expect(global.map((i) => i.rule_id)).toContain("fx.rate_stale");

    const un = await issues(`fingerprint = 'bank.unmatched_old:tx|${txId}'`);
    expect(un[0]).toMatchObject({
      division_id: w.divisionId,
      severity: "warning",
      status: "open",
      amount_minor: -5000,
      currency: "EUR",
    });
    expect(un[0]?.message).toBe("EUR -50.00 unmatched for 14 days.");
    // Exact balance never read -> not available, with a reason, never ok
    expect(await ruleStatus("bank.balance_mismatch", w.divisionId)).toMatchObject({
      status: "not_available",
      reason: "no_comparable_exact_balance",
    });
    for (const id of [
      "receivables.bounced_emails",
      "receivables.disputed_chased",
      "master.vat_code_country",
    ]) {
      expect(await ruleStatus(id, w.divisionId), id).toMatchObject({ status: "not_available" });
    }
    expect(await ruleStatus("ledger.suspense_not_zero", w.divisionId)).toMatchObject({
      status: "not_configured",
      reason: "no_suspense_accounts_configured",
    });
    expect(await ruleStatus("ledger.closed_period_bookings", w.divisionId)).toMatchObject({
      status: "not_available",
      reason: "no_closed_period_marker",
    });
    const run = await db.prepare("SELECT * FROM dq_runs").all<Record<string, unknown>>();
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({ status: "ok", job_run_id: 1, engine_version: "1" });
  });

  it("never sends the database anything it should not: no Exact or Revolut call, no full IBAN stored", async () => {
    await seedProblems();
    await addTx({
      accountId: w.accountId,
      connectionId: w.revolutConnectionId,
      amountMinor: -100,
      createdAt: T0,
      counterpartyName: `Pay NL91ABNA0417164300 now`,
      reference: "ref",
      counterpartyIban: CUSTOMER_IBAN,
    });
    await runDq();
    const all = await db.prepare("SELECT * FROM dq_issues").all<Record<string, unknown>>();
    const text = JSON.stringify(all.results);
    expect(text).not.toContain("NL91ABNA0417164300");
    expect(text).not.toContain("0417164300");
    expect(text).toContain("NL91****4300");
    const audit = JSON.stringify(
      (await db.prepare("SELECT * FROM audit_log WHERE action LIKE 'dq.%'").all()).results,
    );
    expect(audit).not.toContain("0417164300");
  });
});

describe("dq.checks: reruns, auto-resolve and snooze", () => {
  it("a rerun changes nothing but last_seen; one run row per job run", async () => {
    await seedProblems();
    await runDq();
    const first = await issues();
    const second = await (async () => {
      await runDq({ now: () => NOW + 3_600_000 });
      return issues();
    })();
    expect(
      second.map((i) => [i.id, i.fingerprint, i.status, i.first_seen_at, i.reopen_count]),
    ).toEqual(first.map((i) => [i.id, i.fingerprint, i.status, i.first_seen_at, i.reopen_count]));
    expect(
      second.every((i) => i.last_seen_at > (first.find((f) => f.id === i.id)?.last_seen_at ?? "")),
    ).toBe(true);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM dq_runs").first<{ n: number }>())?.n).toBe(
      1,
    );
    // another job run id is another run row
    await runDq({
      run: { id: 2, attempt: 1, scheduledFor: new Date(NOW).toISOString(), requestedBy: "system" },
    });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM dq_runs").first<{ n: number }>())?.n).toBe(
      2,
    );
    expect((await issues()).length).toBe(first.length);
  });

  it("an issue the rule stops reporting is resolved by the system, and a new sighting reopens it once", async () => {
    const { itemIds } = await seedProblems();
    await runDq();
    expect((await fingerprints()).some((f) => f.startsWith("payables.duplicate_invoices:"))).toBe(
      true,
    );
    await db.prepare("DELETE FROM open_items WHERE id = ?1").bind(itemIds[1]).run();
    await runDq({ now: () => NOW + 3_600_000 });
    const dup = (await issues()).find((i) => i.rule_id === "payables.duplicate_invoices");
    expect(dup).toMatchObject({ status: "resolved", resolved_by: "system" });
    expect(dup?.resolved_at).not.toBeNull();
    // still resolved on the next run
    await runDq({ now: () => NOW + 2 * 3_600_000 });
    expect((await issues(`id = ${dup?.id}`))[0]?.status).toBe("resolved");
    // the second bill comes back: the same fingerprint reopens, counted
    await addItem({
      divisionId: w.divisionId,
      kind: "bill",
      invoiceNumber: "F-2026-001",
      openMinor: 10_000,
      relationExactId:
        (await db.prepare("SELECT exact_id FROM relations").first<{ exact_id: string }>())
          ?.exact_id ?? "",
      relationName: "Acme B.V.",
    });
    await runDq({ now: () => NOW + 3 * 3_600_000 });
    const again = (await issues(`id = ${dup?.id}`))[0];
    expect(again).toMatchObject({
      status: "open",
      reopen_count: 1,
      resolved_at: null,
      resolved_by: null,
    });
    expect(again?.first_seen_at).toBe(dup?.first_seen_at);
  });

  it("a person's resolve is reopened by the next run when the problem is still there", async () => {
    const { txId } = await seedProblems();
    await runDq();
    await db
      .prepare(
        `UPDATE dq_issues SET status = 'resolved', resolved_at = ?2, resolved_by = 'a@b.example',
           resolution_note = 'checked' WHERE fingerprint = ?1`,
      )
      .bind(`bank.unmatched_old:tx|${txId}`, new Date(NOW).toISOString())
      .run();
    await runDq({ now: () => NOW + 3_600_000 });
    expect((await issues(`fingerprint = 'bank.unmatched_old:tx|${txId}'`))[0]).toMatchObject({
      status: "open",
      reopen_count: 1,
      resolved_by: null,
    });
  });

  it("a disabled rule resolves nothing and shows as disabled", async () => {
    const { txId } = await seedProblems();
    await runDq();
    await db
      .prepare(
        "INSERT INTO dq_rules (id, enabled, rev, updated_by, updated_at) VALUES ('bank.unmatched_old', 0, 'r1', 'a@b.example', ?1)",
      )
      .bind(new Date(NOW).toISOString())
      .run();
    await db
      .prepare("UPDATE bank_transactions SET booked_at = ?1")
      .bind(new Date(NOW).toISOString())
      .run();
    const res = await runDq({ now: () => NOW + 3_600_000 });
    expect(res.status).toBe("ok");
    expect(await ruleStatus("bank.unmatched_old", w.divisionId)).toMatchObject({
      status: "disabled",
      reason: "rule_disabled",
    });
    expect((await issues(`fingerprint = 'bank.unmatched_old:tx|${txId}'`))[0]?.status).toBe("open");
  });

  it("a section that fails makes its rules not_available and resolves none of their issues", async () => {
    const { relId } = await seedProblems();
    await runDq();
    const before = await fingerprints();
    expect(before).toContain(`master.supplier_no_iban:rel|${relId}`);
    const flaky = { ...env, DB: flakyDb("FROM relations r") } as typeof env;
    const res = await runDq({ now: () => NOW + 3_600_000 }, flaky);
    expect(res).toMatchObject({ status: "partial", code: "section_failed" });
    expect(await ruleStatus("master.supplier_no_iban", w.divisionId)).toMatchObject({
      status: "not_available",
      reason: "relations_not_loaded",
    });
    expect(await fingerprints()).toEqual(before);
  });

  it("snooze: kept (and refreshed) while it runs, open again when it ends, resolved if the problem is gone", async () => {
    const { txId } = await seedProblems();
    await runDq();
    const fp = `bank.unmatched_old:tx|${txId}`;
    const until = new Date(NOW + DAY).toISOString();
    await db
      .prepare(
        "UPDATE dq_issues SET status = 'snoozed', snoozed_until = ?2, snoozed_by = 'a@b.example' WHERE fingerprint = ?1",
      )
      .bind(fp, until)
      .run();
    await runDq({ now: () => NOW + 3_600_000 });
    let row = (await issues(`fingerprint = '${fp}'`))[0];
    expect(row).toMatchObject({ status: "snoozed", snoozed_until: until });
    expect(row?.last_seen_at).toBe(new Date(NOW + 3_600_000).toISOString());
    await runDq({ now: () => NOW + 2 * DAY });
    row = (await issues(`fingerprint = '${fp}'`))[0];
    expect(row).toMatchObject({ status: "open", snoozed_until: null });
    // snoozed again, and the line is matched meanwhile: the issue resolves
    await db
      .prepare("UPDATE dq_issues SET status = 'snoozed', snoozed_until = ?2 WHERE fingerprint = ?1")
      .bind(fp, new Date(NOW + 9 * DAY).toISOString())
      .run();
    await db
      .prepare("UPDATE bank_transactions SET booked_at = ?1")
      .bind(new Date(NOW).toISOString())
      .run();
    await runDq({ now: () => NOW + 2 * DAY + 3_600_000 });
    expect((await issues(`fingerprint = '${fp}'`))[0]).toMatchObject({
      status: "resolved",
      resolved_by: "system",
      snoozed_until: null,
    });
  });
});

describe("dq.checks: rules that use other tables", () => {
  it("suspense accounts: not configured, then configured with codes, then a non-zero balance", async () => {
    await runDq();
    expect(await ruleStatus("ledger.suspense_not_zero", w.divisionId)).toMatchObject({
      status: "not_configured",
    });
    await db
      .prepare(
        "INSERT INTO dq_rules (id, rev, threshold_json, updated_by, updated_at) VALUES ('ledger.suspense_not_zero', 'r', ?1, 'a@b.example', ?2)",
      )
      .bind(JSON.stringify({ codes: ["1999"] }), new Date(NOW).toISOString())
      .run();
    // the ledger was never read: not available, not a zero balance
    await runDq();
    expect(await ruleStatus("ledger.suspense_not_zero", w.divisionId)).toMatchObject({
      status: "not_available",
      reason: "ledger_not_loaded",
    });
    await db
      .prepare(
        "INSERT INTO gl_accounts (division_id, exact_id, code, name, is_active, updated_at) VALUES (?1, 'g1', ' 1999', 'Suspense', 1, '2026-07-01T00:00:00.000Z')",
      )
      .bind(w.divisionId)
      .run();
    await db
      .prepare(
        "INSERT INTO gl_sync_years (division_id, entity, year, completed_at) VALUES (?1, 'gl_balances', 2026, '2026-07-14T00:00:00.000Z')",
      )
      .bind(w.divisionId)
      .run();
    await db
      .prepare(
        `INSERT INTO gl_balances (division_id, gl_account_exact_id, year, period, amount_minor, currency, updated_at)
         VALUES (?1, 'g1', 2026, 0, 2500, 'EUR', 'x'), (?1, 'g1', 2026, 6, -500, 'EUR', 'x')`,
      )
      .bind(w.divisionId)
      .run();
    await runDq();
    const i = (await issues("rule_id = 'ledger.suspense_not_zero'"))[0];
    expect(i).toMatchObject({ amount_minor: 2000, currency: "EUR", severity: "warning" });
    expect(i?.message).toBe("EUR 20.00 on suspense account 1999.");
    await db.prepare("UPDATE gl_balances SET amount_minor = 500 WHERE period = 0").run();
    await runDq({ now: () => NOW + 3_600_000 });
    expect((await issues("rule_id = 'ledger.suspense_not_zero'"))[0]?.status).toBe("resolved");
    expect(await ruleStatus("ledger.suspense_not_zero", w.divisionId)).toMatchObject({
      status: "ok",
    });
  });

  it("bank balance mismatch compares only fresh, close reads", async () => {
    const fresh = new Date(NOW - 3_600_000).toISOString();
    await db
      .prepare(
        `UPDATE bank_accounts SET balance_minor = 100000, balance_at = ?2, exact_balance_minor = 90000,
           exact_balance_at = ?2 WHERE id = ?1`,
      )
      .bind(w.accountId, fresh)
      .run();
    await runDq();
    const i = (await issues("rule_id = 'bank.balance_mismatch'"))[0];
    expect(i).toMatchObject({ amount_minor: 10000, status: "open" });
    // the Exact read goes stale: no longer compared, the issue is left as it is
    await db
      .prepare("UPDATE bank_accounts SET exact_balance_at = ?2 WHERE id = ?1")
      .bind(w.accountId, new Date(NOW - 48 * 3_600_000).toISOString())
      .run();
    await runDq({ now: () => NOW + 60_000 });
    expect(await ruleStatus("bank.balance_mismatch", w.divisionId)).toMatchObject({
      status: "not_available",
    });
    expect((await issues("rule_id = 'bank.balance_mismatch'"))[0]?.status).toBe("open");
    // equal balances resolve it
    await db
      .prepare(
        "UPDATE bank_accounts SET exact_balance_minor = 100000, exact_balance_at = ?2 WHERE id = ?1",
      )
      .bind(w.accountId, fresh)
      .run();
    await runDq({ now: () => NOW + 120_000 });
    expect((await issues("rule_id = 'bank.balance_mismatch'"))[0]?.status).toBe("resolved");
  });

  it("integrations: stale job, failing webhook, expiring Exact connection, low Exact budget", async () => {
    await db
      .prepare(
        `INSERT INTO jobs (name, handler, schedule_json, enabled, created_at, last_scheduled_at)
         VALUES ('bank.match', 'bank.match', '{"kind":"cron","expr":"*/10 * * * *"}', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    const jobId = (
      await db.prepare("SELECT id FROM jobs WHERE name = 'bank.match'").first<{ id: number }>()
    )?.id;
    await db
      .prepare(
        `INSERT INTO job_runs (job_id, scheduled_for, status, queued_at, finished_at)
         VALUES (?1, '2026-07-14T00:00:00.000Z', 'ok', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:05.000Z')`,
      )
      .bind(jobId)
      .run();
    await db
      .prepare(
        `INSERT INTO webhook_rejections (connection_id, bucket_at, reason_code, count)
         VALUES (?1, ?2, 'bad_signature', 9)`,
      )
      .bind(
        w.revolutConnectionId,
        new Date(NOW - 3_600_000).toISOString().slice(0, 16) + ":00.000Z",
      )
      .run();
    await db
      .prepare("UPDATE connections SET refresh_expires_at = ?2 WHERE id = ?1")
      .bind(w.exactConnectionId, new Date(NOW + 2 * DAY).toISOString())
      .run();
    const exactDivision = (
      await db
        .prepare("SELECT exact_division AS n FROM divisions WHERE id = ?1")
        .bind(w.divisionId)
        .first<{ n: number }>()
    )?.n;
    await db
      .prepare(
        "INSERT INTO exact_usage (division, day, calls, remaining) VALUES (?1, '2026-07-15', 4800, NULL)",
      )
      .bind(exactDivision)
      .run();
    await runDq();
    const open = await fingerprints();
    expect(open).toContain("integrations.job_stale:job|bank.match");
    expect(open).toContain("integrations.webhook_failures:revolut");
    expect(open).toContain("integrations.exact_connection:exact");
    expect(open).toContain("integrations.exact_budget:budget");
    const conn = (await issues("rule_id = 'integrations.exact_connection'"))[0];
    expect(conn).toMatchObject({ severity: "critical", division_id: 0 });
    expect(JSON.parse(conn?.payload_json ?? "{}")).toEqual({ reason: "expiring" });
  });
});

describe("dq.checks: handler behaviour", () => {
  it("stops between divisions when aborted and reports partial", async () => {
    await seedProblems();
    const ac = new AbortController();
    ac.abort();
    const res = await runDq({ signal: ac.signal });
    expect(res).toMatchObject({ status: "partial", code: "aborted" });
    expect(await issues()).toEqual([]);
  });

  it("runs the global pass even with no synchronised division", async () => {
    await db.prepare("UPDATE divisions SET sync_enabled = 0").run();
    const res = await runDq();
    expect(res.status).toBe("ok");
    expect(res.summary).toMatchObject({ divisions: 0 });
    expect(await fingerprints()).toContain("fx.rate_stale:ecb");
  });

  it("the result summary holds counts only", async () => {
    await seedProblems();
    const res = await runDq();
    for (const v of Object.values(res.summary)) expect(typeof v).toBe("number");
  });

  it("context helper is the matching one with a fixed clock", () => {
    expect(dqContext().now()).toBe(NOW);
  });
});
